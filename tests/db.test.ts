import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db/index';

const tok = (mint: string, over: Partial<Parameters<Db['recordToken']>[0]> = {}) => ({
  mint, symbol: 'TEST', name: 'Test Token', creator: 'devWallet1',
  createdAt: 1000, stage1Pass: true, ...over,
});

describe('Db', () => {
  let db: Db;
  beforeEach(() => { db = new Db(':memory:'); });

  it('migrates a pre-revival database by adding the new columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trenches-db-'));
    const path = join(dir, 'old.db');
    // Build a DB with the ORIGINAL tokens schema (no bonding_curve etc.) + a row
    const raw = new Database(path);
    raw.exec(`CREATE TABLE tokens (
      mint TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL, creator TEXT NOT NULL,
      twitter TEXT, telegram TEXT, website TEXT, created_at INTEGER NOT NULL,
      stage1_pass INTEGER NOT NULL, stage1_reason TEXT, outcome TEXT NOT NULL DEFAULT 'seen'
    )`);
    raw.prepare("INSERT INTO tokens (mint, symbol, name, creator, created_at, stage1_pass) VALUES ('old1','O','Old','d',1000,1)").run();
    raw.close();

    const migrated = new Db(path); // constructor must ALTER TABLE without breaking the old row
    expect(migrated.getOutcome('old1')).toBe('seen');
    migrated.recordToken({
      mint: 'new1', symbol: 'N', name: 'New', creator: 'd', createdAt: 2000, stage1Pass: true,
      bondingCurve: 'curveX', creationSig: 'sigX', devBuyTokens: 1, image: 'img',
    });
    migrated.setOutcome('new1', 'expired');
    expect(migrated.revivalCandidates(0, 10).map((r) => r.mint)).toEqual(['new1']); // old NULL-curve row skipped
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("excludes empty-string curve keys from revival candidates (would poison an RPC batch)", () => {
    db.recordToken({ ...tok('mEmpty'), bondingCurve: '' } as Parameters<Db['recordToken']>[0]);
    db.setOutcome('mEmpty', 'expired');
    expect(db.revivalCandidates(0, 10)).toEqual([]);
  });

  it('reconcileInterrupted returns stranded watching/triggered tokens to the graveyard', () => {
    db.recordToken(tok('w1', { createdAt: 1000 }));
    db.recordToken(tok('w2', { createdAt: 9000 }));
    db.recordToken(tok('a1', { createdAt: 1000 }));
    db.setOutcome('w1', 'watching');   // old + stranded -> expired
    db.setOutcome('w2', 'watching');   // recent -> untouched (may still be genuinely watched)
    db.setOutcome('a1', 'alerted');    // terminal -> untouched
    expect(db.reconcileInterrupted(5000)).toBe(1);
    expect(db.getOutcome('w1')).toBe('expired');
    expect(db.getOutcome('w2')).toBe('watching');
    expect(db.getOutcome('a1')).toBe('alerted');
  });

  it('returns revival candidates: stage1-passed, expired, recent, with a stored curve key', () => {
    const full = (mint: string, over: object = {}) => ({
      ...tok(mint), bondingCurve: 'curve_' + mint, creationSig: 'sig_' + mint,
      devBuyTokens: 5_000_000, image: 'ipfs://img', createdAt: 10_000, ...over,
    });
    db.recordToken(full('m1'));                                 // expired below -> candidate
    db.recordToken(full('m2'));                                 // stays 'seen' -> not a candidate
    db.recordToken(full('m3', { stage1Pass: false }));          // failed stage1 -> never
    db.recordToken(tok('m4', { createdAt: 10_000 }));           // no curve stored (old row) -> skipped
    db.recordToken(full('m5', { createdAt: 100 }));             // too old
    db.setOutcome('m1', 'expired');
    db.setOutcome('m4', 'expired');
    db.setOutcome('m5', 'expired');

    const rows = db.revivalCandidates(5_000, 100);
    expect(rows.map((r) => r.mint)).toEqual(['m1']);
    expect(rows[0]).toMatchObject({
      mint: 'm1', symbol: 'TEST', creator: 'devWallet1',
      bondingCurve: 'curve_m1', creationSig: 'sig_m1', devBuyTokens: 5_000_000,
      image: 'ipfs://img', createdAt: 10_000,
    });
    expect(db.revivalCandidates(5_000, 0)).toEqual([]); // limit respected
  });

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
    expect(db.getOutcome('mintA')).toBe('seen');
    db.setOutcome('mintA', 'alerted');
    expect(db.getOutcome('mintA')).toBe('alerted');
    expect(db.getOutcome('missing')).toBeNull();
  });

  it('looks up token creator by mint', () => {
    db.recordToken(tok('mintA', { creator: 'devWallet1' }));
    expect(db.getTokenCreator('mintA')).toBe('devWallet1');
    expect(db.getTokenCreator('missing')).toBeNull();
  });
});
