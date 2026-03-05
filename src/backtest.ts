/**
 * Backtest Script for Kalshi 15m BTC Bot
 * Simulates v13.3 strategy against historical fills with fee simulation
 */

import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// === CONFIG (mirrors swing.ts v13.3) ===
const CONFIG = {
  TRADE_SIZE_PCT: 0.05,
  MIN_TRADE_CENTS: 50,
  MAX_TRADE_CENTS: 500,
  MIN_ENTRY_PRICE: 25,
  MAX_ENTRY_PRICE: 45,
  PROFIT_TARGET_CENTS: 10,
  STOP_LOSS_CENTS: 10,
  MIN_SIGNAL_SCORE: 0.05,
  MIN_CHOP_PCT: 0.2,
  MIN_MINS_TO_EXPIRY: 8,
  USE_ML_FILTER: true,
  MIN_ML_CONFIDENCE: 0.6,
  FEE_RATE: 0.025,            // 2.5% per leg
};

// === AUTH ===
const keyId = process.env.KALSHI_KEY_ID || '';
const pem = (process.env.KALSHI_PRIVATE_KEY_PEM || '').replace(/\\n/g, '\n');
const base = process.env.KALSHI_BASE_URL || 'https://api.elections.kalshi.com';

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

async function api(method: string, path: string) {
  const opts = { headers: sign(method, path), timeout: 10000 };
  return (await axios.get(`${base}${path}`, opts)).data;
}

interface Fill {
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count: number;
  price: number;
  ticker: string;
  ts: number;
}

