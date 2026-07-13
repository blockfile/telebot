import { loadConfig, loadSecrets } from './config';
import { Db } from './db/index';
import { PumpPortalStream } from './stream/pumpportal';
import { SolPrice } from './solPrice';
import { Rpc } from './rpc';
import { Watchlist, type WatchedToken } from './pipeline/watchlist';
import { stage1Filter } from './pipeline/stage1';
import { runDeepChecks } from './pipeline/stage3';
import { scoreToken } from './pipeline/scoring';
import { fetchMeta, ipfsToHttp } from './checks/metadata';
import { normalizeTwitterHandle } from './checks/socials';
import { checkUrlAlive, checkXExists } from './checks/liveness';
import { fetchDevHistory } from './checks/devHistory';
import { fetchTop10Pct, fetchHolderCount } from './checks/holders';
import { analyzeLaunch } from './checks/launchAnalysis';
import { GmgnClient } from './checks/gmgn';
import { FollowUps } from './pipeline/followups';
import { RevivalWatcher } from './pipeline/revivals';
import {
  Telegram, formatAlert, formatFollowUp, buildButtons,
  type AlertData, type FollowUpData, type Keyboard, type SendResult,
} from './telegram';
import { maybeSendSummary } from './summary';
import { log } from './logger';
import { TOTAL_SUPPLY, type NewTokenEvent, type TradeEvent, type MigrationEvent } from './types';

const DRY = process.argv.includes('--dry');

const cfg = loadConfig();
const secrets = loadSecrets();
const db = new Db('data/scanner.db');
const rpc = new Rpc(secrets.quicknodeRpcUrl);
const telegram = new Telegram(secrets.telegramBotToken, secrets.telegramChatId);
const solPrice = new SolPrice(cfg.solPriceFallbackUsd);
const stream = new PumpPortalStream(secrets.pumpportalApiKey);
// Off by default (config.json gmgn.enabled). When off, gmgnClient stays null and the deep-check
// dep below resolves to 'unknown' with zero network calls — the pipeline behaves exactly as
// before this feature existed.
const gmgnClient = cfg.gmgn.enabled ? new GmgnClient(secrets.gmgnApiKey) : null;
if (cfg.gmgn.enabled && !secrets.gmgnApiKey) {
  log('warn', 'gmgn.enabled is true but GMGN_API_KEY is not set in .env — GMGN enrichment will fail every call and degrade to unknown on every card.');
}

async function send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<SendResult> {
  const p = typeof payload === 'string' ? { text: payload } : payload;
  if (DRY) {
    log('info', `[DRY ALERT]${p.photoUrl ? ' [photo]' : ''}${p.buttons?.length ? ' [buttons]' : ''}\n${p.text}`);
    return { ok: true }; // no messageId in dry mode -> live edits are naturally skipped
  }
  return telegram.send(p);
}

const watchlist = new Watchlist(cfg.watch, {
  subscribe: (m) => stream.subscribeTrades(m),
  unsubscribe: (m) => stream.unsubscribeTrades(m),
  onExpire: (t) => {
    db.setOutcome(t.event.mint, 'expired');
    // Diagnostic: for tokens that showed some life, log how close they got to the trigger gate.
    // volume and buyers are cumulative (accurate at expiry); MC is the last seen value.
    if (t.buyers.size >= 3) {
      const mc = (t.lastMarketCapSol * solPrice.usd) / 1000;
      const vol = (t.volumeSol * solPrice.usd) / 1000;
      const w = cfg.watch;
      log('info', `expired $${t.event.symbol}: MC ~$${mc.toFixed(1)}k · vol $${vol.toFixed(1)}k · ${t.buyers.size} buyers `
        + `(need $${w.triggerMarketCapUsd / 1000}k / $${w.triggerVolumeUsd / 1000}k / ${w.triggerUniqueBuyers})`);
    }
  },
  onDisqualify: (t, reason) => {
    db.setOutcome(t.event.mint, 'disqualified');
    if (reason === 'dev sold') db.bumpDev(t.event.creator, 'rugged', Date.now());
    log('info', `disqualified $${t.event.symbol} (${t.event.mint}): ${reason}`);
  },
  onTrigger: (t) => void handleTrigger(t),
});

