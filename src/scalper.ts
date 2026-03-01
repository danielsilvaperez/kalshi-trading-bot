/**
 * SCALPER v4 — Production Trading System
 * Primary strategy for KXBTC15M markets
 * 
 * v4 Changes:
 * - Fill tracking & verification
 * - Window-aware sizing (aggressive early, conservative late)
 * - Wider price range (12-88c)
 * - Better duplicate process prevention
 * - Faster polling (2.5s)
 */

import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Trade sizing (larger to reduce fee impact)
  BASE_TRADE_SIZE_CENTS: 200,      // $2 base (was $1)
  MAX_POSITION_PER_SIDE: 600,      // $6 max per side
  MIN_TRADE_SIZE_CENTS: 100,       // $1 min
  
  // Entry conditions
  MIN_SPREAD_CENTS: 3,             // Need 3c+ spread (was 2c)
  MIN_ENTRY_PRICE: 12,
  MAX_ENTRY_PRICE: 60,             // Lowered from 65
  MIN_DEPTH: 3,
  MAX_POSITION_QTY: 4,
  LATE_WINDOW_CUTOFF_MINS: 7,      // Raised from 6
  
  // Exit conditions (fee-aware)
  // Kalshi fee = 0.5% per trade = 1c on $2 trade
  // Need 4c+ gross profit to make 2c+ net
  PROFIT_TARGET_CENTS: 4,          // Was 3
  STOP_LOSS_CENTS: 8,
  TRAILING_ACTIVATION: 5,
  TRAILING_DISTANCE: 2,
  
  // Timing
  POLL_INTERVAL_MS: 3000,          // Slightly slower (was 2500)
  ORDER_TIMEOUT_MS: 20000,
  MIN_MINS_TO_EXPIRY: 2.5,
  MAX_MINS_TO_EXPIRY: 15,
  ENTRY_COOLDOWN_MS: 10000,        // 10s between entries
  
  // Window multipliers
  EARLY_WINDOW_MULTIPLIER: 1.0,    // Normal (was 1.2)
  MID_WINDOW_MULTIPLIER: 0.8,      // Smaller mid-window
  LATE_WINDOW_MULTIPLIER: 0.5,     // Much smaller late
  
  // Risk limits (tighter)
  DAILY_LOSS_LIMIT_CENTS: 300,     // $3 max daily loss (was $4)
  BALANCE_FLOOR_CENTS: 400,        // $4 floor (was $2.50)
  MAX_CONSECUTIVE_LOSSES: 3,       // Faster circuit breaker (was 4)
  LOSS_SCALE_FACTOR: 0.6,          // Aggressive size reduction (was 0.75)
  
  // Momentum
  PRICE_HISTORY_SIZE: 6,
  MOMENTUM_THRESHOLD: 2,
  
  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '8208882081',
  
  // Files
  STATE_FILE: './tmp/scalper-state.json',
  LOG_FILE: './logs/scalper.log',
  LOCK_FILE: './tmp/scalper.lock',
  PID_FILE: './tmp/scalper.pid',
};

// ============================================================================
// AUTH & API
// ============================================================================

const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';

if (!keyId || !pem) {
  console.error('FATAL: Missing KALSHI_KEY_ID or KALSHI_PRIVATE_KEY_PEM');
  process.exit(1);
}

function sign(method: string, path: string): Record<string, string> {
  const ts = String(Date.now());
  const msg = `${ts}${method}${path.split('?')[0]}`;
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign(
      { key: pem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      'base64'
    ),
  };
}

async function apiGet(path: string): Promise<any> {
  const resp = await axios.get(`${base}${path}`, { headers: sign('GET', path), timeout: 8000 });
  return resp.data;
}

