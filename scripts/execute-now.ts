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

async function kalshiGet(path: string) {
  return axios.get(`${base}${path}`, { headers: sign('GET', path) });
}

async function kalshiPost(path: string, body: any) {
  return axios.post(`${base}${path}`, body, { headers: { ...sign('POST', path), 'Content-Type': 'application/json' } });
}

async function main() {
  // 1. Get balance
  const bal = await kalshiGet('/trade-api/v2/portfolio/balance');
  const balanceCents = bal.data.balance;
  console.log(`Balance: $${(balanceCents / 100).toFixed(2)}`);

  // 2. Get BTC spot price (multiple fallbacks)
  let btcPrice = 0;
  try {
    const spot = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'bitcoin', vs_currencies: 'usd' }, timeout: 5000 });
    btcPrice = spot.data?.bitcoin?.usd ?? 0;
  } catch {
    const spot2 = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 });
    btcPrice = parseFloat(spot2.data?.data?.amount ?? '0');
  }
  console.log(`BTC Spot: $${btcPrice.toFixed(2)}`);

  // 3. Get KXBTCD markets (daily above/below)
  const mkts = await kalshiGet('/trade-api/v2/markets?status=open&limit=200&series_ticker=KXBTCD');
  const markets = (mkts.data?.markets ?? []) as any[];
  console.log(`KXBTCD markets: ${markets.length}`);

  // 4. Find markets near current price with orderbook depth
  const candidates: any[] = [];
  for (const m of markets) {
    const strike = m.floor_strike ?? m.strike_price ?? null;
    if (strike == null) continue;
    const strikeNum = typeof strike === 'string' ? parseFloat(strike) : strike;
    
    // Get orderbook for markets near current price
    const dist = Math.abs(btcPrice - strikeNum);
    if (dist > 2000) continue; // only look at strikes within $2000 of spot
    
    try {
      const ob = await kalshiGet(`/trade-api/v2/markets/${m.ticker}/orderbook`);
      const book = ob.data?.orderbook ?? {};
      
      candidates.push({
        ticker: m.ticker,
        title: m.title,
        strike: strikeNum,
        distFromSpot: btcPrice - strikeNum,
        yesAsk: book.yes?.length ? book.yes[0][0] : null,
        noAsk: book.no?.length ? book.no[0][0] : null,
        yesBids: book.yes,
        noBids: book.no,
        volume: m.volume,
        expiry: m.expiration_time,
      });
    } catch {
      continue;
    }
  }

  console.log(`\nCandidates near spot: ${candidates.length}`);
  
  // Sort by distance from spot (closest first)
  candidates.sort((a, b) => Math.abs(a.distFromSpot) - Math.abs(b.distFromSpot));

  for (const c of candidates.slice(0, 15)) {
    const dir = c.distFromSpot > 0 ? 'ABOVE' : 'BELOW';
    console.log(`  ${c.ticker} | strike: ${c.strike} | spot ${dir} by $${Math.abs(c.distFromSpot).toFixed(0)} | vol: ${c.volume} | yes: ${JSON.stringify(c.yesBids?.slice(0,3))} | no: ${JSON.stringify(c.noBids?.slice(0,3))}`);
  }

  // 5. Pick best trade
  // Strategy: if BTC is ABOVE strike, YES is likely to resolve YES → buy YES if cheap
  //           if BTC is BELOW strike, NO is likely → buy NO if cheap
  
  // The orderbook format is [[price_cents, quantity], ...] sorted by price
  // yesAsk = lowest price someone is selling YES at (first entry in yes book from other side perspective)
  // We want to find contracts where:
  // - BTC is comfortably above strike → buy YES (will resolve to $1 if BTC stays above)
  // - BTC is comfortably below strike → buy NO (will resolve to $1 if BTC stays below)
  // Buy at the ASK (lift the offer) for immediate fill
  
  let bestTrade: { ticker: string; side: 'yes' | 'no'; price: number; qty: number; reason: string } | null = null;

  for (const c of candidates) {
    // For YES side: the "no" book entries represent YES asks (inverse pricing on Kalshi)
    // Actually on Kalshi: yes book = [price, qty] where price is what YES holders want
    // To BUY yes, we look at the yes book asks (sorted ascending)
    // The data seems to be: yes = bids on YES side, no = bids on NO side
    // To buy YES at market, we need the lowest ask from the NO side perspective
    // Kalshi: yes_price + no_price = 100, so if no bid is at X, yes ask is at (100-X)
    
    if (c.distFromSpot > 300) {
      // BTC above strike → buy YES
      // In the orderbook, yes entries at low prices = cheap YES we can buy
      if (c.yesBids && c.yesBids.length > 0) {
        // These are limit orders to buy YES; to sell to them won't help us.
        // We need to find asks. On Kalshi, buying YES at price P means the NO side has bids at (100-P).
        // Let's just use the best available price from the book
        const noBids = c.noBids ?? [];
        if (noBids.length > 0) {
          // Highest NO bid → YES ask = 100 - noBid
          // Actually no, let's think again. The book shows:
          // yes: [[price, qty]] = people wanting to buy YES at that price
          // no: [[price, qty]] = people wanting to buy NO at that price  
          // To BUY YES, we can buy at (100 - best_no_bid)
          // Or place a limit buy on the YES side
          const bestNoBid = noBids[0][0];
          const yesAskPrice = 100 - bestNoBid; // This is what we pay for YES
          
          if (yesAskPrice >= 55 && yesAskPrice <= 92) {
            const qty = noBids[0][1];
            bestTrade = { ticker: c.ticker, side: 'yes', price: yesAskPrice, qty, reason: `BTC $${c.distFromSpot.toFixed(0)} above strike ${c.strike}, YES ask ~${yesAskPrice}c (implied from NO bid ${bestNoBid}c)` };
            break;
          }
        }
      }
    } else if (c.distFromSpot < -300) {
      // BTC below strike → buy NO
      if (c.yesBids && c.yesBids.length > 0) {
        const bestYesBid = c.yesBids[0][0];
        const noAskPrice = 100 - bestYesBid;
        
        if (noAskPrice >= 55 && noAskPrice <= 92) {
          const qty = c.yesBids[0][1];
          bestTrade = { ticker: c.ticker, side: 'no', price: noAskPrice, qty, reason: `BTC $${Math.abs(c.distFromSpot).toFixed(0)} below strike ${c.strike}, NO ask ~${noAskPrice}c (implied from YES bid ${bestYesBid}c)` };
          break;
        }
      }
    }
  }

  if (!bestTrade) {
    console.log('\nNo trade found with acceptable edge. Dumping all orderbooks:');
    for (const c of candidates.slice(0, 5)) {
      console.log(`  ${c.ticker} strike=${c.strike} dist=${c.distFromSpot.toFixed(0)} yes=${JSON.stringify(c.yesBids)} no=${JSON.stringify(c.noBids)}`);
    }
    return;
  }

  console.log(`\n=== EXECUTING TRADE ===`);
  console.log(`Ticker: ${bestTrade.ticker}`);
  console.log(`Side: ${bestTrade.side}`);
  console.log(`Price: ${bestTrade.price}c`);
  console.log(`Reason: ${bestTrade.reason}`);
  
  // Max $1 per trade → how many contracts?
  const maxSpendCents = 100; // $1
  const availableQty = bestTrade.qty ?? 9999;
  const count = Math.min(Math.max(1, Math.floor(maxSpendCents / bestTrade.price)), availableQty);
  console.log(`Count: ${count} contracts @ ${bestTrade.price}c = $${((count * bestTrade.price) / 100).toFixed(2)} (available: ${availableQty})`);

  // Place order
  const orderBody = {
    ticker: bestTrade.ticker,
    side: bestTrade.side,
    action: 'buy',
    count: count,
    type: 'limit',
    yes_price: bestTrade.side === 'yes' ? bestTrade.price : undefined,
    no_price: bestTrade.side === 'no' ? bestTrade.price : undefined,
  };

  console.log(`\nOrder payload:`, JSON.stringify(orderBody));

  try {
    const result = await kalshiPost('/trade-api/v2/portfolio/orders', orderBody);
    console.log(`\n✅ ORDER PLACED`);
    console.log(JSON.stringify(result.data, null, 2));
  } catch (e: any) {
    console.error(`\n❌ ORDER FAILED`);
    console.error(`Status: ${e.response?.status}`);
    console.error(`Error: ${JSON.stringify(e.response?.data)}`);
  }

  // Final balance
  const bal2 = await kalshiGet('/trade-api/v2/portfolio/balance');
  console.log(`\nFinal balance: $${(bal2.data.balance / 100).toFixed(2)}`);
}

main().catch(console.error);
