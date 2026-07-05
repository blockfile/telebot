import { describe, it, expect } from 'vitest';
import { Rpc } from '../src/rpc';

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Rpc', () => {
  it('returns result on success', async () => {
    const f = (async () => jsonRes({ jsonrpc: '2.0', id: 1, result: 42 })) as unknown as typeof fetch;
    expect(await new Rpc('https://rpc', f).call<number>('getFoo', [])).toBe(42);
  });

  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return calls < 3 ? jsonRes({}, 429) : jsonRes({ jsonrpc: '2.0', id: 1, result: 'ok' });
    }) as unknown as typeof fetch;
    expect(await new Rpc('https://rpc', f).call<string>('getFoo', [])).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws after 3 failed attempts', async () => {
    let calls = 0;
    const f = (async () => { calls++; return jsonRes({}, 500); }) as unknown as typeof fetch;
    await expect(new Rpc('https://rpc', f).call('getFoo', [])).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('throws on RPC-level error without exhausting retries', async () => {
    let calls = 0;
    const f = (async () => { calls++; return jsonRes({ jsonrpc: '2.0', id: 1, error: { message: 'bad params' } }); }) as unknown as typeof fetch;
    await expect(new Rpc('https://rpc', f).call('getFoo', [])).rejects.toThrow(/bad params/);
    expect(calls).toBe(1);
  });
});