async function apiPost(path: string, data: any): Promise<any> {
  const resp = await axios.post(`${base}${path}`, data, {
    headers: { ...sign('POST', path), 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  return resp.data;
}

async function apiDelete(path: string): Promise<any> {
  const resp = await axios.delete(`${base}${path}`, { headers: sign('DELETE', path), timeout: 8000 });
  return resp.data;
}

// ============================================================================
// STATE
// ============================================================================

interface PricePoint { price: number; ts: number; }

interface PendingOrder {
  orderId: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  price: number;
  count: number;
  placedAt: number;
}

interface DailyStats {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  pnlCents: number;
  feesCents: number;          // Track fees separately
  consecutiveLosses: number;
  consecutiveWins: number;    // Track win streaks
  grossVolume: number;
}

interface ScalperState {
  lastEntryTime: { yes: number; no: number };
  priceHistory: { yes: PricePoint[]; no: PricePoint[] };
  pendingOrders: PendingOrder[];
  daily: DailyStats;
  circuitBreakerTripped: boolean;
  currentSizeMultiplier: number;
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function freshDailyStats(): DailyStats {
  return { date: getToday(), trades: 0, wins: 0, losses: 0, pnlCents: 0, feesCents: 0, consecutiveLosses: 0, consecutiveWins: 0, grossVolume: 0 };
}

function loadState(): ScalperState {
  const defaultState: ScalperState = {
    lastEntryTime: { yes: 0, no: 0 },
    priceHistory: { yes: [], no: [] },
    pendingOrders: [],
    daily: freshDailyStats(),
    circuitBreakerTripped: false,
    currentSizeMultiplier: 1.0,
  };
  
  try {
    if (existsSync(CONFIG.STATE_FILE)) {
      const saved = JSON.parse(readFileSync(CONFIG.STATE_FILE, 'utf8'));
      if (saved.daily?.date !== getToday()) {
        saved.daily = freshDailyStats();
        saved.circuitBreakerTripped = false;
        saved.currentSizeMultiplier = 1.0;
      }
      return { ...defaultState, ...saved };
    }
  } catch { }
  return defaultState;
}

function saveState(state: ScalperState): void {
  try {
    const dir = dirname(CONFIG.STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2));
  } catch { }
}

// ============================================================================
// LOGGING & NOTIFICATIONS
// ============================================================================

function log(msg: string, level: 'INFO' | 'TRADE' | 'WARN' | 'ERROR' = 'INFO'): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  try {
    const dir = dirname(CONFIG.LOG_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(CONFIG.LOG_FILE, line + '\n');
  } catch { }
}

async function notify(msg: string): Promise<void> {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: `🤖 ${msg}`,
    }, { timeout: 5000 });
  } catch { }
}

// ============================================================================
// MARKET DATA
// ============================================================================

interface Market { ticker: string; closeTime: number; minsToClose: number; }

interface Orderbook {
  yesBid: number; yesAsk: number; noBid: number; noAsk: number;
  yesSpread: number; noSpread: number; yesDepth: number; noDepth: number;
}

interface Position { ticker: string; side: 'yes' | 'no'; qty: number; avgCost: number; exposure: number; }

async function findCurrentMarket(): Promise<Market | null> {
  try {
    const data = await apiGet('/trade-api/v2/markets?status=open&limit=50&series_ticker=KXBTC15M');
    const markets = (data?.markets ?? []) as any[];
    const now = Date.now();
    
    const valid = markets
      .map((m: any) => ({
        ticker: m.ticker,
        closeTime: new Date(m.close_time).getTime(),
        minsToClose: (new Date(m.close_time).getTime() - now) / 60000,
      }))
      .filter((m) => m.minsToClose > CONFIG.MIN_MINS_TO_EXPIRY && m.minsToClose < CONFIG.MAX_MINS_TO_EXPIRY)
      .sort((a, b) => a.closeTime - b.closeTime);
    
    return valid[0] || null;
  } catch (e: any) {
    log(`Market lookup failed: ${e.message}`, 'ERROR');
    return null;
  }
}

async function getOrderbook(ticker: string): Promise<Orderbook | null> {
  try {
    const data = await apiGet(`/trade-api/v2/markets/${ticker}/orderbook`);
    const ob = data?.orderbook ?? {};
    const yesBook = ob.yes || [];
    const noBook = ob.no || [];
    
    const yesBid = yesBook.length > 0 ? Math.max(...yesBook.map((l: any) => l[0] ?? 0)) : 0;
    const noBid = noBook.length > 0 ? Math.max(...noBook.map((l: any) => l[0] ?? 0)) : 0;
    const yesAsk = noBid > 0 ? 100 - noBid : 99;
    const noAsk = yesBid > 0 ? 100 - yesBid : 99;
    
    const yesDepth = yesBook.filter((l: any) => l[0] === yesBid).reduce((s: number, l: any) => s + (l[1] ?? 0), 0);
    const noDepth = noBook.filter((l: any) => l[0] === noBid).reduce((s: number, l: any) => s + (l[1] ?? 0), 0);
    
    return { yesBid, yesAsk, noBid, noAsk, yesSpread: yesAsk - yesBid, noSpread: noAsk - noBid, yesDepth, noDepth };
  } catch (e: any) {
    log(`Orderbook failed: ${e.message}`, 'ERROR');
    return null;
  }
}

