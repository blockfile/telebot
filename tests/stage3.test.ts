import { describe, it, expect } from 'vitest';
import { runDeepChecks, type DeepCheckDeps } from '../src/pipeline/stage3';
import type { WatchedToken } from '../src/pipeline/watchlist';

const watched = (meta: WatchedToken['meta']): WatchedToken => ({
  event: {
    mint: 'mintA', name: 'T', symbol: 'T', uri: 'u', creator: 'dev1', devBuyTokens: 0,
    devBuySol: 0, bondingCurveKey: 'bc1', marketCapSol: 100, signature: 's', receivedAt: 0,
  },
  meta, buyers: new Set(['a', 'b']), buys: 2, sells: 0, devSold: false,
  earlyBuyers: new Set(), lastMarketCapSol: 100, addedAt: 0,
});

const deps = (over: Partial<DeepCheckDeps> = {}): DeepCheckDeps => ({
  fetchDevHistory: async () => ({ priorLaunches: 1, anyGraduated: false, funder: 'funder1' }),
  isRugLinked: (w) => w === 'ruggerFunder',
  fetchTop10Pct: async () => 22,
  checkUrlAlive: async () => true,
  checkXExists: async () => true,
  ...over,
});

describe('runDeepChecks', () => {
  it('assembles results from all checks', async () => {
    const r = await runDeepChecks(watched({ twitter: 'https://x.com/CoolDev', telegram: 't.me/c', website: 'coolcoin.io' }), deps());
    expect(r).toEqual({
      devHistory: { priorLaunches: 1, anyGraduated: false },
      funderLinkedToRug: false, top10Pct: 22,
      twitterAlive: true, telegramAlive: true, websiteAlive: true,
      xExists: true, devStillHolds: true,
    });
  });

  it("marks absent links 'unknown' and skips their checks", async () => {
    let urlChecks = 0;
    const r = await runDeepChecks(
      watched({ twitter: 'https://x.com/CoolDev' }),
      deps({ checkUrlAlive: async () => { urlChecks++; return true; } }),
    );
    expect(r.telegramAlive).toBe('unknown');
    expect(r.websiteAlive).toBe('unknown');
    expect(urlChecks).toBe(1);
  });

  it('flags rug-linked funder; unknown funder stays unknown', async () => {
    const linked = await runDeepChecks(
      watched({ twitter: 'https://x.com/d' }),
      deps({ fetchDevHistory: async () => ({ priorLaunches: 0, anyGraduated: false, funder: 'ruggerFunder' }) }),
    );
    expect(linked.funderLinkedToRug).toBe(true);

    const noFunder = await runDeepChecks(
      watched({ twitter: 'https://x.com/d' }),
      deps({ fetchDevHistory: async () => ({ priorLaunches: 0, anyGraduated: false, funder: null }) }),
    );
    expect(noFunder.funderLinkedToRug).toBe('unknown');
  });

  it('propagates unknown dev history', async () => {
    const r = await runDeepChecks(watched({ twitter: 'https://x.com/d' }), deps({ fetchDevHistory: async () => 'unknown' }));
    expect(r.devHistory).toBe('unknown');
    expect(r.funderLinkedToRug).toBe('unknown');
  });
});
