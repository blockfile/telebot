import type { TradeEvent } from '../types';
import type { FollowUpConfig } from '../config';

export interface FollowUp {
  mint: string;
  symbol: string;
  alertMcSol: number;
  peakMcSol: number;
  lastMcSol: number;
  alertedAt: number;
}

export interface FollowUpHooks {
  subscribe(mint: string): void;
  unsubscribe(mint: string): void;
  fire(fu: FollowUp, reason: 'window' | 'dump'): void;
}

export class FollowUps {
  private items = new Map<string, FollowUp>();

  constructor(private cfg: FollowUpConfig, private hooks: FollowUpHooks) {}

  get size(): number { return this.items.size; }
  has(mint: string): boolean { return this.items.has(mint); }

  add(mint: string, symbol: string, alertMcSol: number, now: number): void {
    if (this.items.has(mint)) return;
    this.items.set(mint, { mint, symbol, alertMcSol, peakMcSol: alertMcSol, lastMcSol: alertMcSol, alertedAt: now });
    this.hooks.subscribe(mint);
  }

  onTrade(trade: TradeEvent, _now: number): void {
    const fu = this.items.get(trade.mint);
    if (!fu) return;
    fu.lastMcSol = trade.marketCapSol;
    if (trade.marketCapSol > fu.peakMcSol) fu.peakMcSol = trade.marketCapSol;
    const drawdown = fu.peakMcSol > 0 ? ((fu.peakMcSol - fu.lastMcSol) / fu.peakMcSol) * 100 : 0;
    if (drawdown > this.cfg.dumpAlertPct) {
      this.remove(fu.mint);
      this.hooks.fire(fu, 'dump');
    }
  }

  sweep(now: number): void {
    const cutoff = now - this.cfg.windowMinutes * 60_000;
    for (const fu of [...this.items.values()]) {
      if (fu.alertedAt < cutoff) {
        this.remove(fu.mint);
        this.hooks.fire(fu, 'window');
      }
    }
  }

  private remove(mint: string): void {
    this.items.delete(mint);
    this.hooks.unsubscribe(mint);
  }
}
