import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluate15mTrade, type Market15m } from './strategy/btc15m.js';
import { checkSafety } from './safety/killSwitch.js';
import { cancelStaleOrders } from './safety/staleCleanup.js';
import { assessVolatilityRegime } from './safety/volatilityRegime.js';
import { findCrossMarketEdge } from './adapters/polymarket.js';
import { checkSignalStack } from './safety/signalStack.js';
import { checkTimeFilter } from './safety/timeFilter.js';
import { shouldAvoidTrade } from './safety/marketMakerDetection.js';
import { checkCorrelation } from './safety/correlationFilter.js';
import { adjustEntryForSlippage } from './safety/slippageTracker.js';
import { formatSignalStack } from './safety/signalStack.js';
import { applyTimeQualityModifier } from './safety/timeFilter.js';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
const triggerPath = process.env.TRIGGER_PATH || './tmp/15m-trigger.json';
const momentumPath = process.env.MOMENTUM_PATH || './tmp/btc-momentum.json';

if (!keyId || !pem) process.exit(0);

function sign(method: string, path: string) {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64') };
}

async function get(path: string) { return axios.get(`${base}${path}`, { headers: sign('GET', path) }); }

function loadMomentum(): { price: number; ts: number; source: string }[] {
  if (!existsSync(momentumPath)) return [];
  try {
    return JSON.parse(readFileSync(momentumPath, 'utf8'));
  } catch { return []; }
}

function calcMomentum(points: { price: number; ts: number }[]) {
  if (points.length < 2) return { change1m: 0, change5m: 0, direction: 'flat' as const, strength: 0 };
  const now = Date.now();
  const current = points[points.length - 1].price;
  const p1m = [...points].reverse().find((p) => now - p.ts <= 60000)?.price ?? points[0].price;
  const p5m = [...points].reverse().find((p) => now - p.ts <= 300000)?.price ?? points[0].price;
  const c1m = (current - p1m) / p1m;
  const c5m = (current - p5m) / p5m;
  const avg = (c1m + c5m * 0.5) / 1.5;
  let dir: 'up' | 'down' | 'flat' = 'flat';
  if (avg > 0.0003) dir = 'up';
  else if (avg < -0.0003) dir = 'down';
  return { change1m: c1m, change5m: c5m, direction: dir, strength: Math.abs(avg) * 1000 };
}

async function fetchSpot() {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'bitcoin', vs_currencies: 'usd' }, timeout: 5000 });
    return { price: r.data?.bitcoin?.usd ?? 0, source: 'coingecko' };
  } catch {
    const r = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 });
    return { price: parseFloat(r.data?.data?.amount ?? '0'), source: 'coinbase' };
  }
}

