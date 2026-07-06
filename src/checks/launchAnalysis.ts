import type { Rpc } from '../rpc';
import { TOTAL_SUPPLY } from '../types';
import { buysFromTx, devTransfersFromTx } from './launchParse';

export interface LaunchAnalysis {
  bundlePct: number;
  first20Pct: number;
  devOutflowPct: number;
}

interface SigInfo { signature: string; slot: number }

async function fetchTxs(rpc: Rpc, sigs: SigInfo[]): Promise<Array<{ slot: number; tx: unknown }>> {
  const out: Array<{ slot: number; tx: unknown }> = [];
  for (let i = 0; i < sigs.length; i += 5) {
    const batch = sigs.slice(i, i + 5);
    const txs = await Promise.all(batch.map((s) =>
      rpc.call<unknown>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }])
        .catch(() => null)));
    batch.forEach((s, j) => out.push({ slot: s.slot, tx: txs[j] }));
  }
  return out;
}

export async function analyzeLaunch(
  rpc: Rpc,
  mint: string,
  bondingCurveKey: string,
  creator: string,
  creationSignature: string,
  maxEarlyTxFetch = 60,
): Promise<LaunchAnalysis | 'unknown'> {
  try {
    const createTx = await rpc.call<{ slot?: number } | null>(
      'getTransaction', [creationSignature, { maxSupportedTransactionVersion: 0 }]);
    const creationSlot = createTx?.slot;
    if (typeof creationSlot !== 'number') return 'unknown';

    const curveSigs = await rpc.call<SigInfo[]>('getSignaturesForAddress', [bondingCurveKey, { limit: 1000 }]);
    if (!curveSigs?.length) return 'unknown';
    const chron = [...curveSigs].reverse();
    if (chron[0].slot > creationSlot) return 'unknown'; // we did not capture the launch window

    const early = chron.slice(0, maxEarlyTxFetch);
    const txs = await fetchTxs(rpc, early);

    const exclude = new Set([creator]);
    const firstOwners: string[] = [];
    const boughtByOwner = new Map<string, number>();
    let bundleTokens = 0;

    for (const { slot, tx } of txs) {
      for (const b of buysFromTx(tx, mint, exclude)) {
        if (slot === creationSlot) bundleTokens += b.amount;
        if (!boughtByOwner.has(b.owner) && firstOwners.length < 20) firstOwners.push(b.owner);
        boughtByOwner.set(b.owner, (boughtByOwner.get(b.owner) ?? 0) + b.amount);
      }
    }
    const first20Tokens = firstOwners.reduce((sum, o) => sum + (boughtByOwner.get(o) ?? 0), 0);

    let devOutTokens = 0;
    const devSigs = await rpc.call<SigInfo[]>('getSignaturesForAddress', [creator, { limit: 1000 }]);
    if (devSigs?.length) {
      // Only the creator's activity at/after this token's creation can be an airdrop of THIS mint;
      // anchoring to the creation slot keeps a serial creator's unrelated history out of the count.
      // (If the creator made >1000 txs since launch, the earliest transfers may fall outside this
      //  1000-signature window and devOutflow under-counts — i.e. it could under-flag a dumping
      //  dev. Accepted: the window is narrow, and other gates still apply.)
      const devLaunchEra = [...devSigs].reverse().filter((s) => s.slot >= creationSlot).slice(0, maxEarlyTxFetch);
      const devTxs = await fetchTxs(rpc, devLaunchEra);
      for (const { tx } of devTxs) devOutTokens += devTransfersFromTx(tx, mint, creator);
    }

    const pct = (n: number) => (n / TOTAL_SUPPLY) * 100;
    return { bundlePct: pct(bundleTokens), first20Pct: pct(first20Tokens), devOutflowPct: pct(devOutTokens) };
  } catch {
    return 'unknown';
  }
}
