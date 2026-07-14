import type { ButtonsConfig } from './config';
import { gmgnStars, type GmgnEnrichment, type GradSnapshot } from './checks/gmgn';
import { log } from './logger';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface InlineButton {
  text: string;
  url: string;
}
export type Keyboard = InlineButton[][];

const WEB_BUTTONS: Record<'chart' | 'scan' | 'pumpfun', { text: string; url: (mint: string) => string }> = {
  chart: { text: '📊 Chart', url: (m) => `https://gmgn.ai/sol/token/${m}` },
  scan: { text: '🛡 Scan', url: (m) => `https://rugcheck.xyz/tokens/${m}` },
  pumpfun: { text: '🌐 pump.fun', url: (m) => `https://pump.fun/coin/${m}` },
};

/** Build the inline keyboard for a token: a Buy row (config referral links) + a web row. */
export function buildButtons(
  mint: string,
  cfg: ButtonsConfig,
  opts: { web?: Array<'chart' | 'scan' | 'pumpfun'> } = {},
): Keyboard {
  const rows: Keyboard = [];
  const buyRow = cfg.buy.map((b) => ({ text: b.label, url: b.url.replaceAll('{CA}', mint) }));
  if (buyRow.length) rows.push(buyRow);

  const webKeys = opts.web ?? ['chart', 'scan', 'pumpfun'];
  const webRow = webKeys
    .filter((k) => cfg[k])
    .map((k) => ({ text: WEB_BUTTONS[k].text, url: WEB_BUTTONS[k].url(mint) }));
  if (webRow.length) rows.push(webRow);

  return rows;
}

export interface AlertData {
  mint: string;
  name: string;
  symbol: string;
  score: number;
  flags: string[];
  marketCapUsd: number;
  topMarketCapUsd: number;
  volumeUsd: number;
  liquidityUsd: number;
  ageMinutes: number;
  uniqueBuyers: number;
  holderCount: number | 'unknown';
  feesSol: number;
  devBuyPct: number;
  devStillHolds: boolean;
  priorLaunches: number | 'unknown';
  top10Pct: number | 'unknown';
  bundlePct: number | 'unknown';
  bundleCount: number | 'unknown';
  bundleHeldPct: number | 'unknown';
  sniperCount: number | 'unknown';
  sniperPct: number | 'unknown';
  sniperHeldPct: number | 'unknown';
  first20Pct: number | 'unknown';
  devOutflowPct: number | 'unknown';
  twitter?: string;
  telegram?: string;
  website?: string;
  /** When present, a self-updating "Now" line is rendered (live-edited cards). */
  live?: { nowUsd: number; multiple: number };
  /** GMGN enrichment (smart-money/KOL + security cross-check). Present only when config.json
   * gmgn.enabled is true AND the fetch returned at least partial data — undefined otherwise,
   * in which case the card renders exactly as it did before this feature existed. */
  gmgn?: GmgnEnrichment;
}

/** bought -> held row, with a trend emoji: 💚 holding (>=70%), 🟡 trimming, 🔻 dumped (<30%). */
function heldArrow(boughtPct: number | 'unknown', heldPct: number | 'unknown'): string {
  if (boughtPct === 'unknown') return '?';
  const bought = `${boughtPct.toFixed(0)}%`;
  if (boughtPct === 0) return bought;
  if (heldPct === 'unknown') return `${bought} → ?`;
  const ratio = heldPct / boughtPct;
  const trend = ratio >= 0.7 ? '💚' : ratio >= 0.3 ? '🟡' : '🔻';
  return `${bought} → ${heldPct.toFixed(0)}% ${trend}`;
}

