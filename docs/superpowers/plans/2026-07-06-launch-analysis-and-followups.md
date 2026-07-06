# Launch Analysis + Alert Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three insider-supply / performance signals to the Trenches Scanner — exact bundle %, first-20 buyer share, and dev-outflow (airdrop) % via QuickNode, plus a post-alert performance follow-up message — without weakening the existing filter.

**Architecture:** A pure transaction parser (`launchParse.ts`) feeds an RPC orchestrator (`launchAnalysis.ts`) that runs as a new Stage-3 deep check; its outputs extend `CheckResults`, flow into `scoreToken` (new hard rejects + penalties) and the alert display. A separate in-memory `FollowUps` manager re-tracks alerted tokens and sends one performance follow-up. All new RPC work runs only on deep-check tokens (~5/day) and degrades to `'unknown'` on any failure — `'unknown'` here never suppresses an alert.

**Tech Stack:** Node ≥ 20, TypeScript via tsx, vitest. No new dependencies. Reuses `Rpc`, `PumpPortalStream`, `Telegram`, SQLite, `config.json`.

**Spec:** `docs/superpowers/specs/2026-07-06-launch-analysis-and-followups-design.md` — authoritative.

## Global Constraints

- ESM, `moduleResolution: "Bundler"`, imports WITHOUT file extensions.
- No new runtime deps. Tests never hit the network: RPC via a stub `Rpc`; pure parsers via fixture JSON.
- `TOTAL_SUPPLY = 1_000_000_000` (from `src/types`). All percentages are `tokens / TOTAL_SUPPLY * 100`.
- Check results that cannot be determined are the literal string `'unknown'` — never treated as pass or fail.
- The Stage-3 partial-data alert gate keys ONLY on `devHistory`/`top10Pct` being `'unknown'`. Launch-analysis `'unknown'` must NOT be added to that gate.
- All thresholds come from `config.json` (`launch` + `followUp` sections). Windows: chain shell with `;` not `&&`.
- Run a single test file with `npx vitest run <file>`; full suite `npm test`; types `npm run typecheck`.
- Commit after each task with the message in its final step.

---

### Task 1: Config — `launch` + `followUp` sections

**Files:**
- Modify: `config.json`, `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `LaunchConfig`, `FollowUpConfig` interfaces; `AppConfig.launch: LaunchConfig`, `AppConfig.followUp: FollowUpConfig`.

- [ ] **Step 1: Add the two sections to `config.json`** (after the existing `deep` block, before `alertScoreThreshold`):

```json
  "launch": {
    "bundleHardRejectPct": 50,
    "bundlePenaltyPct": 20,
    "bundlePenalty": 15,
    "devOutflowHardRejectPct": 30,
    "devOutflowPenaltyPct": 10,
    "devOutflowPenalty": 15,
    "first20FlagPct": 60,
    "maxEarlyTxFetch": 60
  },
  "followUp": {
    "windowMinutes": 60,
    "dumpAlertPct": 50
  },
```

- [ ] **Step 2: Write failing config test** — add to `tests/config.test.ts` inside the `loadConfig` describe:

```typescript
  it('loads the launch and followUp sections', () => {
    const cfg = loadConfig();
    expect(cfg.launch.bundleHardRejectPct).toBe(50);
    expect(cfg.launch.devOutflowHardRejectPct).toBe(30);
    expect(cfg.launch.maxEarlyTxFetch).toBe(60);
    expect(cfg.followUp.windowMinutes).toBe(60);
    expect(cfg.followUp.dumpAlertPct).toBe(50);
  });
```

- [ ] **Step 3: Run it — expect FAIL** (`cfg.launch` undefined). `npx vitest run tests/config.test.ts`

- [ ] **Step 4: Implement in `src/config.ts`** — add interfaces after `DeepConfig`:

```typescript
export interface LaunchConfig {
  bundleHardRejectPct: number;
  bundlePenaltyPct: number;
  bundlePenalty: number;
  devOutflowHardRejectPct: number;
  devOutflowPenaltyPct: number;
  devOutflowPenalty: number;
  first20FlagPct: number;
  maxEarlyTxFetch: number;
}

export interface FollowUpConfig {
  windowMinutes: number;
  dumpAlertPct: number;
}
```

Add to `AppConfig` (after `deep: DeepConfig;`):

```typescript
  launch: LaunchConfig;
  followUp: FollowUpConfig;
```

Add these entries to the `required` numeric-validation array in `loadConfig`:

```typescript
    ['launch.bundleHardRejectPct', cfg.launch?.bundleHardRejectPct],
    ['launch.bundlePenaltyPct', cfg.launch?.bundlePenaltyPct],
    ['launch.bundlePenalty', cfg.launch?.bundlePenalty],
    ['launch.devOutflowHardRejectPct', cfg.launch?.devOutflowHardRejectPct],
    ['launch.devOutflowPenaltyPct', cfg.launch?.devOutflowPenaltyPct],
    ['launch.devOutflowPenalty', cfg.launch?.devOutflowPenalty],
    ['launch.first20FlagPct', cfg.launch?.first20FlagPct],
    ['launch.maxEarlyTxFetch', cfg.launch?.maxEarlyTxFetch],
    ['followUp.windowMinutes', cfg.followUp?.windowMinutes],
    ['followUp.dumpAlertPct', cfg.followUp?.dumpAlertPct],
