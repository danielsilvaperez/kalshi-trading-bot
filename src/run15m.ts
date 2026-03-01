import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { evaluate15mTrade, type Market15m } from './strategy/btc15m.js';
import { fetchBtcSpot } from './adapters/spotPrice.js';
import { journal } from './engine/journal.js';
import { FileLock } from './engine/lock.js';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { DEFAULT_ADAPTIVE, type AdaptiveConfig } from './config/adaptive.js';
import { recordPosition } from './safety/correlationFilter.js';
import { logSlippage } from './safety/slippageTracker.js';
import { calculateKellySizing, applyKellySizing } from './safety/kellySizing.js';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
const journalPath = process.env.JOURNAL_PATH || './logs/trading-15m.jsonl';
const lockPath = process.env.LOCK_PATH || './tmp/trading-15m.lock';
const adaptivePath = process.env.ADAPTIVE_CONFIG_PATH || './config/adaptive.json';
const statePath = process.env.STATE_PATH || './tmp/15m-state.json';
const positionsPath = process.env.POSITIONS_TRACKER_PATH || './tmp/tracked-positions.json';
const maxSpendCents = Number(process.env.MAX_SPEND_CENTS || 100);
const dryRun = process.env.DRY_RUN !== 'false';
const allowLive = process.env.ALLOW_LIVE === 'true';

if (!keyId || !pem) {
  console.error('Missing KALSHI_KEY_ID or KALSHI_PRIVATE_KEY_PEM');
  process.exit(1);
}

function sign(method: string, path: string) {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64'),
  };
}

async function get(path: string) {
  return axios.get(`${base}${path}`, { headers: sign('GET', path) });
}

async function post(path: string, body: unknown) {
  return axios.post(`${base}${path}`, body, {
    headers: { ...sign('POST', path), 'Content-Type': 'application/json' },
  });
}

function loadAdaptive(): AdaptiveConfig {
  if (!existsSync(adaptivePath)) return DEFAULT_ADAPTIVE;
  try {
    const raw = JSON.parse(readFileSync(adaptivePath, 'utf8')) as Partial<AdaptiveConfig>;
    return {
      minEvCents: Number(raw.minEvCents ?? DEFAULT_ADAPTIVE.minEvCents),
      highPriceMinConfidence: Number(raw.highPriceMinConfidence ?? DEFAULT_ADAPTIVE.highPriceMinConfidence),
      maxSpendCents: Number(raw.maxSpendCents ?? DEFAULT_ADAPTIVE.maxSpendCents),
    };
  } catch {
    return DEFAULT_ADAPTIVE;
  }
}

