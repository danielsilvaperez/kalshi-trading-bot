#!/usr/bin/env node
/**
 * Log Forwarder — Sends trading bot updates to Telegram
 * No AI, no models, just raw log tailing.
 */

const { readFileSync, existsSync } = require('fs');
const { execSync } = require('child_process');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8208882081';
const LOG_PATH = process.env.LOG_PATH || './logs/trading-15m.jsonl';
const LAST_POS_PATH = './tmp/.telegram-last-pos';

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

function getLastPosition() {
  try {
    return parseInt(readFileSync(LAST_POS_PATH, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function savePosition(pos) {
  try {
    require('fs').mkdirSync('./tmp', { recursive: true });
    require('fs').writeFileSync(LAST_POS_PATH, String(pos));
  } catch {}
}

function sendMessage(text) {
  const cmd = `curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \\
    -d "chat_id=${CHAT_ID}" \\
    -d "text=${encodeURIComponent(text)}" \\
    -d "parse_mode=Markdown"`;
  
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 10000 });
  } catch (e) {
    console.error('Failed to send:', e.message);
  }
}

function main() {
  if (!existsSync(LOG_PATH)) {
    console.log('No log file yet');
    return;
  }

  const lastPos = getLastPosition();
  const content = readFileSync(LOG_PATH, 'utf8');
  const currentPos = content.length;

  if (currentPos <= lastPos) {
    // No new data
    return;
  }

  // Get new lines since last check
  const newContent = content.slice(lastPos);
  const lines = newContent.split('\n').filter(Boolean);

  if (lines.length === 0) return;

  // Process last 3 entries max (rate limiting)
  const recentLines = lines.slice(-3);
  
  for (const line of recentLines) {
    try {
      const entry = JSON.parse(line);
      const time = new Date(entry.ts).toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false 
      });
      
      let msg = '';
      
      if (entry.type === '15m_executed') {
        msg = `✅ *TRADE* \`${time}\`\n` +
              `Side: ${entry.side.toUpperCase()} @ ${entry.price}c ×${entry.count}\n` +
              `EV: ${entry.ev?.toFixed(2)}c | BTC: $${entry.btcSpot?.toFixed(0)}\n` +
              `Status: ${entry.status}`;
        if (entry.fillCount > 0) msg += ` (${entry.fillCount}/${entry.count} filled)`;
      } 
      else if (entry.type === '15m_skip') {
        msg = `⏭️ *SKIP* \`${time}\`\n` +
              `Reason: ${entry.reason}\n` +
              `YES: ${entry.yesAsk}c | NO: ${entry.noAsk}c`;
      }
      else if (entry.type === 'self_improve') {
        msg = `📊 *CALIBRATE* \`${time}\`\n` +
              `PnL: ${entry.realizedPnlCents > 0 ? '+' : ''}${entry.realizedPnlCents}c\n` +
              `MinEV: ${entry.after?.minEvCents}c | MaxSpend: ${entry.after?.maxSpendCents}c`;
      }

      if (msg) sendMessage(msg);
    } catch {}
  }

  savePosition(currentPos);
}

main();
