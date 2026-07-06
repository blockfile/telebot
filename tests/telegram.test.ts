import { describe, it, expect } from 'vitest';
import { escapeHtml, formatAlert, formatFollowUp, Telegram, type AlertData } from '../src/telegram';

const DATA: AlertData = {
  mint: 'MintPubkey111', name: 'Cool <Token>', symbol: 'COOL', score: 74,
  flags: ['top10 35%'], marketCapUsd: 18400, volumeUsd: 27600, ageMinutes: 23, uniqueBuyers: 41,
  devBuyPct: 2.1, devStillHolds: true, priorLaunches: 0, top10Pct: 21,
  twitter: 'https://x.com/dev', telegram: 'https://t.me/c', website: undefined,
  bundlePct: 8, first20Pct: 31, devOutflowPct: 0,
};

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('formatAlert', () => {
  it('renders the full alert with escaped name, copyable CA, links, and flags', () => {
    const text = formatAlert(DATA);
    expect(text).toContain('⚡ <b>$COOL</b> — score 74/100'); // 74 -> ⚡ (grade tested separately)
    expect(text).toContain('Cool &lt;Token&gt;');
    expect(text).toContain('💰 MC $18.4k   📊 Vol $27.6k');
    expect(text).toContain('⏱️ Age 23m   👥 Buyers 41');
    expect(text).toContain('\nMintPubkey111\n'); // bare CA on its own line
    expect(text).not.toContain('<code>'); // bare CA so scanner bots / userbots can parse it
    expect(text).not.toContain('CA:');
    expect(text).toContain('🧑‍💻 Dev: 2.1% · still holds · 0 priors');
    expect(text).toContain('🏆 Top 10: 21%');
    expect(text).toContain('🔗 𝕏 ✅   TG ✅   Web ❌');
    expect(text).toContain('https://pump.fun/coin/MintPubkey111');
    expect(text).toContain('https://gmgn.ai/sol/token/MintPubkey111');
    expect(text).toContain('https://solscan.io/token/MintPubkey111');
    expect(text).toContain('https://rugcheck.xyz/tokens/MintPubkey111');
    expect(text).toContain('🎯 Bundle 8% · First-20 31% · Dev-out 0%');
    expect(text).toContain('⚠️ top10 35%');
  });

  it('picks the lead emoji from the score', () => {
    expect(formatAlert({ ...DATA, score: 85 }).startsWith('🔥')).toBe(true);
    expect(formatAlert({ ...DATA, score: 74 }).startsWith('⚡')).toBe(true);
    expect(formatAlert({ ...DATA, score: 62 }).startsWith('✅')).toBe(true);
  });

  it('renders unknowns as ? and omits flag line when empty', () => {
    const text = formatAlert({ ...DATA, priorLaunches: 'unknown', top10Pct: 'unknown', flags: [] });
    expect(text).toContain('· ? priors');
    expect(text).toContain('🏆 Top 10: ?');
    expect(text).not.toContain('⚠️');
  });

  it('renders unknown launch values as ?', () => {
    const text = formatAlert({ ...DATA, bundlePct: 'unknown', first20Pct: 'unknown', devOutflowPct: 'unknown' });
    expect(text).toContain('🎯 Bundle ? · First-20 ? · Dev-out ?');
  });
});

describe('formatFollowUp', () => {
  it('renders a window follow-up with peak and current performance', () => {
    const s = formatFollowUp({ symbol: 'COOL', reason: 'window', peakUsd: 22000, nowUsd: 9000, peakPct: 47, nowPct: -40 });
    expect(s).toContain('$COOL');
    expect(s).toContain('peaked $22.0k (+47%)');
    expect(s).toContain('now $9.0k (-40% since alert)');
    expect(s).not.toContain('⚠️');
  });

  it('leads dump follow-ups with a warning', () => {
    expect(formatFollowUp({ symbol: 'RUG', reason: 'dump', peakUsd: 30000, nowUsd: 6000, peakPct: 100, nowPct: -80 })).toContain('⚠️');
  });
});

describe('Telegram', () => {
  it('posts to the bot API and returns true on ok', async () => {
    let captured: { url: string; body: string } | null = null;
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body) };
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await new Telegram('TOKEN', '42', f).send('hello');
    expect(ok).toBe(true);
    expect(captured!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(captured!.body);
    expect(body).toMatchObject({ chat_id: '42', text: 'hello', parse_mode: 'HTML' });
  });

  it('returns false after 3 failures without throwing', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('err', { status: 400 }); }) as unknown as typeof fetch;
    expect(await new Telegram('T', '1', f).send('x')).toBe(false);
    expect(calls).toBe(3);
  });

  it('waits out a 429 using retry_after then succeeds', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) {
        return new Response('{"ok":false,"parameters":{"retry_after":0}}', { status: 429 });
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const start = Date.now();
    const ok = await new Telegram('T', '1', f).send('x');
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900); // waited (0 + 1)s
  }, 10_000);
});
