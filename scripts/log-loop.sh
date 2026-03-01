#!/bin/bash
# Log Forwarder Loop — runs forever, checks logs every 60s, no AI tokens
# FIXED: Added MAX_HISTORY limit to prevent spam on restart

LOG_PATH="/home/danny/.openclaw/workspace/trading-core/logs/trading-15m.jsonl"
LAST_POS_FILE="/home/danny/.openclaw/workspace/trading-core/tmp/.telegram-last-pos"
CHAT_ID="8208882081"
MAX_HISTORY=5  # Only send last 5 entries max on startup

# Get bot token from env
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

if [ -z "$BOT_TOKEN" ]; then
  echo "TELEGRAM_BOT_TOKEN not set"
  exit 1
fi

# Initialize position file if missing or reset
init_position() {
  if [ -f "$LOG_PATH" ]; then
    local file_size=$(stat -c%s "$LOG_PATH" 2>/dev/null || echo 0)
    echo "$file_size" > "$LAST_POS_FILE"
    echo "Initialized position to $file_size"
  else
    echo "0" > "$LAST_POS_FILE"
  fi
}

# Get last read position
get_position() {
  if [ -f "$LAST_POS_FILE" ]; then
    cat "$LAST_POS_FILE"
  else
    echo "0"
  fi
}

mkdir -p "$(dirname "$LAST_POS_FILE")"

# Initialize on first run if needed
LAST_POS=$(get_position)
if [ "$LAST_POS" -eq "0" ] && [ -f "$LOG_PATH" ]; then
  init_position
  LAST_POS=$(get_position)
fi

send_msg() {
  local text="$1"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${text}" \
    -d "parse_mode=Markdown" > /dev/null 2>&1
}

check_logs() {
  if [ ! -f "$LOG_PATH" ]; then
    return
  fi

  CURRENT_SIZE=$(stat -c%s "$LOG_PATH" 2>/dev/null || echo 0)
  
  if [ "$CURRENT_SIZE" -le "$LAST_POS" ]; then
    return
  fi

  # Calculate bytes to read
  BYTES_TO_READ=$((CURRENT_SIZE - LAST_POS))
  
  # Limit history on fresh start (prevent spam)
  if [ "$BYTES_TO_READ" -gt 5000 ]; then
    echo "Large log catchup detected ($BYTES_TO_READ bytes), limiting to last $MAX_HISTORY entries"
    # Just update position and skip spam
    echo "$CURRENT_SIZE" > "$LAST_POS_FILE"
    LAST_POS=$CURRENT_SIZE
    return
  fi

  # Extract new content
  local count=0
  tail -c +$((LAST_POS + 1)) "$LOG_PATH" 2>/dev/null | while read -r line; do
    [ -z "$line" ] && continue
    
    count=$((count + 1))
    if [ "$count" -gt "$MAX_HISTORY" ]; then
      break
    fi
    
    # Parse JSON minimally using grep/sed
    type=$(echo "$line" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
    ts=$(echo "$line" | grep -o '"ts":"[^"]*"' | cut -d'"' -f4)
    
    # Format time
    time_str=$(date -d "$ts" +"%H:%M" 2>/dev/null || echo "??:??")
    
    case "$type" in
      "15m_executed")
        side=$(echo "$line" | grep -o '"side":"[^"]*"' | cut -d'"' -f4)
        price=$(echo "$line" | grep -o '"price":[0-9]*' | cut -d':' -f2)
        count=$(echo "$line" | grep -o '"count":[0-9]*' | cut -d':' -f2)
        ev=$(echo "$line" | grep -o '"ev":[0-9.]*' | cut -d':' -f2 | head -1)
        status=$(echo "$line" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
        fill=$(echo "$line" | grep -o '"fillCount":[0-9]*' | cut -d':' -f2)
        msg="✅ *TRADE* \`$time_str\`\nSide: ${side^^} @ ${price}c ×${count}\nEV: ${ev}c\nStatus: ${status}"
        [ -n "$fill" ] && msg="$msg (${fill}/${count} filled)"
        send_msg "$msg"
        ;;
      "15m_skip")
        reason=$(echo "$line" | grep -o '"reason":"[^"]*"' | cut -d'"' -f4)
        msg="⏭️ *SKIP* \`$time_str\`\n${reason}"
        send_msg "$msg"
        ;;
      "self_improve")
        pnl=$(echo "$line" | grep -o '"realizedPnlCents":[0-9.-]*' | cut -d':' -f2)
        [ -n "$pnl" ] && send_msg "📊 *CALIBRATE* \`$time_str\`\nPnL: ${pnl}c"
        ;;
    esac
  done

  echo "$CURRENT_SIZE" > "$LAST_POS_FILE"
  LAST_POS=$CURRENT_SIZE
}

# Main loop
echo "Log forwarder started at $(date)"
echo "Position: $LAST_POS"
check_logs  # Initial check

while true; do
  sleep 60
  check_logs
done
