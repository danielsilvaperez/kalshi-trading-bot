/**
 * SWING v14 VOLATILITY SCALPER — With ML Pipeline + Safety Gates + Real-Time Data
 * Dynamic sizing, momentum signals, ML-enhanced entries
 *
 * v14: Kalshi WebSocket (orderbook, fills, positions), stale price detection,
 * flash crash protection, slippage tracking, volatility regime filter,
 * Kelly sizing, DRY_RUN mode, outcomes.jsonl pipeline
 *
 * v13.3 fixes: TP/SL paired cancellation, passive fill PnL tracking,
 * stale order cleanup, kill switch, balance floor halt, atomic state writes,
 * tighter signal thresholds (0.05), 1:1 R:R (10c/10c)
 */

import 'dotenv/config';
import axios from 'axios';
import WebSocket from 'ws';
import { createSign, constants } from 'node:crypto';
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logMLFeatures, computeLabel, calculateBTCTrends } from './ml/logger.js';
import { detectFlashCrash } from './safety/flashCrashProtection.js';
import { logSlippage, adjustEntryForSlippage, shouldPauseForSlippage } from './safety/slippageTracker.js';
import { calculateKellySizing, applyKellySizing } from './safety/kellySizing.js';

const CONFIG = {
  // Dry run mode — simulate orders without real money
  DRY_RUN: process.env.DRY_RUN === 'true',

  // Stale price detection
  STALE_PRICE_MS: 30000,           // 30s — skip if BTC feed is older
  
  // Kalshi WebSocket
  KALSHI_WS_URL: 'wss://api.elections.kalshi.com/trade-api/ws/v2',

  // Dynamic sizing — 2.5% of balance per trade (reduced for hold-through strategy)
  TRADE_SIZE_PCT: 0.025,            // 2.5% of balance (was 5%)
  MIN_TRADE_CENTS: 50,             // At least 50c
  MAX_TRADE_CENTS: 500,            // Cap at $5
  MAX_POSITION_PER_SIDE: 1000,     // $10 max per side
  
  // Entry — tighter band, momentum-aligned
  MIN_ENTRY_PRICE: 25,             // Avoid cheap entries (<25c lose more)
  MAX_ENTRY_PRICE: 45,             // 25–45c
  MAX_ENTRY_SPREAD_CENTS: 5,       // Max spread allowed (was unused MIN_SPREAD)
  MIN_DEPTH: 5,                    // Min depth (was 3)
  MIN_IMBALANCE: 0.2,              // Orderbook imbalance threshold (20%)
  
  // Exits — 1:1 R:R (breakeven ~53% win rate after fees)
  PROFIT_TARGET_CENTS: 10,         // Take profit at 10c
  STOP_LOSS_CENTS: 10,             // Stop loss at -10c
  
  // Timing
  POLL_INTERVAL_MS: 1500,          // 1.5s
  MAX_TRADES_PER_WINDOW: 1,        // 1 trade max
  ENTRY_COOLDOWN_MS: 30000,        // 30s cooldown
  MIN_MINS_TO_EXPIRY: 8,           // Need 8+ mins to enter (learned from data)
  MAX_MINS_TO_EXPIRY: 14,
  EMERGENCY_EXIT_MINS: 3,          // Force exit with 3 mins left (was 2, increased for hold strategy)
  TP_STALE_MS: 45000,              // Cancel TP if not filling after 45s
  
  // Momentum
  MOMENTUM_LOOKBACK_MS: 300000,    // 5 min lookback
  MIN_VOLATILITY_PCT: 0.3,         // 0.3% vol -> YES
  FADE_MOMENTUM_PCT: 0.5,          // >0.5% move -> NO (Fade)
  MIN_CHOP_PCT: 0.12,              // <0.12% vol -> Skip (lowered to trade more)
  MIN_SIGNAL_SCORE: 0.05,          // Min score threshold (tightened from 0.02)
  
  // ML Model
  USE_ML_FILTER: false,            // Logic hardcoded from 70k sample analysis
  MIN_ML_CONFIDENCE: 0.6,          // Min confidence to enter
  
  // Risk
  DAILY_LOSS_LIMIT_CENTS: 1500,    // $15 max loss
  BALANCE_FLOOR_CENTS: 500,        // Never below $5
  MAX_CONSECUTIVE_LOSSES: 3,       // Kill switch after 3 consecutive losses
  
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  
  // Files
  STATE_FILE: './tmp/swing-state.json',
  LOG_FILE: './logs/swing.log',
  LOCK_FILE: './tmp/swing.lock',
  TRADE_LOG: './logs/trades.csv',
};

let rateLimitUntil = 0;
let rateLimitBackoffMs = 2000;

// === KALSHI WEBSOCKET STATE ===
interface OrderbookState {
  yes: [number, number][];  // [price, size][]
  no: [number, number][];
  seq: number;
  lastUpdate: number;
}

// Real-time caches fed by WebSocket
const wsOrderbooks = new Map<string, OrderbookState>();  // ticker -> orderbook
const wsPositions = new Map<string, any>();    // ticker -> positions (deleted on fill to force REST refresh)
let kalshiWs: WebSocket | null = null;
let kalshiWsConnected = false;
let kalshiWsConnecting = false;
let wsMessageId = 1;
let currentMarketTicker: string | null = null;

// BTC price cache (real-time via dual WebSocket feeds)
let btcPrices: { ts: number; price: number }[] = [];
let btcFeedStale = false;
let lastStaleAlertTs = 0;

// --- Kraken WebSocket ---
let krakenWs: WebSocket | null = null;
let krakenConnected = false;
let krakenPingInterval: ReturnType<typeof setInterval> | null = null;

function initKrakenWs() {
  const connect = () => {
    krakenWs = new WebSocket('wss://ws.kraken.com');

    krakenWs.on('open', () => {
      krakenConnected = true;
      log('Kraken WS connected', 'INFO');
      krakenWs?.send(JSON.stringify({
        event: 'subscribe',
        pair: ['XBT/USD'],
        subscription: { name: 'trade' }
      }));
      // Heartbeat: ping every 30s to detect dead connections fast
      if (krakenPingInterval) clearInterval(krakenPingInterval);
      krakenPingInterval = setInterval(() => {
        if (krakenWs?.readyState === WebSocket.OPEN) {
          krakenWs.ping();
        }
      }, 30000);
    });

    krakenWs.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (Array.isArray(msg) && msg[msg.length - 2] === 'trade') {
          const now = Date.now();
          for (const t of msg[1]) {
            // Use exchange timestamp (seconds) when available, else Date.now()
            const exchangeTs = parseFloat(t[2]);
            const ts = exchangeTs > 1e9 ? Math.round(exchangeTs * 1000) : now;
            pushPrice(ts, parseFloat(t[0]));
          }
        }
      } catch {}
    });

    krakenWs.on('close', () => {
      krakenConnected = false;
      if (krakenPingInterval) { clearInterval(krakenPingInterval); krakenPingInterval = null; }
      log('Kraken WS disconnected, reconnecting in 1s...', 'WARN');
      krakenWs = null;
      setTimeout(connect, 1000);
    });

    krakenWs.on('error', (err) => {
      log(`Kraken WS error: ${err.message}`, 'ERROR');
      krakenWs?.close();
    });
  };
  connect();
}

// --- Coinbase WebSocket (secondary, US-friendly, very fast) ---
let coinbaseWs: WebSocket | null = null;
let coinbaseConnected = false;
let coinbasePingInterval: ReturnType<typeof setInterval> | null = null;

function initCoinbaseWs() {
  const connect = () => {
    coinbaseWs = new WebSocket('wss://ws-feed.exchange.coinbase.com');

    coinbaseWs.on('open', () => {
      coinbaseConnected = true;
      log('Coinbase WS connected', 'INFO');
      coinbaseWs?.send(JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['matches']
      }));
      if (coinbasePingInterval) clearInterval(coinbasePingInterval);
      coinbasePingInterval = setInterval(() => {
        if (coinbaseWs?.readyState === WebSocket.OPEN) {
          coinbaseWs.ping();
        }
      }, 30000);
    });

    coinbaseWs.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'match' || msg.type === 'last_match') {
          const price = parseFloat(msg.price);
          const ts = msg.time ? new Date(msg.time).getTime() : Date.now();
          if (price > 0) pushPrice(ts, price);
        }
      } catch {}
    });

    coinbaseWs.on('close', () => {
      coinbaseConnected = false;
      if (coinbasePingInterval) { clearInterval(coinbasePingInterval); coinbasePingInterval = null; }
      log('Coinbase WS disconnected, reconnecting in 1s...', 'WARN');
      coinbaseWs = null;
      setTimeout(connect, 1000);
    });

    coinbaseWs.on('error', (err) => {
      log(`Coinbase WS error: ${err.message}`, 'ERROR');
      coinbaseWs?.close();
    });
  };
  connect();
}

