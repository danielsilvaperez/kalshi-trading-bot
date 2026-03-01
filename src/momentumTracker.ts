import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
const momentumPath = process.env.MOMENTUM_PATH || './tmp/btc-momentum.json';

if (!keyId || !pem) process.exit(0);

function sign(method: string, path: string) {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64'),
  };
}

interface MomentumPoint {
  price: number;
  ts: number;
  source: string;
}

function loadMomentum(): MomentumPoint[] {
  if (!existsSync(momentumPath)) return [];
  try {
    return JSON.parse(readFileSync(momentumPath, 'utf8'));
  } catch {
    return [];
  }
}

function saveMomentum(points: MomentumPoint[]) {
  mkdirSync(dirname(momentumPath), { recursive: true });
  writeFileSync(momentumPath, JSON.stringify(points.slice(-100), null, 2));
}

async function fetchSpot(): Promise<{ price: number; source: string } | null> {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: 'bitcoin', vs_currencies: 'usd' },
      timeout: 5000,
    });
    return { price: r.data?.bitcoin?.usd ?? 0, source: 'coingecko' };
  } catch {
    try {
      const r = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 5000 });
      return { price: parseFloat(r.data?.data?.amount ?? '0'), source: 'coinbase' };
    } catch {
      return null;
    }
  }
}

function calculateMomentum(points: MomentumPoint[]): {
  change1m: number;
  change5m: number;
  change10m: number;
  direction: 'up' | 'down' | 'flat';
  strength: number;
} {
  if (points.length < 2) {
    return { change1m: 0, change5m: 0, change10m: 0, direction: 'flat', strength: 0 };
  }

  const now = Date.now();
  const current = points[points.length - 1].price;

  const p1m = [...points].reverse().find((p) => now - p.ts <= 60000)?.price ?? points[0].price;
  const p5m = [...points].reverse().find((p) => now - p.ts <= 300000)?.price ?? points[0].price;
  const p10m = [...points].reverse().find((p) => now - p.ts <= 600000)?.price ?? points[0].price;

  const c1m = (current - p1m) / p1m;
  const c5m = (current - p5m) / p5m;
  const c10m = (current - p10m) / p10m;

  const avgChange = (c1m + c5m * 0.5) / 1.5;
  let direction: 'up' | 'down' | 'flat' = 'flat';
  if (avgChange > 0.0003) direction = 'up';
  else if (avgChange < -0.0003) direction = 'down';

  return {
    change1m: c1m,
    change5m: c5m,
    change10m: c10m,
    direction,
    strength: Math.abs(avgChange) * 1000,
  };
}

async function main() {
  const spot = await fetchSpot();
  if (!spot) {
    console.log('[momentum] spot fetch failed');
    return;
  }

  const points = loadMomentum();
  points.push({ price: spot.price, ts: Date.now(), source: spot.source });
  saveMomentum(points);

  const mom = calculateMomentum(points);
  console.log('[momentum]', {
    price: spot.price.toFixed(2),
    change1m: `${(mom.change1m * 100).toFixed(3)}%`,
    change5m: `${(mom.change5m * 100).toFixed(3)}%`,
    direction: mom.direction,
    strength: mom.strength.toFixed(2),
  });
}

main().catch(console.error);
