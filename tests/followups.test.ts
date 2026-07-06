import { describe, it, expect, beforeEach } from 'vitest';
import { FollowUps, type FollowUp } from '../src/pipeline/followups';
import type { TradeEvent } from '../src/types';

const CFG = { windowMinutes: 60, dumpAlertPct: 50 };
const trade = (mint: string, marketCapSol: number): TradeEvent =>
  ({ mint, trader: 't', isBuy: true, tokenAmount: 1, solAmount: 1, marketCapSol, signature: 's', receivedAt: 0 });

describe('FollowUps', () => {
  let fired: Array<[FollowUp, string]>; let subs: string[]; let unsubs: string[]; let fu: FollowUps;
  beforeEach(() => {
    fired = []; subs = []; unsubs = [];
    fu = new FollowUps(CFG, { subscribe: (m) => subs.push(m), unsubscribe: (m) => unsubs.push(m), fire: (f, r) => fired.push([f, r]) });
  });

  it('subscribes on add and tracks peak/last', () => {
    fu.add('m1', 'COOL', 100, 0);
    expect(subs).toEqual(['m1']);
    fu.onTrade(trade('m1', 150), 1000);
    fu.onTrade(trade('m1', 120), 2000);
    expect(fired).toHaveLength(0);
    expect(fu.has('m1')).toBe(true);
  });

  it('fires a dump follow-up when it falls >50% off peak, once', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 200), 1000); // peak 200
    fu.onTrade(trade('m1', 90), 2000);  // -55% off peak
    expect(fired).toHaveLength(1);
    expect(fired[0][1]).toBe('dump');
    expect(unsubs).toEqual(['m1']);
    fu.onTrade(trade('m1', 80), 3000);  // already gone — no second fire
    expect(fired).toHaveLength(1);
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
    expect(fired[0][1]).toBe('window');
    expect(fired[0][0].peakMcSol).toBe(130);
    expect(unsubs).toEqual(['m1']);
    expect(fu.size).toBe(0);
  });
});