// Shared price ingestion — deduplicates close timestamps
function pushPrice(ts: number, price: number) {
  btcPrices.push({ ts, price });
  // Prune: keep last 10 min, cap at 5000 ticks (dual feed = more data)
  if (btcPrices.length > 5000) {
    const cutoff = Date.now() - 600000;
    btcPrices = btcPrices.filter(p => p.ts > cutoff);
  }
}

function initBtcWebSocket() {
  initKrakenWs();
  initCoinbaseWs();
}

// === KALSHI WEBSOCKET ===

function signWs(): Record<string, string> {
  const ts = String(Date.now());
  const msg = `${ts}GET/trade-api/ws/v2`;
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign({ key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, 'base64'),
  };
}

function initKalshiWebSocket() {
  if (kalshiWsConnecting || kalshiWs?.readyState === WebSocket.OPEN) return;
  kalshiWsConnecting = true;

  const connect = () => {
    try {
      const headers = signWs();
      kalshiWs = new WebSocket(CONFIG.KALSHI_WS_URL, { headers });

      kalshiWs.on('open', () => {
        kalshiWsConnected = true;
        kalshiWsConnecting = false;
        log('Kalshi WebSocket connected', 'INFO');
        
        // Subscribe to ticker for all markets (public channel)
        wsSend({
          id: wsMessageId++,
          cmd: 'subscribe',
          params: { channels: ['ticker'] }
        });
        
        // Subscribe to current market orderbook if we have one
        if (currentMarketTicker) {
          subscribeToOrderbook(currentMarketTicker);
        }
      });

      kalshiWs.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          handleWsMessage(msg);
        } catch (e) {
          log(`WebSocket parse error: ${e}`, 'ERROR');
        }
      });

      kalshiWs.on('close', () => {
        kalshiWsConnected = false;
        kalshiWsConnecting = false;
        log('Kalshi WebSocket disconnected, reconnecting in 2s...', 'WARN');
        kalshiWs = null;
        setTimeout(connect, 2000);
      });

      kalshiWs.on('error', (err) => {
        log(`Kalshi WebSocket error: ${err.message}`, 'ERROR');
        kalshiWs?.close();
      });
    } catch (e: any) {
      log(`Failed to connect Kalshi WebSocket: ${e.message}`, 'ERROR');
      kalshiWsConnecting = false;
      setTimeout(connect, 5000);
    }
  };

  connect();
}

function wsSend(msg: any) {
  if (kalshiWs?.readyState === WebSocket.OPEN) {
    kalshiWs.send(JSON.stringify(msg));
  }
}

function subscribeToOrderbook(ticker: string) {
  if (!kalshiWsConnected) return;
  wsSend({
    id: wsMessageId++,
    cmd: 'subscribe',
    params: {
      channels: ['orderbook_delta'],
      market_tickers: [ticker]
    }
  });
  log(`Subscribed to orderbook for ${ticker}`, 'INFO');
}

function unsubscribeFromOrderbook(ticker: string) {
  if (!kalshiWsConnected) return;
  // Find subscription ID for this ticker
  const subId = findOrderbookSubId(ticker);
  if (subId) {
    wsSend({
      id: wsMessageId++,
      cmd: 'unsubscribe',
      params: { sids: [subId] }
    });
  }
}

let orderbookSubIds = new Map<string, number>();  // ticker -> sid

function findOrderbookSubId(ticker: string): number | null {
  return orderbookSubIds.get(ticker) || null;
}

function handleWsMessage(msg: any) {
  const type = msg.type;
  
  switch (type) {
    case 'subscribed':
      // Track subscription IDs for orderbook
      if (msg.msg?.channel === 'orderbook_delta' && msg.msg?.market_ticker) {
        orderbookSubIds.set(msg.msg.market_ticker, msg.sid);
      }
      break;
      
    case 'orderbook_snapshot':
      handleOrderbookSnapshot(msg.msg);
      break;
      
    case 'orderbook_delta':
      handleOrderbookDelta(msg.msg, msg.seq);
      break;
      
    case 'fill':
      handleFill(msg.msg);
      break;
      
    case 'ticker':
      // Ticker updates - can be used for market status
      break;
      
    case 'error':
      log(`WebSocket error: ${msg.msg?.code} - ${msg.msg?.msg}`, 'ERROR');
      break;
  }
}

function handleOrderbookSnapshot(msg: any) {
  const ticker = msg.market_ticker;
  if (!ticker) return;
  
  const book: OrderbookState = {
    yes: msg.yes || [],
    no: msg.no || [],
    seq: 0,
    lastUpdate: Date.now()
  };
  wsOrderbooks.set(ticker, book);
}

function handleOrderbookDelta(msg: any, seq: number) {
  const ticker = msg.market_ticker;
  if (!ticker) return;
  
  let book = wsOrderbooks.get(ticker);
  if (!book) {
    // Create new book if we don't have a snapshot yet
    book = { yes: [], no: [], seq: 0, lastUpdate: Date.now() };
    wsOrderbooks.set(ticker, book);
  }
  
  // Apply deltas
  const applyDelta = (side: 'yes' | 'no', deltas: [number, number][]) => {
    if (!deltas || deltas.length === 0) return;
    for (const [price, size] of deltas) {
      const idx = book![side].findIndex(l => l[0] === price);
      if (size === 0) {
        // Remove level
        if (idx >= 0) book![side].splice(idx, 1);
      } else if (idx >= 0) {
        // Update level
        book![side][idx][1] = size;
      } else {
        // Add level (and keep sorted by price)
        book![side].push([price, size]);
        book![side].sort((a, b) => a[0] - b[0]);
      }
    }
  };
  
  applyDelta('yes', msg.yes);
  applyDelta('no', msg.no);
  book.seq = seq;
  book.lastUpdate = Date.now();
}

function handleFill(msg: any) {
  // Log fill notification (order status tracked via REST with cache invalidation)
  const orderId = msg.order_id;
  const side = msg.side || '?';
  log(`Fill (WS): ${side.toUpperCase()} ${msg.filled_count}x @ ${msg.price}c (order: ${orderId?.slice(0, 8)}...)`, 'TRADE');
  
  // Invalidate position cache to force REST refresh on next check
  updatePositionFromFill(msg);
}

function updatePositionFromFill(msg: any) {
  // When we get a fill, mark positions as needing refresh
  // The next getPositions call will use REST to get fresh data
  wsPositions.delete(msg.market_ticker);  // Force REST refresh
}

// Helper to switch orderbook subscription when market changes
function switchMarketSubscription(newTicker: string) {
  if (currentMarketTicker && currentMarketTicker !== newTicker) {
    unsubscribeFromOrderbook(currentMarketTicker);
    wsOrderbooks.delete(currentMarketTicker);
  }
  if (newTicker !== currentMarketTicker) {
    currentMarketTicker = newTicker;
    subscribeToOrderbook(newTicker);
  }
}

function retryAfterMs(header: any): number | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header[0] : header;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && asNum > 0) return asNum * 1000;
  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// === AUTH ===
const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';

if (!keyId || !pem) { console.error('Missing auth'); process.exit(1); }

function acquireLock() {
  try {
    if (existsSync(CONFIG.LOCK_FILE)) {
      const pid = Number(readFileSync(CONFIG.LOCK_FILE, 'utf8'));
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.error(`Lock exists (pid ${pid}) — exiting`);
          process.exit(1);
        } catch {}
      }
    }
    const dir = dirname(CONFIG.LOCK_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG.LOCK_FILE, String(process.pid));
    process.on('exit', () => { try { unlinkSync(CONFIG.LOCK_FILE); } catch {} });
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  } catch (e: any) {
    console.error('Failed to acquire lock', e?.message || e);
    process.exit(1);
  }
}

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

async function api(method: 'GET' | 'POST' | 'DELETE', path: string, data?: any) {
  const now = Date.now();
  if (rateLimitUntil > now) await sleep(rateLimitUntil - now);

  const opts: any = { headers: sign(method, path), timeout: 8000 };
  try {
    if (method === 'GET') return (await axios.get(`${base}${path}`, opts)).data;
    if (method === 'POST') return (await axios.post(`${base}${path}`, data, { ...opts, headers: { ...opts.headers, 'Content-Type': 'application/json' } })).data;
    if (method === 'DELETE') return (await axios.delete(`${base}${path}`, opts)).data;
  } catch (e: any) {
    if (e?.response?.status === 429) {
      const ra = retryAfterMs(e?.response?.headers?.['retry-after']);
      let ms = ra ?? Math.min(rateLimitBackoffMs * 2, 60000);
      if (!ra) rateLimitBackoffMs = ms; else rateLimitBackoffMs = 2000;
      rateLimitUntil = Date.now() + ms;
      log(`Rate limited (429) — backing off ${Math.round(ms / 1000)}s`, 'WARN');
    }
    throw e;
  }
}