const followUps = new FollowUps(cfg.followUp, {
  subscribe: (m) => stream.subscribeTrades(m),
  unsubscribe: (m) => stream.unsubscribeTrades(m),
  fire: (fu, event) => {
    void (async () => {
      // Re-measure top-10 concentration so every follow-up shows whether whales are distributing.
      const top10Now = fu.bondingCurveKey ? await fetchTop10Pct(rpc, fu.mint, fu.bondingCurveKey) : 'unknown';
      const trend = { top10From: fu.top10AtAlert, top10Now };
      let data: FollowUpData;
      if (event.kind === 'up') {
        // Show the level for THIS milestone (fromUsd × multiple), not the shared live peak —
        // otherwise a single trade that jumps through several milestones prints identical $ on each card.
        data = {
          kind: 'up', symbol: fu.symbol, mint: fu.mint, multiple: event.multiple,
          fromUsd: fu.alertMcSol * solPrice.usd, peakUsd: fu.alertMcSol * event.multiple * solPrice.usd,
          ...trend,
        };
      } else {
        const nowPct = fu.alertMcSol > 0 ? ((fu.lastMcSol - fu.alertMcSol) / fu.alertMcSol) * 100 : 0;
        const peakPct = fu.alertMcSol > 0 ? ((fu.peakMcSol - fu.alertMcSol) / fu.alertMcSol) * 100 : 0;
        data = {
          kind: event.kind, symbol: fu.symbol, mint: fu.mint,
          peakUsd: fu.peakMcSol * solPrice.usd, nowUsd: fu.lastMcSol * solPrice.usd, peakPct, nowPct,
          ...trend,
        };
      }
      const photoUrl = fu.image ? ipfsToHttp(fu.image) : undefined;
      const buttons = buildButtons(fu.mint, cfg.buttons, { web: ['chart', 'pumpfun'] });
      const r = await send({ text: formatFollowUp(data), photoUrl, buttons });
      if (!r.ok) log('error', `follow-up send failed for ${fu.mint}`);
    })().catch((err) => log('error', `follow-up fire ${fu.mint}: ${(err as Error).message}`));
    log('info', `follow-up (${event.kind}${event.kind === 'up' ? ` ${event.multiple}X` : ''}) $${fu.symbol}`);
  },
});

