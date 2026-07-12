import { describe, it, expect } from 'vitest';
import { analyzeLaunch } from '../src/checks/launchAnalysis';
import type { Rpc } from '../src/rpc';

const MINT = 'MintX', CURVE = 'Curve1', DEV = 'Dev1';

// buy tx builder (balance delta) at a given accountIndex
const buy = (owner: string, amount: number) => ({
  meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 2, mint: MINT, owner, uiTokenAmount: { uiAmount: amount } }] },
});
const xfer = (amount: number) => ({
  transaction: { message: { instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked', info: { authority: DEV, mint: MINT, tokenAmount: { uiAmount: amount } } } }] } },
  meta: { innerInstructions: [] },
});

function fakeRpc(h: {
  createSlot: number;
  curveSigs: Array<{ signature: string; slot: number }>;
  txBySig: Record<string, unknown>;
  devSigs?: Array<{ signature: string; slot: number }>;
  heldByOwner?: Record<string, number>; // current uiAmount balance per wallet
}): Rpc {
  return {
    call: async (method: string, params: unknown[]) => {
      if (method === 'getTransaction') {
        const sig = (params[0] as string);
        if (sig === 'create') return { slot: h.createSlot };
        return h.txBySig[sig] ?? null;
      }
      if (method === 'getSignaturesForAddress') {
        const addr = params[0] as string;
        // newest-first
        if (addr === CURVE) return [...h.curveSigs].reverse();
        if (addr === DEV) return [...(h.devSigs ?? [])].reverse();
      }
      if (method === 'getTokenAccountsByOwner') {
        const owner = params[0] as string;
        if (!h.heldByOwner || !(owner in h.heldByOwner)) throw new Error('no balance for ' + owner);
        return { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: h.heldByOwner[owner] } } } } } }] };
      }
      throw new Error('unexpected ' + method);
    },
  } as unknown as Rpc;
}

