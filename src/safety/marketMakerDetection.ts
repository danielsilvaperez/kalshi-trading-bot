import { readFileSync, existsSync, appendFileSync } from 'node:fs';

const mmLogPath = process.env.MM_LOG_PATH || './logs/market-maker.jsonl';

interface BookSnapshot {
  yesBids: number[][];
  yesAsks: number[][];
  noBids: number[][];
  noAsks: number[][];
  ts: number;
}

interface MMDetection {
  informedFlow: boolean;
  spoofing: boolean;
  toxic: boolean;
  confidence: number;
  reason: string;
}

export function detectMarketMakerToxicity(
  currentBook: BookSnapshot,
  previousBook: BookSnapshot | null,
): MMDetection {
  if (!previousBook) {
    return { informedFlow: false, spoofing: false, toxic: false, confidence: 0, reason: 'no baseline' };
  }

  const timeDelta = currentBook.ts - previousBook.ts;
  if (timeDelta > 10000) {
    return { informedFlow: false, spoofing: false, toxic: false, confidence: 0, reason: 'stale baseline' };
  }

  // 1. Large order disappearance (spoofing)
  const yesBidDrop = detectLargeDrop(previousBook.yesBids, currentBook.yesBids);
  const noBidDrop = detectLargeDrop(previousBook.noBids, currentBook.noBids);

  if (yesBidDrop > 50000 || noBidDrop > 50000) {
    logMMEvent('spoofing', { yesBidDrop, noBidDrop });
    return { informedFlow: false, spoofing: true, toxic: true, confidence: 0.7, reason: 'large bid disappearance (spoofing)' };
  }

  // 2. Asymmetric flow (informed trader)
  const yesImbalance = calculateImbalance(currentBook.yesBids, currentBook.yesAsks);
  const noImbalance = calculateImbalance(currentBook.noBids, currentBook.noAsks);

  if (Math.abs(yesImbalance) > 0.7 || Math.abs(noImbalance) > 0.7) {
    logMMEvent('informed', { yesImbalance, noImbalance });
    return { informedFlow: true, spoofing: false, toxic: true, confidence: 0.6, reason: 'asymmetric book (informed flow)' };
  }

  // 3. Rapid spread compression (aggressive flow)
  const prevYesSpread = getSpread(previousBook.yesBids, previousBook.yesAsks);
  const currYesSpread = getSpread(currentBook.yesBids, currentBook.yesAsks);
  const spreadCompression = prevYesSpread > 0 ? (prevYesSpread - currYesSpread) / prevYesSpread : 0;

  if (spreadCompression > 0.5) {
    logMMEvent('compression', { spreadCompression });
    return { informedFlow: true, spoofing: false, toxic: true, confidence: 0.5, reason: 'rapid spread compression' };
  }

  return { informedFlow: false, spoofing: false, toxic: false, confidence: 0, reason: 'clean' };
}

function detectLargeDrop(prev: number[][], curr: number[][]): number {
  const prevTotal = prev.slice(0, 3).reduce((sum, [_, qty]) => sum + qty, 0);
  const currTotal = curr.slice(0, 3).reduce((sum, [_, qty]) => sum + qty, 0);
  return prevTotal - currTotal;
}

function calculateImbalance(bids: number[][], asks: number[][]): number {
  const bidTotal = bids.slice(0, 3).reduce((sum, [_, qty]) => sum + qty, 0);
  const askTotal = asks.slice(0, 3).reduce((sum, [_, qty]) => sum + qty, 0);
  if (bidTotal + askTotal === 0) return 0;
  return (bidTotal - askTotal) / (bidTotal + askTotal);
}

function getSpread(bids: number[][], asks: number[][]): number {
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 100;
  return bestAsk - bestBid;
}

function logMMEvent(type: string, data: unknown) {
  appendFileSync(mmLogPath, JSON.stringify({ ts: new Date().toISOString(), type, data }) + '\n');
}

export function shouldAvoidTrade(): boolean {
  if (!existsSync(mmLogPath)) return false;
  const lines = readFileSync(mmLogPath, 'utf8').split('\n').filter(Boolean).slice(-10);

  let toxicCount = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.type === 'spoofing' || r.type === 'informed') toxicCount++;
    } catch {}
  }

  return toxicCount >= 3; // avoid if 3 of last 10 signals were toxic
}
