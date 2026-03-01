import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const correlationPath = process.env.CORRELATION_PATH || './tmp/position-correlation.json';

interface PositionCorrelation {
  ticker: string;
  side: 'yes' | 'no';
  size: number;
  entryTime: number;
}

function loadPositions(): PositionCorrelation[] {
  if (!existsSync(correlationPath)) return [];
  try {
    return JSON.parse(readFileSync(correlationPath, 'utf8'));
  } catch {
    return [];
  }
}

function savePositions(positions: PositionCorrelation[]) {
  writeFileSync(correlationPath, JSON.stringify(positions, null, 2));
}

export function recordPosition(ticker: string, side: 'yes' | 'no', size: number) {
  const positions = loadPositions();
  positions.push({ ticker, side, size, entryTime: Date.now() });

  // Clean old (> 30 min)
  const now = Date.now();
  const filtered = positions.filter((p) => now - p.entryTime < 1800000);
  savePositions(filtered);
}

export function checkCorrelation(
  proposedSide: 'yes' | 'no',
  proposedTicker: string,
): { canEnter: boolean; reason?: string; netExposure: number } {
  const positions = loadPositions();

  // Calculate net exposure
  const netExposure = positions.reduce((sum, p) => {
    return sum + (p.side === 'yes' ? p.size : -p.size);
  }, 0);

  // If already heavily long, don't add more YES
  if (netExposure >= 2 && proposedSide === 'yes') {
    return { canEnter: false, reason: 'already long biased', netExposure };
  }

  // If already heavily short, don't add more NO
  if (netExposure <= -2 && proposedSide === 'no') {
    return { canEnter: false, reason: 'already short biased', netExposure };
  }

  // Check for same-ticker duplicate
  const sameTicker = positions.find((p) => p.ticker === proposedTicker);
  if (sameTicker) {
    return { canEnter: false, reason: 'already have position in this window', netExposure };
  }

  return { canEnter: true, netExposure };
}

export function getSuggestedHedge(): 'yes' | 'no' | null {
  const positions = loadPositions();
  const netExposure = positions.reduce((sum, p) => {
    return sum + (p.side === 'yes' ? p.size : -p.size);
  }, 0);

  if (netExposure >= 2) return 'no'; // hedge with NO
  if (netExposure <= -2) return 'yes'; // hedge with YES
  return null;
}
