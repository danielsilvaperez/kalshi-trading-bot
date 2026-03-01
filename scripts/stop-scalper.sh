#!/bin/bash
# Stop the scalper

cd "$(dirname "$0")/.."

if [ -f tmp/scalper.pid ]; then
    PID=$(cat tmp/scalper.pid)
    if kill -0 $PID 2>/dev/null; then
        kill $PID
        echo "Stopped scalper (PID $PID)"
        rm tmp/scalper.pid
    else
        echo "Scalper not running (stale PID)"
        rm tmp/scalper.pid
    fi
else
    # Try to find and kill by name
    pkill -f "node dist/scalper.js" && echo "Stopped scalper" || echo "Scalper not running"
fi
