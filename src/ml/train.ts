/**
 * ML Training Script for Kalshi 15m BTC Bot
 * Extracts features from historical trades and trains a simple classifier
 */

import 'dotenv/config';
import axios from 'axios';
import { createSign, constants } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  created_time: string;
}

interface TradeFeatures {
  // Input features
  entryPrice: number;
  side: number; // 1 = YES, 0 = NO
  timeToExpiry: number; // minutes
  // Outcome
  pnl: number;
  win: number; // 1 = win, 0 = loss
}

// Fetch all fills from Kalshi
async function fetchAllFills(): Promise<Fill[]> {
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
        created_time: f.created_time,
      });
    }
    
    if (!data.cursor || data.fills?.length < 100) break;
    cursor = data.cursor;
  }
  
  return fills;
}

// Parse ticker to get expiry time
function parseTickerExpiry(ticker: string): Date | null {
  // KXBTC15M-26FEB140845-45 -> Feb 14, 2026 08:45
  const match = ticker.match(/KXBTC15M-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})-/);
  if (!match) return null;
  
  const [, day, mon, year, hour, min] = match;
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  
  return new Date(2000 + parseInt(year), months[mon], parseInt(day), parseInt(hour), parseInt(min));
}

// Group fills by ticker and compute P&L
function computeTrades(fills: Fill[]): TradeFeatures[] {
  const byTicker: Record<string, Fill[]> = {};
  
  for (const f of fills) {
    if (!byTicker[f.ticker]) byTicker[f.ticker] = [];
    byTicker[f.ticker].push(f);
  }
  
  const trades: TradeFeatures[] = [];
  
  for (const [ticker, tickerFills] of Object.entries(byTicker)) {
    const expiry = parseTickerExpiry(ticker);
    if (!expiry) continue;
    
    // Group by side
    const yesBuys = tickerFills.filter(f => f.action === 'buy' && f.side === 'yes');
    const yesSells = tickerFills.filter(f => f.action === 'sell' && f.side === 'yes');
    const noBuys = tickerFills.filter(f => f.action === 'buy' && f.side === 'no');
    const noSells = tickerFills.filter(f => f.action === 'sell' && f.side === 'no');
    
    // YES side P&L
    if (yesBuys.length > 0) {
      const avgBuy = yesBuys.reduce((s, f) => s + f.price * f.count, 0) / yesBuys.reduce((s, f) => s + f.count, 0);
      const buyQty = yesBuys.reduce((s, f) => s + f.count, 0);
      const sellQty = yesSells.reduce((s, f) => s + f.count, 0);
      const avgSell = yesSells.length > 0 
        ? yesSells.reduce((s, f) => s + f.price * f.count, 0) / sellQty
        : 0; // Expired worthless or at 100
      
      const firstBuy = yesBuys.sort((a, b) => a.ts - b.ts)[0];
      const timeToExpiry = (expiry.getTime() - firstBuy.ts) / 60000;
      
      // If no sells, check if it would have settled at 100 or 0
      // For now, assume unsold = loss (settled at 0)
      const exitPrice = sellQty > 0 ? avgSell : 0;
      const pnl = (exitPrice - avgBuy) * buyQty;
      
      trades.push({
        entryPrice: avgBuy,
        side: 1,
        timeToExpiry,
        pnl,
        win: pnl > 0 ? 1 : 0,
      });
    }
    
    // NO side P&L
    if (noBuys.length > 0) {
      const avgBuy = noBuys.reduce((s, f) => s + f.price * f.count, 0) / noBuys.reduce((s, f) => s + f.count, 0);
      const buyQty = noBuys.reduce((s, f) => s + f.count, 0);
      const sellQty = noSells.reduce((s, f) => s + f.count, 0);
      const avgSell = noSells.length > 0 
        ? noSells.reduce((s, f) => s + f.price * f.count, 0) / sellQty
        : 0;
      
      const firstBuy = noBuys.sort((a, b) => a.ts - b.ts)[0];
      const timeToExpiry = (expiry.getTime() - firstBuy.ts) / 60000;
      
      const exitPrice = sellQty > 0 ? avgSell : 0;
      const pnl = (exitPrice - avgBuy) * buyQty;
      
      trades.push({
        entryPrice: avgBuy,
        side: 0,
        timeToExpiry,
        pnl,
        win: pnl > 0 ? 1 : 0,
      });
    }
  }
  
  return trades;
}

