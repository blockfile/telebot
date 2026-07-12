# Revival Watcher — Design Spec

**Date:** 2026-07-13
**Status:** Approved design, pending implementation
**Goal:** Catch "dead-then-pumping" tokens (the ANSEMIUS-class backtest misses). Tokens that passed stage 1 but expired without alerting go into a graveyard; a periodic sweep polls their bonding-curve market caps, and any token that wakes up (sharp MC jump off its floor) re-enters the normal watchlist → traction gate → deep checks → alert pipeline. No new alert type, no new filters.

## Decisions

| Decision | Choice |
|---|---|
| Candidates | `stage1_pass = 1 AND outcome = 'expired' AND bonding_curve IS NOT NULL`, created within the last **3 days** (`revival.lookbackDays`), capped at `revival.maxCandidates` (6000, newest first) |
| Sweep | Every `revival.sweepMinutes` (10) — batch `getMultipleAccounts` on bonding-curve keys, 100 per call (base64), decode reserves → market cap |
| Wake condition | Current MC ≥ rolling-min baseline × `revival.jumpMult` (2.0) AND current MC ≥ `revival.minMcUsd` ($8k). First sighting only primes the baseline. `complete = 1` (graduated) → drop candidate |
| Re-entry | Reconstruct `NewTokenEvent` from the DB row; `watchlist.add(event, meta, now - bundleWindowMs - 1)` — addedAt just past the bundle window so the (meaningless post-launch) bundle check can never disqualify a revival, while expiry still runs a full window from ~now. Outcome set back to `'watching'`. All existing gates apply unchanged |
| True age | `handleTrigger` computes `ageMinutes` from `t.event.receivedAt` (original creation time) instead of `t.addedAt`, so revival alerts show e.g. `⏱ 26h` worth of minutes; identical for fresh tokens |
| Dedupe | Candidates exclude alerted tokens by outcome; `alertExists` in handleTrigger remains the backstop. A woken token that expires again returns to the graveyard naturally (outcome → 'expired') |

## Bonding-curve account layout (pump.fun)

`8B discriminator | u64 virtualTokenReserves | u64 virtualSolReserves | u64 realTokenReserves | u64 realSolReserves | u64 tokenTotalSupply | u8 complete` (all LE).
`mcSol = (vSolLamports / 1e9) * 1e15 / vTokenRaw` (token has 6 decimals, supply 1e9). `vSolSol = vSolLamports / 1e9` (liquidity display).

## Interfaces

- **DB** (`src/db/index.ts`): `tokens` gains nullable columns `bonding_curve`, `creation_sig`, `dev_buy_tokens`, `image` (schema for new installs + `ALTER TABLE ... ADD COLUMN` migration guarded by `PRAGMA table_info` for existing DBs; old rows stay NULL and are skipped as candidates). `recordToken` accepts the new optional fields. New method `revivalCandidates(sinceMs: number, limit: number): RevivalRow[]` where `RevivalRow = { mint, symbol, name, creator, twitter?, telegram?, website?, image?, bondingCurve, creationSig, devBuyTokens, createdAt }`.
- **`src/pipeline/revivals.ts`**:
  - `parseBondingCurve(base64: string): { mcSol: number; vSolSol: number; complete: boolean } | null` (null on malformed/short data).
  - `class RevivalWatcher(cfg: RevivalConfig, deps: { candidates(): RevivalRow[]; fetchAccounts(keys: string[]): Promise<Array<string | null>>; solUsd(): number; wake(row: RevivalRow, mcSol: number, vSolSol: number): void })` with `sweep(): Promise<void>`. Keeps `minMcSol` per mint in memory; drops state for mints no longer candidates; wakes at most once per sweep per mint and clears that mint's baseline after waking (re-primes if it comes back).
- **Config**: top-level `revival { lookbackDays: 3, sweepMinutes: 10, jumpMult: 2, minMcUsd: 8000, maxCandidates: 6000 }`, numerics validated like the rest.
- **index.ts**: records the new token fields in `handleNew`; instantiates the watcher with `fetchAccounts` via QuickNode `getMultipleAccounts` (base64, batches of 100) and `wake` = rebuild event/meta → `watchlist.add(..., Date.now() - cfg.watch.bundleWindowMs - 1)` → `setOutcome('watching')` → log `revival: $SYM woke up ...`; sweep on its own interval (unref'd, re-entrancy-guarded); `ageMinutes` switched to `t.event.receivedAt`.

## Error handling

- `getMultipleAccounts` failure → that sweep logs a warn and returns (baselines untouched); next sweep retries.
- Malformed curve account → skip that mint this sweep.
- A woken token already on the watchlist (`watchlist.add` duplicate guard) → no-op.
- RPC cost: ≤ `maxCandidates/100` calls per sweep (~60 worst case, typically ~10-30) every 10 min — negligible.

## Testing

- `parseBondingCurve`: crafted buffer round-trips to expected mcSol/vSolSol/complete; short buffer → null.
- `RevivalWatcher.sweep`: primes baseline without waking; wakes on jump×2 above $8k; respects minMcUsd; skips complete=1; baseline is rolling MIN (drift down then jump wakes); doesn't wake twice for one pump; re-primes after wake.
- DB: new columns round-trip via recordToken; `revivalCandidates` filters by stage1/outcome/age/NULL curve; migration adds columns to a pre-existing DB (open old-schema DB fixture → constructor migrates).
- index wiring: ageMinutes-from-receivedAt covered by render/unit check.

## Out of scope

- Post-graduation revivals (token pumping on the AMM after migrating) — different data source; revisit if the graveyard proves out.
- Revival-specific scoring/thresholds — wakes go through the standard gates.
