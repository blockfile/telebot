# Trenches Scanner

## 1. What it is

Trenches Scanner watches every single new token launch on Pump.fun in real time and quietly does the homework you don't have time to do on hundreds of new coins a day. It runs each launch through three stages of filtering — first a quick check of the mint and dev wallet, then a 90-minute watch for real trading traction, then a deeper background check on the developer's history, wallet, and social links. Anything that survives all three stages gets a score from 0 to 100, and if that score clears your threshold, the scanner sends the contract address straight to your Telegram, ready to paste into your trading tool of choice.

This tool is **alert-only**. It never buys, sells, or holds anything, and it never touches your wallet or your funds. It just watches and taps you on the shoulder when something looks worth a closer look. It is not a guarantee of anything — see the disclaimer at the bottom before you use it.

## 2. Requirements

Before you start, make sure you have:

- **Node.js version 20 or newer.** This is the free program that runs the scanner. If you don't have it, download the "LTS" installer from [nodejs.org](https://nodejs.org/) and run it — the default options are fine.
- **A QuickNode Solana mainnet endpoint.** This is a private, reliable connection to the Solana blockchain that the scanner uses to check dev wallets and token holders. Sign up at [quicknode.com](https://www.quicknode.com/), create a new endpoint for the **Solana** chain, **mainnet** network, and copy the HTTP URL it gives you. QuickNode has a free tier that is enough to run this scanner.
- **A Telegram account.** This is where your alerts will show up. If you don't already use Telegram, install it from your phone's app store or from [telegram.org](https://telegram.org/) and create an account — it takes about a minute.
- **A PumpPortal API key funded with at least 0.02 SOL (about $3-4, one time).** PumpPortal's feed of new token launches is free, but the live *trade* stream — which the scanner needs to measure market cap, count buyers, and catch dev sells — requires an API key whose wallet holds at least 0.02 SOL. Without it, the scanner still sees every launch but **no alert can ever trigger**. Setup is covered in Step 4 below.

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

**Step 4 — Create and fund your PumpPortal API key.**

1. Go to [pumpportal.fun](https://pumpportal.fun/) and create an account/API key (the site generates a wallet tied to the key).
2. Send at least **0.02 SOL** to that wallet's address from any wallet or exchange. This is a balance requirement PumpPortal checks when you connect — the scanner never spends or trades with it.
3. Copy the API key.

**Step 5 — Fill in your configuration file.**

```powershell
copy .env.example .env
```

Now open the new `.env` file in Notepad (or any text editor) and replace the placeholder values with your own:

```
QUICKNODE_RPC_URL=https://your-endpoint.solana-mainnet.quiknode.pro/your-key/
TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
TELEGRAM_CHAT_ID=123456789
PUMPPORTAL_API_KEY=your-pumpportal-api-key
```

- `QUICKNODE_RPC_URL` — the endpoint URL from the Requirements step.
- `TELEGRAM_BOT_TOKEN` — the token from Step 2 above.
- `TELEGRAM_CHAT_ID` — the chat ID from Step 3 above.
- `PUMPPORTAL_API_KEY` — the key from Step 4 above. If it's missing, the scanner will print a warning at startup and no alerts will ever fire.

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

## 4b. Running 24/7 on an Ubuntu server (recommended once you've tuned it)

Running on your own PC means the scanner stops the moment you close the window, sleep the machine, or lose internet. To have it watch the trenches around the clock, put it on a cheap Ubuntu server (any $5–6/month VPS from DigitalOcean, Hetzner, Vultr, etc. is plenty). These steps target **Ubuntu 24.04 LTS** (they also work on 22.04) and assume you log in as a normal user who can use `sudo` (the default on most cloud servers). If you log in as `root`, you can drop the `sudo` from each command.

**Important — run only ONE copy at a time.** Once the server is running, stop the scanner on your PC. Running both at once means duplicate Telegram alerts, and PumpPortal may refuse the second connection using the same API key.

**Step 1 — Connect to your server and get the code.**

From your Windows PC, open PowerShell and connect (replace with your server's address):

```powershell
ssh youruser@your.server.ip.address
```

Then, on the server:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/blockfile/telebot.git
cd telebot
```

**Step 2 — Run the setup script.**

```bash
bash deploy/setup-ubuntu.sh
```

This installs Node.js, the tools it needs, all the scanner's dependencies, and registers a background service that will keep it running 24/7 and restart it automatically (including after a server reboot). It takes a couple of minutes and asks for your `sudo` password once or twice.

**Step 3 — Add your keys.**

```bash
cp .env.example .env
nano .env
```

Fill in the same four values you use on your PC — `QUICKNODE_RPC_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `PUMPPORTAL_API_KEY`. In the `nano` editor, save with `Ctrl+O` then `Enter`, and exit with `Ctrl+X`.

**Step 4 — Start it.**

```bash
sudo systemctl start trenches-scanner
```

That's it — the scanner is now running in the background and will restart on its own if it crashes or the server reboots. You can close your SSH window and it keeps going.

**Watching and controlling it:**

```bash
journalctl -u trenches-scanner -f      # watch the live log (Ctrl+C to stop watching — does NOT stop the scanner)
sudo systemctl status trenches-scanner # is it running? how long has it been up?
sudo systemctl restart trenches-scanner # apply changes after editing .env or config.json
sudo systemctl stop trenches-scanner    # stop it
```

**Updating to the latest code later:**

```bash
cd telebot
git pull
npm install
sudo systemctl restart trenches-scanner
```

## 5. Tuning

All of the scanner's tunable behavior lives in `config.json` in the project folder. You can open it in Notepad, change a number, save, and restart the scanner (`Ctrl+C` then run the command again) to apply it. The fields you're most likely to want to adjust:

| Field | What it controls | Effect of changing it |
| --- | --- | --- |
| `watch.triggerMarketCapUsd` | The market cap (in USD) a token must reach during the 90-minute watch window before it's promoted to the deep-check stage. | Lower = catches tokens earlier (more alerts, more noise). Higher = only well-established tokens get checked (fewer, later alerts). |
| `watch.triggerUniqueBuyers` | The number of distinct wallets that must have bought the token during the watch window before it's promoted to the deep-check stage. | Lower = earlier but noisier alerts. Higher = requires broader real interest before checking further. |
| `alertScoreThreshold` | The minimum score (out of 100) a token needs after the deep check to trigger a Telegram alert. | Lower = more alerts, including weaker/riskier tokens. Higher = fewer, higher-confidence alerts. |
| `watch.windowMinutes` | How long (in minutes) the scanner watches a new token for trading traction before giving up on it. | Lower = faster decisions but may miss slow-building tokens. Higher = catches slower risers but ties up more of the watch list. |
| `stage1.maxDevBuyPct` | The maximum percentage of a token's supply the developer's own wallet is allowed to buy at launch before the token is rejected outright. | Lower = stricter, rejects more tokens upfront (fewer alerts overall, less dev-dump risk). Higher = more lenient, lets through tokens with bigger dev buys. |
| `stage1.requireTelegramOrWebsite` | Whether a token needs a Telegram group or website in addition to its Twitter/X link to pass the first filter. A Twitter/X link is always required either way. | `false` (default) = tokens that launch with only a tweet or X community can still alert — fits the current meta, roughly 2-4x more alerts. `true` = stricter, only "prepared" launches with a Telegram or website get through. |
| `launch.bundleHardRejectPct` | The maximum percentage of supply that can be bundled (bought by insiders in the creation block) before the token is hard-rejected. | Lower = reject tokens with smaller insider bundles, stricter filtering. Higher = accept bundles up to that threshold. |
| `followUp.windowMinutes` | How long (in minutes) after an alert the scanner tracks the token and watches for performance changes before posting a follow-up message. | Lower = faster follow-up notifications. Higher = longer tracking window catches slower movements and gives more time before reporting. |

## 6. How scoring works

Every token that survives the deep-check stage starts at a base score of **50** and is adjusted like this:

**Bonuses (score goes up):**
- **+20** — the developer has a prior Pump.fun token that successfully graduated (reached a real DEX listing).
- **+10** — the top 10 wallet holders together hold 30% or less of the supply (a healthy, spread-out distribution).
- **+10** — the project's website is live and reachable.
- **+10** — the developer's wallet still holds its tokens (hasn't sold/dumped).

**Penalties (score goes down):**
- **−15** — the developer has prior token launches, but none of them graduated.
- **−15** — bundle between 20–50% of supply.
- **−15** — dev moved 10–30% of supply out.
- **−10 per link** — for each dead/unreachable social link (X/Twitter, Telegram, or website).
- **−15** — no X (Twitter) account could be found for the project at all.

**Hard rejects — the token is thrown out immediately, regardless of score:**
- The developer is a serial launcher (more than 3 prior token launches) with none having ever graduated.
- The developer's funding wallet is linked to a known rug/scam wallet.
- The top 10 wallet holders together hold more than 45% of the supply.
- The launch was **bundled** — more than 50% of supply bought by insiders in the creation block.
- The **dev moved more than 30%** of supply out to other wallets (hidden-supply / airdrop).

The final score is capped between 0 and 100. A Telegram alert is only sent when a token has **zero hard rejects** and a score of **60 or higher**.

**Understanding the Launch line in your alerts:** Each alert includes a `Launch:` line showing the token's insider trading activity at creation: bundle % (how much supply was bought in the creation block), first-20 % (cumulative share bought by the first 20 distinct buyers), and dev-out % (how much the developer transferred out in the first few minutes). A `?` in any of these fields means the on-chain read was inconclusive (usually a transient RPC failure), but this never blocks an alert — only the developer history and holder concentration checks have hard-reject power.

## 6b. Follow-up messages

After sending an alert, the scanner continues watching that token for approximately `followUp.windowMinutes` (default: 60 minutes). During this window, you'll receive exactly one follow-up message showing the token's peak market cap and current price since the alert, expressed both as dollar values and as percentage gains/losses. If the token dumps more than `followUp.dumpAlertPct` (default: 50%) from its peak during the window, you'll get an earlier ⚠️ alert instead. These follow-up messages are informational only — they reset if the scanner restarts, and they do not influence the scanner's filtering or future alerts.

## 7. Disclaimer

Memecoin trading on Pump.fun is extremely high risk. The overwhelming majority of tokens launched there lose most or all of their value, and many are outright scams or rug pulls. Trenches Scanner filters out some of the most obvious red flags — serial ruggers, suspicious dev wallets, dead social links, concentrated holders — but it **cannot** guarantee that any token it alerts on is safe, legitimate, or profitable. It cannot see the future, and it cannot detect every scam.

Nothing this tool sends you is financial advice. Every alert is a starting point for your own research, not a signal to buy. Only ever risk money you can afford to lose completely, and always do your own due diligence before acting on any alert.
