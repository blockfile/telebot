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
  bundlePenaltyPct: number;
  bundlePenalty: number;
  devOutflowHardRejectPct: number;
  devOutflowPenaltyPct: number;
  devOutflowPenalty: number;
  first20FlagPct: number;
  maxEarlyTxFetch: number;
}

export interface FollowUpConfig {
  windowMinutes: number;
  dumpAlertPct: number;
}

export interface AppConfig {
  stage1: Stage1Config;
  watch: WatchConfig;
  deep: DeepConfig;
  launch: LaunchConfig;
  followUp: FollowUpConfig;
  alertScoreThreshold: number;
  solPriceFallbackUsd: number;
  summaryHourLocal: number;
}

export interface Secrets {
  quicknodeRpcUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  pumpportalApiKey: string;
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
    ['launch.bundlePenaltyPct', cfg.launch?.bundlePenaltyPct],
    ['launch.bundlePenalty', cfg.launch?.bundlePenalty],
    ['launch.devOutflowHardRejectPct', cfg.launch?.devOutflowHardRejectPct],
    ['launch.devOutflowPenaltyPct', cfg.launch?.devOutflowPenaltyPct],
    ['launch.devOutflowPenalty', cfg.launch?.devOutflowPenalty],
    ['launch.first20FlagPct', cfg.launch?.first20FlagPct],
    ['launch.maxEarlyTxFetch', cfg.launch?.maxEarlyTxFetch],
    ['followUp.windowMinutes', cfg.followUp?.windowMinutes],
    ['followUp.dumpAlertPct', cfg.followUp?.dumpAlertPct],
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
  };
  if (missing.length) {
    throw new Error(`Missing required values in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
  return secrets;
}
