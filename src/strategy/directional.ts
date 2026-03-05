import type { MarketSnapshot, Side } from '../types/index.js';

export interface SpotPrice {
  price: number;
  ts: number;
}

export interface DirectionalDecision {
  ok: boolean;
  reason?: string;
  side?: Side;
  confidence?: number;
  entryPrice?: number;
  sizeContracts?: number;
  spotPrice?: number;
  impliedProb?: number;
  delta?: number;
}

/**
 * Directional strategy: exploit lag between BTC spot move and Kalshi implied probability.
 *
 * Logic:
 * - Fetch current BTC spot price
 * - Fetch recent BTC spot price (N minutes ago)
 * - If spot moved significantly in one direction but Kalshi hasn't repriced,
 *   bet in the direction of momentum.
 *
 * For "will BTC be above X at expiry?" markets:
 * - If spot is well above strike and YES is still cheap → buy YES
 * - If spot is well below strike and NO is still cheap → buy NO
 */
export function evaluateDirectional(
  snap: MarketSnapshot,
  currentSpot: SpotPrice,
  recentSpot: SpotPrice,
  strikePrice: number,
  maxNotionalUsd: number,
  minConfidence = 0.62,
): DirectionalDecision {
  const ya = snap.top.yesAsk;
  const na = snap.top.noAsk;
  if (ya == null || na == null) return { ok: false, reason: 'missing asks' };

  // Calculate spot momentum
  const spotDelta = (currentSpot.price - recentSpot.price) / recentSpot.price;
  const spotAbsDelta = Math.abs(spotDelta);

  // Need meaningful spot movement (>0.15% in the window)
  if (spotAbsDelta < 0.0015) {
    return { ok: false, reason: `spot move too small (${(spotDelta * 100).toFixed(3)}%)` };
  }

  // Distance from strike as fraction
  const distFromStrike = (currentSpot.price - strikePrice) / strikePrice;

  let side: Side;
  let entryPrice: number;
  let confidence: number;

  if (distFromStrike > 0.001 && spotDelta > 0) {
    // Spot above strike and moving up → YES
    side = 'YES';
    entryPrice = ya;
    // Confidence scales with distance from strike + momentum
    confidence = Math.min(0.85, 0.5 + Math.abs(distFromStrike) * 10 + spotAbsDelta * 50);
  } else if (distFromStrike < -0.001 && spotDelta < 0) {
    // Spot below strike and moving down → NO
    side = 'NO';
    entryPrice = na;
    confidence = Math.min(0.85, 0.5 + Math.abs(distFromStrike) * 10 + spotAbsDelta * 50);
  } else {
    return { ok: false, reason: 'no clear directional signal' };
  }

  if (confidence < minConfidence) {
    return { ok: false, reason: `confidence too low (${(confidence * 100).toFixed(1)}%)` };
  }

  // Don't buy overpriced contracts
  if (entryPrice > 85) {
    return { ok: false, reason: `entry too expensive (${entryPrice}c)` };
  }

  // Don't buy nearly worthless contracts
  if (entryPrice < 8) {
    return { ok: false, reason: `entry too cheap / likely lost cause (${entryPrice}c)` };
  }

  const notionalPerContract = entryPrice / 100;
  const sizeContracts = Math.max(1, Math.floor(maxNotionalUsd / notionalPerContract));

  return {
    ok: true,
    side,
    confidence,
    entryPrice,
    sizeContracts,
    spotPrice: currentSpot.price,
    impliedProb: side === 'YES' ? ya : na,
    delta: spotDelta,
  };
}