// Graveyard sweep: expired stage1-passed tokens whose bonding-curve MC jumps off its floor
// re-enter the normal watchlist and must pass all the usual gates to alert.
const revivals = new RevivalWatcher(cfg.revival, {
  candidates: () => db.revivalCandidates(Date.now() - cfg.revival.lookbackDays * 86_400_000, cfg.revival.maxCandidates),
  fetchAccounts: async (keys) => {
    const res = await rpc.call<{ value: Array<{ data?: [string, string] } | null> }>(
      'getMultipleAccounts', [keys, { encoding: 'base64' }],
    );
    return (res.value ?? []).map((v) => v?.data?.[0] ?? null);
  },
  solUsd: () => solPrice.usd,
  wake: (r, mcSol, vSolSol) => {
    const event: NewTokenEvent = {
      mint: r.mint, name: r.name, symbol: r.symbol, uri: '', creator: r.creator,
      devBuyTokens: r.devBuyTokens, devBuySol: 0, bondingCurveKey: r.bondingCurve,
      marketCapSol: mcSol, vSolInBondingCurve: vSolSol, signature: r.creationSig,
      receivedAt: r.createdAt, // true creation time — alerts show real token age
    };
    // addedAt just past the bundle window: same-slot bundle detection is meaningless for a
    // revival (launch was hours ago), and this keeps a hot re-entry from tripping it.
    watchlist.add(event, { twitter: r.twitter, telegram: r.telegram, website: r.website, image: r.image },
      Date.now() - cfg.watch.bundleWindowMs - 1);
    db.setOutcome(r.mint, 'watching');
    const ageH = ((Date.now() - r.createdAt) / 3_600_000).toFixed(1);
    log('info', `revival: $${r.symbol} (${r.mint}) woke up at ~$${((mcSol * solPrice.usd) / 1000).toFixed(1)}k MC, age ${ageH}h — re-watching`);
  },
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
      bondingCurve: event.bondingCurveKey || undefined, // never store '' — it would poison a curve-poll batch
      creationSig: event.signature || undefined,
      devBuyTokens: event.devBuyTokens, image: m.image,
    });
    db.bumpDev(event.creator, 'launches', event.receivedAt);
    if (handle) db.recordHandle(handle, event.mint, event.receivedAt);

    if (result.pass && meta !== 'unknown') {
      watchlist.add(event, meta, event.receivedAt);
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
    const deepStart = Date.now();

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
      analyzeLaunch: (mint, bondingCurveKey, creator, creationSignature) =>
        analyzeLaunch(rpc, mint, bondingCurveKey, creator, creationSignature, cfg.launch.maxEarlyTxFetch, cfg.launch.sniperSlots),
      fetchHolderCount: (mint, curve) => fetchHolderCount(rpc, mint, curve),
      fetchGmgn: (mint) => (gmgnClient ? gmgnClient.enrich(mint) : Promise.resolve('unknown')),
    });
    log('info', `deep checks for $${t.event.symbol} took ${Date.now() - deepStart}ms`);

    if (results.devHistory === 'unknown' || results.top10Pct === 'unknown') {
      db.setOutcome(t.event.mint, 'rejected_deep');
      log('warn', `deep checks incomplete for $${t.event.symbol} (${t.event.mint}) — no alert on partial data`);
      return;
    }

    const { score, hardRejects, flags } = scoreToken(results, cfg.deep, cfg.launch, cfg.gmgn);
    if (hardRejects.length || score < cfg.alertScoreThreshold) {
      db.setOutcome(t.event.mint, 'rejected_deep');
      log('info', `rejected $${t.event.symbol}: score ${score}${hardRejects.length ? `, hard: ${hardRejects.join('; ')}` : ''}`);
      return;
    }

    const alertData: AlertData = {
      mint: t.event.mint, name: t.event.name, symbol: t.event.symbol, score, flags,
      marketCapUsd: t.lastMarketCapSol * solPrice.usd,
      topMarketCapUsd: t.peakMarketCapSol * solPrice.usd,
      volumeUsd: t.volumeSol * solPrice.usd,
      liquidityUsd: t.lastVSolInCurve * solPrice.usd,
      // true token age (from mint), not time-on-watchlist — matters for revived tokens
      ageMinutes: Math.round((Date.now() - t.event.receivedAt) / 60_000),
      uniqueBuyers: t.buyers.size,
      holderCount: results.holderCount,
      feesSol: t.volumeSol * 0.01, // pump.fun takes ~1% of traded volume
      devBuyPct: (t.event.devBuyTokens / TOTAL_SUPPLY) * 100,
      devStillHolds: !t.devSold,
      priorLaunches: results.devHistory.priorLaunches,
      top10Pct: results.top10Pct,
      bundlePct: results.bundlePct,
      bundleCount: results.bundleCount,
      bundleHeldPct: results.bundleHeldPct,
      sniperCount: results.sniperCount,
      sniperPct: results.sniperPct,
      sniperHeldPct: results.sniperHeldPct,
      first20Pct: results.first20Pct,
      devOutflowPct: results.devOutflowPct,
      twitter: t.meta.twitter, telegram: t.meta.telegram, website: t.meta.website,
      gmgn: results.gmgn === 'unknown' ? undefined : results.gmgn,
    };
    const caption = formatAlert(alertData);
    const photoUrl = t.meta.image ? ipfsToHttp(t.meta.image) : undefined;
    const buttons = buildButtons(t.event.mint, cfg.buttons);

    const sent = await send({ text: caption, photoUrl, buttons });
    if (sent.ok) {
      db.recordAlert(t.event.mint, score, DRY, caption, Date.now());
      db.setOutcome(t.event.mint, 'alerted');
      followUps.add(
        t.event.mint, t.event.symbol, t.lastMarketCapSol, Date.now(),
        t.meta.image, t.event.bondingCurveKey, results.top10Pct,
      );
      if (sent.messageId !== undefined && cfg.followUp.liveEditSec > 0) {
        liveCards.set(t.event.mint, {
          messageId: sent.messageId, photo: sent.photo === true,
          data: alertData, buttons, alertMcSol: t.lastMarketCapSol, startedAt: Date.now(), failCount: 0,
        });
      }
      log('info', `ALERT sent: $${t.event.symbol} score ${score}`);
    } else {
      log('error', `telegram send failed for ${t.event.mint}; payload:\n${caption}`);
    }
  } catch (err) {
    log('error', `handleTrigger ${t.event.mint}: ${(err as Error).message}`);
    db.setOutcome(t.event.mint, 'rejected_deep');
  }
}

