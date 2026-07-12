import { describe, it, expect, beforeEach } from 'vitest';
import { FollowUps, type FollowUp, type FollowUpEvent } from '../src/pipeline/followups';
import type { TradeEvent } from '../src/types';

const CFG = { windowMinutes: 60, dumpAlertPct: 50, milestones: [2, 5, 10], liveEditSec: 45 };
const trade = (mint: string, marketCapSol: number): TradeEvent =>
  ({ mint, trader: 't', isBuy: true, tokenAmount: 1, solAmount: 1, marketCapSol, vSolInBondingCurve: 30, signature: 's', receivedAt: 0 });

describe('FollowUps', () => {
  let fired: Array<[FollowUp, FollowUpEvent]>; let subs: string[]; let unsubs: string[]; let fu: FollowUps;
  beforeEach(() => {
    fired = []; subs = []; unsubs = [];
    fu = new FollowUps(CFG, { subscribe: (m) => subs.push(m), unsubscribe: (m) => unsubs.push(m), fire: (f, e) => fired.push([f, e]) });
  });

  it('subscribes on add and tracks peak/last without firing early', () => {
    fu.add('m1', 'COOL', 100, 0);
    expect(subs).toEqual(['m1']);
    fu.onTrade(trade('m1', 150), 1000); // 1.5X — below first milestone
    fu.onTrade(trade('m1', 120), 2000);
    expect(fired).toHaveLength(0);
    expect(fu.has('m1')).toBe(true);
  });

  it('fires each up-Nx milestone once as the peak crosses it, and keeps tracking', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 200), 1000); // 2X
    expect(fired.map(([, e]) => e)).toEqual([{ kind: 'up', multiple: 2 }]);
    expect(fu.has('m1')).toBe(true);         // still tracked
    expect(unsubs).toEqual([]);
    fu.onTrade(trade('m1', 260), 1500);      // 2.6X — no new milestone
    expect(fired).toHaveLength(1);
    fu.onTrade(trade('m1', 500), 2000);      // 5X
    expect(fired.map(([, e]) => e)).toEqual([{ kind: 'up', multiple: 2 }, { kind: 'up', multiple: 5 }]);
  });

  it('fires every milestone crossed by a single big jump, once each', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 1200), 1000); // 12X in one trade
    expect(fired.map(([, e]) => e)).toEqual([
      { kind: 'up', multiple: 2 }, { kind: 'up', multiple: 5 }, { kind: 'up', multiple: 10 },
    ]);
  });

  it('fires a dump follow-up when it falls >50% off peak, once', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 200), 1000); // peak 200 (also 2X — up card)
    fu.onTrade(trade('m1', 90), 2000);  // -55% off peak
    expect(fired.map(([, e]) => e.kind)).toEqual(['up', 'dump']);
    expect(unsubs).toEqual(['m1']);
    fu.onTrade(trade('m1', 80), 3000);  // already gone — no more fires
    expect(fired).toHaveLength(2);
  });

  it('ignores a zero market-cap trade (no spurious dump)', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 0), 1000);
    expect(fired).toHaveLength(0);
    expect(fu.has('m1')).toBe(true);
  });

  it('fires a window follow-up after the window elapses', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 130), 1000);
    fu.sweep(60 * 60_000 + 1);
    expect(fired).toHaveLength(1);
    expect(fired[0][1]).toEqual({ kind: 'window' });
    expect(fired[0][0].peakMcSol).toBe(130);
    expect(unsubs).toEqual(['m1']);
    expect(fu.size).toBe(0);
  });

  it('carries the token image through for follow-up cards', () => {
    fu.add('m1', 'COOL', 100, 0, 'ipfs://img');
    fu.onTrade(trade('m1', 200), 1000);
    expect(fired[0][0].image).toBe('ipfs://img');
  });
});
