import type { DeepConfig, LaunchConfig, GmgnConfig } from '../config';
import { gmgnStars, type GmgnEnrichment } from '../checks/gmgn';

// GMGN score-adjust: delta = (stars - 3) * K, mapping the 1..5 rating onto a bounded nudge that
// can never dominate the on-chain score. Default mode uses the smaller K; the aggressive
// `rejectBad` mode uses the larger K plus an extra smart-money boost.
const GMGN_DELTA_K = 3;            // default: max swing (5-3)*3 = ±6 points
const GMGN_DELTA_K_AGGRESSIVE = 4; // rejectBad: base swing (5-3)*4 = ±8 points
const GMGN_SMART_BONUS = 5;        // rejectBad: extra one-off boost when smart money / KOL are high
const GMGN_SMART_HIGH = 3;         // "high" = this many smart-money wallets
const GMGN_KOL_HIGH = 2;           // "high" = this many KOL/renowned wallets

export type Unknown<T> = T | 'unknown';

export interface CheckResults {
  devHistory: Unknown<{ priorLaunches: number; anyGraduated: boolean }>;
  funderLinkedToRug: Unknown<boolean>;
  top10Pct: Unknown<number>;
  twitterAlive: Unknown<boolean>;
  telegramAlive: Unknown<boolean>;
  websiteAlive: Unknown<boolean>;
  xExists: Unknown<boolean>;
  devStillHolds: boolean;
  bundlePct: Unknown<number>;
  first20Pct: Unknown<number>;
  devOutflowPct: Unknown<number>;
  // display-only (not scored): sniper activity, insider held-trend, holder count
  sniperCount: Unknown<number>;
  sniperPct: Unknown<number>;
  sniperHeldPct: Unknown<number>;
  bundleCount: Unknown<number>;
  bundleHeldPct: Unknown<number>;
  holderCount: Unknown<number>;
  // display-only, best-effort, off unless config.json gmgn.enabled is true (see checks/gmgn.ts)
  gmgn: Unknown<GmgnEnrichment>;
}

export interface ScoreResult {
  score: number;
  hardRejects: string[];
  flags: string[];
}

export function scoreToken(r: CheckResults, cfg: DeepConfig, launch: LaunchConfig, gmgn: GmgnConfig): ScoreResult {
  let score = 50;
  const hardRejects: string[] = [];
  const flags: string[] = [];

  if (r.devHistory === 'unknown') {
    flags.push('dev history unknown');
  } else {
    const { priorLaunches, anyGraduated } = r.devHistory;
    if (anyGraduated) {
      score += cfg.graduatedBonus;
    } else if (priorLaunches > cfg.maxLifetimeLaunches) {
      hardRejects.push(`serial dev: ${priorLaunches} launches, none graduated`);
    } else if (priorLaunches >= 1) {
      score -= cfg.priorLaunchPenalty;
      flags.push(`${priorLaunches} prior launches`);
    }
  }

  if (r.funderLinkedToRug === true) hardRejects.push('dev funded by rug-linked wallet');

  if (r.top10Pct === 'unknown') {
    flags.push('holders unknown');
  } else if (r.top10Pct > cfg.top10HardRejectPct) {
    hardRejects.push(`top10 holds ${r.top10Pct.toFixed(0)}%`);
  } else if (r.top10Pct <= cfg.top10BonusPct) {
    score += cfg.top10Bonus;
  } else {
    flags.push(`top10 ${r.top10Pct.toFixed(0)}%`);
  }

  const links: Array<[string, Unknown<boolean>]> = [
    ['twitter', r.twitterAlive], ['telegram', r.telegramAlive], ['website', r.websiteAlive],
  ];
  for (const [name, alive] of links) {
    if (alive === false) {
      score -= cfg.deadLinkPenalty;
      flags.push(`dead ${name} link`);
    }
  }
  if (r.websiteAlive === true) score += cfg.liveWebsiteBonus;

  if (r.xExists === false) {
    score -= cfg.xMissingPenalty;
    flags.push('X account not found');
  }
  if (r.devStillHolds) score += cfg.devHoldsBonus;

  if (r.bundlePct !== 'unknown') {
    if (r.bundleHeldPct !== 'unknown') {
      // Holdings verified: judge the LIVE risk. A launch bundle that already distributed
      // (e.g. 82% -> 7%) is no longer a loaded gun — penalize the history, don't execute it.
      if (r.bundleHeldPct > launch.bundleHeldHardRejectPct) {
        hardRejects.push(`bundlers still hold ${r.bundleHeldPct.toFixed(0)}%`);
      } else if (r.bundlePct >= launch.bundlePenaltyPct) {
        score -= launch.bundlePenalty;
        flags.push(`bundled ${r.bundlePct.toFixed(0)}% at launch`);
      }
    } else {
      // Holdings unverifiable: fall back to the conservative bought-at-launch rule.
      if (r.bundlePct > launch.bundleHardRejectPct) hardRejects.push(`bundle ${r.bundlePct.toFixed(0)}%`);
      else if (r.bundlePct >= launch.bundlePenaltyPct) {
        score -= launch.bundlePenalty;
        flags.push(`bundle ${r.bundlePct.toFixed(0)}%`);
      }
    }
  }
  if (r.devOutflowPct !== 'unknown') {
    if (r.devOutflowPct > launch.devOutflowHardRejectPct) hardRejects.push(`dev moved out ${r.devOutflowPct.toFixed(0)}%`);
    else if (r.devOutflowPct >= launch.devOutflowPenaltyPct) {
      score -= launch.devOutflowPenalty;
      flags.push(`dev out ${r.devOutflowPct.toFixed(0)}%`);
    }
  }
  if (r.first20Pct !== 'unknown' && r.first20Pct > launch.first20FlagPct) {
    flags.push(`first-20 hold ${r.first20Pct.toFixed(0)}%`);
  }

  // GMGN influence on the score. Gated by the master flag AND the presence of data, so when GMGN
  // is disabled (or the fetch degraded to 'unknown') nothing below runs and the score is identical
  // to the pre-GMGN behavior. `rejectBad` selects aggressive mode; default mode is a bounded nudge
  // with NO new hard-rejects.
  if (gmgn.enabled && r.gmgn !== 'unknown') {
    const aggressive = gmgn.rejectBad;
    const stars = gmgnStars(r.gmgn);
    const k = aggressive ? GMGN_DELTA_K_AGGRESSIVE : GMGN_DELTA_K;
    score += (stars - 3) * k; // stars===3 (neutral) → 0; bounded to ±(2*k)

    if (aggressive) {
      if (r.gmgn.honeypot === true) hardRejects.push('GMGN flags honeypot');
      if (r.gmgn.washTrading === true) hardRejects.push('GMGN flags wash trading');
      const smartHigh = typeof r.gmgn.smartMoneyCount === 'number' && r.gmgn.smartMoneyCount >= GMGN_SMART_HIGH;
      const kolHigh = typeof r.gmgn.kolCount === 'number' && r.gmgn.kolCount >= GMGN_KOL_HIGH;
      if (smartHigh || kolHigh) score += GMGN_SMART_BONUS;
    }
  }

  return { score: Math.max(0, Math.min(100, score)), hardRejects, flags };
}