export function formatAlert(d: AlertData): string {
  const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`);
  // Clickable social: link the label to the token's page. pump.fun metadata usually stores a full
  // URL, but tolerate a bare handle (e.g. "@dev" / "dev") by building the platform URL from it.
  const socialUrl = (label: 'X' | 'TG' | 'Web', v: string): string => {
    if (/^https?:\/\//i.test(v)) return v;
    const h = v.replace(/^@/, '').replace(/^\/+/, '');
    return label === 'X' ? `https://x.com/${h}` : label === 'TG' ? `https://t.me/${h}` : `https://${h}`;
  };
  const socialLink = (label: 'X' | 'TG' | 'Web', url: string | undefined) =>
    url ? `<a href="${escapeHtml(socialUrl(label, url))}">${label} ✅</a>` : `${label} ❌`;
  const top10 = d.top10Pct === 'unknown' ? '?' : `${d.top10Pct.toFixed(0)}%`;
  const priors = d.priorLaunches === 'unknown' ? '?' : String(d.priorLaunches);
  const holders = d.holderCount === 'unknown' ? '?' : String(d.holderCount);
  const pctOrQ = (v: number | 'unknown') => (v === 'unknown' ? '?' : `${v.toFixed(0)}%`);
  const sniperLead = d.sniperCount === 'unknown' ? '?' : `${d.sniperCount} • ${heldArrow(d.sniperPct, d.sniperHeldPct)}`;
  const bundleLead = d.bundleCount === 'unknown' ? '?' : `${d.bundleCount} • ${heldArrow(d.bundlePct, d.bundleHeldPct)}`;
  const grade = d.score >= 80 ? '🔥' : d.score >= 70 ? '⚡' : '✅';

  let gmgnLines: string[] = [];
  if (d.gmgn) {
    const g = d.gmgn;
    const stars = gmgnStars(g);
    const starStr = '⭐'.repeat(stars) + '☆'.repeat(5 - stars);
    const smart = g.smartMoneyCount === 'unknown' ? '?' : String(g.smartMoneyCount);
    const kol = g.kolCount === 'unknown' ? '?' : String(g.kolCount);
    // Solana pump.fun tokens have no buy/sell tax and GMGN's security/tax often reads '?', so that
    // line was pure noise — dropped. Keep the ⭐ quality rating + smart-money/KOL with icons, and
    // surface an inline warning ONLY when GMGN actually confirms a honeypot / wash-trading.
    const warns: string[] = [];
    if (g.honeypot === true) warns.push('⚠️ HONEYPOT');
    if (g.washTrading === true) warns.push('🧼 WASH');
    const warnTag = warns.length ? ` · ${warns.join(' · ')}` : '';
    gmgnLines = [
      '',
      `⭐ GMGN: ${starStr} · 🧠 Smart: ${smart} · 👑 KOL: ${kol}${warnTag}`,
    ];
  }

  const lines = [
    `${grade} <b>$${escapeHtml(d.symbol)}</b> • ${escapeHtml(d.name)}`,
    `⭐ Score: ${d.score}/100 | ⏱ ${d.ageMinutes}m`,
  ];
  if (d.live) lines.push(`📈 Now: ${usd(d.live.nowUsd)} • ${d.live.multiple.toFixed(1)}X`);
  if (d.flags.length) lines.push(`⚠️ ${d.flags.map(escapeHtml).join(' · ')}`);
  lines.push(
    '',
    `💰 MC: ${usd(d.marketCapUsd)} • ⇡ top ${usd(d.topMarketCapUsd)}`,
    `💧 Liq: ${usd(d.liquidityUsd)}`,
    `📊 Vol: ${usd(d.volumeUsd)} • 🪙 ~${d.feesSol.toFixed(1)} SOL fees`,
    `👥 Hodls: ${holders} | Buyers: ${d.uniqueBuyers}`,
    '',
    `📦 Bundles: ${bundleLead}`,
    `🔫 Snipers: ${sniperLead}`,
    `🎯 First 20: ${pctOrQ(d.first20Pct)}`,
    `🛠 Dev: ${d.devBuyPct.toFixed(1)}% | Out: ${pctOrQ(d.devOutflowPct)} | Priors: ${priors}`,
    `🏆 Top 10: ${top10}`,
    '',
    `🐦 ${socialLink('X', d.twitter)} | ${socialLink('TG', d.telegram)} | ${socialLink('Web', d.website)}`,
    ...gmgnLines,
    '',
    `<code>${d.mint}</code>`, // tap to copy — links are the buttons below
  );
  return lines.join('\n');
}

