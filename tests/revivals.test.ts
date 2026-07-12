import { describe, it, expect } from 'vitest';
import { parseBondingCurve, RevivalWatcher } from '../src/pipeline/revivals';
import type { RevivalRow } from '../src/db/index';

/** Build a base64 bonding-curve account: disc(8) | vToken u64 | vSol u64 | rT u64 | rS u64 | supply u64 | complete u8 */
function curveB64(vTokenRaw: bigint, vSolLamports: bigint, complete = false): string {
  const buf = Buffer.alloc(49);
  buf.writeBigUInt64LE(vTokenRaw, 8);
  buf.writeBigUInt64LE(vSolLamports, 16);
  buf.writeUInt8(complete ? 1 : 0, 48);
  return buf.toString('base64');
}

describe('parseBondingCurve', () => {
  it('computes market cap and liquidity from virtual reserves', () => {
    // 30 SOL vSol, 1.073e9 tokens vToken -> ~27.96 SOL MC (pump.fun launch state)
    const r = parseBondingCurve(curveB64(1_073_000_000_000_000n, 30_000_000_000n));
    expect(r).not.toBeNull();
    expect(r!.mcSol).toBeCloseTo(27.96, 1);
    expect(r!.vSolSol).toBeCloseTo(30, 5);
    expect(r!.complete).toBe(false);
  });

  it('reads the complete flag and rejects malformed data', () => {
    expect(parseBondingCurve(curveB64(1n, 1n, true))!.complete).toBe(true);
    expect(parseBondingCurve('AAAA')).toBeNull(); // too short
    expect(parseBondingCurve(curveB64(0n, 1n))).toBeNull(); // zero token reserve -> no price
  });
});

const CFG = { lookbackDays: 3, sweepMinutes: 10, jumpMult: 2, minMcUsd: 8000, maxCandidates: 6000 };

const row = (mint: string): RevivalRow => ({
  mint, symbol: 'DEAD', name: 'Dead Token', creator: 'dev1',
  bondingCurve: 'curve_' + mint, creationSig: 'sig', devBuyTokens: 0, createdAt: 1000,
});

// helper: curve data at a given SOL market cap (vSol chosen so mcSol == target)
// mcSol = (vSol/1e9) * 1e15 / vToken ; fix vToken = 1e15 -> mcSol = vSol/1e9
const mcData = (mcSol: number, complete = false) => curveB64(1_000_000_000_000_000n, BigInt(Math.round(mcSol * 1e9)), complete);

function watcher(accounts: Record<string, string | null>, rows: RevivalRow[], solUsd = 100) {
  const woken: Array<{ mint: string; mcSol: number }> = [];
  const w = new RevivalWatcher(CFG, {
    candidates: () => rows,
    fetchAccounts: async (keys) => keys.map((k) => accounts[k] ?? null),
    solUsd: () => solUsd,
    wake: (r, mcSol) => woken.push({ mint: r.mint, mcSol }),
  });
  return { w, woken, accounts };
}

