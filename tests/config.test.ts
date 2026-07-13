import { describe, it, expect } from 'vitest';
import { loadConfig, loadSecrets } from '../src/config';

describe('loadConfig', () => {
  it('loads the repo config.json with required numeric thresholds', () => {
    const cfg = loadConfig();
    expect(cfg.watch.triggerMarketCapUsd).toBe(5000);
    expect(cfg.watch.triggerVolumeUsd).toBe(6000);
    expect(cfg.watch.triggerUniqueBuyers).toBe(15);
    expect(cfg.alertScoreThreshold).toBe(60);
    expect(cfg.stage1.maxDevBuyPct).toBe(10);
    expect(typeof cfg.stage1.requireTelegramOrWebsite).toBe('boolean');
  });

  it('loads the launch and followUp sections', () => {
    const cfg = loadConfig();
    expect(cfg.launch.bundleHardRejectPct).toBe(50);
    expect(cfg.launch.devOutflowHardRejectPct).toBe(30);
    expect(cfg.launch.maxEarlyTxFetch).toBe(60);
    expect(cfg.launch.sniperSlots).toBe(3);
    expect(cfg.followUp.windowMinutes).toBe(60);
    expect(cfg.followUp.dumpAlertPct).toBe(50);
    expect(cfg.followUp.milestones).toEqual([2, 5, 10, 25, 50, 100]);
    expect(Array.isArray(cfg.buttons.buy)).toBe(true);
    expect(cfg.buttons.chart).toBe(true);
  });

  it('loads gmgn config, defaulting to disabled', () => {
    const cfg = loadConfig();
    expect(cfg.gmgn.enabled).toBe(false);
  });
});

describe('loadSecrets', () => {
  it('returns secrets when all env vars present', () => {
    const s = loadSecrets({
      QUICKNODE_RPC_URL: 'https://x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1',
    });
    expect(s.quicknodeRpcUrl).toBe('https://x');
    expect(s.pumpportalApiKey).toBe(''); // optional — empty when unset
  });

  it('passes through the optional pumpportal api key', () => {
    const s = loadSecrets({
      QUICKNODE_RPC_URL: 'https://x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1',
      PUMPPORTAL_API_KEY: 'pp-key',
    });
    expect(s.pumpportalApiKey).toBe('pp-key');
  });

  it('gmgn api key is optional: empty when unset, passed through when set', () => {
    const unset = loadSecrets({ QUICKNODE_RPC_URL: 'https://x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' });
    expect(unset.gmgnApiKey).toBe('');
    const set = loadSecrets({
      QUICKNODE_RPC_URL: 'https://x', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', GMGN_API_KEY: 'gmgn-key',
    });
    expect(set.gmgnApiKey).toBe('gmgn-key');
  });

  it('throws naming every missing var', () => {
    expect(() => loadSecrets({})).toThrow(/QUICKNODE_RPC_URL.*TELEGRAM_BOT_TOKEN.*TELEGRAM_CHAT_ID/s);
  });
});
