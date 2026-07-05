import 'dotenv/config';
import { readFileSync } from 'node:fs';

export interface Stage1Config {
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

export interface AppConfig {
  stage1: Stage1Config;
  watch: WatchConfig;
  deep: DeepConfig;
  alertScoreThreshold: number;
  solPriceFallbackUsd: number;
  summaryHourLocal: number;
}

export interface Secrets {
  quicknodeRpcUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
}

export function loadConfig(path = 'config.json'): AppConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;
  const required: Array<[string, unknown]> = [
    ['stage1.maxDevBuyPct', cfg.stage1?.maxDevBuyPct],
    ['watch.triggerMarketCapUsd', cfg.watch?.triggerMarketCapUsd],
    ['watch.triggerUniqueBuyers', cfg.watch?.triggerUniqueBuyers],
    ['watch.windowMinutes', cfg.watch?.windowMinutes],
    ['deep.top10HardRejectPct', cfg.deep?.top10HardRejectPct],
    ['alertScoreThreshold', cfg.alertScoreThreshold],
    ['solPriceFallbackUsd', cfg.solPriceFallbackUsd],
  ];
  for (const [name, v] of required) {
    if (typeof v !== 'number') throw new Error(`config.json missing numeric field: ${name}`);
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
  };
  if (missing.length) {
    throw new Error(`Missing required values in .env: ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
  return secrets;
}
