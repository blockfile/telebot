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
import { fetchTop10Pct } from './checks/holders';
import { analyzeLaunch } from './checks/launchAnalysis';
import { FollowUps } from './pipeline/followups';
import { Telegram, formatAlert, formatFollowUp, buildButtons, type FollowUpData, type Keyboard } from './telegram';
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

async function send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<boolean> {
  const p = typeof payload === 'string' ? { text: payload } : payload;
  if (DRY) {
    log('info', `[DRY ALERT]${p.photoUrl ? ' [photo]' : ''}${p.buttons?.length ? ' [buttons]' : ''}\n${p.text}`);
    return true;
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
    let data: FollowUpData;
    if (event.kind === 'up') {
      // Show the level for THIS milestone (fromUsd × multiple), not the shared live peak —
      // otherwise a single trade that jumps through several milestones prints identical $ on each card.
      data = {
        kind: 'up', symbol: fu.symbol, mint: fu.mint, multiple: event.multiple,
        fromUsd: fu.alertMcSol * solPrice.usd, peakUsd: fu.alertMcSol * event.multiple * solPrice.usd,
      };
    } else {
      const nowPct = fu.alertMcSol > 0 ? ((fu.lastMcSol - fu.alertMcSol) / fu.alertMcSol) * 100 : 0;
      const peakPct = fu.alertMcSol > 0 ? ((fu.peakMcSol - fu.alertMcSol) / fu.alertMcSol) * 100 : 0;
      data = {
        kind: event.kind, symbol: fu.symbol, mint: fu.mint,
        peakUsd: fu.peakMcSol * solPrice.usd, nowUsd: fu.lastMcSol * solPrice.usd, peakPct, nowPct,
      };
    }
    const photoUrl = fu.image ? ipfsToHttp(fu.image) : undefined;
    const buttons = buildButtons(fu.mint, cfg.buttons, { web: ['chart', 'pumpfun'] });
    void send({ text: formatFollowUp(data), photoUrl, buttons })
      .then((ok) => { if (!ok) log('error', `follow-up send failed for ${fu.mint}`); });
    log('info', `follow-up (${event.kind}${event.kind === 'up' ? ` ${event.multiple}X` : ''}) $${fu.symbol}`);
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
        analyzeLaunch(rpc, mint, bondingCurveKey, creator, creationSignature, cfg.launch.maxEarlyTxFetch),
    });

    if (results.devHistory === 'unknown' || results.top10Pct === 'unknown') {
      db.setOutcome(t.event.mint, 'rejected_deep');
      log('warn', `deep checks incomplete for $${t.event.symbol} (${t.event.mint}) — no alert on partial data`);
      return;
    }

    const { score, hardRejects, flags } = scoreToken(results, cfg.deep, cfg.launch);
    if (hardRejects.length || score < cfg.alertScoreThreshold) {
      db.setOutcome(t.event.mint, 'rejected_deep');
      log('info', `rejected $${t.event.symbol}: score ${score}${hardRejects.length ? `, hard: ${hardRejects.join('; ')}` : ''}`);
      return;
    }

    const caption = formatAlert({
      mint: t.event.mint, name: t.event.name, symbol: t.event.symbol, score, flags,
      marketCapUsd: t.lastMarketCapSol * solPrice.usd,
      volumeUsd: t.volumeSol * solPrice.usd,
      ageMinutes: Math.round((Date.now() - t.addedAt) / 60_000),
      uniqueBuyers: t.buyers.size,
      devBuyPct: (t.event.devBuyTokens / TOTAL_SUPPLY) * 100,
      devStillHolds: !t.devSold,
      priorLaunches: results.devHistory.priorLaunches,
      top10Pct: results.top10Pct,
      bundlePct: results.bundlePct,
      first20Pct: results.first20Pct,
      devOutflowPct: results.devOutflowPct,
      twitter: t.meta.twitter, telegram: t.meta.telegram, website: t.meta.website,
    });
    const photoUrl = t.meta.image ? ipfsToHttp(t.meta.image) : undefined;
    const buttons = buildButtons(t.event.mint, cfg.buttons);

    if (await send({ text: caption, photoUrl, buttons })) {
      db.recordAlert(t.event.mint, score, DRY, caption, Date.now());
      db.setOutcome(t.event.mint, 'alerted');
      followUps.add(t.event.mint, t.event.symbol, t.lastMarketCapSol, Date.now(), t.meta.image);
      log('info', `ALERT sent: $${t.event.symbol} score ${score}`);
    } else {
      log('error', `telegram send failed for ${t.event.mint}; payload:\n${caption}`);
    }
  } catch (err) {
    log('error', `handleTrigger ${t.event.mint}: ${(err as Error).message}`);
    db.setOutcome(t.event.mint, 'rejected_deep');
  }
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
});
stream.on('status', (s: string) => log('info', `stream: ${s}`));
stream.connect();

setInterval(() => {
  const now = Date.now();
  watchlist.sweep(now);
  followUps.sweep(now);
}, 60_000);

let lastSummaryDay = -1;
setInterval(() => {
  void maybeSendSummary(db, send, cfg.summaryHourLocal, new Date(), lastSummaryDay)
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

if (!secrets.pumpportalApiKey) {
  log('warn', 'PUMPPORTAL_API_KEY is not set — PumpPortal rejects trade streams without a funded API key, so market cap/buyers/dev sells cannot be tracked and NO ALERTS will ever fire. See README "PumpPortal API key".');
}
log('info', `Trenches Scanner started${DRY ? ' (DRY RUN — alerts print to console)' : ''} — watching pump.fun`);
