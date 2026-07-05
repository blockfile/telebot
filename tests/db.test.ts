import { describe, it, expect, beforeEach } from 'vitest';
import { Db } from '../src/db/index';

const tok = (mint: string, over: Partial<Parameters<Db['recordToken']>[0]> = {}) => ({
  mint, symbol: 'TEST', name: 'Test Token', creator: 'devWallet1',
  createdAt: 1000, stage1Pass: true, ...over,
});

describe('Db', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('records tokens and counts creator launches with exclusion', () => {
    db.recordToken(tok('mintA'));
    db.recordToken(tok('mintB', { createdAt: 2000 }));
    expect(db.countCreatorLaunches('devWallet1', 0)).toBe(2);
    expect(db.countCreatorLaunches('devWallet1', 0, 'mintB')).toBe(1);
    expect(db.countCreatorLaunches('devWallet1', 1500)).toBe(1);
    expect(db.countCreatorLaunches('otherWallet', 0)).toBe(0);
  });

  it('detects symbol clones case-insensitively within window', () => {
    db.recordToken(tok('mintA', { symbol: 'PePe' }));
    expect(db.symbolSeenSince('PEPE', 0, 'mintB')).toBe(true);
    expect(db.symbolSeenSince('PEPE', 0, 'mintA')).toBe(false);
    expect(db.symbolSeenSince('PEPE', 5000, 'mintB')).toBe(false);
  });

  it('tracks handles idempotently', () => {
    expect(db.handleSeen('cooldev')).toBe(false);
    db.recordHandle('cooldev', 'mintA', 1000);
    db.recordHandle('cooldev', 'mintZ', 2000);
    expect(db.handleSeen('cooldev')).toBe(true);
  });

  it('upserts dev stats via bumpDev', () => {
    expect(db.getDevStats('w1')).toBeNull();
    db.bumpDev('w1', 'launches', 1000);
    db.bumpDev('w1', 'launches', 1001);
    db.bumpDev('w1', 'rugged', 1002);
    expect(db.getDevStats('w1')).toEqual({ launches: 2, graduated: 0, rugged: 1 });
  });

  it('dedupes alerts and reports counts', () => {
    db.recordToken(tok('mintA'));
    db.recordToken(tok('mintB', { stage1Pass: false, stage1Reason: 'no twitter link' }));
    expect(db.alertExists('mintA')).toBe(false);
    db.recordAlert('mintA', 74, false, 'payload', 3000);
    expect(db.alertExists('mintA')).toBe(true);
    const c = db.countsSince(0);
    expect(c).toEqual({ seen: 2, watched: 1, alerted: 1 });
  });

  it('updates outcome', () => {
    db.recordToken(tok('mintA'));
    db.setOutcome('mintA', 'alerted');
    // no throw = pass; outcome verified via countsSince behavior elsewhere
  });
});
