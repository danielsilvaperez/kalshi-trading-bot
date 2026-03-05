import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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

export interface PortfolioHeatMap {
  totalExposure: number;
  yesExposure: number;
  noExposure: number;
  netDelta: number;
  byHour: Record<number, { yes: number; no: number }>;
  byPriceBucket: Record<string, { yes: number; no: number; pnl: number }>;
  unrealizedPnl: number;
  realizedPnl: number;
}

export async function generateHeatMap(): Promise<PortfolioHeatMap> {
  if (!keyId || !pem) {
    return {
      totalExposure: 0, yesExposure: 0, noExposure: 0, netDelta: 0,
      byHour: {}, byPriceBucket: {}, unrealizedPnl: 0, realizedPnl: 0,
    };
  }

  try {
    const posResp = await axios.get(`${base}/trade-api/v2/portfolio/positions`, { headers: sign('GET', '/trade-api/v2/portfolio/positions') });
    const positions = (posResp.data?.market_positions ?? posResp.data?.positions ?? []) as any[];

    let yesExposure = 0;
    let noExposure = 0;
    let unrealizedPnl = 0;
    const byHour: Record<number, { yes: number; no: number }> = {};
    const byPriceBucket: Record<string, { yes: number; no: number; pnl: number }> = {};

    for (const p of positions) {
      const size = Math.abs(p.position || 0);
      const side = p.position > 0 ? 'yes' : 'no';
      const pnl = p.unrealized_pnl || 0;

      if (side === 'yes') yesExposure += size;
      else noExposure += size;

      unrealizedPnl += pnl;

      // Parse expiration hour from ticker
      const hour = extractHourFromTicker(p.ticker);
      if (hour !== null) {
        if (!byHour[hour]) byHour[hour] = { yes: 0, no: 0 };
        byHour[hour][side] += size;
      }

      // Price bucket
      const avgPrice = p.avg_price || 50;
      const bucket = `${Math.floor(avgPrice / 10) * 10}-${Math.floor(avgPrice / 10) * 10 + 10}`;
      if (!byPriceBucket[bucket]) byPriceBucket[bucket] = { yes: 0, no: 0, pnl: 0 };
      byPriceBucket[bucket][side] += size;
      byPriceBucket[bucket].pnl += pnl;
    }

    return {
      totalExposure: yesExposure + noExposure,
      yesExposure,
      noExposure,
      netDelta: yesExposure - noExposure,
      byHour,
      byPriceBucket,
      unrealizedPnl,
      realizedPnl: 0, // Would need to calculate from fills
    };
  } catch {
    return {
      totalExposure: 0, yesExposure: 0, noExposure: 0, netDelta: 0,
      byHour: {}, byPriceBucket: {}, unrealizedPnl: 0, realizedPnl: 0,
    };
  }
}

function extractHourFromTicker(ticker: string): number | null {
  // Parse hour from KXBTC15M-26FEB131200-00 format
  const match = ticker.match(/(\d{2})(\d{2})-/);
  if (match) return parseInt(match[1]);
  return null;
}

export function logHeatMap(heatMap: PortfolioHeatMap) {
  console.log('[heatmap]', {
    totalExposure: heatMap.totalExposure,
    netDelta: heatMap.netDelta,
    unrealizedPnl: heatMap.unrealizedPnl,
    byHour: heatMap.byHour,
  });
}
