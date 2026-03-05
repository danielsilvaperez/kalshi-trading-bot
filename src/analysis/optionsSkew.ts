import axios from 'axios';

const DERIBIT_API = 'https://www.deribit.com/api/v2';

interface OptionsSkew {
  atmIv: number; // At-the-money implied volatility
  riskReversal: number; // Call IV - Put IV (positive = calls expensive)
  butterfly: number; // Fly price (convexity)
  termStructure: Record<string, number>; // IV by expiry
}

/**
 * Fetch BTC options data from Deribit
 * Free API, no auth needed for public data
 */
export async function fetchOptionsSkew(): Promise<OptionsSkew | null> {
  try {
    // Get BTC option instruments
    const r = await axios.get(`${DERIBIT_API}/public/get_instruments`, {
      params: { currency: 'BTC', kind: 'option', expired: false },
      timeout: 5000,
    });

    const instruments = r.data?.result || [];

    // Find near ATM options (within 5% of current price)
    // Group by expiry
    const byExpiry: Record<string, any[]> = {};

    for (const inst of instruments) {
      if (!byExpiry[inst.expiration_timestamp]) {
        byExpiry[inst.expiration_timestamp] = [];
      }
      byExpiry[inst.expiration_timestamp].push(inst);
    }

    // Get order books for ATM options
    const nearestExpiry = Object.keys(byExpiry).sort()[0];
    const nearestOptions = byExpiry[nearestExpiry];

    // Get mark prices
    const tickers = await axios.get(`${DERIBIT_API}/public/ticker`, {
      params: { instrument_name: nearestOptions.map((o) => o.instrument_name).join(',') },
      timeout: 5000,
    });

    // Calculate ATM IV
    const ivs = tickers.data?.result?.map((t: any) => t.mark_iv) || [];
    const atmIv = ivs.reduce((a: number, b: number) => a + b, 0) / ivs.length;

    // Calculate risk reversal (closest call - closest put)
    const calls = nearestOptions.filter((o) => o.option_type === 'call');
    const puts = nearestOptions.filter((o) => o.option_type === 'put');

    // Sort by strike distance from current
    const btcPrice = await fetchBTCPrice();

    const nearestCall = calls.sort((a, b) =>
      Math.abs(a.strike - btcPrice) - Math.abs(b.strike - btcPrice)
    )[0];
    const nearestPut = puts.sort((a, b) =>
      Math.abs(a.strike - btcPrice) - Math.abs(b.strike - btcPrice)
    )[0];

    const callIv = tickers.data?.result?.find((t: any) =>
      t.instrument_name === nearestCall?.instrument_name
    )?.mark_iv || atmIv;

    const putIv = tickers.data?.result?.find((t: any) =>
      t.instrument_name === nearestPut?.instrument_name
    )?.mark_iv || atmIv;

    return {
      atmIv,
      riskReversal: callIv - putIv,
      butterfly: 0, // Would need more strikes
      termStructure: {}, // Simplified
    };
  } catch (e) {
    console.log('[options-skew] fetch error', e);
    return null;
  }
}

async function fetchBTCPrice(): Promise<number> {
  try {
    const r = await axios.get(`${DERIBIT_API}/public/ticker`, {
      params: { instrument_name: 'BTC-PERPETUAL' },
      timeout: 5000,
    });
    return r.data?.result?.last_price || 50000;
  } catch {
    return 50000;
  }
}

/**
 * Interpret skew for directional edge
 * Positive risk reversal = market pricing in upside (calls expensive)
 * Negative = market pricing in downside
 */
export function interpretSkew(skew: OptionsSkew): {
  signal: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  reasoning: string;
} {
  const rr = skew.riskReversal;

  if (rr > 5) {
    return {
      signal: 'bullish',
      strength: Math.min(1, rr / 20),
      reasoning: `Calls ${rr.toFixed(1)}% more expensive than puts (upside demand)`,
    };
  }

  if (rr < -5) {
    return {
      signal: 'bearish',
      strength: Math.min(1, Math.abs(rr) / 20),
      reasoning: `Puts ${Math.abs(rr).toFixed(1)}% more expensive than calls (downside protection)`,
    };
  }

  return {
    signal: 'neutral',
    strength: 0,
    reasoning: 'Risk reversal near zero (balanced sentiment)',
  };
}
