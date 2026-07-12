import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Outcome = 'seen' | 'watching' | 'expired' | 'disqualified' | 'triggered' | 'rejected_deep' | 'alerted';

export interface RevivalRow {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  image?: string;
  bondingCurve: string;
  creationSig: string;
  devBuyTokens: number;
  createdAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  creator TEXT NOT NULL,
  twitter TEXT,
  telegram TEXT,
  website TEXT,
  created_at INTEGER NOT NULL,
  stage1_pass INTEGER NOT NULL,
  stage1_reason TEXT,
  outcome TEXT NOT NULL DEFAULT 'seen',
  bonding_curve TEXT,
  creation_sig TEXT,
  dev_buy_tokens REAL,
  image TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator, created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol COLLATE NOCASE, created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_graveyard ON tokens(created_at) WHERE stage1_pass = 1 AND outcome = 'expired';

CREATE TABLE IF NOT EXISTS handles (
  handle TEXT PRIMARY KEY,
  first_mint TEXT NOT NULL,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devs (
  wallet TEXT PRIMARY KEY,
  launches INTEGER NOT NULL DEFAULT 0,
  graduated INTEGER NOT NULL DEFAULT 0,
  rugged INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  mint TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  dry INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
`;

export class Db {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Add columns introduced after the first release to pre-existing databases. */
  private migrate(): void {
    const cols = new Set(
      (this.db.pragma('table_info(tokens)') as Array<{ name: string }>).map((c) => c.name),
    );
    const add = (name: string, type: string) => {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE tokens ADD COLUMN ${name} ${type}`);
    };
    add('bonding_curve', 'TEXT');
    add('creation_sig', 'TEXT');
    add('dev_buy_tokens', 'REAL');
    add('image', 'TEXT');
  }

  recordToken(t: {
    mint: string; symbol: string; name: string; creator: string;
    twitter?: string; telegram?: string; website?: string;
    createdAt: number; stage1Pass: boolean; stage1Reason?: string;
    bondingCurve?: string; creationSig?: string; devBuyTokens?: number; image?: string;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO tokens (mint, symbol, name, creator, twitter, telegram, website, created_at, stage1_pass, stage1_reason, bonding_curve, creation_sig, dev_buy_tokens, image)
      VALUES (@mint, @symbol, @name, @creator, @twitter, @telegram, @website, @createdAt, @stage1Pass, @stage1Reason, @bondingCurve, @creationSig, @devBuyTokens, @image)
    `).run({
      ...t,
      twitter: t.twitter ?? null, telegram: t.telegram ?? null, website: t.website ?? null,
      stage1Pass: t.stage1Pass ? 1 : 0, stage1Reason: t.stage1Reason ?? null,
      bondingCurve: t.bondingCurve ?? null, creationSig: t.creationSig ?? null,
      devBuyTokens: t.devBuyTokens ?? null, image: t.image ?? null,
    });
  }

  /** Graveyard candidates for the revival sweep: screened fine, watched, never alerted. */
  revivalCandidates(sinceMs: number, limit: number): RevivalRow[] {
    const rows = this.db.prepare(`
      SELECT mint, symbol, name, creator, twitter, telegram, website, image,
             bonding_curve AS bondingCurve, creation_sig AS creationSig,
             dev_buy_tokens AS devBuyTokens, created_at AS createdAt
      FROM tokens
      WHERE stage1_pass = 1 AND outcome = 'expired' AND bonding_curve IS NOT NULL AND bonding_curve != '' AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?
    `).all(sinceMs, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      mint: r.mint as string, symbol: r.symbol as string, name: r.name as string, creator: r.creator as string,
      twitter: (r.twitter as string | null) ?? undefined,
      telegram: (r.telegram as string | null) ?? undefined,
      website: (r.website as string | null) ?? undefined,
      image: (r.image as string | null) ?? undefined,
      bondingCurve: r.bondingCurve as string,
      creationSig: (r.creationSig as string | null) ?? '',
      devBuyTokens: (r.devBuyTokens as number | null) ?? 0,
      createdAt: r.createdAt as number,
    }));
  }

  setOutcome(mint: string, outcome: Outcome): void {
    this.db.prepare('UPDATE tokens SET outcome = ? WHERE mint = ?').run(outcome, mint);
  }

  /**
   * Watchlist state is in-memory, so a restart strands mid-watch tokens at 'watching'/'triggered'
   * forever — invisible to the revival graveyard. Called once at boot to return them to 'expired'.
   */
  reconcileInterrupted(olderThanMs: number): number {
    const r = this.db.prepare(
      "UPDATE tokens SET outcome = 'expired' WHERE outcome IN ('watching', 'triggered') AND created_at < ?",
    ).run(olderThanMs);
    return r.changes;
  }

  getOutcome(mint: string): Outcome | null {
    const row = this.db.prepare('SELECT outcome FROM tokens WHERE mint = ?').get(mint) as { outcome: Outcome } | undefined;
    return row?.outcome ?? null;
  }

  getTokenCreator(mint: string): string | null {
    const row = this.db.prepare('SELECT creator FROM tokens WHERE mint = ?').get(mint) as { creator: string } | undefined;
    return row?.creator ?? null;
  }

  countCreatorLaunches(creator: string, sinceMs: number, excludeMint = ''): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM tokens WHERE creator = ? AND created_at >= ? AND mint != ?'
    ).get(creator, sinceMs, excludeMint) as { n: number };
    return row.n;
  }

  symbolSeenSince(symbol: string, sinceMs: number, excludeMint: string): boolean {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM tokens WHERE symbol = ? COLLATE NOCASE AND created_at >= ? AND mint != ?'
    ).get(symbol, sinceMs, excludeMint) as { n: number };
    return row.n > 0;
  }

  handleSeen(handle: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM handles WHERE handle = ?').get(handle);
  }

  recordHandle(handle: string, mint: string, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO handles (handle, first_mint, first_seen) VALUES (?, ?, ?)').run(handle, mint, at);
  }

  getDevStats(wallet: string): { launches: number; graduated: number; rugged: number } | null {
    const row = this.db.prepare('SELECT launches, graduated, rugged FROM devs WHERE wallet = ?').get(wallet) as
      { launches: number; graduated: number; rugged: number } | undefined;
    return row ?? null;
  }

  bumpDev(wallet: string, field: 'launches' | 'graduated' | 'rugged', at: number): void {
    this.db.prepare(`
      INSERT INTO devs (wallet, ${field}, first_seen) VALUES (?, 1, ?)
      ON CONFLICT(wallet) DO UPDATE SET ${field} = ${field} + 1
    `).run(wallet, at);
  }

  alertExists(mint: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM alerts WHERE mint = ?').get(mint);
  }

  recordAlert(mint: string, score: number, dry: boolean, payload: string, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO alerts (mint, score, dry, payload, sent_at) VALUES (?, ?, ?, ?, ?)')
      .run(mint, score, dry ? 1 : 0, payload, at);
  }

  countsSince(sinceMs: number): { seen: number; watched: number; alerted: number } {
    const seen = (this.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE created_at >= ?').get(sinceMs) as { n: number }).n;
    const watched = (this.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE created_at >= ? AND stage1_pass = 1').get(sinceMs) as { n: number }).n;
    const alerted = (this.db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE sent_at >= ?').get(sinceMs) as { n: number }).n;
    return { seen, watched, alerted };
  }

  close(): void { this.db.close(); }
}
