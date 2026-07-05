# Trenches Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js/TypeScript daemon that watches every new Pump.fun token via the free PumpPortal WebSocket, filters through a three-stage pipeline (mint filters → traction watch → deep checks via the user's QuickNode RPC), and sends scored contract-address alerts to Telegram.

**Architecture:** Single long-running process. Event-driven pipeline: `PumpPortalStream` emits typed events → `stage1Filter` (pure) → `Watchlist` state machine (traction/dev-sell/bundle tracking) → `runDeepChecks` orchestrator (RPC + HTTP checks) → `scoreToken` (pure) → `Telegram`. SQLite (better-sqlite3, synchronous) accumulates dev-wallet/handle/token knowledge.

**Tech Stack:** Node.js ≥ 20, TypeScript run via `tsx` (no build step), `ws`, `better-sqlite3`, `dotenv`, `vitest` for tests. Global `fetch` (Node 20 built-in) for all HTTP; every HTTP-using module accepts an injectable `fetchFn` for testing.

**Spec:** `docs/superpowers/specs/2026-07-05-trenches-scanner-design.md` — thresholds and behavior defined there are authoritative.

## Global Constraints

- Node.js ≥ 20 (global fetch, `AbortSignal.timeout`). Windows is the target platform — no bash-isms in npm scripts.
- ESM (`"type": "module"`), `moduleResolution: "Bundler"`, imports WITHOUT file extensions (e.g. `from '../types'`).
- Runtime deps limited to: `ws`, `better-sqlite3`, `dotenv`. Dev deps: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/ws`, `@types/better-sqlite3`.
- All thresholds come from `config.json` (never hardcoded in logic); secrets only from `.env`.
- Pump.fun total supply is always 1,000,000,000 tokens — constant `TOTAL_SUPPLY` in `src/types.ts`.
- Check results that cannot be determined are the literal string `'unknown'` — never treated as pass or fail.
- Alert-only: no wallet keys, no signing, no trading code anywhere.
- Every HTTP call has a timeout (5s for checks, 10s for RPC/Telegram).
- Tests must not hit the network: inject `fetchFn` stubs; DB tests use `new Db(':memory:')`.
- Run tests with `npx vitest run <file>` (or `npm test` for all).
- Commit after every task with the message given in its final step.

---

### Task 1: Project scaffold + config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `config.json`, `src/types.ts`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `loadConfig(path?: string): AppConfig`, `loadSecrets(env?): Secrets`, types `AppConfig`, `Stage1Config`, `WatchConfig`, `DeepConfig`, `Secrets`, `NewTokenEvent`, `TradeEvent`, `TokenMeta`, `TOTAL_SUPPLY` — used by every later task.

- [ ] **Step 1: Initialize npm project and install dependencies**

```powershell
npm init -y
npm install ws better-sqlite3 dotenv
npm install -D typescript tsx vitest @types/node @types/ws @types/better-sqlite3
```

- [ ] **Step 2: Write package.json scripts, tsconfig, .gitignore, .env.example**

Edit `package.json` — set these fields (keep npm-generated ones):

```json
{
  "name": "trenches-scanner",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts",
    "dry": "tsx src/index.ts --dry",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

Create `.gitignore`:

```
node_modules/
.env
data/
logs/
dist/
```

Create `.env.example`:

```
QUICKNODE_RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-key/
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
TELEGRAM_CHAT_ID=123456789
```

- [ ] **Step 3: Create config.json with the spec's default thresholds**

```json
{
  "stage1": {
    "maxDevBuyPct": 10,
    "maxCreatorLaunches48h": 2,
    "tickerCloneWindowHours": 24
  },
  "watch": {
    "windowMinutes": 90,
    "maxConcurrent": 500,
    "triggerMarketCapUsd": 15000,
    "triggerUniqueBuyers": 25,
    "bundleWindowMs": 1500,
    "bundleMaxBuyers": 8
  },
  "deep": {
    "maxLifetimeLaunches": 3,
    "priorLaunchPenalty": 15,
    "graduatedBonus": 20,
    "top10HardRejectPct": 45,
    "top10BonusPct": 30,
    "top10Bonus": 10,
    "deadLinkPenalty": 10,
    "liveWebsiteBonus": 10,
    "xMissingPenalty": 15,
    "devHoldsBonus": 10
  },
  "alertScoreThreshold": 60,
  "solPriceFallbackUsd": 150,
  "summaryHourLocal": 9
}
```

- [ ] **Step 4: Create src/types.ts**

```typescript
export const TOTAL_SUPPLY = 1_000_000_000;

export interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  devBuyTokens: number;
  devBuySol: number;
  bondingCurveKey: string;
  marketCapSol: number;
  signature: string;
  receivedAt: number;
}

export interface TradeEvent {
  mint: string;
  trader: string;
  isBuy: boolean;
  tokenAmount: number;
  solAmount: number;
  marketCapSol: number;
  signature: string;
  receivedAt: number;
}

export interface TokenMeta {
  twitter?: string;
  telegram?: string;
  website?: string;
}
```

- [ ] **Step 5: Write the failing config test**

Create `tests/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { loadConfig, loadSecrets } from '../src/config';

describe('loadConfig', () => {
  it('loads the repo config.json with required numeric thresholds', () => {
    const cfg = loadConfig();
    expect(cfg.watch.triggerMarketCapUsd).toBe(15000);
    expect(cfg.watch.triggerUniqueBuyers).toBe(25);
    expect(cfg.alertScoreThreshold).toBe(60);
    expect(cfg.stage1.maxDevBuyPct).toBe(10);
  });
});

describe('loadSecrets', () => {
  it('returns secrets when all env vars present', () => {
    const s = loadSecrets({
      QUICKNODE_RPC_URL: 'https://x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1',
    });
    expect(s.quicknodeRpcUrl).toBe('https://x');
  });

  it('throws naming every missing var', () => {
    expect(() => loadSecrets({})).toThrow(/QUICKNODE_RPC_URL.*TELEGRAM_BOT_TOKEN.*TELEGRAM_CHAT_ID/s);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 7: Create src/config.ts**

```typescript
import 'dotenv/config';
import { readFileSync } from 'node:fs';

export interface Stage1Config {
  maxDevBuyPct: number;
  maxCreatorLaunches48h: number;
  tickerCloneWindowHours: number;
}

export interface WatchConfig {
  windowMinutes: number;
  maxConcurrent: number;
  triggerMarketCapUsd: number;
  triggerUniqueBuyers: number;
  bundleWindowMs: number;
  bundleMaxBuyers: number;
}

export interface DeepConfig {
  maxLifetimeLaunches: number;
  priorLaunchPenalty: number;
  graduatedBonus: number;
  top10HardRejectPct: number;
  top10BonusPct: number;
  top10Bonus: number;
  deadLinkPenalty: number;
  liveWebsiteBonus: number;
  xMissingPenalty: number;
  devHoldsBonus: number;
}

export interface AppConfig {
  stage1: Stage1Config;
  watch: WatchConfig;
  deep: DeepConfig;
  alertScoreThreshold: number;
  solPriceFallbackUsd: number;
  summaryHourLocal: number;
}

export interface Secrets {
  quicknodeRpcUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
}

export function loadConfig(path = 'config.json'): AppConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;
  const required: Array<[string, unknown]> = [
    ['stage1.maxDevBuyPct', cfg.stage1?.maxDevBuyPct],
    ['watch.triggerMarketCapUsd', cfg.watch?.triggerMarketCapUsd],
    ['watch.triggerUniqueBuyers', cfg.watch?.triggerUniqueBuyers],
    ['watch.windowMinutes', cfg.watch?.windowMinutes],
    ['deep.top10HardRejectPct', cfg.deep?.top10HardRejectPct],
    ['alertScoreThreshold', cfg.alertScoreThreshold],
    ['solPriceFallbackUsd', cfg.solPriceFallbackUsd],
  ];
  for (const [name, v] of required) {
    if (typeof v !== 'number') throw new Error(`config.json missing numeric field: ${name}`);
  }
  return cfg;
}

