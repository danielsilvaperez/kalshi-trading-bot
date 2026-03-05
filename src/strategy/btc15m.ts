export interface Market15m {
  ticker: string;
  title: string;
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  noBid: number;
  closeTime: number;
  volume: number;
  yesBook: number[][];
  noBook: number[][];
}

export interface SpotMomentum {
  currentPrice: number;
  priceAge: number;
  source: string;
  change1m?: number;
  change5m?: number;
  direction?: 'up' | 'down' | 'flat';
  strength?: number;
}

export interface Decision15m {
  trade: boolean;
  side?: 'yes' | 'no';
  price?: number;
  count?: number;
  reason: string;
  ev?: number;
  confidence?: number;
  signals?: Record<string, number | string>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Strategy v4: momentum-aware, urgency-controlled, outcome-calibrated.
 *
 * - Uses BTC momentum to adjust probability model
 * - Urgency control: stricter in last 3 minutes
 * - Requires all signals aligned (depth, spread, momentum)
 */
export function evaluate15mTrade(
  market: Market15m,
  spot: SpotMomentum,
  maxSpendCents: number,
  nowMs: number,
  opts?: { minEvCents?: number; highPriceMinConfidence?: number },
): Decision15m {
  const minsToClose = (market.closeTime - nowMs) / 60000;

  // URGENCY CONTROL: stricter in last 3 minutes
  const isLate = minsToClose < 3;
  const urgencyMultiplier = isLate ? 1.5 : 1.0;

  if (minsToClose < 1.5) return { trade: false, reason: `too close to expiry (${minsToClose.toFixed(1)}min)` };
  if (minsToClose > 16) return { trade: false, reason: `market not active yet (${minsToClose.toFixed(1)}min)` };
  if (market.volume < 150) return { trade: false, reason: `low volume (${market.volume})` };

  const ya = market.yesAsk;
  const na = market.noAsk;
  if (ya <= 0 || na <= 0 || ya >= 100 || na >= 100) return { trade: false, reason: 'invalid ask prices' };

  const yesDepth = market.yesBook.reduce((s, [_, q]) => s + q, 0);
  const noDepth = market.noBook.reduce((s, [_, q]) => s + q, 0);
  const depthTotal = yesDepth + noDepth;
  const depthImb = depthTotal > 0 ? (yesDepth - noDepth) / depthTotal : 0;

  const yesSpread = Math.max(0, ya - (market.yesBid || 0));
  const noSpread = Math.max(0, na - (market.noBid || 0));
  const spreadBias = clamp((noSpread - yesSpread) / 100, -0.2, 0.2);

  const avgSpread = (yesSpread + noSpread) / 2;
  if (avgSpread > 18) return { trade: false, reason: `spread too wide (${avgSpread.toFixed(1)}c)` };

  const yesTopQty = market.yesBook?.[0]?.[1] ?? 0;
  const noTopQty = market.noBook?.[0]?.[1] ?? 0;
  if (yesTopQty < 10 || noTopQty < 10) {
    return { trade: false, reason: `thin top-of-book (yes=${yesTopQty}, no=${noTopQty})` };
  }

  const impliedYes = ya / 100;
  const impliedNo = na / 100;

  // MOMENTUM ADJUSTMENT: boost model probability in momentum direction
  let momentumBoost = 0;
  if (spot.direction === 'up' && spot.change5m && spot.change5m > 0.0005) {
    momentumBoost = 0.05; // YES more likely
  } else if (spot.direction === 'down' && spot.change5m && spot.change5m < -0.0005) {
    momentumBoost = -0.05; // NO more likely
  }

  const modelYes = clamp(impliedYes + depthImb * 0.12 + spreadBias * 0.08 + momentumBoost, 0.03, 0.97);
  const modelNo = 1 - modelYes;

  const evYes = modelYes * (100 - ya) - (1 - modelYes) * ya;
  const evNo = modelNo * (100 - na) - (1 - modelNo) * na;

  const pickYes = evYes >= evNo;
  const side: 'yes' | 'no' = pickYes ? 'yes' : 'no';
  const price = pickYes ? ya : na;
  const ev = pickYes ? evYes : evNo;
  const confidence = pickYes ? modelYes : modelNo;

  // MOMENTUM-DIRECTION ALIGNMENT: if momentum opposes our side, skip
  if (spot.direction === 'up' && side === 'no' && spot.strength && spot.strength > 0.3) {
    return { trade: false, reason: `momentum opposes side (BTC up, picking NO)` };
  }
  if (spot.direction === 'down' && side === 'yes' && spot.strength && spot.strength > 0.3) {
    return { trade: false, reason: `momentum opposes side (BTC down, picking YES)` };
  }

  const alignedDepth = pickYes ? depthImb : -depthImb;
  if (alignedDepth < -0.05 * urgencyMultiplier) {
    return {
      trade: false,
      reason: `depth opposes side (alignedDepth=${alignedDepth.toFixed(3)})`,
      signals: { depthImb: depthImb.toFixed(3), yesDepth, noDepth },
    };
  }

  const minEvCents = (opts?.minEvCents ?? 2) * urgencyMultiplier;
  const highPriceMinConfidence = opts?.highPriceMinConfidence ?? 0.9;

  if (ev < minEvCents) {
    return {
      trade: false,
      reason: `EV gate failed (${ev.toFixed(2)}c < ${minEvCents.toFixed(2)}c)`,
      ev,
      signals: {
        impliedYes: impliedYes.toFixed(3),
        modelYes: modelYes.toFixed(3),
        evYes: evYes.toFixed(2),
        evNo: evNo.toFixed(2),
        depthImb: depthImb.toFixed(3),
        momentumBoost: momentumBoost.toFixed(3),
        direction: spot.direction || 'unknown',
      },
    };
  }

  if (confidence < 0.55) {
    return { trade: false, reason: `confidence too low (${(confidence * 100).toFixed(1)}%)`, ev };
  }

  if (price >= 80 && confidence < highPriceMinConfidence) {
    return {
      trade: false,
      reason: `high-price gate failed (${side}@${price}c needs >=${(highPriceMinConfidence * 100).toFixed(0)}% model conf; got ${(confidence * 100).toFixed(1)}%)`,
      ev,
    };
  }

  if (price <= 4 && ev < 6 * urgencyMultiplier) {
    return { trade: false, reason: `penny contract rejected (${price}c, EV ${ev.toFixed(2)}c)` };
  }

  const confFactor = clamp((confidence - 0.5) * 2, 0.3, 1);
  const spend = Math.max(25, Math.floor(maxSpendCents * confFactor));
  let count = Math.max(1, Math.floor(spend / price));

  // Late window = smaller size
  if (isLate) count = Math.min(count, 1);
  if (price >= 70) count = Math.min(count, 2);

  return {
    trade: true,
    side,
    price,
    count,
    ev,
    confidence,
    reason: `${side.toUpperCase()} @ ${price}c x${count} | EV ${ev.toFixed(2)}c | model ${(confidence * 100).toFixed(1)}% | mom ${spot.direction || '?'}/${(spot.strength || 0).toFixed(1)} | ${minsToClose.toFixed(1)}m`,
    signals: {
      impliedYes: impliedYes.toFixed(3),
      modelYes: modelYes.toFixed(3),
      evYes: evYes.toFixed(2),
      evNo: evNo.toFixed(2),
      depthImb: depthImb.toFixed(3),
      momentumBoost: momentumBoost.toFixed(3),
      direction: spot.direction || 'unknown',
      urgency: isLate ? 'late' : 'normal',
    },
  };
}
