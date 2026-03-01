import { readFileSync, existsSync, appendFileSync } from 'node:fs';

interface State {
  price: number;
  position: 'none' | 'long' | 'short';
  entryPrice: number;
  pnl: number;
}

interface Action {
  side: 'yes' | 'no' | 'hold';
  size: number;
  confidence: number;
}

interface Reward {
  reward: number;
  newState: State;
}

const Q_TABLE_PATH = process.env.Q_TABLE_PATH || './tmp/q-table.json';
const LEARNING_RATE = 0.1;
const DISCOUNT_FACTOR = 0.95;
const EXPLORATION_RATE = 0.1;

/**
 * Discretize state for Q-table lookup
 */
function discretizeState(
  momentum: number,
  spread: number,
  depthImb: number,
  timeToClose: number,
): string {
  const mBin = momentum > 0.001 ? 'up' : momentum < -0.001 ? 'down' : 'flat';
  const sBin = spread < 5 ? 'tight' : spread < 15 ? 'normal' : 'wide';
  const dBin = depthImb > 0.2 ? 'yes_heavy' : depthImb < -0.2 ? 'no_heavy' : 'balanced';
  const tBin = timeToClose < 3 ? 'urgent' : timeToClose < 8 ? 'normal' : 'early';
  return `${mBin}_${sBin}_${dBin}_${tBin}`;
}

function loadQTable(): Record<string, Record<string, number>> {
  if (!existsSync(Q_TABLE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(Q_TABLE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveQTable(table: Record<string, Record<string, number>>) {
  const { writeFileSync } = require('node:fs');
  writeFileSync(Q_TABLE_PATH, JSON.stringify(table, null, 2));
}

/**
 * Q-Learning action selection
 */
export function selectRLAction(
  momentum: number,
  spread: number,
  depthImb: number,
  timeToClose: number,
  ev: number,
): Action {
  const qTable = loadQTable();
  const state = discretizeState(momentum, spread, depthImb, timeToClose);

  if (!qTable[state]) {
    qTable[state] = { yes: 0, no: 0, hold: 0 };
  }

  // Exploration vs exploitation
  if (Math.random() < EXPLORATION_RATE) {
    const actions: ('yes' | 'no' | 'hold')[] = ['yes', 'no', 'hold'];
    const random = actions[Math.floor(Math.random() * actions.length)];
    return { side: random, size: random === 'hold' ? 0 : 1, confidence: 0.3 };
  }

  // Exploitation: pick best action
  const qValues = qTable[state];
  const bestAction = Object.entries(qValues).sort((a, b) => b[1] - a[1])[0][0] as 'yes' | 'no' | 'hold';
  const confidence = Math.min(0.9, 0.5 + Math.abs(qValues[bestAction]) / 10);

  return {
    side: bestAction,
    size: bestAction === 'hold' ? 0 : 1,
    confidence,
  };
}

/**
 * Update Q-table after outcome
 */
export function updateRL(
  momentum: number,
  spread: number,
  depthImb: number,
  timeToClose: number,
  action: 'yes' | 'no' | 'hold',
  reward: number,
): void {
  const qTable = loadQTable();
  const state = discretizeState(momentum, spread, depthImb, timeToClose);

  if (!qTable[state]) {
    qTable[state] = { yes: 0, no: 0, hold: 0 };
  }

  // Q-learning update: Q(s,a) = Q(s,a) + α * (r + γ * max(Q(s')) - Q(s,a))
  const currentQ = qTable[state][action];
  const maxNextQ = Math.max(...Object.values(qTable[state]));
  const newQ = currentQ + LEARNING_RATE * (reward + DISCOUNT_FACTOR * maxNextQ - currentQ);

  qTable[state][action] = newQ;
  saveQTable(qTable);

  // Log update
  appendFileSync('./logs/rl-updates.jsonl', JSON.stringify({
    ts: new Date().toISOString(),
    state,
    action,
    reward,
    oldQ: currentQ,
    newQ,
  }) + '\n');
}

/**
 * Convert trade outcome to RL reward
 */
export function calculateReward(profitCents: number): number {
  // Normalize to -1 to +1 range
  if (profitCents > 0) return Math.min(1, profitCents / 50);
  if (profitCents < 0) return Math.max(-1, profitCents / 50);
  return -0.1; // Small penalty for breakeven (opportunity cost)
}
