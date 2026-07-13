import { describe, it, expect } from 'vitest';
import { scoreToken, type CheckResults } from '../src/pipeline/scoring';

const CFG = {
  maxLifetimeLaunches: 3, priorLaunchPenalty: 15, graduatedBonus: 20,
  top10HardRejectPct: 45, top10BonusPct: 30, top10Bonus: 10,
  deadLinkPenalty: 10, liveWebsiteBonus: 10, xMissingPenalty: 15, devHoldsBonus: 10,
};

const LAUNCH = {
  bundleHardRejectPct: 50, bundleHeldHardRejectPct: 30, bundlePenaltyPct: 20, bundlePenalty: 15,
  devOutflowHardRejectPct: 30, devOutflowPenaltyPct: 10, devOutflowPenalty: 15,
  first20FlagPct: 60, maxEarlyTxFetch: 60, sniperSlots: 3,
};

// GMGN master flag off (the shipped default) — every existing test runs with this so GMGN never
// touches the score. The two ON variants are exercised by the dedicated GMGN suite below.
const GMGN_OFF = { enabled: false, rejectBad: false };
const GMGN_DEFAULT = { enabled: true, rejectBad: false };   // score-nudge only, no new rejects
const GMGN_AGGRESSIVE = { enabled: true, rejectBad: true };  // reject honeypot/wash + bigger boost

const gm = (over: Partial<import('../src/checks/gmgn').GmgnEnrichment> = {}): import('../src/checks/gmgn').GmgnEnrichment => ({
  smartMoneyCount: 0, kolCount: 0, honeypot: false, washTrading: false,
  buyTaxPct: 0, sellTaxPct: 0, top10Pct: 20, ...over,
});

const clean = (over: Partial<CheckResults> = {}): CheckResults => ({
  devHistory: { priorLaunches: 0, anyGraduated: false },
  funderLinkedToRug: false, top10Pct: 20,
  twitterAlive: true, telegramAlive: true, websiteAlive: true,
  xExists: true, devStillHolds: true,
  bundlePct: 5, first20Pct: 20, devOutflowPct: 0,
  sniperCount: 'unknown', sniperPct: 'unknown', sniperHeldPct: 'unknown',
  bundleCount: 'unknown', bundleHeldPct: 'unknown', holderCount: 'unknown',
  gmgn: 'unknown',
  ...over,
});

