import type { NewTokenEvent, TradeEvent, TokenMeta } from '../types';
import type { WatchConfig } from '../config';

export interface WatchedToken {
  event: NewTokenEvent;
  meta: TokenMeta;
  buyers: Set<string>;
  buys: number;
  sells: number;
  devSold: boolean;
  earlyBuyers: Set<string>;
  lastMarketCapSol: number;
  peakMarketCapSol: number;
  lastVSolInCurve: number;
  volumeSol: number;
  addedAt: number;
}

export interface WatchlistHooks {
  onTrigger(t: WatchedToken): void;
  onDisqualify(t: WatchedToken, reason: string): void;
  onExpire(t: WatchedToken): void;
  subscribe(mint: string): void;
  unsubscribe(mint: string): void;
}

export class Watchlist {
  private tokens = new Map<string, WatchedToken>();

  constructor(private cfg: WatchConfig, private hooks: WatchlistHooks) {}

  get size(): number { return this.tokens.size; }
  mints(): string[] { return [...this.tokens.keys()]; }

  add(event: NewTokenEvent, meta: TokenMeta, now: number): void {
    if (this.tokens.has(event.mint)) return;
    if (this.tokens.size >= this.cfg.maxConcurrent) {
      let oldest: WatchedToken | null = null;
      for (const t of this.tokens.values()) {
        if (!oldest || t.addedAt < oldest.addedAt) oldest = t;
      }
      if (oldest) {
        this.remove(oldest.event.mint);
        this.hooks.onExpire(oldest);
      }
    }
    this.tokens.set(event.mint, {
      event, meta, buyers: new Set(), buys: 0, sells: 0, devSold: false,
      earlyBuyers: new Set(), lastMarketCapSol: event.marketCapSol, peakMarketCapSol: event.marketCapSol,
      lastVSolInCurve: event.vSolInBondingCurve, volumeSol: 0, addedAt: now,
    });
    this.hooks.subscribe(event.mint);
  }

  onTrade(trade: TradeEvent, solUsd: number, now: number): void {
    const t = this.tokens.get(trade.mint);
    if (!t) return;
    t.lastMarketCapSol = trade.marketCapSol;
    if (trade.marketCapSol > t.peakMarketCapSol) t.peakMarketCapSol = trade.marketCapSol;
    if (trade.vSolInBondingCurve > 0) t.lastVSolInCurve = trade.vSolInBondingCurve;
    t.volumeSol += trade.solAmount; // total traded volume (all trades) — used for the traction gate
    const isDev = trade.trader === t.event.creator;

    if (!trade.isBuy) {
      t.sells++;
      if (isDev) {
        t.devSold = true;
        this.remove(trade.mint);
        this.hooks.onDisqualify(t, 'dev sold');
      }
      return;
    }

    t.buys++;
    if (isDev) return;
    t.buyers.add(trade.trader);

    if (now - t.addedAt <= this.cfg.bundleWindowMs) {
      t.earlyBuyers.add(trade.trader);
      if (t.earlyBuyers.size >= this.cfg.bundleMaxBuyers) {
        this.remove(trade.mint);
        this.hooks.onDisqualify(t, `bundled: ${t.earlyBuyers.size} buyers within ${this.cfg.bundleWindowMs}ms of mint`);
        return;
      }
    }

    const mcUsd = trade.marketCapSol * solUsd;
    const volUsd = t.volumeSol * solUsd;
    if (
      mcUsd >= this.cfg.triggerMarketCapUsd &&
      volUsd >= this.cfg.triggerVolumeUsd &&
      t.buyers.size >= this.cfg.triggerUniqueBuyers
    ) {
      this.remove(trade.mint);
      this.hooks.onTrigger(t);
    }
  }

  sweep(now: number): void {
    const cutoff = now - this.cfg.windowMinutes * 60_000;
    for (const t of [...this.tokens.values()]) {
      if (t.addedAt < cutoff) {
        this.remove(t.event.mint);
        this.hooks.onExpire(t);
      }
    }
  }

  private remove(mint: string): void {
    this.tokens.delete(mint);
    this.hooks.unsubscribe(mint);
  }
}
