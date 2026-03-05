# Kalshi BTC Volatility Scalper (v14)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)

**Status:** LIVE

A high-frequency trading bot for Kalshi's **BTC 15-minute binary prediction markets**. Detects volatility expansions using real-time Kraken WebSocket price feeds and executes limit orders via the Kalshi API v2.

---

## Architecture / How It Works

The bot runs a continuous event loop fed by a live Kraken WebSocket stream. On each new 15-minute candle close it:

1. **Computes signals** — volatility (ATR), momentum (rate-of-change), and spread indicators
2. **Filters with ML** — an XGBoost model (trained on 70k historical candles) gates each entry
3. **Sizes the position** — Kelly criterion with a volatility-regime overlay
4. **Places a limit order** — via Kalshi API v2, with an IO (Immediate-or-Cancel) fallback
5. **Manages risk** — monitors for stop-loss, take-profit, flash-crash, and time-to-expiry conditions concurrently
6. **Reports** — Telegram alerts for fills, exits, daily P&L summary, and circuit-breaker events

### Dual Strategy

| Strategy | Trigger | Hold Time |
|---|---|---|
| **SWING** | Volatility expansion + momentum alignment | Up to market expiry |
| **SCALPER** | Spread arb between YES/NO prices | `<` 2 minutes |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 / TypeScript 5 |
| Market data | Kraken WebSocket API (real-time OHLCV) |
| Execution | Kalshi REST API v2 (RSA-signed requests) |
| ML inference | XGBoost model served via Python (`scripts/train-ml.py`) |
| Process management | systemd + custom watchdog (`scripts/watchdog.sh`) |
| Monitoring | Telegram Bot API |

---

## Project Structure

```
kalshi-trading-bot/
├── src/
│   ├── swing.ts              # Main SWING strategy loop
│   ├── scalper.ts            # SCALPER strategy loop
│   ├── strategy/             # btc15m, directional, spreadArbitrage
│   ├── safety/               # Kelly sizing, circuit breaker, flash-crash, kill switch
│   ├── ml/                   # XGBoost predictor, meta-strategy, RL layer
│   ├── adapters/             # Kalshi API v2 client, Kraken WebSocket
│   └── analysis/             # Multi-timeframe, order flow, microstructure
├── scripts/
│   ├── train-ml.py           # XGBoost training pipeline (70k candles)
│   ├── run-scalper.sh        # Launch script with env validation
│   └── watchdog.sh           # Process health monitor
├── models/
│   └── entry_filter.json     # Serialised XGBoost model
├── .env.example              # All required environment variables (no secrets)
├── kalshi-bot.service        # systemd unit for SWING bot
└── scalper.service           # systemd unit for SCALPER bot
```

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/danielsilvaperez/kalshi-trading-bot.git
cd kalshi-trading-bot
npm install
npm run build
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env with your credentials (see .env.example for all required fields)
```

Required variables:

| Variable | Description |
|---|---|
| `KALSHI_KEY_ID` | Kalshi API key ID (from dashboard) |
| `KALSHI_PRIVATE_KEY_PATH` | Path to your RSA private key `.pem` file |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

### 3. Run

```bash
# SWING strategy (main)
node dist/swing.js

# SCALPER strategy
node dist/scalper.js

# Or via systemd (production)
sudo systemctl start kalshi-bot
```

---

## Risk Management

| Control | Setting |
|---|---|
| Stop Loss | Hard exit at -12c drawdown |
| Take Profit | Scalp exit at +8c gain |
| Emergency Exit | Force market sell at 2 min to expiry |
| Position Sizing | Kelly criterion, capped at 5% of account |
| Circuit Breaker | Halt trading if daily loss exceeds $15 |
| Flash-Crash Guard | Suspend on anomalous volatility spike |
| Kill Switch | Manual emergency halt via Telegram command |

---

## Live Performance (Pilot)

| Metric | Value |
|---|---|
| Start Balance | $8.86 |
| Balance after 3 trades | ~$9.10 |
| Win / Loss | 3 / 0 |
| Gross Return | +2.7% |

> **Note:** This is a small live pilot (3 trades). Results are not statistically significant and are not indicative of future performance. This project is for educational and research purposes.

---

## Security

All secrets (API keys, RSA private key path, Telegram tokens) are loaded exclusively from environment variables at startup. The bot validates that all required variables are present before initialising any network connections.

- `.env` is excluded from version control via `.gitignore`
- RSA private key files (`*.pem`, `*.key`) are also excluded
- See `.env.example` for the full list of required variables

---

## Disclaimer

This software is for educational purposes only. Trading binary prediction markets involves substantial risk of loss. Use at your own risk. Past performance does not guarantee future results.
