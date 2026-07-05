import { describe, it, expect } from 'vitest';
import { loadConfig, loadSecrets } from '../src/config';

describe('loadConfig', () => {
  it('loads the repo config.json with required numeric thresholds', () => {
    const cfg = loadConfig();
    expect(cfg.watch.triggerMarketCapUsd).toBe(15000);
    expect(cfg.watch.triggerUniqueBuyers).toBe(25);
    expect(cfg.alertScoreThreshold).toBe(60);
    expect(cfg.stage1.maxDevBuyPct).toBe(10);
  });
});

describe('loadSecrets', () => {
  it('returns secrets when all env vars present', () => {
    const s = loadSecrets({
      QUICKNODE_RPC_URL: 'https://x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1',
    });
    expect(s.quicknodeRpcUrl).toBe('https://x');
  });

  it('throws naming every missing var', () => {
    expect(() => loadSecrets({})).toThrow(/QUICKNODE_RPC_URL.*TELEGRAM_BOT_TOKEN.*TELEGRAM_CHAT_ID/s);
  });
});
