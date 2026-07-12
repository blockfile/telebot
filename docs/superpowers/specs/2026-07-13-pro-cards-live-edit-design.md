# Pro Cards + Live-Edit Alerts — Design Spec

**Date:** 2026-07-13
**Status:** Approved design, pending implementation
**Goal:** Fix the `Bundle ? · Snipers ? …` gap (launch analysis pagination), add insider bought→holds arrows, estimated fees, a reference-style professional card layout, live self-updating alert cards, and top-10 trend in follow-ups. Display/UX only — no filter or scoring changes.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Trading fees | Display-only: `feesSol ≈ volumeSol × 1%`. No fee filter. |
| `?` metrics bug | Root cause: launch analyzer only reads the newest 1000 curve signatures; hot tokens exceed that by alert time. Fix: paginate backwards with `until: creationSignature`, capped at `maxSigPages = 15` pages (~15k sigs); if the cap is exhausted before reaching creation → `'unknown'` (unchanged failure mode). |
| Bought→holds | For bundler + sniper wallets found in launch analysis, fetch current balances via `getTokenAccountsByOwner` (jsonParsed, per wallet, batched 5, capped at the top 20 wallets by bought amount). New fields: `bundleCount`, `bundleHeldPct`, `sniperHeldPct` (`'unknown'` on RPC failure — never blocks). |
| Top-10 trend | `FollowUp` stores `top10AtAlert` + `bondingCurveKey`; every follow-up fire re-measures `fetchTop10Pct` and shows `🏆 Top10 28% → 21%`. |
| Live card | Alert message edits itself every `followUp.liveEditSec` (default 45s, 0 = off) for the follow-up window (`followUp.windowMinutes`), showing `📈 Now: $X • N.NX`. Data comes from the FollowUps tracker (`get(mint)` accessor) — no new subscriptions. Editing stops when the follow-up is removed (dump/window) or the window elapses. DRY mode: no live edits. |
| UI | Reference-style labeled rows (mock below). Held-trend emoji: 💚 held ≥70% of bought, 🟡 30–70%, 🔻 <30%. |
| Latency | Log `deep checks took Xms` on every trigger to quantify the alert delay; no aggressive trimming yet. |

## Card layout (caption; photo + buttons unchanged)

```
🔥 CONSEAL • Conseal Protocol
⭐ Score: 80/100 | ⏱ 24m
📈 Now: $48.2k • 3.1X            ← only when live update data present
⚠️ <flags>                        ← only when flags exist

💰 MC: $15.6k • ⇡ top $18.4k
💧 Liq: $12.3k
📊 Vol: $27.6k • 🪙 ~1.4 SOL fees
👥 Hodls: 341 | Buyers: 119

📦 Bundles: 8% → 3% 💚
🔫 Snipers: 5 • 12% → 4% 💚
🎯 First 20: 31%
🛠 Dev: 0.0% | Out: 0% | Priors: 0
🏆 Top 10: 28%

🐦 X ✅ | TG ❌ | Web ✅

<code>MINT</code>
```

Unknowns render `?` (e.g. `📦 Bundles: 8% → ?`). Grade emoji unchanged (🔥 80+ / ⚡ 70+ / ✅ else).

## Interfaces

- `LaunchAnalysis` += `bundleCount: number`, `bundleHeldPct: number | 'unknown'`, `sniperHeldPct: number | 'unknown'`.
- `analyzeLaunch(rpc, mint, curve, creator, creationSig, maxEarlyTxFetch, sniperSlots, maxSigPages = 15)`.
- `CheckResults` += `bundleCount`, `bundleHeldPct`, `sniperHeldPct` (all `Unknown<number>`; `'unknown'` when launch is unknown).
- `AlertData` += `feesSol: number`, `bundleCount`, `bundleHeldPct`, `sniperHeldPct` (Unknown), optional `live?: { nowUsd: number; multiple: number }`.
- `Telegram.send(...)` returns `Promise<SendResult>` where `SendResult = { ok: boolean; messageId?: number; photo?: boolean }` (messageId parsed from the Telegram response; `photo` true when delivered via sendPhoto).
- `Telegram.editCaption(messageId: number, text: string, buttons: Keyboard, photo: boolean): Promise<boolean>` — `editMessageCaption` for photo messages / `editMessageText` (link preview on) otherwise; MUST resend `reply_markup` (an edit without it clears the buttons); single attempt + one retry; treats "message is not modified" as success; never throws.
- `FollowUp` += `bondingCurveKey: string`, `top10AtAlert: number | 'unknown'`; `FollowUps.add(mint, symbol, alertMcSol, now, image?, bondingCurveKey?, top10AtAlert?)`; new accessor `get(mint): FollowUp | undefined`.
- `FollowUpData` (dump/window) += `top10From?: Unknown<number>`, `top10Now?: Unknown<number>` → rendered as a `🏆 Top10 X% → Y%` line when both present.
- Config: `followUp.liveEditSec: number` (default 45; 0 disables live edits). Validated like other numerics.
- index.ts: `send` wrapper returns `SendResult`; summary caller adapts to boolean; live-card registry `Map<mint, { messageId, photo, data: AlertData, buttons, alertMcSol, startedAt }>`; ticker every `liveEditSec` regenerates the caption via `formatAlert({ ...data, live })` and calls `editCaption`; deregisters when `followUps.get(mint)` is gone or window elapsed.

## Error handling

- Pagination cap exhausted → launch analysis `'unknown'` (same as today, but now rare).
- Holds lookups: per-wallet failures are skipped; if ALL lookups fail → `'unknown'` held pct.
- Live edits: any edit failure logs once at warn and deregisters that card (no retry storms).
- Fees are derived, never fetched — no failure mode.

## Testing (all injected fetch/RPC, no network)

- launchAnalysis: multi-page pagination reaches creation; cap exhaustion → 'unknown'; holds fetch computes heldPct; holds failure → 'unknown'; existing sniper/bundle tests updated.
- telegram: send returns messageId from response; editCaption hits the right endpoint with reply_markup for photo vs text; formatAlert renders new rows, fees, live line, arrows + trend emoji, unknowns; formatFollowUp renders top10 trend.
- followups: get() accessor; add stores bondingCurveKey/top10AtAlert.
- stage3/scoring fixtures updated; scoring still ignores new fields (display-only guarantee).

## Out of scope

- Fee-based filtering; instant pre-alert pings; per-wallet sniper "still held" beyond the aggregate; any threshold/scoring change.
