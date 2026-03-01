import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DEFAULT_ADAPTIVE } from './config/adaptive.js';

const outcomesPath = process.env.OUTCOMES_PATH || './logs/outcomes.jsonl';
const adaptivePath = process.env.ADAPTIVE_CONFIG_PATH || './config/adaptive.json';

interface OutcomeRecord {
  ts?: string;
  ticker: string;
  side: 'yes' | 'no';
  entryPrice: number;
  count: number;
  result: string;
  won: boolean;
  profitCents: number;
  holdingTimeMin?: number;
}

function loadRecentOutcomes(windowMs = 24 * 60 * 60 * 1000): OutcomeRecord[] {
  if (!existsSync(outcomesPath)) return [];
  const lines = readFileSync(outcomesPath, 'utf8').split('\n').filter(Boolean);
  const now = Date.now();
  const records: OutcomeRecord[] = [];

  for (const line of lines.slice(-50)) {
    try {
      const r = JSON.parse(line) as OutcomeRecord & { ts?: string };
      if (r.ts) {
        const ts = new Date(r.ts).getTime();
        if (now - ts < windowMs) records.push(r);
      } else {
        records.push(r);
      }
    } catch {}
  }

  return records;
}

function loadAdaptive() {
  if (!existsSync(adaptivePath)) return DEFAULT_ADAPTIVE;
  try {
    return JSON.parse(readFileSync(adaptivePath, 'utf8'));
  } catch {
    return DEFAULT_ADAPTIVE;
  }
}

function saveAdaptive(cfg: typeof DEFAULT_ADAPTIVE) {
  writeFileSync(adaptivePath, JSON.stringify(cfg, null, 2));
}

function calculateWinRateByPriceBucket(records: OutcomeRecord[]): Record<string, { wins: number; losses: number; total: number; winRate: number }> {
  const buckets: Record<string, { wins: number; losses: number } > = {};

  for (const r of records) {
    const bucket = Math.floor(r.entryPrice / 10) * 10; // 0-10, 10-20, etc
    const key = `${bucket}-${bucket + 10}`;
    if (!buckets[key]) buckets[key] = { wins: 0, losses: 0 };
    if (r.won) buckets[key].wins++;
    else buckets[key].losses++;
  }

  const result: Record<string, { wins: number; losses: number; total: number; winRate: number }> = {};
  for (const [key, v] of Object.entries(buckets)) {
    const total = v.wins + v.losses;
    result[key] = { wins: v.wins, losses: v.losses, total, winRate: total > 0 ? v.wins / total : 0 };
  }

  return result;
}

function main() {
  const outcomes = loadRecentOutcomes();
  const current = loadAdaptive();

  if (outcomes.length < 3) {
    console.log('[calibrate] not enough outcomes yet', outcomes.length);
    return;
  }

  const wins = outcomes.filter((o) => o.won).length;
  const losses = outcomes.filter((o) => !o.won).length;
  const winRate = wins / outcomes.length;
  const totalProfit = outcomes.reduce((s, o) => s + o.profitCents, 0);

  const buckets = calculateWinRateByPriceBucket(outcomes);

  console.log('[calibrate]', {
    trades: outcomes.length,
    wins,
    losses,
    winRate: `${(winRate * 100).toFixed(1)}%`,
    totalProfitCents: totalProfit,
    buckets,
  });

  // Dynamic adjustment based on recent performance
  const adjusted = { ...current };

  if (winRate < 0.4) {
    // Losing streak - tighten significantly
    adjusted.minEvCents = Math.min(5, current.minEvCents + 0.5);
    adjusted.highPriceMinConfidence = Math.min(0.96, current.highPriceMinConfidence + 0.01);
    adjusted.maxSpendCents = Math.max(40, current.maxSpendCents - 10);
  } else if (winRate > 0.6 && totalProfit > 0) {
    // Winning - can loosen carefully
    adjusted.minEvCents = Math.max(1.5, current.minEvCents - 0.3);
    adjusted.highPriceMinConfidence = Math.max(0.88, current.highPriceMinConfidence - 0.01);
    adjusted.maxSpendCents = Math.min(90, current.maxSpendCents + 5);
  }

  // Consecutive loss protection
  const last5 = outcomes.slice(-5);
  const last5Losses = last5.filter((o) => !o.won).length;
  if (last5Losses >= 4) {
    adjusted.minEvCents = Math.min(6, adjusted.minEvCents + 1);
    adjusted.maxSpendCents = Math.max(30, adjusted.maxSpendCents - 15);
    console.log('[calibrate] CONSECUTIVE LOSS PROTECTION activated');
  }

  saveAdaptive(adjusted);
  console.log('[calibrate] adjusted', { before: current, after: adjusted });
}

main();
