import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GmgnClient } from '../src/checks/gmgn';

const SECURITY_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/gmgn-security.json', import.meta.url), 'utf8'));
const INFO_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/gmgn-info.json', import.meta.url), 'utf8'));

type Handler = (url: URL) => unknown;

function fakeFetch(handlers: Record<string, Handler | 'http500' | 'throw'>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = url.pathname;
    const h = handlers[key];
    if (h === undefined) throw new Error(`unexpected path ${key}`);
    if (h === 'throw') throw new Error('network down');
    if (h === 'http500') return new Response('server error', { status: 500 });
    // capture auth header presence for assertions via a side channel on globalThis
    (globalThis as any).__lastHeaders = init?.headers;
    return new Response(JSON.stringify(h(url)), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('GmgnClient.enrich', () => {
  it('parses real captured sol token/security + token/info fixtures into a GmgnEnrichment', async () => {
    const f = fakeFetch({
      '/v1/token/security': () => SECURITY_FIXTURE,
      '/v1/token/info': () => INFO_FIXTURE,
    });
    const client = new GmgnClient('demo-key', f);
    const r = await client.enrich('9eBUi9xdFphD9sASBu84XKHFzeM4hnTFBozuogWKpump');
    expect(r).toEqual({
      smartMoneyCount: 3,
      kolCount: 4,
      honeypot: 'unknown', // fixture's is_honeypot is null — never guess "not a honeypot" from that
      buyTaxPct: 0,
      sellTaxPct: 0,
      top10Pct: 21.42,
    });
  });

  it('sends the required auth header and query params (chain, address, timestamp, client_id)', async () => {
    // Both endpoints are hit in parallel (Promise.all) — capture all requests and assert on
    // the security one specifically, rather than assuming which resolves/logs last.
    const captured: URL[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(new URL(String(input)));
      expect((init?.headers as Record<string, string>)?.['X-APIKEY']).toBe('demo-key');
      return new Response(JSON.stringify(SECURITY_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;
    await new GmgnClient('demo-key', f).enrich('mintXYZ');
    const security = captured.find((u) => u.pathname === '/v1/token/security');
    expect(security).toBeDefined();
    expect(security!.searchParams.get('chain')).toBe('sol');
    expect(security!.searchParams.get('address')).toBe('mintXYZ');
    expect(security!.searchParams.get('timestamp')).toMatch(/^\d+$/);
    expect(security!.searchParams.get('client_id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.some((u) => u.pathname === '/v1/token/info')).toBe(true);
  });

  it('degrades one source to unknown when only it fails, keeping the other', async () => {
    const f = fakeFetch({
      '/v1/token/security': 'http500',
      '/v1/token/info': () => INFO_FIXTURE,
    });
    const r = await new GmgnClient('k', f).enrich('mint');
    expect(r).not.toBe('unknown');
    if (r === 'unknown') throw new Error('unreachable');
    expect(r.smartMoneyCount).toBe(3);
    expect(r.kolCount).toBe(4);
    expect(r.honeypot).toBe('unknown');
    expect(r.buyTaxPct).toBe('unknown');
    expect(r.sellTaxPct).toBe('unknown');
    expect(r.top10Pct).toBe(21.42); // falls back to info's stat.top_10_holder_rate
  });

  it("returns 'unknown' when both endpoints fail (HTTP error)", async () => {
    const f = fakeFetch({ '/v1/token/security': 'http500', '/v1/token/info': 'http500' });
    expect(await new GmgnClient('k', f).enrich('mint')).toBe('unknown');
  });

  it("returns 'unknown' when both endpoints throw (network down) — never throws itself", async () => {
    const f = fakeFetch({ '/v1/token/security': 'throw', '/v1/token/info': 'throw' });
    await expect(new GmgnClient('k', f).enrich('mint')).resolves.toBe('unknown');
  });

  it("returns 'unknown' when the outer envelope code is non-zero", async () => {
    const f = fakeFetch({
      '/v1/token/security': () => ({ code: 1, data: null, message: 'rate limited' }),
      '/v1/token/info': () => ({ code: 1, data: null, message: 'rate limited' }),
    });
    expect(await new GmgnClient('k', f).enrich('mint')).toBe('unknown');
  });

  it('unwraps a double-wrapped envelope (market/rank style) defensively', async () => {
    const f = fakeFetch({
      '/v1/token/security': () => ({
        code: 0,
        data: { code: 0, message: 'success', data: SECURITY_FIXTURE.data },
      }),
      '/v1/token/info': 'http500',
    });
    const r = await new GmgnClient('k', f).enrich('mint');
    expect(r).not.toBe('unknown');
    if (r === 'unknown') throw new Error('unreachable');
    expect(r.buyTaxPct).toBe(0);
    expect(r.top10Pct).toBe(21.42);
  });

  it('treats is_honeypot: 1 as true and a plain 0 as false (only null/missing is unknown)', async () => {
    const hpTrue = fakeFetch({
      '/v1/token/security': () => ({ ...SECURITY_FIXTURE, data: { ...SECURITY_FIXTURE.data, is_honeypot: 1 } }),
      '/v1/token/info': 'http500',
    });
    const rTrue = await new GmgnClient('k', hpTrue).enrich('mint');
    if (rTrue === 'unknown') throw new Error('unreachable');
    expect(rTrue.honeypot).toBe(true);

    const hpFalse = fakeFetch({
      '/v1/token/security': () => ({ ...SECURITY_FIXTURE, data: { ...SECURITY_FIXTURE.data, is_honeypot: 0 } }),
      '/v1/token/info': 'http500',
    });
    const rFalse = await new GmgnClient('k', hpFalse).enrich('mint');
    if (rFalse === 'unknown') throw new Error('unreachable');
    expect(rFalse.honeypot).toBe(false);
  });
});