```

- [ ] **Step 5: Run test + typecheck — expect PASS.** `npx vitest run tests/config.test.ts` then `npm run typecheck`.

- [ ] **Step 6: Commit.** `git add -A; git commit -m "feat: config for launch analysis + follow-ups"`

---

### Task 2: Pure transaction parsers (`launchParse.ts`)

**Files:**
- Create: `src/checks/launchParse.ts`
- Test: `tests/launchParse.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `interface Buy { owner: string; amount: number }`
  - `buysFromTx(tx: unknown, mint: string, exclude: Set<string>): Buy[]` — token-balance increases for `mint`, in the tx, by owners not in `exclude`. `amount` is decimal token count (uiAmount).
  - `devTransfersFromTx(tx: unknown, mint: string, creator: string): number` — total `mint` tokens moved out of `creator` via SPL `transferChecked` (top-level + inner), summed as decimal token count.

- [ ] **Step 1: Write failing tests** — create `tests/launchParse.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buysFromTx, devTransfersFromTx } from '../src/checks/launchParse';

const MINT = 'MintX';

// A pump buy: buyer's token balance for MINT goes 0 -> 1,000,000; bonding curve (excluded) drops.
const buyTx = (owner: string, pre: number, post: number) => ({
  meta: {
    preTokenBalances: pre === 0 ? [] : [{ accountIndex: 3, mint: MINT, owner, uiTokenAmount: { uiAmount: pre } }],
    postTokenBalances: [{ accountIndex: 3, mint: MINT, owner, uiTokenAmount: { uiAmount: post } }],
  },
});

describe('buysFromTx', () => {
  it('returns positive balance deltas for the mint, excluding listed owners', () => {
    expect(buysFromTx(buyTx('buyer1', 0, 1_000_000), MINT, new Set())).toEqual([{ owner: 'buyer1', amount: 1_000_000 }]);
    expect(buysFromTx(buyTx('dev1', 0, 2_000_000), MINT, new Set(['dev1']))).toEqual([]);
  });

  it('ignores other mints, sells (negative delta), and malformed txs', () => {
    const otherMint = { meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: 'OTHER', owner: 'x', uiTokenAmount: { uiAmount: 5 } }] } };
    expect(buysFromTx(otherMint, MINT, new Set())).toEqual([]);
    expect(buysFromTx(buyTx('seller', 1_000_000, 400_000), MINT, new Set())).toEqual([]); // sold, delta negative
    expect(buysFromTx(null, MINT, new Set())).toEqual([]);
    expect(buysFromTx({}, MINT, new Set())).toEqual([]);
  });
});

describe('devTransfersFromTx', () => {
  const transferTx = (authority: string, mint: string, amount: number, inner = false) => {
    const ix = { program: 'spl-token', parsed: { type: 'transferChecked', info: { authority, mint, tokenAmount: { uiAmount: amount } } } };
    return inner
      ? { meta: { innerInstructions: [{ instructions: [ix] }] }, transaction: { message: { instructions: [] } } }
      : { meta: { innerInstructions: [] }, transaction: { message: { instructions: [ix] } } };
  };

  it('sums transferChecked of the mint authorized by the dev (top-level and inner)', () => {
    expect(devTransfersFromTx(transferTx('dev1', MINT, 62_000_000), MINT, 'dev1')).toBe(62_000_000);
    expect(devTransfersFromTx(transferTx('dev1', MINT, 5_000_000, true), MINT, 'dev1')).toBe(5_000_000);
  });

  it('ignores transfers by others, of other mints, and non-transfer instructions', () => {
    expect(devTransfersFromTx(transferTx('someoneElse', MINT, 9), MINT, 'dev1')).toBe(0);
    expect(devTransfersFromTx(transferTx('dev1', 'OTHER', 9), MINT, 'dev1')).toBe(0);
    expect(devTransfersFromTx(null, MINT, 'dev1')).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing). `npx vitest run tests/launchParse.test.ts`

- [ ] **Step 3: Implement `src/checks/launchParse.ts`:**

```typescript
export interface Buy {
  owner: string;
  amount: number;
}

interface TokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { uiAmount?: number | null };
}

function ui(b: TokenBalance): number {
  return typeof b.uiTokenAmount?.uiAmount === 'number' ? b.uiTokenAmount.uiAmount : 0;
}

export function buysFromTx(tx: unknown, mint: string, exclude: Set<string>): Buy[] {
  const meta = (tx as { meta?: { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } } | null)?.meta;
  if (!meta) return [];
  const pre = new Map<number, number>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint === mint && typeof b.accountIndex === 'number') pre.set(b.accountIndex, ui(b));
  }
  const buys: Buy[] = [];
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mint || typeof b.accountIndex !== 'number' || !b.owner) continue;
    const delta = ui(b) - (pre.get(b.accountIndex) ?? 0);
    if (delta > 0 && !exclude.has(b.owner)) buys.push({ owner: b.owner, amount: delta });
  }
  return buys;
}

interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: { authority?: string; mint?: string; tokenAmount?: { uiAmount?: number | null } } };
}

