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
  // Try the series ticker from the URL: KXBTC15M
  const tickers = ['KXBTC15M', 'KXBTC15', 'KXBTC-15M', 'KXBTC-15MIN'];
  
  for (const series of tickers) {
    try {
      const path = `/trade-api/v2/markets?status=open&limit=50&series_ticker=${series}`;
      const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/markets') });
      const mkts = r.data?.markets ?? [];
      console.log(`${series}: ${mkts.length} markets`);
      
      if (mkts.length > 0) {
        const now = Date.now();
        for (const m of mkts.slice(0, 10)) {
          const exp = m.expected_expiration_time ? new Date(m.expected_expiration_time).getTime() : 0;
          const close = m.close_time ? new Date(m.close_time).getTime() : 0;
          const minsToClose = ((close - now) / 60000).toFixed(1);
          const minsToExp = ((exp - now) / 60000).toFixed(1);
          console.log(`  ${m.ticker} | close: ${minsToClose}min | exp: ${minsToExp}min | vol: ${m.volume} | ${m.title?.slice(0, 60)} | yes_ask: ${m.yes_ask} no_ask: ${m.no_ask}`);
        }
      }
    } catch (e: any) {
      console.log(`${series}: error ${e.response?.status}`);
    }
  }

  // Also try events
  console.log('\n=== Events ===');
  for (const series of tickers) {
    try {
      const path = `/trade-api/v2/events?series_ticker=${series}&status=open&limit=10`;
      const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/events') });
      const evts = r.data?.events ?? [];
      if (evts.length > 0) {
        console.log(`${series}: ${evts.length} events`);
        for (const e of evts) {
          console.log(`  ${e.event_ticker} | ${e.title} | category: ${e.category}`);
        }
      }
    } catch {}
  }

  // Also check recently settled/closed to see if they existed today
  console.log('\n=== Recently closed KXBTC15M ===');
  try {
    const path = '/trade-api/v2/markets?status=closed&limit=20&series_ticker=KXBTC15M';
    const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/markets') });
    const mkts = r.data?.markets ?? [];
    console.log(`Closed: ${mkts.length}`);
    for (const m of mkts.slice(0, 10)) {
      console.log(`  ${m.ticker} | result: ${m.result} | exp: ${m.expiration_time} | vol: ${m.volume}`);
    }
  } catch (e: any) {
    console.log(`Closed query error: ${e.response?.status}`);
  }
}

main().catch(console.error);
