#!/bin/bash
# Watchdog - ensures scalper runs 24/7

cd "$(dirname "$0")/.."

# Check if running
if ! pgrep -f "node dist/scalper.js" > /dev/null; then
    echo "[$(date)] Scalper not running, restarting..." >> logs/watchdog.log
    
    # Clean up stale locks
    rm -f tmp/scalper.lock tmp/scalper.pid
    
    # Start it
    nohup node dist/scalper.js > /dev/null 2>&1 &
    
    echo "[$(date)] Started scalper (PID $!)" >> logs/watchdog.log
fi