describe('RevivalWatcher', () => {
  it('primes the baseline on first sighting without waking', async () => {
    const { w, woken } = watcher({ curve_m1: mcData(200) }, [row('m1')], 100); // $20k, above minMcUsd
    await w.sweep();
    expect(woken).toHaveLength(0); // first sighting only primes
  });

  it('wakes when MC jumps 2x off the floor and clears above minMcUsd', async () => {
    const t = watcher({ curve_m1: mcData(50) }, [row('m1')], 100); // floor $5k
    await t.w.sweep();
    t.accounts.curve_m1 = mcData(90); // $9k = 1.8x -> no wake
    await t.w.sweep();
    expect(t.woken).toHaveLength(0);
    t.accounts.curve_m1 = mcData(110); // $11k = 2.2x floor and >= $8k -> wake
    await t.w.sweep();
    expect(t.woken).toEqual([{ mint: 'm1', mcSol: 110 }]);
  });

  it('does not wake below minMcUsd even on a big multiple', async () => {
    const t = watcher({ curve_m1: mcData(10) }, [row('m1')], 100); // floor $1k
    await t.w.sweep();
    t.accounts.curve_m1 = mcData(60); // 6x but only $6k < $8k
    await t.w.sweep();
    expect(t.woken).toHaveLength(0);
  });

  it('uses a rolling MIN baseline (drift down, then jump from the lower floor)', async () => {
    const t = watcher({ curve_m1: mcData(100) }, [row('m1')], 100);
    await t.w.sweep();                       // baseline 100
    t.accounts.curve_m1 = mcData(45);        // drifts down -> baseline 45
    await t.w.sweep();
    t.accounts.curve_m1 = mcData(95);        // 2.1x the 45 floor, $9.5k -> wake
    await t.w.sweep();
    expect(t.woken).toHaveLength(1);
  });

  it('skips graduated curves and malformed accounts', async () => {
    const t = watcher(
      { curve_m1: mcData(50, true), curve_m2: 'AAAA' },
      [row('m1'), row('m2')], 100,
    );
    await t.w.sweep();
    t.accounts.curve_m1 = mcData(200, true);
    await t.w.sweep();
    expect(t.woken).toHaveLength(0);
  });

  it('wakes a mint at most once per pump (baseline re-primes after waking)', async () => {
    const t = watcher({ curve_m1: mcData(50) }, [row('m1')], 100);
    await t.w.sweep();
    t.accounts.curve_m1 = mcData(120);
    await t.w.sweep();
    expect(t.woken).toHaveLength(1);
    t.accounts.curve_m1 = mcData(130); // still pumping — but baseline restarted at 120
    await t.w.sweep();
    expect(t.woken).toHaveLength(1);
    t.accounts.curve_m1 = mcData(260); // 2x again from the new floor -> second, genuine wake
    await t.w.sweep();
    expect(t.woken).toHaveLength(2);
  });

  it('a graduated curve is dropped permanently (no repeat RPC interest, no floor)', async () => {
    const t = watcher({ curve_m1: mcData(50, true), curve_m2: mcData(40) }, [row('m1'), row('m2')], 100);
    await t.w.sweep();                          // m1 graduated -> dropped; m2 primes at 40
    t.accounts.curve_m2 = mcData(90);           // 2.25x, $9k -> wake
    await t.w.sweep();
    expect(t.woken).toEqual([{ mint: 'm2', mcSol: 90 }]);
    // graduated mint stays excluded even if its account data would now look wakeable
    t.accounts.curve_m1 = mcData(500, false);
    await t.w.sweep();
    expect(t.woken).toHaveLength(1);
  });

  it('one failing batch does not starve later batches', async () => {
    // 101 candidates -> two batches; the first batch throws, the second must still process
    const rows: RevivalRow[] = Array.from({ length: 101 }, (_, i) => row(`m${i}`));
    const accounts: Record<string, string> = {};
    for (let i = 0; i < 101; i++) accounts[`curve_m${i}`] = mcData(50);
    const woken: string[] = [];
    const w = new RevivalWatcher(CFG, {
      candidates: () => rows,
      fetchAccounts: async (keys) => {
        if (keys.length === 100) throw new Error('poisoned batch'); // first batch of each sweep
        return keys.map((k) => accounts[k]);
      },
      solUsd: () => 100,
      wake: (r) => woken.push(r.mint),
    });
    await w.sweep();          // batch2 (m100) primes at 50 despite batch1 failing
    accounts.curve_m100 = mcData(120);
    await w.sweep();          // m100 wakes
    expect(woken).toEqual(['m100']);
  });

  it('keeps a floor for a mint that temporarily leaves the candidate window', async () => {
    const r1 = row('m1');
    let present = true;
    const t = { accounts: { curve_m1: mcData(50) } as Record<string, string> };
    const woken: string[] = [];
    const w = new RevivalWatcher(CFG, {
      candidates: () => (present ? [r1] : []),
      fetchAccounts: async (keys) => keys.map((k) => t.accounts[k]),
      solUsd: () => 100,
      wake: (r) => woken.push(r.mint),
    });
    await w.sweep();          // primes floor at 50
    present = false;
    await w.sweep();          // mint falls out of the (capped) window — floor must survive
    present = true;
    t.accounts.curve_m1 = mcData(120); // 2.4x the ORIGINAL floor
    await w.sweep();
    expect(woken).toEqual(['m1']);     // would be empty if the floor had been re-primed at 120
  });

  it('a fetch failure skips the sweep without corrupting baselines', async () => {
    const t = watcher({ curve_m1: mcData(50) }, [row('m1')], 100);
    await t.w.sweep();
    const failing = new RevivalWatcher(CFG, {
      candidates: () => [row('m1')],
      fetchAccounts: async () => { throw new Error('rpc down'); },
      solUsd: () => 100,
      wake: () => { throw new Error('must not wake'); },
    });
    await expect(failing.sweep()).resolves.toBeUndefined(); // never throws
  });
});
