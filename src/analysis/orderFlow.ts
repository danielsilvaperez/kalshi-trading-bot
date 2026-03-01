import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const flowLogPath = process.env.FLOW_LOG_PATH || './logs/order-flow.jsonl';

interface FlowSnapshot {
  aggressiveBuys: number;
  aggressiveSells: number;
  netFlow: number; // positive = buying pressure
  timestamp: number;
}

/**
 * Track aggressive market orders vs passive limit orders
 * Aggressive = buyer hitting asks or seller hitting bids
 */
export function detectOrderFlowImbalance(
  bookBefore: { yes: number[][]; no: number[][] },
  bookAfter: { yes: number[][]; no: number[][] },
  trades: { side: 'yes' | 'no'; size: number; price: number }[],
): FlowSnapshot {
  let aggressiveBuys = 0;
  let aggressiveSells = 0;

  for (const trade of trades) {
    // Determine if aggressive by checking if it hit the bid or ask
    if (trade.side === 'yes') {
      // Buying YES = hitting NO bids (inverse)
      aggressiveBuys += trade.size;
    } else {
      aggressiveSells += trade.size;
    }
  }

  // Also check book depletion
  const yesBidDepletion = Math.max(0, 
    bookBefore.yes.slice(0, 3).reduce((s, [_, q]) => s + q, 0) - 
    bookAfter.yes.slice(0, 3).reduce((s, [_, q]) => s + q, 0)
  );
  const noBidDepletion = Math.max(0,
    bookBefore.no.slice(0, 3).reduce((s, [_, q]) => s + q, 0) -
    bookAfter.no.slice(0, 3).reduce((s, [_, q]) => s + q, 0)
  );

  // Bid depletion = sellers hitting bids (aggressive selling)
  aggressiveSells += yesBidDepletion;
  aggressiveBuys += noBidDepletion;

  const snapshot: FlowSnapshot = {
    aggressiveBuys,
    aggressiveSells,
    netFlow: aggressiveBuys - aggressiveSells,
    timestamp: Date.now(),
  };

  appendFileSync(flowLogPath, JSON.stringify(snapshot) + '\n');
  return snapshot;
}

export function getRecentFlowImbalance(windowMs = 60000): { imbalance: number; strength: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell' } {
  if (!existsSync(flowLogPath)) return { imbalance: 0, strength: 'neutral' };

  const lines = readFileSync(flowLogPath, 'utf8').split('\n').filter(Boolean);
  const now = Date.now();

  const recent = lines
    .map((l) => JSON.parse(l))
    .filter((s) => now - s.timestamp < windowMs);

  if (recent.length === 0) return { imbalance: 0, strength: 'neutral' };

  const totalBuy = recent.reduce((s, r) => s + r.aggressiveBuys, 0);
  const totalSell = recent.reduce((s, r) => s + r.aggressiveSells, 0);
  const total = totalBuy + totalSell;

  if (total === 0) return { imbalance: 0, strength: 'neutral' };

  const imbalance = (totalBuy - totalSell) / total;

  let strength: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell' = 'neutral';
  if (imbalance > 0.6) strength = 'strong_buy';
  else if (imbalance > 0.3) strength = 'buy';
  else if (imbalance < -0.6) strength = 'strong_sell';
  else if (imbalance < -0.3) strength = 'sell';

  return { imbalance, strength };
}

export function flowAlignsWithTrade(flowStrength: string, side: 'yes' | 'no'): boolean {
  if (flowStrength === 'neutral') return true;
  const wantUp = side === 'yes';
  return (wantUp && (flowStrength === 'buy' || flowStrength === 'strong_buy')) ||
         (!wantUp && (flowStrength === 'sell' || flowStrength === 'strong_sell'));
}