describe('analyzeLaunch', () => {
  it('computes bundle (creation-slot buys), first-20, and dev-outflow percentages', async () => {
    const rpc = fakeRpc({
      createSlot: 100,
      // chronological: create(100), b1(100 same slot = bundle), b2(101), devxfer sig lives on dev list
      curveSigs: [
        { signature: 'create', slot: 100 },
        { signature: 'b1', slot: 100 },
        { signature: 'b2', slot: 101 },
      ],
      txBySig: {
        b1: buy('buyer1', 50_000_000),   // 5% bundle
        b2: buy('buyer2', 10_000_000),   // 1% first-20 but not bundle
        dx: xfer(62_000_000),            // 6.2% dev outflow
      },
      devSigs: [{ signature: 'dx', slot: 100 }],
    });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.bundlePct).toBeCloseTo(5, 5);       // 50M / 1B
    expect(r.first20Pct).toBeCloseTo(6, 5);      // buyer1 5% + buyer2 1%
    expect(r.devOutflowPct).toBeCloseTo(6.2, 5); // 62M / 1B
  });

  it('counts snipers: first buy within sniperSlots after creation, excluding same-slot bundlers', async () => {
    const rpc = fakeRpc({
      createSlot: 100,
      curveSigs: [
        { signature: 'create', slot: 100 },
        { signature: 'bundler', slot: 100 },  // creation slot -> bundler, NOT a sniper
        { signature: 'sniper1', slot: 101 },   // within 3 slots -> sniper
        { signature: 'sniper2', slot: 103 },   // within 3 slots -> sniper
        { signature: 'late', slot: 110 },      // beyond sniperSlots -> not a sniper
      ],
      txBySig: {
        bundler: buy('bundlerW', 40_000_000),
        sniper1: buy('sniperW1', 30_000_000),
        sniper2: buy('sniperW2', 20_000_000),
        late: buy('lateW', 10_000_000),
      },
    });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60, 3); // sniperSlots = 3
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.sniperCount).toBe(2);              // sniperW1 + sniperW2
    expect(r.sniperPct).toBeCloseTo(5, 5);      // (30M + 20M) / 1B
    expect(r.bundlePct).toBeCloseTo(4, 5);      // bundlerW 40M (unchanged by sniper logic)
  });

  it('paginates back to the creation signature when the curve has more than one page of history', async () => {
    // 1500 sigs newer than creation: page 1 = 1000 (full -> keep paging), page 2 = 500 (short -> reached creation)
    const calls: Array<Record<string, unknown>> = [];
    const early = [
      { signature: 'b1', slot: 100 }, // creation-slot bundle buy
      { signature: 'b2', slot: 105 },
    ];
    const filler = Array.from({ length: 1498 }, (_, i) => ({ signature: `f${i}`, slot: 200 + i }));
    const all = [...early, ...filler]; // chronological
    const newestFirst = [...all].reverse();
    const rpc = {
      call: async (method: string, params: unknown[]) => {
        if (method === 'getTransaction') {
          const sig = params[0] as string;
          if (sig === 'create') return { slot: 100 };
          if (sig === 'b1') return buy('bundlerW', 50_000_000);
          if (sig === 'b2') return buy('lateW', 10_000_000);
          return null;
        }
        if (method === 'getSignaturesForAddress') {
          const addr = params[0] as string;
          if (addr === DEV) return [];
          const opts = params[1] as Record<string, unknown>;
          calls.push(opts);
          const start = opts.before ? newestFirst.findIndex((s) => s.signature === opts.before) + 1 : 0;
          return newestFirst.slice(start, start + 1000);
        }
        if (method === 'getTokenAccountsByOwner') throw new Error('no balances in this test');
        throw new Error('unexpected ' + method);
      },
    } as unknown as Rpc;

    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60, 3, 15);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(calls.length).toBe(2);                        // two pages walked
    expect(calls[1].before).toBeDefined();               // second page anchored on the first page's oldest sig
    expect(r.bundlePct).toBeCloseTo(5, 5);               // earliest txs reached across the page boundary
  });

  it("returns 'unknown' when the page cap is exhausted before reaching creation (token too hot)", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ signature: `p${i}`, slot: 500 + i }));
    const rpc = {
      call: async (method: string, params: unknown[]) => {
        if (method === 'getTransaction') return { slot: 100 };
        if (method === 'getSignaturesForAddress') return page; // always a full page, never reaches creation
        throw new Error('unexpected ' + method);
      },
    } as unknown as Rpc;
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60, 3, 2)).toBe('unknown');
  });

  it('computes bundle/sniper held percentages from current insider balances', async () => {
    const rpc = fakeRpc({
      createSlot: 100,
      curveSigs: [
        { signature: 'create', slot: 100 },
        { signature: 'bund', slot: 100 },   // bundler: bought 50M
        { signature: 'snip', slot: 102 },    // sniper: bought 30M
      ],
      txBySig: { bund: buy('bundlerW', 50_000_000), snip: buy('sniperW', 30_000_000) },
      heldByOwner: { bundlerW: 10_000_000, sniperW: 30_000_000 }, // bundler dumped 80%, sniper holds all
      devSigs: [],
    });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60, 3, 15);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.bundleCount).toBe(1);
    expect(r.bundlePct).toBeCloseTo(5, 5);        // bought 50M/1B
    expect(r.bundleHeldPct).toBeCloseTo(1, 5);    // holds 10M/1B
    expect(r.sniperPct).toBeCloseTo(3, 5);        // bought 30M/1B
    expect(r.sniperHeldPct).toBeCloseTo(3, 5);    // still holds 30M/1B
  });

  it("a PARTIAL balance-lookup failure degrades that group to 'unknown' rather than faking a dump", async () => {
    const rpc = fakeRpc({
      createSlot: 100,
      curveSigs: [
        { signature: 'create', slot: 100 },
        { signature: 'bund1', slot: 100 },
        { signature: 'bund2', slot: 100 },
      ],
      txBySig: { bund1: buy('bw1', 50_000_000), bund2: buy('bw2', 40_000_000) },
      heldByOwner: { bw1: 50_000_000 }, // bw2's lookup throws — must NOT count as "holds 0"
      devSigs: [],
    });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60, 3, 15);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.bundlePct).toBeCloseTo(9, 5);
    expect(r.bundleHeldPct).toBe('unknown'); // honest "9% → ?" instead of a false dump trend
  });

  it("insiders beyond the lookup cap degrade their group to 'unknown' instead of counting as dumped", async () => {
    const n = 21; // one more than MAX_HOLDS_LOOKUPS
    const curveSigs = [
      { signature: 'create', slot: 100 },
      ...Array.from({ length: n }, (_, i) => ({ signature: `s${i}`, slot: 101 })), // all snipers
    ];
    const txBySig: Record<string, unknown> = {};
    const heldByOwner: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      txBySig[`s${i}`] = buy(`sw${i}`, 1_000_000);
      heldByOwner[`sw${i}`] = 1_000_000; // everyone still holds — but only 20 get looked up
    }
    const rpc = fakeRpc({ createSlot: 100, curveSigs, txBySig, heldByOwner, devSigs: [] });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60, 3, 15);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.sniperCount).toBe(n);
    expect(r.sniperHeldPct).toBe('unknown'); // 21st wallet unsampled — don't report a fake trim
    expect(r.bundleHeldPct).toBe(0);         // no bundlers at all -> exact 0, not unknown
  });

  it("held percentages degrade to 'unknown' when balance lookups fail, without failing the analysis", async () => {
    const rpc = fakeRpc({
      createSlot: 100,
      curveSigs: [{ signature: 'create', slot: 100 }, { signature: 'bund', slot: 100 }],
      txBySig: { bund: buy('bundlerW', 50_000_000) },
      // heldByOwner omitted -> getTokenAccountsByOwner throws for every wallet
      devSigs: [],
    });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60, 3, 15);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.bundlePct).toBeCloseTo(5, 5);
    expect(r.bundleHeldPct).toBe('unknown');
  });

  it("returns 'unknown' when the earliest captured slot is newer than creation (launch missed)", async () => {
    const rpc = fakeRpc({ createSlot: 100, curveSigs: [{ signature: 'x', slot: 200 }], txBySig: {} });
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60)).toBe('unknown');
  });

  it("returns 'unknown' when the creation tx has no slot", async () => {
    const rpc = { call: async (m: string) => (m === 'getTransaction' ? null : []) } as unknown as Rpc;
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60)).toBe('unknown');
  });

  it("returns 'unknown' when the creator's getSignaturesForAddress call rejects, instead of reading as a clean 0% dev outflow", async () => {
    const rpc = {
      call: async (method: string, params: unknown[]) => {
        if (method === 'getTransaction') return { slot: 100 };
        if (method === 'getSignaturesForAddress') {
          const addr = params[0] as string;
          if (addr === CURVE) return [{ signature: 'create', slot: 100 }];
          if (addr === DEV) throw new Error('RPC unavailable');
        }
        throw new Error('unexpected ' + method);
      },
    } as unknown as Rpc;
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60)).toBe('unknown');
  });

  it('caps first20Pct at the first 20 distinct buyers, summing repeat buys but excluding the 21st buyer', async () => {
    const buyerCount = 21;
    const curveSigs = [
      { signature: 'create', slot: 100 },
      ...Array.from({ length: buyerCount }, (_, i) => ({ signature: `b${i + 1}`, slot: 100 })),
      { signature: 'b1-again', slot: 100 }, // buyer1 buys a second time
    ];
    const txBySig: Record<string, unknown> = { 'b1-again': buy('buyer1', 1_000_000) };
    for (let i = 1; i <= buyerCount; i++) txBySig[`b${i}`] = buy(`buyer${i}`, 1_000_000);

    const rpc = fakeRpc({ createSlot: 100, curveSigs, txBySig });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    // first 20 distinct buyers = buyer1..buyer20; buyer1's repeat buy is summed in (2M),
    // buyer2..buyer20 contribute 1M each (19M), buyer21 is excluded entirely => 21M / 1B = 2.1%
    expect(r.first20Pct).toBeCloseTo(2.1, 5);
  });

  it('bounds getTransaction fetches to maxEarlyTxFetch per side, never fetching every available signature', async () => {
    const maxEarlyTxFetch = 10;
    let getTransactionCalls = 0;
    const curveSigs = [
      { signature: 'create', slot: 100 },
      ...Array.from({ length: 100 }, (_, i) => ({ signature: `c${i}`, slot: 100 })),
    ];
    const devSigs = Array.from({ length: 100 }, (_, i) => ({ signature: `d${i}`, slot: 100 }));
    const rpc = {
      call: async (method: string, params: unknown[]) => {
        if (method === 'getTransaction') {
          getTransactionCalls++;
          const sig = params[0] as string;
          return sig === 'create' ? { slot: 100 } : null;
        }
        if (method === 'getSignaturesForAddress') {
          const addr = params[0] as string;
          if (addr === CURVE) return [...curveSigs].reverse();
          if (addr === DEV) return [...devSigs].reverse();
        }
        throw new Error('unexpected ' + method);
      },
    } as unknown as Rpc;

    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', maxEarlyTxFetch);
    expect(r).not.toBe('unknown');
    // <=10 curve early fetches + <=10 dev early fetches + 1 creation-slot fetch
    expect(getTransactionCalls).toBeLessThanOrEqual(2 * maxEarlyTxFetch + 1);
  });

  it('excludes the bonding curve mint-in from bundle and first-20 (regression: C1)', async () => {
    // creation-slot tx: curve ATA gets 970M (must be excluded), dev gets 30M (excluded), one real sniper gets 20M
    const creationBuys = {
      meta: {
        preTokenBalances: [],
        postTokenBalances: [
          { accountIndex: 1, mint: MINT, owner: CURVE, uiTokenAmount: { uiAmount: 970_000_000 } },
          { accountIndex: 2, mint: MINT, owner: DEV, uiTokenAmount: { uiAmount: 30_000_000 } },
          { accountIndex: 3, mint: MINT, owner: 'sniper1', uiTokenAmount: { uiAmount: 20_000_000 } },
        ],
      },
    };
    const rpc = fakeRpc({
      createSlot: 100,
      curveSigs: [{ signature: 'create', slot: 100 }, { signature: 'b1', slot: 100 }],
      txBySig: { b1: creationBuys },
      devSigs: [],
    });
    const r = await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60);
    expect(r).not.toBe('unknown');
    if (r === 'unknown') return;
    expect(r.bundlePct).toBeCloseTo(2, 5);    // only sniper1's 20M/1B — NOT ~99%
    expect(r.first20Pct).toBeCloseTo(2, 5);
    expect(r.devOutflowPct).toBeCloseTo(0, 5);
  });
});
