import type { RevivalConfig } from '../config';
import type { RevivalRow } from '../db/index';
import { log } from '../logger';

/**
 * Decode a pump.fun bonding-curve account (base64):
 * 8B discriminator | u64 virtualTokenReserves | u64 virtualSolReserves |
 * u64 realTokenReserves | u64 realSolReserves | u64 tokenTotalSupply | u8 complete (LE).
 * mcSol = price per token (vSol/vToken) × the fixed 1e9 supply; token has 6 decimals.
 */
export function parseBondingCurve(b64: string): { mcSol: number; vSolSol: number; complete: boolean } | null {
  let buf: Buffer;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (buf.length < 49) return null;
  const vToken = buf.readBigUInt64LE(8);
  const vSol = buf.readBigUInt64LE(16);
  if (vToken === 0n) return null;
  const vSolSol = Number(vSol) / 1e9;
  const mcSol = (vSolSol * 1e15) / Number(vToken);
  return { mcSol, vSolSol, complete: buf.readUInt8(48) === 1 };
}

export interface RevivalDeps {
  candidates(): RevivalRow[];
  /** base64 account data per curve key, null for missing accounts. Order matches keys. */
  fetchAccounts(keys: string[]): Promise<Array<string | null>>;
  solUsd(): number;
  wake(row: RevivalRow, mcSol: number, vSolSol: number): void;
}

/**
 * Watches the graveyard: expired stage1-passed tokens whose bonding-curve market cap
 * suddenly jumps off its floor get fed back into the normal watchlist pipeline.
 */
export class RevivalWatcher {
  /** rolling MIN market cap (SOL) per candidate — the "floor" a wake must jump from */
  private floors = new Map<string, { mc: number; seenAt: number }>();
  /** curves seen with complete=1 — graduated, can never revive on the curve; skip forever */
  private graduated = new Set<string>();

  constructor(private cfg: RevivalConfig, private deps: RevivalDeps) {}

  async sweep(): Promise<void> {
    let rows: RevivalRow[];
    try {
      rows = this.deps.candidates().filter((r) => !this.graduated.has(r.mint));
    } catch (err) {
      log('warn', `revival sweep: candidates query failed: ${(err as Error).message}`);
      return;
    }
    if (rows.length >= this.cfg.maxCandidates) {
      log('warn', `revival sweep: candidate cap saturated (${rows.length}) — consider raising revival.maxCandidates`);
    }

    // Floors are pruned by AGE, not by absence from this sweep's candidate list — a mint that
    // temporarily falls off the (capped) candidate window must keep its floor, or a pump that
    // happens while it's outside the window would re-prime at the top and never wake.
    const now = Date.now();
    const cutoff = now - this.cfg.lookbackDays * 86_400_000;
    for (const [mint, f] of [...this.floors]) {
      if (f.seenAt < cutoff) this.floors.delete(mint);
    }

    const byCurve = new Map(rows.map((r) => [r.bondingCurve, r]));
    const keys = [...byCurve.keys()];
    for (let i = 0; i < keys.length; i += 100) {
      const batch = keys.slice(i, i + 100);
      try {
        const datas = await this.deps.fetchAccounts(batch);
        batch.forEach((key, j) => {
          const data = datas[j];
          if (!data) return;
          const curve = parseBondingCurve(data);
          if (!curve) return;
          const r = byCurve.get(key)!;
          if (curve.complete) {
            this.graduated.add(r.mint); // migrated off the curve — never a curve revival
            this.floors.delete(r.mint);
            return;
          }

          const floor = this.floors.get(r.mint);
          if (floor === undefined) {
            this.floors.set(r.mint, { mc: curve.mcSol, seenAt: now }); // first sighting: prime only
            return;
          }
          floor.seenAt = now;
          const mcUsd = curve.mcSol * this.deps.solUsd();
          if (curve.mcSol >= floor.mc * this.cfg.jumpMult && mcUsd >= this.cfg.minMcUsd) {
            // Waking re-primes the floor at the wake level, so one pump = one wake.
            floor.mc = curve.mcSol;
            this.deps.wake(r, curve.mcSol, curve.vSolSol);
          } else if (curve.mcSol < floor.mc) {
            floor.mc = curve.mcSol; // rolling minimum
          }
        });
      } catch (err) {
        // One bad batch (RPC hiccup, an invalid key poisoning the request) must not starve
        // the remaining batches; floors touched by earlier batches are already updated.
        log('warn', `revival sweep: batch ${i / 100} failed: ${(err as Error).message}`);
      }
    }
  }
}