describe('scoreToken', () => {
  it('scores a clean token: 50 +10 top10 +10 website +10 devHolds = 80', () => {
    const r = scoreToken(clean(), CFG, LAUNCH, GMGN_OFF);
    expect(r).toEqual({ score: 80, hardRejects: [], flags: [] });
  });

  it('hard rejects serial dev, rug-linked funder, concentrated top10', () => {
    expect(scoreToken(clean({ devHistory: { priorLaunches: 4, anyGraduated: false } }), CFG, LAUNCH, GMGN_OFF).hardRejects)
      .toEqual(['serial dev: 4 launches, none graduated']);
    expect(scoreToken(clean({ funderLinkedToRug: true }), CFG, LAUNCH, GMGN_OFF).hardRejects)
      .toEqual(['dev funded by rug-linked wallet']);
    expect(scoreToken(clean({ top10Pct: 60 }), CFG, LAUNCH, GMGN_OFF).hardRejects).toEqual(['top10 holds 60%']);
  });

  it('graduated dev overrides launch count and earns bonus', () => {
    const r = scoreToken(clean({ devHistory: { priorLaunches: 5, anyGraduated: true } }), CFG, LAUNCH, GMGN_OFF);
    expect(r.hardRejects).toEqual([]);
    expect(r.score).toBe(100); // 80 + 20, clamped at 100
  });

  it('penalizes prior launches, dead links, missing X', () => {
    const r = scoreToken(clean({
      devHistory: { priorLaunches: 2, anyGraduated: false },
      twitterAlive: false, xExists: false,
    }), CFG, LAUNCH, GMGN_OFF);
    // 80 - 15 (priors) - 10 (dead twitter) - 15 (no X) = 40
    expect(r.score).toBe(40);
    expect(r.flags).toEqual(['2 prior launches', 'dead twitter link', 'X account not found']);
  });

  it("'unknown' results only flag, never score", () => {
    const r = scoreToken(clean({ devHistory: 'unknown', top10Pct: 'unknown', xExists: 'unknown' }), CFG, LAUNCH, GMGN_OFF);
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
    }), CFG, LAUNCH, GMGN_OFF);
    // 50 -15 -10 -10 -10 -15 = -10 → 0
    expect(r.score).toBe(0);
  });

  it('hard rejects heavy bundle (holdings unverifiable) and heavy dev outflow', () => {
    // bundleHeldPct 'unknown' in the clean fixture -> conservative bought-at-launch rule
    expect(scoreToken(clean({ bundlePct: 62 }), CFG, LAUNCH, GMGN_OFF).hardRejects).toEqual(['bundle 62%']);
    expect(scoreToken(clean({ devOutflowPct: 40 }), CFG, LAUNCH, GMGN_OFF).hardRejects).toEqual(['dev moved out 40%']);
  });

  it('judges the bundle by what insiders STILL HOLD when holdings are known', () => {
    // SCATMAN case: 82% bundled at launch but distributed to 7% -> no hard reject, just the penalty+flag
    const distributed = scoreToken(clean({ bundlePct: 82, bundleHeldPct: 7 }), CFG, LAUNCH, GMGN_OFF);
    expect(distributed.hardRejects).toEqual([]);
    expect(distributed.score).toBe(65); // 80 - bundlePenalty(15)
    expect(distributed.flags).toContain('bundled 82% at launch');
    // Loaded gun: bundlers still sitting on 35% -> hard reject regardless of bought size
    const loaded = scoreToken(clean({ bundlePct: 40, bundleHeldPct: 35 }), CFG, LAUNCH, GMGN_OFF);
    expect(loaded.hardRejects).toEqual(['bundlers still hold 35%']);
    // Small verified bundle fully held but under the held threshold -> no reject, no penalty (below penaltyPct)
    const small = scoreToken(clean({ bundlePct: 10, bundleHeldPct: 10 }), CFG, LAUNCH, GMGN_OFF);
    expect(small.hardRejects).toEqual([]);
    expect(small.score).toBe(80);
  });

  it('penalizes medium bundle / dev outflow and flags high first-20', () => {
    const b = scoreToken(clean({ bundlePct: 30 }), CFG, LAUNCH, GMGN_OFF);
    expect(b.score).toBe(65); // 80 - 15
    expect(b.flags).toContain('bundle 30%');
    const d = scoreToken(clean({ devOutflowPct: 15 }), CFG, LAUNCH, GMGN_OFF);
    expect(d.score).toBe(65);
    expect(d.flags).toContain('dev out 15%');
    expect(scoreToken(clean({ first20Pct: 70 }), CFG, LAUNCH, GMGN_OFF).flags).toContain('first-20 hold 70%');
  });

  it("launch analysis 'unknown' never changes score or rejects", () => {
    const r = scoreToken(clean({ bundlePct: 'unknown', first20Pct: 'unknown', devOutflowPct: 'unknown' }), CFG, LAUNCH, GMGN_OFF);
    expect(r.score).toBe(80);
    expect(r.hardRejects).toEqual([]);
  });

  it('GMGN disabled (default): no GMGN data ever touches the score, flags, or rejects', () => {
    // Even a maximally-bad GMGN payload is inert while the master flag is off.
    const withGmgn = scoreToken(clean({
      gmgn: gm({ smartMoneyCount: 9, kolCount: 9, honeypot: true, washTrading: true, sellTaxPct: 99 }),
    }), CFG, LAUNCH, GMGN_OFF);
    expect(withGmgn).toEqual(scoreToken(clean(), CFG, LAUNCH, GMGN_OFF));
  });
});