// === LOGGING ===
function log(msg: string, level = 'INFO') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try {
    const dir = dirname(CONFIG.LOG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(CONFIG.LOG_FILE, line + '\n');
  } catch {}
}

// Track running positions for PnL calculation
const positionTracker: Map<string, { qty: number; avgPrice: number; side: 'YES' | 'NO' }> = new Map();

function logTrade(data: {
  timestamp: string;
  ticker: string;
  action: 'BUY' | 'SELL';
  side: 'YES' | 'NO';
  qty: number;
  price: number;
  reason: string;
  pnl?: number;
  btcPrice?: number;
  momentum?: string;
  fee?: number;
  orderId?: string;
  entryPrice?: number;
}) {
  try {
    const dir = dirname(CONFIG.TRADE_LOG);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(CONFIG.TRADE_LOG)) {
      appendFileSync(CONFIG.TRADE_LOG, 'timestamp,ticker,action,side,qty,price,fee,netPnl,grossPnl,reason,btcPrice,momentum,orderId,entryPrice\n');
    }
    
    // Calculate net PnL (gross - fee)
    const grossPnl = data.pnl || 0;
    const fee = data.fee || 0;
    const netPnl = grossPnl - fee;
    
    // Track positions for accurate PnL
    const key = `${data.ticker}_${data.side}`;
    if (data.action === 'BUY') {
      const existing = positionTracker.get(key);
      if (existing) {
        const totalQty = existing.qty + data.qty;
        const totalCost = (existing.qty * existing.avgPrice) + (data.qty * data.price);
        existing.qty = totalQty;
        existing.avgPrice = Math.round(totalCost / totalQty);
      } else {
        positionTracker.set(key, { qty: data.qty, avgPrice: data.price, side: data.side });
      }
    } else if (data.action === 'SELL') {
      const existing = positionTracker.get(key);
      if (existing) {
        existing.qty = Math.max(0, existing.qty - data.qty);
        if (existing.qty === 0) {
          positionTracker.delete(key);
        }
      }
    }
    
    appendFileSync(CONFIG.TRADE_LOG,
      `${data.timestamp},${data.ticker},${data.action},${data.side},${data.qty},${data.price},${fee},${netPnl},${grossPnl},${data.reason},${data.btcPrice || ''},${data.momentum || ''},${data.orderId || ''},${data.entryPrice || ''}\n`
    );

    // Write outcomes.jsonl on every closed trade (feeds Kelly sizing + kill switch)
    if (data.action === 'SELL' && data.entryPrice) {
      try {
        appendFileSync('./logs/outcomes.jsonl', JSON.stringify({
          ts: data.timestamp,
          ticker: data.ticker,
          entryPrice: data.entryPrice,
          exitPrice: data.price,
          won: grossPnl > 0,
          profitCents: netPnl,
          side: data.side,
        }) + '\n');
      } catch {}
    }

    // Also log detailed trade to main log
    const netStr = netPnl > 0 ? `+${netPnl}` : `${netPnl}`;
    log(`${data.action} ${data.side} ${data.qty}x @ ${data.price}c | Net: ${netStr}c | Fee: ${fee}c | ${data.reason}`, 'TRADE');
  } catch {}
}

async function notify(msg: string) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
  const prefix = CONFIG.DRY_RUN ? '[DRY] ' : '';
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID, text: `${prefix}🎯 ${msg}`,
    }, { timeout: 5000 });
  } catch {}
}

// === ML ENHANCED PREDICTION ===
interface TreeNode {
  feature?: string;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
  prediction?: number;
  confidence?: number;
}

let mlModel: TreeNode | null = null;
let mlFeatures: Map<string, any> = new Map(); // Store entry features for later ML training

function loadMlModel() {
  try {
    if (existsSync('./models/entry_filter.json')) {
      const data = JSON.parse(readFileSync('./models/entry_filter.json', 'utf8'));
      mlModel = data.tree;
      log(`ML model loaded (accuracy: ${(data.accuracy * 100).toFixed(1)}%)`, 'INFO');
    }
  } catch (e: any) {
    log(`No ML model found: ${e.message}`, 'INFO');
  }
}

interface MLFeatures {
  entryPrice: number;
  btcPrice: number;
  btcVolatility5m: number;
  btcTrend30m: number;
  spread: number;
  depthYes: number;
  depthNo: number;
  imbalance: number;
  minsToExpiry: number;
  timeOfDay: number;
  dayOfWeek: number;
  signalConfidence: number;
  volatilitySignal: number;
}

function mlPredict(features: MLFeatures): { shouldEnter: boolean; confidence: number } {
  if (!mlModel || !CONFIG.USE_ML_FILTER) {
    return { shouldEnter: true, confidence: 0.5 };
  }
  
  // Simple feature mapping to tree structure
  // This is a simplified version - full implementation would need feature alignment
  const treeFeatures: Record<string, number> = {
    entryPrice: features.entryPrice,
    btcVolatility5m: features.btcVolatility5m,
    btcTrend30m: features.btcTrend30m,
    spread: features.spread,
    imbalance: features.imbalance,
    minsToExpiry: features.minsToExpiry,
    signalConfidence: features.signalConfidence,
  };
  
  function predict(node: TreeNode): { prediction: number; confidence: number } {
    if (node.prediction !== undefined) {
      return { prediction: node.prediction, confidence: node.confidence || 0.5 };
    }
    const value = treeFeatures[node.feature!];
    if (value === undefined) {
      return predict(node.left!); // Default path
    }
    if (value <= node.threshold!) {
      return predict(node.left!);
    } else {
      return predict(node.right!);
    }
  }
  
  const result = predict(mlModel);
  return {
    shouldEnter: result.prediction === 1 && result.confidence >= CONFIG.MIN_ML_CONFIDENCE,
    confidence: result.confidence,
  };
}

// === ORDERBOOK IMBALANCE ===
function getOrderbookImbalance(book: { yesDepth: number; noDepth: number }): { imbalance: number; favoredSide: 'yes' | 'no' | 'neutral' } {
  const total = book.yesDepth + book.noDepth;
  if (total === 0) return { imbalance: 0, favoredSide: 'neutral' };
  
  const yesRatio = book.yesDepth / total;
  const noRatio = book.noDepth / total;
  const imbalance = Math.abs(yesRatio - noRatio);
  
  let favoredSide: 'yes' | 'no' | 'neutral' = 'neutral';
  if (imbalance >= CONFIG.MIN_IMBALANCE) {
    favoredSide = yesRatio > noRatio ? 'yes' : 'no';
  }
  
  return { imbalance, favoredSide };
}

// === SIGNAL LOGIC (Based on 70k sample Logistic Regression) ===
function getSignal(): { side: 'YES' | 'NO' | 'SKIP'; confidence: number; reason: string } {
  const now = Date.now();
  const recent = btcPrices.filter(p => now - p.ts < CONFIG.MOMENTUM_LOOKBACK_MS); // 5 min
  
  if (recent.length < 10) return { side: 'SKIP', confidence: 0, reason: 'No Data' };
  
  const prices = recent.map(p => p.price);
  const open = prices[0];
  const close = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  
  // 1. Momentum (Return %)
  const momPct = ((close - open) / open) * 100;
  
  // 2. Volatility (Range %)
  const volPct = ((high - low) / open) * 100;
  
  // Skip chop
  if (volPct < CONFIG.MIN_CHOP_PCT) return { side: 'SKIP', confidence: 0, reason: `Chop (${volPct.toFixed(2)}%)` };
  
  // 3. Linear Model Score (Weights from training)
  // Volatility (+0.16) vs Momentum (-0.04)
  // Score > 0.02 -> Strong YES
  // Score < -0.02 -> Strong NO
  const score = (0.16 * volPct) - (0.04 * momPct);
  
  let side: 'YES' | 'NO' | 'SKIP' = 'SKIP';
  let reason = '';
  
  if (score > CONFIG.MIN_SIGNAL_SCORE) {
    side = 'YES';
    reason = `High Vol (${volPct.toFixed(2)}%)`;
  } else if (score < -CONFIG.MIN_SIGNAL_SCORE) {
    side = 'NO';
    reason = `Fade Mom (${momPct.toFixed(2)}%)`;
  } else {
    reason = `Weak Signal (${score.toFixed(3)})`;
  }
  
  return { side, confidence: Math.abs(score), reason };
}

