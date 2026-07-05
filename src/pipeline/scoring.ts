import type { DeepConfig } from '../config';

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
}

export interface ScoreResult {
  score: number;
  hardRejects: string[];
  flags: string[];
}

export function scoreToken(r: CheckResults, cfg: DeepConfig): ScoreResult {
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

  return { score: Math.max(0, Math.min(100, score)), hardRejects, flags };
}
