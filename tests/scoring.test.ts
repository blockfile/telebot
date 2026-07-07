import { describe, it, expect } from 'vitest';
import { scoreToken, type CheckResults } from '../src/pipeline/scoring';

const CFG = {
  maxLifetimeLaunches: 3, priorLaunchPenalty: 15, graduatedBonus: 20,
  top10HardRejectPct: 45, top10BonusPct: 30, top10Bonus: 10,
  deadLinkPenalty: 10, liveWebsiteBonus: 10, xMissingPenalty: 15, devHoldsBonus: 10,
};

const LAUNCH = {
  bundleHardRejectPct: 50, bundlePenaltyPct: 20, bundlePenalty: 15,
  devOutflowHardRejectPct: 30, devOutflowPenaltyPct: 10, devOutflowPenalty: 15,
  first20FlagPct: 60, maxEarlyTxFetch: 60, sniperSlots: 3,
};

const clean = (over: Partial<CheckResults> = {}): CheckResults => ({
  devHistory: { priorLaunches: 0, anyGraduated: false },
  funderLinkedToRug: false, top10Pct: 20,
  twitterAlive: true, telegramAlive: true, websiteAlive: true,
  xExists: true, devStillHolds: true,
  bundlePct: 5, first20Pct: 20, devOutflowPct: 0,
  sniperCount: 'unknown', sniperPct: 'unknown', holderCount: 'unknown',
  ...over,
});

describe('scoreToken', () => {
  it('scores a clean token: 50 +10 top10 +10 website +10 devHolds = 80', () => {
    const r = scoreToken(clean(), CFG, LAUNCH);
    expect(r).toEqual({ score: 80, hardRejects: [], flags: [] });
  });

  it('hard rejects serial dev, rug-linked funder, concentrated top10', () => {
    expect(scoreToken(clean({ devHistory: { priorLaunches: 4, anyGraduated: false } }), CFG, LAUNCH).hardRejects)
      .toEqual(['serial dev: 4 launches, none graduated']);
    expect(scoreToken(clean({ funderLinkedToRug: true }), CFG, LAUNCH).hardRejects)
      .toEqual(['dev funded by rug-linked wallet']);
    expect(scoreToken(clean({ top10Pct: 60 }), CFG, LAUNCH).hardRejects).toEqual(['top10 holds 60%']);
  });

  it('graduated dev overrides launch count and earns bonus', () => {
    const r = scoreToken(clean({ devHistory: { priorLaunches: 5, anyGraduated: true } }), CFG, LAUNCH);
    expect(r.hardRejects).toEqual([]);
    expect(r.score).toBe(100); // 80 + 20, clamped at 100
  });

  it('penalizes prior launches, dead links, missing X', () => {
    const r = scoreToken(clean({
      devHistory: { priorLaunches: 2, anyGraduated: false },
      twitterAlive: false, xExists: false,
    }), CFG, LAUNCH);
    // 80 - 15 (priors) - 10 (dead twitter) - 15 (no X) = 40
    expect(r.score).toBe(40);
    expect(r.flags).toEqual(['2 prior launches', 'dead twitter link', 'X account not found']);
  });

  it("'unknown' results only flag, never score", () => {
    const r = scoreToken(clean({ devHistory: 'unknown', top10Pct: 'unknown', xExists: 'unknown' }), CFG, LAUNCH);
    // 50 + 10 website + 10 devHolds = 70 (no top10 bonus, no dev bonus/penalty)
    expect(r.score).toBe(70);
    expect(r.hardRejects).toEqual([]);
    expect(r.flags).toEqual(['dev history unknown', 'holders unknown']);
  });

  it('clamps at 0', () => {
    const r = scoreToken(clean({
      devHistory: { priorLaunches: 1, anyGraduated: false },
      twitterAlive: false, telegramAlive: false, websiteAlive: false,
      xExists: false, devStillHolds: false, top10Pct: 40,
    }), CFG, LAUNCH);
    // 50 -15 -10 -10 -10 -15 = -10 → 0
    expect(r.score).toBe(0);
  });

  it('hard rejects heavy bundle and heavy dev outflow', () => {
    expect(scoreToken(clean({ bundlePct: 62 }), CFG, LAUNCH).hardRejects).toEqual(['bundle 62%']);
    expect(scoreToken(clean({ devOutflowPct: 40 }), CFG, LAUNCH).hardRejects).toEqual(['dev moved out 40%']);
  });

  it('penalizes medium bundle / dev outflow and flags high first-20', () => {
    const b = scoreToken(clean({ bundlePct: 30 }), CFG, LAUNCH);
    expect(b.score).toBe(65); // 80 - 15
    expect(b.flags).toContain('bundle 30%');
    const d = scoreToken(clean({ devOutflowPct: 15 }), CFG, LAUNCH);
    expect(d.score).toBe(65);
    expect(d.flags).toContain('dev out 15%');
    expect(scoreToken(clean({ first20Pct: 70 }), CFG, LAUNCH).flags).toContain('first-20 hold 70%');
  });

  it("launch analysis 'unknown' never changes score or rejects", () => {
    const r = scoreToken(clean({ bundlePct: 'unknown', first20Pct: 'unknown', devOutflowPct: 'unknown' }), CFG, LAUNCH);
    expect(r.score).toBe(80);
    expect(r.hardRejects).toEqual([]);
  });
});
