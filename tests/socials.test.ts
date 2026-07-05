import { describe, it, expect } from 'vitest';
import { normalizeTwitterHandle, normalizeUrl } from '../src/checks/socials';

describe('normalizeTwitterHandle', () => {
  it('normalizes urls, bare handles, and @handles to lowercase', () => {
    expect(normalizeTwitterHandle('https://twitter.com/CoolDev')).toBe('cooldev');
    expect(normalizeTwitterHandle('https://x.com/CoolDev?s=21')).toBe('cooldev');
    expect(normalizeTwitterHandle('x.com/CoolDev/status/123')).toBe('cooldev');
    expect(normalizeTwitterHandle('@CoolDev')).toBe('cooldev');
    expect(normalizeTwitterHandle('CoolDev')).toBe('cooldev');
  });

  it('maps X communities to community:<id>', () => {
    expect(normalizeTwitterHandle('https://x.com/i/communities/1234567890')).toBe('community:1234567890');
  });

  it('returns null for junk and reserved paths', () => {
    expect(normalizeTwitterHandle('https://example.com/foo')).toBeNull();
    expect(normalizeTwitterHandle('https://x.com/search?q=a')).toBeNull();
    expect(normalizeTwitterHandle('')).toBeNull();
    expect(normalizeTwitterHandle('has spaces!!')).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('prefixes https:// only when missing', () => {
    expect(normalizeUrl('t.me/coolcoin')).toBe('https://t.me/coolcoin');
    expect(normalizeUrl('http://coolcoin.io')).toBe('http://coolcoin.io');
  });
});
