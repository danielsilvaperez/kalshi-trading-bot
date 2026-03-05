import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const slippagePath = process.env.SLIPPAGE_LOG_PATH || './logs/slippage.jsonl';

interface SlippageRecord {
  ticker: string;
  side: 'yes' | 'no';
  expectedPrice: number;
  actualPrice: number;
  slippageCents: number;
  ts: string;
}

export function logSlippage(
  ticker: string,
  side: 'yes' | 'no',
  expectedPrice: number,
  fillPrice: number | null,
) {
  if (!fillPrice) return;

  const slippage = fillPrice - expectedPrice; // positive = worse

  const record: SlippageRecord = {
    ticker,
    side,
    expectedPrice,
    actualPrice: fillPrice,
    slippageCents: slippage,
    ts: new Date().toISOString(),
  };

  appendFileSync(slippagePath, JSON.stringify(record) + '\n');
}

export function getAverageSlippage(windowTrades = 10): number {
  if (!existsSync(slippagePath)) return 0;

  const lines = readFileSync(slippagePath, 'utf8').split('\n').filter(Boolean);
  const recent = lines.slice(-windowTrades);

  if (recent.length === 0) return 0;

  const total = recent.reduce((sum, line) => {
    try {
      const r = JSON.parse(line) as SlippageRecord;
      return sum + r.slippageCents;
    } catch {
      return sum;
    }
  }, 0);

  return total / recent.length;
}

export function adjustEntryForSlippage(targetPrice: number, side: 'yes' | 'no'): number {
  const avgSlip = getAverageSlippage(10);

  if (avgSlip <= 0) return targetPrice; // no adjustment needed

  // Adjust entry: bid lower if buying YES, bid lower if buying NO (price is inverted)
  // Actually for Kalshi, we want to pay less, so reduce our bid
  const adjustment = Math.min(3, Math.ceil(avgSlip)); // cap at 3c

  if (side === 'yes') {
    return Math.max(1, targetPrice - adjustment);
  } else {
    return Math.max(1, targetPrice - adjustment);
  }
}

export function shouldPauseForSlippage(): boolean {
  const avg = getAverageSlippage(5);
  return avg > 5; // pause if avg slippage > 5c
}
