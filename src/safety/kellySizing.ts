import { readFileSync, existsSync } from 'node:fs';

const outcomesPath = process.env.OUTCOMES_PATH || './logs/outcomes.jsonl';

interface OutcomeRecord {
  entryPrice: number;
  won: boolean;
  profitCents: number;
}

function loadRecentOutcomes(windowMs = 24 * 60 * 60 * 1000): OutcomeRecord[] {
  if (!existsSync(outcomesPath)) return [];
  const lines = readFileSync(outcomesPath, 'utf8').split('\n').filter(Boolean);
  const now = Date.now();
  const records: OutcomeRecord[] = [];
  for (const line of lines.slice(-100)) {
    try {
      const r = JSON.parse(line);
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

export interface KellySizing {
  fraction: number; // 0-1
  edge: number;
  variance: number;
  confidence: number;
}

export function calculateKellySizing(price: number, side: 'yes' | 'no'): KellySizing {
  const outcomes = loadRecentOutcomes();

  // Filter to similar price bucket
  const bucketSize = 5;
  const bucketMin = Math.floor(price / bucketSize) * bucketSize;
  const bucketMax = bucketMin + bucketSize;
  const relevant = outcomes.filter((o) => o.entryPrice >= bucketMin && o.entryPrice < bucketMax);

  if (relevant.length < 5) {
    // Not enough data — use conservative default
    return { fraction: 0.3, edge: 0.05, variance: 0.25, confidence: 0.5 };
  }

  const wins = relevant.filter((o) => o.won).length;
  const winRate = wins / relevant.length;
  const avgProfit = relevant.reduce((s, o) => s + o.profitCents, 0) / relevant.length;
  const avgLoss = relevant.filter((o) => !o.won).reduce((s, o) => s + Math.abs(o.profitCents), 0) / Math.max(1, relevant.length - wins);

  // Kelly fraction = (p*b - q) / b where b = avg win / avg loss
  const b = avgProfit / Math.max(1, avgLoss);
  const p = winRate;
  const q = 1 - p;
  const kelly = (p * b - q) / b;

  // Half Kelly for safety
  const halfKelly = Math.max(0, Math.min(1, kelly * 0.5));

  // Variance estimate
  const variance = relevant.reduce((s, o) => {
    const diff = o.profitCents - avgProfit;
    return s + diff * diff;
  }, 0) / relevant.length;

  return {
    fraction: halfKelly,
    edge: p * b - q,
    variance: variance / 10000, // normalize
    confidence: Math.min(1, relevant.length / 20), // more data = higher confidence
  };
}

export function applyKellySizing(baseSpendCents: number, kelly: KellySizing): number {
  // Scale base spend by Kelly fraction and confidence
  const adjusted = baseSpendCents * kelly.fraction * (0.5 + kelly.confidence * 0.5);
  return Math.max(20, Math.min(baseSpendCents, Math.floor(adjusted)));
}
