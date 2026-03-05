import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';

const keyId = process.env.KALSHI_KEY_ID!;
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';

function sign(method: string, path: string) {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  const sig = s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64');
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig };
}
async function get(path: string) { return axios.get(`${base}${path}`, { headers: sign('GET', path) }); }
async function post(path: string, body: any) { return axios.post(`${base}${path}`, body, { headers: { ...sign('POST', path), 'Content-Type': 'application/json' } }); }

async function main() {
  const bal = await get('/trade-api/v2/portfolio/balance');
  console.log(`Balance: $${(bal.data.balance / 100).toFixed(2)}`);

  // BTC spot
  let btcPrice = 0;
  try {
    const s = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'bitcoin', vs_currencies: 'usd' }, timeout: 5000 });
    btcPrice = s.data?.bitcoin?.usd ?? 0;
  } catch { const s = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 }); btcPrice = parseFloat(s.data?.data?.amount ?? '0'); }
  console.log(`BTC: $${btcPrice.toFixed(2)}`);

  // Get KXBTCD markets
  const r = await get('/trade-api/v2/markets?status=open&limit=200&series_ticker=KXBTCD');
  const markets = (r.data?.markets ?? []) as any[];

  // Focus on markets near current price, get orderbooks
  const now = Date.now();
  type Candidate = { ticker: string; strike: number; dist: number; expiry: string; secsLeft: number; yesBook: number[][]; noBook: number[][] };
  const candidates: Candidate[] = [];

  for (const m of markets) {
    const strike = parseFloat(m.floor_strike ?? m.strike_price ?? '0');
    if (!strike) continue;
    const dist = btcPrice - strike;
    if (Math.abs(dist) > 1500) continue;
    
    const exp = m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
    const secsLeft = Math.floor((exp - now) / 1000);
    
    try {
      const ob = await get(`/trade-api/v2/markets/${m.ticker}/orderbook`);
      const book = ob.data?.orderbook ?? {};
      candidates.push({
        ticker: m.ticker,
        strike,
        dist,
        expiry: m.expiration_time,
        secsLeft,
        yesBook: book.yes ?? [],
        noBook: book.no ?? [],
      });
    } catch { continue; }
  }

  console.log(`\nCandidates: ${candidates.length}`);

  // Strategy: find the best risk/reward
  // For "Will BTC be above X?" contracts:
  // - If BTC is $500+ above strike → YES very likely → find YES at good price
  // - If BTC is $500+ below strike → NO very likely → find NO at good price
  // We want to buy cheap contracts that are likely to resolve in our favor
  
  type Trade = { ticker: string; side: 'yes' | 'no'; price: number; count: number; reason: string; ev: number };
  const trades: Trade[] = [];

  for (const c of candidates) {
    // YES book: [[price, qty]] = people willing to BUY yes at that price (bids)
    // NO book: [[price, qty]] = people willing to BUY no at that price (bids)
    // To BUY YES: we need someone selling YES = someone buying NO. Best YES ask = 100 - highest NO bid
    // To BUY NO: Best NO ask = 100 - highest YES bid
    
    if (c.dist > 300) {
      // BTC above strike → want YES
      // Find cheapest YES (= 100 - best NO bid price)
      if (c.noBook.length > 0) {
        // NO bids sorted by price desc (highest first)
        const sorted = [...c.noBook].sort((a, b) => b[0] - a[0]);
        const bestNoBid = sorted[0][0];
        const bestNoBidQty = sorted[0][1];
        const yesPrice = 100 - bestNoBid;
        
        // Only trade if YES is reasonably priced (not too expensive, not too cheap)
        if (yesPrice >= 60 && yesPrice <= 93) {
          // EV: if resolves YES we get $1, paid yesPrice cents
          // Rough probability BTC stays above: higher dist = higher prob
          const probYes = Math.min(0.95, 0.5 + (c.dist / 5000));
          const ev = probYes * (100 - yesPrice) - (1 - probYes) * yesPrice;
          
          const maxSpend = 100; // $1
          const count = Math.min(Math.max(1, Math.floor(maxSpend / yesPrice)), bestNoBidQty);
          
          trades.push({
            ticker: c.ticker,
            side: 'yes',
            price: yesPrice,
            count,
            reason: `BTC $${c.dist.toFixed(0)} above ${c.strike} (${c.secsLeft}s left), YES@${yesPrice}c, probYes=${(probYes*100).toFixed(0)}%`,
            ev,
          });
        }
      }
    } else if (c.dist < -300) {
      // BTC below strike → want NO
      if (c.yesBook.length > 0) {
        const sorted = [...c.yesBook].sort((a, b) => b[0] - a[0]);
        const bestYesBid = sorted[0][0];
        const bestYesBidQty = sorted[0][1];
        const noPrice = 100 - bestYesBid;
        
        if (noPrice >= 60 && noPrice <= 93) {
          const probNo = Math.min(0.95, 0.5 + (Math.abs(c.dist) / 5000));
          const ev = probNo * (100 - noPrice) - (1 - probNo) * noPrice;
          
          const maxSpend = 100;
          const count = Math.min(Math.max(1, Math.floor(maxSpend / noPrice)), bestYesBidQty);
          
          trades.push({
            ticker: c.ticker,
            side: 'no',
            price: noPrice,
            count,
            reason: `BTC $${Math.abs(c.dist).toFixed(0)} below ${c.strike} (${c.secsLeft}s left), NO@${noPrice}c, probNo=${(probNo*100).toFixed(0)}%`,
            ev,
          });
        }
      }
    }
  }

  // Sort by EV
  trades.sort((a, b) => b.ev - a.ev);

  console.log(`\nTrade candidates (sorted by EV):`);
  for (const t of trades.slice(0, 10)) {
    console.log(`  ${t.ticker} | ${t.side} @ ${t.price}c x${t.count} | EV: ${t.ev.toFixed(1)}c | ${t.reason}`);
  }

  if (trades.length === 0) {
    console.log('No trades with acceptable edge found.');
    return;
  }

  const best = trades[0];
  console.log(`\n=== EXECUTING BEST TRADE ===`);
  console.log(`Ticker: ${best.ticker}`);
  console.log(`Side: ${best.side} @ ${best.price}c x${best.count}`);
  console.log(`Cost: $${((best.count * best.price) / 100).toFixed(2)}`);
  console.log(`EV: ${best.ev.toFixed(1)}c per contract`);
  console.log(`Reason: ${best.reason}`);

  const orderBody = {
    ticker: best.ticker,
    side: best.side,
    action: 'buy',
    count: best.count,
    type: 'limit',
    ...(best.side === 'yes' ? { yes_price: best.price } : { no_price: best.price }),
  };

  console.log(`\nOrder:`, JSON.stringify(orderBody));

  try {
    const result = await post('/trade-api/v2/portfolio/orders', orderBody);
    console.log(`\n✅ ORDER PLACED`);
    console.log(JSON.stringify(result.data, null, 2));
  } catch (e: any) {
    console.error(`\n❌ ORDER FAILED: ${e.response?.status} ${JSON.stringify(e.response?.data)}`);
  }

  const bal2 = await get('/trade-api/v2/portfolio/balance');
  console.log(`\nFinal balance: $${(bal2.data.balance / 100).toFixed(2)}`);
}

main().catch(console.error);
