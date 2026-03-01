import type { ArbDecision, Fees, MarketSnapshot } from '../types/index.js';

/**
 * Structural arb only: buy YES + NO when total cost < 100c after friction.
 */
export function evaluateIntraMarketArb(
  m: MarketSnapshot,
  fees: Fees,
  maxNotionalUsd: number,
  minEdgeCents = 0.35,
): ArbDecision {
  const ya = m.top.yesAsk;
  const na = m.top.noAsk;
  if (ya == null || na == null) return { ok: false, reason: 'missing asks' };

  const grossCost = ya + na;
  const friction = fees.perContractCents * 2 + fees.roundTripSlippageCents;
  const netCost = grossCost + friction;
  const edgeCents = 100 - netCost;

  if (edgeCents < minEdgeCents) {
    return { ok: false, reason: `edge too small (${edgeCents.toFixed(3)}c)` };
  }

  const notionalPerPairUsd = grossCost / 100;
  const sizeContracts = Math.max(1, Math.floor(maxNotionalUsd / notionalPerPairUsd));
  const expectedProfitUsd = (edgeCents / 100) * sizeContracts;

  return { ok: true, edgeCents, expectedProfitUsd, sizeContracts };
}
