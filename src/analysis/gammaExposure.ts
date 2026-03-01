import axios from 'axios';

const GEX_THRESHOLD = 0.05; // 5% price move threshold

interface GammaExposure {
  strike: number;
  callGamma: number;
  putGamma: number;
  netGamma: number;
  price: number;
}

/**
 * Estimate gamma exposure from options-like binary markets
 * High gamma near strike = explosive moves possible
 */
export function estimateGammaExposure(
  currentPrice: number,
  strike: number,
  timeToExpiry: number,
): { gamma: number; isPinRisk: boolean; isSqueezeRisk: boolean } {
  const distance = Math.abs(currentPrice - strike) / strike;
  
  // Simplified gamma model: highest when price near strike, low time remaining
  const timeDecay = Math.max(0.1, timeToExpiry / 900); // normalize to 15 min
  const moneyness = 1 - Math.min(1, distance * 10); // 0-1, 1 = at strike
  
  const gamma = moneyness / timeDecay;
  
  const isPinRisk = distance < 0.002 && timeToExpiry < 300; // Within 0.2% and 5 min
  const isSqueezeRisk = gamma > 2 && timeToExpiry < 600; // High gamma, 10 min left

  return { gamma, isPinRisk, isSqueezeRisk };
}

/**
 * Check if we're in a gamma danger zone
 */
export function checkGammaDanger(
  btcPrice: number,
  marketStrike: number,
  minutesToClose: number,
): { safe: boolean; reason?: string; gamma: number } {
  const gex = estimateGammaExposure(btcPrice, marketStrike, minutesToClose * 60);

  if (gex.isPinRisk) {
    return { safe: false, reason: 'PIN RISK: price near strike with little time', gamma: gex.gamma };
  }

  if (gex.isSqueezeRisk) {
    return { safe: false, reason: 'GAMMA SQUEEZE RISK: high gamma zone', gamma: gex.gamma };
  }

  return { safe: true, gamma: gex.gamma };
}

/**
 * Find strike price from Kalshi market ticker
 * E.g., KXBTC15M-26FEB131200-00 -> strike around current BTC price
 */
export function extractStrikeFromContext(
  ticker: string,
  currentBtcPrice: number,
): number {
  // For 15m up/down markets, strike is effectively current price at market open
  // Return nearest round number
  return Math.round(currentBtcPrice / 100) * 100;
}
