import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const microLogPath = process.env.MICRO_LOG_PATH || './logs/microstructure.jsonl';

interface MicroSnapshot {
  timestamp: number;
  bids: number[][]; // [price, size]
  asks: number[][];
  lastTrade: { price: number; size: number; side: 'buy' | 'sell' };
}

/**
 * Calculate order book imbalance at microsecond-level precision
 * Returns -1 (all sellers) to +1 (all buyers)
 */
export function calculateMicroImbalance(
  bids: number[][],
  asks: number[][],
  depth: number = 5,
): number {
  const bidSum = bids.slice(0, depth).reduce((s, [_, qty]) => s + qty, 0);
  const askSum = asks.slice(0, depth).reduce((s, [_, qty]) => s + qty, 0);

  if (bidSum + askSum === 0) return 0;

  return (bidSum - askSum) / (bidSum + askSum);
}

/**
 * Detect aggressive order flow
 * Large market orders that eat through book = informed flow
 */
export function detectAggressiveFlow(
  before: MicroSnapshot,
  after: MicroSnapshot,
): { detected: boolean; side: 'buy' | 'sell' | null; size: number; toxic: boolean } {
  // Check for large bid/ask depletion
  const bidDepletion = before.bids.slice(0, 3).reduce((s, [_, q]) => s + q, 0) -
                       after.bids.slice(0, 3).reduce((s, [_, q]) => s + q, 0);

  const askDepletion = before.asks.slice(0, 3).reduce((s, [_, q]) => s + q, 0) -
                       after.asks.slice(0, 3).reduce((s, [_, q]) => s + q, 0);

  const threshold = 10000; // 10k contracts

  if (bidDepletion > threshold) {
    const toxic = bidDepletion > threshold * 3;
    return { detected: true, side: 'sell', size: bidDepletion, toxic };
  }

  if (askDepletion > threshold) {
    const toxic = askDepletion > threshold * 3;
    return { detected: true, side: 'buy', size: askDepletion, toxic };
  }

  return { detected: false, side: null, size: 0, toxic: false };
}

/**
 * Order book slope analysis
 * Steep bid slope = strong support, steep ask slope = strong resistance
 */
export function analyzeBookSlope(
  bids: number[][],
  asks: number[][],
): { bidSlope: number; askSlope: number; signal: 'support' | 'resistance' | 'neutral' } {
  // Calculate slope (price change per unit of quantity)
  const bidSlope = bids.length >= 2
    ? (bids[bids.length - 1][0] - bids[0][0]) / bids.reduce((s, [_, q]) => s + q, 0)
    : 0;

  const askSlope = asks.length >= 2
    ? (asks[asks.length - 1][0] - asks[0][0]) / asks.reduce((s, [_, q]) => s + q, 0)
    : 0;

  let signal: 'support' | 'resistance' | 'neutral' = 'neutral';
  if (bidSlope < -0.01) signal = 'support'; // Steep bids = support
  if (askSlope > 0.01) signal = 'resistance'; // Steep asks = resistance

  return { bidSlope, askSlope, signal };
}

/**
 * Microstructure score for entry timing
 * Combines imbalance, flow, and slope
 */
export function calculateMicroScore(
  imbalance: number,
  flowSide: 'buy' | 'sell' | null,
  slopeSignal: 'support' | 'resistance' | 'neutral',
  desiredSide: 'yes' | 'no',
): { score: number; shouldEnter: boolean; reason: string } {
  let score = 0;
  const wantUp = desiredSide === 'yes';

  // Imbalance contribution (-1 to +1)
  score += imbalance * 0.3;

  // Flow contribution
  if (flowSide === 'buy' && wantUp) score += 0.3;
  else if (flowSide === 'sell' && !wantUp) score += 0.3;
  else if (flowSide !== null) score -= 0.3;

  // Slope contribution
  if (slopeSignal === 'support' && wantUp) score += 0.2;
  else if (slopeSignal === 'resistance' && !wantUp) score += 0.2;
  else if (slopeSignal !== 'neutral') score -= 0.2;

  const normalized = (score + 1) / 2; // 0-1

  return {
    score: normalized,
    shouldEnter: normalized > 0.6,
    reason: `imb:${imbalance.toFixed(2)} flow:${flowSide || 'none'} slope:${slopeSignal} = ${normalized.toFixed(2)}`,
  };
}

export function logMicrostructure(data: Record<string, unknown>) {
  appendFileSync(microLogPath, JSON.stringify({ ts: Date.now(), ...data }) + '\n');
}
