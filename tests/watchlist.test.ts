import { describe, it, expect, beforeEach } from 'vitest';
import { Watchlist, type WatchedToken } from '../src/pipeline/watchlist';
import type { NewTokenEvent, TradeEvent } from '../src/types';

const CFG = {
  windowMinutes: 90, maxConcurrent: 3, triggerMarketCapUsd: 15000,
  triggerUniqueBuyers: 3, bundleWindowMs: 1500, bundleMaxBuyers: 3,
};

const newToken = (mint: string): NewTokenEvent => ({
  mint, name: 'T', symbol: 'T', uri: 'u', creator: 'dev1', devBuyTokens: 0, devBuySol: 0,
  bondingCurveKey: 'bc', marketCapSol: 30, signature: 's', receivedAt: 0,
});

const trade = (mint: string, trader: string, isBuy: boolean, marketCapSol: number, at: number): TradeEvent & { at: number } =>
  ({ mint, trader, isBuy, tokenAmount: 1, solAmount: 1, marketCapSol, signature: 'x', receivedAt: at, at });

describe('Watchlist', () => {
  let triggered: WatchedToken[]; let disqualified: Array<[WatchedToken, string]>;
  let expired: WatchedToken[]; let subs: string[]; let unsubs: string[];
  let wl: Watchlist;

  beforeEach(() => {
    triggered = []; disqualified = []; expired = []; subs = []; unsubs = [];
    wl = new Watchlist(CFG, {
      onTrigger: (t) => triggered.push(t),
      onDisqualify: (t, r) => disqualified.push([t, r]),
      onExpire: (t) => expired.push(t),
      subscribe: (m) => subs.push(m),
      unsubscribe: (m) => unsubs.push(m),
    });
  });

  it('triggers when MC and unique buyers thresholds are both met', () => {
    wl.add(newToken('m1'), {}, 0);
    expect(subs).toEqual(['m1']);
    // 3 unique buyers at $100/SOL: 200 SOL MC = $20k >= $15k, spread out past the bundle window
    wl.onTrade(trade('m1', 'a', true, 100, 5000), 100, 5000);
    wl.onTrade(trade('m1', 'b', true, 150, 6000), 100, 6000);
    expect(triggered).toHaveLength(0); // only 2 buyers so far
    wl.onTrade(trade('m1', 'c', true, 200, 7000), 100, 7000);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].buyers.size).toBe(3);
    expect(triggered[0].lastMarketCapSol).toBe(200);
    expect(unsubs).toEqual(['m1']);
    // further trades are ignored — no double trigger
    wl.onTrade(trade('m1', 'd', true, 300, 8000), 100, 8000);
    expect(triggered).toHaveLength(1);
  });

  it('does not trigger on MC alone without enough buyers', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'a', true, 500, 5000), 100, 5000);
    expect(triggered).toHaveLength(0);
  });

  it('disqualifies on dev sell', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'dev1', false, 25, 5000), 100, 5000);
    expect(disqualified).toHaveLength(1);
    expect(disqualified[0][1]).toBe('dev sold');
    expect(wl.size).toBe(0);
  });

  it('disqualifies bundled launches (3 distinct early buyers within 1500ms)', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'a', true, 31, 100), 100, 100);
    wl.onTrade(trade('m1', 'b', true, 32, 200), 100, 200);
    expect(disqualified).toHaveLength(0);
    wl.onTrade(trade('m1', 'c', true, 33, 300), 100, 300);
    expect(disqualified).toHaveLength(1);
    expect(disqualified[0][1]).toMatch(/bundled/);
  });

  it('dev buys do not count toward buyers or bundling', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'dev1', true, 31, 100), 100, 100);
    wl.onTrade(trade('m1', 'a', true, 32, 200), 100, 200);
    wl.onTrade(trade('m1', 'b', true, 33, 300), 100, 300);
    expect(disqualified).toHaveLength(0);
  });

  it('expires tokens past the watch window on sweep', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.sweep(90 * 60_000 + 1);
    expect(expired).toHaveLength(1);
    expect(wl.size).toBe(0);
  });

  it('ignores a duplicate add for a mint already on the watchlist', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.onTrade(trade('m1', 'a', true, 31, 100), 100, 100);
    wl.add(newToken('m1'), {}, 500);
    expect(subs).toEqual(['m1']); // subscribe not called a second time
    expect(wl.size).toBe(1);
    expect(wl.mints()).toEqual(['m1']);
    // state (buyers) must not have been reset by the duplicate add
    wl.onTrade(trade('m1', 'b', true, 32, 600), 100, 600);
    wl.onTrade(trade('m1', 'c', true, 200, 7000), 100, 7000);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].buyers.has('a')).toBe(true);
  });

  it('evicts oldest when at capacity', () => {
    wl.add(newToken('m1'), {}, 0);
    wl.add(newToken('m2'), {}, 1);
    wl.add(newToken('m3'), {}, 2);
    wl.add(newToken('m4'), {}, 3);
    expect(wl.size).toBe(3);
    expect(expired.map(t => t.event.mint)).toEqual(['m1']);
    expect(wl.mints()).toEqual(['m2', 'm3', 'm4']);
  });
});
