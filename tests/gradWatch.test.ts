import { describe, it, expect } from 'vitest';
import { GradWatch, type GradWatchDeps } from '../src/pipeline/gradWatch';
import type { GradSnapshot, Tri } from '../src/checks/gmgn';
import type { GraduationMonitorConfig } from '../src/config';

const CFG: GraduationMonitorConfig = {
  enabled: true, pollSeconds: 90, watchMinutes: 60,
  minVolume1hUsd: 5000, minLiquidityUsd: 3000, minHolders: 30, maxChecksPerSweep: 8,
};

function snap(over: Partial<GradSnapshot> = {}): GradSnapshot {
  return {
    symbol: 'FOMO', name: 'fomocat', logo: 'https://img/logo.png',
    priceUsd: 0.001, marketCapUsd: 20000, graduationMcUsd: 61626, athPriceUsd: 0.002,
    volume1hUsd: 10000, buys1h: 100, sells1h: 80, swaps1h: 180,
    holderCount: 60, liquidityUsd: 5000, priceChange1hPct: 12,
    honeypot: false, smartMoneyCount: 3, kolCount: 1,
    top10Pct: 20, buyTaxPct: 0, sellTaxPct: 0,
    ...over,
  };
}

function harness(overrides: {
  cfg?: GraduationMonitorConfig;
  graduationSnapshot?: (mint: string) => Promise<Tri<GradSnapshot>>;
  sendOk?: boolean;
} = {}) {
  const sent: Array<{ text: string; photoUrl?: string; buttons?: unknown }> = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const gmgnFn = overrides.graduationSnapshot ?? (async () => snap());
  const deps: GradWatchDeps = {
    gmgn: { graduationSnapshot: (mint: string) => { calls.push(mint); return gmgnFn(mint); } },
    send: async (payload) => { sent.push(payload); return { ok: overrides.sendOk ?? true }; },
    buttons: () => [[{ text: 'Chart', url: 'https://c' }]],
    cfg: overrides.cfg ?? CFG,
    log: (msg) => logs.push(msg),
  };
  return { watch: new GradWatch(deps), sent, calls, logs };
}

