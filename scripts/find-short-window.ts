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
  // Paginate through ALL open markets and find anything expiring within 2 hours
  const now = Date.now();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  let cursor: string | undefined;
  const shortExpiry: any[] = [];
  const seriesSeen = new Set<string>();
  let total = 0;

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ status: 'open', limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const path = `/trade-api/v2/markets?${params}`;
    const r = await axios.get(`${base}${path}`, { headers: sign('GET', '/trade-api/v2/markets') });
    const markets = r.data?.markets ?? [];
    total += markets.length;
    cursor = r.data?.cursor;

    for (const m of markets) {
      if (m.series_ticker) seriesSeen.add(m.series_ticker);
      const exp = m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
      if (exp > now && exp - now < twoHoursMs) {
        shortExpiry.push({
          ticker: m.ticker,
          series: m.series_ticker,
          title: m.title,
          expiry: m.expiration_time,
          minsLeft: ((exp - now) / 60000).toFixed(1),
          volume: m.volume,
        });
      }
    }

    if (!cursor || markets.length < 200) break;
  }

  console.log(`Total markets scanned: ${total}`);
  console.log(`\n=== Markets expiring within 2 hours: ${shortExpiry.length} ===`);
  shortExpiry.sort((a, b) => parseFloat(a.minsLeft) - parseFloat(b.minsLeft));
  for (const m of shortExpiry.slice(0, 40)) {
    console.log(`  ${m.ticker} | series: ${m.series} | ${m.minsLeft}min | vol: ${m.volume} | ${m.title?.slice(0, 80)}`);
  }

  // Also show all unique series tickers (find crypto ones)
  console.log(`\n=== All unique series tickers (${seriesSeen.size}) ===`);
  const sorted = [...seriesSeen].sort();
  for (const s of sorted) {
    const lower = s.toLowerCase();
    if (lower.includes('btc') || lower.includes('bitcoin') || lower.includes('crypto') || lower.includes('eth') || lower.includes('sol')) {
      console.log(`  🪙 ${s}`);
    }
  }
  // Show all
  console.log(`\n  All: ${sorted.join(', ')}`);
}

main().catch(console.error);
