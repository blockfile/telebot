import { describe, it, expect } from 'vitest';
import { stage1Filter, type Stage1Input } from '../src/pipeline/stage1';
import type { NewTokenEvent } from '../src/types';

const CFG = { requireTelegramOrWebsite: true, maxDevBuyPct: 10, maxCreatorLaunches48h: 2, tickerCloneWindowHours: 24 };

const event = (over: Partial<NewTokenEvent> = {}): NewTokenEvent => ({
  mint: 'mintA', name: 'Cool', symbol: 'COOL', uri: 'https://u', creator: 'dev1',
  devBuyTokens: 20_000_000, devBuySol: 1, bondingCurveKey: 'bc', marketCapSol: 31,
  vSolInBondingCurve: 30, signature: 's', receivedAt: 0, ...over,
});

const input = (over: Partial<Stage1Input> = {}): Stage1Input => ({
  event: event(), meta: { twitter: 'https://x.com/dev', telegram: 'https://t.me/c' },
  handleSeenBefore: false, creatorLaunches48h: 0, symbolClone24h: false, ...over,
});

describe('stage1Filter', () => {
  it('passes a clean token', () => {
    expect(stage1Filter(input(), CFG)).toEqual({ pass: true });
  });

  it('rejects when metadata is unavailable', () => {
    expect(stage1Filter(input({ meta: 'unknown' }), CFG).reason).toBe('metadata unavailable');
  });

  it('rejects without twitter, or without telegram AND website', () => {
    expect(stage1Filter(input({ meta: { telegram: 'https://t.me/c' } }), CFG).reason).toBe('no twitter link');
    expect(stage1Filter(input({ meta: { twitter: 'https://x.com/dev' } }), CFG).reason).toBe('no telegram or website');
    expect(stage1Filter(input({ meta: { twitter: 'https://x.com/dev', website: 'https://c.io' } }), CFG).pass).toBe(true);
  });

  it('accepts twitter-only tokens when requireTelegramOrWebsite is off', () => {
    const loose = { ...CFG, requireTelegramOrWebsite: false };
    expect(stage1Filter(input({ meta: { twitter: 'https://x.com/dev' } }), loose)).toEqual({ pass: true });
    // twitter itself stays mandatory even in loose mode
    expect(stage1Filter(input({ meta: { telegram: 'https://t.me/c' } }), loose).reason).toBe('no twitter link');
  });

  it('rejects reused handles, serial deployers, ticker clones', () => {
    expect(stage1Filter(input({ handleSeenBefore: true }), CFG).reason).toBe('twitter handle reused');
    expect(stage1Filter(input({ creatorLaunches48h: 3 }), CFG).reason).toBe('serial deployer');
    expect(stage1Filter(input({ creatorLaunches48h: 2 }), CFG).pass).toBe(true);
    expect(stage1Filter(input({ symbolClone24h: true }), CFG).reason).toBe('ticker clone');
  });

  it('rejects dev buy above threshold (10% of 1B supply)', () => {
    expect(stage1Filter(input({ event: event({ devBuyTokens: 150_000_000 }) }), CFG).reason)
      .toBe('dev buy 15.0% > 10%');
    expect(stage1Filter(input({ event: event({ devBuyTokens: 100_000_000 }) }), CFG).pass).toBe(true);
  });
});
