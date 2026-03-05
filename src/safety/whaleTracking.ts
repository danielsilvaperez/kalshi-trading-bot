import { appendFileSync, readFileSync, existsSync } from 'node:fs';

const whaleLogPath = process.env.WHALE_LOG_PATH || './logs/whale-activity.jsonl';

interface WhaleTrade {
  ticker: string;
  side: 'yes' | 'no';
  size: number;
  price: number;
  ts: number;
  wallet?: string;
}

const WHALE_THRESHOLD = 5000; // 5k+ contracts = whale

export function detectWhaleActivity(
  orderbookBefore: { yes: number[][]; no: number[][] },
  orderbookAfter: { yes: number[][]; no: number[][] },
  ticker: string,
): WhaleTrade | null {
  // Detect large position changes
  const yesBefore = orderbookBefore.yes.slice(0, 3).reduce((s, [_, q]) => s + q, 0);
  const yesAfter = orderbookAfter.yes.slice(0, 3).reduce((s, [_, q]) => s + q, 0);
  const yesChange = yesAfter - yesBefore;

  if (yesChange < -WHALE_THRESHOLD) {
    // Large YES buyer came in
    const trade: WhaleTrade = {
      ticker,
      side: 'yes',
      size: Math.abs(yesChange),
      price: orderbookAfter.yes[0]?.[0] ?? 0,
      ts: Date.now(),
    };
    logWhale(trade);
    return trade;
  }

  const noBefore = orderbookBefore.no.slice(0, 3).reduce((s, [_, q]) => s + q, 0);
  const noAfter = orderbookAfter.no.slice(0, 3).reduce((s, [_, q]) => s + q, 0);
  const noChange = noAfter - noBefore;

  if (noChange < -WHALE_THRESHOLD) {
    const trade: WhaleTrade = {
      ticker,
      side: 'no',
      size: Math.abs(noChange),
      price: orderbookAfter.no[0]?.[0] ?? 0,
      ts: Date.now(),
    };
    logWhale(trade);
    return trade;
  }

  return null;
}

function logWhale(trade: WhaleTrade) {
  appendFileSync(whaleLogPath, JSON.stringify({ ...trade, ts: new Date().toISOString() }) + '\n');
}

export function getRecentWhaleDirection(ticker: string, windowMs = 300000): 'yes' | 'no' | null {
  if (!existsSync(whaleLogPath)) return null;

  const lines = readFileSync(whaleLogPath, 'utf8').split('\n').filter(Boolean);
  const now = Date.now();

  const recent = lines
    .map((l) => JSON.parse(l))
    .filter((t) => t.ticker === ticker && now - new Date(t.ts).getTime() < windowMs);

  if (recent.length === 0) return null;

  const yesVolume = recent.filter((t) => t.side === 'yes').reduce((s, t) => s + t.size, 0);
  const noVolume = recent.filter((t) => t.side === 'no').reduce((s, t) => s + t.size, 0);

  if (yesVolume > noVolume * 2) return 'yes';
  if (noVolume > yesVolume * 2) return 'no';
  return null;
}

export function shouldFollowWhale(whaleDirection: 'yes' | 'no', proposedSide: 'yes' | 'no'): boolean {
  // Follow whale unless we're contrarian with specific edge
  return whaleDirection === proposedSide;
}
