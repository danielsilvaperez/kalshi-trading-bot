import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';
const staleThresholdMs = Number(process.env.STALE_ORDER_MS || 120000); // 2 min

function sign(method: string, path: string) {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64'),
  };
}

export async function cancelStaleOrders(): Promise<{ cancelled: number; errors: number }> {
  if (!keyId || !pem) return { cancelled: 0, errors: 0 };

  let cancelled = 0;
  let errors = 0;

  try {
    const r = await axios.get(`${base}/trade-api/v2/portfolio/orders?status=resting`, { headers: sign('GET', '/trade-api/v2/portfolio/orders') });
    const orders = (r.data?.orders ?? []) as any[];
    const now = Date.now();

    for (const o of orders) {
      const created = new Date(o.created_time || 0).getTime();
      const age = now - created;

      if (age > staleThresholdMs) {
        try {
          await axios.delete(`${base}/trade-api/v2/portfolio/orders/${o.order_id}`, { headers: sign('DELETE', `/trade-api/v2/portfolio/orders/${o.order_id}`) });
          console.log(`[cleanup] cancelled stale order ${o.order_id} (${(age/1000).toFixed(0)}s old)`);
          cancelled++;
        } catch {
          errors++;
        }
      }
    }
  } catch (e) {
    console.error('[cleanup] error fetching orders', e);
    errors++;
  }

  return { cancelled, errors };
}
