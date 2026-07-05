import { describe, it, expect } from 'vitest';
import { checkUrlAlive, checkXExists } from '../src/checks/liveness';

const statusFetch = (status: number) => (async () => new Response('x', { status })) as unknown as typeof fetch;
const throwing = (async () => { throw new Error('net'); }) as unknown as typeof fetch;

describe('checkUrlAlive', () => {
  it('true on 2xx, false on 404/410', async () => {
    expect(await checkUrlAlive('https://a.io', statusFetch(200))).toBe(true);
    expect(await checkUrlAlive('https://a.io', statusFetch(404))).toBe(false);
    expect(await checkUrlAlive('https://a.io', statusFetch(410))).toBe(false);
  });

  it("'unknown' on network failure or server errors (never a hard fail)", async () => {
    expect(await checkUrlAlive('https://a.io', throwing)).toBe('unknown');
    expect(await checkUrlAlive('https://a.io', statusFetch(503))).toBe('unknown');
  });
});

describe('checkXExists', () => {
  it('true on oEmbed 200, false on 404, unknown on error', async () => {
    expect(await checkXExists('cooldev', statusFetch(200))).toBe(true);
    expect(await checkXExists('cooldev', statusFetch(404))).toBe(false);
    expect(await checkXExists('cooldev', throwing)).toBe('unknown');
  });

  it("communities are always 'unknown'", async () => {
    expect(await checkXExists('community:123', statusFetch(404))).toBe('unknown');
  });
});
