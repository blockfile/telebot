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

  it("returns 'unknown' when the earliest captured slot is newer than creation (launch missed)", async () => {
    const rpc = fakeRpc({ createSlot: 100, curveSigs: [{ signature: 'x', slot: 200 }], txBySig: {} });
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60)).toBe('unknown');
  });

  it("returns 'unknown' when the creation tx has no slot", async () => {
    const rpc = { call: async (m: string) => (m === 'getTransaction' ? null : []) } as unknown as Rpc;
    expect(await analyzeLaunch(rpc, MINT, CURVE, DEV, 'create', 60)).toBe('unknown');
  });
});
