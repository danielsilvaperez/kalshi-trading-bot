import type { Fees, RiskConfig } from '../types/index.js';
import { RiskGuards } from '../risk/guards.js';
import { evaluateIntraMarketArb } from '../strategy/feeAwareArb.js';
import { evaluateDirectional, type DirectionalDecision } from '../strategy/directional.js';
import type { ArbDecision, MarketSnapshot } from '../types/index.js';
import { KalshiAdapter } from '../adapters/kalshiAdapter.js';
import { fetchBtcSpot, type SpotSnapshot } from '../adapters/spotPrice.js';
import { journal } from './journal.js';
import { FileLock } from './lock.js';
import { CircuitBreaker } from './circuitBreaker.js';

export interface EngineConfig {
  ticker?: string;
  autoDiscoverTicker: boolean;
  dryRun: boolean;
  allowLive: boolean;
  enableArb: boolean;
  enableDirectional: boolean;
  pollMs: number;
  fees: Fees;
  risk: RiskConfig;
  journalPath: string;
  lockPath: string;
  circuitBreakerThreshold: number;
}

export class ArbEngine {
  private risk: RiskGuards;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lock: FileLock;
  private breaker: CircuitBreaker;
  private lastSpot: SpotSnapshot | null = null;

  constructor(
    private cfg: EngineConfig,
    private kalshi: KalshiAdapter,
  ) {
    this.risk = new RiskGuards(cfg.risk);
    this.lock = new FileLock(cfg.lockPath);
    this.breaker = new CircuitBreaker(cfg.circuitBreakerThreshold);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.pollMs);
    console.log('[engine] started', {
      ticker: this.cfg.ticker ?? '(auto)',
      autoDiscoverTicker: this.cfg.autoDiscoverTicker,
      dryRun: this.cfg.dryRun,
      allowLive: this.cfg.allowLive,
      enableArb: this.cfg.enableArb,
      enableDirectional: this.cfg.enableDirectional,
      pollMs: this.cfg.pollMs,
    });
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log('[engine] stopped');
  }

  async runOnce() {
    await this.tick();
  }

  private async tick() {
    if (this.inFlight) return;
    if (!this.breaker.canRun()) {
      journal(this.cfg.journalPath, { type: 'skip', reason: 'circuit breaker open', breaker: this.breaker.status() });
      return;
    }
    if (!this.lock.acquire()) {
      journal(this.cfg.journalPath, { type: 'skip', reason: 'run lock active' });
      return;
    }

    this.inFlight = true;

    try {
      // Discover ticker
      let ticker = this.cfg.ticker;
      if (this.cfg.autoDiscoverTicker || !ticker) {
        const discovered = await this.kalshi.discoverActive15mBtcMarket({
          contains: 'BTC',
          minSecondsToExpiry: this.cfg.risk.minSecondsToExpiry,
        });
        if (!discovered) {
          journal(this.cfg.journalPath, { type: 'skip', reason: 'no active 15m btc market found' });
          return;
        }
        ticker = discovered.ticker;
        journal(this.cfg.journalPath, {
          type: 'discovered_market',
          ticker: discovered.ticker,
          secondsToExpiry: discovered.secondsToExpiry,
          title: discovered.title,
        });
      }

      const snap = await this.kalshi.getMarketSnapshot(ticker);
      const gate = this.risk.canTrade(Date.now(), snap.expiryTs);
      if (!gate.ok) {
        journal(this.cfg.journalPath, { type: 'skip', reason: gate.reason, ticker: snap.ticker });
        return;
      }

      let traded = false;

      // ===== STRATEGY 1: Structural arb =====
      if (this.cfg.enableArb) {
        traded = await this.tryArb(snap);
      }

      // ===== STRATEGY 2: Directional momentum =====
      if (this.cfg.enableDirectional && !traded) {
        traded = await this.tryDirectional(snap);
      }

      if (!traded) {
        journal(this.cfg.journalPath, { type: 'no_trade', ticker: snap.ticker });
      }

    } catch (err) {
      console.error('[engine] tick error', err);
      this.breaker.onFailure();
      journal(this.cfg.journalPath, { type: 'error', error: String(err), breaker: this.breaker.status() });
    } finally {
      this.inFlight = false;
      this.lock.release();
    }
  }

  // ======================== ARB ========================

  private async tryArb(snap: MarketSnapshot): Promise<boolean> {
    const d = evaluateIntraMarketArb(snap, this.cfg.fees, this.cfg.risk.maxNotionalPerTradeUsd);
    if (!d.ok) {
      journal(this.cfg.journalPath, { type: 'arb_skip', reason: d.reason, ticker: snap.ticker });
      return false;
    }

    const payload = {
      strategy: 'arb',
      ticker: snap.ticker,
      edgeCents: d.edgeCents,
      expectedProfitUsd: d.expectedProfitUsd,
      sizeContracts: d.sizeContracts,
      yesAsk: snap.top.yesAsk,
      noAsk: snap.top.noAsk,
    };

    if (this.cfg.dryRun || !this.cfg.allowLive) {
      console.log('[arb][dry]', payload);
      journal(this.cfg.journalPath, { type: 'arb_opportunity_dry', ...payload });
      this.breaker.onSuccess();
      return false;
    }

    return this.executeArbPair(snap, d, payload);
  }

  private async executeArbPair(
    snap: MarketSnapshot,
    d: ArbDecision,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const yesPrice = snap.top.yesAsk;
    const noPrice = snap.top.noAsk;
    if (yesPrice == null || noPrice == null || !d.sizeContracts) return false;

    this.risk.onOpenPosition();

    const leg1 = await this.kalshi.placeOrder({
      ticker: snap.ticker, side: 'yes', action: 'buy',
      count: d.sizeContracts, price: yesPrice, type: 'limit', time_in_force: 'ioc',
    });

    if (!leg1.ok) {
      this.risk.onClosePosition(0);
      this.breaker.onFailure();
      journal(this.cfg.journalPath, { type: 'arb_fail', leg: 1, error: leg1.error, ...payload, breaker: this.breaker.status() });
      return false;
    }

    const leg2 = await this.kalshi.placeOrder({
      ticker: snap.ticker, side: 'no', action: 'buy',
      count: d.sizeContracts, price: noPrice, type: 'limit', time_in_force: 'ioc',
    });

    if (!leg2.ok) {
      await this.kalshi.placeOrder({
        ticker: snap.ticker, side: 'yes', action: 'sell',
        count: d.sizeContracts, price: yesPrice, type: 'limit', time_in_force: 'ioc',
      });
      this.risk.onClosePosition(-0.5);
      this.breaker.onFailure();
      journal(this.cfg.journalPath, { type: 'arb_partial_unwind', leg1, leg2, ...payload, breaker: this.breaker.status() });
      return false;
    }

    this.risk.onClosePosition(0);
    this.breaker.onSuccess();
    journal(this.cfg.journalPath, { type: 'arb_executed', leg1, leg2, ...payload, breaker: this.breaker.status() });
    console.log('[arb][live] executed paired orders', payload);
    return true;
  }

  // ======================== DIRECTIONAL ========================

  private async tryDirectional(snap: MarketSnapshot): Promise<boolean> {
    // Fetch spot
    let currentSpot: SpotSnapshot;
    try {
      currentSpot = await fetchBtcSpot();
    } catch (err) {
      journal(this.cfg.journalPath, { type: 'directional_skip', reason: 'spot fetch failed', error: String(err) });
      return false;
    }

    const recentSpot = this.lastSpot ?? currentSpot;
    this.lastSpot = currentSpot;

    // Extract strike from market (use midpoint of YES/NO as proxy if not explicit)
    // For Kalshi BTC markets, strike is usually embedded in ticker or market data.
    // For now approximate: if YES is cheap, strike is above spot; if NO is cheap, strike is below.
    const strikeEstimate = currentSpot.price; // conservative: assume strike ≈ current price

    const d = evaluateDirectional(
      snap,
      currentSpot,
      recentSpot,
      strikeEstimate,
      this.cfg.risk.maxNotionalPerTradeUsd,
    );

    if (!d.ok) {
      journal(this.cfg.journalPath, { type: 'directional_skip', reason: d.reason, ticker: snap.ticker, spotPrice: currentSpot.price });
      return false;
    }

    const payload = {
      strategy: 'directional',
      ticker: snap.ticker,
      side: d.side,
      confidence: d.confidence,
      entryPrice: d.entryPrice,
      sizeContracts: d.sizeContracts,
      spotPrice: d.spotPrice,
      delta: d.delta,
    };

    if (this.cfg.dryRun || !this.cfg.allowLive) {
      console.log('[directional][dry]', payload);
      journal(this.cfg.journalPath, { type: 'directional_opportunity_dry', ...payload });
      this.breaker.onSuccess();
      return false;
    }

    return this.executeDirectional(snap, d, payload);
  }

  private async executeDirectional(
    snap: MarketSnapshot,
    d: DirectionalDecision,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    if (!d.side || !d.entryPrice || !d.sizeContracts) return false;

    this.risk.onOpenPosition();

    const order = await this.kalshi.placeOrder({
      ticker: snap.ticker,
      side: d.side === 'YES' ? 'yes' : 'no',
      action: 'buy',
      count: d.sizeContracts,
      price: d.entryPrice,
      type: 'limit',
      time_in_force: 'ioc',
    });

    if (!order.ok) {
      this.risk.onClosePosition(0);
      this.breaker.onFailure();
      journal(this.cfg.journalPath, { type: 'directional_fail', error: order.error, ...payload, breaker: this.breaker.status() });
      return false;
    }

    // Position stays open until settlement (15m window resolves)
    this.breaker.onSuccess();
    journal(this.cfg.journalPath, { type: 'directional_executed', orderId: order.orderId, ...payload, breaker: this.breaker.status() });
    console.log('[directional][live] order placed', payload);
    return true;
  }
}
