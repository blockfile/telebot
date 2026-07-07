import { describe, it, expect } from 'vitest';
import { escapeHtml, formatAlert, formatFollowUp, buildButtons, Telegram, type AlertData } from '../src/telegram';

const BTN_CFG = {
  buy: [{ label: '⚡ Trojan', url: 'https://t.me/solana_trojanbot?start={CA}' }],
  chart: true, scan: true, pumpfun: true,
};

describe('buildButtons', () => {
  it('builds a buy row and a web row, substituting {CA}', () => {
    const kb = buildButtons('MINT1', BTN_CFG);
    expect(kb[0]).toEqual([{ text: '⚡ Trojan', url: 'https://t.me/solana_trojanbot?start=MINT1' }]);
    expect(kb[1]).toEqual([
      { text: '📊 Chart', url: 'https://gmgn.ai/sol/token/MINT1' },
      { text: '🛡 Scan', url: 'https://rugcheck.xyz/tokens/MINT1' },
      { text: '🌐 pump.fun', url: 'https://pump.fun/coin/MINT1' },
    ]);
  });

  it('honors the web whitelist (for follow-ups) and disabled flags', () => {
    const kb = buildButtons('MINT1', BTN_CFG, { web: ['chart', 'pumpfun'] });
    expect(kb[1].map((b) => b.text)).toEqual(['📊 Chart', '🌐 pump.fun']);
    const off = buildButtons('MINT1', { buy: [], chart: false, scan: false, pumpfun: false });
    expect(off).toEqual([]);
  });
});

const DATA: AlertData = {
  mint: 'MintPubkey111', name: 'Cool <Token>', symbol: 'COOL', score: 74,
  flags: ['top10 35%'], marketCapUsd: 18400, topMarketCapUsd: 24000, volumeUsd: 27600,
  liquidityUsd: 12300, ageMinutes: 23, uniqueBuyers: 41, holderCount: 341,
  devBuyPct: 2.1, devStillHolds: true, priorLaunches: 0, top10Pct: 21,
  twitter: 'https://x.com/dev', telegram: 'https://t.me/c', website: undefined,
  bundlePct: 8, sniperCount: 5, sniperPct: 12, first20Pct: 31, devOutflowPct: 0,
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
    expect(text).toContain('💰 MC $18.4k (top $24.0k) · 📊 Vol $27.6k · ⏱️ 23m');
    expect(text).toContain('💧 Liq $12.3k · 👥 41 buyers · 🙋 341 holders');
    expect(text).toContain('<code>MintPubkey111</code>'); // CA is tap-to-copy
    expect(text).toContain('🧑‍💻 Dev: 2.1% · still holds · 0 priors');
    expect(text).toContain('🏆 Top 10: 21%');
    expect(text).toContain('🔗 𝕏 ✅   TG ✅   Web ❌');
    expect(text).toContain('🎯 Bundle 8% · Snipers 5 (12%) · First-20 31% · Dev-out 0%');
    expect(text).toContain('⚠️ top10 35%');
    // links are now buttons, not inline text in the caption
    expect(text).not.toContain('href=');
  });

  it('picks the lead emoji from the score', () => {
    expect(formatAlert({ ...DATA, score: 85 }).startsWith('🔥')).toBe(true);
    expect(formatAlert({ ...DATA, score: 74 }).startsWith('⚡')).toBe(true);
    expect(formatAlert({ ...DATA, score: 62 }).startsWith('✅')).toBe(true);
  });

  it('renders unknowns as ? and omits flag line when empty', () => {
    const text = formatAlert({ ...DATA, priorLaunches: 'unknown', top10Pct: 'unknown', holderCount: 'unknown', flags: [] });
    expect(text).toContain('· ? priors');
    expect(text).toContain('🏆 Top 10: ?');
    expect(text).toContain('🙋 ? holders');
    expect(text).not.toContain('⚠️');
  });

  it('renders unknown launch values as ?', () => {
    const text = formatAlert({ ...DATA, bundlePct: 'unknown', sniperCount: 'unknown', sniperPct: 'unknown', first20Pct: 'unknown', devOutflowPct: 'unknown' });
    expect(text).toContain('🎯 Bundle ? · Snipers ? · First-20 ? · Dev-out ?');
  });
});

describe('formatFollowUp', () => {
  it('renders an up-Nx card with the multiple, move, and rockets', () => {
    const s = formatFollowUp({ kind: 'up', symbol: 'PAM', mint: 'MintX', multiple: 5, fromUsd: 39600, peakUsd: 198000 });
    expect(s).toContain('$PAM</b> is up 5X');
    expect(s).toContain('$39.6k → $198.0k');
    expect(s).toContain('🚀🚀🚀🚀🚀');
    expect(s).toContain('<code>MintX</code>');
  });

  it('caps the rocket row at 10', () => {
    const s = formatFollowUp({ kind: 'up', symbol: 'X', mint: 'm', multiple: 100, fromUsd: 1000, peakUsd: 100000 });
    expect(s).toContain('is up 100X');
    expect((s.match(/🚀/g) ?? []).length).toBe(10);
  });

  it('renders a window recap with peak and current performance', () => {
    const s = formatFollowUp({ kind: 'window', symbol: 'COOL', mint: 'm', peakUsd: 22000, nowUsd: 9000, peakPct: 47, nowPct: -40 });
    expect(s).toContain('$COOL');
    expect(s).toContain('peaked $22.0k (+47%)');
    expect(s).toContain('now $9.0k (-40% since alert)');
    expect(s).not.toContain('⚠️');
  });

  it('leads dump follow-ups with a warning', () => {
    expect(formatFollowUp({ kind: 'dump', symbol: 'RUG', mint: 'm', peakUsd: 30000, nowUsd: 6000, peakPct: 100, nowPct: -80 })).toContain('⚠️');
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

  it('sends a photo card with caption and inline buttons', async () => {
    const captured: Array<{ url: string; body: any }> = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const buttons = [[{ text: 'Chart', url: 'https://c' }]];
    const ok = await new Telegram('T', '42', f).send({ text: 'cap', photoUrl: 'https://img', buttons });
    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.telegram.org/botT/sendPhoto');
    expect(captured[0].body).toMatchObject({
      chat_id: '42', photo: 'https://img', caption: 'cap', parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
  });

  it('falls back to a text message when the photo cannot be sent', async () => {
    const urls: string[] = [];
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      urls.push(u);
      // sendPhoto always fails (e.g. Telegram can't fetch the IPFS image); sendMessage succeeds
      return u.endsWith('/sendPhoto')
        ? new Response('{"ok":false,"description":"wrong file"}', { status: 400 })
        : new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await new Telegram('T', '1', f).send({ text: 'cap', photoUrl: 'https://bad' });
    expect(ok).toBe(true);
    expect(urls.some((u) => u.endsWith('/sendPhoto'))).toBe(true);
    expect(urls.some((u) => u.endsWith('/sendMessage'))).toBe(true);
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
