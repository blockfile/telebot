import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GmgnClient, gmgnStars, type GmgnEnrichment } from '../src/checks/gmgn';

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
      washTrading: 'unknown', // per-token endpoints don't carry is_wash_trading; flags empty → unknown
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

  it('reads is_wash_trading when GMGN provides it, else degrades to unknown', async () => {
    const withFlag = fakeFetch({
      '/v1/token/security': () => ({ ...SECURITY_FIXTURE, data: { ...SECURITY_FIXTURE.data, is_wash_trading: true } }),
      '/v1/token/info': 'http500',
    });
    const r = await new GmgnClient('k', withFlag).enrich('mint');
    if (r === 'unknown') throw new Error('unreachable');
    expect(r.washTrading).toBe(true);

    // The real captured fixtures carry no is_wash_trading and an empty flags[] → unknown, never false.
    const clean = fakeFetch({ '/v1/token/security': () => SECURITY_FIXTURE, '/v1/token/info': () => INFO_FIXTURE });
    const rc = await new GmgnClient('k', clean).enrich('mint');
    if (rc === 'unknown') throw new Error('unreachable');
    expect(rc.washTrading).toBe('unknown');
  });

  it('detects a wash-trading entry in the security flags array', async () => {
    const flagged = fakeFetch({
      '/v1/token/security': () => ({ ...SECURITY_FIXTURE, data: { ...SECURITY_FIXTURE.data, flags: ['wash_trading'] } }),
      '/v1/token/info': 'http500',
    });
    const r = await new GmgnClient('k', flagged).enrich('mint');
    if (r === 'unknown') throw new Error('unreachable');
    expect(r.washTrading).toBe(true);
  });
});

describe('gmgnStars', () => {
  const g = (over: Partial<GmgnEnrichment> = {}): GmgnEnrichment => ({
    smartMoneyCount: 0, kolCount: 0, honeypot: false, washTrading: false,
    buyTaxPct: 0, sellTaxPct: 0, top10Pct: 20, ...over,
  });

  it('starts neutral at 3 with no positives or negatives', () => {
    expect(gmgnStars(g())).toBe(3);
  });

  it('adds a star each for smart money present and KOL present (max via positives = 5)', () => {
    expect(gmgnStars(g({ smartMoneyCount: 1 }))).toBe(4);
    expect(gmgnStars(g({ kolCount: 1 }))).toBe(4);
    expect(gmgnStars(g({ smartMoneyCount: 5, kolCount: 3 }))).toBe(5);
  });

  it('subtracts a star each for confirmed honeypot, wash trading, and sell-tax over 10%', () => {
    expect(gmgnStars(g({ honeypot: true }))).toBe(2);
    expect(gmgnStars(g({ washTrading: true }))).toBe(2);
    expect(gmgnStars(g({ sellTaxPct: 11 }))).toBe(2);
    expect(gmgnStars(g({ sellTaxPct: 10 }))).toBe(3); // exactly 10% is not "over" — stays neutral
  });

  it('treats unknown/null fields as NEUTRAL — never subtracts on unknown', () => {
    expect(gmgnStars(g({ honeypot: 'unknown', washTrading: 'unknown', sellTaxPct: 'unknown', smartMoneyCount: 'unknown', kolCount: 'unknown' }))).toBe(3);
  });

  it('clamps to 1..5 at both ends', () => {
    // all positives + no negatives can only reach 5
    expect(gmgnStars(g({ smartMoneyCount: 9, kolCount: 9 }))).toBe(5);
    // all three negatives, no positives: 3 - 3 = 0 → clamped to 1
    expect(gmgnStars(g({ honeypot: true, washTrading: true, sellTaxPct: 50 }))).toBe(1);
  });

  it('a mixed token nets out (e.g. smart money present but a honeypot)', () => {
    expect(gmgnStars(g({ smartMoneyCount: 2, honeypot: true }))).toBe(3); // 3 +1 -1
  });
});
