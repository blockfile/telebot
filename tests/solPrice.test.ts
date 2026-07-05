import { describe, it, expect } from 'vitest';
import { SolPrice } from '../src/solPrice';

const okFetch = (usd: number) => (async () =>
  new Response(JSON.stringify({ solana: { usd } }), { status: 200 })) as unknown as typeof fetch;

describe('SolPrice', () => {
  it('starts at the fallback price', () => {
    expect(new SolPrice(150).usd).toBe(150);
  });

  it('updates on successful refresh', async () => {
    const p = new SolPrice(150, okFetch(203.5));
    await p.refresh();
    expect(p.usd).toBe(203.5);
  });

  it('keeps last known price when fetch fails or returns junk', async () => {
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const p = new SolPrice(150, failing);
    await p.refresh();
    expect(p.usd).toBe(150);

    const junk = (async () => new Response('{"solana":{}}', { status: 200 })) as unknown as typeof fetch;
    const p2 = new SolPrice(150, junk);
    await p2.refresh();
    expect(p2.usd).toBe(150);
  });
});
