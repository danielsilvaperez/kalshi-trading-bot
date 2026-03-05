import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const CIRCUIT_LOG = process.env.CIRCUIT_LOG_PATH || './logs/circuit-breaker.jsonl';

interface PriceTick {
  price: number;
  timestamp: number;
}

const CIRCUIT_THRESHOLDS = {
  level1: 0.05, // 5% in 1 min = warning
  level2: 0.10, // 10% in 1 min = halt
  level3: 0.15, // 15% in 1 min = kill switch
};

/**
 * Detect flash crash or flash pump
 * Returns true if trading should be halted
 */
export function detectFlashCrash(
  recentPrices: PriceTick[],
): { halt: boolean; level: 0 | 1 | 2 | 3; change: number; reason: string } {
  if (recentPrices.length < 2) {
    return { halt: false, level: 0, change: 0, reason: 'insufficient data' };
  }

  const now = recentPrices[recentPrices.length - 1];
  const oneMinAgo = recentPrices.find((p) => now.timestamp - p.timestamp <= 60000) || recentPrices[0];

  const change = (now.price - oneMinAgo.price) / oneMinAgo.price;

  // Fat finger detection: single tick > 3% away from VWAP
  const vwap = calculateVWAP(recentPrices);
  const fatFinger = Math.abs(now.price - vwap) / vwap > 0.03;

  if (fatFinger) {
    logCircuitEvent('fat_finger', change);
    return { halt: true, level: 2, change, reason: 'Fat finger detected' };
  }

  if (Math.abs(change) >= CIRCUIT_THRESHOLDS.level3) {
    logCircuitEvent('level3', change);
    return { halt: true, level: 3, change, reason: `Flash ${change > 0 ? 'pump' : 'crash'}: ${(change * 100).toFixed(1)}%` };
  }

  if (Math.abs(change) >= CIRCUIT_THRESHOLDS.level2) {
    logCircuitEvent('level2', change);
    return { halt: true, level: 2, change, reason: `Extreme move: ${(change * 100).toFixed(1)}%` };
  }

  if (Math.abs(change) >= CIRCUIT_THRESHOLDS.level1) {
    logCircuitEvent('level1', change);
    return { halt: false, level: 1, change, reason: `Elevated volatility: ${(change * 100).toFixed(1)}%` };
  }

  return { halt: false, level: 0, change, reason: 'normal' };
}

function calculateVWAP(prices: PriceTick[]): number {
  // Simplified VWAP
  const sum = prices.reduce((s, p) => s + p.price, 0);
  return sum / prices.length;
}

function logCircuitEvent(level: string, change: number) {
  appendFileSync(CIRCUIT_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    level,
    change: (change * 100).toFixed(2) + '%',
  }) + '\n');
}

/**
 * Check if we should resume trading after halt
 */
export function checkResumeConditions(
  recentPrices: PriceTick[],
): boolean {
  const last5 = recentPrices.slice(-5);
  if (last5.length < 5) return false;

  // Check if prices stabilized (std dev < 0.5%)
  const mean = last5.reduce((s, p) => s + p.price, 0) / last5.length;
  const variance = last5.reduce((s, p) => s + Math.pow(p.price - mean, 2), 0) / last5.length;
  const stdDev = Math.sqrt(variance);

  return (stdDev / mean) < 0.005;
}

/**
 * Fat finger detection: unusually large trade at off-market price
 */
export function detectFatFinger(
  trade: { price: number; size: number; side: 'buy' | 'sell' },
  bookVWAP: number,
): boolean {
  const priceDeviation = Math.abs(trade.price - bookVWAP) / bookVWAP;
  const isLarge = trade.size > 10000; // 10k+ contracts

  return priceDeviation > 0.02 && isLarge; // 2% off market
}
