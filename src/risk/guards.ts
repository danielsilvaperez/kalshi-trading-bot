import type { RiskConfig } from '../types/index.js';

export class RiskGuards {
  private dailyRealizedPnlUsd = 0;
  private openPositions = 0;

  constructor(private cfg: RiskConfig) {}

  canTrade(nowTs: number, expiryTs: number): { ok: boolean; reason?: string } {
    if (this.cfg.killSwitch) return { ok: false, reason: 'kill switch enabled' };
    if (this.dailyRealizedPnlUsd <= -Math.abs(this.cfg.maxDailyLossUsd)) {
      return { ok: false, reason: 'daily loss limit reached' };
    }
    if (this.openPositions >= this.cfg.maxOpenPositions) {
      return { ok: false, reason: 'max open positions reached' };
    }
    const secsToExpiry = Math.floor((expiryTs - nowTs) / 1000);
    if (secsToExpiry < this.cfg.minSecondsToExpiry) {
      return { ok: false, reason: 'too close to expiry' };
    }
    return { ok: true };
  }

  onOpenPosition(): void {
    this.openPositions += 1;
  }

  onClosePosition(realizedPnlUsd: number): void {
    this.openPositions = Math.max(0, this.openPositions - 1);
    this.dailyRealizedPnlUsd += realizedPnlUsd;
  }

  snapshot() {
    return {
      dailyRealizedPnlUsd: this.dailyRealizedPnlUsd,
      openPositions: this.openPositions,
    };
  }
}
