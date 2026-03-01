import 'dotenv/config';
import { KalshiAdapter } from './adapters/kalshiAdapter.js';
import { ArbEngine } from './engine/arbEngine.js';

const keyId = process.env.KALSHI_KEY_ID || '';
// Support escaped newlines from .env files
const privateKeyPem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const token = process.env.KALSHI_TOKEN || '';

if (!token && !(keyId && privateKeyPem)) {
  console.error('Missing Kalshi auth: set KALSHI_TOKEN or (KALSHI_KEY_ID + KALSHI_PRIVATE_KEY_PEM)');
  process.exit(1);
}

const startingCapital = Number(process.env.START_CAPITAL_USD || 8);

const engine = new ArbEngine(
  {
    ticker: process.env.KALSHI_TICKER || undefined,
    autoDiscoverTicker: process.env.AUTO_DISCOVER_TICKER !== 'false',
    dryRun: process.env.DRY_RUN !== 'false',
    enableArb: process.env.ENABLE_ARB !== 'false',
    enableDirectional: process.env.ENABLE_DIRECTIONAL !== 'false',
    allowLive: process.env.ALLOW_LIVE === 'true',
    pollMs: Number(process.env.POLL_MS || 300000),
    fees: {
      perContractCents: Number(process.env.FEE_PER_CONTRACT_CENTS || 0.2),
      roundTripSlippageCents: Number(process.env.SLIPPAGE_CENTS || 0.25),
    },
    risk: {
      maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || Math.max(4, startingCapital * 0.2)),
      maxNotionalPerTradeUsd: Number(process.env.MAX_NOTIONAL_PER_TRADE_USD || 2),
      maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || 2),
      minSecondsToExpiry: Number(process.env.MIN_SECONDS_TO_EXPIRY || 120),
      killSwitch: process.env.KILL_SWITCH === 'true',
    },
    journalPath: process.env.JOURNAL_PATH || './logs/trading-journal.jsonl',
    lockPath: process.env.LOCK_PATH || './tmp/trading-run.lock',
    circuitBreakerThreshold: Number(process.env.CIRCUIT_BREAKER_THRESHOLD || 3),
  },
  new KalshiAdapter(
    process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com',
    {
      bearerToken: token || undefined,
      keyId: keyId || undefined,
      privateKeyPem: privateKeyPem || undefined,
    },
  ),
);

if (process.env.ONCE === 'true') {
  await engine.runOnce();
  process.exit(0);
}

engine.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    engine.stop();
    process.exit(0);
  });
}
