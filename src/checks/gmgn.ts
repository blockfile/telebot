import { log } from '../logger';

/** Same 'unknown' degrade-doctrine as the other checks (see holders.ts, devHistory.ts). */
export type Tri<T> = T | 'unknown';

/**
 * Best-effort GMGN enrichment for one mint: security signals (honeypot/tax) from
 * `token/security`, plus smart-money and KOL wallet counts from `token/info`. Each field
 * degrades independently to 'unknown' when its source call fails; only when BOTH calls fail
 * does the whole result become 'unknown' (mirrors LaunchAnalysis's pattern in launchAnalysis.ts).
 * Purely additive/display data — never scored, never blocks an alert.
 */
export interface GmgnEnrichment {
  smartMoneyCount: Tri<number>;
  kolCount: Tri<number>;
  honeypot: Tri<boolean>;
  washTrading: Tri<boolean>;
  buyTaxPct: Tri<number>;
  sellTaxPct: Tri<number>;
  top10Pct: Tri<number>;
}

/** A sell tax at/above this percent counts as a security negative in the star rating. */
export const GMGN_SELL_TAX_NEG_PCT = 10;

/**
 * 1..5 quality star rating derived purely from GMGN signals. Neutral middle (3), +1 per strong
 * positive (smart money present, KOL present), -1 per CONFIRMED negative (honeypot, wash-trading,
 * sell-tax over ~10%). Unknown/null fields are NEUTRAL and never subtract — this is the same
 * degrade-to-unknown doctrine the rest of the checks follow. Clamped to 1..5. Pure function,
 * shared by the card renderer and the scorer so both agree on the rating. */
export function gmgnStars(g: GmgnEnrichment): number {
  let stars = 3;
  if (typeof g.smartMoneyCount === 'number' && g.smartMoneyCount > 0) stars += 1;
  if (typeof g.kolCount === 'number' && g.kolCount > 0) stars += 1;
  if (g.honeypot === true) stars -= 1;
  if (g.washTrading === true) stars -= 1;
  if (typeof g.sellTaxPct === 'number' && g.sellTaxPct > GMGN_SELL_TAX_NEG_PCT) stars -= 1;
  return Math.max(1, Math.min(5, stars));
}

const BASE = 'https://openapi.gmgn.ai';

function buildUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Required on every call, per GMGN's read-endpoint auth: unix seconds + a fresh request id.
  url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
  url.searchParams.set('client_id', crypto.randomUUID());
  return url;
}

/**
 * Unwraps GMGN's response envelope. Validated live against openapi.gmgn.ai: `market/rank`
 * double-wraps the payload as `{code, data:{code, message, data:<payload>}}`, but the per-token
 * endpoints used here (`token/security`, `token/info`) single-wrap it as `{code, data:<payload>,
 * message}`. Handle both shapes defensively so a future API change on either side degrades
 * instead of silently misparsing. Returns null on any non-zero code or shape mismatch.
 */
function unwrap(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.code !== 0) return null;
  const inner = b.data;
  if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).code === 'number') {
    const wrapped = inner as Record<string, unknown>;
    if (wrapped.code !== 0) return null;
    return (wrapped.data as Record<string, unknown>) ?? null;
  }
  return (inner as Record<string, unknown>) ?? null;
}

function triBool(v: unknown): Tri<boolean> {
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false) return false;
  return 'unknown'; // GMGN sends null for "not evaluated" — never guess "not a honeypot" from that
}

/**
 * Wash-trading verdict for a mint. The per-token security/info endpoints don't currently carry
 * `is_wash_trading` (only the market/rank list does), so this usually degrades to 'unknown'
 * (neutral). Read it defensively from wherever GMGN might surface it — an explicit boolean on
 * either payload, or a "wash" entry in security.flags — and only ever return `true` on positive
 * evidence (never fabricate a "clean" verdict from a missing field). */
function triWash(security: Record<string, unknown> | null, info: Record<string, unknown> | null): Tri<boolean> {
  for (const p of [security, info]) {
    if (!p) continue;
    const w = triBool(p.is_wash_trading);
    if (w !== 'unknown') return w;
  }
  const flags = security?.flags;
  if (Array.isArray(flags)) {
    for (const f of flags) {
      const label = typeof f === 'string'
        ? f
        : (f && typeof f === 'object' ? String((f as Record<string, unknown>).name ?? (f as Record<string, unknown>).type ?? '') : '');
      if (label.toLowerCase().includes('wash')) return true;
    }
  }
  return 'unknown';
}

function triNum(v: unknown): Tri<number> {
  const n = Number(v);
  return Number.isFinite(n) ? n : 'unknown';
}

/** A numeric-ish 0..1 fraction (GMGN sends these as strings, e.g. buy_tax/top_10_holder_rate)
 * scaled to a 0..100 percent. */
function triPctFromFraction(v: unknown): Tri<number> {
  const n = Number(v);
  return Number.isFinite(n) ? n * 100 : 'unknown';
}

export class GmgnClient {
  constructor(
    private apiKey: string,
    private fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
    try {
      const url = buildUrl(path, params);
      const res = await this.fetchFn(url.toString(), {
        headers: { 'X-APIKEY': this.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log('warn', `GMGN ${path}: HTTP ${res.status}`);
        return null;
      }
      const body = await res.json().catch(() => null);
      const payload = unwrap(body);
      if (payload === null) {
        log('warn', `GMGN ${path}: bad envelope (code ${(body as { code?: unknown } | null)?.code})`);
      }
      return payload;
    } catch (err) {
      log('warn', `GMGN ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fetches security + info for `mint` on the sol chain in parallel. Never throws. Returns
   * 'unknown' only if both calls fail; otherwise returns as much as could be read, with the
   * unreached fields individually 'unknown'.
   */
  async enrich(mint: string): Promise<Tri<GmgnEnrichment>> {
    const [security, info] = await Promise.all([
      this.get('/v1/token/security', { chain: 'sol', address: mint }),
      this.get('/v1/token/info', { chain: 'sol', address: mint }),
    ]);
    if (!security && !info) return 'unknown';

    const tags = (info?.wallet_tags_stat as Record<string, unknown> | undefined) ?? {};
    const stat = (info?.stat as Record<string, unknown> | undefined) ?? {};

    return {
      smartMoneyCount: info ? triNum(tags.smart_wallets) : 'unknown',
      kolCount: info ? triNum(tags.renowned_wallets) : 'unknown',
      honeypot: security ? triBool(security.is_honeypot) : 'unknown',
      washTrading: triWash(security, info),
      buyTaxPct: security ? triPctFromFraction(security.buy_tax) : 'unknown',
      sellTaxPct: security ? triPctFromFraction(security.sell_tax) : 'unknown',
      // Prefer security's own top10 reading; fall back to info's `stat` block if only that came back.
      top10Pct: security
        ? triPctFromFraction(security.top_10_holder_rate)
        : (info ? triPctFromFraction(stat.top_10_holder_rate) : 'unknown'),
    };
  }
}
