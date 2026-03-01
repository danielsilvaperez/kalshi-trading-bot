import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const PERFORMANCE_LOG = process.env.PERFORMANCE_LOG_PATH || './logs/strategy-performance.jsonl';

interface StrategyPerformance {
  name: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  sharpe: number;
  lastUpdated: number;
  weight: number;
}

const STRATEGIES = [
  'momentum',
  'mean_reversion',
  'breakout',
  'cross_market_arb',
  'spread_arb',
  'market_making',
  'ml_prediction',
  'rl_optimized',
];

/**
 * Calculate performance for each strategy
 */
export function calculateStrategyPerformance(): StrategyPerformance[] {
  if (!existsSync(PERFORMANCE_LOG)) {
    return STRATEGIES.map((name) => ({
      name,
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgProfit: 0,
      avgLoss: 0,
      profitFactor: 0,
      sharpe: 0,
      lastUpdated: Date.now(),
      weight: 1 / STRATEGIES.length,
    }));
  }

  const lines = readFileSync(PERFORMANCE_LOG, 'utf8').split('\n').filter(Boolean);

  const byStrategy: Record<string, { wins: number; losses: number; profits: number[] }> = {};

  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (!byStrategy[r.strategy]) {
        byStrategy[r.strategy] = { wins: 0, losses: 0, profits: [] };
      }

      if (r.won) {
        byStrategy[r.strategy].wins++;
        byStrategy[r.strategy].profits.push(r.profitCents / 100);
      } else {
        byStrategy[r.strategy].losses++;
        byStrategy[r.strategy].profits.push(-Math.abs(r.profitCents / 100));
      }
    } catch {}
  }

  const performances: StrategyPerformance[] = [];
  let totalScore = 0;

  for (const name of STRATEGIES) {
    const p = byStrategy[name] || { wins: 0, losses: 0, profits: [] };
    const trades = p.wins + p.losses;

    const winRate = trades > 0 ? p.wins / trades : 0;
    const wins = p.profits.filter((x) => x > 0);
    const losses = p.profits.filter((x) => x < 0);
    const avgProfit = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0)) / losses.length : 1;
    const profitFactor = avgLoss > 0 ? avgProfit / avgLoss : 0;

    // Sharpe-ish ratio
    const mean = p.profits.reduce((a, b) => a + b, 0) / Math.max(1, p.profits.length);
    const variance = p.profits.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / Math.max(1, p.profits.length);
    const sharpe = Math.sqrt(variance) > 0 ? mean / Math.sqrt(variance) : 0;

    // Composite score for weighting
    const score = (winRate * 0.3) + (Math.min(2, profitFactor) * 0.3) + (Math.max(0, sharpe) * 0.2) + (Math.min(1, trades / 20) * 0.2);

    performances.push({
      name,
      trades,
      wins: p.wins,
      losses: p.losses,
      winRate,
      avgProfit,
      avgLoss,
      profitFactor,
      sharpe,
      lastUpdated: Date.now(),
      weight: score,
    });

    totalScore += score;
  }

  // Normalize weights
  for (const p of performances) {
    p.weight = totalScore > 0 ? p.weight / totalScore : 1 / performances.length;
  }

  return performances.sort((a, b) => b.weight - a.weight);
}

/**
 * Select best strategy ensemble for current conditions
 */
export function selectOptimalStrategy(
  performances: StrategyPerformance[],
  regime: 'trending' | 'ranging' | 'volatile',
): { primary: string; secondary: string; confidence: number } {
  // Filter by regime suitability
  const regimeMap: Record<string, string[]> = {
    trending: ['momentum', 'breakout', 'ml_prediction'],
    ranging: ['mean_reversion', 'spread_arb', 'market_making'],
    volatile: ['cross_market_arb', 'rl_optimized', 'ml_prediction'],
  };

  const suitable = performances.filter((p) => regimeMap[regime].includes(p.name));

  if (suitable.length === 0) {
    return { primary: 'ml_prediction', secondary: 'rl_optimized', confidence: 0.5 };
  }

  const top = suitable.slice(0, 2);

  return {
    primary: top[0]?.name || 'ml_prediction',
    secondary: top[1]?.name || 'rl_optimized',
    confidence: top[0]?.winRate || 0.5,
  };
}

export function logStrategyOutcome(strategy: string, won: boolean, profitCents: number) {
  const { appendFileSync } = require('node:fs');
  appendFileSync(PERFORMANCE_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    strategy,
    won,
    profitCents,
  }) + '\n');
}

/**
 * Dynamic position sizing based on strategy confidence
 */
export function calculateMetaSize(
  baseSize: number,
  strategyWeight: number,
  confidence: number,
): number {
  return Math.floor(baseSize * strategyWeight * (0.5 + confidence * 0.5));
}
