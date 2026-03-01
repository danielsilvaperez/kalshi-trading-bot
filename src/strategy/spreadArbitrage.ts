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

/**
 * Construct a risk-defined spread:
 * Buy YES @ low price + Buy NO @ low price when sum < 95c
 * Guaranteed profit of 5c+ minus fees
 */
export async function findSpreadArbitrage(ticker: string): Promise<{
  executable: boolean;
  yesPrice?: number;
  noPrice?: number;
  totalCost?: number;
  guaranteedProfit?: number;
  reason?: string;
}> {
  if (!keyId || !pem) return { executable: false, reason: 'no auth' };

  try {
    const r = await axios.get(`${base}/trade-api/v2/markets/${ticker}/orderbook`, { headers: sign('GET', `/trade-api/v2/markets/${ticker}/orderbook`) });
    const book = r.data?.orderbook ?? {};

    const yesAsk = book.yes?.[0]?.[0] ?? 100;
    const noAsk = book.no?.[0]?.[0] ?? 100;

    const total = yesAsk + noAsk;

    // Need sum < 95c for guaranteed profit after fees (~2c each side)
    if (total >= 95) {
      return { executable: false, reason: `spread too wide: ${yesAsk}c + ${noAsk}c = ${total}c` };
    }

    const profit = 100 - total - 4; // 4c fees estimate

    return {
      executable: profit > 1,
      yesPrice: yesAsk,
      noPrice: noAsk,
      totalCost: total,
      guaranteedProfit: profit,
    };
  } catch {
    return { executable: false, reason: 'fetch error' };
  }
}

/**
 * Execute paired spread trade atomically
 */
export async function executeSpread(
  ticker: string,
  yesPrice: number,
  noPrice: number,
  count: number,
): Promise<{ success: boolean; yesOrderId?: string; noOrderId?: string; error?: string }> {
  // This would need proper implementation with sequential order placement
  // and unwind logic if one leg fails
  console.log(`[spread] would execute ${ticker}: YES@${yesPrice}c + NO@${noPrice}c x${count}`);
  return { success: false, error: 'spread execution not yet implemented' };
}