// === VOLATILITY REGIME CLASSIFIER (inline, reads from btcPrices) ===
type Regime = 'stable' | 'trending' | 'choppy' | 'unknown';

function classifyRegime(): { regime: Regime; canTrade: boolean; volatility: number; reason: string } {
  const now = Date.now();
  const recent = btcPrices.filter(p => now - p.ts < 300000); // last 5 min
  if (recent.length < 5) {
    return { regime: 'unknown', canTrade: false, volatility: 0, reason: 'insufficient data' };
  }

  // Tick-to-tick returns over last 2 min
  const twoMin = recent.filter(p => now - p.ts < 120000);
  const returns: number[] = [];
  for (let i = 1; i < twoMin.length; i++) {
    returns.push((twoMin[i].price - twoMin[i - 1].price) / twoMin[i - 1].price);
  }
  if (returns.length < 2) {
    return { regime: 'unknown', canTrade: false, volatility: 0, reason: 'insufficient ticks' };
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // 1-min and 5-min directional changes
  const current = recent[recent.length - 1].price;
  const p1m = recent.find(p => now - p.ts <= 60000)?.price ?? recent[0].price;
  const p5m = recent[0].price;
  const change1m = (current - p1m) / p1m;
  const change5m = (current - p5m) / p5m;
  const absChange1m = Math.abs(change1m);

  // CHOPPY: high vol, no clear direction, or rapid reversals
  if (stdDev > 0.0008 || absChange1m > 0.003) {
    return {
      regime: 'choppy',
      canTrade: false,
      volatility: stdDev,
      reason: `choppy: stdDev=${(stdDev * 100).toFixed(3)}%, 1m=${(absChange1m * 100).toFixed(3)}%`,
    };
  }

  // TRENDING: consistent direction, moderate volatility
  if (Math.abs(change5m) > 0.0005 && absChange1m > 0.00015 && change1m * change5m > 0) {
    return {
      regime: 'trending',
      canTrade: true,
      volatility: stdDev,
      reason: `trending: 1m=${(change1m * 100).toFixed(3)}%, 5m=${(change5m * 100).toFixed(3)}%`,
    };
  }

  // STABLE: low volatility, small moves
  if (stdDev < 0.0003 && absChange1m < 0.0005) {
    return {
      regime: 'stable',
      canTrade: false,
      volatility: stdDev,
      reason: `stable: stdDev=${(stdDev * 100).toFixed(3)}%, 1m=${(absChange1m * 100).toFixed(3)}%`,
    };
  }

  // Edge case — allow with caution
  return {
    regime: 'trending',
    canTrade: true,
    volatility: stdDev,
    reason: `edge: stdDev=${(stdDev * 100).toFixed(3)}%, 1m=${(change1m * 100).toFixed(3)}%`,
  };
}

// === STATE ===
interface State {
  tradesThisWindow: number;
  lastTradeTime: number;
  dailyPnl: number;
  dailyDate: string;
  circuitBreaker: boolean;
  consecutiveLosses: number;
  openTpOrders: { orderId: string; placedAt: number; ticker: string; side: string; qty: number; type: 'tp' | 'sl' }[];
}

function getToday() { return new Date().toISOString().split('T')[0]; }

function loadState(): State {
  const fresh: State = { tradesThisWindow: 0, lastTradeTime: 0, dailyPnl: 0, dailyDate: getToday(), circuitBreaker: false, consecutiveLosses: 0, openTpOrders: [] };
  try {
    if (existsSync(CONFIG.STATE_FILE)) {
      const s = JSON.parse(readFileSync(CONFIG.STATE_FILE, 'utf8'));
      if (s.dailyDate !== getToday()) return fresh;
      return { ...fresh, ...s };
    }
  } catch {}
  return fresh;
}

/** Remove openTpOrders whose markets have expired (close time in the past). */
async function cleanStaleOrders(state: State) {
  if (state.openTpOrders.length === 0) return;
  const now = Date.now();
  const stale: typeof state.openTpOrders = [];
  const keep: typeof state.openTpOrders = [];

  for (const order of state.openTpOrders) {
    // Check if the market is still open by querying Kalshi
    try {
      const data = await api('GET', `/trade-api/v2/markets/${order.ticker}`);
      const closeTime = data?.market?.close_time ? new Date(data.market.close_time).getTime() : 0;
      if (!closeTime || closeTime < now || data?.market?.status === 'closed' || data?.market?.status === 'settled') {
        stale.push(order);
      } else {
        keep.push(order);
      }
    } catch {
      // If we can't query the market, it's likely expired — remove it
      // But only if the order is old (> 20 min)
      if (now - order.placedAt > 20 * 60 * 1000) {
        stale.push(order);
      } else {
        keep.push(order);
      }
    }
  }

  if (stale.length > 0) {
    log(`Cleaned ${stale.length} stale orders from expired markets: ${stale.map(o => o.ticker).join(', ')}`, 'INFO');
    // Attempt to cancel them on the exchange too (harmless if already expired)
    for (const order of stale) {
      await cancelOrder(order.orderId).catch(() => {});
    }
    state.openTpOrders = keep;
    saveState(state);
  }
}

function saveState(s: State) {
  try {
    const dir = dirname(CONFIG.STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpFile = join(dir, `.swing-state-${process.pid}.tmp`);
    writeFileSync(tmpFile, JSON.stringify(s));
    renameSync(tmpFile, CONFIG.STATE_FILE);
  } catch (e: any) {
    log(`Failed to save state: ${e.message}`, 'ERROR');
  }
}

// === MARKET DATA ===
async function getBalance(): Promise<number | null> {
  try {
    const data = await api('GET', '/trade-api/v2/portfolio/balance');
    const balance = data?.balance;
    if (typeof balance !== 'number') {
      log('Balance API returned non-numeric value', 'WARN');
      return null;
    }
    return balance;
  } catch (e: any) {
    log(`Balance API failed: ${e.message}`, 'ERROR');
    return null;
  }
}

async function findMarket() {
  try {
    const data = await api('GET', '/trade-api/v2/markets?status=open&limit=50&series_ticker=KXBTC15M');
    const now = Date.now();
    const valid = (data?.markets ?? [])
      .map((m: any) => ({ ticker: m.ticker, minsToClose: (new Date(m.close_time).getTime() - now) / 60000 }))
      .filter((m: any) => m.minsToClose > CONFIG.MIN_MINS_TO_EXPIRY && m.minsToClose < CONFIG.MAX_MINS_TO_EXPIRY)
      .sort((a: any, b: any) => a.minsToClose - b.minsToClose);
    return valid[0] || null;
  } catch { return null; }
}

async function getBook(ticker: string) {
  // Try WebSocket cache first (faster, real-time)
  const wsBook = wsOrderbooks.get(ticker);
  if (wsBook && Date.now() - wsBook.lastUpdate < 5000) {  // Use if < 5s stale
    const yes = wsBook.yes;
    const no = wsBook.no;
    const yesBid = yes.length ? Math.max(...yes.map(l => l[0])) : 0;
    const noBid = no.length ? Math.max(...no.map(l => l[0])) : 0;
    return {
      yesBid, yesAsk: noBid > 0 ? 100 - noBid : 99,
      noBid, noAsk: yesBid > 0 ? 100 - yesBid : 99,
      yesDepth: yes.reduce((s, l) => s + (l[1] || 0), 0),
      noDepth: no.reduce((s, l) => s + (l[1] || 0), 0),
    };
  }
  
  // Fallback to REST API
  try {
    const data = await api('GET', `/trade-api/v2/markets/${ticker}/orderbook`);
    const yes = data?.orderbook?.yes || [];
    const no = data?.orderbook?.no || [];
    const yesBid = yes.length ? Math.max(...yes.map((l: any) => l[0])) : 0;
    const noBid = no.length ? Math.max(...no.map((l: any) => l[0])) : 0;
    return {
      yesBid, yesAsk: noBid > 0 ? 100 - noBid : 99,
      noBid, noAsk: yesBid > 0 ? 100 - yesBid : 99,
      yesDepth: yes.reduce((s: number, l: any) => s + (l[1] || 0), 0),
      noDepth: no.reduce((s: number, l: any) => s + (l[1] || 0), 0),
    };
  } catch { return null; }
}

async function getPositions(ticker: string) {
  // WebSocket: fills trigger cache invalidation, so if cache is empty/missing, use REST
  // In the future, we could track cumulative fills for true real-time positions
  try {
    const data = await api('GET', '/trade-api/v2/portfolio/positions');
    let yes = null, no = null;
    for (const p of (data?.positions || [])) {
      if (p.ticker !== ticker || p.position === 0) continue;
      const qty = Math.abs(p.position);
      const exp = Math.abs(p.market_exposure || 0);
      const avg = qty > 0 ? Math.round(exp / qty) : 0;
      if (p.position > 0) yes = { qty, avg, exp };
      else no = { qty, avg, exp };
    }
    return { yes, no };
  } catch { return { yes: null, no: null }; }
}

async function getOpenOrders(ticker?: string): Promise<any[]> {
  try {
    const data = await api('GET', `/trade-api/v2/portfolio/orders?status=open&limit=50`);
    const orders = data?.orders || [];
    if (ticker) return orders.filter((o: any) => o.ticker === ticker);
    return orders;
  } catch { return []; }
}

async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    await api('DELETE', `/trade-api/v2/portfolio/orders/${orderId}`);
    log(`Cancelled order ${orderId}`, 'INFO');
    return true;
  } catch (e: any) {
    log(`Failed to cancel ${orderId}: ${e.message}`, 'WARN');
    return false;
  }
}

