# Polymarket Data Access

## Current Status

✅ **Market metadata** - Available publicly via Gamma API
❌ **Historical order book** - Requires CLOB API authentication
❌ **Price history** - Requires CLOB API authentication  
❌ **Trade history** - Requires CLOB API authentication

## What We Found

**Market Details:**
- **Question:** Bitcoin Up or Down - February 14, 5:45PM-6:00PM ET
- **Condition ID:** 0x37c16f84a0aa402a20620cab9ac9ca7babb9dbd1f55190e1a91d522b58fb7230
- **Status:** Active, accepting orders
- **Fees:** 1% maker, 1% taker (much lower than Kalshi's 2.5%)
- **Min Order:** 5 USDC
- **Tick Size:** 0.01

**Current Prices:**
- YES (Up): 0.645 ($0.645)
- NO (Down): 0.355 ($0.355)

## The Problem

Polymarket's **CLOB API** (order book, trades, price history) requires:
1. API key authentication
2. Wallet signature (Polygon/USDC wallet)
3. Geographic restrictions (US users blocked)

## What This Means

**Cannot pull historical data without:**
- Setting up a Polymarket account
- Connecting a wallet
- Getting API credentials
- Potentially VPN if in US

## Comparison

| Feature | Kalshi | Polymarket |
|---------|--------|------------|
| 15-min BTC markets | ✅ Yes | ✅ Yes |
| API access | ✅ Easy, key-based | ❌ Complex, wallet auth |
| Historical data | ✅ Available | ❌ Requires auth |
| Fees | 2.5% | 1% |
| Settlement | USD (regulated) | USDC (crypto) |

## Recommendation

**Stick with Kalshi for now.**

Polymarket's 1% fees are better, but:
1. You already have Kalshi working
2. You'd need to bridge/set up USDC on Polygon ($10-20 in gas)
3. Your $89 bankroll can't afford $5 minimums + gas + spread
4. API access is much harder

**When to switch to Polymarket:**
- Bankroll > $500
- Willing to set up crypto infrastructure
- Want lower fees (1% vs 2.5%)
- Need the historical data (which requires auth anyway)

## Alternative

If you want **free historical data**, the best sources are:
1. **Kalshi API** (your own fills + settlements)
2. **Coinbase/Binance API** (BTC price history)
3. **Your own bot** (logging everything going forward)

**Bottom line:** Polymarket exists and has better fees, but the data isn't freely accessible and the setup is much harder than Kalshi.