// Simple decision tree implementation
interface TreeNode {
  feature?: string;
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
  prediction?: number;
  confidence?: number;
}

function trainDecisionTree(data: TradeFeatures[], maxDepth = 3): TreeNode {
  const features = ['entryPrice', 'side', 'timeToExpiry'];
  
  function entropy(labels: number[]): number {
    if (labels.length === 0) return 0;
    const p1 = labels.filter(l => l === 1).length / labels.length;
    if (p1 === 0 || p1 === 1) return 0;
    return -p1 * Math.log2(p1) - (1 - p1) * Math.log2(1 - p1);
  }
  
  function bestSplit(data: TradeFeatures[]): { feature: string; threshold: number; gain: number } | null {
    const labels = data.map(d => d.win);
    const baseEntropy = entropy(labels);
    
    let best: { feature: string; threshold: number; gain: number } | null = null;
    
    for (const feature of features) {
      const values = [...new Set(data.map(d => d[feature as keyof TradeFeatures] as number))].sort((a, b) => a - b);
      
      for (let i = 0; i < values.length - 1; i++) {
        const threshold = (values[i] + values[i + 1]) / 2;
        const left = data.filter(d => (d[feature as keyof TradeFeatures] as number) <= threshold);
        const right = data.filter(d => (d[feature as keyof TradeFeatures] as number) > threshold);
        
        if (left.length === 0 || right.length === 0) continue;
        
        const leftEntropy = entropy(left.map(d => d.win));
        const rightEntropy = entropy(right.map(d => d.win));
        const weightedEntropy = (left.length * leftEntropy + right.length * rightEntropy) / data.length;
        const gain = baseEntropy - weightedEntropy;
        
        if (!best || gain > best.gain) {
          best = { feature, threshold, gain };
        }
      }
    }
    
    return best;
  }
  
  function buildTree(data: TradeFeatures[], depth: number): TreeNode {
    const wins = data.filter(d => d.win === 1).length;
    const losses = data.length - wins;
    const prediction = wins > losses ? 1 : 0;
    const confidence = Math.max(wins, losses) / data.length;
    
    if (depth >= maxDepth || data.length < 5 || confidence > 0.9) {
      return { prediction, confidence };
    }
    
    const split = bestSplit(data);
    if (!split || split.gain < 0.01) {
      return { prediction, confidence };
    }
    
    const left = data.filter(d => (d[split.feature as keyof TradeFeatures] as number) <= split.threshold);
    const right = data.filter(d => (d[split.feature as keyof TradeFeatures] as number) > split.threshold);
    
    return {
      feature: split.feature,
      threshold: split.threshold,
      left: buildTree(left, depth + 1),
      right: buildTree(right, depth + 1),
    };
  }
  
  return buildTree(data, 0);
}

function predict(tree: TreeNode, features: { entryPrice: number; side: number; timeToExpiry: number }): { prediction: number; confidence: number } {
  if (tree.prediction !== undefined) {
    return { prediction: tree.prediction, confidence: tree.confidence || 0.5 };
  }
  
  const value = features[tree.feature as keyof typeof features];
  if (value <= tree.threshold!) {
    return predict(tree.left!, features);
  } else {
    return predict(tree.right!, features);
  }
}

function printTree(node: TreeNode, indent = ''): void {
  if (node.prediction !== undefined) {
    console.log(`${indent}→ ${node.prediction === 1 ? 'WIN' : 'LOSS'} (${(node.confidence! * 100).toFixed(0)}%)`);
    return;
  }
  console.log(`${indent}${node.feature} <= ${node.threshold?.toFixed(1)}?`);
  console.log(`${indent}  YES:`);
  printTree(node.left!, indent + '    ');
  console.log(`${indent}  NO:`);
  printTree(node.right!, indent + '    ');
}