export function loadSecrets(env: Record<string, string | undefined> = process.env): Secrets {
  const missing: string[] = [];
  const get = (k: string): string => {
    const v = env[k];
    if (!v) missing.push(k);
    return v ?? '';
  };
  const secrets = {
    quicknodeRpcUrl: get('QUICKNODE_RPC_URL'),
    telegramBotToken: get('TELEGRAM_BOT_TOKEN'),
    telegramChatId: get('TELEGRAM_CHAT_ID'),
  };
  if (missing.length) {
    throw new Error(`Missing required values in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
  return secrets;
}
```

- [ ] **Step 8: Run tests and typecheck to verify pass**

Run: `npx vitest run tests/config.test.ts` — Expected: 3 passed.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 9: Commit**

```powershell
git add -A; git commit -m "feat: project scaffold, shared types, config loader"
```

---

### Task 2: SQLite knowledge base

**Files:**
- Create: `src/db/index.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: class `Db` with constructor `new Db(path: string)` (`':memory:'` for tests) and methods:
  - `recordToken(t: { mint: string; symbol: string; name: string; creator: string; twitter?: string; telegram?: string; website?: string; createdAt: number; stage1Pass: boolean; stage1Reason?: string }): void`
  - `setOutcome(mint: string, outcome: Outcome): void` — `Outcome = 'seen' | 'watching' | 'expired' | 'disqualified' | 'triggered' | 'rejected_deep' | 'alerted'`
  - `countCreatorLaunches(creator: string, sinceMs: number, excludeMint?: string): number`
  - `symbolSeenSince(symbol: string, sinceMs: number, excludeMint: string): boolean` (case-insensitive)
  - `handleSeen(handle: string): boolean`
  - `recordHandle(handle: string, mint: string, at: number): void` (no-op if handle exists)
  - `getDevStats(wallet: string): { launches: number; graduated: number; rugged: number } | null`
  - `bumpDev(wallet: string, field: 'launches' | 'graduated' | 'rugged', at: number): void` (upserts)
  - `alertExists(mint: string): boolean`
  - `recordAlert(mint: string, score: number, dry: boolean, payload: string, at: number): void`
  - `countsSince(sinceMs: number): { seen: number; watched: number; alerted: number }`
  - `close(): void`

- [ ] **Step 1: Write the failing test**

Create `tests/db.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db.test.ts` — Expected: FAIL, cannot resolve `../src/db/index`.

- [ ] **Step 3: Implement src/db/index.ts**

```typescript
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Outcome = 'seen' | 'watching' | 'expired' | 'disqualified' | 'triggered' | 'rejected_deep' | 'alerted';

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
  outcome TEXT NOT NULL DEFAULT 'seen'
);
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator, created_at);
CREATE INDEX IF NOT EXISTS idx_tokens_symbol ON tokens(symbol COLLATE NOCASE, created_at);

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
  }

  recordToken(t: {
    mint: string; symbol: string; name: string; creator: string;
    twitter?: string; telegram?: string; website?: string;
    createdAt: number; stage1Pass: boolean; stage1Reason?: string;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO tokens (mint, symbol, name, creator, twitter, telegram, website, created_at, stage1_pass, stage1_reason)
      VALUES (@mint, @symbol, @name, @creator, @twitter, @telegram, @website, @createdAt, @stage1Pass, @stage1Reason)
    `).run({
      ...t,
      twitter: t.twitter ?? null, telegram: t.telegram ?? null, website: t.website ?? null,
      stage1Pass: t.stage1Pass ? 1 : 0, stage1Reason: t.stage1Reason ?? null,
    });
  }

  setOutcome(mint: string, outcome: Outcome): void {
    this.db.prepare('UPDATE tokens SET outcome = ? WHERE mint = ?').run(outcome, mint);
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
```

Note: `bumpDev` interpolates `field` into SQL — safe only because the parameter type is a union of three literals; do not widen that type.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/db.test.ts` — Expected: 6 passed.
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: sqlite knowledge base (tokens, devs, handles, alerts)"
```

---

### Task 3: PumpPortal message parsing + WebSocket client

**Files:**
- Create: `src/stream/parse.ts`, `src/stream/pumpportal.ts`
- Test: `tests/parse.test.ts`

**Interfaces:**
- Consumes: `NewTokenEvent`, `TradeEvent` from `src/types`
- Produces:
  - `parseMessage(raw: string, receivedAt: number): { type: 'new'; event: NewTokenEvent } | { type: 'trade'; event: TradeEvent } | null`
  - class `PumpPortalStream extends EventEmitter` — events `'new' (NewTokenEvent)`, `'trade' (TradeEvent)`, `'status' (string)`; methods `connect(): void`, `subscribeTrades(mint: string): void`, `unsubscribeTrades(mint: string): void`, `close(): void`. Reconnects with exponential backoff 1s→30s and re-subscribes new-token feed plus all tracked mints on reconnect.

PumpPortal (`wss://pumpportal.fun/api/data`) message shapes this parser must handle:
- Creation: `{ signature, mint, traderPublicKey, txType: 'create', initialBuy, solAmount, bondingCurveKey, vTokensInBondingCurve, vSolInBondingCurve, marketCapSol, name, symbol, uri, pool: 'pump' }`
- Trade: `{ signature, mint, traderPublicKey, txType: 'buy' | 'sell', tokenAmount, solAmount, newTokenBalance, bondingCurveKey, vTokensInBondingCurve, vSolInBondingCurve, marketCapSol, pool }`
- Anything else (subscription confirmations, malformed JSON) → `null`.

- [ ] **Step 1: Write the failing test**

Create `tests/parse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/stream/parse';

const CREATE = JSON.stringify({
  signature: 'sig1', mint: 'MintPubkey111', traderPublicKey: 'DevWallet111', txType: 'create',
  initialBuy: 35000000, solAmount: 1.0, bondingCurveKey: 'Curve111',
  vTokensInBondingCurve: 1000000000, vSolInBondingCurve: 31, marketCapSol: 31.5,
  name: 'Cool Token', symbol: 'COOL', uri: 'https://ipfs.io/ipfs/abc', pool: 'pump',
});

const BUY = JSON.stringify({
  signature: 'sig2', mint: 'MintPubkey111', traderPublicKey: 'Buyer111', txType: 'buy',
  tokenAmount: 1000000, solAmount: 0.5, newTokenBalance: 1000000,
  bondingCurveKey: 'Curve111', marketCapSol: 33.1, pool: 'pump',
});

describe('parseMessage', () => {
  it('parses a create message into NewTokenEvent', () => {
    const r = parseMessage(CREATE, 1234);
    expect(r?.type).toBe('new');
    if (r?.type !== 'new') return;
    expect(r.event).toMatchObject({
      mint: 'MintPubkey111', creator: 'DevWallet111', symbol: 'COOL', name: 'Cool Token',
      uri: 'https://ipfs.io/ipfs/abc', devBuyTokens: 35000000, devBuySol: 1.0,
      bondingCurveKey: 'Curve111', marketCapSol: 31.5, signature: 'sig1', receivedAt: 1234,
    });
  });

  it('parses buy and sell messages into TradeEvent', () => {
    const r = parseMessage(BUY, 5678);
    expect(r?.type).toBe('trade');
    if (r?.type !== 'trade') return;
    expect(r.event).toMatchObject({
      mint: 'MintPubkey111', trader: 'Buyer111', isBuy: true,
      tokenAmount: 1000000, solAmount: 0.5, marketCapSol: 33.1, receivedAt: 5678,
    });
    const sell = parseMessage(BUY.replace('"buy"', '"sell"'), 1);
    expect(sell?.type === 'trade' && sell.event.isBuy).toBe(false);
  });

  it('returns null for confirmations, garbage, and missing mint', () => {
    expect(parseMessage('{"message":"Successfully subscribed"}', 1)).toBeNull();
    expect(parseMessage('not json', 1)).toBeNull();
    expect(parseMessage('{"txType":"create"}', 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/parse.test.ts` — Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement src/stream/parse.ts**

```typescript
import type { NewTokenEvent, TradeEvent } from '../types';

type Parsed = { type: 'new'; event: NewTokenEvent } | { type: 'trade'; event: TradeEvent } | null;

export function parseMessage(raw: string, receivedAt: number): Parsed {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object' || typeof msg.mint !== 'string' || !msg.mint) return null;

  if (msg.txType === 'create') {
    return {
      type: 'new',
      event: {
        mint: msg.mint,
        name: String(msg.name ?? ''),
        symbol: String(msg.symbol ?? ''),
        uri: String(msg.uri ?? ''),
        creator: String(msg.traderPublicKey ?? ''),
        devBuyTokens: Number(msg.initialBuy ?? 0),
        devBuySol: Number(msg.solAmount ?? 0),
        bondingCurveKey: String(msg.bondingCurveKey ?? ''),
        marketCapSol: Number(msg.marketCapSol ?? 0),
        signature: String(msg.signature ?? ''),
        receivedAt,
      },
    };
  }
  if (msg.txType === 'buy' || msg.txType === 'sell') {
    return {
      type: 'trade',
      event: {
        mint: msg.mint,
        trader: String(msg.traderPublicKey ?? ''),
        isBuy: msg.txType === 'buy',
        tokenAmount: Number(msg.tokenAmount ?? 0),
        solAmount: Number(msg.solAmount ?? 0),
        marketCapSol: Number(msg.marketCapSol ?? 0),
        signature: String(msg.signature ?? ''),
        receivedAt,
      },
    };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/parse.test.ts` — Expected: 3 passed.

- [ ] **Step 5: Implement src/stream/pumpportal.ts (no unit test — thin I/O wrapper, verified in the Task 13 dry run)**

```typescript
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { parseMessage } from './parse';

const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';

export class PumpPortalStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private tracked = new Set<string>();
  private backoffMs = 1000;
  private closed = false;

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(PUMPPORTAL_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1000;
      this.emit('status', 'connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      if (this.tracked.size) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...this.tracked] }));
      }
    });

    ws.on('message', (data) => {
      const parsed = parseMessage(data.toString(), Date.now());
      if (!parsed) return;
      if (parsed.type === 'new') this.emit('new', parsed.event);
      else this.emit('trade', parsed.event);
    });

    // 'error' always precedes 'close'; schedule the reconnect only from 'close' so it fires once
    ws.on('error', (err) => this.emit('status', `ws error: ${err.message}`));
    ws.on('close', () => {
      if (this.closed) return;
      this.emit('status', `reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  subscribeTrades(mint: string): void {
    this.tracked.add(mint);
    this.sendIfOpen({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  unsubscribeTrades(mint: string): void {
    this.tracked.delete(mint);
    this.sendIfOpen({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private sendIfOpen(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — Expected: no errors.

```powershell
git add -A; git commit -m "feat: pumpportal stream client and message parser"
```

---

### Task 4: SOL price feed + logger

**Files:**
- Create: `src/solPrice.ts`, `src/logger.ts`
- Test: `tests/solPrice.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - class `SolPrice` — `new SolPrice(fallbackUsd: number, fetchFn?: typeof fetch)`, getter `usd: number`, `refresh(): Promise<void>`, `start(intervalMs?: number): NodeJS.Timeout`
  - `log(level: 'info' | 'warn' | 'error', msg: string): void` — writes to console and appends to `logs/scanner.log`

- [ ] **Step 1: Write the failing test**

Create `tests/solPrice.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SolPrice } from '../src/solPrice';

const okFetch = (usd: number) => (async () =>
  new Response(JSON.stringify({ solana: { usd } }), { status: 200 })) as unknown as typeof fetch;

describe('SolPrice', () => {
  it('starts at the fallback price', () => {
    expect(new SolPrice(150).usd).toBe(150);
  });

  it('updates on successful refresh', async () => {
    const p = new SolPrice(150, okFetch(203.5));
    await p.refresh();
    expect(p.usd).toBe(203.5);
  });

  it('keeps last known price when fetch fails or returns junk', async () => {
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const p = new SolPrice(150, failing);
    await p.refresh();
    expect(p.usd).toBe(150);

    const junk = (async () => new Response('{"solana":{}}', { status: 200 })) as unknown as typeof fetch;
    const p2 = new SolPrice(150, junk);
    await p2.refresh();
    expect(p2.usd).toBe(150);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/solPrice.test.ts` — Expected: FAIL, cannot resolve module.

- [ ] **Step 3: Implement src/solPrice.ts and src/logger.ts**

`src/solPrice.ts`:

```typescript
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

export class SolPrice {
  private current: number;

  constructor(fallbackUsd: number, private fetchFn: typeof fetch = fetch) {
    this.current = fallbackUsd;
  }

  get usd(): number { return this.current; }

  async refresh(): Promise<void> {
    try {
      const res = await this.fetchFn(COINGECKO_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const j = (await res.json()) as { solana?: { usd?: number } };
      if (typeof j.solana?.usd === 'number' && j.solana.usd > 0) this.current = j.solana.usd;
    } catch {
      // keep last known price
    }
  }

  start(intervalMs = 300_000): NodeJS.Timeout {
    void this.refresh();
    const t = setInterval(() => void this.refresh(), intervalMs);
    t.unref();
    return t;
  }
}
```

`src/logger.ts`:

```typescript
import { appendFileSync, mkdirSync } from 'node:fs';

let dirReady = false;

export function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  try {
    if (!dirReady) { mkdirSync('logs', { recursive: true }); dirReady = true; }
    appendFileSync('logs/scanner.log', line + '\n');
  } catch {
    // console output already happened; never crash on log I/O
  }
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/solPrice.test.ts` — Expected: 3 passed. Run: `npm run typecheck` — no errors.

```powershell
git add -A; git commit -m "feat: sol price feed with fallback, file logger"
```

---

### Task 5: Token metadata fetch + Twitter handle normalization

**Files:**
- Create: `src/checks/metadata.ts`, `src/checks/socials.ts`
- Test: `tests/metadata.test.ts`, `tests/socials.test.ts`

**Interfaces:**
- Consumes: `TokenMeta` from `src/types`
- Produces:
  - `ipfsToHttp(uri: string): string`
  - `extractMeta(json: unknown): TokenMeta`
  - `fetchMeta(uri: string, fetchFn?: typeof fetch): Promise<TokenMeta | 'unknown'>` — 5s timeout, one retry
  - `normalizeTwitterHandle(input: string): string | null` — lowercase handle, `community:<id>` for X communities, `null` if unparseable
  - `normalizeUrl(s: string): string` — prefixes `https://` if missing

- [ ] **Step 1: Write the failing tests**

Create `tests/metadata.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ipfsToHttp, extractMeta, fetchMeta } from '../src/checks/metadata';

describe('ipfsToHttp', () => {
  it('converts ipfs:// and passes through https://', () => {
    expect(ipfsToHttp('ipfs://QmAbc')).toBe('https://ipfs.io/ipfs/QmAbc');
    expect(ipfsToHttp('https://ipfs.io/ipfs/QmAbc')).toBe('https://ipfs.io/ipfs/QmAbc');
  });
});

describe('extractMeta', () => {
  it('extracts trimmed social fields, dropping empties', () => {
    expect(extractMeta({ twitter: ' https://x.com/dev ', telegram: '', website: 'cool.io', image: 'x' }))
      .toEqual({ twitter: 'https://x.com/dev', telegram: undefined, website: 'cool.io' });
    expect(extractMeta(null)).toEqual({ twitter: undefined, telegram: undefined, website: undefined });
  });
});

describe('fetchMeta', () => {
  it('returns parsed meta on success', async () => {
    const f = (async () => new Response('{"twitter":"https://x.com/dev"}', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchMeta('https://meta.uri', f)).toEqual({ twitter: 'https://x.com/dev', telegram: undefined, website: undefined });
  });

  it("returns 'unknown' when both attempts fail", async () => {
    let calls = 0;
    const f = (async () => { calls++; throw new Error('net'); }) as unknown as typeof fetch;
    expect(await fetchMeta('https://meta.uri', f)).toBe('unknown');
    expect(calls).toBe(2);
  });
});
```

Create `tests/socials.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeTwitterHandle, normalizeUrl } from '../src/checks/socials';

describe('normalizeTwitterHandle', () => {
  it('normalizes urls, bare handles, and @handles to lowercase', () => {
    expect(normalizeTwitterHandle('https://twitter.com/CoolDev')).toBe('cooldev');
    expect(normalizeTwitterHandle('https://x.com/CoolDev?s=21')).toBe('cooldev');
    expect(normalizeTwitterHandle('x.com/CoolDev/status/123')).toBe('cooldev');
    expect(normalizeTwitterHandle('@CoolDev')).toBe('cooldev');
    expect(normalizeTwitterHandle('CoolDev')).toBe('cooldev');
  });

  it('maps X communities to community:<id>', () => {
    expect(normalizeTwitterHandle('https://x.com/i/communities/1234567890')).toBe('community:1234567890');
  });

  it('returns null for junk and reserved paths', () => {
    expect(normalizeTwitterHandle('https://example.com/foo')).toBeNull();
    expect(normalizeTwitterHandle('https://x.com/search?q=a')).toBeNull();
    expect(normalizeTwitterHandle('')).toBeNull();
    expect(normalizeTwitterHandle('has spaces!!')).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('prefixes https:// only when missing', () => {
    expect(normalizeUrl('t.me/coolcoin')).toBe('https://t.me/coolcoin');
    expect(normalizeUrl('http://coolcoin.io')).toBe('http://coolcoin.io');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/metadata.test.ts tests/socials.test.ts` — Expected: FAIL, unresolved modules.

- [ ] **Step 3: Implement src/checks/metadata.ts**

```typescript
import type { TokenMeta } from '../types';

export function ipfsToHttp(uri: string): string {
  return uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}` : uri;
}

export function extractMeta(json: unknown): TokenMeta {
  const j = (json ?? {}) as Record<string, unknown>;
  const pick = (k: string): string | undefined => {
    const v = j[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  return { twitter: pick('twitter'), telegram: pick('telegram'), website: pick('website') };
}

export async function fetchMeta(uri: string, fetchFn: typeof fetch = fetch): Promise<TokenMeta | 'unknown'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(ipfsToHttp(uri), { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      return extractMeta(await res.json());
    } catch {
      // retry once
    }
  }
  return 'unknown';
}
```

- [ ] **Step 4: Implement src/checks/socials.ts**

```typescript
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED = new Set(['home', 'search', 'explore', 'intent', 'share', 'hashtag', 'i', 'settings']);

export function normalizeTwitterHandle(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(s)) return s.replace(/^@/, '').toLowerCase();

  let url: URL;
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/(^|\.)(twitter|x)\.com$/.test(url.hostname)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'i' && parts[1] === 'communities' && parts[2]) return `community:${parts[2]}`;
  if (parts[0] && !RESERVED.has(parts[0].toLowerCase()) && HANDLE_RE.test(parts[0])) {
    return parts[0].toLowerCase();
  }
  return null;
}

export function normalizeUrl(s: string): string {
  return s.startsWith('http://') || s.startsWith('https://') ? s : `https://${s}`;
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run tests/metadata.test.ts tests/socials.test.ts` — Expected: all passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: metadata fetch and twitter handle normalization"
```

---

### Task 6: Stage 1 mint filters

**Files:**
- Create: `src/pipeline/stage1.ts`
- Test: `tests/stage1.test.ts`

**Interfaces:**
- Consumes: `NewTokenEvent`, `TokenMeta`, `TOTAL_SUPPLY` from `src/types`; `Stage1Config` from `src/config`
- Produces:
  - `interface Stage1Input { event: NewTokenEvent; meta: TokenMeta | 'unknown'; handleSeenBefore: boolean; creatorLaunches48h: number; symbolClone24h: boolean }`
  - `stage1Filter(input: Stage1Input, cfg: Stage1Config): { pass: boolean; reason?: string }` — pure; caller supplies all DB lookups.

- [ ] **Step 1: Write the failing test**

Create `tests/stage1.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { stage1Filter, type Stage1Input } from '../src/pipeline/stage1';
import type { NewTokenEvent } from '../src/types';

const CFG = { maxDevBuyPct: 10, maxCreatorLaunches48h: 2, tickerCloneWindowHours: 24 };

const event = (over: Partial<NewTokenEvent> = {}): NewTokenEvent => ({
  mint: 'mintA', name: 'Cool', symbol: 'COOL', uri: 'https://u', creator: 'dev1',
  devBuyTokens: 20_000_000, devBuySol: 1, bondingCurveKey: 'bc', marketCapSol: 31,
  signature: 's', receivedAt: 0, ...over,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stage1.test.ts` — Expected: FAIL, unresolved module.

- [ ] **Step 3: Implement src/pipeline/stage1.ts**

```typescript
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
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/stage1.test.ts` — Expected: 5 passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: stage 1 mint filters"
```

---

### Task 7: Watchlist state machine (traction, dev-sell, bundling, expiry)

**Files:**
- Create: `src/pipeline/watchlist.ts`
- Test: `tests/watchlist.test.ts`

**Interfaces:**
- Consumes: `NewTokenEvent`, `TradeEvent`, `TokenMeta` from `src/types`; `WatchConfig` from `src/config`
- Produces:
  - `interface WatchedToken { event: NewTokenEvent; meta: TokenMeta; buyers: Set<string>; buys: number; sells: number; devSold: boolean; earlyBuyers: Set<string>; lastMarketCapSol: number; addedAt: number }`
  - `interface WatchlistHooks { onTrigger(t: WatchedToken): void; onDisqualify(t: WatchedToken, reason: string): void; onExpire(t: WatchedToken): void; subscribe(mint: string): void; unsubscribe(mint: string): void }`
  - class `Watchlist` — `new Watchlist(cfg: WatchConfig, hooks: WatchlistHooks)`, `add(event, meta, now): void`, `onTrade(trade, solUsd, now): void`, `sweep(now): void`, `mints(): string[]`, getter `size: number`
- Behavior contract: a token leaves the watchlist (and gets unsubscribed) on trigger, disqualify, expiry, or capacity eviction — each exactly once. Bundle rule: ≥ `bundleMaxBuyers` distinct non-creator buyers within `bundleWindowMs` of `add` → disqualify (this is the spec's "creation slot" check, approximated by arrival time since PumpPortal messages carry no slot). Dev sell → disqualify. Trigger: `marketCapSol × solUsd ≥ triggerMarketCapUsd` AND `buyers.size ≥ triggerUniqueBuyers`.

- [ ] **Step 1: Write the failing test**

Create `tests/watchlist.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { Watchlist, type WatchedToken } from '../src/pipeline/watchlist';
import type { NewTokenEvent, TradeEvent } from '../src/types';

const CFG = {
  windowMinutes: 90, maxConcurrent: 3, triggerMarketCapUsd: 15000,
  triggerUniqueBuyers: 3, bundleWindowMs: 1500, bundleMaxBuyers: 3,
};

const newToken = (mint: string): NewTokenEvent => ({
  mint, name: 'T', symbol: 'T', uri: 'u', creator: 'dev1', devBuyTokens: 0, devBuySol: 0,
  bondingCurveKey: 'bc', marketCapSol: 30, signature: 's', receivedAt: 0,
});

const trade = (mint: string, trader: string, isBuy: boolean, marketCapSol: number, at: number): TradeEvent & { at: number } =>
  ({ mint, trader, isBuy, tokenAmount: 1, solAmount: 1, marketCapSol, signature: 'x', receivedAt: at, at });

describe('Watchlist', () => {
  let triggered: WatchedToken[]; let disqualified: Array<[WatchedToken, string]>;
  let expired: WatchedToken[]; let subs: string[]; let unsubs: string[];
  let wl: Watchlist;

  beforeEach(() => {
    triggered = []; disqualified = []; expired = []; subs = []; unsubs = [];
    wl = new Watchlist(CFG, {
      onTrigger: (t) => triggered.push(t),
      onDisqualify: (t, r) => disqualified.push([t, r]),
      onExpire: (t) => expired.push(t),
      subscribe: (m) => subs.push(m),
      unsubscribe: (m) => unsubs.push(m),
    });
  });

  it('triggers when MC and unique buyers thresholds are both met', () => {
    wl.add(newToken('m1'), {}, 0);
    expect(subs).toEqual(['m1']);
    // 3 unique buyers at $100/SOL: 200 SOL MC = $20k >= $15k, spread out past the bundle window
    wl.onTrade(trade('m1', 'a', true, 100, 5000), 100, 5000);
    wl.onTrade(trade('m1', 'b', true, 150, 6000), 100, 6000);
    expect(triggered).toHaveLength(0); // only 2 buyers so far
    wl.onTrade(trade('m1', 'c', true, 200, 7000), 100, 7000);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].buyers.size).toBe(3);
    expect(triggered[0].lastMarketCapSol).toBe(200);
    expect(unsubs).toEqual(['m1']);
    // further trades are ignored — no double trigger
    wl.onTrade(trade('m1', 'd', true, 300, 8000), 100, 8000);
    expect(triggered).toHaveLength(1);
  });

  it('does not trigger on MC alone without enough buyers', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'a', true, 500, 5000), 100, 5000);
    expect(triggered).toHaveLength(0);
  });

  it('disqualifies on dev sell', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'dev1', false, 25, 5000), 100, 5000);
    expect(disqualified).toHaveLength(1);
    expect(disqualified[0][1]).toBe('dev sold');
    expect(wl.size).toBe(0);
  });

  it('disqualifies bundled launches (3 distinct early buyers within 1500ms)', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'a', true, 31, 100), 100, 100);
    wl.onTrade(trade('m1', 'b', true, 32, 200), 100, 200);
    expect(disqualified).toHaveLength(0);
    wl.onTrade(trade('m1', 'c', true, 33, 300), 100, 300);
    expect(disqualified).toHaveLength(1);
    expect(disqualified[0][1]).toMatch(/bundled/);
  });

  it('dev buys do not count toward buyers or bundling', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'dev1', true, 31, 100), 100, 100);
    wl.onTrade(trade('m1', 'a', true, 32, 200), 100, 200);
    wl.onTrade(trade('m1', 'b', true, 33, 300), 100, 300);
    expect(disqualified).toHaveLength(0);
  });

  it('expires tokens past the watch window on sweep', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.sweep(90 * 60_000 + 1);
    expect(expired).toHaveLength(1);
    expect(wl.size).toBe(0);
  });

  it('evicts oldest when at capacity', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.add(newToken('m2'), {}, 1);
    wl.add(newToken('m3'), {}, 2);
    wl.add(newToken('m4'), {}, 3);
    expect(wl.size).toBe(3);
    expect(expired.map(t => t.event.mint)).toEqual(['m1']);
    expect(wl.mints()).toEqual(['m2', 'm3', 'm4']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/watchlist.test.ts` — Expected: FAIL, unresolved module.

- [ ] **Step 3: Implement src/pipeline/watchlist.ts**

```typescript
import type { NewTokenEvent, TradeEvent, TokenMeta } from '../types';
import type { WatchConfig } from '../config';

export interface WatchedToken {
  event: NewTokenEvent;
  meta: TokenMeta;
  buyers: Set<string>;
  buys: number;
  sells: number;
  devSold: boolean;
  earlyBuyers: Set<string>;
  lastMarketCapSol: number;
  addedAt: number;
}

export interface WatchlistHooks {
  onTrigger(t: WatchedToken): void;
  onDisqualify(t: WatchedToken, reason: string): void;
  onExpire(t: WatchedToken): void;
  subscribe(mint: string): void;
  unsubscribe(mint: string): void;
}

export class Watchlist {
  private tokens = new Map<string, WatchedToken>();

  constructor(private cfg: WatchConfig, private hooks: WatchlistHooks) {}

  get size(): number { return this.tokens.size; }
  mints(): string[] { return [...this.tokens.keys()]; }

  add(event: NewTokenEvent, meta: TokenMeta, now: number): void {
    if (this.tokens.size >= this.cfg.maxConcurrent) {
      let oldest: WatchedToken | null = null;
      for (const t of this.tokens.values()) {
        if (!oldest || t.addedAt < oldest.addedAt) oldest = t;
      }
      if (oldest) {
        this.remove(oldest.event.mint);
        this.hooks.onExpire(oldest);
      }
    }
    this.tokens.set(event.mint, {
      event, meta, buyers: new Set(), buys: 0, sells: 0, devSold: false,
      earlyBuyers: new Set(), lastMarketCapSol: event.marketCapSol, addedAt: now,
    });
    this.hooks.subscribe(event.mint);
  }

  onTrade(trade: TradeEvent, solUsd: number, now: number): void {
    const t = this.tokens.get(trade.mint);
    if (!t) return;
    t.lastMarketCapSol = trade.marketCapSol;
    const isDev = trade.trader === t.event.creator;

    if (!trade.isBuy) {
      t.sells++;
      if (isDev) {
        t.devSold = true;
        this.remove(trade.mint);
        this.hooks.onDisqualify(t, 'dev sold');
      }
      return;
    }

    t.buys++;
    if (isDev) return;
    t.buyers.add(trade.trader);

    if (now - t.addedAt <= this.cfg.bundleWindowMs) {
      t.earlyBuyers.add(trade.trader);
      if (t.earlyBuyers.size >= this.cfg.bundleMaxBuyers) {
        this.remove(trade.mint);
        this.hooks.onDisqualify(t, `bundled: ${t.earlyBuyers.size} buyers within ${this.cfg.bundleWindowMs}ms of mint`);
        return;
      }
    }

    const mcUsd = trade.marketCapSol * solUsd;
    if (mcUsd >= this.cfg.triggerMarketCapUsd && t.buyers.size >= this.cfg.triggerUniqueBuyers) {
      this.remove(trade.mint);
      this.hooks.onTrigger(t);
    }
  }

  sweep(now: number): void {
    const cutoff = now - this.cfg.windowMinutes * 60_000;
    for (const t of [...this.tokens.values()]) {
      if (t.addedAt < cutoff) {
        this.remove(t.event.mint);
        this.hooks.onExpire(t);
      }
    }
  }

  private remove(mint: string): void {
    this.tokens.delete(mint);
    this.hooks.unsubscribe(mint);
  }
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/watchlist.test.ts` — Expected: 7 passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: watchlist state machine with traction, dev-sell, bundle, expiry"
```

---

### Task 8: RPC wrapper + dev wallet history + holder concentration

**Files:**
- Create: `src/rpc.ts`, `src/checks/devHistory.ts`, `src/checks/holders.ts`
- Test: `tests/rpc.test.ts`, `tests/holders.test.ts`

**Interfaces:**
- Consumes: `TOTAL_SUPPLY` from `src/types`
- Produces:
  - class `Rpc` — `new Rpc(url: string, fetchFn?: typeof fetch)`, `call<T>(method: string, params: unknown[]): Promise<T>` — 3 attempts on 429/5xx/network error with jittered backoff, 10s timeout, throws on exhaustion or RPC-level error
  - `interface DevHistory { priorLaunches: number; anyGraduated: boolean; funder: string | null }`
  - `fetchDevHistory(rpc: Rpc, creator: string, currentMint: string, dbPriorLaunches: number, dbGraduated: number, maxTxFetch?: number): Promise<DevHistory | 'unknown'>`
  - `fetchTop10Pct(rpc: Rpc, mint: string, bondingCurveKey: string): Promise<number | 'unknown'>`
- Pump.fun program ID constant: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. Bounded cost: at most 1 `getSignaturesForAddress` page (limit 1000), at most `maxTxFetch` (default 40) `getTransaction` calls in batches of 5, plus 1 for funding source. Funding source only resolved when the wallet's full history fits in one page (< 1000 signatures); otherwise `funder: null`.

- [ ] **Step 1: Write the failing tests**

Create `tests/rpc.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Rpc } from '../src/rpc';

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Rpc', () => {
  it('returns result on success', async () => {
    const f = (async () => jsonRes({ jsonrpc: '2.0', id: 1, result: 42 })) as unknown as typeof fetch;
    expect(await new Rpc('https://rpc', f).call<number>('getFoo', [])).toBe(42);
  });

  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 3 ? jsonRes({}, 429) : jsonRes({ jsonrpc: '2.0', id: 1, result: 'ok' });
    }) as unknown as typeof fetch;
    expect(await new Rpc('https://rpc', f).call<string>('getFoo', [])).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws after 3 failed attempts', async () => {
    let calls = 0;
    const f = (async () => { calls++; return jsonRes({}, 500); }) as unknown as typeof fetch;
    await expect(new Rpc('https://rpc', f).call('getFoo', [])).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('throws on RPC-level error without exhausting retries', async () => {
    let calls = 0;
    const f = (async () => { calls++; return jsonRes({ jsonrpc: '2.0', id: 1, error: { message: 'bad params' } }); }) as unknown as typeof fetch;
    await expect(new Rpc('https://rpc', f).call('getFoo', [])).rejects.toThrow(/bad params/);
    expect(calls).toBe(1);
  });
});
```

Create `tests/holders.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fetchTop10Pct } from '../src/checks/holders';
import type { Rpc } from '../src/rpc';

function fakeRpc(handlers: Record<string, (params: unknown[]) => unknown>): Rpc {
  return {
    call: async (method: string, params: unknown[]) => {
      if (!(method in handlers)) throw new Error(`unexpected method ${method}`);
      return handlers[method](params);
    },
  } as unknown as Rpc;
}

describe('fetchTop10Pct', () => {
  it('sums top 10 holders excluding the bonding curve account', async () => {
    const rpc = fakeRpc({
      getTokenLargestAccounts: () => ({
        value: [
          { address: 'curveAta', uiAmount: 800_000_000 },
          { address: 'h1', uiAmount: 100_000_000 },
          { address: 'h2', uiAmount: 50_000_000 },
        ],
      }),
      getMultipleAccounts: () => ({
        value: [
          { data: { parsed: { info: { owner: 'CurveKey' } } } },
          { data: { parsed: { info: { owner: 'wallet1' } } } },
          { data: { parsed: { info: { owner: 'wallet2' } } } },
        ],
      }),
    });
    // (100M + 50M) / 1B = 15%
    expect(await fetchTop10Pct(rpc, 'mint', 'CurveKey')).toBe(15);
  });

  it("returns 'unknown' on RPC failure or empty result", async () => {
    const failing = fakeRpc({ getTokenLargestAccounts: () => { throw new Error('rpc down'); } });
    expect(await fetchTop10Pct(failing, 'mint', 'CurveKey')).toBe('unknown');
    const empty = fakeRpc({ getTokenLargestAccounts: () => ({ value: [] }) });
    expect(await fetchTop10Pct(empty, 'mint', 'CurveKey')).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rpc.test.ts tests/holders.test.ts` — Expected: FAIL, unresolved modules.

- [ ] **Step 3: Implement src/rpc.ts**

```typescript
class RpcError extends Error {}

export class Rpc {
  private id = 0;

  constructor(private url: string, private fetchFn: typeof fetch = fetch) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 400 * attempt + Math.random() * 400));
      }
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`RPC HTTP ${res.status}`);
          continue;
        }
        const j = (await res.json()) as { result?: T; error?: { message?: string } };
        if (j.error) throw new RpcError(`${method}: ${j.error.message ?? 'unknown RPC error'}`);
        return j.result as T;
      } catch (err) {
        if (err instanceof RpcError) throw err; // deterministic error — retrying won't help
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
```

- [ ] **Step 4: Implement src/checks/holders.ts**

```typescript
import type { Rpc } from '../rpc';
import { TOTAL_SUPPLY } from '../types';

interface LargestAccount { address: string; uiAmount: number | null }
interface ParsedAccount { data?: { parsed?: { info?: { owner?: string } } } }

export async function fetchTop10Pct(rpc: Rpc, mint: string, bondingCurveKey: string): Promise<number | 'unknown'> {
  try {
    const largest = await rpc.call<{ value: LargestAccount[] }>('getTokenLargestAccounts', [mint]);
    const accounts = largest.value ?? [];
    if (!accounts.length) return 'unknown';

    const infos = await rpc.call<{ value: Array<ParsedAccount | null> }>(
      'getMultipleAccounts',
      [accounts.map((a) => a.address), { encoding: 'jsonParsed' }],
    );
    const owners = (infos.value ?? []).map((v) => v?.data?.parsed?.info?.owner ?? '');
    const holders = accounts.filter((_, i) => owners[i] !== bondingCurveKey);
    const top10 = holders.slice(0, 10).reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
    return (top10 / TOTAL_SUPPLY) * 100;
  } catch {
    return 'unknown';
  }
}
```

- [ ] **Step 5: Implement src/checks/devHistory.ts (no unit test — thin orchestration over `Rpc`, exercised in Task 13's dry run; the retry/parse logic it depends on is tested above)**

```typescript
import type { Rpc } from '../rpc';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

export interface DevHistory {
  priorLaunches: number;
  anyGraduated: boolean;
  funder: string | null;
}

interface SigInfo { signature: string; blockTime: number | null }

export async function fetchDevHistory(
  rpc: Rpc,
  creator: string,
  currentMint: string,
  dbPriorLaunches: number,
  dbGraduated: number,
  maxTxFetch = 40,
): Promise<DevHistory | 'unknown'> {
  try {
    const sigs = await rpc.call<SigInfo[]>('getSignaturesForAddress', [creator, { limit: 1000 }]);

    let funder: string | null = null;
    if (sigs.length > 0 && sigs.length < 1000) {
      funder = await findFunder(rpc, creator, sigs[sigs.length - 1].signature);
    }

    let onchainCreations = 0;
    const toInspect = sigs.slice(0, maxTxFetch);
    for (let i = 0; i < toInspect.length; i += 5) {
      const batch = toInspect.slice(i, i + 5);
      const txs = await Promise.all(batch.map((s) =>
        rpc.call<TxJson | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }])
          .catch(() => null),
      ));
      for (const tx of txs) {
        if (isPumpCreation(tx) && !accountKeys(tx).includes(currentMint)) onchainCreations++;
      }
    }
    return {
      priorLaunches: Math.max(onchainCreations, dbPriorLaunches),
      anyGraduated: dbGraduated > 0,
      funder,
    };
  } catch {
    return 'unknown';
  }
}

interface TxJson {
  meta?: { logMessages?: string[] };
  transaction?: { message?: { accountKeys?: string[]; instructions?: unknown[] } };
}

function accountKeys(tx: TxJson | null): string[] {
  return tx?.transaction?.message?.accountKeys ?? [];
}

function isPumpCreation(tx: TxJson | null): boolean {
  if (!tx) return false;
  const logs = tx.meta?.logMessages ?? [];
  return accountKeys(tx).includes(PUMP_PROGRAM) && logs.some((l) => l.includes('Instruction: Create'));
}

interface ParsedTx {
  transaction?: {
    message?: {
      instructions?: Array<{ program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string } } }>;
    };
  };
}

async function findFunder(rpc: Rpc, wallet: string, oldestSig: string): Promise<string | null> {
  try {
    const tx = await rpc.call<ParsedTx | null>('getTransaction', [oldestSig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    for (const ix of tx?.transaction?.message?.instructions ?? []) {
      if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === wallet) {
        return ix.parsed.info.source ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run tests, typecheck, commit**

Run: `npx vitest run tests/rpc.test.ts tests/holders.test.ts` — Expected: 6 passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: rpc wrapper, dev wallet history, holder concentration checks"
```

---

### Task 9: Social liveness + best-effort X existence

**Files:**
- Create: `src/checks/liveness.ts`
- Test: `tests/liveness.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `type Liveness = boolean | 'unknown'`
  - `checkUrlAlive(url: string, fetchFn?: typeof fetch): Promise<Liveness>` — GET, follow redirects, 5s timeout, one retry; 404/410 → `false`, 2xx/3xx → `true`, anything else after retry → `'unknown'`
  - `checkXExists(handle: string, fetchFn?: typeof fetch): Promise<Liveness>` — via Twitter's free oEmbed endpoint (`https://publish.twitter.com/oembed?url=...`); 404 → `false`, 200 → `true`, else `'unknown'`; `community:*` handles → always `'unknown'` (no free check exists)

- [ ] **Step 1: Write the failing test**

Create `tests/liveness.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkUrlAlive, checkXExists } from '../src/checks/liveness';

const statusFetch = (status: number) => (async () => new Response('x', { status })) as unknown as typeof fetch;
const throwing = (async () => { throw new Error('net'); }) as unknown as typeof fetch;

describe('checkUrlAlive', () => {
  it('true on 2xx, false on 404/410', async () => {
    expect(await checkUrlAlive('https://a.io', statusFetch(200))).toBe(true);
    expect(await checkUrlAlive('https://a.io', statusFetch(404))).toBe(false);
    expect(await checkUrlAlive('https://a.io', statusFetch(410))).toBe(false);
  });

  it("'unknown' on network failure or server errors (never a hard fail)", async () => {
    expect(await checkUrlAlive('https://a.io', throwing)).toBe('unknown');
    expect(await checkUrlAlive('https://a.io', statusFetch(503))).toBe('unknown');
  });
});

describe('checkXExists', () => {
  it('true on oEmbed 200, false on 404, unknown on error', async () => {
    expect(await checkXExists('cooldev', statusFetch(200))).toBe(true);
    expect(await checkXExists('cooldev', statusFetch(404))).toBe(false);
    expect(await checkXExists('cooldev', throwing)).toBe('unknown');
  });

  it("communities are always 'unknown'", async () => {
    expect(await checkXExists('community:123', statusFetch(404))).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/liveness.test.ts` — Expected: FAIL, unresolved module.

- [ ] **Step 3: Implement src/checks/liveness.ts**

```typescript
export type Liveness = boolean | 'unknown';

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; TrenchesScanner/1.0)' };

export async function checkUrlAlive(url: string, fetchFn: typeof fetch = fetch): Promise<Liveness> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, { redirect: 'follow', signal: AbortSignal.timeout(5000), headers: UA });
      if (res.status === 404 || res.status === 410) return false;
      if (res.ok) return true;
    } catch {
      // retry once
    }
  }
  return 'unknown';
}

export async function checkXExists(handle: string, fetchFn: typeof fetch = fetch): Promise<Liveness> {
  if (handle.startsWith('community:')) return 'unknown';
  try {
    const url = `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/${handle}`)}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(5000), headers: UA });
    if (res.status === 404) return false;
    if (res.ok) return true;
  } catch {
    // fall through
  }
  return 'unknown';
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/liveness.test.ts` — Expected: 4 passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: social link liveness and best-effort X existence checks"
```

---

### Task 10: Scoring

**Files:**
- Create: `src/pipeline/scoring.ts`
- Test: `tests/scoring.test.ts`

**Interfaces:**
- Consumes: `DeepConfig` from `src/config`
- Produces:
  - `type Unknown<T> = T | 'unknown'`
  - `interface CheckResults { devHistory: Unknown<{ priorLaunches: number; anyGraduated: boolean }>; funderLinkedToRug: Unknown<boolean>; top10Pct: Unknown<number>; twitterAlive: Unknown<boolean>; telegramAlive: Unknown<boolean>; websiteAlive: Unknown<boolean>; xExists: Unknown<boolean>; devStillHolds: boolean }`
  - `interface ScoreResult { score: number; hardRejects: string[]; flags: string[] }`
  - `scoreToken(r: CheckResults, cfg: DeepConfig): ScoreResult` — pure. Base 50, clamp 0–100. Hard rejects per spec; `'unknown'` never scores in either direction, only flags.

- [ ] **Step 1: Write the failing test**

Create `tests/scoring.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { scoreToken, type CheckResults } from '../src/pipeline/scoring';

const CFG = {
  maxLifetimeLaunches: 3, priorLaunchPenalty: 15, graduatedBonus: 20,
  top10HardRejectPct: 45, top10BonusPct: 30, top10Bonus: 10,
  deadLinkPenalty: 10, liveWebsiteBonus: 10, xMissingPenalty: 15, devHoldsBonus: 10,
};

const clean = (over: Partial<CheckResults> = {}): CheckResults => ({
  devHistory: { priorLaunches: 0, anyGraduated: false },
  funderLinkedToRug: false, top10Pct: 20,
  twitterAlive: true, telegramAlive: true, websiteAlive: true,
  xExists: true, devStillHolds: true, ...over,
});

describe('scoreToken', () => {
  it('scores a clean token: 50 +10 top10 +10 website +10 devHolds = 80', () => {
    const r = scoreToken(clean(), CFG);
    expect(r).toEqual({ score: 80, hardRejects: [], flags: [] });
  });

  it('hard rejects serial dev, rug-linked funder, concentrated top10', () => {
    expect(scoreToken(clean({ devHistory: { priorLaunches: 4, anyGraduated: false } }), CFG).hardRejects)
      .toEqual(['serial dev: 4 launches, none graduated']);
    expect(scoreToken(clean({ funderLinkedToRug: true }), CFG).hardRejects)
      .toEqual(['dev funded by rug-linked wallet']);
    expect(scoreToken(clean({ top10Pct: 60 }), CFG).hardRejects).toEqual(['top10 holds 60%']);
  });

  it('graduated dev overrides launch count and earns bonus', () => {
    const r = scoreToken(clean({ devHistory: { priorLaunches: 5, anyGraduated: true } }), CFG);
    expect(r.hardRejects).toEqual([]);
    expect(r.score).toBe(100); // 80 + 20, clamped at 100
  });

  it('penalizes prior launches, dead links, missing X', () => {
    const r = scoreToken(clean({
      devHistory: { priorLaunches: 2, anyGraduated: false },
      twitterAlive: false, xExists: false,
    }), CFG);
    // 80 - 15 (priors) - 10 (dead twitter) - 15 (no X) = 40
    expect(r.score).toBe(40);
    expect(r.flags).toEqual(['2 prior launches', 'dead twitter link', 'X account not found']);
  });

  it("'unknown' results only flag, never score", () => {
    const r = scoreToken(clean({ devHistory: 'unknown', top10Pct: 'unknown', xExists: 'unknown' }), CFG);
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
    }), CFG);
    // 50 -15 -10 -10 -10 -15 = -10 → 0
    expect(r.score).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scoring.test.ts` — Expected: FAIL, unresolved module.

- [ ] **Step 3: Implement src/pipeline/scoring.ts**

```typescript
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
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/scoring.test.ts` — Expected: 6 passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: token scoring with hard rejects and soft flags"
```

---

### Task 11: Telegram formatting + sender

**Files:**
- Create: `src/telegram.ts`
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `escapeHtml(s: string): string`
  - `interface AlertData { mint: string; name: string; symbol: string; score: number; flags: string[]; marketCapUsd: number; ageMinutes: number; uniqueBuyers: number; devBuyPct: number; devStillHolds: boolean; priorLaunches: number | 'unknown'; top10Pct: number | 'unknown'; twitter?: string; telegram?: string; website?: string }`
  - `formatAlert(d: AlertData): string` — Telegram HTML
  - class `Telegram` — `new Telegram(botToken: string, chatId: string, fetchFn?: typeof fetch)`, `send(text: string): Promise<boolean>` — 3 attempts, honors 429 `retry_after`, returns `false` on final failure (never throws)

- [ ] **Step 1: Write the failing test**

Create `tests/telegram.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { escapeHtml, formatAlert, Telegram, type AlertData } from '../src/telegram';

const DATA: AlertData = {
  mint: 'MintPubkey111', name: 'Cool <Token>', symbol: 'COOL', score: 74,
  flags: ['top10 35%'], marketCapUsd: 18400, ageMinutes: 23, uniqueBuyers: 41,
  devBuyPct: 2.1, devStillHolds: true, priorLaunches: 0, top10Pct: 21,
  twitter: 'https://x.com/dev', telegram: 'https://t.me/c', website: undefined,
};

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('formatAlert', () => {
  it('renders the full alert with escaped name, copyable CA, links, and flags', () => {
    const text = formatAlert(DATA);
    expect(text).toContain('TRENCH ALERT — $COOL');
    expect(text).toContain('(score 74/100)');
    expect(text).toContain('Cool &lt;Token&gt;');
    expect(text).toContain('MC $18.4k • age 23m • buyers 41');
    expect(text).toContain('<code>MintPubkey111</code>');
    expect(text).toContain('bought 2.1%, still holds, 0 prior launches');
    expect(text).toContain('top10 21%');
    expect(text).toContain('𝕏 ✓  TG ✓  Web ✗');
    expect(text).toContain('https://pump.fun/coin/MintPubkey111');
    expect(text).toContain('https://gmgn.ai/sol/token/MintPubkey111');
    expect(text).toContain('https://solscan.io/token/MintPubkey111');
    expect(text).toContain('https://rugcheck.xyz/tokens/MintPubkey111');
    expect(text).toContain('⚠️ top10 35%');
  });

  it('renders unknowns as ? and omits flag line when empty', () => {
    const text = formatAlert({ ...DATA, priorLaunches: 'unknown', top10Pct: 'unknown', flags: [] });
    expect(text).toContain('? prior launches');
    expect(text).toContain('top10 ?');
    expect(text).not.toContain('⚠️');
  });
});

describe('Telegram', () => {
  it('posts to the bot API and returns true on ok', async () => {
    let captured: { url: string; body: string } | null = null;
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await new Telegram('TOKEN', '42', f).send('hello');
    expect(ok).toBe(true);
    expect(captured!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(captured!.body);
    expect(body).toMatchObject({ chat_id: '42', text: 'hello', parse_mode: 'HTML' });
  });

  it('returns false after 3 failures without throwing', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('err', { status: 400 }); }) as unknown as typeof fetch;
    expect(await new Telegram('T', '1', f).send('x')).toBe(false);
    expect(calls).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/telegram.test.ts` — Expected: FAIL, unresolved module.

- [ ] **Step 3: Implement src/telegram.ts**

```typescript
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface AlertData {
  mint: string;
  name: string;
  symbol: string;
  score: number;
  flags: string[];
  marketCapUsd: number;
  ageMinutes: number;
  uniqueBuyers: number;
  devBuyPct: number;
  devStillHolds: boolean;
  priorLaunches: number | 'unknown';
  top10Pct: number | 'unknown';
  twitter?: string;
  telegram?: string;
  website?: string;
}

export function formatAlert(d: AlertData): string {
  const mc = d.marketCapUsd >= 1000 ? `$${(d.marketCapUsd / 1000).toFixed(1)}k` : `$${d.marketCapUsd.toFixed(0)}`;
  const mark = (v: string | undefined) => (v ? '✓' : '✗');
  const top10 = d.top10Pct === 'unknown' ? '?' : `${d.top10Pct.toFixed(0)}%`;
  const priors = d.priorLaunches === 'unknown' ? '?' : String(d.priorLaunches);
  const links = [
    `<a href="https://pump.fun/coin/${d.mint}">pump.fun</a>`,
    `<a href="https://gmgn.ai/sol/token/${d.mint}">GMGN</a>`,
    `<a href="https://solscan.io/token/${d.mint}">Solscan</a>`,
    `<a href="https://rugcheck.xyz/tokens/${d.mint}">RugCheck</a>`,
  ].join(' | ');

  const lines = [
    `🎯 <b>TRENCH ALERT — $${escapeHtml(d.symbol)}</b>  (score ${d.score}/100)`,
    `${escapeHtml(d.name)} • MC ${mc} • age ${d.ageMinutes}m • buyers ${d.uniqueBuyers}`,
    `CA: <code>${d.mint}</code>`,
    `Dev: bought ${d.devBuyPct.toFixed(1)}%, ${d.devStillHolds ? 'still holds' : 'sold some'}, ${priors} prior launches`,
    `Holders: top10 ${top10} • bundle: clean`,
    `Socials: 𝕏 ${mark(d.twitter)}  TG ${mark(d.telegram)}  Web ${mark(d.website)}`,
    links,
  ];
  if (d.flags.length) lines.push(`⚠️ ${d.flags.map(escapeHtml).join(', ')}`);
  return lines.join('\n');
}

export class Telegram {
  constructor(
    private botToken: string,
    private chatId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return true;
        if (res.status === 429) {
          const j = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
          await new Promise((r) => setTimeout(r, ((j?.parameters?.retry_after ?? 3) + 1) * 1000));
        }
      } catch {
        // retry
      }
    }
    return false;
  }
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/telegram.test.ts` — Expected: 5 passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: telegram alert formatting and sender"
```

---

### Task 12: Stage 3 deep-check orchestrator

**Files:**
- Create: `src/pipeline/stage3.ts`
- Test: `tests/stage3.test.ts`

**Interfaces:**
- Consumes: `WatchedToken` from `src/pipeline/watchlist`; `CheckResults`, `Unknown` from `src/pipeline/scoring`; `Liveness` from `src/checks/liveness`; `DevHistory` from `src/checks/devHistory`; `normalizeTwitterHandle`, `normalizeUrl` from `src/checks/socials`
- Produces:
  - `interface DeepCheckDeps { fetchDevHistory(creator: string, mint: string): Promise<DevHistory | 'unknown'>; isRugLinked(wallet: string): boolean; fetchTop10Pct(mint: string, bondingCurveKey: string): Promise<number | 'unknown'>; checkUrlAlive(url: string): Promise<Liveness>; checkXExists(handle: string): Promise<Liveness> }`
  - `runDeepChecks(t: WatchedToken, deps: DeepCheckDeps): Promise<CheckResults>` — runs all checks concurrently; social checks only for links present in `t.meta` (absent link → `'unknown'`); `funderLinkedToRug` is `'unknown'` when the funder could not be resolved.

- [ ] **Step 1: Write the failing test**

Create `tests/stage3.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runDeepChecks, type DeepCheckDeps } from '../src/pipeline/stage3';
import type { WatchedToken } from '../src/pipeline/watchlist';

const watched = (meta: WatchedToken['meta']): WatchedToken => ({
  event: {
    mint: 'mintA', name: 'T', symbol: 'T', uri: 'u', creator: 'dev1', devBuyTokens: 0,
    devBuySol: 0, bondingCurveKey: 'bc1', marketCapSol: 100, signature: 's', receivedAt: 0,
  },
  meta, buyers: new Set(['a', 'b']), buys: 2, sells: 0, devSold: false,
  earlyBuyers: new Set(), lastMarketCapSol: 100, addedAt: 0,
});

const deps = (over: Partial<DeepCheckDeps> = {}): DeepCheckDeps => ({
  fetchDevHistory: async () => ({ priorLaunches: 1, anyGraduated: false, funder: 'funder1' }),
  isRugLinked: (w) => w === 'ruggerFunder',
  fetchTop10Pct: async () => 22,
  checkUrlAlive: async () => true,
  checkXExists: async () => true,
  ...over,
});

describe('runDeepChecks', () => {
  it('assembles results from all checks', async () => {
    const r = await runDeepChecks(watched({ twitter: 'https://x.com/CoolDev', telegram: 't.me/c', website: 'coolcoin.io' }), deps());
    expect(r).toEqual({
      devHistory: { priorLaunches: 1, anyGraduated: false },
      funderLinkedToRug: false, top10Pct: 22,
      twitterAlive: true, telegramAlive: true, websiteAlive: true,
      xExists: true, devStillHolds: true,
    });
  });

  it("marks absent links 'unknown' and skips their checks", async () => {
    let urlChecks = 0;
    const r = await runDeepChecks(
      watched({ twitter: 'https://x.com/CoolDev' }),
      deps({ checkUrlAlive: async () => { urlChecks++; return true; } }),
    );
    expect(r.telegramAlive).toBe('unknown');
    expect(r.websiteAlive).toBe('unknown');
    expect(urlChecks).toBe(1);
  });

  it('flags rug-linked funder; unknown funder stays unknown', async () => {
    const linked = await runDeepChecks(
      watched({ twitter: 'https://x.com/d' }),
      deps({ fetchDevHistory: async () => ({ priorLaunches: 0, anyGraduated: false, funder: 'ruggerFunder' }) }),
    );
    expect(linked.funderLinkedToRug).toBe(true);

    const noFunder = await runDeepChecks(
      watched({ twitter: 'https://x.com/d' }),
      deps({ fetchDevHistory: async () => ({ priorLaunches: 0, anyGraduated: false, funder: null }) }),
    );
    expect(noFunder.funderLinkedToRug).toBe('unknown');
  });

  it('propagates unknown dev history', async () => {
    const r = await runDeepChecks(watched({ twitter: 'https://x.com/d' }), deps({ fetchDevHistory: async () => 'unknown' }));
    expect(r.devHistory).toBe('unknown');
    expect(r.funderLinkedToRug).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stage3.test.ts` — Expected: FAIL, unresolved module.

- [ ] **Step 3: Implement src/pipeline/stage3.ts**

```typescript
import type { WatchedToken } from './watchlist';
import type { CheckResults, Unknown } from './scoring';
import type { DevHistory } from '../checks/devHistory';
import type { Liveness } from '../checks/liveness';
import { normalizeTwitterHandle, normalizeUrl } from '../checks/socials';

export interface DeepCheckDeps {
  fetchDevHistory(creator: string, mint: string): Promise<DevHistory | 'unknown'>;
  isRugLinked(wallet: string): boolean;
  fetchTop10Pct(mint: string, bondingCurveKey: string): Promise<number | 'unknown'>;
  checkUrlAlive(url: string): Promise<Liveness>;
  checkXExists(handle: string): Promise<Liveness>;
}

const UNKNOWN = Promise.resolve('unknown' as const);

export async function runDeepChecks(t: WatchedToken, deps: DeepCheckDeps): Promise<CheckResults> {
  const handle = t.meta.twitter ? normalizeTwitterHandle(t.meta.twitter) : null;

  const [devHistory, top10Pct, twitterAlive, telegramAlive, websiteAlive, xExists] = await Promise.all([
    deps.fetchDevHistory(t.event.creator, t.event.mint),
    deps.fetchTop10Pct(t.event.mint, t.event.bondingCurveKey),
    t.meta.twitter ? deps.checkUrlAlive(normalizeUrl(t.meta.twitter)) : UNKNOWN,
    t.meta.telegram ? deps.checkUrlAlive(normalizeUrl(t.meta.telegram)) : UNKNOWN,
    t.meta.website ? deps.checkUrlAlive(normalizeUrl(t.meta.website)) : UNKNOWN,
    handle ? deps.checkXExists(handle) : UNKNOWN,
  ]);

  let funderLinkedToRug: Unknown<boolean> = 'unknown';
  if (devHistory !== 'unknown' && devHistory.funder) {
    funderLinkedToRug = deps.isRugLinked(devHistory.funder);
  }

  return {
    devHistory: devHistory === 'unknown'
      ? 'unknown'
      : { priorLaunches: devHistory.priorLaunches, anyGraduated: devHistory.anyGraduated },
    funderLinkedToRug,
    top10Pct,
    twitterAlive,
    telegramAlive,
    websiteAlive,
    xExists,
    devStillHolds: !t.devSold,
  };
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run tests/stage3.test.ts` — Expected: 4 passed. Run: `npm run typecheck`.

```powershell
git add -A; git commit -m "feat: stage 3 deep-check orchestrator"
```

---

### Task 13: Main wiring, daily summary, dry-run verification

**Files:**
- Create: `src/index.ts`, `src/summary.ts`
- Test: `tests/summary.test.ts` (summary logic only; `index.ts` is verified by live dry run)

**Interfaces:**
- Consumes: everything produced by Tasks 1–12
- Produces: runnable `npm start` / `npm run dry`; `maybeSendSummary(db: Db, send: (text: string) => Promise<boolean>, hourLocal: number, now: Date, lastSentDay: number): Promise<number>` — returns the new `lastSentDay` (sends at most once per calendar day when `now` hits the configured hour).

- [ ] **Step 1: Write the failing summary test**

Create `tests/summary.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { maybeSendSummary } from '../src/summary';
import { Db } from '../src/db/index';

describe('maybeSendSummary', () => {
  it('sends once when the hour matches, then not again the same day', async () => {
    const db = new Db(':memory:');
    const sent: string[] = [];
    const send = async (t: string) => { sent.push(t); return true; };

    const at9 = new Date(2026, 6, 5, 9, 0, 0);
    let last = await maybeSendSummary(db, send, 9, at9, -1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/scanned 0 • watched 0 • alerted 0/);
    expect(last).toBe(5);

    last = await maybeSendSummary(db, send, 9, at9, last);
    expect(sent).toHaveLength(1); // no double send

    const at8 = new Date(2026, 6, 6, 8, 0, 0);
    last = await maybeSendSummary(db, send, 9, at8, last);
    expect(sent).toHaveLength(1); // wrong hour
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/summary.test.ts` — Expected: FAIL, unresolved module.

- [ ] **Step 3: Implement src/summary.ts**

```typescript
import type { Db } from './db/index';

export async function maybeSendSummary(
  db: Db,
  send: (text: string) => Promise<boolean>,
  hourLocal: number,
  now: Date,
  lastSentDay: number,
): Promise<number> {
  if (now.getHours() !== hourLocal || now.getDate() === lastSentDay) return lastSentDay;
  const c = db.countsSince(now.getTime() - 24 * 3_600_000);
  await send(`📊 Trenches daily: scanned ${c.seen} • watched ${c.watched} • alerted ${c.alerted}`);
  return now.getDate();
}
```

- [ ] **Step 4: Run summary test to verify pass**

Run: `npx vitest run tests/summary.test.ts` — Expected: 1 passed.

- [ ] **Step 5: Implement src/index.ts**

```typescript
import { loadConfig, loadSecrets } from './config';
import { Db } from './db/index';
import { PumpPortalStream } from './stream/pumpportal';
import { SolPrice } from './solPrice';
import { Rpc } from './rpc';
import { Watchlist, type WatchedToken } from './pipeline/watchlist';
import { stage1Filter } from './pipeline/stage1';
import { runDeepChecks } from './pipeline/stage3';
import { scoreToken } from './pipeline/scoring';
import { fetchMeta } from './checks/metadata';
import { normalizeTwitterHandle } from './checks/socials';
import { checkUrlAlive, checkXExists } from './checks/liveness';
import { fetchDevHistory } from './checks/devHistory';
import { fetchTop10Pct } from './checks/holders';
import { Telegram, formatAlert } from './telegram';
import { maybeSendSummary } from './summary';
import { log } from './logger';
import { TOTAL_SUPPLY, type NewTokenEvent, type TradeEvent } from './types';

const DRY = process.argv.includes('--dry');

const cfg = loadConfig();
const secrets = loadSecrets();
const db = new Db('data/scanner.db');
const rpc = new Rpc(secrets.quicknodeRpcUrl);
const telegram = new Telegram(secrets.telegramBotToken, secrets.telegramChatId);
const solPrice = new SolPrice(cfg.solPriceFallbackUsd);
const stream = new PumpPortalStream();

async function send(text: string): Promise<boolean> {
  if (DRY) {
    log('info', `[DRY ALERT]\n${text}`);
    return true;
  }
  return telegram.send(text);
}

const watchlist = new Watchlist(cfg.watch, {
  subscribe: (m) => stream.subscribeTrades(m),
  unsubscribe: (m) => stream.unsubscribeTrades(m),
  onExpire: (t) => db.setOutcome(t.event.mint, 'expired'),
  onDisqualify: (t, reason) => {
    db.setOutcome(t.event.mint, 'disqualified');
    if (reason === 'dev sold') db.bumpDev(t.event.creator, 'rugged', Date.now());
    log('info', `disqualified $${t.event.symbol} (${t.event.mint}): ${reason}`);
  },
  onTrigger: (t) => void handleTrigger(t),
});

async function handleNew(event: NewTokenEvent): Promise<void> {
  try {
    const meta = await fetchMeta(event.uri);
    const handle = meta !== 'unknown' && meta.twitter ? normalizeTwitterHandle(meta.twitter) : null;

    const result = stage1Filter({
      event,
      meta,
      handleSeenBefore: handle ? db.handleSeen(handle) : false,
      creatorLaunches48h: db.countCreatorLaunches(event.creator, Date.now() - 48 * 3_600_000, event.mint),
      symbolClone24h: db.symbolSeenSince(event.symbol, Date.now() - cfg.stage1.tickerCloneWindowHours * 3_600_000, event.mint),
    }, cfg.stage1);

    const m = meta === 'unknown' ? {} : meta;
    db.recordToken({
      mint: event.mint, symbol: event.symbol, name: event.name, creator: event.creator,
      twitter: m.twitter, telegram: m.telegram, website: m.website,
      createdAt: event.receivedAt, stage1Pass: result.pass, stage1Reason: result.reason,
    });
    db.bumpDev(event.creator, 'launches', event.receivedAt);
    if (handle) db.recordHandle(handle, event.mint, event.receivedAt);

    if (result.pass && meta !== 'unknown') {
      watchlist.add(event, meta, Date.now());
      db.setOutcome(event.mint, 'watching');
    }
  } catch (err) {
    log('error', `handleNew ${event.mint}: ${(err as Error).message}`);
  }
}

async function handleTrigger(t: WatchedToken): Promise<void> {
  try {
    if (db.alertExists(t.event.mint)) return;
    db.setOutcome(t.event.mint, 'triggered');
    log('info', `triggered $${t.event.symbol} (${t.event.mint}) — running deep checks`);

    const results = await runDeepChecks(t, {
      fetchDevHistory: (creator, mint) => fetchDevHistory(
        rpc, creator, mint,
        db.countCreatorLaunches(creator, 0, mint),
        db.getDevStats(creator)?.graduated ?? 0,
      ),
      isRugLinked: (wallet) => (db.getDevStats(wallet)?.rugged ?? 0) > 0,
      fetchTop10Pct: (mint, curve) => fetchTop10Pct(rpc, mint, curve),
      checkUrlAlive,
      checkXExists,
    });

    const { score, hardRejects, flags } = scoreToken(results, cfg.deep);
    if (hardRejects.length || score < cfg.alertScoreThreshold) {
      db.setOutcome(t.event.mint, 'rejected_deep');
      log('info', `rejected $${t.event.symbol}: score ${score}${hardRejects.length ? `, hard: ${hardRejects.join('; ')}` : ''}`);
      return;
    }

    const text = formatAlert({
      mint: t.event.mint, name: t.event.name, symbol: t.event.symbol, score, flags,
      marketCapUsd: t.lastMarketCapSol * solPrice.usd,
      ageMinutes: Math.round((Date.now() - t.addedAt) / 60_000),
      uniqueBuyers: t.buyers.size,
      devBuyPct: (t.event.devBuyTokens / TOTAL_SUPPLY) * 100,
      devStillHolds: !t.devSold,
      priorLaunches: results.devHistory === 'unknown' ? 'unknown' : results.devHistory.priorLaunches,
      top10Pct: results.top10Pct,
      twitter: t.meta.twitter, telegram: t.meta.telegram, website: t.meta.website,
    });

    if (await send(text)) {
      db.recordAlert(t.event.mint, score, DRY, text, Date.now());
      db.setOutcome(t.event.mint, 'alerted');
      log('info', `ALERT sent: $${t.event.symbol} score ${score}`);
    } else {
      log('error', `telegram send failed for ${t.event.mint}; payload:\n${text}`);
    }
  } catch (err) {
    log('error', `handleTrigger ${t.event.mint}: ${(err as Error).message}`);
  }
}

solPrice.start();
stream.on('new', (e: NewTokenEvent) => void handleNew(e));
stream.on('trade', (tr: TradeEvent) => watchlist.onTrade(tr, solPrice.usd, Date.now()));
stream.on('status', (s: string) => log('info', `stream: ${s}`));
stream.connect();

setInterval(() => watchlist.sweep(Date.now()), 60_000);

let lastSummaryDay = -1;
setInterval(() => {
  void maybeSendSummary(db, send, cfg.summaryHourLocal, new Date(), lastSummaryDay)
    .then((d) => { lastSummaryDay = d; });
}, 60_000);

process.on('SIGINT', () => {
  log('info', 'shutting down');
  stream.close();
  db.close();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  log('error', `uncaught: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log('error', `unhandled rejection: ${String(reason)}`);
});

log('info', `Trenches Scanner started${DRY ? ' (DRY RUN — alerts print to console)' : ''} — watching pump.fun`);
```

- [ ] **Step 6: Full test suite + typecheck**

Run: `npm test` — Expected: all tests pass (config, db, parse, solPrice, metadata, socials, stage1, watchlist, rpc, holders, liveness, scoring, telegram, stage3, summary).
Run: `npm run typecheck` — Expected: no errors.

- [ ] **Step 7: Live dry-run smoke test (needs a real .env)**

Create `.env` from `.env.example` with the real QuickNode URL (Telegram values can be dummies for dry run). Then:

Run: `npm run dry` in a background terminal for ~3 minutes.
Expected observations (all in console/`logs/scanner.log`):
- `stream: connected`
- A steady flow of tokens being recorded (verify: `SELECT COUNT(*) FROM tokens` grows — or add a temporary log line)
- At least some `disqualified`/`watching` log lines
- No uncaught exceptions

Note: a `[DRY ALERT]` may take a while to appear (only tokens that reach $15k MC with 25+ buyers trigger deep checks) — its absence within 3 minutes is NOT a failure. If the stream connects and tokens flow through stage 1, the smoke test passes.

- [ ] **Step 8: Commit**

```powershell
git add -A; git commit -m "feat: main wiring, dry-run mode, daily summary"
```

---

### Task 14: README setup guide + push

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the finished app
- Produces: user-facing documentation

- [ ] **Step 1: Write README.md**

Must contain, in this order (write real prose, not placeholders):
1. **What it is** — one paragraph: watches every new Pump.fun launch, three-stage filter (socials + dev wallet + traction), sends scored CA alerts to your Telegram. Alert-only, no trading.
2. **Requirements** — Node.js ≥ 20 (link nodejs.org), a QuickNode Solana mainnet endpoint, a Telegram account.
3. **Setup** — step by step:
   - `npm install`
   - Create the Telegram bot: message @BotFather → `/newbot` → copy the token.
   - Get your chat ID: message your new bot once, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `message.chat.id`.
   - `copy .env.example .env` and fill in the three values.
4. **Running** — `npm run dry` first (alerts print to the console; tune `config.json`), then `npm start` for live Telegram alerts. Keep the terminal open; Ctrl+C stops it.
5. **Tuning** — a table of the `config.json` fields users most likely tweak: `triggerMarketCapUsd`, `triggerUniqueBuyers`, `alertScoreThreshold`, `watch.windowMinutes`, `stage1.maxDevBuyPct`, with one-line effects ("lower = earlier but noisier alerts").
6. **How scoring works** — brief: base 50, bonuses/penalties list, hard rejects list, alert at ≥ 60.
7. **Disclaimer** — memecoin trading is extremely high risk; this tool filters obvious rugs but cannot guarantee anything; alerts are not financial advice.

- [ ] **Step 2: Commit and push**

```powershell
git add -A; git commit -m "docs: README with setup and tuning guide"; git push origin main
```

- [ ] **Step 3: Verify the push**

Run: `git status` — Expected: clean, `Your branch is up to date with 'origin/main'`.

---

## Plan Self-Review (completed)

- **Spec coverage:** every spec section maps to a task — Stage 1 filters (Task 6), traction watch + bundle + dev-sell (Task 7), deep checks (Tasks 8, 9, 12), scoring (Task 10), Telegram format + dedupe (Task 11 + `alerts` table in Task 2), daily summary + dry-run + error handling (Task 13), README (Task 14). Bundle detection uses arrival-time-since-mint as the slot proxy because PumpPortal payloads carry no slot — noted in Task 7.
- **Placeholder scan:** no TBDs; every code step contains complete code; README step lists required content explicitly.
- **Type consistency:** `Db` method names, `WatchedToken` fields, `CheckResults` keys, and `AlertData` keys verified consistent between producing and consuming tasks.
