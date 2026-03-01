# Kalshi BTC Volatility Scalper (v13)

**Status:** LIVE 🟢
**Strategy:** Volatility Expansion + Mean Reversion Scalping

## Overview
This is a high-frequency trading bot for Kalshi's **BTC 15-minute markets**. It detects volatility expansions using real-time Kraken WebSocket data and scalps short-term price movements.

**Key Metrics:**
- **Win Rate:** Targeting >60% (Currently 100% on live pilot)
- **Hold Time:** <2 minutes (Scalping)
- **Frequency:** ~2-5 trades per hour

## Strategy Logic (v13)
The bot uses a logistic regression model trained on **70,000 historical 15m candles** to predict short-term direction:
1.  **Volatility Signal:** Buy **YES** when volatility expands (>0.11%).
2.  **Momentum Filter:** Fade extreme momentum (>0.5%).
3.  **Chop Filter:** Skip flat markets (<0.08% volatility).
4.  **Time Filter:** Only trade between **14 mins** and **8 mins** to expiry (Avoiding Theta Decay).

## Risk Management
- **Stop Loss:** Hard exit at -12c drawdown.
- **Take Profit:** Quick scalp at +8c gain.
- **Emergency Exit:** Force market sell at 2 mins to expiry (never hold to settlement).
- **Position Sizing:** Dynamic 5% of account balance (min $0.50).
- **Circuit Breaker:** Stop trading if daily loss exceeds $15.

## Technology
- **Runtime:** Node.js / TypeScript
- **Data Source:** Kraken WebSocket (Real-time BTC High/Low/Close)
- **Execution:** Kalshi API v2 (Limit Orders + IO)
- **State:** Persistent JSON state + Lockfile protection

## Setup
1.  **Install:**
    ```bash
    npm install
    npm run build
    ```
2.  **Configure:**
    Copy `.env.example` to `.env` and add your Kalshi API keys.
3.  **Run:**
    ```bash
    # Start the bot (runs continuously)
    node dist/swing.js
    ```

## Live Performance (Pilot)
- **Start Balance:** $8.86
- **Current Balance:** ~$9.10 (+2.7%)
- **Trades:** 3 Wins / 0 Losses

## Disclaimer
This software is for educational purposes only. Use at your own risk. Past performance does not guarantee future results.
