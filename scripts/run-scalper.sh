#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Kill any existing scalper
for pid in $(pgrep -f "node.*dist/scalper" 2>/dev/null || true); do
    kill -9 "$pid" 2>/dev/null || true
done

# Clean locks
rm -f tmp/scalper.lock tmp/scalper.pid

# Wait for processes to die
sleep 1

# Verify none running
if pgrep -f "node.*dist/scalper" > /dev/null 2>&1; then
    echo "ERROR: Could not kill existing scalper"
    exit 1
fi

# Create dirs
mkdir -p logs tmp

# Start single instance
nohup node dist/scalper.js > /dev/null 2>&1 &
PID=$!

sleep 2

# Verify started
if ! kill -0 "$PID" 2>/dev/null; then
    echo "ERROR: Scalper failed to start"
    exit 1
fi

echo "Scalper v4 started (PID $PID)"
echo "Logs: tail -f logs/scalper.log"
