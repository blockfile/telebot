# Rich Alert Cards + Up-Nx Follow-ups — Design Spec

**Date:** 2026-07-07
**Status:** Approved design, pending implementation
**Goal:** Make Telegram alerts look like a premium trench bot — token image on top, tap-buttons (Buy / Chart / Scan / pump.fun) underneath — and add celebratory "up Nx since alert" follow-up cards at 2/5/10/25/50/100X, while keeping the existing dump warnings.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Alert visual | Photo (token image) + caption + inline buttons; auto-fallback to text if no image or photo send fails |
| Buttons | Buy (config-driven, user referral links w/ `{CA}`), Chart (GMGN), Scan (RugCheck), pump.fun |
| Up-Nx milestones | 2X, 5X, 10X, 25X, 50X, 100X — each fires once, based on peak vs alert market cap |
| Dump warnings | Kept |
| Buy links | Config-driven in `config.json` so the user can add/swap bots without code changes |
| Not attempted (data we don't have) | total holder count, snipers, fake volume, liquidity |

## Architecture overview

Additive changes to existing modules — no new pipeline stages.

```
metadata.ts    → also extract token `image`
types.ts       → TokenMeta gains `image?`
telegram.ts    → InlineButton/Keyboard types; sendPhoto; buildButtons; card-aware send; new follow-up formats
config.ts      → ButtonsConfig; FollowUpConfig.milestones
followups.ts   → milestone-crossing detection (fires each Nx once), richer fire event
index.ts       → build photoUrl+buttons for alerts and follow-ups; wire config
```

## Components

### 1. Metadata image (`src/checks/metadata.ts`, `src/types.ts`)
- `TokenMeta` gains `image?: string`.
- `extractMeta` also picks `image` (same trim rules as other fields).
- `ipfsToHttp` is reused at send time to turn `ipfs://…` into a gateway URL Telegram can fetch. Raw value is stored; conversion happens where the photo URL is built.

### 2. Telegram buttons + photo (`src/telegram.ts`)
- Types: `interface InlineButton { text: string; url: string }`; `type Keyboard = InlineButton[][]`.
- `buildButtons(mint: string, cfg: ButtonsConfig, opts?: { web?: Array<'chart'|'scan'|'pumpfun'> }): Keyboard`:
  - Row 1 = Buy buttons from `cfg.buy`, each `{ text: label, url: url.replaceAll('{CA}', mint) }`.
  - Row 2 = web buttons for the keys in `opts.web` (default `['chart','scan','pumpfun']`): Chart→`https://gmgn.ai/sol/token/<mint>`, Scan→`https://rugcheck.xyz/tokens/<mint>`, pump.fun→`https://pump.fun/coin/<mint>`, each gated by its `cfg.chart`/`cfg.scan`/`cfg.pumpfun` boolean.
  - Empty rows are omitted; returns `[]` when nothing enabled.
- `Telegram.send` is generalized to accept an optional payload: `send(payload: { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<boolean>` (a plain `string` is still accepted and treated as `{ text }` for the summary caller).
  - If `photoUrl` is set: POST `sendPhoto` with `photo: photoUrl`, `caption: text`, `parse_mode: HTML`, `reply_markup` (if buttons). On non-ok response, **fall back** to `sendMessage` with the same text + buttons (link preview enabled) and log the fallback.
  - If no `photoUrl`: POST `sendMessage` with `text`, `parse_mode: HTML`, `link_preview_options: { is_disabled: false }`, `reply_markup` (if buttons).
  - Retry/429 behavior unchanged; still never throws, returns boolean.
- Telegram caption limit is 1024 chars; the alert caption is ~450, so no truncation needed (spec note only).

### 3. Alert + follow-up formatting (`src/telegram.ts`)
- `formatAlert` (caption): unchanged clean layout, **minus** the trailing text-links line (links move to buttons). Ends at the tap-to-copy `<code>CA</code>`.
- `FollowUpData` becomes a discriminated shape by `kind`:
  - `{ kind: 'up'; symbol; multiple; fromUsd; peakUsd }` → `📈 <b>$SYM</b> is up {multiple}X 📈` / `from your Trench alert` / `${usd(fromUsd)} → ${usd(peakUsd)}` / rocket row (`'🚀'.repeat(min(multiple,10))`) / tap-to-copy CA.
  - `{ kind: 'dump'; symbol; peakUsd; nowUsd; peakPct; nowPct }` → `⚠️ <b>$SYM</b> dumped` line with peak/now (current behavior, restyled).
  - `{ kind: 'window'; symbol; peakUsd; nowUsd; peakPct; nowPct }` → `📊 <b>$SYM</b> recap` peak/now.
- `formatFollowUp(d: FollowUpData): string` returns the caption; buttons are built separately by the caller.

### 4. Milestone follow-ups (`src/pipeline/followups.ts`)
- `FollowUp` gains `image?: string` and `firedMilestones: number[]`.
- `add(mint, symbol, alertMcSol, now, image?)` stores image and `firedMilestones: []`.
- `onTrade`: after updating `lastMcSol`/`peakMcSol`, compute `multiple = alertMcSol > 0 ? peakMcSol / alertMcSol : 0`. For each `m` in `cfg.milestones` (ascending) where `m <= multiple` and `!firedMilestones.includes(m)`: push `m`, and `hooks.fire(fu, { kind: 'up', multiple: m })`. An `'up'` fire does **not** remove the follow-up (keeps tracking for higher milestones). Dump detection unchanged and still removes on fire. Window sweep unchanged.
- `FollowUpHooks.fire(fu, event)` where `event = { kind:'up'; multiple:number } | { kind:'dump' } | { kind:'window' }`.

### 5. Config (`src/config.ts`, `config.json`)
- `ButtonsConfig { buy: Array<{ label: string; url: string }>; chart: boolean; scan: boolean; pumpfun: boolean }`, top-level `buttons`.
- `FollowUpConfig` gains `milestones: number[]`.
- `config.json` defaults:
  ```json
  "buttons": {
    "buy": [],
    "chart": true,
    "scan": true,
    "pumpfun": true
  }
  ```
  and `"followUp": { …, "milestones": [2, 5, 10, 25, 50, 100] }`.
  - The `buy` array starts empty; the user's Soul/Phanes/Trojan referral links (with `{CA}`) are added during wiring, e.g. `{ "label": "⚡ Trojan", "url": "https://t.me/solana_trojanbot?start={CA}" }`.
- Validation: `buttons` object present with a `buy` array and boolean web flags; `followUp.milestones` a non-empty number array. Missing → clear boot error (existing pattern).

### 6. Wiring (`src/index.ts`)
- Thread `image` from `t.meta.image` into the alert send and into `followUps.add(...)`.
- Alert send: `photoUrl = t.meta.image ? ipfsToHttp(t.meta.image) : undefined`; `buttons = buildButtons(mint, cfg.buttons)`; `send({ text: caption, photoUrl, buttons })`.
- Follow-up `fire`: build caption via `formatFollowUp`, `photoUrl` from `fu.image`, `buttons = buildButtons(fu.mint, cfg.buttons, { web: ['chart','pumpfun'] })`; send.
- DRY wrapper: prints caption + `[photo]`/`[buttons]` markers to console.

## Error handling
- **Photo fetch failure** (IPFS 404/timeout, Telegram can't fetch): `sendPhoto` returns non-ok → automatic fallback to `sendMessage` (text + buttons + link preview). No alert is ever lost to a bad image.
- **Missing image**: no `photoUrl` → normal text message with buttons + preview.
- **`{CA}` absent from a buy url**: `replaceAll` is a no-op; the button still opens the bot (without the token). Acceptable.
- **Milestone spam guard**: `firedMilestones` ensures each Nx fires at most once per token; a token that gaps from 1X→12X in one trade fires 2X/5X/10X once each (all crossed), then continues.

## Testing (Vitest, no network — inject `fetchFn`, stub hooks)
- `metadata`: `extractMeta` pulls `image`; absent → undefined.
- `buildButtons`: `{CA}` substituted in buy + web urls; disabled web flags omit buttons; empty config → `[]`; row layout correct.
- `telegram.send`: photo path posts `sendPhoto` with caption+reply_markup; non-ok photo response falls back to `sendMessage` (assert both endpoints hit); text path posts `sendMessage` with reply_markup.
- `formatFollowUp`: up-card shows `is up 5X`, `$X → $Y`, rockets; dump card leads with ⚠️; window card is a recap.
- `followups`: crossing 2X fires once and keeps tracking; reaching 5X later fires 5X; a big jump fires all crossed milestones once; dump still fires+removes; `firedMilestones` prevents refire.

## Out of scope (YAGNI)
- Holder count, snipers, fake-volume, liquidity metrics (need heavy extra RPC).
- `callback_data` buttons / bot-side button handling (all buttons are plain URL deep links).
- Editing a live message in place as price moves (each follow-up is a new card).
