import type { ButtonsConfig } from './config';
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
  devBuyPct: number;
  devStillHolds: boolean;
  priorLaunches: number | 'unknown';
  top10Pct: number | 'unknown';
  bundlePct: number | 'unknown';
  sniperCount: number | 'unknown';
  sniperPct: number | 'unknown';
  first20Pct: number | 'unknown';
  devOutflowPct: number | 'unknown';
  twitter?: string;
  telegram?: string;
  website?: string;
}

export function formatAlert(d: AlertData): string {
  const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`);
  const mc = usd(d.marketCapUsd);
  const top = usd(d.topMarketCapUsd);
  const vol = usd(d.volumeUsd);
  const liq = usd(d.liquidityUsd);
  const mark = (v: string | undefined) => (v ? '✅' : '❌');
  const top10 = d.top10Pct === 'unknown' ? '?' : `${d.top10Pct.toFixed(0)}%`;
  const priors = d.priorLaunches === 'unknown' ? '?' : String(d.priorLaunches);
  const holders = d.holderCount === 'unknown' ? '?' : String(d.holderCount);
  const pctOrQ = (v: number | 'unknown') => (v === 'unknown' ? '?' : `${v.toFixed(0)}%`);
  const snipers = d.sniperCount === 'unknown' ? '?' : `${d.sniperCount} (${pctOrQ(d.sniperPct)})`;
  const grade = d.score >= 80 ? '🔥' : d.score >= 70 ? '⚡' : '✅';

  const lines = [`${grade} <b>$${escapeHtml(d.symbol)}</b> — score ${d.score}/100`];
  if (d.flags.length) lines.push(`⚠️ ${d.flags.map(escapeHtml).join(' · ')}`);
  lines.push(
    '',
    escapeHtml(d.name),
    `💰 MC ${mc} (top ${top}) · 📊 Vol ${vol} · ⏱️ ${d.ageMinutes}m`,
    `💧 Liq ${liq} · 👥 ${d.uniqueBuyers} buyers · 🙋 ${holders} holders`,
    '',
    `🧑‍💻 Dev: ${d.devBuyPct.toFixed(1)}% · ${d.devStillHolds ? 'still holds' : 'sold some'} · ${priors} priors`,
    `🏆 Top 10: ${top10}`,
    `🎯 Bundle ${pctOrQ(d.bundlePct)} · Snipers ${snipers} · First-20 ${pctOrQ(d.first20Pct)} · Dev-out ${pctOrQ(d.devOutflowPct)}`,
    `🔗 𝕏 ${mark(d.twitter)}   TG ${mark(d.telegram)}   Web ${mark(d.website)}`,
    '',
    `<code>${d.mint}</code>`, // tap to copy — links are now buttons below
  );
  return lines.join('\n');
}

export class Telegram {
  constructor(
    private botToken: string,
    private chatId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Send a message. A plain string sends text; a payload with `photoUrl` sends an
   * image card (caption + buttons) and, if Telegram can't fetch the image, falls
   * back to a text message so an alert is never lost to a bad image URL.
   */
  async send(payload: string | { text: string; photoUrl?: string; buttons?: Keyboard }): Promise<boolean> {
    const p = typeof payload === 'string' ? { text: payload } : payload;
    const markup = p.buttons?.length ? { reply_markup: { inline_keyboard: p.buttons } } : {};

    if (p.photoUrl) {
      const sent = await this.post('sendPhoto', {
        chat_id: this.chatId, photo: p.photoUrl, caption: p.text, parse_mode: 'HTML', ...markup,
      });
      if (sent) return true;
      // image couldn't be fetched/sent (e.g. dead IPFS gateway) — fall through to a plain text message
      log('warn', `sendPhoto failed for ${p.photoUrl} — falling back to text`);
    }

    return this.post('sendMessage', {
      chat_id: this.chatId, text: p.text, parse_mode: 'HTML',
      link_preview_options: { is_disabled: false }, ...markup,
    });
  }

  private async post(method: string, body: object): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return true;
        if (res.status === 429 && attempt < 2) {
          const j = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
          await new Promise((r) => setTimeout(r, ((j?.parameters?.retry_after ?? 3) + 1) * 1000));
        }
      } catch {
        // retry
      }
    }
    return false;
  }
}

export type FollowUpData =
  | { kind: 'up'; symbol: string; mint: string; multiple: number; fromUsd: number; peakUsd: number }
  | { kind: 'dump' | 'window'; symbol: string; mint: string; peakUsd: number; nowUsd: number; peakPct: number; nowPct: number };

export function formatFollowUp(d: FollowUpData): string {
  const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
  const sign = (n: number) => (n >= 0 ? `+${n.toFixed(0)}` : n.toFixed(0));
  if (d.kind === 'up') {
    return [
      `📈 <b>$${escapeHtml(d.symbol)}</b> is up ${d.multiple}X 📈`,
      'from your Trench alert',
      `${k(d.fromUsd)} → ${k(d.peakUsd)}`,
      '🚀'.repeat(Math.min(d.multiple, 10)),
      '',
      `<code>${d.mint}</code>`,
    ].join('\n');
  }
  const head = d.kind === 'dump' ? '⚠️ ' : '📊 ';
  const verb = d.kind === 'dump' ? 'dumped from peak' : 'recap';
  return `${head}<b>$${escapeHtml(d.symbol)}</b> ${verb} — peaked ${k(d.peakUsd)} (${sign(d.peakPct)}%), now ${k(d.nowUsd)} (${sign(d.nowPct)}% since alert)`;
}
