export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface AlertData {
  mint: string;
  name: string;
  symbol: string;
  score: number;
  flags: string[];
  marketCapUsd: number;
  volumeUsd: number;
  ageMinutes: number;
  uniqueBuyers: number;
  devBuyPct: number;
  devStillHolds: boolean;
  priorLaunches: number | 'unknown';
  top10Pct: number | 'unknown';
  bundlePct: number | 'unknown';
  first20Pct: number | 'unknown';
  devOutflowPct: number | 'unknown';
  twitter?: string;
  telegram?: string;
  website?: string;
}

export function formatAlert(d: AlertData): string {
  const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`);
  const mc = usd(d.marketCapUsd);
  const vol = usd(d.volumeUsd);
  const mark = (v: string | undefined) => (v ? '✓' : '✗');
  const top10 = d.top10Pct === 'unknown' ? '?' : `${d.top10Pct.toFixed(0)}%`;
  const priors = d.priorLaunches === 'unknown' ? '?' : String(d.priorLaunches);
  const pctOrQ = (v: number | 'unknown') => (v === 'unknown' ? '?' : `${v.toFixed(0)}%`);
  const links = [
    `<a href="https://pump.fun/coin/${d.mint}">pump.fun</a>`,
    `<a href="https://gmgn.ai/sol/token/${d.mint}">GMGN</a>`,
    `<a href="https://solscan.io/token/${d.mint}">Solscan</a>`,
    `<a href="https://rugcheck.xyz/tokens/${d.mint}">RugCheck</a>`,
  ].join(' | ');

  const lines = [
    `🎯 <b>TRENCH ALERT — $${escapeHtml(d.symbol)}</b>  (score ${d.score}/100)`,
    `${escapeHtml(d.name)} • MC ${mc} • vol ${vol} • age ${d.ageMinutes}m • buyers ${d.uniqueBuyers}`,
    `CA: ${d.mint}`,
    `Dev: bought ${d.devBuyPct.toFixed(1)}%, ${d.devStillHolds ? 'still holds' : 'sold some'}, ${priors} prior launches`,
    `Holders: top10 ${top10}`,
    `Launch: bundle ${pctOrQ(d.bundlePct)} • first-20 ${pctOrQ(d.first20Pct)} • dev-out ${pctOrQ(d.devOutflowPct)}`,
    `Socials: 𝕏 ${mark(d.twitter)}  TG ${mark(d.telegram)}  Web ${mark(d.website)}`,
    links,
  ];
  if (d.flags.length) lines.push(`⚠️ ${d.flags.map(escapeHtml).join(', ')}`);
  return lines.join('\n');
}

export class Telegram {
  constructor(
    private botToken: string,
    private chatId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
          }),
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

export interface FollowUpData {
  symbol: string;
  reason: 'window' | 'dump';
  peakUsd: number;
  nowUsd: number;
  peakPct: number;
  nowPct: number;
}

export function formatFollowUp(d: FollowUpData): string {
  const k = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
  const sign = (n: number) => (n >= 0 ? `+${n.toFixed(0)}` : n.toFixed(0));
  const head = d.reason === 'dump' ? '⚠️ ' : '📈 ';
  return `${head}<b>$${escapeHtml(d.symbol)}</b> follow-up — peaked ${k(d.peakUsd)} (${sign(d.peakPct)}%), now ${k(d.nowUsd)} (${sign(d.nowPct)}% since alert)`;
}