async function getOrderStatus(orderId: string): Promise<{ status: string; filled: number; price?: number; fee?: number; cost?: number } | null> {
  try {
    const data = await api('GET', `/trade-api/v2/portfolio/orders/${orderId}`);
    if (!data?.order) return null;
    const o = data.order;
    return { 
      status: o.status, 
      filled: o.filled_count || 0, 
      price: o.avg_fill_price,
      fee: o.fees || 0,
      cost: o.cost || 0
    };
  } catch { return null; }
}

async function placeOrder(ticker: string, side: 'yes' | 'no', action: 'buy' | 'sell', price: number, qty: number): Promise<{
  ok: boolean;
  orderId: string;
  filled: number;
  fee?: number;
  avgPrice?: number;
}> {
  // DRY_RUN: simulate the order without calling the API
  if (CONFIG.DRY_RUN) {
    const simId = 'dry-' + Math.random().toString(36).slice(2, 10);
    const simFee = Math.round(price * qty * 0.025);
    log(`[DRY] ${action.toUpperCase()} ${side.toUpperCase()} ${qty}x @ ${price}c (simulated ${simId})`, 'TRADE');
    return { ok: true, orderId: simId, filled: qty, fee: simFee, avgPrice: price };
  }

  try {
    const body: any = { ticker, side, action, type: 'limit', count: qty };
    body[side === 'yes' ? 'yes_price' : 'no_price'] = price;
    const r = await api('POST', '/trade-api/v2/portfolio/orders', body);
    if (r?.order?.order_id) {
      const orderId = r.order.order_id;
      log(`${action.toUpperCase()} ${side.toUpperCase()} ${qty}x @ ${price}c (Order: ${orderId.slice(0,8)}...)`, 'TRADE');
      
      // Quick poll for immediate fill
      for (let i = 0; i < 3; i++) {
        await sleep(400);
        const st = await getOrderStatus(orderId);
        if (st) {
          if (st.status === 'canceled' || st.status === 'rejected') {
            log(`Order ${orderId.slice(0,8)}... ${st.status}`, 'WARN');
            return { ok: false, orderId, filled: 0 };
          }
          if (st.status === 'executed' || st.filled > 0) {
            const fee = st.fee || Math.round((st.cost || price * qty) * 0.025); // Estimate 2.5% fee if not provided
            log(`FILLED ${side.toUpperCase()} ${st.filled}x @ ${st.price}c | Fee: ${fee}c`, 'TRADE');
            return { ok: true, orderId, filled: st.filled, fee, avgPrice: st.price };
          }
        }
      }
      return { ok: true, orderId, filled: 0 }; // Resting
    }
  } catch (e: any) { 
    log(`Order failed: ${e.message}`, 'ERROR'); 
  }
  return { ok: false, orderId: '', filled: 0 };
}

// === ORDER MANAGEMENT ===
async function manageOpenOrders(state: State, ticker: string, minsToClose: number) {
  const now = Date.now();
  // Save filled order details BEFORE removing from array (bug fix: previously removed then searched)
  const filledDetails: { orderId: string; ticker: string; side: string; qty: number; type: 'tp' | 'sl'; fillPrice?: number; fee?: number }[] = [];

  // Check TP/SL orders
  for (const order of [...state.openTpOrders]) {
    if (order.ticker !== ticker) continue;

    const status = await getOrderStatus(order.orderId);

    if (!status || status.status === 'executed' || status.status === 'canceled') {
      if (status?.status === 'executed') {
        // Save details BEFORE removing from array
        filledDetails.push({
          orderId: order.orderId,
          ticker: order.ticker,
          side: order.side,
          qty: order.qty,
          type: order.type,
          fillPrice: status.price,
          fee: status.fee,
        });
        const typeStr = order.type === 'tp' ? 'TP' : 'SL';
        log(`${typeStr} ${order.orderId.slice(0,8)} filled! (${order.side.toUpperCase()} ${order.qty}x @ ${status.price || '?'}c)`, 'TRADE');

        // Compute and record PnL for passive fill
        const fillPrice = status.price || 0;
        const fee = status.fee || Math.round(fillPrice * order.qty * 0.025);
        // Find matching entry in positionTracker for entry price
        const posKey = `${order.ticker}_${order.side.toUpperCase()}`;
        const tracked = positionTracker.get(posKey);
        const entryPrice = tracked?.avgPrice || 0;
        const grossPnl = entryPrice > 0 ? (fillPrice - entryPrice) * order.qty : 0;
        const netPnl = grossPnl - fee;

        state.dailyPnl += netPnl;

        logTrade({
          timestamp: new Date().toISOString(),
          ticker: order.ticker,
          action: 'SELL',
          side: order.side.toUpperCase() as 'YES' | 'NO',
          qty: order.qty,
          price: fillPrice,
          reason: order.type === 'tp' ? 'TP_PASSIVE_FILL' : 'SL_PASSIVE_FILL',
          pnl: grossPnl,
          fee,
          btcPrice: btcPrices[btcPrices.length - 1]?.price,
          orderId: order.orderId,
          entryPrice,
        });

        // Check circuit breaker after passive fill loss
        if (state.dailyPnl <= -CONFIG.DAILY_LOSS_LIMIT_CENTS) {
          state.circuitBreaker = true;
          log(`CIRCUIT BREAKER triggered by passive fill — daily PnL: ${state.dailyPnl}c`, 'WARN');
          await notify(`🛑 CIRCUIT BREAKER — down $${Math.abs(state.dailyPnl / 100).toFixed(2)} (passive ${order.type.toUpperCase()} fill)`);
        }

        // Track consecutive losses for kill switch
        if (netPnl < 0) {
          state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
        } else {
          state.consecutiveLosses = 0;
        }

        await notify(`${order.type === 'tp' ? '💰' : '🛑'} ${typeStr} FILLED — ${order.side.toUpperCase()} ${order.qty}x @ ${fillPrice}c | Net: ${netPnl > 0 ? '+' : ''}${netPnl}c | Day: ${state.dailyPnl > 0 ? '+' : ''}${state.dailyPnl}c | ${order.ticker}`);
      }
      // Remove from tracking
      state.openTpOrders = state.openTpOrders.filter(o => o.orderId !== order.orderId);
      continue;
    }

    // Cancel on emergency (2 mins left)
    if (minsToClose <= CONFIG.EMERGENCY_EXIT_MINS) {
      log(`Cancelling emergency ${order.type.toUpperCase()} ${order.orderId.slice(0,8)} (mins: ${minsToClose.toFixed(1)})`, 'WARN');
      await cancelOrder(order.orderId);
      state.openTpOrders = state.openTpOrders.filter(o => o.orderId !== order.orderId);
    }
  }

  // Cancel opposite orders if one filled (using saved details, not the already-removed array entries)
  for (const filled of filledDetails) {
    const oppositeType = filled.type === 'tp' ? 'sl' : 'tp';
    const opposite = state.openTpOrders.find(o =>
      o.ticker === filled.ticker &&
      o.side === filled.side &&
      o.type === oppositeType
    );
    if (opposite) {
      log(`Cancelling opposite ${oppositeType.toUpperCase()} ${opposite.orderId.slice(0,8)} (paired ${filled.type.toUpperCase()} filled)`, 'INFO');
      await cancelOrder(opposite.orderId);
      state.openTpOrders = state.openTpOrders.filter(o => o.orderId !== opposite.orderId);
    }
  }

  saveState(state);
}

