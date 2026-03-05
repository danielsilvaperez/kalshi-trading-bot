#!/usr/bin/env node
/**
 * BOT MONITOR + SAFETY NET
 * Runs continuously to:
 * 1. Check if main bot is running, restart if not
 * 2. Emergency sell positions expiring in < 3 mins
 * 3. Send Telegram alerts on all actions
 */
import 'dotenv/config';
import { createSign, constants } from 'crypto';
import axios from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const KALSHI_API_BASE = 'https://api.elections.kalshi.com';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = process.env.KALSHI_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || '';

const EMERGENCY_MINS = 3;
const BOT_CHECK_INTERVAL = 30000; // Check bot every 30s
const POSITION_CHECK_INTERVAL = 60000; // Check positions every 60s

let lastAlertTime = 0;
const ALERT_COOLDOWN = 300000; // 5 min between alerts

function sign(method, path) {
  const ts = String(Date.now());
  const msg = ts + method + path.split('?')[0];
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign({ 
      key: PEM, 
      padding: constants.RSA_PKCS1_PSS_PADDING, 
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST 
    }, 'base64'),
  };
}

async function api(method, path, data) {
  const opts = { headers: sign(method, path), timeout: 10000 };
  if (method === 'GET') return (await axios.get(KALSHI_API_BASE + path, opts)).data;
  if (method === 'POST') return (await axios.post(KALSHI_API_BASE + path, data, { ...opts, headers: { ...opts.headers, 'Content-Type': 'application/json' } })).data;
  if (method === 'DELETE') return (await axios.delete(KALSHI_API_BASE + path, opts)).data;
}

async function notify(msg, force = false) {
  const now = Date.now();
  if (!force && now - lastAlertTime < ALERT_COOLDOWN) return;
  lastAlertTime = now;
  
  if (!TELEGRAM_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT, 
      text: msg
    }, { timeout: 5000 });
    console.log(`[${new Date().toISOString()}] Telegram sent: ${msg.slice(0, 50)}...`);
  } catch (e) {
    console.error('Telegram failed:', e.message);
  }
}

async function isBotRunning() {
  try {
    const { stdout } = await execAsync('ps aux | grep "dist/swing.js" | grep -v grep');
    return stdout.includes('node');
  } catch {
    return false;
  }
}

async function restartBot() {
  console.log(`[${new Date().toISOString()}] Restarting bot...`);
  try {
    await execAsync('pkill -f "dist/swing.js" 2>/dev/null; sleep 2');
    await execAsync(`cd ${process.cwd()} && nohup node dist/swing.js > /dev/null 2>&1 &`);
    await notify('🔄 Bot was DOWN - restarted automatically', true);
    console.log(`[${new Date().toISOString()}] Bot restarted`);
  } catch (e) {
    console.error('Failed to restart:', e);
    await notify(`🚨 FAILED TO RESTART BOT: ${e.message}`, true);
  }
}

async function getPositions() {
  try {
    const data = await api('GET', '/trade-api/v2/portfolio/positions', null);
    return data?.positions || [];
  } catch { return []; }
}

async function getMarkets() {
  try {
    const data = await api('GET', '/trade-api/v2/markets?status=open&limit=50&series_ticker=KXBTC15M', null);
    return data?.markets || [];
  } catch { return []; }
}

async function emergencySell(ticker, side, qty, avgPrice) {
  try {
    const book = await api('GET', `/trade-api/v2/markets/${ticker}/orderbook`, null);
    const yesBid = book?.orderbook?.yes?.length ? Math.max(...book.orderbook.yes.map(l => l[0])) : 0;
    const noBid = book?.orderbook?.no?.length ? Math.max(...book.orderbook.no.map(l => l[0])) : 0;
    const bid = side === 'yes' ? yesBid : noBid;
    
    if (!bid || bid <= 0) {
      await notify(`⚠️ Cannot sell ${ticker} - no bid`, true);
      return false;
    }
    
    const body = { ticker, side, action: 'sell', type: 'limit', count: qty };
    body[side === 'yes' ? 'yes_price' : 'no_price'] = bid;
    
    const r = await api('POST', '/trade-api/v2/portfolio/orders', body);
    if (r?.order?.order_id) {
      const pnl = (bid - avgPrice) * qty;
      const pnlStr = pnl >= 0 ? `+${pnl}` : `${pnl}`;
      await notify(`💰 SAFETY NET SOLD ${side.toUpperCase()} ${qty}x @ ${bid}c (avg ${avgPrice}c) | PnL: ${pnlStr}c | ${ticker}`, true);
      return true;
    }
  } catch (e) {
    await notify(`🚨 FAILED to sell ${ticker}: ${e.message}`, true);
  }
  return false;
}

async function checkPositions() {
  const positions = await getPositions();
  if (!positions.length) return;
  
  const markets = await getMarkets();
  const marketMap = new Map(markets.map(m => [m.ticker, m]));
  
  for (const pos of positions) {
    const market = marketMap.get(pos.ticker);
    if (!market) continue;
    
    const closeTime = new Date(market.close_time).getTime();
    const minsToClose = (closeTime - Date.now()) / 60000;
    const side = pos.position > 0 ? 'yes' : 'no';
    const qty = Math.abs(pos.position);
    const avgPrice = Math.abs(pos.market_exposure || 0) / qty;
    
    console.log(`[${new Date().toISOString()}] ${pos.ticker}: ${side} ${qty}x | ${minsToClose.toFixed(1)}m left`);
    
    if (minsToClose < EMERGENCY_MINS) {
      await notify(`⚠️ Position expiring in ${minsToClose.toFixed(1)}m! Selling ${side} ${qty}x @ ${pos.ticker}`, true);
      await emergencySell(pos.ticker, side, qty, avgPrice);
    }
  }
}

async function checkBot() {
  const running = await isBotRunning();
  if (!running) {
    console.log(`[${new Date().toISOString()}] Bot is DOWN!`);
    await restartBot();
  }
}

// Initial startup notification
await notify('🛡️ SAFETY NET MONITOR STARTED\nWatching bot health + expiring positions', true);

// Run checks
setInterval(checkBot, BOT_CHECK_INTERVAL);
setInterval(checkPositions, POSITION_CHECK_INTERVAL);

// Run immediately on start
checkBot();
checkPositions();

console.log(`[${new Date().toISOString()}] Monitor running...`);

// Keep alive
setInterval(() => {}, 1000);
