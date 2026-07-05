import type { NewTokenEvent, TokenMeta } from '../types';
import { TOTAL_SUPPLY } from '../types';
import type { Stage1Config } from '../config';

export interface Stage1Input {
  event: NewTokenEvent;
  meta: TokenMeta | 'unknown';
  handleSeenBefore: boolean;
  creatorLaunches48h: number;
  symbolClone24h: boolean;
}

export interface Stage1Result {
  pass: boolean;
  reason?: string;
}

export function stage1Filter(input: Stage1Input, cfg: Stage1Config): Stage1Result {
  const { event, meta } = input;
  if (meta === 'unknown') return { pass: false, reason: 'metadata unavailable' };
  if (!meta.twitter) return { pass: false, reason: 'no twitter link' };
  if (!meta.telegram && !meta.website) return { pass: false, reason: 'no telegram or website' };
  if (input.handleSeenBefore) return { pass: false, reason: 'twitter handle reused' };

  const devBuyPct = (event.devBuyTokens / TOTAL_SUPPLY) * 100;
  if (devBuyPct > cfg.maxDevBuyPct) {
    return { pass: false, reason: `dev buy ${devBuyPct.toFixed(1)}% > ${cfg.maxDevBuyPct}%` };
  }
  if (input.creatorLaunches48h > cfg.maxCreatorLaunches48h) return { pass: false, reason: 'serial deployer' };
  if (input.symbolClone24h) return { pass: false, reason: 'ticker clone' };
  return { pass: true };
}
