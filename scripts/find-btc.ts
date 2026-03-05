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
  // Search for BTC/crypto markets using different approaches
  const searches = [
    '/trade-api/v2/markets?status=open&limit=200&series_ticker=KXBTC',
    '/trade-api/v2/markets?status=open&limit=200&series_ticker=KXBTCD',
    '/trade-api/v2/markets?status=open&limit=200&series_ticker=KXBITCOIN',
  ];

  for (const path of searches) {
    try {
      const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/markets') });
      const mkts = r.data?.markets ?? [];
      if (mkts.length > 0) {
        console.log(`\n=== ${path} → ${mkts.length} markets ===`);
        for (const m of mkts.slice(0, 15)) {
          console.log(`  ${m.ticker} | ${m.title ?? ''}`);
        }
      } else {
        console.log(`${path} → 0 markets`);
      }
    } catch (e: any) {
      console.log(`${path} → error ${e.response?.status}`);
    }
  }

  // Also get all unique series_tickers from first 1000 markets
  console.log('\n=== Unique series tickers (sample) ===');
  const allPath = '/trade-api/v2/markets?status=open&limit=200';
  const r = await axios.get(`${base}${allPath}`, { headers: sign('GET', '/trade-api/v2/markets') });
  const mkts = r.data?.markets ?? [];
  const seriesTickers = new Set(mkts.map((m: any) => m.series_ticker).filter(Boolean));
  const sorted = [...seriesTickers].sort();
  for (const st of sorted.slice(0, 50)) {
    console.log(`  ${st}`);
  }
  console.log(`  ... (${sorted.length} total unique series)`);
}

main().catch(console.error);
