const axios = require('axios');

(async () => {
  try {
    console.log('Searching for BTC 15-min markets on Polymarket...\n');
    
    // Try to get markets with pagination
    let cursor = null;
    let page = 0;
    const btc15mMarkets = [];
    
    while (page < 20) {
      const url = cursor 
        ? `https://clob.polymarket.com/markets?cursor=${cursor}&active=true` 
        : 'https://clob.polymarket.com/markets?active=true';
      
      console.log(`Fetching page ${page + 1}...`);
      const res = await axios.get(url, { timeout: 15000 });
      const markets = res.data?.data || [];
      
      for (const m of markets) {
        const q = m.question?.toLowerCase() || '';
        const desc = m.description?.toLowerCase() || '';
        
        // Look for 15-minute patterns
        if ((q.includes('bitcoin') || q.includes('btc')) &&
            (q.includes('up or down') || q.includes('higher or lower') || desc.includes('15 min'))) {
          console.log('\n=== FOUND BTC 15-MIN MARKET ===');
          console.log('Question:', m.question);
          console.log('Condition ID:', m.condition_id);
          console.log('Active:', m.active);
          console.log('Accepting orders:', m.accepting_orders);
          console.log('================================\n');
          btc15mMarkets.push(m);
        }
      }
      
      cursor = res.data?.next_cursor;
      if (!cursor || btc15mMarkets.length >= 5) break;
      page++;
      
      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    }
    
    console.log(`\nTotal BTC 15-min markets found: ${btc15mMarkets.length}`);
    
    // Save market list
    if (btc15mMarkets.length > 0) {
      const fs = require('fs');
      fs.mkdirSync('./data/polymarket', { recursive: true });
      fs.writeFileSync('./data/polymarket/btc-15m-markets.json', JSON.stringify(btc15mMarkets, null, 2));
      console.log('Market list saved to ./data/polymarket/btc-15m-markets.json');
      
      // Try to fetch historical data for first market
      if (btc15mMarkets[0]) {
        const conditionId = btc15mMarkets[0].condition_id;
        console.log(`\nFetching historical data for ${conditionId}...`);
        
        // Get price history
        const priceRes = await axios.get(
          `https://clob.polymarket.com/prices/history/${conditionId}?interval=1m`,
          { timeout: 15000 }
        );
        
        console.log('Price history points:', priceRes.data?.prices?.length || 0);
        
        if (priceRes.data?.prices?.length > 0) {
          fs.writeFileSync(
            `./data/polymarket/${conditionId}-prices.json`,
            JSON.stringify(priceRes.data.prices, null, 2)
          );
          console.log(`Saved ${priceRes.data.prices.length} price points`);
        }
      }
    } else {
      console.log('No BTC 15-min markets found. They may be:');
      console.log('1. Inactive/closed');
      console.log('2. On a different endpoint');
      console.log('3. Require authentication');
    }
  } catch (e) {
    console.error('Error:', e.message);
    if (e.response) {
      console.error('Status:', e.response.status);
      console.error('Data:', e.response.data);
    }
  }
})();
