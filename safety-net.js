#!/usr/bin/env node
/**
 * SAFETY NET BOT
 * Runs independently to close positions if main bot is down
 * Use: node safety-net.js [ticker]  (or auto-discovers)
 */
import 'dotenv/config';
import { createSign, constants } from 'crypto';
import axios from 'axios';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com';
const KEY_ID = process.env.KALSHI_KEY_ID;
const PEM = process.env.KALSHI_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || '8208882081';

const EMERGENCY_MINS = 3; // Exit if market expires in < 3 mins

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

async function notify(msg) {
  if (!TELEGRAM_TOKEN) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT, 
      text: `🚨 SAFETY NET: ${msg}`
    }, { timeout: 5000 });
  } catch {}
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

async function emergencySell(ticker, side, qty) {
  try {
    // Get current book
    const book = await api('GET', `/trade-api/v2/markets/${ticker}/orderbook`, null);
    const yesBid = book?.orderbook?.yes?.length ? Math.max(...book.orderbook.yes.map(l => l[0])) : 0;
    const noBid = book?.orderbook?.no?.length ? Math.max(...book.orderbook.no.map(l => l[0])) : 0;
    const bid = side === 'yes' ? yesBid : noBid;
    
    if (!bid || bid <= 0) {
      await notify(`Cannot sell ${ticker} ${side} - no bid available`);
      return false;
    }
    
    // Place market sell (at bid)
    const body = { ticker, side, action: 'sell', type: 'limit', count: qty };
    body[side === 'yes' ? 'yes_price' : 'no_price'] = bid;
    
    const r = await api('POST', '/trade-api/v2/portfolio/orders', body);
    if (r?.order?.order_id) {
      await notify(`EMERGENCY SOLD ${side.toUpperCase()} ${qty}x @ ${bid}c | ${ticker} | Order: ${r.order.order_id.slice(0,8)}`);
      return true;
    }
  } catch (e) {
    await notify(`Failed to sell ${ticker} ${side}: ${e.message}`);
  }
  return false;
}

async function run() {
  const now = new Date().toISOString();
  console.log(`[${now}] Safety net check...`);
  
  const positions = await getPositions();
  if (!positions.length) {
    console.log('No open positions');
    return;
  }
  
  const markets = await getMarkets();
  const marketMap = new Map(markets.map(m => [m.ticker, m]));
  
  let actionTaken = false;
  
  for (const pos of positions) {
    const market = marketMap.get(pos.ticker);
    if (!market) {
      console.log(`Market ${pos.ticker} not found - may already be settled`);
      continue;
    }
    
    const closeTime = new Date(market.close_time).getTime();
    const minsToClose = (closeTime - Date.now()) / 60000;
    const side = pos.position > 0 ? 'yes' : 'no';
    const qty = Math.abs(pos.position);
    
    console.log(`${pos.ticker}: ${side} ${qty}x | ${minsToClose.toFixed(1)}m to close`);
    
    if (minsToClose < EMERGENCY_MINS) {
      console.log(`EMERGENCY: ${pos.ticker} expires in ${minsToClose.toFixed(1)}m - selling now!`);
      await notify(`Position expiring in ${minsToClose.toFixed(1)}m! Selling ${side} ${qty}x @ ${pos.ticker}`);
      const sold = await emergencySell(pos.ticker, side, qty);
      if (sold) actionTaken = true;
    }
  }
  
  if (!actionTaken) {
    console.log('No emergency actions needed');
  }
}

run().catch(e => {
  console.error('Safety net error:', e);
  process.exit(1);
});