async function emergencySweep(state: State, ticker: string, book: any) {
  // Cancel all open orders and market sell any positions
  const openOrders = await getOpenOrders(ticker);
  for (const o of openOrders) {
    await cancelOrder(o.order_id);
  }
  state.openTpOrders = state.openTpOrders.filter(tp => tp.ticker !== ticker);
  
  // Market sell positions at bid
  const pos = await getPositions(ticker);
  for (const side of ['yes', 'no'] as const) {
    const p = pos[side];
    if (!p) continue;
    
    let bid = side === 'yes' ? book.yesBid : book.noBid;
    if (!bid || bid <= 0) bid = 1; // Fire sale
    
    const grossPnl = (bid - p.avg) * p.qty;
    const estFee = Math.round(bid * p.qty * 0.025); // 2.5% estimated fee
    const netPnl = grossPnl - estFee;
    
    log(`EMERGENCY SELL ${side.toUpperCase()} ${p.qty}x @ ${bid}c | Entry: ${p.avg}c | Gross: ${grossPnl}c | Fee: ${estFee}c | Net: ${netPnl}c`, 'TRADE');
    const result = await placeOrder(ticker, side, 'sell', bid, p.qty);
    
    const actualFee = result.fee || estFee;
    const actualNetPnl = grossPnl - actualFee;
    state.dailyPnl += actualNetPnl;
    
    logTrade({
      timestamp: new Date().toISOString(),
      ticker,
      action: 'SELL',
      side: side.toUpperCase() as 'YES' | 'NO',
      qty: p.qty,
      price: bid,
      reason: 'EMERGENCY_EXIT',
      pnl: grossPnl,
      fee: actualFee,
      btcPrice: btcPrices[btcPrices.length - 1]?.price,
      orderId: result.orderId,
      entryPrice: p.avg,
    });
    
    await notify(`🚨 EMERGENCY SELL ${side.toUpperCase()} ${p.qty}x @ ${bid}c (avg ${p.avg}c) | Net PnL: ${actualNetPnl > 0 ? '+' : ''}${actualNetPnl}c | <2min left`);
  }
  
  saveState(state);
}

// === CRASH HANDLER ===
let crashAlertSent = false;

async function alertCrash(reason: string) {
  if (crashAlertSent) return;
  crashAlertSent = true;
  
  const msg = `🚨 BOT CRASHED: ${reason}\nTime: ${new Date().toISOString()}\nCheck positions NOW!`;
  log(msg, 'ERROR');
  
  try {
    if (CONFIG.TELEGRAM_BOT_TOKEN) {
      await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: msg
      }, { timeout: 5000 });
    }
  } catch {}
}

process.on('uncaughtException', async (e) => {
  await alertCrash(`Uncaught Exception: ${e.message}`);
  process.exit(1);
});

process.on('unhandledRejection', async (e: any) => {
  await alertCrash(`Unhandled Rejection: ${e?.message || e}`);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await alertCrash('SIGTERM received - bot killed');
  process.exit(0);
});

process.on('SIGINT', async () => {
  await alertCrash('SIGINT received - bot interrupted');
  process.exit(0);
});

