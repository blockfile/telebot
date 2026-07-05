# Trenches Scanner — Design Spec

**Date:** 2026-07-05
**Status:** Approved design, pending implementation
**Goal:** A Node.js program that watches every new Pump.fun token launch in real time, filters for tokens with genuine social presence, a clean dev wallet, and early market traction, and sends the contract address (CA) plus a quality scorecard to the user's Telegram. Alert-only — no trading.

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Alert timing | Early traction — watch all mints, alert when filters pass AND momentum confirms |
| Social checks | Free-tier only (metadata links, liveness, handle-reuse detection); no paid X API |
| RPC | User's QuickNode endpoint (standard Solana JSON-RPC), used only for deep checks |
| Discovery/tracking stream | PumpPortal free WebSocket (`subscribeNewToken`, `subscribeTokenTrade`) |
| Runtime | TypeScript / Node.js, running on the user's Windows PC |
| Architecture | Approach A: event-driven pipeline, PumpPortal for streams + QuickNode for deep checks |
| Scope guard | Pump.fun tokens only; alert-only (no auto-buy) |

## Architecture overview

Single long-running Node.js process. Event-driven pipeline with three stages of increasing cost, backed by a SQLite database that accumulates knowledge (dev wallets, Twitter handles, token outcomes) the longer it runs.

```
PumpPortal WS ── newToken ──▶ Stage 1 (mint filters, free, instant)
                                  │ pass
                                  ▼
                            Watchlist (Stage 2: traction tracking via trade stream, ≤ 90 min/token)
                                  │ traction trigger
                                  ▼
                            Stage 3 (deep checks: QuickNode + HTTP, runs once per token)
                                  │ score ≥ threshold, no hard rejects
                                  ▼
                            Telegram alert (deduped, one per token ever)
```

SQLite records every token seen, every dev wallet, every Twitter handle, and every alert — Stage 1 and Stage 3 read from and write to it.

## Components

| Module | Responsibility |
|---|---|
| `src/index.ts` | Entry point; wires stream → pipeline → telegram; graceful shutdown |
| `src/config.ts` | Loads `.env` (secrets) + `config.json` (thresholds); validates on boot, exits with a clear message if anything is missing |
| `src/stream/pumpportal.ts` | WebSocket client for `wss://pumpportal.fun/api/data`; emits typed `NewTokenEvent` / `TradeEvent`; auto-reconnect with exponential backoff (1s → 30s cap) and re-subscribes the current watchlist on reconnect |
| `src/pipeline/stage1.ts` | Mint-time filters (pure function + DB lookups) |
| `src/pipeline/watchlist.ts` | In-memory map of watched tokens; consumes trade events; tracks market cap, unique buyers, buy/sell counts, dev sells; expires tokens after the watch window; fires the traction trigger |
| `src/pipeline/stage3.ts` | Orchestrates deep checks; assembles the scorecard |
| `src/pipeline/scoring.ts` | Pure scoring function: check results in → `{score: 0-100, hardRejects: string[], flags: string[]}` out |
| `src/checks/metadata.ts` | Fetches token metadata JSON from its URI (IPFS/HTTP, 5s timeout); extracts twitter/telegram/website |
| `src/checks/socials.ts` | Link liveness (HTTP GET, 5s timeout); Twitter-handle normalization + reuse lookup; best-effort X page existence check |
| `src/checks/devHistory.ts` | Via QuickNode: `getSignaturesForAddress` on the creator wallet; counts prior Pump.fun creations; finds first inbound SOL transfer (funding source) |
| `src/checks/holders.ts` | Via QuickNode: `getTokenLargestAccounts`; computes top-10 concentration excluding the bonding-curve account |
| `src/checks/bundling.ts` | From recorded early trades: counts buys landing in the creation slot / first slot |
| `src/db/index.ts` | better-sqlite3 setup + migrations (`tokens`, `devs`, `handles`, `alerts` tables) |
| `src/telegram.ts` | Telegram Bot API `sendMessage` (HTML parse mode); alert dedupe via `alerts` table; daily summary message |
| `src/rpc.ts` | Thin QuickNode JSON-RPC wrapper: retry with jitter on 429/5xx, request timeout |
| `src/solPrice.ts` | SOL/USD price, refreshed every 5 min from CoinGecko's free endpoint; falls back to last known value, then to a configurable default |
| `src/logger.ts` | Console + rolling file log (`logs/scanner.log`) |

Each module is independently testable; filters and scoring are pure functions taking plain data.

## Filter pipeline — defaults

All numeric thresholds live in `config.json`. Defaults:

### Stage 1 — at mint

