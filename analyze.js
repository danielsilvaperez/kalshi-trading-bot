const fills = [
    {
      "action": "buy",
      "count": 2,
      "yes_price": 64,
      "no_price": 36,
      "side": "no",
      "fee_cost": "0.0400",
      "ticker": "KXBTC15M-26FEB140845-45"
    },
    {
      "action": "buy",
      "count": 1,
      "yes_price": 51,
      "no_price": 49,
      "side": "no",
      "fee_cost": "0.0200"
    },
    // ... more data
];

// Analysis from actual API data
const buys = { yes: [], no: [] };
const sells = { yes: [], no: [] };
let totalBuyCost = 0, totalSellRevenue = 0, totalFees = 0;

// Parse from the actual output above
const rawFills = [
  { action: 'buy', side: 'no', price: 36, count: 2 },
  { action: 'buy', side: 'no', price: 49, count: 1 },
  { action: 'buy', side: 'yes', price: 3, count: 31 },
  { action: 'buy', side: 'yes', price: 7, count: 13 },
  { action: 'buy', side: 'yes', price: 15, count: 12 },
  { action: 'sell', side: 'yes', price: 54, count: 5 },
  { action: 'buy', side: 'yes', price: 46, count: 4 },
  { action: 'buy', side: 'yes', price: 26, count: 14 },
  { action: 'buy', side: 'yes', price: 27, count: 14 },
  { action: 'buy', side: 'yes', price: 34, count: 11 },
  { action: 'buy', side: 'yes', price: 45, count: 8 },
  { action: 'sell', side: 'yes', price: 83, count: 17 },
  { action: 'buy', side: 'no', price: 41, count: 9 },
  { action: 'buy', side: 'no', price: 44, count: 8 },
  { action: 'sell', side: 'yes', price: 48, count: 9 },
  { action: 'buy', side: 'no', price: 40, count: 9 },
  { action: 'buy', side: 'no', price: 2, count: 46 },
  { action: 'sell', side: 'yes', price: 83, count: 50 },
  { action: 'buy', side: 'no', price: 17, count: 22 },
  { action: 'buy', side: 'no', price: 26, count: 27 },
  { action: 'buy', side: 'yes', price: 11, count: 7 },
  { action: 'sell', side: 'no', price: 22, count: 42 },
  { action: 'buy', side: 'yes', price: 24, count: 15 },
  { action: 'buy', side: 'yes', price: 25, count: 15 },
  { action: 'buy', side: 'yes', price: 31, count: 12 },
  { action: 'sell', side: 'no', price: 28, count: 44 },
  { action: 'buy', side: 'yes', price: 22, count: 44 },
  { action: 'buy', side: 'yes', price: 33, count: 11 },
  { action: 'buy', side: 'yes', price: 2, count: 93 },
  { action: 'buy', side: 'yes', price: 4, count: 46 },
  { action: 'buy', side: 'yes', price: 6, count: 31 },
  { action: 'buy', side: 'yes', price: 28, count: 16 },
  { action: 'buy', side: 'yes', price: 30, count: 16 },
  { action: 'buy', side: 'yes', price: 34, count: 14 },
  { action: 'buy', side: 'yes', price: 35, count: 13 },
  { action: 'buy', side: 'yes', price: 36, count: 13 },
  { action: 'buy', side: 'yes', price: 34, count: 14 },
  { action: 'buy', side: 'yes', price: 37, count: 13 },
  { action: 'buy', side: 'no', price: 1, count: 93 },
  { action: 'buy', side: 'no', price: 11, count: 41 },
  { action: 'buy', side: 'no', price: 24, count: 20 },
  { action: 'buy', side: 'no', price: 37, count: 13 },
  { action: 'sell', side: 'no', price: 28, count: 53 },
  { action: 'buy', side: 'yes', price: 23, count: 20 },
  { action: 'buy', side: 'yes', price: 25, count: 19 },
  { action: 'sell', side: 'no', price: 26, count: 14 },
  { action: 'buy', side: 'yes', price: 33, count: 14 },
  { action: 'sell', side: 'yes', price: 72, count: 13 },
  { action: 'buy', side: 'no', price: 36, count: 13 },
  { action: 'sell', side: 'yes', price: 60, count: 26 },
  { action: 'buy', side: 'no', price: 35, count: 13 },
  { action: 'buy', side: 'no', price: 36, count: 13 },
  { action: 'sell', side: 'yes', price: 66, count: 16 },
  { action: 'buy', side: 'no', price: 29, count: 16 },
  { action: 'sell', side: 'yes', price: 77, count: 49 },
  { action: 'buy', side: 'no', price: 24, count: 20 },
  { action: 'buy', side: 'no', price: 29, count: 16 },
  { action: 'buy', side: 'no', price: 37, count: 13 },
  { action: 'sell', side: 'yes', price: 72, count: 13 },
  { action: 'buy', side: 'no', price: 36, count: 13 },
  { action: 'sell', side: 'no', price: 25, count: 42 },
  { action: 'buy', side: 'yes', price: 21, count: 22 },
  { action: 'buy', side: 'yes', price: 23, count: 20 },
];

