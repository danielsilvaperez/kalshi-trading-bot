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
  const path = '/trade-api/v2/markets?status=open&limit=200';
  const r = await axios.get(`${base}${path}`, { headers: sign('GET', path) });
  const markets = r.data?.markets ?? [];
  
  // Find BTC-related
  const btc = markets.filter((m: any) => {
    const t = `${m.ticker} ${m.title ?? ''}`.toLowerCase();
    return t.includes('btc') || t.includes('bitcoin');
  });

  console.log(`Total open markets: ${markets.length}`);
  console.log(`BTC-related: ${btc.length}`);
  console.log('---');
  
  for (const m of btc.slice(0, 30)) {
    const exp = m.expiration_time ? new Date(m.expiration_time) : null;
    const secsLeft = exp ? Math.floor((exp.getTime() - Date.now()) / 1000) : '?';
    console.log(`${m.ticker} | ${m.title ?? '(no title)'} | exp: ${exp?.toISOString() ?? '?'} | ${secsLeft}s left`);
  }
}

main().catch(console.error);
