import axios from 'axios';

// Polymarket CLOB API (no auth needed for read-only)
const POLYMARKET_CLOB = 'https://clob.polymarket.com';

export interface Polymarket15m {
  marketId: string;
  conditionId: string;
  question: string;
  yesPrice: number; // 0-1
  noPrice: number;
  spread: number;
  lastUpdate: number;
}

/**
 * Find active 15m BTC markets on Polymarket
 * Returns best bid/ask for comparison with Kalshi
 */
export async function getPolymarketBTC15m(): Promise<Polymarket15m | null> {
  try {
    // Search for BTC 15m markets
    const resp = await axios.get(`${POLYMARKET_CLOB}/markets`, {
      params: { active: true, limit: 50 },
      timeout: 5000,
    });

    const markets = resp.data?.data ?? [];

    // Find BTC 15m markets
    const btc15m = markets.find((m: any) => {
      const q = (m.question || '').toLowerCase();
      return q.includes('bitcoin') && (q.includes('15 min') || q.includes('15min') || q.includes('15-minute'));
    });

    if (!btc15m) return null;

    // Get orderbook for best prices
    const bookResp = await axios.get(`${POLYMARKET_CLOB}/books/${btc15m.condition_id}`, { timeout: 5000 });
    const book = bookResp.data;

    const yesBids = (book.bids || []).filter((b: any) => b.side === 'BUY');
    const yesAsks = (book.asks || []).filter((a: any) => a.side === 'SELL');

    const bestYesBid = yesBids.length > 0 ? parseFloat(yesBids[0].price) : 0;
    const bestYesAsk = yesAsks.length > 0 ? parseFloat(yesAsks[0].price) : 1;

    return {
      marketId: btc15m.market_slug || btc15m.condition_id,
      conditionId: btc15m.condition_id,
      question: btc15m.question,
      yesPrice: bestYesBid, // use bid as proxy for "market price"
      noPrice: 1 - bestYesAsk,
      spread: bestYesAsk - bestYesBid,
      lastUpdate: Date.now(),
    };
  } catch (e) {
    console.log('[polymarket] fetch error', e);
    return null;
  }
}

/**
 * Compare Kalshi vs Polymarket for arbitrage signal
 * Returns edge in cents if significant mispricing exists
 */
export async function findCrossMarketEdge(
  kalshiYesPrice: number,
  side: 'yes' | 'no',
): Promise<{ edgeCents: number; signal: 'kalshi_cheap' | 'poly_cheap' | 'none'; reason: string }> {
  const poly = await getPolymarketBTC15m();
  if (!poly) {
    return { edgeCents: 0, signal: 'none', reason: 'no polymarket data' };
  }

  const polyYesCents = poly.yesPrice * 100;
  const polyNoCents = poly.noPrice * 100;

  if (side === 'yes') {
    const diff = polyYesCents - kalshiYesPrice;
    if (diff > 3) {
      // Polymarket prices YES higher → Kalshi YES is cheap
      return { edgeCents: diff, signal: 'kalshi_cheap', reason: `Poly YES ${polyYesCents.toFixed(1)}c > Kalshi ${kalshiYesPrice}c` };
    } else if (diff < -3) {
      return { edgeCents: Math.abs(diff), signal: 'poly_cheap', reason: `Kalshi YES ${kalshiYesPrice}c > Poly ${polyYesCents.toFixed(1)}c` };
    }
  } else {
    const kalshiNoPrice = 100 - kalshiYesPrice;
    const diff = polyNoCents - kalshiNoPrice;
    if (diff > 3) {
      return { edgeCents: diff, signal: 'kalshi_cheap', reason: `Poly NO ${polyNoCents.toFixed(1)}c > Kalshi ${kalshiNoPrice}c` };
    } else if (diff < -3) {
      return { edgeCents: Math.abs(diff), signal: 'poly_cheap', reason: `Kalshi NO ${kalshiNoPrice}c > Poly ${polyNoCents.toFixed(1)}c` };
    }
  }

  return { edgeCents: 0, signal: 'none', reason: 'prices aligned' };
}