export function devTransfersFromTx(tx: unknown, mint: string, creator: string): number {
  const t = tx as {
    transaction?: { message?: { instructions?: ParsedIx[] } };
    meta?: { innerInstructions?: Array<{ instructions?: ParsedIx[] }> };
  } | null;
  if (!t) return 0;
  const top = t.transaction?.message?.instructions ?? [];
  const inner = (t.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? []);
  let sum = 0;
  for (const ix of [...top, ...inner]) {
    if (ix.program !== 'spl-token' || ix.parsed?.type !== 'transferChecked') continue;
    const info = ix.parsed.info;
    if (info?.mint === mint && info.authority === creator && typeof info.tokenAmount?.uiAmount === 'number') {
      sum += info.tokenAmount.uiAmount;
    }
  }
  return sum;
}
```

- [ ] **Step 4: Run tests + typecheck — expect PASS.** `npx vitest run tests/launchParse.test.ts` then `npm run typecheck`.

- [ ] **Step 5: Commit.** `git add -A; git commit -m "feat: pure pump.fun tx parsers for launch analysis"`

---

### Task 3: RPC orchestrator (`launchAnalysis.ts`)

**Files:**
- Create: `src/checks/launchAnalysis.ts`
- Test: `tests/launchAnalysis.test.ts`

**Interfaces:**
- Consumes: `Rpc` (`src/rpc`), `buysFromTx`/`devTransfersFromTx` (`launchParse`), `TOTAL_SUPPLY` (`src/types`).
- Produces:
  - `interface LaunchAnalysis { bundlePct: number; first20Pct: number; devOutflowPct: number }`
  - `analyzeLaunch(rpc: Rpc, mint: string, bondingCurveKey: string, creator: string, creationSignature: string, maxEarlyTxFetch?: number): Promise<LaunchAnalysis | 'unknown'>`
- Behavior: creation slot from `getTransaction(creationSignature)`; `getSignaturesForAddress(bondingCurveKey, {limit:1000})` reversed to chronological; if the oldest captured slot is newer than the creation slot → `'unknown'` (we missed the launch). Fetch ≤ `maxEarlyTxFetch` earliest txs (batches of 5, per-call `.catch → null`); `bundlePct` = non-dev buys in the creation slot; `first20Pct` = all buys by the first 20 distinct non-dev buyers; `devOutflowPct` from a second `getSignaturesForAddress(creator,…)` + bounded tx fetch. Any throw → `'unknown'`.

- [ ] **Step 1: Write failing test** — create `tests/launchAnalysis.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { analyzeLaunch } from '../src/checks/launchAnalysis';
import type { Rpc } from '../src/rpc';

const MINT = 'MintX', CURVE = 'Curve1', DEV = 'Dev1';

// buy tx builder (balance delta) at a given accountIndex
const buy = (owner: string, amount: number) => ({
  meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 2, mint: MINT, owner, uiTokenAmount: { uiAmount: amount } }] },
});
const xfer = (amount: number) => ({
  transaction: { message: { instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked', info: { authority: DEV, mint: MINT, tokenAmount: { uiAmount: amount } } } }] } },
  meta: { innerInstructions: [] },
});

function fakeRpc(h: {
  createSlot: number;
  curveSigs: Array<{ signature: string; slot: number }>;
  txBySig: Record<string, unknown>;
  devSigs?: Array<{ signature: string; slot: number }>;
}): Rpc {
  return {
    call: async (method: string, params: unknown[]) => {
      if (method === 'getTransaction') {
        const sig = (params[0] as string);
        if (sig === 'create') return { slot: h.createSlot };
        return h.txBySig[sig] ?? null;
      }
      if (method === 'getSignaturesForAddress') {
        const addr = params[0] as string;
        // newest-first
        if (addr === CURVE) return [...h.curveSigs].reverse();
        if (addr === DEV) return [...(h.devSigs ?? [])].reverse();
      }
      throw new Error('unexpected ' + method);
    },
  } as unknown as Rpc;
}

describe('analyzeLaunch', () => {
  it('computes bundle (creation-slot buys), first-20, and dev-outflow percentages', async () => {
    const rpc = fakeRpc({
      createSlot: 100,
      // chronological: create(100), b1(100 same slot = bundle), b2(101), devxfer sig lives on dev list
      curveSigs: [
        { signature: 'create', slot: 100 },
        { signature: 'b1', slot: 100 },
        { signature: 'b2', slot: 101 },
      ],
      txBySig: {
        b1: buy('buyer1', 50_000_000),   // 5% bundle
        b2: buy('buyer2', 10_000_000),   // 1% first-20 but not bundle
        dx: xfer(62_000_000),            // 6.2% dev outflow
      },
      devSigs: [{ signature: 'dx', slot: 100 }],
    });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.bundlePct).toBeCloseTo(5, 5);       // 50M / 1B
    expect(r.first20Pct).toBeCloseTo(6, 5);      // buyer1 5% + buyer2 1%
    expect(r.devOutflowPct).toBeCloseTo(6.2, 5); // 62M / 1B
  });

  it("returns 'unknown' when the earliest captured slot is newer than creation (launch missed)", async () => {
    const rpc = fakeRpc({ createSlot: 100, curveSigs: [{ signature: 'x', slot: 200 }], txBySig: {} });
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60)).toBe('unknown');
  });

  it("returns 'unknown' when the creation tx has no slot", async () => {
    const rpc = { call: async (m: string) => (m === 'getTransaction' ? null : []) } as unknown as Rpc;
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60)).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run tests/launchAnalysis.test.ts`

- [ ] **Step 3: Implement `src/checks/launchAnalysis.ts`:**

```typescript
import type { Rpc } from '../rpc';
import { TOTAL_SUPPLY } from '../types';
import { buysFromTx, devTransfersFromTx } from './launchParse';

export interface LaunchAnalysis {
  bundlePct: number;
  first20Pct: number;
  devOutflowPct: number;
}

interface SigInfo { signature: string; slot: number }

async function fetchTxs(rpc: Rpc, sigs: SigInfo[]): Promise<Array<{ slot: number; tx: unknown }>> {
  const out: Array<{ slot: number; tx: unknown }> = [];
  for (let i = 0; i < sigs.length; i += 5) {
    const batch = sigs.slice(i, i + 5);
    const txs = await Promise.all(batch.map((s) =>
      rpc.call<unknown>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }])
        .catch(() => null)));
    batch.forEach((s, j) => out.push({ slot: s.slot, tx: txs[j] }));
  }
  return out;
}

