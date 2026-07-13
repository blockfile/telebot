import 'dotenv/config';
import { readFileSync } from 'node:fs';

export interface Stage1Config {
  requireTelegramOrWebsite: boolean;
  maxDevBuyPct: number;
  maxCreatorLaunches48h: number;
  tickerCloneWindowHours: number;
}

export interface WatchConfig {
  windowMinutes: number;
  maxConcurrent: number;
  triggerMarketCapUsd: number;
  triggerVolumeUsd: number;
  triggerUniqueBuyers: number;
  bundleWindowMs: number;
  bundleMaxBuyers: number;
}

export interface DeepConfig {
  maxLifetimeLaunches: number;
  priorLaunchPenalty: number;
  graduatedBonus: number;
  top10HardRejectPct: number;
  top10BonusPct: number;
  top10Bonus: number;
  deadLinkPenalty: number;
  liveWebsiteBonus: number;
  xMissingPenalty: number;
  devHoldsBonus: number;
}

export interface LaunchConfig {
  bundleHardRejectPct: number;
  bundleHeldHardRejectPct: number;
  bundlePenaltyPct: number;
  bundlePenalty: number;
  devOutflowHardRejectPct: number;
  devOutflowPenaltyPct: number;
  devOutflowPenalty: number;
  first20FlagPct: number;
  maxEarlyTxFetch: number;
  sniperSlots: number;
}

export interface FollowUpConfig {
  windowMinutes: number;
  dumpAlertPct: number;
  milestones: number[];
  liveEditSec: number; // live-edit the alert card every N seconds during the window; 0 = off
}

export interface RevivalConfig {
  lookbackDays: number;
  sweepMinutes: number;
  jumpMult: number;
  minMcUsd: number;
  maxCandidates: number;
}

export interface BuyButton {
  label: string;
  url: string; // may contain {CA}, replaced with the token mint
}

export interface ButtonsConfig {
  buy: BuyButton[];
  chart: boolean;
  scan: boolean;
  pumpfun: boolean;
}

/** GMGN enrichment (security + smart-money/KOL signals on the alert card). Off by default —
 * enabling it requires both this flag AND a GMGN_API_KEY in .env (see README).
 * `rejectBad` (also default off) upgrades GMGN from a bounded score nudge to an aggressive mode
 * that hard-rejects GMGN-confirmed honeypots / wash-trading and boosts smart-money harder. */
export interface GmgnConfig {
  enabled: boolean;
  rejectBad: boolean;
}

/** Post-graduation monitor: watches a mint via GMGN after a pump.fun migration (PumpPortal goes
 * blind at graduation) and alerts once it looks healthy. Off by default — enabling it requires
 * both `enabled: true` here AND a GMGN_API_KEY in .env. Max-coverage by design: every healthy
 * graduation alerts, the user triages (see .gmgn-gradwatch-brief.md). */
export interface GraduationMonitorConfig {
  enabled: boolean;
  pollSeconds: number;
  watchMinutes: number;
  minVolume1hUsd: number;
  minLiquidityUsd: number;
  minHolders: number;
  maxChecksPerSweep: number;
}

export interface AppConfig {
  stage1: Stage1Config;
  watch: WatchConfig;
  deep: DeepConfig;
  launch: LaunchConfig;
  followUp: FollowUpConfig;
  revival: RevivalConfig;
  buttons: ButtonsConfig;
  gmgn: GmgnConfig;
  graduationMonitor: GraduationMonitorConfig;
  alertScoreThreshold: number;
  solPriceFallbackUsd: number;
  summaryHourLocal: number;
}

export interface Secrets {
  quicknodeRpcUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  pumpportalApiKey: string;
  gmgnApiKey: string;
}