// Main
async function main() {
  console.log('=== ML TRAINING FOR KALSHI 15M BTC BOT ===\n');
  
  console.log('Fetching fills from Kalshi...');
  const fills = await fetchAllFills();
  console.log(`Found ${fills.length} fills\n`);
  
  console.log('Computing trade outcomes...');
  const trades = computeTrades(fills);
  console.log(`Computed ${trades.length} trades\n`);
  
  // Stats
  const wins = trades.filter(t => t.win === 1);
  const losses = trades.filter(t => t.win === 0);
  console.log('=== TRADE STATS ===');
  console.log(`Total trades: ${trades.length}`);
  console.log(`Wins: ${wins.length} (${(wins.length / trades.length * 100).toFixed(1)}%)`);
  console.log(`Losses: ${losses.length} (${(losses.length / trades.length * 100).toFixed(1)}%)`);
  console.log(`Avg win P&L: ${(wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(1)}c`);
  console.log(`Avg loss P&L: ${(losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(1)}c`);
  
  // Feature analysis
  console.log('\n=== FEATURE ANALYSIS ===');
  console.log('Entry Price:');
  const cheapWins = wins.filter(t => t.entryPrice < 25).length;
  const cheapTotal = trades.filter(t => t.entryPrice < 25).length;
  const midWins = wins.filter(t => t.entryPrice >= 25 && t.entryPrice <= 45).length;
  const midTotal = trades.filter(t => t.entryPrice >= 25 && t.entryPrice <= 45).length;
  console.log(`  <25c: ${cheapWins}/${cheapTotal} wins (${cheapTotal > 0 ? (cheapWins/cheapTotal*100).toFixed(0) : 0}%)`);
  console.log(`  25-45c: ${midWins}/${midTotal} wins (${midTotal > 0 ? (midWins/midTotal*100).toFixed(0) : 0}%)`);
  
  console.log('Time to Expiry:');
  const earlyWins = wins.filter(t => t.timeToExpiry > 10).length;
  const earlyTotal = trades.filter(t => t.timeToExpiry > 10).length;
  const lateWins = wins.filter(t => t.timeToExpiry <= 5).length;
  const lateTotal = trades.filter(t => t.timeToExpiry <= 5).length;
  console.log(`  >10min: ${earlyWins}/${earlyTotal} wins (${earlyTotal > 0 ? (earlyWins/earlyTotal*100).toFixed(0) : 0}%)`);
  console.log(`  <=5min: ${lateWins}/${lateTotal} wins (${lateTotal > 0 ? (lateWins/lateTotal*100).toFixed(0) : 0}%)`);
  
  console.log('Side:');
  const yesWins = wins.filter(t => t.side === 1).length;
  const yesTotal = trades.filter(t => t.side === 1).length;
  const noWins = wins.filter(t => t.side === 0).length;
  const noTotal = trades.filter(t => t.side === 0).length;
  console.log(`  YES: ${yesWins}/${yesTotal} wins (${yesTotal > 0 ? (yesWins/yesTotal*100).toFixed(0) : 0}%)`);
  console.log(`  NO: ${noWins}/${noTotal} wins (${noTotal > 0 ? (noWins/noTotal*100).toFixed(0) : 0}%)`);
  
  // Train decision tree
  console.log('\n=== TRAINING DECISION TREE ===');
  const tree = trainDecisionTree(trades, 4);
  console.log('Tree structure:');
  printTree(tree);
  
  // Cross-validation (simple holdout)
  const shuffled = [...trades].sort(() => Math.random() - 0.5);
  const trainSet = shuffled.slice(0, Math.floor(shuffled.length * 0.7));
  const testSet = shuffled.slice(Math.floor(shuffled.length * 0.7));
  
  const cvTree = trainDecisionTree(trainSet, 4);
  let correct = 0;
  for (const t of testSet) {
    const pred = predict(cvTree, t);
    if (pred.prediction === t.win) correct++;
  }
  console.log(`\nCross-validation accuracy: ${(correct / testSet.length * 100).toFixed(1)}%`);
  
  // Save model
  const modelPath = './models/entry_filter.json';
  const modelDir = dirname(modelPath);
  if (!existsSync(modelDir)) mkdirSync(modelDir, { recursive: true });
  writeFileSync(modelPath, JSON.stringify({ tree, trainedAt: new Date().toISOString(), trades: trades.length }, null, 2));
  console.log(`\nModel saved to ${modelPath}`);
  
  // Generate rules
  console.log('\n=== DERIVED TRADING RULES ===');
  if (cheapWins / cheapTotal < 0.4) {
    console.log('❌ Avoid entries <25c (low win rate)');
  }
  if (lateWins / lateTotal < 0.4) {
    console.log('❌ Avoid entries with <5min to expiry');
  }
  if (earlyWins / earlyTotal > 0.5) {
    console.log('✅ Prefer entries with >10min to expiry');
  }
}

main().catch(console.error);