// --- Live cards: the alert message edits itself with the current MC/multiple while the
// --- follow-up tracker still has fresh trade data for the token.
interface LiveCard {
  messageId: number;
  photo: boolean;
  data: AlertData;
  buttons: Keyboard;
  alertMcSol: number;
  startedAt: number;
  failCount: number;
}
const liveCards = new Map<string, LiveCard>();

async function tickLiveCards(): Promise<void> {
  for (const [mint, card] of [...liveCards]) {
    const fu = followUps.get(mint);
    const expired = Date.now() - card.startedAt > cfg.followUp.windowMinutes * 60_000;
    if (!fu || expired) {
      // Tracking ended (dump/window). Freeze the card honestly: one final edit that drops the
      // stale "Now" line, so a dumped token doesn't keep displaying its peak forever.
      liveCards.delete(mint);
      void telegram.editCaption(card.messageId, formatAlert(card.data), card.buttons, card.photo);
      continue;
    }
    const nowUsd = fu.lastMcSol * solPrice.usd;
    const multiple = card.alertMcSol > 0 ? fu.lastMcSol / card.alertMcSol : 0;
    const caption = formatAlert({ ...card.data, live: { nowUsd, multiple } });
    const ok = await telegram.editCaption(card.messageId, caption, card.buttons, card.photo);
    if (ok) {
      card.failCount = 0;
    } else if (++card.failCount >= 3) {
      // Transient blips (a 429, one timeout) are retried by the next tick; only give up
      // after repeated consecutive failures (e.g. the message was deleted).
      log('warn', `live edit failed ${card.failCount}x for ${mint} — stopping live updates for this card`);
      liveCards.delete(mint);
    }
  }
}

if (cfg.followUp.liveEditSec > 0 && !DRY) {
  let ticking = false; // re-entrancy guard: a slow tick must not overlap the next one
  const t = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tickLiveCards().finally(() => { ticking = false; });
  }, cfg.followUp.liveEditSec * 1000);
  t.unref();
}

solPrice.start();
stream.on('new', (e: NewTokenEvent) => void handleNew(e));
stream.on('trade', (tr: TradeEvent) => {
  watchlist.onTrade(tr, solPrice.usd, Date.now());
  followUps.onTrade(tr, Date.now());
});
stream.on('migration', (m: MigrationEvent) => {
  const creator = db.getTokenCreator(m.mint);
  if (creator) {
    db.bumpDev(creator, 'graduated', Date.now());
    log('info', `graduated: ${m.mint} (dev ${creator})`);
  }
  // After migration the supply moves to the AMM pool vault, which fetchTop10Pct would
  // wrongly count as a whale. Blank the curve key so later follow-ups skip the re-measure.
  const fu = followUps.get(m.mint);
  if (fu) fu.bondingCurveKey = '';
});
stream.on('status', (s: string) => log('info', `stream: ${s}`));
stream.connect();

setInterval(() => {
  const now = Date.now();
  watchlist.sweep(now);
  followUps.sweep(now);
}, 60_000);

{
  let sweeping = false; // a slow RPC sweep must not overlap the next one
  const t = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void revivals.sweep().finally(() => { sweeping = false; });
  }, cfg.revival.sweepMinutes * 60_000);
  t.unref();
}

let lastSummaryDay = -1;
setInterval(() => {
  void maybeSendSummary(db, (text) => send(text).then((r) => r.ok), cfg.summaryHourLocal, new Date(), lastSummaryDay)
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

{
  // Tokens stranded mid-watch by the previous shutdown go back to the graveyard.
  const reconciled = db.reconcileInterrupted(Date.now() - cfg.watch.windowMinutes * 60_000);
  if (reconciled > 0) log('info', `reconciled ${reconciled} tokens stranded mid-watch by the last shutdown`);
}

if (!secrets.pumpportalApiKey) {
  log('warn', 'PUMPPORTAL_API_KEY is not set — PumpPortal rejects trade streams without a funded API key, so market cap/buyers/dev sells cannot be tracked and NO ALERTS will ever fire. See README "PumpPortal API key".');
}
log('info', `Trenches Scanner started${DRY ? ' (DRY RUN — alerts print to console)' : ''} — watching pump.fun`);
