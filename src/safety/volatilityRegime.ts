import { readFileSync, existsSync } from 'node:fs';

const momentumPath = process.env.MOMENTUM_PATH || './tmp/btc-momentum.json';

interface MomentumPoint {
  price: number;
  ts: number;
}

export interface VolatilityRegime {
  regime: 'stable' | 'trending' | 'choppy' | 'unknown' | 'edge';
  volatility: number; // normalized
  change1m: number;
  change5m: number;
  canTrade: boolean;
  reason?: string;
}

export function assessVolatilityRegime(): VolatilityRegime {
  if (!existsSync(momentumPath)) {
    return { regime: 'unknown', volatility: 0, change1m: 0, change5m: 0, canTrade: false, reason: 'no momentum data' };
  }

  let points: MomentumPoint[] = [];
  try {
    points = JSON.parse(readFileSync(momentumPath, 'utf8'));
  } catch {
    return { regime: 'unknown', volatility: 0, change1m: 0, change5m: 0, canTrade: false, reason: 'parse error' };
  }

  if (points.length < 5) {
    return { regime: 'unknown', volatility: 0, change1m: 0, change5m: 0, canTrade: false, reason: 'insufficient data' };
  }

  const now = Date.now();
  const recent = points.filter((p) => now - p.ts <= 300000); // last 5 min
  if (recent.length < 3) {
    return { regime: 'unknown', volatility: 0, change1m: 0, change5m: 0, canTrade: false, reason: 'no recent data' };
  }

  // Calculate price changes
  const current = recent[recent.length - 1].price;
  const p1m = [...recent].reverse().find((p) => now - p.ts <= 60000)?.price ?? recent[0].price;
  const p5m = recent[0].price;

  const change1m = (current - p1m) / p1m;
  const change5m = (current - p5m) / p5m;

  // Calculate volatility (std dev of returns)
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push((recent[i].price - recent[i-1].price) / recent[i-1].price);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance);

  // Classify regime
  const absChange1m = Math.abs(change1m);
  const absChange5m = Math.abs(change5m);

  // CHOPPY: high volatility, no clear direction, or rapid reversals
  if (volatility > 0.0008 || absChange1m > 0.003) {
    return {
      regime: 'choppy',
      volatility,
      change1m,
      change5m,
      canTrade: false,
      reason: `choppy: vol=${(volatility*100).toFixed(3)}%, 1m move=${(absChange1m*100).toFixed(3)}%`,
    };
  }

  // TRENDING: consistent direction, moderate volatility
  if (absChange5m > 0.0005 && Math.abs(change1m) > 0.00015 && change1m * change5m > 0) {
    return {
      regime: 'trending',
      volatility,
      change1m,
      change5m,
      canTrade: true,
    };
  }

  // STABLE: low volatility, small moves
  if (volatility < 0.0003 && absChange1m < 0.0005) {
    return {
      regime: 'stable',
      volatility,
      change1m,
      change5m,
      canTrade: true,
    };
  }

  // Default: edge case - allow trading with caution
  return {
    regime: 'edge',
    volatility,
    change1m,
    change5m,
    canTrade: true,
    reason: 'unclear regime - trading with reduced size',
  };
}
