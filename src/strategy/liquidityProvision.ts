import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const MM_LOG = process.env.MM_LOG_PATH || './logs/market-maker.jsonl';

interface MarketMakingSession {
  ticker: string;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  spreadCapture: number;
  inventory: number;
  pnl: number;
}

/**
 * Provide liquidity when spreads are wide
 * Capture spread by quoting both sides
 */
export function shouldProvideLiquidity(
  yesBid: number,
  yesAsk: number,
  noBid: number,
  noAsk: number,
): { shouldMM: boolean; quoteYes: number; quoteNo: number; expectedSpread: number; reason: string } {
  const yesSpread = yesAsk - yesBid;
  const noSpread = noAsk - noBid;
  const totalSpread = yesSpread + noSpread;

  // Need at least 8c total spread to profit after fees
  if (totalSpread < 8) {
    return { shouldMM: false, quoteYes: 0, quoteNo: 0, expectedSpread: 0, reason: 'spread too tight' };
  }

  // Quote inside the spread
  const quoteYes = yesBid + 1; // Penny better than best bid
  const quoteNo = noBid + 1;

  return {
    shouldMM: true,
    quoteYes,
    quoteNo,
    expectedSpread: totalSpread - 4, // minus fees
    reason: `Wide spread: YES ${yesSpread}c + NO ${noSpread}c = ${totalSpread}c`,
  };
}

/**
 * Manage inventory risk for market making
 * Don't let position get too large in one direction
 */
export function manageMMInventory(
  currentInventory: number,
  filledSide: 'yes' | 'no',
): { action: 'hold' | 'hedge' | 'close'; targetPrice?: number; reason: string } {
  if (Math.abs(currentInventory) >= 5) {
    return {
      action: 'hedge',
      targetPrice: filledSide === 'yes' ? 50 : 50,
      reason: `Inventory limit: ${currentInventory} contracts`,
    };
  }

  if (Math.abs(currentInventory) >= 3) {
    return {
      action: 'close',
      reason: `Reducing inventory: ${currentInventory}`,
    };
  }

  return { action: 'hold', reason: 'Inventory within limits' };
}

/**
 * Calculate MM session PnL
 */
export function calculateMMPnL(trades: { side: 'yes' | 'no'; price: number; size: number }[]): number {
  let pnl = 0;
  let inventory = 0;
  let vwap = 0;

  for (const trade of trades) {
    if (trade.side === 'yes') {
      if (inventory >= 0) {
        // Adding to long
        vwap = (vwap * inventory + trade.price * trade.size) / (inventory + trade.size);
        inventory += trade.size;
      } else {
        // Reducing short
        pnl += (vwap - trade.price) * Math.min(trade.size, Math.abs(inventory));
        inventory += trade.size;
      }
    } else {
      if (inventory <= 0) {
        // Adding to short
        vwap = (vwap * Math.abs(inventory) + trade.price * trade.size) / (Math.abs(inventory) + trade.size);
        inventory -= trade.size;
      } else {
        // Reducing long
        pnl += (trade.price - vwap) * Math.min(trade.size, inventory);
        inventory -= trade.size;
      }
    }
  }

  return pnl;
}

export function logMMSession(session: MarketMakingSession) {
  appendFileSync(MM_LOG, JSON.stringify({ ts: new Date().toISOString(), ...session }) + '\n');
}
