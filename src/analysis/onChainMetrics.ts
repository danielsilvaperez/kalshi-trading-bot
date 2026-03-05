import axios from 'axios';

const GLASSNODE_API = 'https://api.glassnode.com/v1';
const API_KEY = process.env.GLASSNODE_API_KEY || '';

interface OnChainMetrics {
  exchangeInflow: number; // BTC flowing into exchanges (selling pressure)
  exchangeOutflow: number; // BTC leaving exchanges (hodling)
  netFlow: number; // negative = bullish, positive = bearish
  sopr: number; // >1 = profit taking, <1 = capitulation
  fundingRate: number; // positive = longs pay shorts
  timestamp: number;
}

/**
 * Fetch exchange flow data
 * Large inflows = potential selling pressure
 */
export async function fetchExchangeFlows(): Promise<Pick<OnChainMetrics, 'exchangeInflow' | 'exchangeOutflow' | 'netFlow'> | null> {
  if (!API_KEY) return null;

  try {
    // Note: Free tier has limited endpoints
    // This is a simplified implementation
    const r = await axios.get(`${GLASSNODE_API}/metrics/flows/exchange_inflow`, {
      params: { a: 'BTC', api_key: API_KEY, limit: 1 },
      timeout: 5000,
    });

    const inflow = r.data?.[0]?.v || 0;

    const outR = await axios.get(`${GLASSNODE_API}/metrics/flows/exchange_outflow`, {
      params: { a: 'BTC', api_key: API_KEY, limit: 1 },
      timeout: 5000,
    });

    const outflow = outR.data?.[0]?.v || 0;

    return {
      exchangeInflow: inflow,
      exchangeOutflow: outflow,
      netFlow: inflow - outflow,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch funding rates
 * High positive = overleveraged longs = potential dump
 */
export async function fetchFundingRate(): Promise<{ rate: number; annualized: number } | null> {
  if (!API_KEY) return null;

  try {
    const r = await axios.get(`${GLASSNODE_API}/metrics/derivatives/funding_rate_perpetual`, {
      params: { a: 'BTC', api_key: API_KEY, limit: 1 },
      timeout: 5000,
    });

    const rate = r.data?.[0]?.v || 0;
    return {
      rate,
      annualized: rate * 365 * 100, // Convert to annual %
    };
  } catch {
    return null;
  }
}

/**
 * SOPR - Spent Output Profit Ratio
 * > 1 = people selling at profit (resistance)
 * < 1 = people selling at loss (capitulation, bottom)
 */
export async function fetchSOPR(): Promise<{ sopr: number; interpretation: 'profit_taking' | 'capitulation' | 'neutral' } | null> {
  if (!API_KEY) return null;

  try {
    const r = await axios.get(`${GLASSNODE_API}/metrics/indicators/sopr`, {
      params: { a: 'BTC', api_key: API_KEY, limit: 1 },
      timeout: 5000,
    });

    const sopr = r.data?.[0]?.v || 1;
    
    let interpretation: 'profit_taking' | 'capitulation' | 'neutral' = 'neutral';
    if (sopr > 1.01) interpretation = 'profit_taking';
    else if (sopr < 0.99) interpretation = 'capitulation';

    return { sopr, interpretation };
  } catch {
    return null;
  }
}

/**
 * Aggregate on-chain signal
 */
export async function getOnChainSignal(): Promise<{
  signal: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  metrics: Partial<OnChainMetrics>;
}> {
  const [flows, funding, sopr] = await Promise.all([
    fetchExchangeFlows(),
    fetchFundingRate(),
    fetchSOPR(),
  ]);

  let bullishScore = 0;
  let bearishScore = 0;

  if (flows) {
    if (flows.netFlow < 0) bullishScore += 1; // Outflow = hodling
    else bearishScore += 1;
  }

  if (funding) {
    if (funding.annualized > 50) bearishScore += 1.5; // Overleveraged longs
    else if (funding.annualized < -20) bullishScore += 1;
  }

  if (sopr) {
    if (sopr.interpretation === 'capitulation') bullishScore += 1.5; // Bottom signal
    else if (sopr.interpretation === 'profit_taking') bearishScore += 1;
  }

  const signal = bullishScore > bearishScore ? 'bullish' : bearishScore > bullishScore ? 'bearish' : 'neutral';
  const confidence = Math.abs(bullishScore - bearishScore) / Math.max(1, bullishScore + bearishScore);

  return {
    signal,
    confidence,
    metrics: {
      exchangeInflow: flows?.exchangeInflow,
      exchangeOutflow: flows?.exchangeOutflow,
      netFlow: flows?.netFlow,
      fundingRate: funding?.rate,
    },
  };
}