async function getBalance(): Promise<number> {
  try {
    const data = await apiGet('/trade-api/v2/portfolio/balance');
    return data?.balance?.available_cash ?? data?.balance ?? 0;
  } catch { return 0; }
}

async function getPositions(ticker: string): Promise<{ yes: Position | null; no: Position | null }> {
  try {
    const data = await apiGet('/trade-api/v2/portfolio/positions');
    const positions = data?.positions ?? data?.market_positions ?? [];
    let yes: Position | null = null;
    let no: Position | null = null;
    
    for (const p of positions) {
      if (p.ticker !== ticker) continue;
      const qty = p.position ?? 0;
      if (qty === 0) continue;
      const absQty = Math.abs(qty);
      const exposure = Math.abs(p.market_exposure ?? 0);
      const avgCost = absQty > 0 ? Math.round(exposure / absQty) : 0;
      
      if (qty > 0) yes = { ticker, side: 'yes', qty: absQty, avgCost, exposure };
      else no = { ticker, side: 'no', qty: absQty, avgCost, exposure };
    }
    return { yes, no };
  } catch { return { yes: null, no: null }; }
}

async function getOpenOrders(ticker: string): Promise<any[]> {
  try {
    const data = await apiGet('/trade-api/v2/portfolio/orders?status=resting');
    return (data?.orders ?? []).filter((o: any) => o.ticker === ticker);
  } catch { return []; }
}

async function getOrderStatus(orderId: string): Promise<{ filled: number; status: string } | null> {
  try {
    const data = await apiGet(`/trade-api/v2/portfolio/orders/${orderId}`);
    return { filled: data?.order?.filled_count ?? 0, status: data?.order?.status ?? 'unknown' };
  } catch { return null; }
}

// ============================================================================
// ORDER EXECUTION
// ============================================================================

async function placeOrder(
  ticker: string, side: 'yes' | 'no', action: 'buy' | 'sell', price: number, count: number
): Promise<{ ok: boolean; orderId?: string; filled?: number; error?: string }> {
  try {
    const body: any = { ticker, side, action, type: 'limit', count };
    body[side === 'yes' ? 'yes_price' : 'no_price'] = price;
    
    const data = await apiPost('/trade-api/v2/portfolio/orders', body);
    const order = data?.order;
    
    if (order?.order_id) {
      const cost = (price * count / 100).toFixed(2);
      log(`ORDER: ${action.toUpperCase()} ${side.toUpperCase()} ${count}x @ ${price}c ($${cost}) → ${order.order_id}`, 'TRADE');
      return { ok: true, orderId: order.order_id, filled: order.filled_count ?? 0 };
    }
    return { ok: false, error: 'No order ID' };
  } catch (e: any) {
    const msg = e?.response?.data?.message ?? e?.message ?? 'Unknown';
    log(`ORDER FAILED: ${msg}`, 'ERROR');
    return { ok: false, error: msg };
  }
}

async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    await apiDelete(`/trade-api/v2/portfolio/orders/${orderId}`);
    log(`CANCELLED: ${orderId}`, 'TRADE');
    return true;
  } catch { return false; }
}

async function cancelStaleOrders(state: ScalperState, ticker: string): Promise<number> {
  const orders = await getOpenOrders(ticker);
  const now = Date.now();
  let cancelled = 0;
  
  for (const order of orders) {
    const age = now - new Date(order.created_time).getTime();
    if (age > CONFIG.ORDER_TIMEOUT_MS) {
      if (await cancelOrder(order.order_id)) cancelled++;
    }
  }
  
  // Check pending orders for fills
  const newPending: PendingOrder[] = [];
  for (const po of state.pendingOrders) {
    if (po.ticker !== ticker) { newPending.push(po); continue; }
    
    const status = await getOrderStatus(po.orderId);
    if (!status) { newPending.push(po); continue; }
    
    if (status.status === 'resting' && (now - po.placedAt) < CONFIG.ORDER_TIMEOUT_MS) {
      newPending.push(po);
    } else if (status.filled > 0) {
      log(`FILLED: ${po.side.toUpperCase()} ${status.filled}/${po.count}x @ ${po.price}c`, 'TRADE');
    }
  }
  state.pendingOrders = newPending;
  
  return cancelled;
}

