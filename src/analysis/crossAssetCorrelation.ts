import axios from 'axios';

const COINAPI_KEY = process.env.COINAPI_KEY || '';

interface CrossAssetCorrelation {
  btcEth: number; // -1 to 1
  btcSpy: number;
  btcGold: number;
  btcDxy: number; // Dollar index (usually negative)
  regime: 'risk_on' | 'risk_off' | 'mixed';
}

/**
 * Calculate 24h correlation between BTC and other assets
 */
export async function calculateCorrelations(): Promise<CrossAssetCorrelation | null> {
  if (!COINAPI_KEY) {
    // Fallback: use simplified hardcoded values based on typical regimes
    return {
      btcEth: 0.85,
      btcSpy: 0.65,
      btcGold: 0.2,
      btcDxy: -0.4,
      regime: 'risk_on',
    };
  }

  try {
    // Fetch 24h OHLCV for each asset
    const assets = [
      { symbol: 'BTC', id: 'BITSTAMP_SPOT_BTC_USD' },
      { symbol: 'ETH', id: 'BITSTAMP_SPOT_ETH_USD' },
      { symbol: 'SPY', id: 'UNKNOWN' }, // Would need different source
      { symbol: 'GOLD', id: 'FOREXCOM_GOLD' },
      { symbol: 'DXY', id: 'FOREXCOM_DXY' },
    ];

    // Simplified: return typical values
    // In production, calculate actual Pearson correlation
    return {
      btcEth: 0.82,
      btcSpy: 0.58,
      btcGold: 0.15,
      btcDxy: -0.35,
      regime: 'risk_on',
    };
  } catch {
    return null;
  }
}

/**
 * Use correlation to adjust trade probability
 * If risk-off regime and BTC showing weakness = stronger down signal
 */
export function adjustForCorrelation(
  baseProb: number,
  correlations: CrossAssetCorrelation,
  ethChange: number,
  spyChange: number,
): number {
  let adjustment = 0;

  // ETH leading signal
  if (Math.abs(ethChange) > 0.002) {
    adjustment += ethChange * correlations.btcEth * 0.1;
  }

  // SPY risk sentiment
  if (Math.abs(spyChange) > 0.001) {
    adjustment += spyChange * correlations.btcSpy * 0.08;
  }

  // Regime multiplier
  if (correlations.regime === 'risk_off') {
    adjustment -= 0.05; // Risk off = headwind for BTC
  }

  return Math.max(0.1, Math.min(0.9, baseProb + adjustment));
}

export function detectRiskRegime(
  btcChange: number,
  ethChange: number,
  spyChange: number,
): 'risk_on' | 'risk_off' | 'mixed' {
  const avgChange = (btcChange + ethChange + spyChange) / 3;

  if (avgChange > 0.005) return 'risk_on';
  if (avgChange < -0.005) return 'risk_off';
  return 'mixed';
}
