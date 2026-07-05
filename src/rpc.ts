class RpcError extends Error {}

export class Rpc {
  private id = 0;

  constructor(private url: string, private fetchFn: typeof fetch = fetch) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 400 * attempt + Math.random() * 400));
      }
      try {
        const res = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`RPC HTTP ${res.status}`);
          continue;
        }
        const j = (await res.json()) as { result?: T; error?: { message?: string } };
        if (j.error) throw new RpcError(`${method}: ${j.error.message ?? 'unknown RPC error'}`);
        return j.result as T;
      } catch (err) {
        if (err instanceof RpcError) throw err; // deterministic error — retrying won't help
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