// ============================================================================
// MOMENTUM
// ============================================================================

function updatePriceHistory(state: ScalperState, side: 'yes' | 'no', price: number): void {
  const history = state.priceHistory[side];
  history.push({ price, ts: Date.now() });
  while (history.length > CONFIG.PRICE_HISTORY_SIZE) history.shift();
}

function getMomentum(state: ScalperState, side: 'yes' | 'no'): { direction: 'up' | 'down' | 'flat'; strength: number } {
  const history = state.priceHistory[side];
  if (history.length < 3) return { direction: 'flat', strength: 0 };
  
  const recent = history.slice(-3);
  const change = recent[recent.length - 1].price - recent[0].price;
  
  if (change >= CONFIG.MOMENTUM_THRESHOLD) return { direction: 'up', strength: change };
  if (change <= -CONFIG.MOMENTUM_THRESHOLD) return { direction: 'down', strength: Math.abs(change) };
  return { direction: 'flat', strength: Math.abs(change) };
}

function shouldEnterOnMomentum(side: 'yes' | 'no', momentum: { direction: string; strength: number }): boolean {
  if (momentum.direction === 'flat') return true;
  if (momentum.strength < CONFIG.MOMENTUM_THRESHOLD) return true;
  if (side === 'yes' && momentum.direction === 'down') return false;
  if (side === 'no' && momentum.direction === 'down') return false;
  return true;
}

// ============================================================================
// TRADING LOGIC
// ============================================================================

function getWindowMultiplier(minsToClose: number): number {
  if (minsToClose >= 10) return CONFIG.EARLY_WINDOW_MULTIPLIER;
  if (minsToClose >= 5) return CONFIG.MID_WINDOW_MULTIPLIER;
  return CONFIG.LATE_WINDOW_MULTIPLIER;
}

function calculateTradeSize(state: ScalperState, price: number, minsToClose: number): number {
  const windowMult = getWindowMultiplier(minsToClose);
  const baseSize = CONFIG.BASE_TRADE_SIZE_CENTS * state.currentSizeMultiplier * windowMult;
  const adjusted = Math.max(CONFIG.MIN_TRADE_SIZE_CENTS, Math.round(baseSize));
  return Math.max(1, Math.floor(adjusted / price));
}