| Check | Rule | On fail |
|---|---|---|
| Socials present | Metadata has X/Twitter link AND (Telegram OR website) | reject |
| Handle reuse | Twitter handle already in `handles` table from a previous token | reject (recycled-rug signal) |
| Dev buy size | Creator's initial buy ≤ 10% of total supply | reject |
| Serial deployer | Creator wallet created > 2 tokens in the last 48h (from our DB) | reject |
| Ticker clone | Same symbol (case-insensitive) launched within the last 24h | reject |

Every token (pass or fail) is recorded in `tokens`; the handle and dev wallet are recorded regardless of outcome so the knowledge base grows.

### Stage 2 — traction watch

- Watch window: **90 minutes** from mint; token silently dropped after that.
- Trigger: **market cap ≥ $15,000** (from trade-event `marketCapSol` × SOL/USD) **AND ≥ 25 unique buyer wallets**.
- Instant disqualify during watch: creator wallet sells any amount; or bundling check fails (≥ 8 distinct buyer wallets in the creation slot).
- Watchlist is capped at 500 concurrent tokens (oldest evicted first) to bound memory; evictions are logged.

### Stage 3 — deep checks (once per triggered token)

| Check | Data source | Effect |
|---|---|---|
| Dev launch history | QuickNode signatures + own DB | > 3 lifetime launches, none graduated (completed the bonding curve) → **hard reject**; 1–3 priors → −15 pts; a prior token graduated → +20 pts |
| Funding source | First inbound SOL transfer to dev wallet | Funder wallet linked to a hard-rejected/rugged token in DB → **hard reject** |
| Top-10 concentration | `getTokenLargestAccounts` minus bonding curve | > 45% → **hard reject**; ≤ 30% → +10 pts |
| Link liveness | HTTP GET each social link | Each dead link → −10 pts; live website → +10 pts |
| X existence | Best-effort page fetch | Clearly nonexistent account/community → −15 pts; fetch blocked/inconclusive → 0 (unknown ≠ pass, unknown ≠ fail) |
| Dev behavior | From watchlist state | Dev still holds full initial buy → +10 pts |

### Scoring

Base score 50; modifiers above apply; clamp to 0–100. **Alert if score ≥ 60 and zero hard rejects.** The alert shows the score and any soft flags so the user can judge borderline cases themselves.

## Telegram alert format

HTML parse mode, one message per token, ever (dedupe by mint in `alerts`):

```
🎯 TRENCH ALERT — $TICKER  (score 74/100)
Name • MC $18.4k • age 23m • buyers 41
CA: <code>7xKX…pump</code>          ← tap-to-copy
Dev: bought 2.1%, still holds, 0 prior launches
Holders: top10 21% • bundle: clean
Socials: 𝕏 ✓  TG ✓  Web ✓
<links: pump.fun | GMGN | Solscan | RugCheck>
⚠️ flags: (only if any)
```

Link URLs: `https://pump.fun/coin/<mint>`, `https://gmgn.ai/sol/token/<mint>`, `https://solscan.io/token/<mint>`, `https://rugcheck.xyz/tokens/<mint>`.

A daily summary message ("scanned N / watched N / alerted N") is sent at a configurable hour (default 09:00 local).

## Configuration

- `.env` (gitignored): `QUICKNODE_RPC_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- `config.json`: every threshold named above, watch window, alert score threshold, summary hour, SOL price fallback.
- `README.md` includes a non-developer-friendly setup walkthrough: install Node, create the Telegram bot with @BotFather, get the chat ID, fill `.env`, run.

## Modes

- `npm start` — live mode, sends Telegram alerts.
- `npm run dry` — identical pipeline, but alerts print to console and are marked `dry` in the DB instead of being sent. For tuning filters safely.

## Error handling

- **WebSocket:** exponential backoff reconnect (1s → 30s cap), resubscribe new-token feed + all watched mints on reconnect. Tokens minted during an outage are simply missed (accepted).
- **HTTP checks (metadata, socials, price):** 5s timeout, one retry; failure → result "unknown", never a pass or a hard fail.
- **QuickNode:** retry with jitter on 429/5xx (max 3); if deep checks can't complete, the token is skipped and logged — no alert on partial data.
- **Telegram:** retry up to 3 times; failed alerts logged with full payload so nothing is silently lost.
- **Process:** uncaught errors logged with stack; process exits nonzero (user runs it under a restart loop or just restarts; README covers this).

## Testing

- Vitest unit tests for `stage1`, `scoring`, `bundling`, `watchlist` state transitions, and Twitter-handle normalization — all pure logic, driven by fixture events modeled on real PumpPortal payloads.
- End-to-end validation via dry-run mode against the live feed.

## Explicitly out of scope (YAGNI)

- Auto-buying / trading of any kind
- Paid X API integration
- GMGN unofficial API scraping
- A web dashboard
- Multi-chain / non-Pump.fun launchpads
- VPS deployment (may come later; design does not preclude it)
