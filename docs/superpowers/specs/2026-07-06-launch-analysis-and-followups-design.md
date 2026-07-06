# Launch Analysis + Alert Follow-ups — Design Spec

**Date:** 2026-07-06
**Status:** Approved design, pending implementation
**Goal:** Enrich Trenches Scanner alerts with three insider-supply / performance signals inspired by third-party scanner bots, without weakening the existing filter or adding paid data sources. All new on-chain work runs only on tokens that reach the deep-check stage (~a handful per day), through the user's existing QuickNode RPC.

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Feature 1 shape | Post-alert **follow-up message** (not in-alert drawdown, which is ~0% at our trigger time) |
| Feature 2 | Exact **bundle %** (creation-slot insider buys) + **first-20 buyers** share, via QuickNode |
| Feature 3 | **Dev outflow / airdrop %** (supply the dev moved to other wallets), via QuickNode |
| Bundle hard-reject | > 50% of supply bundled at creation |
| Dev-outflow hard-reject | > 30% of supply moved out of the dev wallet |
| Follow-up window | 60 minutes, or immediate if it dumps > 50% off peak |
| New-check "unknown" handling | Enrichment only — **never** gates an otherwise-good alert (only dev-history + top-10 gate, unchanged) |

## Architecture overview

Two independent additions, each isolated behind a clear interface:

1. **Launch analysis** — a new deep-check module `src/checks/launchAnalysis.ts` that runs during Stage 3 (alongside the existing dev-history and holder checks), returning `{ bundlePct, first20Pct, devOutflowPct }` or `'unknown'`. Its outputs flow into scoring (hard rejects + penalties) and into the alert display.

2. **Alert follow-ups** — a new manager `src/pipeline/followups.ts`. After an alert is sent, the token is re-subscribed to the trade stream and tracked for a window; a single follow-up message reports peak and current performance, or fires early on a large dump.

Both reuse existing infrastructure: the `Rpc` wrapper, the PumpPortal stream, the `Telegram` sender, the SQLite `alerts` table, and `config.json`.

## Component 1 — Launch analysis (Features 2 & 3)

### Module: `src/checks/launchAnalysis.ts`

```
interface LaunchAnalysis {
  bundlePct: number;      // % of 1B supply bought by non-dev wallets in the creation slot
  first20Pct: number;     // % of supply bought by the first 20 distinct non-dev buyers
  devOutflowPct: number;  // % of supply transferred OUT of the dev wallet (airdrop/hidden supply)
}
analyzeLaunch(rpc, mint, bondingCurveKey, creator, creationSignature): Promise<LaunchAnalysis | 'unknown'>
```

**Method (all via QuickNode `Rpc`, bounded call budget):**
1. `getTransaction(creationSignature)` → the creation **slot**. If missing/unparseable → `'unknown'`.
2. `getSignaturesForAddress(bondingCurveKey, { limit: 1000 })` → all activity since launch (a just-triggered token has at most a few hundred txs). Fetch a bounded number (≤ 60) of the **earliest** transactions in batches of 5, with per-call `.catch → null` (same pattern as `devHistory.ts`).
3. **bundlePct** = sum of token amounts bought by non-dev wallets whose transaction slot equals the creation slot, ÷ TOTAL_SUPPLY × 100.
4. **first20Pct** = sum of token amounts bought by the first 20 distinct non-dev buyer wallets (in slot/time order), ÷ TOTAL_SUPPLY × 100.
5. **devOutflowPct**: `getSignaturesForAddress(creator, { limit: 1000 })`, fetch a bounded number of the earliest txs, sum SPL-token `transfer`/`transferChecked` amounts of **this mint** whose source-owner is the creator, ÷ TOTAL_SUPPLY × 100.
6. Any step failing throws → caught → whole result is `'unknown'`.

Cost per triggered token: ~2 `getSignaturesForAddress` + ≤ ~24 `getTransaction` calls. Runs only on deep-check tokens (~5/day), so negligible.

### Scoring integration

Extend `CheckResults` (scoring.ts) with `bundlePct`, `first20Pct`, `devOutflowPct`, each `Unknown<number>`. `scoreToken` rules (all thresholds from config):

- `bundlePct` known: `> bundleHardRejectPct` (50) → **hard reject** `bundle Nx%`; `≥ bundlePenaltyPct` (20) → −`bundlePenalty` (15) + flag; else no change.
- `devOutflowPct` known: `> devOutflowHardRejectPct` (30) → **hard reject** `dev moved out N%`; `≥ devOutflowPenaltyPct` (10) → −`devOutflowPenalty` (15) + flag; else no change.
- `first20Pct` known: `> first20FlagPct` (60) → flag `first-20 hold N%` (display only, no score change).
- Any of them `'unknown'` → no score change, no reject, optional single flag `launch analysis unknown`.

