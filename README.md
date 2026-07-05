# Trenches Scanner

## 1. What it is

Trenches Scanner watches every single new token launch on Pump.fun in real time and quietly does the homework you don't have time to do on hundreds of new coins a day. It runs each launch through three stages of filtering — first a quick check of the mint and dev wallet, then a 90-minute watch for real trading traction, then a deeper background check on the developer's history, wallet, and social links. Anything that survives all three stages gets a score from 0 to 100, and if that score clears your threshold, the scanner sends the contract address straight to your Telegram, ready to paste into your trading tool of choice.

This tool is **alert-only**. It never buys, sells, or holds anything, and it never touches your wallet or your funds. It just watches and taps you on the shoulder when something looks worth a closer look. It is not a guarantee of anything — see the disclaimer at the bottom before you use it.

## 2. Requirements

Before you start, make sure you have:

- **Node.js version 20 or newer.** This is the free program that runs the scanner. If you don't have it, download the "LTS" installer from [nodejs.org](https://nodejs.org/) and run it — the default options are fine.
- **A QuickNode Solana mainnet endpoint.** This is a private, reliable connection to the Solana blockchain that the scanner uses to check dev wallets and token holders. Sign up at [quicknode.com](https://www.quicknode.com/), create a new endpoint for the **Solana** chain, **mainnet** network, and copy the HTTP URL it gives you. QuickNode has a free tier that is enough to run this scanner.
- **A Telegram account.** This is where your alerts will show up. If you don't already use Telegram, install it from your phone's app store or from [telegram.org](https://telegram.org/) and create an account — it takes about a minute.

## 3. Setup

Do these steps once, in order, from a PowerShell window opened inside the `Trenches` folder (right-click the folder while holding Shift and choose "Open PowerShell window here", or open PowerShell and `cd` into it).

**Step 1 — Install the scanner's dependencies.**

```powershell
npm install
```

This downloads the handful of small libraries the scanner depends on. It only needs to be run once (or again later if you ever pull down updated code).

**Step 2 — Create your Telegram bot.**

Alerts are delivered by a small "bot" account that you own and control — nobody else can see or use it.

1. Open Telegram and start a chat with **@BotFather** (Telegram's official bot for creating bots — search for it in the Telegram search bar).
2. Send the message `/newbot` and follow the prompts: give it any name and a unique username ending in `bot` (for example `mytrenchesalerts_bot`).
3. BotFather will reply with a **token** that looks like `123456:ABC-your-bot-token`. Copy it somewhere safe — this is what lets your scanner send messages through your bot.

**Step 3 — Get your chat ID.**

Your chat ID tells the scanner which Telegram chat to send alerts to (yours).

1. In Telegram, search for the bot you just created (by the username you gave it) and send it any message, e.g. "hello". This is required — Telegram won't tell the bot your chat ID until you've messaged it at least once.
2. In your web browser, go to the following address, replacing `<TOKEN>` with the token from Step 2:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. You'll see a block of text (JSON). Look for `"message"` and inside it `"chat"`, then `"id"` — a number, for example `123456789`. That number is your chat ID.

**Step 4 — Fill in your configuration file.**

```powershell
copy .env.example .env
```

Now open the new `.env` file in Notepad (or any text editor) and replace the three placeholder values with your own:

```
QUICKNODE_RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-key/
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
TELEGRAM_CHAT_ID=123456789
```

- `QUICKNODE_RPC_URL` — the endpoint URL from the Requirements step.
- `TELEGRAM_BOT_TOKEN` — the token from Step 2 above.
- `TELEGRAM_CHAT_ID` — the chat ID from Step 3 above.

Save the file. Nobody else should ever see this file — it contains the keys to your bot and your blockchain endpoint, so don't share it or upload it anywhere.

## 4. Running

**First, do a dry run.** This runs the full scanner exactly as it would run live, but instead of sending Telegram messages, it prints every alert straight to your terminal window. It's the safest way to see what the scanner would have sent you, and to tune `config.json` (see the Tuning section below) before you start getting real notifications.

```powershell
npm run dry
```

**Once you're happy with the results, run it live** so alerts go to your Telegram:

```powershell
npm start
```

Either way, the scanner keeps running continuously in that terminal window, watching new launches as they happen — leave the window open in the background. To stop it at any time, click into the terminal window and press `Ctrl+C`.

## 5. Tuning

All of the scanner's tunable behavior lives in `config.json` in the project folder. You can open it in Notepad, change a number, save, and restart the scanner (`Ctrl+C` then run the command again) to apply it. The fields you're most likely to want to adjust:

| Field | What it controls | Effect of changing it |
| --- | --- | --- |
| `watch.triggerMarketCapUsd` | The market cap (in USD) a token must reach during the 90-minute watch window before it's promoted to the deep-check stage. | Lower = catches tokens earlier (more alerts, more noise). Higher = only well-established tokens get checked (fewer, later alerts). |
| `watch.triggerUniqueBuyers` | The number of distinct wallets that must have bought the token during the watch window before it's promoted to the deep-check stage. | Lower = earlier but noisier alerts. Higher = requires broader real interest before checking further. |
| `alertScoreThreshold` | The minimum score (out of 100) a token needs after the deep check to trigger a Telegram alert. | Lower = more alerts, including weaker/riskier tokens. Higher = fewer, higher-confidence alerts. |
| `watch.windowMinutes` | How long (in minutes) the scanner watches a new token for trading traction before giving up on it. | Lower = faster decisions but may miss slow-building tokens. Higher = catches slower risers but ties up more of the watch list. |
| `stage1.maxDevBuyPct` | The maximum percentage of a token's supply the developer's own wallet is allowed to buy at launch before the token is rejected outright. | Lower = stricter, rejects more tokens upfront (fewer alerts overall, less dev-dump risk). Higher = more lenient, lets through tokens with bigger dev buys. |

## 6. How scoring works

Every token that survives the deep-check stage starts at a base score of **50** and is adjusted like this:

**Bonuses (score goes up):**
- **+20** — the developer has a prior Pump.fun token that successfully graduated (reached a real DEX listing).
- **+10** — the top 10 wallet holders together hold 30% or less of the supply (a healthy, spread-out distribution).
- **+10** — the project's website is live and reachable.
- **+10** — the developer's wallet still holds its tokens (hasn't sold/dumped).

**Penalties (score goes down):**
- **−15** — the developer has prior token launches, but none of them graduated.
- **−10 per link** — for each dead/unreachable social link (X/Twitter, Telegram, or website).
- **−15** — no X (Twitter) account could be found for the project at all.

**Hard rejects — the token is thrown out immediately, regardless of score:**
- The developer is a serial launcher (more than 3 prior token launches) with none having ever graduated.
- The developer's funding wallet is linked to a known rug/scam wallet.
- The top 10 wallet holders together hold more than 45% of the supply.

The final score is capped between 0 and 100. A Telegram alert is only sent when a token has **zero hard rejects** and a score of **60 or higher**.

## 7. Disclaimer

Memecoin trading on Pump.fun is extremely high risk. The overwhelming majority of tokens launched there lose most or all of their value, and many are outright scams or rug pulls. Trenches Scanner filters out some of the most obvious red flags — serial ruggers, suspicious dev wallets, dead social links, concentrated holders — but it **cannot** guarantee that any token it alerts on is safe, legitimate, or profitable. It cannot see the future, and it cannot detect every scam.

Nothing this tool sends you is financial advice. Every alert is a starting point for your own research, not a signal to buy. Only ever risk money you can afford to lose completely, and always do your own due diligence before acting on any alert.
