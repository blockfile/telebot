import type { Rpc } from '../rpc';
import { TOTAL_SUPPLY } from '../types';
import { buysFromTx, devTransfersFromTx } from './launchParse';

export interface LaunchAnalysis {
  bundlePct: number;
  bundleCount: number;
  bundleHeldPct: number | 'unknown';
  sniperCount: number;
  sniperPct: number;
  sniperHeldPct: number | 'unknown';
  first20Pct: number;
  devOutflowPct: number | 'unknown';
}

const MAX_HOLDS_LOOKUPS = 20;

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
  sniperSlots = 3,
  maxSigPages = 15,
): Promise<LaunchAnalysis | 'unknown'> {
  try {
    const createTx = await rpc.call<{ slot?: number } | null>(
      'getTransaction', [creationSignature, { maxSupportedTransactionVersion: 0 }]);
    const creationSlot = createTx?.slot;
    if (typeof creationSlot !== 'number') return 'unknown';

    // Page backwards through the curve's history until it ends (the curve account is born in the
    // creation tx, so exhausting history means we reached the launch). Hot tokens can have far
    // more than one page of trades by alert time; the cap bounds the cost on extreme ones.
    let collected: SigInfo[] = [];
    let before: string | undefined;
    let reachedEnd = false;
    for (let page = 0; page < maxSigPages; page++) {
      const batch = await rpc.call<SigInfo[]>('getSignaturesForAddress', [
        bondingCurveKey, { limit: 1000, ...(before ? { before } : {}) },
      ]);
      if (!batch?.length) { reachedEnd = true; break; }
      collected = collected.concat(batch);
      if (batch.length < 1000) { reachedEnd = true; break; }
      before = batch[batch.length - 1].signature;
    }
    if (!reachedEnd || !collected.length) return 'unknown'; // too hot to walk back within the cap
    const chron = [...collected].reverse();
    if (chron[0].slot > creationSlot) return 'unknown'; // history doesn't reach the launch window

    const early = chron.slice(0, maxEarlyTxFetch);
    const txs = await fetchTxs(rpc, early);

    const exclude = new Set([creator, bondingCurveKey]);
    const firstOwners: string[] = [];
    const boughtByOwner = new Map<string, number>();
    const firstBuySlot = new Map<string, number>();
    const bundleWallets = new Set<string>();
    let bundleTokens = 0;

    for (const { slot, tx } of txs) {
      for (const b of buysFromTx(tx, mint, exclude)) {
        if (slot === creationSlot) {
          bundleTokens += b.amount;
          bundleWallets.add(b.owner);
        }
        if (!firstBuySlot.has(b.owner)) firstBuySlot.set(b.owner, slot);
        if (!boughtByOwner.has(b.owner) && firstOwners.length < 20) firstOwners.push(b.owner);
        boughtByOwner.set(b.owner, (boughtByOwner.get(b.owner) ?? 0) + b.amount);
      }
    }
    const first20Tokens = firstOwners.reduce((sum, o) => sum + (boughtByOwner.get(o) ?? 0), 0);

    // Snipers: wallets whose FIRST buy landed within sniperSlots after creation (bot snipes),
    // as opposed to same-slot bundlers (counted above) or organic later buyers.
    const sniperWallets = new Set<string>();
    let sniperTokens = 0;
    for (const [owner] of boughtByOwner) {
      const fs = firstBuySlot.get(owner) ?? creationSlot;
      if (fs > creationSlot && fs <= creationSlot + sniperSlots) {
        sniperWallets.add(owner);
        sniperTokens += boughtByOwner.get(owner) ?? 0;
      }
    }
    const sniperCount = sniperWallets.size;

    // Bought -> still-holds: fetch insiders' current balances (capped, best-effort).
    const insiders = [...new Set([...bundleWallets, ...sniperWallets])]
      .sort((a, b) => (boughtByOwner.get(b) ?? 0) - (boughtByOwner.get(a) ?? 0))
      .slice(0, MAX_HOLDS_LOOKUPS);
    const held = await fetchHeldByOwners(rpc, mint, insiders);
    const sumHeld = (wallets: Set<string>): number | 'unknown' => {
      if (!wallets.size) return 0;
      if (held === 'unknown') return 'unknown';
      let sum = 0;
      for (const w of wallets) {
        const h = held.get(w);
        // Not sampled (beyond the lookup cap) or lookup failed: counting it as 0 would fake a
        // "dumped" trend on the card, so degrade the whole group to 'unknown' (renders "8% → ?").
        if (h === undefined) return 'unknown';
        sum += h;
      }
      return sum;
    };
    const bundleHeldTokens = sumHeld(bundleWallets);
    const sniperHeldTokens = sumHeld(sniperWallets);

    let devOutTokens: number | 'unknown' = 0;
    const devSigs = await rpc.call<SigInfo[]>('getSignaturesForAddress', [creator, { limit: 1000 }]);
    if (devSigs?.length) {
      // Only the creator's activity at/after this token's creation can be an airdrop of THIS mint;
      // anchoring to the creation slot keeps a serial creator's unrelated history out of the count.
      const oldestReturned = devSigs[devSigs.length - 1];
      if (devSigs.length === 1000 && oldestReturned.slot > creationSlot) {
        // The creator's 1000-signature window provably doesn't reach back to the launch (common
        // for revived tokens hours/days old with active creators). A partial count here would be
        // a confidently wrong ~0% that silently passes the dev-outflow hard-reject — degrade
        // honestly instead, like the bundle metrics do.
        devOutTokens = 'unknown';
      } else {
        const devLaunchEra = [...devSigs].reverse().filter((s) => s.slot >= creationSlot).slice(0, maxEarlyTxFetch);
        const devTxs = await fetchTxs(rpc, devLaunchEra);
        for (const { tx } of devTxs) devOutTokens += devTransfersFromTx(tx, mint, creator);
      }
    }

    const pct = (n: number) => (n / TOTAL_SUPPLY) * 100;
    return {
      bundlePct: pct(bundleTokens),
      bundleCount: bundleWallets.size,
      bundleHeldPct: bundleHeldTokens === 'unknown' ? 'unknown' : pct(bundleHeldTokens),
      sniperCount,
      sniperPct: pct(sniperTokens),
      sniperHeldPct: sniperHeldTokens === 'unknown' ? 'unknown' : pct(sniperHeldTokens),
      first20Pct: pct(first20Tokens),
      devOutflowPct: devOutTokens === 'unknown' ? 'unknown' : pct(devOutTokens),
    };
  } catch {
    return 'unknown';
  }
}

interface TokenAccountsByOwner { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }> }

/**
 * Current balance of `mint` for each owner (uiAmount tokens), batched 5 at a time.
 * Per-wallet failures are skipped; if EVERY lookup fails, returns 'unknown' so callers
 * can distinguish "insiders dumped to zero" from "we couldn't check". Never throws.
 */
async function fetchHeldByOwners(rpc: Rpc, mint: string, owners: string[]): Promise<Map<string, number> | 'unknown'> {
  const held = new Map<string, number>();
  if (!owners.length) return held;
  let failures = 0;
  for (let i = 0; i < owners.length; i += 5) {
    const batch = owners.slice(i, i + 5);
    const results = await Promise.all(batch.map((o) =>
      rpc.call<TokenAccountsByOwner>('getTokenAccountsByOwner', [o, { mint }, { encoding: 'jsonParsed' }])
        .catch(() => null)));
    batch.forEach((o, j) => {
      const res = results[j];
      if (!res) { failures++; return; }
      let sum = 0;
      for (const acc of res.value ?? []) sum += acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
      held.set(o, sum);
    });
  }
  return failures === owners.length ? 'unknown' : held;
}
