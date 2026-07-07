import { describe, it, expect } from 'vitest';
import { ipfsToHttp, extractMeta, fetchMeta } from '../src/checks/metadata';

describe('ipfsToHttp', () => {
  it('converts ipfs:// and passes through https://', () => {
    expect(ipfsToHttp('ipfs://QmAbc')).toBe('https://ipfs.io/ipfs/QmAbc');
    expect(ipfsToHttp('https://ipfs.io/ipfs/QmAbc')).toBe('https://ipfs.io/ipfs/QmAbc');
  });
});

describe('extractMeta', () => {
  it('extracts trimmed social + image fields, dropping empties', () => {
    expect(extractMeta({ twitter: ' https://x.com/dev ', telegram: '', website: 'cool.io', image: ' ipfs://QmImg ' }))
      .toEqual({ twitter: 'https://x.com/dev', telegram: undefined, website: 'cool.io', image: 'ipfs://QmImg' });
    expect(extractMeta(null)).toEqual({ twitter: undefined, telegram: undefined, website: undefined, image: undefined });
  });
});

describe('fetchMeta', () => {
  it('returns parsed meta on success', async () => {
    const f = (async () => new Response('{"twitter":"https://x.com/dev","image":"ipfs://QmImg"}', { status: 200 })) as unknown as typeof fetch;
    expect(await fetchMeta('https://meta.uri', f)).toEqual({ twitter: 'https://x.com/dev', telegram: undefined, website: undefined, image: 'ipfs://QmImg' });
  });

  it("returns 'unknown' when both attempts fail", async () => {
    let calls = 0;
    const f = (async () => { calls++; throw new Error('net'); }) as unknown as typeof fetch;
    expect(await fetchMeta('https://meta.uri', f)).toBe('unknown');
    expect(calls).toBe(2);
  });
});