async function main() {
  // 1. Safety checks first
  const safety = await checkSafety();
  if (!safety.canTrade) {
    console.log('[sentry] KILL SWITCH:', safety.reason);
    return;
  }
  console.log('[sentry] safety OK:', { balance: safety.balanceCents, positions: safety.openPositions, streak: safety.consecutiveLosses });

  // 2. Clean stale orders
  const cleanup = await cancelStaleOrders();
  if (cleanup.cancelled > 0) console.log('[sentry] cleaned', cleanup.cancelled, 'stale orders');

  // 3. Check volatility regime
  const regime = assessVolatilityRegime();
  if (!regime.canTrade) {
    console.log('[sentry] VOLATILITY BLOCK:', regime.reason);
    return;
  }
  console.log('[sentry] regime:', regime.regime, 'vol:', (regime.volatility*100).toFixed(3)+'%');

  // Time filter
  const timeFilter = checkTimeFilter();
  if (!timeFilter.canTrade) {
    console.log('[sentry] TIME BLOCK:', timeFilter.reason);
    return;
  }
  console.log('[sentry] time quality:', timeFilter.quality);

  // Market maker toxicity check
  if (shouldAvoidTrade()) {
    console.log('[sentry] MM TOXICITY BLOCK: recent spoofing/informed flow detected');
    return;
  }

  rmSync(triggerPath, { force: true });

  const spot = await fetchSpot();
  if (!spot.price) { console.log('[sentry] spot failed'); return; }

  const momPoints = loadMomentum();
  const mom = calcMomentum(momPoints);

  const r = await get('/trade-api/v2/markets?status=open&limit=50&series_ticker=KXBTC15M');
  const rawMarkets = (r.data?.markets ?? []) as any[];
  console.log(`[sentry] markets: ${rawMarkets.length}, spot: ${spot.price.toFixed(2)}, mom: ${mom.direction}/${mom.strength.toFixed(2)}`);

  if (rawMarkets.length === 0) { console.log('[sentry] no market'); return; }

  const now = Date.now();
  const maxSpend = Number(process.env.MAX_SPEND_CENTS || 90);

  for (const m of rawMarkets) {
    let yesBook: number[][] = [], noBook: number[][] = [];
    try {
      const ob = await get(`/trade-api/v2/markets/${m.ticker}/orderbook`);
      yesBook = ob.data?.orderbook?.yes ?? [];
      noBook = ob.data?.orderbook?.no ?? [];
    } catch {}

    const market: Market15m = {
      ticker: m.ticker,
      title: m.title ?? '',
      yesAsk: m.yes_ask ?? 0,
      yesBid: m.yes_bid ?? 0,
      noAsk: m.no_ask ?? 0,
      noBid: m.no_bid ?? 0,
      closeTime: m.close_time ? new Date(m.close_time).getTime() : 0,
      volume: m.volume ?? 0,
      yesBook,
      noBook,
    };

    // Cross-market check
    const crossEdge = await findCrossMarketEdge(market.yesAsk || market.yesBid || 50, 'yes');
    if (crossEdge.signal !== 'none') {
      console.log('[sentry] cross-market edge:', crossEdge.signal, crossEdge.edgeCents.toFixed(1)+'c', crossEdge.reason);
    }

    const d = evaluate15mTrade(
      market,
      { currentPrice: spot.price, priceAge: 0, source: spot.source, ...mom },
      maxSpend,
      now,
      {
        minEvCents: Number(process.env.SENTRY_MIN_EV_CENTS || 2),
        highPriceMinConfidence: Number(process.env.SENTRY_HIGH_CONF || 0.9),
      },
    );

    if (!d.trade) continue;

    // Signal stack check (need 2+ signals)
    const stack = checkSignalStack(
      mom.direction,
      d.side!,
      crossEdge.edgeCents,
      parseFloat((d.signals?.depthImb as string) || '0'),
    );
    if (!stack.passes) {
      console.log(`[sentry] SIGNAL STACK FAIL: ${formatSignalStack(stack)}`);
      continue;
    }
    console.log('[sentry] signals pass:', formatSignalStack(stack));

    // Correlation check
    const corr = checkCorrelation(d.side!, market.ticker);
    if (!corr.canEnter) {
      console.log('[sentry] CORRELATION BLOCK:', corr.reason, 'netExposure:', corr.netExposure);
      continue;
    }

    // Adjust for slippage
    const adjustedPrice = adjustEntryForSlippage(d.price!, d.side!);
    if (adjustedPrice !== d.price!) {
      console.log(`[sentry] slippage adjust: ${d.price}c -> ${adjustedPrice}c`);
      d.price = adjustedPrice;
    }

    // Apply time quality to spend
    const adjustedSpend = applyTimeQualityModifier(maxSpend, timeFilter.quality);

    mkdirSync(dirname(triggerPath), { recursive: true });
    writeFileSync(triggerPath, JSON.stringify({
      ts: new Date().toISOString(), ticker: m.ticker, side: d.side, price: d.price, count: d.count,
      reason: d.reason, ev: d.ev, closeTime: m.close_time, expiresAtMs: Date.now() + 70000,
      signals: d.signals, adjustedSpend,
    }, null, 2));

    console.log('[sentry] trigger', d.reason);
    return;
  }

  console.log('[sentry] no feasible setup');
}

main().catch((e) => { console.error('[sentry] error', e); process.exit(1); });
