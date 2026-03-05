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

async function main() {
  // Get KXBTC + KXBTCD markets that expire soonest
  for (const series of ['KXBTC', 'KXBTCD']) {
    const path = `/trade-api/v2/markets?status=open&limit=200&series_ticker=${series}`;
    const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/markets') });
    const mkts = (r.data?.markets ?? []) as any[];
    
    const now = Date.now();
    const withExpiry = mkts.map(m => ({
      ticker: m.ticker,
      title: m.title,
      expiry: m.expiration_time,
      secsLeft: m.expiration_time ? Math.floor((new Date(m.expiration_time).getTime() - now) / 1000) : 999999,
      strike: m.floor_strike ?? m.strike_price ?? null,
      yesAsk: m.yes_ask,
      noAsk: m.no_ask,
      volume: m.volume,
    })).sort((a, b) => a.secsLeft - b.secsLeft);

    console.log(`\n=== ${series}: ${mkts.length} markets (sorted by expiry) ===`);
    for (const m of withExpiry.slice(0, 10)) {
      const hrs = (m.secsLeft / 3600).toFixed(1);
      console.log(`  ${m.ticker} | ${hrs}h left | strike: ${m.strike} | vol: ${m.volume} | yes_ask: ${m.yesAsk} no_ask: ${m.noAsk}`);
    }
  }
}

main().catch(console.error);
