/**
 * ML Data Capture - Enhanced logging for model training
 * Captures rich features per trade for later analysis
 */
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface TradeFeatures {
  // Core trade data
  timestamp: string;
  ticker: string;
  action: 'BUY' | 'SELL';
  side: 'YES' | 'NO';
  qty: number;
  entryPrice: number;
  exitPrice?: number;
  
  // Market context at entry
  btcPrice: number;
  btcVolatility5m: number;  // 5-min BTC volatility %
  btcTrend30m: number;      // 30-min BTC trend direction
  
  // Orderbook context
  spread: number;           // yesAsk - yesBid
  depthYes: number;
  depthNo: number;
  imbalance: number;        // (depthYes - depthNo) / total
  
  // Timing
  minsToExpiry: number;
  timeOfDay: number;        // Hour (0-23) for session patterns
  dayOfWeek: number;        // 0-6
  
  // Signal info
  signalReason: string;
  signalConfidence: number; // 0-1
  volatilitySignal: number; // % reading
  
  // Outcome (filled on SELL)
  fee?: number;
  grossPnl?: number;
  netPnl?: number;
  exitReason?: string;
  holdingTimeMs?: number;
  
  // Computed label (for training)
  label?: 1 | 0 | -1;  // 1=win, 0=breakeven, -1=loss
}

const ML_LOG_FILE = './logs/ml-features.csv';
const TRADE_LOG_FILE = './logs/trade-details.jsonl';

export function logMLFeatures(features: TradeFeatures) {
  try {
    // Ensure directory exists
    const dir = dirname(ML_LOG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    
    // Write header if new file
    if (!existsSync(ML_LOG_FILE)) {
      const headers = [
        'timestamp', 'ticker', 'action', 'side', 'qty', 'entryPrice', 'exitPrice',
        'btcPrice', 'btcVolatility5m', 'btcTrend30m',
        'spread', 'depthYes', 'depthNo', 'imbalance',
        'minsToExpiry', 'timeOfDay', 'dayOfWeek',
        'signalReason', 'signalConfidence', 'volatilitySignal',
        'fee', 'grossPnl', 'netPnl', 'exitReason', 'holdingTimeMs', 'label'
      ].join(',') + '\n';
      appendFileSync(ML_LOG_FILE, headers);
    }
    
    // Write data row
    const row = [
      features.timestamp,
      features.ticker,
      features.action,
      features.side,
      features.qty,
      features.entryPrice,
      features.exitPrice ?? '',
      features.btcPrice.toFixed(2),
      features.btcVolatility5m.toFixed(4),
      features.btcTrend30m.toFixed(4),
      features.spread,
      features.depthYes.toFixed(2),
      features.depthNo.toFixed(2),
      features.imbalance.toFixed(4),
      features.minsToExpiry.toFixed(2),
      features.timeOfDay,
      features.dayOfWeek,
      features.signalReason.replace(/,/g, ';'),
      features.signalConfidence.toFixed(2),
      features.volatilitySignal.toFixed(4),
      features.fee ?? '',
      features.grossPnl ?? '',
      features.netPnl ?? '',
      features.exitReason ?? '',
      features.holdingTimeMs ?? '',
      features.label ?? ''
    ].join(',') + '\n';
    
    appendFileSync(ML_LOG_FILE, row);
    
    // Also log full JSON for detailed analysis
    const jsonDir = dirname(TRADE_LOG_FILE);
    if (!existsSync(jsonDir)) mkdirSync(jsonDir, { recursive: true });
    appendFileSync(TRADE_LOG_FILE, JSON.stringify(features) + '\n');
    
  } catch (e) {
    console.error('ML logging error:', e);
  }
}

export function computeLabel(netPnl: number): 1 | 0 | -1 {
  if (netPnl > 5) return 1;      // Win: >5¢ profit
  if (netPnl < -5) return -1;    // Loss: >5¢ loss
  return 0;                       // Breakeven
}

// Helper to calculate BTC trend/volatility from price cache
export function calculateBTCTrends(prices: { ts: number; price: number }[]) {
  const now = Date.now();
  
  // 5-min volatility
  const recent5m = prices.filter(p => now - p.ts < 300000);
  let volatility5m = 0;
  if (recent5m.length >= 2) {
    const vals = recent5m.map(p => p.price);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((sum, p) => sum + Math.pow(p - avg, 2), 0) / vals.length;
    volatility5m = Math.sqrt(variance) / avg * 100;  // CV as %
  }
  
  // 30-min trend
  const recent30m = prices.filter(p => now - p.ts < 1800000);
  let trend30m = 0;
  if (recent30m.length >= 2) {
    const first = recent30m[0].price;
    const last = recent30m[recent30m.length - 1].price;
    trend30m = (last - first) / first * 100;
  }
  
  return { volatility5m, trend30m };
}