// === MAIN LOOP ===
async function run() {
  acquireLock();
  const dryTag = CONFIG.DRY_RUN ? ' [DRY RUN]' : '';
  await notify(`🚀 v14 VOLATILITY SCALPER STARTING${dryTag} — Monitoring active`);
  log(`=== SWING v14 VOLATILITY SCALPER STARTING${dryTag} ===`);
  log(`Dynamic sizing (Kelly/5% bal, max $5) | TP +${CONFIG.PROFIT_TARGET_CENTS}c | SL -${CONFIG.STOP_LOSS_CENTS}c | Triple WS (Kalshi+Kraken+Coinbase)`);
  log(`Entry range: ${CONFIG.MIN_ENTRY_PRICE}-${CONFIG.MAX_ENTRY_PRICE}c | Window: ${CONFIG.MIN_MINS_TO_EXPIRY}-${CONFIG.MAX_MINS_TO_EXPIRY}m | Emergency: ${CONFIG.EMERGENCY_EXIT_MINS}m`);
  log(`Kill switch: ${CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses | Signal threshold: ${CONFIG.MIN_SIGNAL_SCORE} | Chop filter: ${CONFIG.MIN_CHOP_PCT}%`);
  log(`Gates: stale=${CONFIG.STALE_PRICE_MS}ms | flash crash | slippage | regime filter | Kelly sizing`);
  await notify(`🚀 v14 VOLATILITY SCALPER started${dryTag} — Triple WS (Kalshi+Kraken+Coinbase) + safety gates`);

  // Initialize dual WebSocket feeds for real-time BTC prices
  initBtcWebSocket();
  
  // Initialize Kalshi WebSocket for real-time market data
  initKalshiWebSocket();
  
  // Load ML model
  loadMlModel();
  
  // Wait for initial price data
  log('Waiting for BTC price data...');
  for (let i = 0; i < 10 && btcPrices.length < 5; i++) {
    await sleep(1000);
  }
  if (btcPrices.length > 0) {
    log(`BTC price feed active: $${btcPrices[btcPrices.length - 1].price.toFixed(0)}`);
  }
  
  const state = loadState();

  // Clean stale orders from expired markets on startup
  await cleanStaleOrders(state);

  let lastTicker = '';

  // Watchdog Timer (Fix for hangs)
  let lastLoopTime = Date.now();
  setInterval(() => {
    if (Date.now() - lastLoopTime > 60000) {
      console.error('Watchdog: Loop stuck for 60s -> Exiting');
      process.exit(1); // Force restart by wrapper script
    }
  }, 10000); // Check every 10s
  
  while (true) {
    try {
      lastLoopTime = Date.now(); // Feed the watchdog
      
      const now = Date.now();
      
      // Circuit breaker check
      if (state.circuitBreaker) {
        log('Circuit breaker active — paused', 'WARN');
        await sleep(60000);
        continue;
      }
      
      // Balance check — halt trading if below floor or API failure
      const balance = await getBalance();
      if (balance === null) {
        log('Balance API failed — pausing trading for safety', 'ERROR');
        await sleep(30000);
        continue;
      }
      if (balance < CONFIG.BALANCE_FLOOR_CENTS) {
        log(`Balance $${(balance / 100).toFixed(2)} below floor $${(CONFIG.BALANCE_FLOOR_CENTS / 100).toFixed(2)} — HALTING`, 'ERROR');
        await notify(`🛑 BALANCE FLOOR HIT — $${(balance / 100).toFixed(2)} < $${(CONFIG.BALANCE_FLOOR_CENTS / 100).toFixed(2)} — trading stopped`);
        state.circuitBreaker = true;
        saveState(state);
        break;
      }
      
      // Find market
      const market = await findMarket();
      if (!market) {
        log('No valid market in window — waiting 10s', 'INFO');
        await sleep(10000);
        continue;
      }
      
      // New window?
      if (market.ticker !== lastTicker) {
        const btcNow = btcPrices.length ? `$${btcPrices[btcPrices.length - 1].price.toFixed(0)}` : 'waiting';
        log(`=== ${market.ticker} (${market.minsToClose.toFixed(1)}m) | BTC ${btcNow} | Bal: $${(balance/100).toFixed(2)} ===`);
        lastTicker = market.ticker;
        state.tradesThisWindow = 0;
        // Cancel and remove orders from OLD windows (keep only current ticker's orders)
        const oldOrders = state.openTpOrders.filter(tp => tp.ticker !== market.ticker);
        for (const old of oldOrders) {
          log(`Cleaning stale ${old.type.toUpperCase()} order from old window ${old.ticker}`, 'INFO');
          await cancelOrder(old.orderId).catch(() => {});
        }
        state.openTpOrders = state.openTpOrders.filter(tp => tp.ticker === market.ticker);
        saveState(state);
        
        // Switch WebSocket subscription to new market
        switchMarketSubscription(market.ticker);
      }
      
      const book = await getBook(market.ticker);
      if (!book) { await sleep(CONFIG.POLL_INTERVAL_MS); continue; }
      
      // Manage open orders (cancel stale TPs)
      await manageOpenOrders(state, market.ticker, market.minsToClose);
      
      // Emergency sweep if close to settlement
      if (market.minsToClose <= CONFIG.EMERGENCY_EXIT_MINS) {
        await emergencySweep(state, market.ticker, book);
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }
      
      const pos = await getPositions(market.ticker);
      const openOrders = await getOpenOrders(market.ticker);
      const hasOpen = openOrders.length > 0;
      
      // === STALE PRICE CHECK ===
      if (btcPrices.length === 0 || now - btcPrices[btcPrices.length - 1].ts > CONFIG.STALE_PRICE_MS) {
        if (!btcFeedStale) {
          btcFeedStale = true;
          log(`BTC price feed stale (>${CONFIG.STALE_PRICE_MS / 1000}s) — skipping entries`, 'WARN');
          if (now - lastStaleAlertTs > 300000) { // Alert cooldown: 5 min
            lastStaleAlertTs = now;
            await notify(`⚠️ BTC price feed stale — no data for ${CONFIG.STALE_PRICE_MS / 1000}s`);
          }
        }
      } else {
        if (btcFeedStale) {
          btcFeedStale = false;
          log('BTC price feed recovered', 'INFO');
        }
      }

      // === FLASH CRASH PROTECTION ===
      const flashCrash = btcPrices.length >= 2
        ? detectFlashCrash(btcPrices.map(p => ({ price: p.price, timestamp: p.ts })))
        : { halt: false, level: 0 as const, change: 0, reason: 'no data' };
      if (flashCrash.level >= 1) {
        log(`Flash crash detector: level=${flashCrash.level} | ${flashCrash.reason}`, 'WARN');
      }
      if (flashCrash.halt) {
        await notify(`🚨 FLASH CRASH HALT — ${flashCrash.reason}`);
        // Level 2+: cancel resting TP/SL orders (they'd fill at bad prices)
        if (flashCrash.level >= 2) {
          for (const order of [...state.openTpOrders]) {
            log(`Cancelling ${order.type.toUpperCase()} ${order.orderId.slice(0, 8)} (flash crash level ${flashCrash.level})`, 'WARN');
            await cancelOrder(order.orderId);
          }
          state.openTpOrders = [];
          saveState(state);
        }
      }

      // Get signal (Volatility + Mean Reversion)
      const signal = getSignal();
      
      // === CHECK EXITS ===
      for (const side of ['yes', 'no'] as const) {
        const p = pos[side];
        if (!p) continue;
        
        let bid = side === 'yes' ? book.yesBid : book.noBid;
        const ask = side === 'yes' ? book.yesAsk : book.noAsk;
        if (!bid || bid <= 0) {
          bid = ask;
          log(`No bid for ${side.toUpperCase()} — using ask ${ask}c for exit`, 'WARN');
        }
        const pnl = (bid - p.avg) * p.qty;
        const pnlPer = bid - p.avg;
        
        let exit = false, reason = '';
        
        // Time-based profit taking (v14.3)
        // > 8 min left: Hold for full target (+10c)
        // 5-8 min left: Take partial profit (+5c)
        // < 5 min left: Take ANY profit (>0c) to avoid emergency exit risk
        let dynamicTarget = CONFIG.PROFIT_TARGET_CENTS;
        if (market.minsToClose < 5) {
          dynamicTarget = 1; // Any profit > 0 (breakeven + 1c)
        } else if (market.minsToClose < 8) {
          dynamicTarget = 5; // Reduced target
        }
        
        // Only exit on profit target (hold through drawdowns)
        if (pnlPer >= dynamicTarget) {
          exit = true; reason = `TARGET +${pnlPer}c (${market.minsToClose.toFixed(1)}m left)`;
        }
        // NOTE: Stop loss removed - bot holds through drawdowns per strategy change
        
        if (exit) {
          const grossPnl = (bid - p.avg) * p.qty;
          const estFee = Math.round(bid * p.qty * 0.025);
          const netPnl = grossPnl - estFee;
          
          log(`EXIT ${side.toUpperCase()}: ${reason} | Entry: ${p.avg}c | Gross: ${grossPnl}c | EstFee: ${estFee}c`, 'TRADE');
          const result = await placeOrder(market.ticker, side, 'sell', bid, p.qty);
          
          if (result.ok) {
            const actualFee = result.fee || estFee;
            const actualNetPnl = grossPnl - actualFee;
            state.dailyPnl += actualNetPnl;
            saveState(state);

            // Track slippage on exit fill
            if (result.avgPrice) {
              logSlippage(market.ticker, side, bid, result.avgPrice);
            }

            logTrade({
              timestamp: new Date().toISOString(),
              ticker: market.ticker,
              action: 'SELL',
              side: side.toUpperCase() as 'YES' | 'NO',
              qty: p.qty,
              price: result.avgPrice || bid,
              reason,
              pnl: grossPnl,
              fee: actualFee,
              btcPrice: btcPrices[btcPrices.length - 1]?.price,
              momentum: signal.reason,
              orderId: result.orderId,
              entryPrice: p.avg,
            });
            
            // Find matching entry features and log ML completion
            let entryFeatures: any = null;
            for (const [key, value] of mlFeatures.entries()) {
              if (value.ticker === market.ticker && value.side === side.toUpperCase() && Math.abs(value.entryPrice - p.avg) < 2) {
                entryFeatures = value;
                mlFeatures.delete(key);
                break;
              }
            }
            
            if (entryFeatures) {
              const holdingTime = Date.now() - entryFeatures.entryTime;
              logMLFeatures({
                timestamp: new Date().toISOString(),
                ticker: market.ticker,
                action: 'SELL',
                side: side.toUpperCase() as 'YES' | 'NO',
                qty: p.qty,
                entryPrice: p.avg,
                exitPrice: bid,
                btcPrice: btcPrices[btcPrices.length - 1]?.price,
                btcVolatility5m: entryFeatures.btcVolatility5m,
                btcTrend30m: entryFeatures.btcTrend30m,
                spread: entryFeatures.spread,
                depthYes: entryFeatures.depthYes,
                depthNo: entryFeatures.depthNo,
                imbalance: entryFeatures.imbalance,
                minsToExpiry: market.minsToClose,
                timeOfDay: entryFeatures.timeOfDay,
                dayOfWeek: entryFeatures.dayOfWeek,
                signalReason: entryFeatures.signalReason,
                signalConfidence: entryFeatures.signalConfidence,
                volatilitySignal: entryFeatures.volatilitySignal,
                fee: actualFee,
                grossPnl: grossPnl,
                netPnl: actualNetPnl,
                exitReason: reason,
                holdingTimeMs: holdingTime,
                label: computeLabel(actualNetPnl),
              });
            }
            
            // Track consecutive losses for kill switch
            if (actualNetPnl < 0) {
              state.consecutiveLosses = (state.consecutiveLosses || 0) + 1;
            } else {
              state.consecutiveLosses = 0;
            }

            if (actualNetPnl > 0) {
              await notify(`✅ SOLD +${actualNetPnl}c net | ${side.toUpperCase()} ${p.qty}x @ ${bid}c | ${reason} | Day: ${state.dailyPnl > 0 ? '+' : ''}${state.dailyPnl}c | Bal: $${(balance/100).toFixed(2)}`);
            } else {
              await notify(`❌ SOLD ${actualNetPnl}c net | ${side.toUpperCase()} ${p.qty}x @ ${bid}c | ${reason} | Day: ${state.dailyPnl > 0 ? '+' : ''}${state.dailyPnl}c | Bal: $${(balance/100).toFixed(2)}`);
              if (state.dailyPnl <= -CONFIG.DAILY_LOSS_LIMIT_CENTS) {
                state.circuitBreaker = true;
                await notify(`🛑 CIRCUIT BREAKER — down $${Math.abs(state.dailyPnl/100).toFixed(2)}`);
              }
              if (state.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
                state.circuitBreaker = true;
                log(`KILL SWITCH: ${state.consecutiveLosses} consecutive losses`, 'WARN');
                await notify(`🛑 KILL SWITCH — ${state.consecutiveLosses} consecutive losses — trading halted`);
              }
            }
          }
        } else {
          const sign = pnlPer >= 0 ? '+' : '';
          const btcNow = btcPrices.length ? btcPrices[btcPrices.length - 1].price.toFixed(0) : '?';
          log(`HOLD ${side.toUpperCase()} ${p.qty}x @ ${p.avg}c → ${bid}c (${sign}${pnlPer}c) | BTC $${btcNow} | Bal: $${(balance/100).toFixed(2)} | ${market.minsToClose.toFixed(1)}m left`);
        }
      }
      
      // === CHECK ENTRIES ===
      // Skip if we have open orders or positions
      if (hasOpen || pos.yes || pos.no) {
        log(`Book: Y${book.yesBid}/${book.yesAsk} N${book.noBid}/${book.noAsk} | Bal: $${(balance/100).toFixed(2)} | Sig: ${signal.side} (${signal.reason})`);
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      if (state.tradesThisWindow >= CONFIG.MAX_TRADES_PER_WINDOW) {
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }
      
      if (now - state.lastTradeTime < CONFIG.ENTRY_COOLDOWN_MS) {
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }
      
      // Check signal
      if (signal.side === 'SKIP') {
        log(`Skip: ${signal.reason}`, 'INFO');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // === ENTRY GATE: Stale price ===
      if (btcFeedStale) {
        log('Skip entry: BTC feed stale', 'WARN');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // === ENTRY GATE: Flash crash ===
      if (flashCrash.halt) {
        log(`Skip entry: flash crash halt (level ${flashCrash.level})`, 'WARN');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // === ENTRY GATE: Volatility regime ===
      const regime = classifyRegime();
      log(`Regime: ${regime.regime} | ${regime.reason}`, 'INFO');
      if (!regime.canTrade) {
        log(`Skip entry: regime=${regime.regime} — ${regime.reason}`, 'INFO');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // === ENTRY GATE: Slippage pause ===
      if (shouldPauseForSlippage()) {
        log('Skip entry: slippage too high (>5c avg over last 5 fills)', 'WARN');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      const preferredSide = signal.side === 'YES' ? 'yes' : 'no';
      const ask = preferredSide === 'yes' ? book.yesAsk : book.noAsk;
      const bid = preferredSide === 'yes' ? book.yesBid : book.noBid;
      const depth = preferredSide === 'yes' ? book.yesDepth : book.noDepth;
      
      // Check entry conditions
      const spread = ask - bid;
      if (ask < CONFIG.MIN_ENTRY_PRICE || ask > CONFIG.MAX_ENTRY_PRICE) {
        log(`Skip: ${preferredSide.toUpperCase()} ask ${ask}c outside range`, 'INFO');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }
      
      if (spread > CONFIG.MAX_ENTRY_SPREAD_CENTS) {
        log(`Skip: Spread ${spread}c too wide (max ${CONFIG.MAX_ENTRY_SPREAD_CENTS}c)`, 'INFO');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }
      
      if (depth < CONFIG.MIN_DEPTH) {
        log(`Skip: ${preferredSide.toUpperCase()} depth ${depth} too thin`, 'INFO');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }
      
      // Dynamic position sizing: Kelly or fixed 5% of balance
      let baseTradeCents = Math.min(
        Math.max(Math.floor(balance * CONFIG.TRADE_SIZE_PCT), CONFIG.MIN_TRADE_CENTS),
        CONFIG.MAX_TRADE_CENTS
      );

      // Kelly sizing: use if enough data, else fall back to fixed
      const kelly = calculateKellySizing(ask, preferredSide);
      let tradeSize = baseTradeCents;
      if (kelly.confidence >= 0.3) {
        tradeSize = applyKellySizing(baseTradeCents, kelly);
        log(`Kelly: fraction=${kelly.fraction.toFixed(2)} edge=${kelly.edge.toFixed(3)} confidence=${kelly.confidence.toFixed(2)} → size=${tradeSize}c (base=${baseTradeCents}c)`, 'INFO');
      } else {
        log(`Kelly: low confidence (${kelly.confidence.toFixed(2)}) — using fixed ${baseTradeCents}c`, 'INFO');
      }

      const qty = Math.floor(tradeSize / ask);

      if (qty <= 0) {
        log(`Skip: qty=0 (size=${tradeSize}c, ask=${ask}c)`, 'INFO');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }

      // Entry price: midpoint adjusted for slippage
      const rawLimit = Math.floor((bid + ask) / 2);
      const limit = adjustEntryForSlippage(rawLimit, preferredSide);
      
      // Calculate BTC trends for ML features
      const btcTrends = calculateBTCTrends(btcPrices);
      const imbalance = getOrderbookImbalance(book);
      const nowDate = new Date();
      
      // Build ML feature set
      const mlFeatureSet: MLFeatures = {
        entryPrice: limit,
        btcPrice: btcPrices[btcPrices.length - 1]?.price || 0,
        btcVolatility5m: btcTrends.volatility5m,
        btcTrend30m: btcTrends.trend30m,
        spread,
        depthYes: book.yesDepth,
        depthNo: book.noDepth,
        imbalance: imbalance.imbalance,
        minsToExpiry: market.minsToClose,
        timeOfDay: nowDate.getHours(),
        dayOfWeek: nowDate.getDay(),
        signalConfidence: signal.confidence,
        volatilitySignal: parseFloat(signal.reason.match(/[\d.]+/)?.[0] || '0'),
      };
      
      // ML Prediction
      const mlResult = mlPredict(mlFeatureSet);
      
      if (CONFIG.USE_ML_FILTER && !mlResult.shouldEnter) {
        log(`Skip: ML filter rejected (confidence: ${mlResult.confidence.toFixed(2)})`, 'INFO');
        await sleep(CONFIG.POLL_INTERVAL_MS);
        continue;
      }
      
      log(`Book: Y${book.yesBid}/${book.yesAsk} N${book.noBid}/${book.noAsk} | Bal: $${(balance/100).toFixed(2)} | Sig: ${signal.side} (${signal.reason})`);
      log(`ENTRY ${preferredSide.toUpperCase()} ${qty}x @ ${limit}c (${signal.reason}) | Regime: ${regime.regime} | ML: ${mlResult.confidence.toFixed(2)}`, 'TRADE');

      const entryRes = await placeOrder(market.ticker, preferredSide, 'buy', limit, qty);

      if (entryRes.ok) {
        const entryFee = entryRes.fee || Math.round(limit * qty * 0.025);

        // Track slippage on entry fill
        if (entryRes.avgPrice) {
          logSlippage(market.ticker, preferredSide, limit, entryRes.avgPrice);
        }

        state.tradesThisWindow++;
        state.lastTradeTime = now;
        saveState(state);
        
        logTrade({
          timestamp: new Date().toISOString(),
          ticker: market.ticker,
          action: 'BUY',
          side: preferredSide.toUpperCase() as 'YES' | 'NO',
          qty,
          price: entryRes.avgPrice || limit,
          reason: signal.reason,
          btcPrice: btcPrices[btcPrices.length - 1]?.price,
          momentum: signal.reason,
          fee: entryFee,
          orderId: entryRes.orderId,
        });
        
        // Log rich ML features
        logMLFeatures({
          timestamp: new Date().toISOString(),
          ticker: market.ticker,
          action: 'BUY',
          side: preferredSide.toUpperCase() as 'YES' | 'NO',
          qty,
          entryPrice: entryRes.avgPrice || limit,
          btcPrice: mlFeatureSet.btcPrice,
          btcVolatility5m: mlFeatureSet.btcVolatility5m,
          btcTrend30m: mlFeatureSet.btcTrend30m,
          spread: mlFeatureSet.spread,
          depthYes: mlFeatureSet.depthYes,
          depthNo: mlFeatureSet.depthNo,
          imbalance: mlFeatureSet.imbalance,
          minsToExpiry: mlFeatureSet.minsToExpiry,
          timeOfDay: mlFeatureSet.timeOfDay,
          dayOfWeek: mlFeatureSet.dayOfWeek,
          signalReason: signal.reason,
          signalConfidence: mlFeatureSet.signalConfidence,
          volatilitySignal: mlFeatureSet.volatilitySignal,
          fee: entryFee,
        });
        
        // Store features for later SELL matching
        mlFeatures.set(entryRes.orderId, {
          ...mlFeatureSet,
          entryTime: Date.now(),
          ticker: market.ticker,
          side: preferredSide.toUpperCase(),
          qty,
          entryPrice: entryRes.avgPrice || limit,
          fee: entryFee,
        });
        
        const btcEntry = btcPrices.length ? btcPrices[btcPrices.length - 1].price.toFixed(0) : '?';
        await notify(`🎯 BUY ${preferredSide.toUpperCase()} ${qty}x @ ${entryRes.avgPrice || limit}c (fee: ${entryFee}c) | ${signal.reason} | BTC $${btcEntry} | Bal: $${(balance/100).toFixed(2)}`);

        // Place take-profit limit immediately
        const tpPrice = Math.min(99, limit + CONFIG.PROFIT_TARGET_CENTS);
        const tp = await placeOrder(market.ticker, preferredSide, 'sell', tpPrice, qty);
        if (tp.ok && tp.orderId) {
          log(`TP placed ${preferredSide.toUpperCase()} ${qty}x @ ${tpPrice}c`, 'INFO');
          state.openTpOrders.push({
            orderId: tp.orderId,
            placedAt: now,
            ticker: market.ticker,
            side: preferredSide,
            qty,
            type: 'tp',
          });
          saveState(state);
        }
        
        // NOTE: Stop-loss removed for hold-through strategy
        // Bot will hold through drawdowns and only exit on:
        // 1. TP hit (+10¢)
        // 2. Emergency at 3 min to expiry (if underwater)
        
        await notify(`🎯 TP PLACED — Target: ${tpPrice}c | Hold through drawdowns | Emergency at 3min`);
      }
      
      await sleep(CONFIG.POLL_INTERVAL_MS);
      
    } catch (e: any) {
      log(`Error: ${e.message}`, 'ERROR');
      await sleep(10000);
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

run().catch(e => { log(`FATAL: ${e.message}`, 'ERROR'); process.exit(1); });
