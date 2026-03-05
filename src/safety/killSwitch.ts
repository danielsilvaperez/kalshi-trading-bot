import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
const minBalanceCents = Number(process.env.KILL_BALANCE_CENTS || 300);
const maxConsecutiveLosses = Number(process.env.MAX_CONSECUTIVE_LOSSES || 3);
const maxOpenPositions = Number(process.env.MAX_OPEN_POSITIONS || 2);

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

interface SafetyStatus {
  canTrade: boolean;
  reason?: string;
  balanceCents: number;
  consecutiveLosses: number;
  openPositions: number;
}

export async function checkSafety(): Promise<SafetyStatus> {
  if (!keyId || !pem) {
    return { canTrade: false, reason: 'missing auth', balanceCents: 0, consecutiveLosses: 0, openPositions: 0 };
  }

  try {
    // Check balance - use available_cash, not total balance
    const bal = await axios.get(`${base}/trade-api/v2/portfolio/balance`, { headers: sign('GET', '/trade-api/v2/portfolio/balance') });
    const balanceCents = bal.data?.available_cash ?? bal.data?.balance ?? 0;

    if (balanceCents < minBalanceCents) {
      return { canTrade: false, reason: `BALANCE KILL SWITCH: $${(balanceCents/100).toFixed(2)} < $${(minBalanceCents/100).toFixed(2)}`, balanceCents, consecutiveLosses: 0, openPositions: 0 };
    }

    // Check open positions
    const pos = await axios.get(`${base}/trade-api/v2/portfolio/positions`, { headers: sign('GET', '/trade-api/v2/portfolio/positions') });
    const positions = (pos.data?.market_positions ?? pos.data?.positions ?? []) as any[];
    const openPositions = positions.filter((p) => Math.abs(p.position || 0) > 0).length;

    if (openPositions >= maxOpenPositions) {
      return { canTrade: false, reason: `POSITION LIMIT: ${openPositions} open >= ${maxOpenPositions}`, balanceCents, consecutiveLosses: 0, openPositions };
    }

    // Check consecutive losses from outcomes log
    const consecutiveLosses = calculateConsecutiveLosses();
    if (consecutiveLosses >= maxConsecutiveLosses) {
      return { canTrade: false, reason: `LOSS STREAK KILL: ${consecutiveLosses} consecutive losses`, balanceCents, consecutiveLosses, openPositions };
    }

    return { canTrade: true, balanceCents, consecutiveLosses, openPositions };
  } catch (e) {
    return { canTrade: false, reason: 'safety check error', balanceCents: 0, consecutiveLosses: 0, openPositions: 0 };
  }
}

function calculateConsecutiveLosses(): number {
  try {
    const { readFileSync, existsSync } = require('node:fs');
    const path = process.env.OUTCOMES_PATH || './logs/outcomes.jsonl';
    if (!existsSync(path)) return 0;
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    let streak = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]);
      if (rec.won === false) streak++;
      else if (rec.won === true) break;
    }
    return streak;
  } catch {
    return 0;
  }
}