export function loadConfig(path = 'config.json'): AppConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;
  const required: Array<[string, unknown]> = [
    ['stage1.maxDevBuyPct', cfg.stage1?.maxDevBuyPct],
    ['stage1.maxCreatorLaunches48h', cfg.stage1?.maxCreatorLaunches48h],
    ['stage1.tickerCloneWindowHours', cfg.stage1?.tickerCloneWindowHours],
    ['watch.windowMinutes', cfg.watch?.windowMinutes],
    ['watch.maxConcurrent', cfg.watch?.maxConcurrent],
    ['watch.triggerMarketCapUsd', cfg.watch?.triggerMarketCapUsd],
    ['watch.triggerVolumeUsd', cfg.watch?.triggerVolumeUsd],
    ['watch.triggerUniqueBuyers', cfg.watch?.triggerUniqueBuyers],
    ['watch.bundleWindowMs', cfg.watch?.bundleWindowMs],
    ['watch.bundleMaxBuyers', cfg.watch?.bundleMaxBuyers],
    ['deep.maxLifetimeLaunches', cfg.deep?.maxLifetimeLaunches],
    ['deep.priorLaunchPenalty', cfg.deep?.priorLaunchPenalty],
    ['deep.graduatedBonus', cfg.deep?.graduatedBonus],
    ['deep.top10HardRejectPct', cfg.deep?.top10HardRejectPct],
    ['deep.top10BonusPct', cfg.deep?.top10BonusPct],
    ['deep.top10Bonus', cfg.deep?.top10Bonus],
    ['deep.deadLinkPenalty', cfg.deep?.deadLinkPenalty],
    ['deep.liveWebsiteBonus', cfg.deep?.liveWebsiteBonus],
    ['deep.xMissingPenalty', cfg.deep?.xMissingPenalty],
    ['deep.devHoldsBonus', cfg.deep?.devHoldsBonus],
    ['launch.bundleHardRejectPct', cfg.launch?.bundleHardRejectPct],
    ['launch.bundleHeldHardRejectPct', cfg.launch?.bundleHeldHardRejectPct],
    ['launch.bundlePenaltyPct', cfg.launch?.bundlePenaltyPct],
    ['launch.bundlePenalty', cfg.launch?.bundlePenalty],
    ['launch.devOutflowHardRejectPct', cfg.launch?.devOutflowHardRejectPct],
    ['launch.devOutflowPenaltyPct', cfg.launch?.devOutflowPenaltyPct],
    ['launch.devOutflowPenalty', cfg.launch?.devOutflowPenalty],
    ['launch.first20FlagPct', cfg.launch?.first20FlagPct],
    ['launch.maxEarlyTxFetch', cfg.launch?.maxEarlyTxFetch],
    ['launch.sniperSlots', cfg.launch?.sniperSlots],
    ['followUp.windowMinutes', cfg.followUp?.windowMinutes],
    ['followUp.dumpAlertPct', cfg.followUp?.dumpAlertPct],
    ['followUp.liveEditSec', cfg.followUp?.liveEditSec],
    ['revival.lookbackDays', cfg.revival?.lookbackDays],
    ['revival.sweepMinutes', cfg.revival?.sweepMinutes],
    ['revival.jumpMult', cfg.revival?.jumpMult],
    ['revival.minMcUsd', cfg.revival?.minMcUsd],
    ['revival.maxCandidates', cfg.revival?.maxCandidates],
    ['graduationMonitor.pollSeconds', cfg.graduationMonitor?.pollSeconds],
    ['graduationMonitor.watchMinutes', cfg.graduationMonitor?.watchMinutes],
    ['graduationMonitor.minVolume1hUsd', cfg.graduationMonitor?.minVolume1hUsd],
    ['graduationMonitor.minLiquidityUsd', cfg.graduationMonitor?.minLiquidityUsd],
    ['graduationMonitor.minHolders', cfg.graduationMonitor?.minHolders],
    ['graduationMonitor.maxChecksPerSweep', cfg.graduationMonitor?.maxChecksPerSweep],
    ['alertScoreThreshold', cfg.alertScoreThreshold],
    ['solPriceFallbackUsd', cfg.solPriceFallbackUsd],
    ['summaryHourLocal', cfg.summaryHourLocal],
  ];
  for (const [name, v] of required) {
    if (typeof v !== 'number') throw new Error(`config.json missing numeric field: ${name}`);
  }
  if (typeof cfg.stage1?.requireTelegramOrWebsite !== 'boolean') {
    throw new Error('config.json missing boolean field: stage1.requireTelegramOrWebsite');
  }
  if (!Array.isArray(cfg.followUp?.milestones) || cfg.followUp.milestones.length === 0
      || cfg.followUp.milestones.some((m) => typeof m !== 'number')) {
    throw new Error('config.json missing number array: followUp.milestones');
  }
  if (!cfg.buttons || !Array.isArray(cfg.buttons.buy)
      || typeof cfg.buttons.chart !== 'boolean'
      || typeof cfg.buttons.scan !== 'boolean'
      || typeof cfg.buttons.pumpfun !== 'boolean') {
    throw new Error('config.json missing buttons config (buy[], chart, scan, pumpfun)');
  }
  if (typeof cfg.gmgn?.enabled !== 'boolean') {
    throw new Error('config.json missing boolean field: gmgn.enabled');
  }
  if (typeof cfg.gmgn?.rejectBad !== 'boolean') {
    throw new Error('config.json missing boolean field: gmgn.rejectBad');
  }
  if (typeof cfg.graduationMonitor?.enabled !== 'boolean') {
    throw new Error('config.json missing boolean field: graduationMonitor.enabled');
  }
  return cfg;
}

export function loadSecrets(env: Record<string, string | undefined> = process.env): Secrets {
  const missing: string[] = [];
  const get = (k: string): string => {
    const v = env[k];
    if (!v) missing.push(k);
    return v ?? '';
  };
  const secrets = {
    quicknodeRpcUrl: get('QUICKNODE_RPC_URL'),
    telegramBotToken: get('TELEGRAM_BOT_TOKEN'),
    telegramChatId: get('TELEGRAM_CHAT_ID'),
    pumpportalApiKey: env['PUMPPORTAL_API_KEY'] ?? '', // optional: unlocks real-time trade streams
    gmgnApiKey: env['GMGN_API_KEY'] ?? '', // optional: only used when config.json gmgn.enabled is true
  };
  if (missing.length) {
    throw new Error(`Missing required values in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
  return secrets;
}
