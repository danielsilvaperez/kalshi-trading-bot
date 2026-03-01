export type Side = 'YES' | 'NO';

export interface BookTop {
  yesAsk: number | null;
  noAsk: number | null;
  yesBid: number | null;
  noBid: number | null;
  ts: number;
}

export interface MarketSnapshot {
  ticker: string;
  expiryTs: number;
  top: BookTop;
}

export interface Fees {
  perContractCents: number;
  roundTripSlippageCents: number;
}

export interface RiskConfig {
  maxDailyLossUsd: number;
  maxNotionalPerTradeUsd: number;
  maxOpenPositions: number;
  minSecondsToExpiry: number;
  killSwitch: boolean;
}

export interface ArbDecision {
  ok: boolean;
  reason?: string;
  edgeCents?: number;
  expectedProfitUsd?: number;
  sizeContracts?: number;
}