describe('GradWatch', () => {
  it('add() records a mint; size reflects the watch list', () => {
    const { watch } = harness();
    expect(watch.size).toBe(0);
    watch.add('m1', 1000);
    expect(watch.size).toBe(1);
    watch.add('m2', 1000);
    expect(watch.size).toBe(2);
  });

  it('add() is a no-op for a mint already watched or already alerted', async () => {
    const { watch, calls } = harness({ graduationSnapshot: async () => snap() });
    watch.add('m1', 0);
    watch.add('m1', 0); // duplicate while watched -> no-op
    expect(watch.size).toBe(1);
    await watch.sweep(0); // healthy -> alerts and removes from watch
    expect(watch.size).toBe(0);
    watch.add('m1', 0); // already alerted -> no-op
    expect(watch.size).toBe(0);
    expect(calls).toEqual(['m1']); // never re-checked after being alerted
  });

  it('a healthy snapshot sends one alert and marks it alerted; a second sweep does not resend', async () => {
    const { watch, sent, calls } = harness({ graduationSnapshot: async () => snap() });
    watch.add('mint1', 0);
    await watch.sweep(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('$FOMO');
    expect(sent[0].text).toContain('<code>mint1</code>');
    expect(sent[0].photoUrl).toBe('https://img/logo.png');
    expect(watch.size).toBe(0);

    await watch.sweep(2000);
    expect(sent).toHaveLength(1); // not resent
    expect(calls).toEqual(['mint1']); // not re-checked once alerted
  });

  it('a confirmed honeypot is dropped without sending', async () => {
    const { watch, sent, logs } = harness({ graduationSnapshot: async () => snap({ honeypot: true }) });
    watch.add('rug1', 0);
    await watch.sweep(1000);
    expect(sent).toHaveLength(0);
    expect(watch.size).toBe(0);
    expect(logs.some((l) => l.includes('honeypot'))).toBe(true);
  });

  it("an 'unknown' snapshot (GMGN hasn't indexed the pool yet) is kept and retried", async () => {
    let calls = 0;
    const { watch, sent } = harness({
      graduationSnapshot: async () => { calls++; return calls === 1 ? 'unknown' : snap(); },
    });
    watch.add('slow1', 0);
    await watch.sweep(1000);
    expect(sent).toHaveLength(0);
    expect(watch.size).toBe(1); // still watched
    await watch.sweep(2000);
    expect(sent).toHaveLength(1); // second sweep found data and it was healthy
    expect(calls).toBe(2);
  });

  it('a snapshot below the health floors is kept watching (not dropped, not alerted)', async () => {
    const { watch, sent } = harness({
      graduationSnapshot: async () => snap({ volume1hUsd: 100 }), // well below minVolume1hUsd
    });
    watch.add('cold1', 0);
    await watch.sweep(1000);
    expect(sent).toHaveLength(0);
    expect(watch.size).toBe(1);
  });

  it('each health floor (volume, liquidity, holders) independently gates the alert', async () => {
    const belowLiquidity = harness({ graduationSnapshot: async () => snap({ liquidityUsd: 100 }) });
    belowLiquidity.watch.add('a', 0);
    await belowLiquidity.watch.sweep(1000);
    expect(belowLiquidity.sent).toHaveLength(0);

    const belowHolders = harness({ graduationSnapshot: async () => snap({ holderCount: 5 }) });
    belowHolders.watch.add('b', 0);
    await belowHolders.watch.sweep(1000);
    expect(belowHolders.sent).toHaveLength(0);

    const healthy = harness({ graduationSnapshot: async () => snap() });
    healthy.watch.add('c', 0);
    await healthy.watch.sweep(1000);
    expect(healthy.sent).toHaveLength(1);
  });

  it('a mint past watchMinutes is dropped without ever being checked again', async () => {
    const { watch, calls, logs } = harness({ graduationSnapshot: async () => snap() });
    watch.add('old1', 0);
    // 61 minutes later, past the 60-minute watchMinutes
    await watch.sweep(61 * 60_000 + 1);
    expect(calls).toEqual([]); // expired before ever calling gmgn
    expect(watch.size).toBe(0);
    expect(logs.some((l) => l.includes('expired'))).toBe(true);
  });

  it('a below-floor snapshot is dropped once it passes watchMinutes', async () => {
    const { watch, sent } = harness({ graduationSnapshot: async () => snap({ volume1hUsd: 0 }) });
    watch.add('cold2', 0);
    await watch.sweep(1000); // below floor, kept
    expect(watch.size).toBe(1);
    await watch.sweep(61 * 60_000 + 1); // now expired
    expect(watch.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('maxChecksPerSweep bounds the number of gmgn calls in a single sweep', async () => {
    const cfg = { ...CFG, maxChecksPerSweep: 3 };
    const { watch, calls } = harness({ cfg, graduationSnapshot: async () => snap({ volume1hUsd: 0 }) }); // kept watching
    for (let i = 0; i < 8; i++) watch.add(`m${i}`, 0);
    await watch.sweep(1000);
    expect(calls).toEqual(['m0', 'm1', 'm2']); // only the first 3 mints are checked this sweep
    await watch.sweep(2000);
    // still none of these were ever dropped, so the same front-of-list 3 are checked again —
    // m3..m7 are never reached while m0..m2 stay below the health floor
    expect(calls).toEqual(['m0', 'm1', 'm2', 'm0', 'm1', 'm2']);
  });

  it('never throws when the gmgn call rejects, and keeps the mint watched to retry', async () => {
    const { watch, sent } = harness({ graduationSnapshot: async () => { throw new Error('network down'); } });
    watch.add('flaky1', 0);
    await expect(watch.sweep(1000)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(watch.size).toBe(1);
  });

  it('one mint throwing does not stop the rest of the sweep from being processed', async () => {
    const { watch, sent, calls } = harness({
      graduationSnapshot: async (mint: string) => {
        if (mint === 'bad') throw new Error('boom');
        return snap();
      },
    });
    watch.add('bad', 0);
    watch.add('good', 0);
    await watch.sweep(1000);
    expect(calls).toEqual(['bad', 'good']);
    expect(sent).toHaveLength(1);
    expect(watch.size).toBe(1); // 'bad' still watched, 'good' alerted and removed
  });

  it('keeps a mint watched (does not mark alerted) when send fails, and retries next sweep', async () => {
    const { watch, sent } = harness({ graduationSnapshot: async () => snap(), sendOk: false });
    watch.add('retry1', 0);
    await watch.sweep(1000);
    expect(sent).toHaveLength(1); // attempted
    expect(watch.size).toBe(1); // not marked alerted, still watched
    await watch.sweep(2000);
    expect(sent).toHaveLength(2); // retried
  });
});