async function checkExits(
  state: ScalperState, ticker: string, book: Orderbook, 
  positions: { yes: Position | null; no: Position | null }
): Promise<void> {
  for (const side of ['yes', 'no'] as const) {
    const pos = positions[side];
    if (!pos || pos.qty === 0) continue;
    
    const exitBid = side === 'yes' ? book.yesBid : book.noBid;
    const pnlPerContract = exitBid - pos.avgCost;
    const totalPnl = pnlPerContract * pos.qty;
    
    let shouldExit = false;
    let reason = '';
    
    // Dynamic profit target based on entry price (cheaper entries = smaller targets)
    const profitTarget = pos.avgCost <= 30 ? 3 : pos.avgCost <= 50 ? 4 : 5;
    const stopLoss = pos.avgCost <= 30 ? 6 : pos.avgCost <= 50 ? 7 : 8;
    
    if (pnlPerContract >= profitTarget) {
      shouldExit = true;
      reason = `PROFIT +${totalPnl}c`;
    } else if (pnlPerContract <= -stopLoss) {
      shouldExit = true;
      reason = `STOP ${totalPnl}c`;
    } else if (pnlPerContract >= CONFIG.TRAILING_ACTIVATION) {
      const history = state.priceHistory[side];
      if (history.length > 0) {
        const highPrice = Math.max(...history.map(p => p.price));
        if (exitBid <= highPrice - CONFIG.TRAILING_DISTANCE && highPrice > pos.avgCost + CONFIG.TRAILING_ACTIVATION) {
          shouldExit = true;
          reason = `TRAIL +${totalPnl}c`;
        }
      }
    }
    
    if (shouldExit) {
      // Calculate fees: 0.5% per trade = 1% round trip
      const entryNotional = pos.qty * pos.avgCost;
      const exitNotional = pos.qty * exitBid;
      const fees = Math.round((entryNotional + exitNotional) * 0.005);  // 0.5% each side
      const netPnl = totalPnl - fees;
      
      log(`EXIT ${side.toUpperCase()} ${pos.qty}x: ${reason} (fees: ${fees}c, net: ${netPnl}c)`, 'TRADE');
      const result = await placeOrder(ticker, side, 'sell', exitBid, pos.qty);
      
      if (result.ok) {
        state.daily.trades++;
        state.daily.grossVolume += pos.qty * exitBid;
        state.daily.feesCents += fees;
        
        if (netPnl > 0) {
          state.daily.wins++;
          state.daily.consecutiveLosses = 0;
          state.daily.consecutiveWins++;
          // Scale up on win streaks (cap at 1.5x)
          const winBonus = Math.min(0.3, state.daily.consecutiveWins * 0.1);
          state.currentSizeMultiplier = Math.min(1.5, state.currentSizeMultiplier + 0.1 + winBonus);
          await notify(`✅ +${netPnl}c ${side.toUpperCase()} (fees: ${fees}c) | ${state.daily.wins}W/${state.daily.losses}L | Streak: ${state.daily.consecutiveWins}🔥`);
        } else {
          state.daily.losses++;
          state.daily.consecutiveLosses++;
          state.daily.consecutiveWins = 0;
          state.currentSizeMultiplier *= CONFIG.LOSS_SCALE_FACTOR;
          await notify(`❌ ${netPnl}c ${side.toUpperCase()} (fees: ${fees}c) | Loss streak: ${state.daily.consecutiveLosses}`);
        }
        state.daily.pnlCents += netPnl;
        
        if (state.daily.consecutiveLosses >= CONFIG.MAX_CONSECUTIVE_LOSSES) {
          state.circuitBreakerTripped = true;
          await notify(`🛑 Circuit breaker! ${state.daily.consecutiveLosses} losses`);
        }
      }
    } else {
      log(`POS: ${side.toUpperCase()} ${pos.qty}x @ ${pos.avgCost}c → ${exitBid}c (${pnlPerContract >= 0 ? '+' : ''}${pnlPerContract}c)`);
    }
  }
}