// Fetch all fills
async function fetchFills(): Promise<Fill[]> {
  const fills: Fill[] = [];
  let cursor = '';

  while (true) {
    const path = `/trade-api/v2/portfolio/fills?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const data = await api('GET', path);

    for (const f of data.fills || []) {
      fills.push({
        action: f.action,
        side: f.side,
        count: f.count,
        price: f.side === 'yes' ? f.yes_price : f.no_price,
        ticker: f.ticker,
        ts: f.ts * 1000,
      });
    }

    if (!data.cursor || data.fills?.length < 100) break;
    cursor = data.cursor;
  }

  return fills.sort((a, b) => a.ts - b.ts);
}

// Parse ticker expiry
function parseTickerExpiry(ticker: string): Date | null {
  const match = ticker.match(/KXBTC15M-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})-/);
  if (!match) return null;
  const [, day, mon, year, hour, min] = match;
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  return new Date(2000 + parseInt(year), months[mon], parseInt(day), parseInt(hour), parseInt(min));
}

// Load ML model
interface TreeNode {
  feature?: string;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
  prediction?: number;
  confidence?: number;
}

let mlModel: TreeNode | null = null;

function loadMlModel() {
  try {
    if (existsSync('./models/entry_filter.json')) {
      const data = JSON.parse(readFileSync('./models/entry_filter.json', 'utf8'));
      mlModel = data.tree;
    }
  } catch {}
}

function mlPredict(entryPrice: number, side: 'yes' | 'no', timeToExpiry: number): { shouldEnter: boolean; confidence: number } {
  if (!mlModel || !CONFIG.USE_ML_FILTER) {
    return { shouldEnter: true, confidence: 0.5 };
  }

  const features = { entryPrice, side: side === 'yes' ? 1 : 0, timeToExpiry };

  function predict(node: TreeNode): { prediction: number; confidence: number } {
    if (node.prediction !== undefined) {
      return { prediction: node.prediction, confidence: node.confidence || 0.5 };
    }
    const value = features[node.feature as keyof typeof features];
    return predict(value <= node.threshold! ? node.left! : node.right!);
  }

  const result = predict(mlModel);
  return {
    shouldEnter: result.prediction === 1 && result.confidence >= CONFIG.MIN_ML_CONFIDENCE,
    confidence: result.confidence,
  };
}

// Simulate strategy
interface Trade {
  ticker: string;
  side: 'yes' | 'no';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  netPnl: number;
  reason: string;
  wouldHaveEntered: boolean;
  mlAllowed: boolean;
}

function simulateTrades(fills: Fill[]): Trade[] {
  const byTicker: Record<string, Fill[]> = {};
  for (const f of fills) {
    if (!byTicker[f.ticker]) byTicker[f.ticker] = [];
    byTicker[f.ticker].push(f);
  }

  const trades: Trade[] = [];

  for (const [ticker, tickerFills] of Object.entries(byTicker)) {
    const expiry = parseTickerExpiry(ticker);
    if (!expiry) continue;

    // Group by side
    for (const side of ['yes', 'no'] as const) {
      const buys = tickerFills.filter(f => f.action === 'buy' && f.side === side);
      const sells = tickerFills.filter(f => f.action === 'sell' && f.side === side);

      if (buys.length === 0) continue;

      const avgEntry = buys.reduce((s, f) => s + f.price * f.count, 0) / buys.reduce((s, f) => s + f.count, 0);
      const buyQty = buys.reduce((s, f) => s + f.count, 0);
      const firstBuy = buys[0];
      const timeToExpiry = (expiry.getTime() - firstBuy.ts) / 60000;

      let exitPrice = 0;
      let reason = 'EXPIRED_WORTHLESS';

      if (sells.length > 0) {
        exitPrice = sells.reduce((s, f) => s + f.price * f.count, 0) / sells.reduce((s, f) => s + f.count, 0);
        reason = 'SOLD';
      }

      const grossPnl = (exitPrice - avgEntry) * buyQty;

      // Fee simulation: 2.5% per leg
      const entryFee = Math.round(avgEntry * buyQty * CONFIG.FEE_RATE);
      const exitFee = exitPrice > 0 ? Math.round(exitPrice * buyQty * CONFIG.FEE_RATE) : 0;
      const netPnl = grossPnl - entryFee - exitFee;

      // Would v13.3 have entered?
      const priceInRange = avgEntry >= CONFIG.MIN_ENTRY_PRICE && avgEntry <= CONFIG.MAX_ENTRY_PRICE;
      const timeOk = timeToExpiry >= CONFIG.MIN_MINS_TO_EXPIRY;
      const mlResult = mlPredict(avgEntry, side, timeToExpiry);

      trades.push({
        ticker,
        side,
        entryPrice: avgEntry,
        exitPrice,
        qty: buyQty,
        grossPnl,
        entryFee,
        exitFee,
        netPnl,
        reason,
        wouldHaveEntered: priceInRange && timeOk && mlResult.shouldEnter,
        mlAllowed: mlResult.shouldEnter,
      });
    }
  }

  return trades;
}

// Main
async function main() {
  console.log('=== BACKTEST: v13.3 STRATEGY (with fee simulation) ===\n');

  loadMlModel();
  console.log(`ML Model: ${mlModel ? 'loaded' : 'not found (will use without ML filter)'}`);
  console.log(`Config: TP=${CONFIG.PROFIT_TARGET_CENTS}c | SL=${CONFIG.STOP_LOSS_CENTS}c | Fee=${CONFIG.FEE_RATE * 100}% per leg`);
  console.log(`Entry: ${CONFIG.MIN_ENTRY_PRICE}-${CONFIG.MAX_ENTRY_PRICE}c | Signal: ${CONFIG.MIN_SIGNAL_SCORE} | Chop: ${CONFIG.MIN_CHOP_PCT}%\n`);

  console.log('Fetching historical fills...');
  const fills = await fetchFills();
  console.log(`Found ${fills.length} fills\n`);

  const trades = simulateTrades(fills);
  console.log(`Reconstructed ${trades.length} trades\n`);

  // === ACTUAL RESULTS ===
  const actualGross = trades.reduce((s, t) => s + t.grossPnl, 0);
  const actualNet = trades.reduce((s, t) => s + t.netPnl, 0);
  const actualFees = trades.reduce((s, t) => s + t.entryFee + t.exitFee, 0);
  const actualWins = trades.filter(t => t.netPnl > 0).length;
  const actualLosses = trades.filter(t => t.netPnl <= 0).length;

  console.log('=== ACTUAL RESULTS (what happened) ===');
  console.log(`Gross P&L: ${actualGross.toFixed(0)}c ($${(actualGross / 100).toFixed(2)})`);
  console.log(`Total fees: ${actualFees.toFixed(0)}c ($${(actualFees / 100).toFixed(2)})`);
  console.log(`Net P&L:   ${actualNet.toFixed(0)}c ($${(actualNet / 100).toFixed(2)})`);
  console.log(`Wins: ${actualWins} | Losses: ${actualLosses}`);
  console.log(`Win rate: ${trades.length > 0 ? (actualWins / trades.length * 100).toFixed(1) : 0}%`);

  // Breakeven win rate at 1:1 R:R with fees
  const avgEntryPrice = trades.length > 0 ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length : 35;
  const avgQty = trades.length > 0 ? trades.reduce((s, t) => s + t.qty, 0) / trades.length : 1;
  const avgFeePerLeg = Math.round(avgEntryPrice * avgQty * CONFIG.FEE_RATE);
  const tpGain = CONFIG.PROFIT_TARGET_CENTS * avgQty - 2 * avgFeePerLeg;
  const slLoss = CONFIG.STOP_LOSS_CENTS * avgQty + 2 * avgFeePerLeg;
  const breakevenWinRate = slLoss / (tpGain + slLoss);
  console.log(`\nBreakeven win rate (with fees): ${(breakevenWinRate * 100).toFixed(1)}%`);

  // === SIMULATED v13.3 RESULTS ===
  const v13Trades = trades.filter(t => t.wouldHaveEntered);
  const v13Gross = v13Trades.reduce((s, t) => s + t.grossPnl, 0);
  const v13Net = v13Trades.reduce((s, t) => s + t.netPnl, 0);
  const v13Fees = v13Trades.reduce((s, t) => s + t.entryFee + t.exitFee, 0);
  const v13Wins = v13Trades.filter(t => t.netPnl > 0).length;
  const v13Losses = v13Trades.filter(t => t.netPnl <= 0).length;

  console.log('\n=== v13.3 SIMULATION (what would have happened) ===');
  console.log(`Trades taken: ${v13Trades.length}/${trades.length} (${trades.length > 0 ? ((1 - v13Trades.length / trades.length) * 100).toFixed(0) : 0}% filtered out)`);
  console.log(`Gross P&L: ${v13Gross.toFixed(0)}c ($${(v13Gross / 100).toFixed(2)})`);
  console.log(`Total fees: ${v13Fees.toFixed(0)}c ($${(v13Fees / 100).toFixed(2)})`);
  console.log(`Net P&L:   ${v13Net.toFixed(0)}c ($${(v13Net / 100).toFixed(2)})`);
  console.log(`Wins: ${v13Wins} | Losses: ${v13Losses}`);
  console.log(`Win rate: ${v13Trades.length > 0 ? (v13Wins / v13Trades.length * 100).toFixed(1) : 0}%`);

  // === PER-SIDE BREAKDOWN ===
  console.log('\n=== PER-SIDE BREAKDOWN ===');
  for (const side of ['yes', 'no'] as const) {
    const sideTrades = v13Trades.filter(t => t.side === side);
    if (sideTrades.length === 0) {
      console.log(`${side.toUpperCase()}: no trades`);
      continue;
    }
    const sideGross = sideTrades.reduce((s, t) => s + t.grossPnl, 0);
    const sideNet = sideTrades.reduce((s, t) => s + t.netPnl, 0);
    const sideWins = sideTrades.filter(t => t.netPnl > 0).length;
    console.log(`${side.toUpperCase()}: ${sideTrades.length} trades | Gross: ${sideGross.toFixed(0)}c | Net: ${sideNet.toFixed(0)}c | Win rate: ${(sideWins / sideTrades.length * 100).toFixed(1)}%`);
  }

  // === FILTERED TRADES ===
  const filtered = trades.filter(t => !t.wouldHaveEntered);
  const filteredNet = filtered.reduce((s, t) => s + t.netPnl, 0);

  console.log('\n=== FILTERED TRADES (dodged) ===');
  console.log(`Count: ${filtered.length}`);
  console.log(`Net P&L avoided: ${filteredNet.toFixed(0)}c ($${(filteredNet / 100).toFixed(2)})`);
  if (filtered.length > 0) {
    console.log(`Avg net P&L of filtered: ${(filteredNet / filtered.length).toFixed(1)}c`);
  }

  // Filter reasons
  const priceFiltered = trades.filter(t => t.entryPrice < CONFIG.MIN_ENTRY_PRICE || t.entryPrice > CONFIG.MAX_ENTRY_PRICE);
  const mlFiltered = trades.filter(t => !t.mlAllowed && t.entryPrice >= CONFIG.MIN_ENTRY_PRICE && t.entryPrice <= CONFIG.MAX_ENTRY_PRICE);

  console.log('\n=== FILTER BREAKDOWN ===');
  console.log(`Price range filter: ${priceFiltered.length} trades`);
  console.log(`ML filter: ${mlFiltered.length} trades`);

  // === SUMMARY ===
  const improvement = v13Net - actualNet;
  console.log('\n=== SUMMARY ===');
  console.log(`Actual net P&L:  ${actualNet.toFixed(0)}c`);
  console.log(`v13.3 net P&L:   ${v13Net.toFixed(0)}c`);
  console.log(`Improvement:     ${improvement > 0 ? '+' : ''}${improvement.toFixed(0)}c ($${(improvement / 100).toFixed(2)})`);

  if (improvement > 0) {
    console.log('\n  v13.3 would have performed BETTER');
  } else if (improvement < 0) {
    console.log('\n  v13.3 would have performed WORSE (but with less variance)');
  } else {
    console.log('\n  v13.3 would have performed the SAME');
  }
}

main().catch(console.error);