export async function analyzeLaunch(
  rpc: Rpc,
  mint: string,
  bondingCurveKey: string,
  creator: string,
  creationSignature: string,
  maxEarlyTxFetch = 60,
): Promise<LaunchAnalysis | 'unknown'> {
  try {
    const createTx = await rpc.call<{ slot?: number } | null>(
      'getTransaction', [creationSignature, { maxSupportedTransactionVersion: 0 }]);
    const creationSlot = createTx?.slot;
    if (typeof creationSlot !== 'number') return 'unknown';

    const curveSigs = await rpc.call<SigInfo[]>('getSignaturesForAddress', [bondingCurveKey, { limit: 1000 }]);
    if (!curveSigs?.length) return 'unknown';
    const chron = [...curveSigs].reverse();
    if (chron[0].slot > creationSlot) return 'unknown'; // we did not capture the launch window

    const early = chron.slice(0, maxEarlyTxFetch);
    const txs = await fetchTxs(rpc, early);

    const exclude = new Set([creator]);
    const firstOwners: string[] = [];
    const boughtByOwner = new Map<string, number>();
    let bundleTokens = 0;

    for (const { slot, tx } of txs) {
      for (const b of buysFromTx(tx, mint, exclude)) {
        if (slot === creationSlot) bundleTokens += b.amount;
        if (!boughtByOwner.has(b.owner) && firstOwners.length < 20) firstOwners.push(b.owner);
        boughtByOwner.set(b.owner, (boughtByOwner.get(b.owner) ?? 0) + b.amount);
      }
    }
    const first20Tokens = firstOwners.reduce((sum, o) => sum + (boughtByOwner.get(o) ?? 0), 0);

    let devOutTokens = 0;
    const devSigs = await rpc.call<SigInfo[]>('getSignaturesForAddress', [creator, { limit: 1000 }]).catch(() => [] as SigInfo[]);
    if (devSigs?.length) {
      const devEarly = [...devSigs].reverse().slice(0, maxEarlyTxFetch);
      const devTxs = await fetchTxs(rpc, devEarly);
      for (const { tx } of devTxs) devOutTokens += devTransfersFromTx(tx, mint, creator);
    }

    const pct = (n: number) => (n / TOTAL_SUPPLY) * 100;
    return { bundlePct: pct(bundleTokens), first20Pct: pct(first20Tokens), devOutflowPct: pct(devOutTokens) };
  } catch {
    return 'unknown';
  }
}
```

- [ ] **Step 4: Run tests + typecheck — expect PASS.** `npx vitest run tests/launchAnalysis.test.ts` then `npm run typecheck`.

- [ ] **Step 5: Commit.** `git add -A; git commit -m "feat: launchAnalysis rpc orchestrator (bundle, first-20, dev-outflow)"`

---

### Task 4: Scoring extension

**Files:**
- Modify: `src/pipeline/scoring.ts`
- Test: `tests/scoring.test.ts`

**Interfaces:**
- Consumes: `LaunchConfig` (`src/config`).
- Produces: `CheckResults` gains `bundlePct`, `first20Pct`, `devOutflowPct` (all `Unknown<number>`). `scoreToken` signature becomes `scoreToken(r: CheckResults, cfg: DeepConfig, launch: LaunchConfig): ScoreResult`.

- [ ] **Step 1: Update the shared `clean()` helper and add tests** in `tests/scoring.test.ts`. First, the existing tests build `CheckResults` via a `clean()` helper and call `scoreToken(r, CFG)`. Update the helper to include the new fields and pass a launch config. At the top, add:

```typescript
const LAUNCH = {
  bundleHardRejectPct: 50, bundlePenaltyPct: 20, bundlePenalty: 15,
  devOutflowHardRejectPct: 30, devOutflowPenaltyPct: 10, devOutflowPenalty: 15,
  first20FlagPct: 60, maxEarlyTxFetch: 60,
};
```

In the `clean()` helper add these three fields to the returned object: `bundlePct: 5, first20Pct: 20, devOutflowPct: 0,`. Replace every `scoreToken(clean(...), CFG)` call with `scoreToken(clean(...), CFG, LAUNCH)`. (The existing baseline expectation changes: a clean token was 80; with `bundlePct 5`, `devOutflowPct 0` no penalty, still 80 — verify the "clean token" test still expects 80.)

Then add new tests:

```typescript
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
```

- [ ] **Step 2: Run — expect FAIL** (arity/type + missing logic). `npx vitest run tests/scoring.test.ts`

- [ ] **Step 3: Implement in `src/pipeline/scoring.ts`.** Add imports and fields, extend signature and logic. Change the import line to also import the type:

```typescript
import type { DeepConfig, LaunchConfig } from '../config';
```

Add to `CheckResults` (after `devStillHolds: boolean;`):

```typescript
  bundlePct: Unknown<number>;
  first20Pct: Unknown<number>;
  devOutflowPct: Unknown<number>;