/**
 * Graduation-monitor alert card: built from a `GradSnapshot` plus the LIVE SOL/USD price used to
 * convert the snapshot's SOL-denominated `graduationMcSol` into USD — so the "×from grad" line
 * matches the same multiple the watcher gated on. No mint/CA (the caller appends the
 * `<code>{mint}</code>` footer, since GradSnapshot intentionally doesn't carry it). Reuses
 * `gmgnStars` by shaping the snapshot's security fields into a `GmgnEnrichment`-like object
 * (washTrading is 'unknown' — GradSnapshot doesn't carry a wash-trading verdict).
 */
export function formatGraduation(s: GradSnapshot, solUsd: number): string {
  const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`);
  const graduationMcUsd = s.graduationMcSol * solUsd;
  const mult = graduationMcUsd > 0 ? s.marketCapUsd / graduationMcUsd : 0;

  const g: GmgnEnrichment = {
    smartMoneyCount: s.smartMoneyCount, kolCount: s.kolCount,
    honeypot: s.honeypot, washTrading: 'unknown',
    buyTaxPct: s.buyTaxPct, sellTaxPct: s.sellTaxPct, top10Pct: s.top10Pct,
  };
  const stars = gmgnStars(g);
  const starStr = '⭐'.repeat(stars) + '☆'.repeat(5 - stars);
  const smart = s.smartMoneyCount === 'unknown' ? '?' : String(s.smartMoneyCount);
  const kol = s.kolCount === 'unknown' ? '?' : String(s.kolCount);
  const hpTag = s.honeypot === true ? ' · ⚠️ HONEYPOT' : '';

  // ATH market cap is derivable from the snapshot's own fields (ath_price scaled by the same
  // price->MC ratio as the current market cap) without needing a separate supply field.
  const athMcUsd = s.priceUsd > 0 && s.athPriceUsd > 0 ? (s.athPriceUsd / s.priceUsd) * s.marketCapUsd : 0;
  const athPart = athMcUsd > 0 ? ` • ATH ~${usd(athMcUsd)}` : '';

  const top10 = s.top10Pct === 'unknown' ? '?' : `${s.top10Pct.toFixed(0)}%`;

  const lines = [
    `🎓 <b>$${escapeHtml(s.symbol)}</b> • ${escapeHtml(s.name)} — GRADUATED`,
    `⭐ GMGN: ${starStr} · 🧠 Smart: ${smart} · 👑 KOL: ${kol}${hpTag}`,
    '',
    `💰 MC: ${usd(s.marketCapUsd)} • ⇡ ${mult.toFixed(1)}× from grad${athPart}`,
    `💧 Liq: ${usd(s.liquidityUsd)}`,
    `📊 Vol 1h: ${usd(s.volume1hUsd)} • ${s.swaps1h} swaps (${s.buys1h}/${s.sells1h})`,
    `👥 Holders: ${s.holderCount}`,
    `🏆 Top 10: ${top10}`,
  ];
  return lines.join('\n');
}

export class Telegram {
  constructor(
    private botToken: string,
    private chatId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Send an alert as a TEXT message so the <code> contract address is reliably tap-to-copy on
   * mobile (tap-to-copy is flaky inside photo captions). When `photoUrl` is given, the token
   * image rides along as a LARGE link preview shown ABOVE the text — the best of both worlds.
   * A dead/unfetchable image just yields no preview (Telegram drops it silently), so an alert is
   * never lost to a bad image URL. Returns the delivered message's id for later live-edits.
   */
  async send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<SendResult> {
    const p = typeof payload === 'string' ? { text: payload } : payload;
    const markup = p.buttons?.length ? { reply_markup: { inline_keyboard: p.buttons } } : {};
    const linkPreview = p.photoUrl
      ? { url: p.photoUrl, prefer_large_media: true, show_above_text: true }
      : { is_disabled: false };

    const sent = await this.post('sendMessage', {
      chat_id: this.chatId, text: p.text, parse_mode: 'HTML',
      link_preview_options: linkPreview, ...markup,
    });
    return { ok: sent.ok, messageId: sent.messageId, photo: false };
  }

  /**
   * Live-edit a previously sent card via editMessageText, preserving the large image preview
   * (pass the same `photoUrl`). MUST resend the buttons — an edit without reply_markup clears
   * the inline keyboard. Single attempt (called on a timer; the next tick is the retry). Never throws.
   */
  async editCaption(messageId: number, text: string, buttons: Keyboard, photoUrl?: string): Promise<boolean> {
    const markup = buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {};
    const linkPreview = photoUrl
      ? { url: photoUrl, prefer_large_media: true, show_above_text: true }
      : { is_disabled: false };
    const r = await this.post('editMessageText', {
      chat_id: this.chatId, message_id: messageId, text, parse_mode: 'HTML',
      link_preview_options: linkPreview, ...markup,
    }, 1);
    return r.ok;
  }

  private async post(method: string, body: object, attempts = 3): Promise<{ ok: boolean; messageId?: number }> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const j = (await res.json().catch(() => null)) as { result?: { message_id?: number } } | null;
          return { ok: true, messageId: j?.result?.message_id };
        }
        if (res.status === 429 && attempt < attempts - 1) {
          const j = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
          await new Promise((r) => setTimeout(r, ((j?.parameters?.retry_after ?? 3) + 1) * 1000));
        } else if (res.status === 400) {
          // "message is not modified" on an edit = the content didn't change; that's a success, not a failure
          const j = (await res.json().catch(() => null)) as { description?: string } | null;
          if (j?.description?.includes('message is not modified')) return { ok: true };
        }
      } catch {
        // retry
      }
    }
    return { ok: false };
  }
}

export interface SendResult {
  ok: boolean;
  messageId?: number;
  photo?: boolean;
}

interface Top10Trend {
  top10From?: number | 'unknown';
  top10Now?: number | 'unknown';
}

export type FollowUpData =
  | ({ kind: 'up'; symbol: string; mint: string; multiple: number; fromUsd: number; peakUsd: number } & Top10Trend)
  | ({ kind: 'dump' | 'window'; symbol: string; mint: string; peakUsd: number; nowUsd: number; peakPct: number; nowPct: number } & Top10Trend);

function top10Line(d: Top10Trend): string | null {
  if (typeof d.top10From !== 'number' || typeof d.top10Now !== 'number') return null;
  return `🏆 Top10 ${d.top10From.toFixed(0)}% → ${d.top10Now.toFixed(0)}%`;
}

export function formatFollowUp(d: FollowUpData): string {
  const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
  const sign = (n: number) => (n >= 0 ? `+${n.toFixed(0)}` : n.toFixed(0));
  const trend = top10Line(d);
  if (d.kind === 'up') {
    const lines = [
      `📈 <b>$${escapeHtml(d.symbol)}</b> is up ${d.multiple}X 📈`,
      'from your Trench alert',
      `${k(d.fromUsd)} → ${k(d.peakUsd)}`,
      '🚀'.repeat(Math.min(d.multiple, 10)),
    ];
    if (trend) lines.push(trend);
    lines.push('', `<code>${d.mint}</code>`);
    return lines.join('\n');
  }
  const head = d.kind === 'dump' ? '⚠️ ' : '📊 ';
  const verb = d.kind === 'dump' ? 'dumped from peak' : 'recap';
  const main = `${head}<b>$${escapeHtml(d.symbol)}</b> ${verb} — peaked ${k(d.peakUsd)} (${sign(d.peakPct)}%), now ${k(d.nowUsd)} (${sign(d.nowPct)}% since alert)`;
  return trend ? `${main}\n${trend}` : main;
}
