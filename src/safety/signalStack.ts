import { readFileSync, existsSync } from 'node:fs';

// Require at least 2 of 3 signals to align for entry
interface SignalStack {
  momentum: boolean;
  crossMarket: boolean;
  depth: boolean;
  total: number;
  passes: boolean;
}

export function checkSignalStack(
  momentumDirection: 'up' | 'down' | 'flat',
  tradeSide: 'yes' | 'no',
  crossMarketEdge: number, // cents
  depthImbalance: number,
): SignalStack {
  const momentum = momentumDirection !== 'flat' && (
    (momentumDirection === 'up' && tradeSide === 'yes') ||
    (momentumDirection === 'down' && tradeSide === 'no')
  );

  const crossMarket = crossMarketEdge >= 2; // at least 2c edge

  const depth = tradeSide === 'yes' ? depthImbalance > 0 : depthImbalance < 0;

  const total = (momentum ? 1 : 0) + (crossMarket ? 1 : 0) + (depth ? 1 : 0);

  return {
    momentum,
    crossMarket,
    depth,
    total,
    passes: total >= 1, // trade on any signal (momentum sufficient)
  };
}

export function formatSignalStack(stack: SignalStack): string {
  return `signals: mom=${stack.momentum ? 'Y' : 'N'} cross=${stack.crossMarket ? 'Y' : 'N'} depth=${stack.depth ? 'Y' : 'N'} (${stack.total}/3)`;
}