```

Change the signature to `export function scoreToken(r: CheckResults, cfg: DeepConfig, launch: LaunchConfig): ScoreResult {` and, immediately before the final `return`, insert:

```typescript
  if (r.bundlePct !== 'unknown') {
    if (r.bundlePct > launch.bundleHardRejectPct) hardRejects.push(`bundle ${r.bundlePct.toFixed(0)}%`);
    else if (r.bundlePct >= launch.bundlePenaltyPct) {
      score -= launch.bundlePenalty;
      flags.push(`bundle ${r.bundlePct.toFixed(0)}%`);
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
```

- [ ] **Step 4: Run tests + typecheck — expect PASS.** `npx vitest run tests/scoring.test.ts` then `npm run typecheck` (typecheck will fail at `stage3.ts`/`index.ts` call sites — that's expected and fixed in Tasks 5 & 7; if running typecheck now, note the only errors are those two call sites).

- [ ] **Step 5: Commit.** `git add -A; git commit -m "feat: score bundle, dev-outflow, first-20 signals"`

---

### Task 5: Stage-3 wiring

**Files:**
- Modify: `src/pipeline/stage3.ts`
- Test: `tests/stage3.test.ts`

**Interfaces:**
- Consumes: `LaunchAnalysis` (`src/checks/launchAnalysis`).
- Produces: `DeepCheckDeps` gains `analyzeLaunch(mint, bondingCurveKey, creator, creationSignature): Promise<LaunchAnalysis | 'unknown'>`. `runDeepChecks` populates the three new `CheckResults` fields.

- [ ] **Step 1: Add tests** in `tests/stage3.test.ts`. Extend the `deps()` helper with `analyzeLaunch: async () => ({ bundlePct: 8, first20Pct: 31, devOutflowPct: 0 }),`. In the first "assembles results" test, add to the expected object: `bundlePct: 8, first20Pct: 31, devOutflowPct: 0,`. Add a new test:

```typescript
  it("propagates launch-analysis 'unknown' without failing the others", async () => {
    const r = await runDeepChecks(watched({ twitter: 'https://x.com/d' }), deps({ analyzeLaunch: async () => 'unknown' }));
    expect(r.bundlePct).toBe('unknown');
    expect(r.first20Pct).toBe('unknown');
    expect(r.devOutflowPct).toBe('unknown');
    expect(r.top10Pct).toBe(22); // other checks unaffected
  });
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run tests/stage3.test.ts`

- [ ] **Step 3: Implement in `src/pipeline/stage3.ts`.** Add import:

```typescript
import type { LaunchAnalysis } from '../checks/launchAnalysis';
```

Add to `DeepCheckDeps`:

```typescript
  analyzeLaunch(mint: string, bondingCurveKey: string, creator: string, creationSignature: string): Promise<LaunchAnalysis | 'unknown'>;
```

In `runDeepChecks`, add `launch` to the `Promise.all` (append as the last element):

```typescript
  const [devHistory, top10Pct, twitterAlive, telegramAlive, websiteAlive, xExists, launch] = await Promise.all([
    deps.fetchDevHistory(t.event.creator, t.event.mint),
    deps.fetchTop10Pct(t.event.mint, t.event.bondingCurveKey),
    t.meta.twitter ? deps.checkUrlAlive(normalizeUrl(t.meta.twitter)) : UNKNOWN,
    t.meta.telegram ? deps.checkUrlAlive(normalizeUrl(t.meta.telegram)) : UNKNOWN,
    t.meta.website ? deps.checkUrlAlive(normalizeUrl(t.meta.website)) : UNKNOWN,
    handle ? deps.checkXExists(handle) : UNKNOWN,
    deps.analyzeLaunch(t.event.mint, t.event.bondingCurveKey, t.event.creator, t.event.signature),
  ]);
```

Add to the returned object (after `devStillHolds: !t.devSold,`):

```typescript
    bundlePct: launch === 'unknown' ? 'unknown' : launch.bundlePct,
    first20Pct: launch === 'unknown' ? 'unknown' : launch.first20Pct,
    devOutflowPct: launch === 'unknown' ? 'unknown' : launch.devOutflowPct,
```

- [ ] **Step 4: Run tests + typecheck — expect PASS** (`scoring` + `stage3` green; `index.ts` still to be wired in Task 7). `npx vitest run tests/stage3.test.ts`

- [ ] **Step 5: Commit.** `git add -A; git commit -m "feat: run launch analysis in stage 3 deep checks"`

---

### Task 6: Telegram — alert line + follow-up formatter

**Files:**
- Modify: `src/telegram.ts`
- Test: `tests/telegram.test.ts`

**Interfaces:**
- Produces:
  - `AlertData` gains `bundlePct: number | 'unknown'`, `first20Pct: number | 'unknown'`, `devOutflowPct: number | 'unknown'`.
  - `formatAlert` replaces the hardcoded `bundle: clean` with a real launch line.
  - `interface FollowUpData { symbol: string; reason: 'window' | 'dump'; peakUsd: number; nowUsd: number; peakPct: number; nowPct: number }`
  - `formatFollowUp(d: FollowUpData): string`

- [ ] **Step 1: Add tests** in `tests/telegram.test.ts`. Extend the `DATA` object with `bundlePct: 8, first20Pct: 31, devOutflowPct: 0,`. In the "renders the full alert" test, replace the `bundle: clean` assertion with:

```typescript
    expect(text).toContain('Launch: bundle 8% • first-20 31% • dev-out 0%');
```

Add:

```typescript
import { formatFollowUp } from '../src/telegram';

describe('formatFollowUp', () => {
  it('renders a window follow-up with peak and current performance', () => {
    const s = formatFollowUp({ symbol: 'COOL', reason: 'window', peakUsd: 22000, nowUsd: 9000, peakPct: 47, nowPct: -40 });
    expect(s).toContain('$COOL');
    expect(s).toContain('peaked $22.0k (+47%)');
    expect(s).toContain('now $9.0k (-40%)');
    expect(s).not.toContain('⚠️');
  });

  it('leads dump follow-ups with a warning', () => {
    expect(formatFollowUp({ symbol: 'RUG', reason: 'dump', peakUsd: 30000, nowUsd: 6000, peakPct: 100, nowPct: -80 })).toContain('⚠️');
  });
});
```

Also add a test that unknown launch values render as `?`:

```typescript
  it('renders unknown launch values as ?', () => {
    const text = formatAlert({ ...DATA, bundlePct: 'unknown', first20Pct: 'unknown', devOutflowPct: 'unknown' });
    expect(text).toContain('Launch: bundle ? • first-20 ? • dev-out ?');
  });
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run tests/telegram.test.ts`

- [ ] **Step 3: Implement in `src/telegram.ts`.** Add the three fields to `AlertData` (after `top10Pct`):

```typescript
  bundlePct: number | 'unknown';
  first20Pct: number | 'unknown';
  devOutflowPct: number | 'unknown';
```

In `formatAlert`, add a percent helper and a launch line. After the `top10` const add:

```typescript
  const pctOrQ = (v: number | 'unknown') => (v === 'unknown' ? '?' : `${v.toFixed(0)}%`);
```

Replace the `Holders:` line and split into two lines — change:

```typescript
    `Holders: top10 ${top10} • bundle: clean`,
```

to:

```typescript
    `Holders: top10 ${top10}`,
    `Launch: bundle ${pctOrQ(d.bundlePct)} • first-20 ${pctOrQ(d.first20Pct)} • dev-out ${pctOrQ(d.devOutflowPct)}`,
```

Append the follow-up types + formatter at the end of the file (after the `Telegram` class):

```typescript
export interface FollowUpData {
  symbol: string;
  reason: 'window' | 'dump';
  peakUsd: number;
  nowUsd: number;
  peakPct: number;
  nowPct: number;
}

export function formatFollowUp(d: FollowUpData): string {
  const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
  const sign = (n: number) => (n >= 0 ? `+${n.toFixed(0)}` : n.toFixed(0));
  const head = d.reason === 'dump' ? '⚠️ ' : '📈 ';
  return `${head}<b>$${escapeHtml(d.symbol)}</b> follow-up — peaked ${k(d.peakUsd)} (${sign(d.peakPct)}%), now ${k(d.nowUsd)} (${sign(d.nowPct)}% since alert)`;
}
```

- [ ] **Step 4: Run tests + typecheck — expect PASS** (`index.ts` call to `formatAlert` still missing the new fields → typecheck error there, fixed in Task 7). Run `npx vitest run tests/telegram.test.ts`.

- [ ] **Step 5: Commit.** `git add -A; git commit -m "feat: launch line in alerts + follow-up message formatter"`

---

### Task 7: Follow-ups manager (`followups.ts`)

**Files:**
- Create: `src/pipeline/followups.ts`
- Test: `tests/followups.test.ts`

**Interfaces:**
- Consumes: `TradeEvent` (`src/types`), `FollowUpConfig` (`src/config`).
- Produces:
  - `interface FollowUp { mint: string; symbol: string; alertMcSol: number; peakMcSol: number; lastMcSol: number; alertedAt: number }`
  - `interface FollowUpHooks { subscribe(mint: string): void; unsubscribe(mint: string): void; fire(fu: FollowUp, reason: 'window' | 'dump'): void }`
  - `class FollowUps { constructor(cfg: FollowUpConfig, hooks: FollowUpHooks); add(mint, symbol, alertMcSol, now): void; onTrade(trade: TradeEvent, now: number): void; sweep(now: number): void; has(mint): boolean; get size(): number }`
- Behavior: `add` subscribes and starts tracking. `onTrade` updates `peakMcSol`/`lastMcSol`; if `(peak-last)/peak*100 > dumpAlertPct` → `fire(fu,'dump')`, remove, unsubscribe. `sweep` fires `'window'` for tokens older than `windowMinutes`, removes, unsubscribes. Exactly one fire + one unsubscribe per token.

- [ ] **Step 1: Write failing test** — create `tests/followups.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { FollowUps, type FollowUp } from '../src/pipeline/followups';
import type { TradeEvent } from '../src/types';

const CFG = { windowMinutes: 60, dumpAlertPct: 50 };
const trade = (mint: string, marketCapSol: number): TradeEvent =>
  ({ mint, trader: 't', isBuy: true, tokenAmount: 1, solAmount: 1, marketCapSol, signature: 's', receivedAt: 0 });

describe('FollowUps', () => {
  let fired: Array<[FollowUp, string]>; let subs: string[]; let unsubs: string[]; let fu: FollowUps;
  beforeEach(() => {
    fired = []; subs = []; unsubs = [];
    fu = new FollowUps(CFG, { subscribe: (m) => subs.push(m), unsubscribe: (m) => unsubs.push(m), fire: (f, r) => fired.push([f, r]) });
  });

  it('subscribes on add and tracks peak/last', () => {
    fu.add('m1', 'COOL', 100, 0);
    expect(subs).toEqual(['m1']);
    fu.onTrade(trade('m1', 150), 1000);
    fu.onTrade(trade('m1', 120), 2000);
    expect(fired).toHaveLength(0);
    expect(fu.has('m1')).toBe(true);
  });

  it('fires a dump follow-up when it falls >50% off peak, once', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 200), 1000); // peak 200
    fu.onTrade(trade('m1', 90), 2000);  // -55% off peak
    expect(fired).toHaveLength(1);
    expect(fired[0][1]).toBe('dump');
    expect(unsubs).toEqual(['m1']);
    fu.onTrade(trade('m1', 80), 3000);  // already gone — no second fire
    expect(fired).toHaveLength(1);
  });

  it('fires a window follow-up after the window elapses', () => {
    fu.add('m1', 'COOL', 100, 0);
    fu.onTrade(trade('m1', 130), 1000);
    fu.sweep(60 * 60_000 + 1);
    expect(fired).toHaveLength(1);
    expect(fired[0][1]).toBe('window');
    expect(fired[0][0].peakMcSol).toBe(130);
    expect(unsubs).toEqual(['m1']);
    expect(fu.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run tests/followups.test.ts`

- [ ] **Step 3: Implement `src/pipeline/followups.ts`:**

```typescript
import type { TradeEvent } from '../types';
import type { FollowUpConfig } from '../config';

export interface FollowUp {
  mint: string;
  symbol: string;
  alertMcSol: number;
  peakMcSol: number;
  lastMcSol: number;
  alertedAt: number;
}

export interface FollowUpHooks {
  subscribe(mint: string): void;
  unsubscribe(mint: string): void;
  fire(fu: FollowUp, reason: 'window' | 'dump'): void;
}

export class FollowUps {
  private items = new Map<string, FollowUp>();

  constructor(private cfg: FollowUpConfig, private hooks: FollowUpHooks) {}

  get size(): number { return this.items.size; }
  has(mint: string): boolean { return this.items.has(mint); }

  add(mint: string, symbol: string, alertMcSol: number, now: number): void {
    if (this.items.has(mint)) return;
    this.items.set(mint, { mint, symbol, alertMcSol, peakMcSol: alertMcSol, lastMcSol: alertMcSol, alertedAt: now });
    this.hooks.subscribe(mint);
  }

  onTrade(trade: TradeEvent, _now: number): void {
    const fu = this.items.get(trade.mint);
    if (!fu) return;
    fu.lastMcSol = trade.marketCapSol;
    if (trade.marketCapSol > fu.peakMcSol) fu.peakMcSol = trade.marketCapSol;
    const drawdown = fu.peakMcSol > 0 ? ((fu.peakMcSol - fu.lastMcSol) / fu.peakMcSol) * 100 : 0;
    if (drawdown > this.cfg.dumpAlertPct) {
      this.remove(fu.mint);
      this.hooks.fire(fu, 'dump');
    }
  }

  sweep(now: number): void {
    const cutoff = now - this.cfg.windowMinutes * 60_000;
    for (const fu of [...this.items.values()]) {
      if (fu.alertedAt < cutoff) {
        this.remove(fu.mint);
        this.hooks.fire(fu, 'window');
      }
    }
  }

  private remove(mint: string): void {
    this.items.delete(mint);
    this.hooks.unsubscribe(mint);
  }
}
```

- [ ] **Step 4: Run tests + typecheck — expect PASS.** `npx vitest run tests/followups.test.ts`

- [ ] **Step 5: Commit.** `git add -A; git commit -m "feat: post-alert follow-up manager"`

---

### Task 8: Main wiring (`index.ts`)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes everything from Tasks 1–7. No unit test (integration) — verified by the Task 9 dry run and by the now-green suite + typecheck.

- [ ] **Step 1: Add imports** near the other imports in `src/index.ts`:

```typescript
import { analyzeLaunch } from './checks/launchAnalysis';
import { FollowUps } from './pipeline/followups';
import { Telegram, formatAlert, formatFollowUp } from './telegram';
```

(The `Telegram, formatAlert` import already exists — extend it to include `formatFollowUp` rather than duplicating.)

- [ ] **Step 2: Instantiate `FollowUps`** after the `watchlist` is created. Insert:

```typescript
const followUps = new FollowUps(cfg.followUp, {
  subscribe: (m) => stream.subscribeTrades(m),
  unsubscribe: (m) => stream.unsubscribeTrades(m),
  fire: (fu, reason) => {
    const nowPct = fu.alertMcSol > 0 ? ((fu.lastMcSol - fu.alertMcSol) / fu.alertMcSol) * 100 : 0;
    const peakPct = fu.alertMcSol > 0 ? ((fu.peakMcSol - fu.alertMcSol) / fu.alertMcSol) * 100 : 0;
    void send(formatFollowUp({
      symbol: fu.symbol, reason,
      peakUsd: fu.peakMcSol * solPrice.usd, nowUsd: fu.lastMcSol * solPrice.usd,
      peakPct, nowPct,
    }));
    log('info', `follow-up (${reason}) $${fu.symbol}: peak ${peakPct.toFixed(0)}% now ${nowPct.toFixed(0)}%`);
  },
});
```

- [ ] **Step 3: Add `analyzeLaunch` to the deep-check deps** inside `handleTrigger` (in the `runDeepChecks(t, { … })` deps object), alongside `fetchTop10Pct`:

```typescript
      analyzeLaunch: (mint, bondingCurveKey, creator, creationSignature) =>
        analyzeLaunch(rpc, mint, bondingCurveKey, creator, creationSignature, cfg.launch.maxEarlyTxFetch),
```

- [ ] **Step 4: Pass launch config to scoring** — change `const { score, hardRejects, flags } = scoreToken(results, cfg.deep);` to:

```typescript
    const { score, hardRejects, flags } = scoreToken(results, cfg.deep, cfg.launch);
```

- [ ] **Step 5: Pass the new fields to `formatAlert`** — inside the `formatAlert({ … })` call add:

```typescript
      bundlePct: results.bundlePct,
      first20Pct: results.first20Pct,
      devOutflowPct: results.devOutflowPct,
```

- [ ] **Step 6: Start a follow-up on a successful alert** — in the `if (await send(text)) { … }` block, after `db.setOutcome(t.event.mint, 'alerted');` add:

```typescript
      followUps.add(t.event.mint, t.event.symbol, t.lastMarketCapSol, Date.now());
```

- [ ] **Step 7: Route trades and sweeps to follow-ups.** Change the trade handler line to also feed follow-ups:

```typescript
stream.on('trade', (tr: TradeEvent) => {
  watchlist.onTrade(tr, solPrice.usd, Date.now());
  followUps.onTrade(tr, Date.now());
});
```

And extend the existing sweep interval:

```typescript
setInterval(() => {
  const now = Date.now();
  watchlist.sweep(now);
  followUps.sweep(now);
}, 60_000);
```

- [ ] **Step 8: Full suite + typecheck — expect all green.** `npm test` then `npm run typecheck`.

- [ ] **Step 9: Commit.** `git add -A; git commit -m "feat: wire launch analysis + follow-ups into the scanner"`

---

### Task 9: Dry-run verification, README, push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Live dry-run smoke test.** Ensure `.env` exists (leave it untouched). Run `npm run dry` in the background for ~3 minutes. Confirm in `logs/scanner.log`: `stream: connected`, token flow, and — if any token triggers — an alert containing a `Launch: bundle … • first-20 … • dev-out …` line, with graceful `'unknown'` on transient RPC failures and no uncaught exceptions. A trigger is not guaranteed in 3 min; absence of one is not a failure. Kill the process (`taskkill /T /F` on Windows).

- [ ] **Step 2: Update `README.md`.** In the "How scoring works" section add the new hard rejects and penalties:
  - Hard rejects: add "The launch was **bundled** — more than 50% of supply bought by insiders in the creation block." and "The **dev moved more than 30%** of supply out to other wallets (hidden-supply / airdrop)."
  - Penalties: add "−15 — bundle between 20–50% of supply." and "−15 — dev moved 10–30% of supply out."
  - Add one line explaining the alert's `Launch:` line (bundle % / first-20 % / dev-out %) and that `?` means the on-chain read was inconclusive (which never blocks an alert).
  - Add a short "Follow-up messages" note: after an alert, the scanner tracks the token for `followUp.windowMinutes` (default 60) and posts one performance update, or an earlier ⚠️ dump notice if it falls more than `followUp.dumpAlertPct` (default 50%) off its peak. Note these are informational and reset on restart.
  - In the Tuning table, add rows for `launch.bundleHardRejectPct` and `followUp.windowMinutes` with plain-language effects.

- [ ] **Step 3: Commit and push.** `git add -A; git commit -m "docs: document launch analysis + follow-ups"; git push origin main`

- [ ] **Step 4: Verify push.** `git status` — expect clean, up to date with `origin/main`.

---

## Plan Self-Review (completed)

- **Spec coverage:** bundle %/first-20/dev-outflow (Tasks 2,3 compute; 4 scores; 5 wires; 6 displays), follow-ups (Task 7 + wiring Task 8), config (Task 1), "unknown never gates" preserved (index.ts gate untouched; verified in Task 8 wiring — the partial-data gate above the launch code keys only on devHistory/top10), tests (each task), dry-run + README (Task 9). All spec sections mapped.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `CheckResults` new fields (`bundlePct`/`first20Pct`/`devOutflowPct`) match across scoring (4), stage3 (5), telegram `AlertData` (6), and index wiring (8). `scoreToken(r, deep, launch)` arity is updated in both the test (4) and the call site (8). `LaunchAnalysis`, `FollowUp`, `FollowUpHooks.fire`, and `FollowUpData` names are consistent between producing and consuming tasks.
