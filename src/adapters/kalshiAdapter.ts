import axios from 'axios';
import type { MarketSnapshot } from '../types/index.js';
import type { LiveOrderRequest, LiveOrderResponse } from '../types/live.js';
import type { DiscoverOptions, DiscoveredMarket } from '../types/discovery.js';
import { kalshiSignedHeaders } from './kalshiAuth.js';

export interface KalshiAdapterCreds {
  bearerToken?: string;
  keyId?: string;
  privateKeyPem?: string;
}

/**
 * Kalshi adapter with two auth modes:
 * 1) bearer token (legacy)
 * 2) RSA signed headers (recommended/live)
 */
export class KalshiAdapter {
  constructor(
    private baseUrl: string,
    private creds: KalshiAdapterCreds,
  ) {}

  private authHeaders(method: 'GET' | 'POST' | 'DELETE', path: string) {
    if (this.creds.keyId && this.creds.privateKeyPem) {
      return kalshiSignedHeaders(
        { keyId: this.creds.keyId, privateKeyPem: this.creds.privateKeyPem },
        method,
        path,
      );
    }
    if (this.creds.bearerToken) {
      return { Authorization: `Bearer ${this.creds.bearerToken}` };
    }
    throw new Error('No Kalshi auth configured');
  }

  async discoverActive15mBtcMarket(opts: DiscoverOptions = {}): Promise<DiscoveredMarket | null> {
    const path = '/trade-api/v2/markets?status=open&limit=200';
    const headers = this.authHeaders('GET', '/trade-api/v2/markets');
    const r = await axios.get(`${this.baseUrl}${path}`, { headers });

    const now = Date.now();
    const needle = (opts.contains ?? 'BTC').toLowerCase();
    const minSecs = opts.minSecondsToExpiry ?? 120;
    const rows = (r.data?.markets ?? []) as any[];

    const candidates = rows
      .map((m) => {
        const exp = m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
        const secs = Math.floor((exp - now) / 1000);
        return {
          ticker: String(m.ticker ?? ''),
          title: String(m.title ?? ''),
          expirationTime: m.expiration_time,
          secondsToExpiry: secs,
        } as DiscoveredMarket;
      })
      .filter((m) => m.ticker && m.secondsToExpiry > minSecs)
      .filter((m) => {
        const t = `${m.ticker} ${m.title ?? ''}`.toLowerCase();
        return t.includes(needle) && (t.includes('15') || t.includes('15m') || t.includes('15 minute'));
      })
      .sort((a, b) => a.secondsToExpiry - b.secondsToExpiry);

    return candidates[0] ?? null;
  }

  async getMarketSnapshot(ticker: string): Promise<MarketSnapshot> {
    const p1 = `/trade-api/v2/markets/${ticker}`;
    const p2 = `/trade-api/v2/markets/${ticker}/orderbook`;

    const [mkt, ob] = await Promise.all([
      axios.get(`${this.baseUrl}${p1}`, { headers: this.authHeaders('GET', p1) }),
      axios.get(`${this.baseUrl}${p2}`, { headers: this.authHeaders('GET', p2) }),
    ]);

    const expiryTs = new Date(mkt.data?.market?.expiration_time ?? Date.now()).getTime();
    const b = ob.data?.orderbook ?? {};

    return {
      ticker,
      expiryTs,
      top: {
        yesAsk: numOrNull(b.yes_ask),
        noAsk: numOrNull(b.no_ask),
        yesBid: numOrNull(b.yes_bid),
        noBid: numOrNull(b.no_bid),
        ts: Date.now(),
      },
    };
  }

  async placeOrder(req: LiveOrderRequest): Promise<LiveOrderResponse> {
    try {
      const path = '/trade-api/v2/orders';
      const r = await axios.post(
        `${this.baseUrl}${path}`,
        {
          ticker: req.ticker,
          side: req.side,
          action: req.action,
          count: req.count,
          type: req.type ?? 'limit',
          price: req.price,
          time_in_force: req.time_in_force ?? 'ioc',
        },
        { headers: this.authHeaders('POST', path) },
      );

      return {
        ok: true,
        orderId: r.data?.order?.order_id ?? r.data?.order_id,
        raw: r.data,
      };
    } catch (error: any) {
      return {
        ok: false,
        error: error?.response?.data?.message ?? error?.message ?? 'order failed',
        raw: error?.response?.data,
      };
    }
  }
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
