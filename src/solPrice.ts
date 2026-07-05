const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

export class SolPrice {
  private current: number;

  constructor(fallbackUsd: number, private fetchFn: typeof fetch = fetch) {
    this.current = fallbackUsd;
  }

  get usd(): number { return this.current; }

  async refresh(): Promise<void> {
    try {
      const res = await this.fetchFn(COINGECKO_URL, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const j = (await res.json()) as { solana?: { usd?: number } };
      if (typeof j.solana?.usd === 'number' && j.solana.usd > 0) this.current = j.solana.usd;
    } catch {
      // keep last known price
    }
  }

  start(intervalMs = 300_000): NodeJS.Timeout {
    void this.refresh();
    const t = setInterval(() => void this.refresh(), intervalMs);
    t.unref();
    return t;
  }
}
