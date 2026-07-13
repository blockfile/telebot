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
  liquidityUsd: 12300, ageMinutes: 23, uniqueBuyers: 41, holderCount: 341, feesSol: 1.4,
  devBuyPct: 2.1, devStillHolds: true, priorLaunches: 0, top10Pct: 21,
  twitter: 'https://x.com/dev', telegram: 'https://t.me/c', website: undefined,
  bundlePct: 8, bundleCount: 3, bundleHeldPct: 3,
  sniperCount: 5, sniperPct: 12, sniperHeldPct: 4,
  first20Pct: 31, devOutflowPct: 0,
};

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });
});

describe('formatAlert', () => {
  it('renders the full alert with escaped name, copyable CA, links, and flags', () => {
    const text = formatAlert(DATA);
    expect(text).toContain('⚡ <b>$COOL</b> • Cool &lt;Token&gt;'); // 74 -> ⚡ (grade tested separately)
    expect(text).toContain('⭐ Score: 74/100 | ⏱ 23m');
    expect(text).toContain('💰 MC: $18.4k • ⇡ top $24.0k');
    expect(text).toContain('💧 Liq: $12.3k');
    expect(text).toContain('📊 Vol: $27.6k • 🪙 ~1.4 SOL fees');
    expect(text).toContain('👥 Hodls: 341 | Buyers: 41');
    expect(text).toContain('<code>MintPubkey111</code>'); // CA is tap-to-copy
    expect(text).toContain('📦 Bundles: 3 • 8% → 3% 🟡'); // held 3/8 = 37% -> trimming
    expect(text).toContain('🔫 Snipers: 5 • 12% → 4% 🟡');
    expect(text).toContain('🎯 First 20: 31%');
    expect(text).toContain('🛠 Dev: 2.1% | Out: 0% | Priors: 0');
    expect(text).toContain('🏆 Top 10: 21%');
    expect(text).toContain('🐦 <a href="https://x.com/dev">X ✅</a> | <a href="https://t.me/c">TG ✅</a> | Web ❌');
    expect(text).toContain('⚠️ top10 35%');
    expect(text).not.toContain('📈 Now:'); // no live line unless live data is passed
  });

  it('links full-URL socials as-is and normalizes bare handles into clickable links', () => {
    // full URLs (the pump.fun norm) pass through
    expect(formatAlert(DATA)).toContain('🐦 <a href="https://x.com/dev">X ✅</a> | <a href="https://t.me/c">TG ✅</a> | Web ❌');
    // bare handles get built into platform URLs
    const handles = formatAlert({ ...DATA, twitter: '@coolproj', telegram: 'coolportal', website: 'coolproj.io' });
    expect(handles).toContain('<a href="https://x.com/coolproj">X ✅</a>');
    expect(handles).toContain('<a href="https://t.me/coolportal">TG ✅</a>');
    expect(handles).toContain('<a href="https://coolproj.io">Web ✅</a>');
  });

  it('renders the live Now line and held-trend emojis', () => {
    const live = formatAlert({ ...DATA, live: { nowUsd: 48200, multiple: 3.1 } });
    expect(live).toContain('📈 Now: $48.2k • 3.1X');
    // holding (>=70%) and dumped (<30%) trends
    expect(formatAlert({ ...DATA, bundlePct: 10, bundleHeldPct: 9 })).toContain('📦 Bundles: 3 • 10% → 9% 💚');
    expect(formatAlert({ ...DATA, bundlePct: 10, bundleHeldPct: 1 })).toContain('📦 Bundles: 3 • 10% → 1% 🔻');
    expect(formatAlert({ ...DATA, bundlePct: 0, bundleHeldPct: 0, bundleCount: 0 })).toContain('📦 Bundles: 0 • 0%\n');
    expect(formatAlert({ ...DATA, bundlePct: 8, bundleHeldPct: 'unknown' })).toContain('📦 Bundles: 3 • 8% → ?');
  });

  it('picks the lead emoji from the score', () => {
    expect(formatAlert({ ...DATA, score: 85 }).startsWith('🔥')).toBe(true);
    expect(formatAlert({ ...DATA, score: 74 }).startsWith('⚡')).toBe(true);
    expect(formatAlert({ ...DATA, score: 62 }).startsWith('✅')).toBe(true);
  });

  it('renders unknowns as ? and omits flag line when empty', () => {
    const text = formatAlert({ ...DATA, priorLaunches: 'unknown', top10Pct: 'unknown', holderCount: 'unknown', flags: [] });
    expect(text).toContain('Priors: ?');
    expect(text).toContain('🏆 Top 10: ?');
    expect(text).toContain('👥 Hodls: ? | Buyers: 41');
    expect(text).not.toContain('⚠️');
  });

  it('renders unknown launch values as ?', () => {
    const text = formatAlert({
      ...DATA, bundlePct: 'unknown', bundleCount: 'unknown', bundleHeldPct: 'unknown',
      sniperCount: 'unknown', sniperPct: 'unknown', sniperHeldPct: 'unknown',
      first20Pct: 'unknown', devOutflowPct: 'unknown',
    });
    expect(text).toContain('📦 Bundles: ?');
    expect(text).toContain('🔫 Snipers: ?');
    expect(text).toContain('🎯 First 20: ?');
    expect(text).toContain('Out: ?');
  });

  it('omits the GMGN line entirely when gmgn is absent (flag off / disabled default)', () => {
    const text = formatAlert(DATA);
    expect(text).not.toContain('🧠 Smart');
    expect(text).not.toContain('GMGN:');
  });

  it('renders the GMGN star rating + icon’d smart-money/KOL (and NO security/tax line)', () => {
    const text = formatAlert({
      ...DATA,
      gmgn: { smartMoneyCount: 3, kolCount: 4, honeypot: false, washTrading: false, buyTaxPct: 0, sellTaxPct: 5, top10Pct: 21 },
    });
    // smart money + KOL present, no negatives → 5★
    expect(text).toContain('⭐ GMGN: ⭐⭐⭐⭐⭐ · 🧠 Smart: 3 · 👑 KOL: 4');
    // the noisy security/tax line is gone
    expect(text).not.toContain('🛡 Security');
    expect(text).not.toContain('Tax ');
  });

  it('renders a partial star bar with empty stars (☆)', () => {
    const text = formatAlert({
      ...DATA,
      gmgn: { smartMoneyCount: 2, kolCount: 0, honeypot: false, washTrading: false, buyTaxPct: 0, sellTaxPct: 0, top10Pct: 21 },
    });
    // smart money present only → 4★ → ⭐⭐⭐⭐☆
    expect(text).toContain('⭐ GMGN: ⭐⭐⭐⭐☆ · 🧠 Smart: 2 · 👑 KOL: 0');
  });

  it('appends an inline HONEYPOT / WASH warning to the GMGN line (no separate security line)', () => {
    const text = formatAlert({
      ...DATA,
      gmgn: { smartMoneyCount: 0, kolCount: 0, honeypot: true, washTrading: true, buyTaxPct: 99, sellTaxPct: 99, top10Pct: 90 },
    });
    // honeypot + wash + high tax, no positives → 1★ (clamped), warnings appended inline
    expect(text).toContain('⭐ GMGN: ⭐☆☆☆☆ · 🧠 Smart: 0 · 👑 KOL: 0 · ⚠️ HONEYPOT · 🧼 WASH');
    expect(text).not.toContain('🛡 Security');
  });

  it('renders GMGN unknown counts as ? without dropping the line or warning (neutral 3★)', () => {
    const text = formatAlert({
      ...DATA,
      gmgn: { smartMoneyCount: 'unknown', kolCount: 'unknown', honeypot: 'unknown', washTrading: 'unknown', buyTaxPct: 'unknown', sellTaxPct: 'unknown', top10Pct: 'unknown' },
    });
    // all-unknown is neutral → 3★, no honeypot/wash warning (only fires on confirmed true)
    expect(text).toContain('⭐ GMGN: ⭐⭐⭐☆☆ · 🧠 Smart: ? · 👑 KOL: ?');
    expect(text).not.toContain('HONEYPOT');
    expect(text).not.toContain('🛡 Security');
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

  it('appends a top-10 trend line when both measurements are known, omits it otherwise', () => {
    const withTrend = formatFollowUp({
      kind: 'up', symbol: 'PAM', mint: 'm', multiple: 2, fromUsd: 1000, peakUsd: 2000,
      top10From: 28, top10Now: 21,
    });
    expect(withTrend).toContain('🏆 Top10 28% → 21%');
    const noTrend = formatFollowUp({
      kind: 'window', symbol: 'C', mint: 'm', peakUsd: 1, nowUsd: 1, peakPct: 0, nowPct: 0,
      top10From: 28, top10Now: 'unknown',
    });
    expect(noTrend).not.toContain('🏆');
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
    const r = await new Telegram('TOKEN', '42', f).send('hello');
    expect(r.ok).toBe(true);
    expect(captured!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const body = JSON.parse(captured!.body);
    expect(body).toMatchObject({ chat_id: '42', text: 'hello', parse_mode: 'HTML' });
  });

  it('returns false after 3 failures without throwing', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('err', { status: 400 }); }) as unknown as typeof fetch;
    expect((await new Telegram('T', '1', f).send('x')).ok).toBe(false);
    expect(calls).toBe(3);
  });

  it('sends an alert as a text message with a large image preview above (not a photo caption)', async () => {
    const captured: Array<{ url: string; body: any }> = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true,"result":{"message_id":777}}', { status: 200 });
    }) as unknown as typeof fetch;
    const buttons = [[{ text: 'Chart', url: 'https://c' }]];
    const r = await new Telegram('T', '42', f).send({ text: 'cap', photoUrl: 'https://img', buttons });
    // delivered as TEXT (photo:false) so the <code> CA is tap-to-copy on mobile
    expect(r).toMatchObject({ ok: true, messageId: 777, photo: false });
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.telegram.org/botT/sendMessage');
    expect(captured[0].body).toMatchObject({
      chat_id: '42', text: 'cap', parse_mode: 'HTML',
      link_preview_options: { url: 'https://img', prefer_large_media: true, show_above_text: true },
      reply_markup: { inline_keyboard: buttons },
    });
  });

  it('sends plain text with the preview disabled when there is no image', async () => {
    const captured: Array<{ url: string; body: any }> = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true,"result":{"message_id":1}}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await new Telegram('T', '1', f).send({ text: 'cap' });
    expect(r.photo).toBe(false);
    expect(captured[0].url).toBe('https://api.telegram.org/botT/sendMessage');
    expect(captured[0].body.link_preview_options).toMatchObject({ is_disabled: false });
    expect(captured[0].body.link_preview_options.url).toBeUndefined();
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
    const r = await new Telegram('T', '1', f).send('x');
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(900); // waited (0 + 1)s
  }, 10_000);

  it('editCaption edits via editMessageText, keeps the large image preview, and resends buttons', async () => {
    const captured: Array<{ url: string; body: any }> = [];
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const buttons = [[{ text: 'Chart', url: 'https://c' }]];
    const ok = await new Telegram('T', '42', f).editCaption(777, 'updated', buttons, 'https://img');
    expect(ok).toBe(true);
    expect(captured[0].url).toBe('https://api.telegram.org/botT/editMessageText');
    expect(captured[0].body).toMatchObject({
      chat_id: '42', message_id: 777, text: 'updated', parse_mode: 'HTML',
      link_preview_options: { url: 'https://img', prefer_large_media: true, show_above_text: true },
      reply_markup: { inline_keyboard: buttons }, // an edit without reply_markup drops the buttons
    });
  });

  it('editCaption without an image still uses editMessageText (preview disabled)', async () => {
    let url = ''; let body: any;
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => { url = String(u); body = JSON.parse(String(init?.body)); return new Response('{"ok":true}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await new Telegram('T', '1', f).editCaption(5, 'x', [])).toBe(true);
    expect(url).toBe('https://api.telegram.org/botT/editMessageText');
    expect(body.link_preview_options).toMatchObject({ is_disabled: false });
  });

  it("editCaption treats 'message is not modified' as success and does not retry", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response('{"ok":false,"description":"Bad Request: message is not modified"}', { status: 400 });
    }) as unknown as typeof fetch;
    expect(await new Telegram('T', '1', f).editCaption(5, 'same', [], 'https://img')).toBe(true);
    expect(calls).toBe(1);
  });
});
