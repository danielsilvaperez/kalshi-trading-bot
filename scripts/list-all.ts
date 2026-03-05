import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';

const keyId = process.env.KALSHI_KEY_ID!;
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';

function sign(method: string, path: string) {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const signer = createSign('RSA-SHA256');
  signer.update(msg);
  signer.end();
  const sig = signer.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64');
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': sig };
}

async function main() {
  // Try multiple pages / series
  let cursor: string | undefined;
  const allMarkets: any[] = [];
  
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ status: 'open', limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const path = `/trade-api/v2/markets?${params}`;
    const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/markets') });
    const markets = r.data?.markets ?? [];
    allMarkets.push(...markets);
    cursor = r.data?.cursor;
    if (!cursor || markets.length < 200) break;
  }

  console.log(`Total fetched: ${allMarkets.length}`);

  // Find crypto / btc
  const crypto = allMarkets.filter((m: any) => {
    const t = `${m.ticker} ${m.title ?? ''} ${m.subtitle ?? ''} ${m.category ?? ''}`.toLowerCase();
    return t.includes('btc') || t.includes('bitcoin') || t.includes('crypto') || t.includes('15min') || t.includes('15-min');
  });

  console.log(`Crypto/BTC/15min matches: ${crypto.length}`);
  
  for (const m of crypto.slice(0, 40)) {
    console.log(`${m.ticker} | ${m.title ?? ''} | cat: ${m.category ?? '?'}`);
  }

  if (crypto.length === 0) {
    // Show sample of what's there
    console.log('\n--- Sample of available markets ---');
    const tickers = allMarkets.slice(0, 20).map((m: any) => `${m.ticker} | ${m.title ?? ''}`);
    tickers.forEach((t: string) => console.log(t));
  }
}

main().catch(console.error);
