import { describe, it, expect } from 'vitest';
import { fetchTop10Pct } from '../src/checks/holders';
import type { Rpc } from '../src/rpc';

function fakeRpc(handlers: Record<string, (params: unknown[]) => unknown>): Rpc {
  return {
    call: async (method: string, params: unknown[]) => {
      if (!(method in handlers)) throw new Error(`unexpected method ${method}`);
      return handlers[method](params);
    },
  } as unknown as Rpc;
}

describe('fetchTop10Pct', () => {
  it('sums top 10 holders excluding the bonding curve account', async () => {
    const rpc = fakeRpc({
      getTokenLargestAccounts: () => ({
        value: [
          { address: 'curveAta', uiAmount: 800_000_000 },
          { address: 'h1', uiAmount: 100_000_000 },
          { address: 'h2', uiAmount: 50_000_000 },
        ],
      }),
      getMultipleAccounts: () => ({
        value: [
          { data: { parsed: { info: { owner: 'CurveKey' } } } },
          { data: { parsed: { info: { owner: 'wallet1' } } } },
          { data: { parsed: { info: { owner: 'wallet2' } } } },
        ],
      }),
    });
    // (100M + 50M) / 1B = 15%
    expect(await fetchTop10Pct(rpc, 'mint', 'CurveKey')).toBe(15);
  });

  it("returns 'unknown' on RPC failure or empty result", async () => {
    const failing = fakeRpc({ getTokenLargestAccounts: () => { throw new Error('rpc down'); } });
    expect(await fetchTop10Pct(failing, 'mint', 'CurveKey')).toBe('unknown');
    const empty = fakeRpc({ getTokenLargestAccounts: () => ({ value: [] }) });
    expect(await fetchTop10Pct(empty, 'mint', 'CurveKey')).toBe('unknown');
  });
});
