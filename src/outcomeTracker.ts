import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
const outcomesPath = process.env.OUTCOMES_PATH || './logs/outcomes.jsonl';
const positionsPath = process.env.POSITIONS_TRACKER_PATH || './tmp/tracked-positions.json';

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

interface TrackedPosition {
  ticker: string;
  side: 'yes' | 'no';
  entryPrice: number;
  count: number;
  entryTime: number;
  expectedResolutionTime: number;
  orderId: string;
}

function loadTracked(): TrackedPosition[] {
  if (!existsSync(positionsPath)) return [];
  try {
    return JSON.parse(readFileSync(positionsPath, 'utf8'));
  } catch {
    return [];
  }
}

function saveTracked(positions: TrackedPosition[]) {
  mkdirSync(dirname(positionsPath), { recursive: true });
  writeFileSync(positionsPath, JSON.stringify(positions, null, 2));
}

function appendOutcome(record: Record<string, unknown>) {
  mkdirSync(dirname(outcomesPath), { recursive: true });
  appendFileSync(outcomesPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
}

async function getMarketStatus(ticker: string) {
  try {
    const path = `/trade-api/v2/markets/${ticker}`;
    const r = await axios.get(`${base}${path}`, { headers: sign('GET', path) });
    return r.data?.market ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const now = Date.now();
  const tracked = loadTracked();
  if (tracked.length === 0) {
    console.log('[outcome] no tracked positions');
    return;
  }

  const remaining: TrackedPosition[] = [];

  for (const pos of tracked) {
    // Check if resolution time passed
    if (now < pos.expectedResolutionTime + 120000) {
      remaining.push(pos);
      continue;
    }

    const market = await getMarketStatus(pos.ticker);
    if (!market) {
      console.log(`[outcome] could not fetch ${pos.ticker}`);
      remaining.push(pos);
      continue;
    }

    const status = market.status;
    const result = market.result;

    if (status !== 'settled' && status !== 'closed') {
      remaining.push(pos);
      continue;
    }

    // Determine if we won
    let won = false;
    let profitCents = 0;

    if (result === 'yes') {
      won = pos.side === 'yes';
      profitCents = won ? (100 - pos.entryPrice) * pos.count : -pos.entryPrice * pos.count;
    } else if (result === 'no') {
      won = pos.side === 'no';
      profitCents = won ? (100 - pos.entryPrice) * pos.count : -pos.entryPrice * pos.count;
    }

    const outcome = {
      ticker: pos.ticker,
      side: pos.side,
      entryPrice: pos.entryPrice,
      count: pos.count,
      result,
      won,
      profitCents,
      holdingTimeMin: Math.floor((now - pos.entryTime) / 60000),
    };

    appendOutcome(outcome);
    console.log('[outcome]', outcome);
  }

  saveTracked(remaining);
}

main().catch(console.error);
