import type { GraduationMonitorConfig } from '../config';
import type { GradSnapshot, Tri } from '../checks/gmgn';
import { formatGraduation, type Keyboard } from '../telegram';

export interface GradWatchDeps {
  gmgn: { graduationSnapshot(mint: string): Promise<Tri<GradSnapshot>> };
  send: (payload: { text: string; photoUrl?: string; buttons?: Keyboard }) => Promise<{ ok: boolean }>;
  buttons: (mint: string) => Keyboard;
  cfg: GraduationMonitorConfig;
  log?: (msg: string) => void;
}

interface WatchedMint {
  mint: string;
  graduatedAt: number;
}

/**
 * Watches mints via GMGN after a pump.fun graduation — PumpPortal stops streaming trades at
 * migration, so this is the only post-graduation signal the scanner has left. `add()` is called
 * from the `stream.on('migration', ...)` handler; `sweep()` is driven by an interval in index.ts
 * (polling, not event-driven — GMGN needs time to index the new AMM pool anyway).
 *
 * In-memory only: both `watched` and `alerted` reset on restart. Acceptable for v1 — worst case
 * after a restart is re-watching (and potentially re-alerting) a mint that graduated within the
 * last `watchMinutes`, not silently losing coverage.
 */
export class GradWatch {
  private watched = new Map<string, WatchedMint>();
  private alerted = new Set<string>();

  constructor(private deps: GradWatchDeps) {}

  get size(): number {
    return this.watched.size;
  }

  /** Records a freshly graduated mint to watch, unless it's already watched or already alerted. */
  add(mint: string, graduatedAt: number): void {
    if (this.watched.has(mint) || this.alerted.has(mint)) return;
    this.watched.set(mint, { mint, graduatedAt });
  }

  /**
   * One pass over the watch list, bounded to `cfg.maxChecksPerSweep` mints (the rest are picked
   * up on the next sweep) to respect GMGN rate limits. Never throws — each mint is wrapped in its
   * own try/catch so one bad GMGN response can't starve the rest of the sweep.
   */
  async sweep(now: number): Promise<void> {
    const log = this.deps.log ?? ((): void => {});
    const batch = [...this.watched.values()].slice(0, this.deps.cfg.maxChecksPerSweep);

    for (const w of batch) {
      try {
        if (now - w.graduatedAt > this.deps.cfg.watchMinutes * 60_000) {
          this.watched.delete(w.mint);
          log(`grad watch expired: ${w.mint}`);
          continue;
        }

        const snap = await this.deps.gmgn.graduationSnapshot(w.mint);
        if (snap === 'unknown') continue; // GMGN hasn't indexed the new pool yet — retry next sweep

        if (snap.honeypot === true) {
          this.watched.delete(w.mint);
          log(`grad skip honeypot: ${w.mint}`);
          continue;
        }

        const healthy = snap.volume1hUsd >= this.deps.cfg.minVolume1hUsd
          && snap.liquidityUsd >= this.deps.cfg.minLiquidityUsd
          && snap.holderCount >= this.deps.cfg.minHolders;
        if (!healthy) continue; // present but below the floors — keep watching, may pick up volume

        const text = `${formatGraduation(snap)}\n\n<code>${w.mint}</code>`;
        const result = await this.deps.send({ text, photoUrl: snap.logo, buttons: this.deps.buttons(w.mint) });
        if (result.ok) {
          this.alerted.add(w.mint);
          this.watched.delete(w.mint);
          log(`grad ALERT: $${snap.symbol}`);
        } // else: leave it watched to retry the send on the next sweep
      } catch (err) {
        log(`grad watch sweep error for ${w.mint}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