async function checkEntries(
  state: ScalperState, ticker: string, book: Orderbook, market: Market,
  positions: { yes: Position | null; no: Position | null }
): Promise<void> {
  const now = Date.now();
  const balance = await getBalance();
  
  if (state.circuitBreakerTripped) return;
  if (balance < CONFIG.BALANCE_FLOOR_CENTS) return;
  if (state.daily.pnlCents <= -CONFIG.DAILY_LOSS_LIMIT_CENTS) return;
  
  updatePriceHistory(state, 'yes', book.yesBid);
  updatePriceHistory(state, 'no', book.noBid);
  
  const yesExp = positions.yes?.exposure ?? 0;
  const noExp = positions.no?.exposure ?? 0;
  
  log(`Book: Y${book.yesBid}/${book.yesAsk} N${book.noBid}/${book.noAsk} | Exp: Y$${(yesExp/100).toFixed(2)} N$${(noExp/100).toFixed(2)} | ${market.minsToClose.toFixed(1)}m | $${(balance/100).toFixed(2)}`);
  
  for (const side of ['yes', 'no'] as const) {
    const askPrice = side === 'yes' ? book.yesAsk : book.noAsk;
    const spread = side === 'yes' ? book.yesSpread : book.noSpread;
    const depth = side === 'yes' ? book.yesDepth : book.noDepth;
    const exposure = side === 'yes' ? yesExp : noExp;
    const lastEntry = state.lastEntryTime[side];
    
    // Check pending orders for this side
    const hasPending = state.pendingOrders.some(o => o.ticker === ticker && o.side === side && o.action === 'buy');
    if (hasPending) continue;
    
    if (now - lastEntry < CONFIG.ENTRY_COOLDOWN_MS) continue;
    if (askPrice < CONFIG.MIN_ENTRY_PRICE || askPrice > CONFIG.MAX_ENTRY_PRICE) continue;
    if (spread < CONFIG.MIN_SPREAD_CENTS) continue;
    if (depth < CONFIG.MIN_DEPTH) continue;
    
    const momentum = getMomentum(state, side);
    if (!shouldEnterOnMomentum(side, momentum)) {
      log(`SKIP ${side.toUpperCase()}: momentum ${momentum.direction}`, 'INFO');
      continue;
    }
    
    const qty = calculateTradeSize(state, askPrice, market.minsToClose);
    const newExposure = exposure + qty * askPrice;
    
    if (newExposure > CONFIG.MAX_POSITION_PER_SIDE) continue;
    const currentPos = positions[side];
    if (currentPos && currentPos.qty >= CONFIG.MAX_POSITION_QTY) continue;
    if (market.minsToClose < CONFIG.LATE_WINDOW_CUTOFF_MINS && side === 'no') continue;
    if (qty * askPrice > balance) continue;
    
    const bidPrice = side === 'yes' ? book.yesBid : book.noBid;
    const limitPrice = Math.floor((bidPrice + askPrice) / 2);
    
    log(`ENTRY ${side.toUpperCase()} ${qty}x @ ${limitPrice}c (spread ${spread}c)`, 'TRADE');
    const result = await placeOrder(ticker, side, 'buy', limitPrice, qty);
    
    if (result.ok) {
      state.lastEntryTime[side] = now;
      state.pendingOrders.push({
        orderId: result.orderId!,
        ticker, side, action: 'buy',
        price: limitPrice, count: qty, placedAt: now,
      });
      state.daily.grossVolume += qty * limitPrice;
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function runLoop(): Promise<void> {
  log('=== SCALPER v4 STARTING ===');
  log(`Config: $${CONFIG.BASE_TRADE_SIZE_CENTS/100} base, ${CONFIG.PROFIT_TARGET_CENTS}c profit, ${CONFIG.STOP_LOSS_CENTS}c stop, ${CONFIG.POLL_INTERVAL_MS}ms poll`);
  
  const state = loadState();
  await notify(`🚀 Scalper v4 | Day: $${(state.daily.pnlCents/100).toFixed(2)}`);
  
  let lastTicker = '';
  let errorCount = 0;
  
  while (true) {
    try {
      const market = await findCurrentMarket();
      
      if (!market) {
        log('No market — waiting');
        await sleep(8000);
        continue;
      }
      
      if (market.ticker !== lastTicker) {
        log(`=== MARKET: ${market.ticker} (${market.minsToClose.toFixed(1)}m) ===`);
        lastTicker = market.ticker;
        state.priceHistory = { yes: [], no: [] };
      }
      
      const book = await getOrderbook(market.ticker);
      if (!book) { await sleep(CONFIG.POLL_INTERVAL_MS); continue; }
      
      await cancelStaleOrders(state, market.ticker);
      const positions = await getPositions(market.ticker);
      await checkExits(state, market.ticker, book, positions);
      await checkEntries(state, market.ticker, book, market, positions);
      
      saveState(state);
      errorCount = 0;
      await sleep(CONFIG.POLL_INTERVAL_MS);
      
    } catch (e: any) {
      errorCount++;
      log(`ERROR: ${e.message}`, 'ERROR');
      await sleep(errorCount > 5 ? 30000 : 5000);
    }
  }
}

// ============================================================================
// LOCK & STARTUP
// ============================================================================

function acquireLock(): boolean {
  try {
    const dir = dirname(CONFIG.LOCK_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    
    // Check existing lock
    if (existsSync(CONFIG.LOCK_FILE)) {
      const pid = parseInt(readFileSync(CONFIG.LOCK_FILE, 'utf8').trim());
      try {
        process.kill(pid, 0);  // Check if alive
        console.error(`Already running (PID ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        // Dead process, clean up
        unlinkSync(CONFIG.LOCK_FILE);
      }
    }
    
    writeFileSync(CONFIG.LOCK_FILE, String(process.pid));
    writeFileSync(CONFIG.PID_FILE, String(process.pid));
    return true;
  } catch (e) {
    console.error(`Lock failed: ${e}`);
    return false;
  }
}

function releaseLock(): void {
  try {
    for (const f of [CONFIG.LOCK_FILE, CONFIG.PID_FILE]) {
      if (existsSync(f)) {
        const pid = readFileSync(f, 'utf8').trim();
        if (pid === String(process.pid)) unlinkSync(f);
      }
    }
  } catch { }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

if (!acquireLock()) process.exit(1);

runLoop().catch(e => {
  log(`FATAL: ${e.message}`, 'ERROR');
  releaseLock();
  process.exit(1);
});
