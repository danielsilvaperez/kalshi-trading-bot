import { readFileSync, existsSync } from 'node:fs';

const featuresPath = process.env.FEATURES_PATH || './logs/features.jsonl';

interface FeatureVector {
  momentum1m: number;
  momentum5m: number;
  depthImb: number;
  spread: number;
  timeToClose: number;
  volatility: number;
  volume: number;
  crossMarketEdge: number;
  won: boolean;
}

function loadTrainingData(): FeatureVector[] {
  if (!existsSync(featuresPath)) return [];
  const lines = readFileSync(featuresPath, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-200).map((l) => JSON.parse(l));
}

/**
 * Simple logistic regression-style predictor
 * Trains on historical outcomes to predict win probability
 */
export function predictWinProbability(
  momentum1m: number,
  momentum5m: number,
  depthImb: number,
  spread: number,
  timeToClose: number,
  volatility: number,
  volume: number,
  crossMarketEdge: number,
): { probability: number; confidence: number; features: string[] } {
  const data = loadTrainingData();

  if (data.length < 20) {
    // Not enough data - use heuristic weights
    const score =
      Math.sign(momentum1m) * Math.min(Math.abs(momentum1m) * 1000, 0.2) +
      depthImb * 0.15 +
      (crossMarketEdge > 2 ? 0.1 : 0) +
      (spread < 10 ? 0.05 : -0.05) +
      (volatility < 0.0005 ? 0.05 : -0.1);

    const prob = 0.5 + Math.max(-0.2, Math.min(0.2, score));
    return { probability: prob, confidence: 0.3, features: ['heuristic'] };
  }

  // Calculate feature averages for wins vs losses
  const wins = data.filter((d) => d.won);
  const losses = data.filter((d) => !d.won);

  if (wins.length < 5 || losses.length < 5) {
    return { probability: 0.5, confidence: 0.2, features: ['insufficient_balance'] };
  }

  const winAvg = {
    momentum1m: wins.reduce((s, d) => s + d.momentum1m, 0) / wins.length,
    depthImb: wins.reduce((s, d) => s + d.depthImb, 0) / wins.length,
    spread: wins.reduce((s, d) => s + d.spread, 0) / wins.length,
    volatility: wins.reduce((s, d) => s + d.volatility, 0) / wins.length,
  };

  const lossAvg = {
    momentum1m: losses.reduce((s, d) => s + d.momentum1m, 0) / losses.length,
    depthImb: losses.reduce((s, d) => s + d.depthImb, 0) / losses.length,
    spread: losses.reduce((s, d) => s + d.spread, 0) / losses.length,
    volatility: losses.reduce((s, d) => s + d.volatility, 0) / losses.length,
  };

  // Calculate distances to win/loss centroids
  const winDist = Math.sqrt(
    Math.pow(momentum1m - winAvg.momentum1m, 2) +
    Math.pow(depthImb - winAvg.depthImb, 2) +
    Math.pow(spread - winAvg.spread, 2) +
    Math.pow(volatility - winAvg.volatility, 2)
  );

  const lossDist = Math.sqrt(
    Math.pow(momentum1m - lossAvg.momentum1m, 2) +
    Math.pow(depthImb - lossAvg.depthImb, 2) +
    Math.pow(spread - lossAvg.spread, 2) +
    Math.pow(volatility - lossAvg.volatility, 2)
  );

  // Convert to probability
  const totalDist = winDist + lossDist;
  const winProb = totalDist > 0 ? lossDist / totalDist : 0.5;

  // Confidence based on data size
  const confidence = Math.min(0.9, data.length / 100);

  return {
    probability: Math.max(0.1, Math.min(0.9, winProb)),
    confidence,
    features: ['momentum', 'depth', 'spread', 'volatility'],
  };
}

export function logFeatures(
  momentum1m: number,
  momentum5m: number,
  depthImb: number,
  spread: number,
  timeToClose: number,
  volatility: number,
  volume: number,
  crossMarketEdge: number,
  won: boolean,
) {
  const { appendFileSync } = require('node:fs');
  const record: FeatureVector = {
    momentum1m, momentum5m, depthImb, spread, timeToClose, volatility, volume, crossMarketEdge, won,
  };
  appendFileSync(featuresPath, JSON.stringify(record) + '\n');
}
