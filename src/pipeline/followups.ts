import type { TradeEvent } from '../types';
import type { FollowUpConfig } from '../config';

export interface FollowUp {
  mint: string;
  symbol: string;
  image?: string;
  alertMcSol: number;
  peakMcSol: number;
  lastMcSol: number;
  alertedAt: number;
  firedMilestones: number[];
}

export type FollowUpEvent =
  | { kind: 'up'; multiple: number }
  | { kind: 'dump' }
  | { kind: 'window' };

export interface FollowUpHooks {
  subscribe(mint: string): void;
  unsubscribe(mint: string): void;
  fire(fu: FollowUp, event: FollowUpEvent): void;
}

export class FollowUps {
  private items = new Map<string, FollowUp>();
  private milestones: number[];

  constructor(private cfg: FollowUpConfig, private hooks: FollowUpHooks) {
    this.milestones = [...cfg.milestones].sort((a, b) => a - b);
  }

  get size(): number { return this.items.size; }
  has(mint: string): boolean { return this.items.has(mint); }

  add(mint: string, symbol: string, alertMcSol: number, now: number, image?: string): void {
    if (this.items.has(mint)) return;
    this.items.set(mint, {
      mint, symbol, image, alertMcSol,
      peakMcSol: alertMcSol, lastMcSol: alertMcSol, alertedAt: now, firedMilestones: [],
    });
    this.hooks.subscribe(mint);
  }

  onTrade(trade: TradeEvent, _now: number): void {
    const fu = this.items.get(trade.mint);
    if (!fu) return;
    if (!(trade.marketCapSol > 0)) return;
    fu.lastMcSol = trade.marketCapSol;
    if (trade.marketCapSol > fu.peakMcSol) fu.peakMcSol = trade.marketCapSol;

    // up-Nx milestones — each fires once, based on peak vs the market cap at alert time
    const multiple = fu.alertMcSol > 0 ? fu.peakMcSol / fu.alertMcSol : 0;
    for (const m of this.milestones) {
      if (multiple >= m && !fu.firedMilestones.includes(m)) {
        fu.firedMilestones.push(m);
        this.hooks.fire(fu, { kind: 'up', multiple: m });
      }
    }

    // dump warning — a hard fall off the peak ends tracking
    const drawdown = fu.peakMcSol > 0 ? ((fu.peakMcSol - fu.lastMcSol) / fu.peakMcSol) * 100 : 0;
    if (drawdown > this.cfg.dumpAlertPct) {
      this.remove(fu.mint);
      this.hooks.fire(fu, { kind: 'dump' });
    }
  }

  sweep(now: number): void {
    const cutoff = now - this.cfg.windowMinutes * 60_000;
    for (const fu of [...this.items.values()]) {
      if (fu.alertedAt < cutoff) {
        this.remove(fu.mint);
        this.hooks.fire(fu, { kind: 'window' });
      }
    }
  }

  private remove(mint: string): void {
    this.items.delete(mint);
    this.hooks.unsubscribe(mint);
  }
}