describe('scoreToken — GMGN scoring', () => {
  const base = () => scoreToken(clean(), CFG, LAUNCH, GMGN_OFF).score; // 80, GMGN inert

  it('unknown GMGN → delta 0 in every mode (degrade doctrine)', () => {
    expect(scoreToken(clean({ gmgn: 'unknown' }), CFG, LAUNCH, GMGN_DEFAULT).score).toBe(base());
    expect(scoreToken(clean({ gmgn: 'unknown' }), CFG, LAUNCH, GMGN_AGGRESSIVE).score).toBe(base());
    expect(scoreToken(clean({ gmgn: 'unknown' }), CFG, LAUNCH, GMGN_AGGRESSIVE).hardRejects).toEqual([]);
  });

  it('neutral GMGN (3★: no positives, no negatives) → delta 0', () => {
    // no smart money, no KOL, honeypot=false, no wash, 0 tax → 3 stars → (3-3)*K = 0
    const r = scoreToken(clean({ gmgn: gm() }), CFG, LAUNCH, GMGN_DEFAULT);
    expect(r.score).toBe(base());
  });

  it('default mode: bounded nudge = (stars-3)*3, max ±6, never rejects', () => {
    // 5★ (smart + KOL present) → +6
    const good = scoreToken(clean({ gmgn: gm({ smartMoneyCount: 3, kolCount: 4 }) }), CFG, LAUNCH, GMGN_DEFAULT);
    expect(good.score).toBe(base() + 6);
    expect(good.hardRejects).toEqual([]);
    // 1★ (honeypot + wash + high sell tax, no positives) → -6, still NO reject in default mode
    const bad = scoreToken(clean({ gmgn: gm({ honeypot: true, washTrading: true, sellTaxPct: 40 }) }), CFG, LAUNCH, GMGN_DEFAULT);
    expect(bad.score).toBe(base() - 6);
    expect(bad.hardRejects).toEqual([]);
  });

  it('unknown honeypot/wash are NEUTRAL, never subtract (only confirmed negatives do)', () => {
    const r = scoreToken(clean({
      gmgn: gm({ smartMoneyCount: 2, honeypot: 'unknown', washTrading: 'unknown', sellTaxPct: 'unknown' }),
    }), CFG, LAUNCH, GMGN_DEFAULT);
    // 3 +1 (smart) = 4★ → +3; unknown negatives contribute nothing
    expect(r.score).toBe(base() + 3);
  });

  it('aggressive mode: hard-rejects a GMGN-confirmed honeypot', () => {
    const r = scoreToken(clean({ gmgn: gm({ honeypot: true }) }), CFG, LAUNCH, GMGN_AGGRESSIVE);
    expect(r.hardRejects).toContain('GMGN flags honeypot');
  });

  it('aggressive mode: hard-rejects GMGN-confirmed wash trading', () => {
    const r = scoreToken(clean({ gmgn: gm({ washTrading: true }) }), CFG, LAUNCH, GMGN_AGGRESSIVE);
    expect(r.hardRejects).toContain('GMGN flags wash trading');
  });

  it('aggressive mode: stronger boost = (stars-3)*4 plus a +5 smart-money bonus when high', () => {
    // 5★ with high smart money (3) and high KOL (4): (5-3)*4 = +8, plus +5 bonus = +13
    const r = scoreToken(clean({ gmgn: gm({ smartMoneyCount: 3, kolCount: 4 }) }), CFG, LAUNCH, GMGN_AGGRESSIVE);
    // base 80 + 13 = 93 (under the 100 clamp)
    expect(r.score).toBe(base() + 13);
    expect(r.hardRejects).toEqual([]);
  });

  it('aggressive smart bonus does NOT apply below the high thresholds', () => {
    // smart money 1 (< GMGN_SMART_HIGH 3), KOL 1 (< GMGN_KOL_HIGH 2): 5★ base swing only, no +5
    const r = scoreToken(clean({ gmgn: gm({ smartMoneyCount: 1, kolCount: 1 }) }), CFG, LAUNCH, GMGN_AGGRESSIVE);
    expect(r.score).toBe(base() + 8); // (5-3)*4, no bonus
  });

  it('default mode never rejects even a confirmed honeypot (only aggressive does)', () => {
    const r = scoreToken(clean({ gmgn: gm({ honeypot: true, washTrading: true }) }), CFG, LAUNCH, GMGN_DEFAULT);
    expect(r.hardRejects).toEqual([]);
  });
});
