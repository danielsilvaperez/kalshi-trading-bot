import { readFileSync, existsSync } from 'node:fs';

const outcomesPath = process.env.OUTCOMES_PATH || './logs/outcomes.jsonl';

interface VarianceMetrics {
  currentVolatility: number; // daily PnL volatility
  targetVolatility: number;
  positionSizeMultiplier: number;
  shouldReduceSize: boolean;
  shouldIncreaseSize: boolean;
}

/**
 * Calculate realized volatility from recent trades
 */
export function calculateRealizedVolatility(window = 20): number {
  if (!existsSync(outcomesPath)) return 0.25; // default 25% vol

  const lines = readFileSync(outcomesPath, 'utf8').split('\n').filter(Boolean);
  const outcomes = lines.slice(-window).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  if (outcomes.length < 5) return 0.25;

  const pnls = outcomes.map((o) => (o.profitCents || 0) / 100); // in dollars

  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const variance = pnls.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / pnls.length;
  const dailyVol = Math.sqrt(variance);

  // Annualize (assuming ~10 trades per day for 15m strategy)
  const annualVol = dailyVol * Math.sqrt(252);

  return annualVol;
}

/**
 * Calculate position size multiplier to maintain target volatility
 */
export function varianceTargeting(
  targetVolatility: number = 0.50, // 50% annual target
  maxSize: number = 1.0,
  minSize: number = 0.3,
): VarianceMetrics {
  const currentVol = calculateRealizedVolatility(20);

  // If current vol is 0, use default
  if (currentVol === 0) {
    return {
      currentVolatility: 0,
      targetVolatility,
      positionSizeMultiplier: 0.5,
      shouldReduceSize: false,
      shouldIncreaseSize: false,
    };
  }

  // Kelly-like sizing for volatility: target / current
  const multiplier = targetVolatility / currentVol;
  const clamped = Math.max(minSize, Math.min(maxSize, multiplier));

  return {
    currentVolatility: currentVol,
    targetVolatility,
    positionSizeMultiplier: clamped,
    shouldReduceSize: multiplier < 0.8,
    shouldIncreaseSize: multiplier > 1.2,
  };
}

export function applyVarianceSizing(baseSpend: number, metrics: VarianceMetrics): number {
  return Math.floor(baseSpend * metrics.positionSizeMultiplier);
}
