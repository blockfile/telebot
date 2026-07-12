# PumpSwap Direct-Launch Discovery — Design Spec

**Date:** 2026-07-13
**Status:** Approved scope (PumpSwap only, 25 SOL min liquidity); pending implementation
**Goal:** Catch SCATMAN-class tokens that launch directly as a PumpSwap pool (dev-seeded liquidity, no pump.fun bonding curve). These never appear in the PumpPortal new-token feed, so today they are invisible to the scanner. New discovery channel feeds the existing pipeline.

## Decisions

| Decision | Choice |
|---|---|
| Venue | PumpSwap AMM only (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`); Raydium later if this proves out |
| Anti-dust gate | Initial pool liquidity ≥ **25 SOL** (`dexLaunch.minInitialSol`), configurable |
| Scope guard | Only NEW pools for NEW mints (skip migration pools for tokens we already track — a pool whose mint exists in our `tokens` table is a graduation, not a launch) |
| Pipeline | Wakes feed the existing watchlist → traction gate → deep checks → score, with DEX-launch adaptations below |

## Architecture

```
QuickNode WS (logsSubscribe, mentions=[PumpSwap program])
  → detect CreatePool tx → fetch tx (jsonParsed) → extract mint, pool, creator, initial SOL
  → skip if mint known (migration) or initial SOL < 25
  → fetch Metaplex metadata (PDA → account → URI → JSON: socials/image)
  → stage-1 filter (adapted) → watchlist.add(...) → existing pipeline
```

## Components

1. **`src/stream/solanaLogs.ts`** — minimal Solana WS client on the QuickNode endpoint (`wss` form of the HTTP URL): `logsSubscribe({ mentions: [PUMPSWAP_PROGRAM] }, 'confirmed')`, reconnect with backoff + watchdog (same pattern as PumpPortalStream), emits signatures whose logs contain the pool-creation instruction marker (`Instruction: CreatePool`).
2. **`src/checks/pumpswapPool.ts`** — given the creation signature: `getTransaction` (jsonParsed) → extract base mint, pool address, creator (fee payer), initial SOL deposited (from the SOL transfer/wrap into the pool vault) → `{ mint, pool, creator, initialSol, signature, slot }`. Returns 'unknown' on decode failure (log + skip; never crash).
3. **`src/checks/metaplex.ts`** — metadata for non-pump.fun mints: derive the Metaplex metadata PDA (requires `findProgramAddress`; add tiny dep `@noble/ed25519` — amends the original deps constraint — or `@solana/web3.js` if simpler), `getAccountInfo` → decode name/symbol/uri from the Metaplex layout → fetch URI JSON → reuse `extractMeta` (twitter/telegram/website/image). 'unknown' on any failure.
4. **Pipeline adaptations:**
   - Synthesize a `NewTokenEvent`: `devBuyTokens = 0` (no bonding-curve dev buy; the dev's exposure is the LP), `bondingCurveKey = pool` (so holder checks exclude the pool vault), `vSolInBondingCurve = initialSol` (liquidity display), `signature = creationSig` (launch analysis anchors work unchanged — bundle = same-slot buys after pool creation, snipers = first N slots).
   - Stage 1: same social rules; dev-buy% check trivially passes (0); serial-deployer/handle/ticker checks unchanged. New gate: `initialSol >= dexLaunch.minInitialSol` (checked before stage 1).
   - Trade tracking: PumpPortal `subscribeTokenTrade` by mint — **verify during build** that pump-amm trades stream for never-bonded mints (they do for graduated tokens; expected to work). Fallback if not: poll pool reserves like the revival sweep (reuse pattern).
   - Alert card: gains a `🏦 DEX launch` marker line so the user knows it's a direct listing; dev row reads LP-based (`Dev seeded X SOL`).
   - Revival watcher: DEX-launch tokens have no bonding curve — excluded from the graveyard (pool-reserve polling variant is future work).
5. **Config:** `dexLaunch { enabled: true, minInitialSol: 25 }` (+ validation).
6. **DB:** reuse `tokens` (bonding_curve column holds the pool address; add `source TEXT DEFAULT 'pump'` column with value `'pumpswap'` for these — used by the revival exclusion and stats).

## Verification checklist (during build)

- [ ] Confirm PumpSwap CreatePool log line/discriminator against a real recent pool-creation tx.
- [ ] Confirm PumpPortal streams pump-amm trades for a never-bonded mint (subscribe to a live one, observe).
- [ ] Confirm initial-SOL extraction against SCATMAN's actual creation tx (`Cit4M38…4mgA`, expect ~502 SOL).
- [ ] QuickNode WS logsSubscribe rate: PumpSwap CreatePool events are low-volume (tens/hour) — negligible.

## Error handling

Same doctrine as the rest: every external fetch degrades to 'unknown'/skip with a warn log; the logs WS reconnects with backoff + 120s watchdog; a decode failure never crashes the pipeline; DRY mode works unchanged.

## Testing

Pure decoders (pool-creation extraction from a fixture tx, Metaplex layout decode) fully unit-tested; stream client thin-wrapper untested (live smoke); stage-1 gate + event synthesis tested; end-to-end via dry run.

## Out of scope

- Raydium/other AMMs; revival sweeps for DEX-launched tokens; LP-lock/burn analysis (valuable — candidate for v2: a dev who didn't lock LP can pull it).
