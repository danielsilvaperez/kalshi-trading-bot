import axios from 'axios';

export interface SpotSnapshot {
  price: number;
  ts: number;
  source: string;
}

/**
 * Fetch BTC spot price from free public APIs (no auth needed).
 * Falls back through multiple sources.
 */
export async function fetchBtcSpot(): Promise<SpotSnapshot> {
  const sources = [
    fetchCoinGecko,
    fetchCoinbase,
  ];

  for (const fn of sources) {
    try {
      const snap = await fn();
      if (snap && snap.price > 0) return snap;
    } catch {
      continue;
    }
  }

  throw new Error('All spot price sources failed');
}

async function fetchCoinbase(): Promise<SpotSnapshot> {
  const r = await axios.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 3000 });
  return {
    price: parseFloat(r.data?.data?.amount ?? '0'),
    ts: Date.now(),
    source: 'coinbase',
  };
}

async function fetchCoinGecko(): Promise<SpotSnapshot> {
  const r = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price',
    {
      params: { ids: 'bitcoin', vs_currencies: 'usd' },
      timeout: 3000,
    },
  );
  return {
    price: r.data?.bitcoin?.usd ?? 0,
    ts: Date.now(),
    source: 'coingecko',
  };
}
