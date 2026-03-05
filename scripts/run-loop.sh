#!/bin/bash
# Infinite loop to keep the bot running
LOCK_FILE="./tmp/swing.lock"

while true; do
  echo "[$(date)] Starting Swing Bot v13..."
  
  # Clear stale lock if it exists (force start)
  if [ -f "$LOCK_FILE" ]; then
    echo "Removing stale lock file..."
    rm "$LOCK_FILE"
  fi
  
  # Run the bot
  node dist/swing.js >> logs/swing.log 2>&1
  
  EXIT_CODE=$?
  echo "[$(date)] Bot exited with code $EXIT_CODE. Restarting in 5s..."
  
  sleep 5
done
