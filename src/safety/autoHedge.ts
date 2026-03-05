import axios from 'axios';
import { createSign, constants } from 'node:crypto';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';

function sign(method: string, path: string) {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const s = require('node:crypto').createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64'),
  };
}

interface HedgeRecommendation {
  shouldHedge: boolean;
  hedgeSide: 'yes' | 'no' | null;
  hedgeSize: number;
  currentExposure: number;
  reason: string;
}

/**
 * Calculate hedge needed to maintain delta-neutral or limited exposure
 */
export function calculateHedge(
  netDelta: number,
  maxExposure: number = 5,
): HedgeRecommendation {
  if (Math.abs(netDelta) <= maxExposure) {
    return { shouldHedge: false, hedgeSide: null, hedgeSize: 0, currentExposure: netDelta, reason: 'within limits' };
  }

  const hedgeSide = netDelta > 0 ? 'no' : 'yes';
  const targetSize = Math.abs(netDelta) - maxExposure;

  return {
    shouldHedge: true,
    hedgeSide,
    hedgeSize: targetSize,
    currentExposure: netDelta,
    reason: `exposure ${netDelta} > max ${maxExposure}`,
  };
}

/**
 * Auto-place hedge order
 */
export async function executeHedge(
  ticker: string,
  side: 'yes' | 'no',
  size: number,
  maxPrice: number,
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  if (!keyId || !pem) return { success: false, error: 'no auth' };

  try {
    const r = await axios.post(
      `${base}/trade-api/v2/portfolio/orders`,
      {
        ticker,
        side,
        action: 'buy',
        count: size,
        type: 'limit',
        ...(side === 'yes' ? { yes_price: maxPrice } : { no_price: maxPrice }),
      },
      { headers: { ...sign('POST', '/trade-api/v2/portfolio/orders'), 'Content-Type': 'application/json' } },
    );

    return {
      success: true,
      orderId: r.data?.order?.order_id,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e?.response?.data?.message || e.message,
    };
  }
}

/**
 * Find hedge market (can be same ticker for offset, or different expiry)
 */
export async function findHedgeMarket(preferredTicker: string): Promise<string | null> {
  // For now, use same market if available
  // In future, could find different expiry for temporal hedge
  return preferredTicker;
}
