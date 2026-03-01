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

async function main() {
  // Get first market and dump ALL fields
  const path = '/trade-api/v2/markets?status=open&limit=3';
  const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/markets') });
  const mkts = r.data?.markets ?? [];
  if (mkts.length > 0) {
    console.log('=== SAMPLE MARKET (all fields) ===');
    console.log(JSON.stringify(mkts[0], null, 2));
  }

  // Also get a KXBTCD market
  const path2 = '/trade-api/v2/markets?status=open&limit=1&series_ticker=KXBTCD';
  const r2 = await axios.get(`${base}${path2}`, { headers: sign('GET', '/trade-api/v2/markets') });
  const btcMkts = r2.data?.markets ?? [];
  if (btcMkts.length > 0) {
    console.log('\n=== KXBTCD SAMPLE (all fields) ===');
    console.log(JSON.stringify(btcMkts[0], null, 2));
  }

  // Check events endpoint for short-duration
  console.log('\n=== EVENTS (crypto) ===');
  for (const series of ['KXBTC', 'KXBTCD', 'KXBTCUSD', 'KXBTC5', 'KXBTC15', 'KXBTC-15', 'KXBTCM']) {
    try {
      const ep = `/trade-api/v2/events?series_ticker=${series}&status=open&limit=5`;
      const re = await axios.get(`${base}${ep}`, { headers: sign('GET', '/trade-api/v2/events') });
      const evts = re.data?.events ?? [];
      if (evts.length > 0) {
        console.log(`\n  ${series}: ${evts.length} events`);
        for (const e of evts.slice(0, 3)) {
          console.log(`    ${e.event_ticker} | ${e.title} | markets: ${e.markets?.length ?? '?'}`);
        }
      }
    } catch {}
  }
}

main().catch(console.error);
