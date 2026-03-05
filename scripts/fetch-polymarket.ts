#!/usr/bin/env node
/**
 * Polymarket Historical Data Fetcher
 * Pulls order book snapshots, trades, and price history for 15-min BTC markets
 */
import axios from 'axios';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const POLYMARKET_API = 'https://clob.polymarket.com';
const DATA_DIR = './data/polymarket';

// BTC 15-min market condition IDs (you'll need to find these)
// Example: https://polymarket.com/event/btc-updown-15m-1771109100
// The condition ID is in the API or can be fetched from the market endpoint

async function getMarketInfo(marketSlug: string) {
  try {
    // Polymarket gamma API for market metadata
    const res = await axios.get(`https://gamma-api.polymarket.com/markets?slug=${marketSlug}`, {
      timeout: 10000
    });
    return res.data?.[0];
  } catch (e) {
    console.error('Failed to get market info:', e);
    return null;
  }
}

async function getHistoricalOrderBook(conditionId: string, timestamp?: number) {
  try {
    const url = timestamp 
      ? `${POLYMARKET_API}/orderbook/historical/${conditionId}?timestamp=${timestamp}`
      : `${POLYMARKET_API}/orderbook/${conditionId}`;
    
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (e) {
    console.error('Failed to get order book:', e);
    return null;
  }
}

async function getTradeHistory(conditionId: string, startTime?: number, endTime?: number) {
  try {
    let url = `${POLYMARKET_API}/trades/history/${conditionId}`;
    if (startTime && endTime) {
      url += `?start_time=${startTime}&end_time=${endTime}`;
    }
    
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (e) {
    console.error('Failed to get trade history:', e);
    return null;
  }
}

async function getPriceHistory(conditionId: string, startTime?: number, endTime?: number) {
  try {
    let url = `${POLYMARKET_API}/prices/history/${conditionId}`;
    if (startTime && endTime) {
      url += `?start_time=${startTime}&end_time=${endTime}`;
    }
    
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (e) {
    console.error('Failed to get price history:', e);
    return null;
  }
}

async function fetchMarketData(conditionId: string, marketName: string) {
  console.log(`Fetching data for ${marketName} (${conditionId})`);
  
  // Create data directory
  const marketDir = `${DATA_DIR}/${conditionId}`;
  if (!existsSync(marketDir)) {
    mkdirSync(marketDir, { recursive: true });
  }
  
  // Calculate time range (90 days)
  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - (90 * 24 * 60 * 60); // 90 days ago
  
  console.log(`Time range: ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()}`);
  
  // Fetch in chunks (API may limit)
  const chunkSize = 7 * 24 * 60 * 60; // 7 days per chunk
  let currentStart = startTime;
  
  const allTrades: any[] = [];
  const allPrices: any[] = [];
  
  while (currentStart < endTime) {
    const chunkEnd = Math.min(currentStart + chunkSize, endTime);
    
    console.log(`Fetching chunk: ${new Date(currentStart * 1000).toISOString()} to ${new Date(chunkEnd * 1000).toISOString()}`);
    
    // Get trades
    const trades = await getTradeHistory(conditionId, currentStart, chunkEnd);
    if (trades?.trades?.length) {
      allTrades.push(...trades.trades);
      console.log(`  Got ${trades.trades.length} trades`);
    }
    
    // Get price history
    const prices = await getPriceHistory(conditionId, currentStart, chunkEnd);
    if (prices?.prices?.length) {
      allPrices.push(...prices.prices);
      console.log(`  Got ${prices.prices.length} price points`);
    }
    
    currentStart = chunkEnd;
    
    // Rate limit protection
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // Save data
  writeFileSync(`${marketDir}/trades.json`, JSON.stringify(allTrades, null, 2));
  writeFileSync(`${marketDir}/prices.json`, JSON.stringify(allPrices, null, 2));
  
  console.log(`\nTotal trades: ${allTrades.length}`);
  console.log(`Total price points: ${allPrices.length}`);
  console.log(`Data saved to ${marketDir}/`);
  
  // Create summary CSV
  if (allPrices.length > 0) {
    let csv = 'timestamp,price,volume\n';
    for (const p of allPrices) {
      csv += `${p.timestamp || p.time},${p.price},${p.volume || 0}\n`;
    }
    writeFileSync(`${marketDir}/prices.csv`, csv);
  }
  
  return { trades: allTrades, prices: allPrices };
}

async function main() {
  console.log('Polymarket Historical Data Fetcher');
  console.log('===================================\n');
  
  // List of BTC 15-min market condition IDs
  // These would need to be discovered or maintained
  // For now, we'll try to discover them
  
  console.log('Discovering BTC 15-min markets...');
  
  // Search for active BTC markets
  try {
    const res = await axios.get('https://gamma-api.polymarket.com/markets?active=true&archived=false&limit=100', {
      timeout: 10000
    });
    
    const markets = res.data?.filter((m: any) => 
      m.title?.toLowerCase().includes('bitcoin') || 
      m.title?.toLowerCase().includes('btc')
    );
    
    console.log(`Found ${markets?.length || 0} BTC-related markets`);
    
    if (markets?.length > 0) {
      for (const market of markets.slice(0, 5)) { // Limit to first 5
        console.log(`\n- ${market.title}`);
        console.log(`  Condition ID: ${market.conditionId}`);
        console.log(`  Slug: ${market.marketSlug}`);
        
        // Fetch data for this market
        await fetchMarketData(market.conditionId, market.title);
      }
    }
  } catch (e) {
    console.error('Failed to discover markets:', e);
  }
}

main().catch(console.error);
