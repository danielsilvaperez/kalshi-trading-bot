import 'dotenv/config';
import { createSign, constants } from 'crypto';
import axios from 'axios';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com';
const keyId = process.env.KALSHI_KEY_ID;
const pem = process.env.KALSHI_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');

function sign(method, path) {
  const ts = String(Date.now());
  const msg = ts + method + path.split('?')[0];
  const s = createSign('RSA-SHA256');
  s.update(msg);
  s.end();
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'KALSHI-ACCESS-SIGNATURE': s.sign({ 
      key: pem, 
      padding: constants.RSA_PKCS1_PSS_PADDING, 
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST 
    }, 'base64'),
  };
}

async function getPositions() {
  const res = await axios.get(
    KALSHI_API_BASE + '/trade-api/v2/portfolio/positions', 
    { headers: sign('GET', '/trade-api/v2/portfolio/positions'), timeout: 8000 }
  );
  return res.data;
}

async function getBalance() {
  const res = await axios.get(
    KALSHI_API_BASE + '/trade-api/v2/portfolio/balance', 
    { headers: sign('GET', '/trade-api/v2/portfolio/balance'), timeout: 8000 }
  );
  return res.data;
}

async function getFills(limit = 50) {
  const res = await axios.get(
    KALSHI_API_BASE + `/trade-api/v2/portfolio/fills?limit=${limit}`, 
    { headers: sign('GET', '/trade-api/v2/portfolio/fills'), timeout: 8000 }
  );
  return res.data;
}

async function getOrders(status = 'open') {
  const res = await axios.get(
    KALSHI_API_BASE + `/trade-api/v2/portfolio/orders?status=${status}&limit=50`, 
    { headers: sign('GET', '/trade-api/v2/portfolio/orders'), timeout: 8000 }
  );
  return res.data;
}

(async () => {
  try {
    const [balance, positions, fills, orders] = await Promise.all([
      getBalance(),
      getPositions(),
      getFills(30),
      getOrders('open')
    ]);
    
    console.log('╔══════════════════════════════════════════╗');
    console.log('║         KALSHI PORTFOLIO STATUS          ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log();
    
    console.log('BALANCE:');
    console.log('  Available:     $' + (balance.balance / 100).toFixed(2));
    console.log('  Portfolio:     $' + ((balance.portfolio_value || 0) / 100).toFixed(2));
    console.log('  Total:         $' + ((balance.balance + (balance.portfolio_value || 0)) / 100).toFixed(2));
    console.log();
    
    console.log('OPEN POSITIONS (' + (positions.positions?.length || 0) + '):');
    if (positions.positions?.length) {
      positions.positions.forEach(p => {
        const value = Math.abs(p.position * p.avg_price / 100).toFixed(2);
        console.log(`  ${p.ticker}`);
        console.log(`    Side: ${p.side.toUpperCase()} ${Math.abs(p.position)} contracts`);
        console.log(`    Avg:  ${p.avg_price}c ($${value})`);
      });
    } else {
      console.log('  No open positions');
    }
    console.log();
    
    console.log('OPEN ORDERS (' + (orders.orders?.length || 0) + '):');
    if (orders.orders?.length) {
      orders.orders.forEach(o => {
        console.log(`  ${o.ticker} ${o.side.toUpperCase()} ${o.count}x @ ${o.price}c (${o.status})`);
      });
    } else {
      console.log('  No open orders');
    }
    console.log();
    
    console.log('RECENT FILLS (last 10):');
    fills.fills?.slice(0, 10).forEach(f => {
      const date = f.created_at ? new Date(f.created_at).toLocaleTimeString('en-US', { hour12: false }) : '??';
      const dollars = (f.count * f.price / 100).toFixed(2);
      console.log(`  ${date} ${f.ticker} ${f.side.toUpperCase()} ${f.count}x @ ${f.price}c ($${dollars})`);
    });
    
  } catch (e) {
    console.error('Error:', e.response?.data?.error?.message || e.message);
    process.exit(1);
  }
})();