function loadState(): { lastWindowTicker?: string; lastTradeAtMs?: number } {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(s: { lastWindowTicker?: string; lastTradeAtMs?: number }) {
  mkdirSync('./tmp', { recursive: true });
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

interface TrackedPosition {
  ticker: string;
  side: 'yes' | 'no';
  entryPrice: number;
  count: number;
  entryTime: number;
  expectedResolutionTime: number;
  orderId: string;
}

function loadTrackedPositions(): TrackedPosition[] {
  if (!existsSync(positionsPath)) return [];
  try {
    return JSON.parse(readFileSync(positionsPath, 'utf8'));
  } catch {
    return [];
  }
}

function saveTrackedPositions(positions: TrackedPosition[]) {
  mkdirSync('./tmp', { recursive: true });
  writeFileSync(positionsPath, JSON.stringify(positions, null, 2));
}

function trackPosition(pos: TrackedPosition) {
  const positions = loadTrackedPositions();
  positions.push(pos);
  saveTrackedPositions(positions);
}

async function main() {
  const lock = new FileLock(lockPath);
  if (!lock.acquire()) {
    journal(journalPath, { type: 'skip', reason: 'run lock active' });
    console.log('[15m] skipped: lock active');
    return;
  }

  try {
    // 1. Balance
    const bal = await get('/trade-api/v2/portfolio/balance');
    const balanceCents = bal.data.available_cash ?? bal.data.balance ?? 0;
    console.log(`[15m] balance: $${(balanceCents / 100).toFixed(2)}`);

    // 2. Spot price
    let spot;
    try {
      spot = await fetchBtcSpot();
      console.log(`[15m] BTC: $${spot.price.toFixed(2)} (${spot.source})`);
    } catch (e) {
      journal(journalPath, { type: 'error', reason: 'spot fetch failed', error: String(e) });
      console.log('[15m] spot fetch failed, skipping');
      return;
    }

    // 3. Find active 15m markets
    const r = await get('/trade-api/v2/markets?status=open&limit=50&series_ticker=KXBTC15M');
    const rawMarkets = (r.data?.markets ?? []) as any[];
    console.log(`[15m] active markets: ${rawMarkets.length}`);

    if (rawMarkets.length === 0) {
      journal(journalPath, { type: 'no_market', reason: 'no active KXBTC15M markets' });
      console.log('[15m] no active 15m markets, waiting for next window');
      return;
    }

    // 4. Evaluate each market
    const now = Date.now();
    const adaptive = loadAdaptive();
    const state = loadState();
    const spendCap = Math.min(maxSpendCents, adaptive.maxSpendCents);
    console.log(`[15m] adaptive: minEV=${adaptive.minEvCents}c highPriceConf=${(adaptive.highPriceMinConfidence*100).toFixed(0)}% spendCap=${spendCap}c`);
    let attemptedTradeThisRun = false;
    for (const m of rawMarkets) {
      if (state.lastWindowTicker && state.lastWindowTicker === m.ticker) {
        journal(journalPath, { type: '15m_skip', ticker: m.ticker, reason: 'already traded this window' });
        console.log(`[15m] ${m.ticker}: skip — already traded this window`);
        continue;
      }
      // Fetch orderbook for depth analysis
      let yesBook: number[][] = [];
      let noBook: number[][] = [];
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

      const decision = evaluate15mTrade(
        market,
        { currentPrice: spot.price, priceAge: 0, source: spot.source },
        spendCap,
        now,
        {
          minEvCents: adaptive.minEvCents,
          highPriceMinConfidence: adaptive.highPriceMinConfidence,
        },
      );

      if (!decision.trade) {
        journal(journalPath, { type: '15m_skip', ticker: market.ticker, reason: decision.reason, yesAsk: market.yesAsk, noAsk: market.noAsk });
        console.log(`[15m] ${market.ticker}: skip — ${decision.reason}`);
        continue;
      }

      const payload = {
        ticker: market.ticker,
        side: decision.side,
        price: decision.price,
        count: decision.count,
        ev: decision.ev,
        reason: decision.reason,
        btcSpot: spot.price,
      };

      if (dryRun || !allowLive) {
        journal(journalPath, { type: '15m_opportunity_dry', ...payload });
        console.log(`[15m][dry] would trade: ${decision.side} @ ${decision.price}c x${decision.count} — ${decision.reason}`);
        continue;
      }

      // 5. Execute
      console.log(`[15m][live] executing: ${decision.side} @ ${decision.price}c x${decision.count}`);

      // Apply Kelly sizing
      const kelly = calculateKellySizing(decision.price!, decision.side!);
      const kellyCount = Math.max(1, Math.min(decision.count!, Math.floor(decision.count! * kelly.fraction * (0.5 + kelly.confidence * 0.5))));
      if (kellyCount !== decision.count) {
        console.log(`[15m] Kelly adjust: ${decision.count} -> ${kellyCount} (frac=${kelly.fraction.toFixed(2)}, conf=${kelly.confidence.toFixed(2)})`);
        decision.count = kellyCount;
      }

      const orderBody = {
        ticker: market.ticker,
        side: decision.side,
        action: 'buy',
        count: decision.count,
        type: 'limit',
        ...(decision.side === 'yes' ? { yes_price: decision.price } : { no_price: decision.price }),
      };

      try {
        const result = await post('/trade-api/v2/portfolio/orders', orderBody);
        const order = result.data?.order ?? {};

        // Log slippage
        const fillPrice = decision.side === 'yes' ? order.yes_price : order.no_price;
        logSlippage(market.ticker, decision.side!, decision.price!, fillPrice ?? null);

        journal(journalPath, {
          type: '15m_executed',
          ...payload,
          orderId: order.order_id,
          status: order.status,
          fillCount: order.fill_count,
          takerFees: order.taker_fees,
          kellyFraction: kelly.fraction,
        });

        console.log(`[15m] ✅ ${order.status} | fill: ${order.fill_count}/${order.initial_count} | id: ${order.order_id}`);

        // Track position for outcome resolution
        if (order.fill_count > 0) {
          trackPosition({
            ticker: market.ticker,
            side: decision.side!,
            entryPrice: decision.price!,
            count: order.fill_count,
            entryTime: Date.now(),
            expectedResolutionTime: market.closeTime,
            orderId: order.order_id,
          });

          // Record for correlation filter
          recordPosition(market.ticker, decision.side!, order.fill_count);
        }

        saveState({ lastWindowTicker: m.ticker, lastTradeAtMs: Date.now() });
        attemptedTradeThisRun = true;
      } catch (e: any) {
        journal(journalPath, {
          type: '15m_order_fail',
          ...payload,
          error: e?.response?.data?.message ?? e?.message,
          status: e?.response?.status,
        });
        console.error(`[15m] ❌ order failed: ${e?.response?.status} ${JSON.stringify(e?.response?.data)}`);
        saveState({ lastWindowTicker: m.ticker, lastTradeAtMs: Date.now() });
        attemptedTradeThisRun = true;
      }

      if (attemptedTradeThisRun) break;
    }

    if (!attemptedTradeThisRun) {
      console.log('[15m] no execution this run');
    }

    // 6. Final balance
    const bal2 = await get('/trade-api/v2/portfolio/balance');
    const finalBalanceCents = bal2.data.available_cash ?? bal2.data.balance ?? 0;
    console.log(`[15m] final balance: $${(finalBalanceCents / 100).toFixed(2)}`);

  } finally {
    lock.release();
  }
}

main().catch((e) => {
  console.error('[15m] fatal:', e);
  journal(journalPath, { type: 'fatal', error: String(e) });
  process.exit(1);
});
