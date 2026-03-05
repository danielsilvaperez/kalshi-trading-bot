import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_ADAPTIVE, type AdaptiveConfig } from './config/adaptive.js';
import { journal } from './engine/journal.js';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
const adaptivePath = process.env.ADAPTIVE_CONFIG_PATH || './config/adaptive.json';
const journalPath = process.env.JOURNAL_PATH || './logs/trading-15m.jsonl';

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

function loadAdaptive(): AdaptiveConfig {
  if (!existsSync(adaptivePath)) return DEFAULT_ADAPTIVE;
  try {
    const raw = JSON.parse(readFileSync(adaptivePath, 'utf8')) as Partial<AdaptiveConfig>;
    return {
      minEvCents: Number(raw.minEvCents ?? DEFAULT_ADAPTIVE.minEvCents),
      highPriceMinConfidence: Number(raw.highPriceMinConfidence ?? DEFAULT_ADAPTIVE.highPriceMinConfidence),
      maxSpendCents: Number(raw.maxSpendCents ?? DEFAULT_ADAPTIVE.maxSpendCents),
    };
  } catch {
    return DEFAULT_ADAPTIVE;
  }
}

function saveAdaptive(cfg: AdaptiveConfig) {
  mkdirSync(dirname(adaptivePath), { recursive: true });
  writeFileSync(adaptivePath, JSON.stringify(cfg, null, 2));
}

async function main() {
  const before = loadAdaptive();

  const posPath = '/trade-api/v2/portfolio/positions';
  const r = await axios.get(`${base}${posPath}`, { headers: sign('GET', posPath) });
  const positions = (r.data?.market_positions ?? r.data?.positions ?? []) as any[];

  const realizedPnlCents = positions.reduce((s, p) => s + Number(p.realized_pnl ?? 0), 0);

  const after: AdaptiveConfig = { ...before };

  // Recursive self-improvement: tighten on drawdown, loosen carefully on gains
  if (realizedPnlCents <= -20) {
    after.minEvCents = Math.min(8, before.minEvCents + 1);
    after.highPriceMinConfidence = Math.min(0.96, before.highPriceMinConfidence + 0.01);
    after.maxSpendCents = Math.max(50, before.maxSpendCents - 10);
  } else if (realizedPnlCents >= 20) {
    after.minEvCents = Math.max(2, before.minEvCents - 0.5);
    after.highPriceMinConfidence = Math.max(0.88, before.highPriceMinConfidence - 0.005);
    after.maxSpendCents = Math.min(120, before.maxSpendCents + 5);
  }

  saveAdaptive(after);

  journal(journalPath, {
    type: 'self_improve',
    realizedPnlCents,
    before,
    after,
  });

  console.log('[self-improve]', { realizedPnlCents, before, after });
}

main().catch((e) => {
  console.error('[self-improve] error', e);
});