**Gate rule (unchanged and explicit):** the Stage-3 partial-data gate in `index.ts` continues to skip alerts only when **dev-history or top-10** is `'unknown'`. Launch-analysis `'unknown'` does **not** suppress alerts.

### Alert display

`AlertData` gains `bundlePct`, `first20Pct`, `devOutflowPct` (`number | 'unknown'`). `formatAlert` adds a line:

```
Launch: bundle 8% • first-20 31% • dev-out 0%
```

with `?` for any unknown value. The existing hardcoded `bundle: clean` line is replaced by this real data.

## Component 2 — Alert follow-ups (Feature 1)

### Module: `src/pipeline/followups.ts`

```
interface FollowUp {
  mint: string; symbol: string;
  alertMarketCapSol: number; peakMarketCapSol: number; lastMarketCapSol: number;
  alertedAt: number;
}
interface FollowUpHooks {
  subscribe(mint): void; unsubscribe(mint): void;
  send(fu: FollowUp, reason: 'window' | 'dump'): void;
}
class FollowUps {
  add(mint, symbol, alertMarketCapSol, now): void;   // called right after an alert is sent
  onTrade(trade, now): void;                          // updates peak/last; fires 'dump' if drawdown > dumpAlertPct
  sweep(now): void;                                   // fires 'window' for tokens past windowMinutes
  has(mint): boolean;
}
```

- On alert, `index.ts` calls `followUps.add(...)` and the token is (re)subscribed to the trade stream.
- Each trade updates `peak` and `last`. If `(peak - last)/peak × 100 > dumpAlertPct` (50), fire a `dump` follow-up immediately, then stop tracking + unsubscribe.
- `sweep` (reuses the existing 60-s interval) fires a `window` follow-up for tokens past `windowMinutes` (60), then unsubscribes.
- Exactly one follow-up message per token; then it is dropped.
- In-memory only. A process restart drops pending follow-ups (acceptable — they are informational, and a restart is rare). This is stated in the README.

### Follow-up message (`telegram.ts`)

```
📈 $TICKER follow-up — peaked $22k (+47%), now $9k (-40% since alert)
```

`dump` follow-ups lead with ⚠️. Peak/current shown in USD via `solPrice.usd`; percentages are relative to the alert-time market cap.

### Trade routing

Trades already flow to `watchlist.onTrade`. Add a parallel `followUps.onTrade(trade, now)` call in `index.ts`'s trade handler. A mint can never be in both the watchlist and follow-ups at once (watchlist removes it before trigger; follow-ups start after alert), so there is no conflict. The stream tracks subscribed mints in a Set and de-dupes, so re-subscribing an alerted mint is safe.

## Configuration additions (`config.json`)

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
}
```

All validated at boot by `loadConfig` (extend the existing numeric-field check).

## Error handling

- `launchAnalysis` mirrors `devHistory`: every RPC failure degrades to `'unknown'`; never throws into the pipeline; never blocks an alert.
- Follow-ups are best-effort: a failed follow-up send is logged (like any Telegram failure) and the token is still dropped — no retry storm, no effect on core alerting.
- Re-subscription failures (stream not open) are swallowed by the existing `sendIfOpen`.

## Testing

- **Unit (pure logic):** extend `scoring.test.ts` for the new bundle / dev-outflow / first-20 rules (hard rejects, penalties, boundaries, `'unknown'` no-op). New `followups.test.ts` for peak/last tracking, dump-trigger, window-expiry, one-message-per-token, subscribe/unsubscribe exactly once. Extend `telegram.test.ts` for the new alert line and the follow-up formatter. Extend `config.test.ts` for the new fields.
- **Parsing logic:** `launchAnalysis.ts` transaction parsing is exercised with fixture transactions (fake `getTransaction` / `getSignaturesForAddress` responses via a stub `Rpc`, same pattern as `holders.test.ts`) — no network.
- **End-to-end:** live dry-run against the real feed; confirm launch-analysis numbers appear on a triggered token and a follow-up message fires, with no crashes and graceful `'unknown'` degradation against transient RPC errors.

## Out of scope (YAGNI)

- "Still holding" balances for first-20 (needs SPL associated-token-account derivation / an extra dependency — deferred; we report **bought** share, which is bounded and dependency-free).
- Wash/fake-volume detection and sniper hold-through (unreliable without a dedicated indexing backend).
- DexScreener paid/ads status (not meaningful for pre-graduation Pump.fun tokens).
- Persisting pending follow-ups across restarts.
