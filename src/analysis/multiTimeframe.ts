import { readFileSync, existsSync } from 'node:fs';

const multiTfPath = process.env.MULTI_TF_PATH || './tmp/multi-timeframe.json';

interface TimeframeData {
  tf1m: { direction: 'up' | 'down' | 'flat'; strength: number };
  tf5m: { direction: 'up' | 'down' | 'flat'; strength: number };
  tf15m: { direction: 'up' | 'down' | 'flat'; strength: number };
  tf1h: { direction: 'up' | 'down' | 'flat'; strength: number };
  updatedAt: number;
}

export function loadMultiTimeframe(): TimeframeData | null {
  if (!existsSync(multiTfPath)) return null;
  try {
    return JSON.parse(readFileSync(multiTfPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check if all timeframes align for a given direction
 * Returns confidence score 0-1
 */
export function checkTimeframeAlignment(
  proposedSide: 'yes' | 'no',
  data: TimeframeData,
): { aligned: boolean; confidence: number; reason: string } {
  const wantUp = proposedSide === 'yes';

  const scores = [
    { tf: '1m', dir: data.tf1m.direction, strength: data.tf1m.strength, weight: 0.3 },
    { tf: '5m', dir: data.tf5m.direction, strength: data.tf5m.strength, weight: 0.3 },
    { tf: '15m', dir: data.tf15m.direction, strength: data.tf15m.strength, weight: 0.25 },
    { tf: '1h', dir: data.tf1h.direction, strength: data.tf1h.strength, weight: 0.15 },
  ];

  let weightedScore = 0;
  let totalWeight = 0;
  const alignments: string[] = [];

  for (const s of scores) {
    const isAligned = wantUp ? s.dir === 'up' : s.dir === 'down';
    const isOpposite = wantUp ? s.dir === 'down' : s.dir === 'up';

    if (isAligned) {
      weightedScore += s.weight * s.strength;
      alignments.push(`${s.tf}:aligned`);
    } else if (isOpposite) {
      weightedScore -= s.weight * s.strength * 2; // Penalize disagreement heavily
      alignments.push(`${s.tf}:opposite`);
    } else {
      alignments.push(`${s.tf}:neutral`);
    }
    totalWeight += s.weight;
  }

  const normalizedScore = (weightedScore / totalWeight + 1) / 2; // Normalize to 0-1
  const confidence = Math.max(0, Math.min(1, normalizedScore));

  return {
    aligned: confidence > 0.6,
    confidence,
    reason: alignments.join(', '),
  };
}

export function logMultiTimeframe(data: TimeframeData) {
  const { writeFileSync, mkdirSync } = require('node:fs');
  const { dirname } = require('node:path');
  mkdirSync(dirname(multiTfPath), { recursive: true });
  writeFileSync(multiTfPath, JSON.stringify(data, null, 2));
}
