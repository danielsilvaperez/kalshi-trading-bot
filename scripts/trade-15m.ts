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
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64') };
}
async function get(path: string) { return axios.get(`${base}${path}`, { headers: sign('GET', path) }); }
async function post(path: string, body: any) { return axios.post(`${base}${path}`, body, { headers: { ...sign('POST', path), 'Content-Type': 'application/json' } }); }

async function main() {
  // Balance
  const bal = await get('/trade-api/v2/portfolio/balance');
  console.log(`Balance: $${(bal.data.balance / 100).toFixed(2)}`);

  // BTC spot
  let btcPrice = 0;
  try {
    const s = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'bitcoin', vs_currencies: 'usd' }, timeout: 5000 });
    btcPrice = s.data?.bitcoin?.usd ?? 0;
  } catch {
    const s = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 });
    btcPrice = parseFloat(s.data?.data?.amount ?? '0');
  }
  console.log(`BTC Spot: $${btcPrice.toFixed(2)}`);

  // Find active 15m markets
  const r = await get('/trade-api/v2/markets?status=open&limit=50&series_ticker=KXBTC15M');
  const markets = (r.data?.markets ?? []) as any[];
  console.log(`Active 15m markets: ${markets.length}`);

  if (markets.length === 0) {
    console.log('No active 15-minute BTC markets right now. They roll periodically — try again in a few minutes.');
    return;
  }

  const now = Date.now();
  for (const m of markets) {
    const closeTime = m.close_time ? new Date(m.close_time).getTime() : 0;
    const minsLeft = ((closeTime - now) / 60000).toFixed(1);
    console.log(`\n  ${m.ticker}`);
    console.log(`  Title: ${m.title}`);
    console.log(`  Close: ${minsLeft} min left`);
    console.log(`  YES ask: ${m.yes_ask}c | YES bid: ${m.yes_bid}c`);
    console.log(`  NO ask: ${m.no_ask}c | NO bid: ${m.no_bid}c`);
    console.log(`  Volume: ${m.volume}`);
    console.log(`  Rules: ${m.rules_primary?.slice(0, 200)}`);

    // Get orderbook
    try {
      const ob = await get(`/trade-api/v2/markets/${m.ticker}/orderbook`);
      const book = ob.data?.orderbook ?? {};
      console.log(`  YES book: ${JSON.stringify((book.yes ?? []).slice(0, 5))}`);
      console.log(`  NO book: ${JSON.stringify((book.no ?? []).slice(0, 5))}`);
    } catch {}

    // Determine trade
    // "BTC price up in next 15 mins?" → simple up/down
    // Check recent BTC momentum to decide YES (up) or NO (down)
    const minsToClose = (closeTime - now) / 60000;
    
    if (minsToClose < 2) {
      console.log(`  ⏰ Too close to expiry (${minsLeft}min), skipping.`);
      continue;
    }

    // For momentum: check 1m and 5m candle from coinbase
    let recentPrice = btcPrice;
    try {
      // Get price from 5 min ago via coinbase
      const cb = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 });
      recentPrice = parseFloat(cb.data?.data?.amount ?? '0');
    } catch {}

    // Simple signal: if BTC moved up recently, buy YES; if down, buy NO
    // Since we only have current spot, use the ask prices as signal:
    // If YES is cheap (<45c) → market thinks DOWN → contrarian or follow
    // If NO is cheap (<45c) → market thinks UP → contrarian or follow
    
    const yesAsk = m.yes_ask || 0;
    const noAsk = m.no_ask || 0;
    
    let side: 'yes' | 'no';
    let price: number;
    
    // Follow the market consensus for now (safer with small capital)
    if (yesAsk > 0 && yesAsk < noAsk && yesAsk <= 60) {
      // YES is cheaper → market expects NO → buy NO (follow consensus)
      side = 'no';
      price = noAsk;
    } else if (noAsk > 0 && noAsk < yesAsk && noAsk <= 60) {
      // NO is cheaper → market expects YES → buy YES
      side = 'yes';
      price = yesAsk;
    } else {
      // Pick the cheaper side
      if (yesAsk <= noAsk && yesAsk > 0) {
        side = 'yes';
        price = yesAsk;
      } else {
        side = 'no';
        price = noAsk;
      }
    }

    if (price <= 0 || price >= 95) {
      console.log(`  Price not tradeable (${price}c), skipping.`);
      continue;
    }

    const maxSpendCents = 100; // $1 max
    const count = Math.max(1, Math.floor(maxSpendCents / price));

    console.log(`\n  === TRADING ===`);
    console.log(`  Side: ${side} @ ${price}c x${count}`);
    console.log(`  Cost: $${((count * price) / 100).toFixed(2)}`);

    const orderBody = {
      ticker: m.ticker,
      side,
      action: 'buy',
      count,
      type: 'limit',
      ...(side === 'yes' ? { yes_price: price } : { no_price: price }),
    };

    console.log(`  Order:`, JSON.stringify(orderBody));

    try {
      const result = await post('/trade-api/v2/portfolio/orders', orderBody);
      console.log(`\n  ✅ ORDER PLACED`);
      console.log(`  Status: ${result.data?.order?.status}`);
      console.log(`  Fill: ${result.data?.order?.fill_count}/${result.data?.order?.initial_count}`);
      console.log(`  Order ID: ${result.data?.order?.order_id}`);
    } catch (e: any) {
      console.error(`\n  ❌ FAILED: ${e.response?.status} ${JSON.stringify(e.response?.data)}`);
    }
  }

  const bal2 = await get('/trade-api/v2/portfolio/balance');
  console.log(`\nFinal balance: $${(bal2.data.balance / 100).toFixed(2)}`);
}

main().catch(console.error);