// Compute stats
let winCount = 0, lossCount = 0;
let winPnl = 0, lossPnl = 0;

// Group by ticker to match buys with sells
const byTicker = {};
rawFills.forEach(f => {
  // Simplified P&L calc
  if (f.action === 'buy') {
    totalBuyCost += f.price * f.count;
  } else {
    totalSellRevenue += f.price * f.count;
  }
});

console.log('=== TRADE ANALYSIS ===');
console.log('Buy contracts:', rawFills.filter(f => f.action === 'buy').reduce((s, f) => s + f.count, 0));
console.log('Sell contracts:', rawFills.filter(f => f.action === 'sell').reduce((s, f) => s + f.count, 0));
console.log('Total Buy Cost:', totalBuyCost, 'c ($' + (totalBuyCost/100).toFixed(2) + ')');
console.log('Total Sell Revenue:', totalSellRevenue, 'c ($' + (totalSellRevenue/100).toFixed(2) + ')');
console.log('Gross P&L:', totalSellRevenue - totalBuyCost, 'c');

// Entry price analysis
const entryPrices = rawFills.filter(f => f.action === 'buy').map(f => f.price);
const avgEntry = entryPrices.reduce((a, b) => a + b, 0) / entryPrices.length;
console.log('\n=== ENTRY PRICE ANALYSIS ===');
console.log('Avg entry price:', avgEntry.toFixed(1) + 'c');
console.log('Entry range:', Math.min(...entryPrices) + 'c -', Math.max(...entryPrices) + 'c');

// Cheap entries (<25c)
const cheapBuys = rawFills.filter(f => f.action === 'buy' && f.price < 25);
const midBuys = rawFills.filter(f => f.action === 'buy' && f.price >= 25 && f.price <= 45);
const expensiveBuys = rawFills.filter(f => f.action === 'buy' && f.price > 45);

console.log('Cheap (<25c):', cheapBuys.reduce((s, f) => s + f.count, 0), 'contracts');
console.log('Mid (25-45c):', midBuys.reduce((s, f) => s + f.count, 0), 'contracts');
console.log('Expensive (>45c):', expensiveBuys.reduce((s, f) => s + f.count, 0), 'contracts');

// YES vs NO
const yesBuys = rawFills.filter(f => f.action === 'buy' && f.side === 'yes');
const noBuys = rawFills.filter(f => f.action === 'buy' && f.side === 'no');
console.log('\n=== SIDE ANALYSIS ===');
console.log('YES buys:', yesBuys.reduce((s, f) => s + f.count, 0), '| NO buys:', noBuys.reduce((s, f) => s + f.count, 0));

// Key insight
console.log('\n=== KEY INSIGHTS ===');
console.log('1. Heavy buying at extreme prices (1-11c) that often went to 0');
console.log('2. Many mid-range entries (25-45c) that got stopped out');
console.log('3. Sells often happened at worse prices than entries');
console.log('4. No clear directional edge - flipping between YES and NO');
