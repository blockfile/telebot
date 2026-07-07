import type { Rpc } from '../rpc';
import { TOTAL_SUPPLY } from '../types';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

interface LargestAccount { address: string; uiAmount: number | null }
interface ParsedAccount { data?: { parsed?: { info?: { owner?: string } } } }

interface HolderAccount { account?: { data?: { parsed?: { info?: { owner?: string; tokenAmount?: { uiAmount?: number | null } } } } } }

/**
 * Total distinct holders = wallets holding a non-zero balance of this mint, EXCLUDING the
 * bonding-curve reserve account (which holds the unsold supply and isn't a real holder).
 * One getProgramAccounts call; counts distinct owners so a wallet with two ATAs isn't double
 * counted. Best-effort: returns 'unknown' if the RPC can't serve it (never throws).
 */
export async function fetchHolderCount(rpc: Rpc, mint: string, bondingCurveKey: string): Promise<number | 'unknown'> {
  try {
    const accts = await rpc.call<HolderAccount[]>('getProgramAccounts', [
      TOKEN_PROGRAM,
      { encoding: 'jsonParsed', filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }] },
    ]);
    if (!Array.isArray(accts)) return 'unknown';
    const owners = new Set<string>();
    for (const a of accts) {
      const info = a?.account?.data?.parsed?.info;
      const owner = info?.owner;
      const amt = info?.tokenAmount?.uiAmount ?? 0;
      if (owner && owner !== bondingCurveKey && amt > 0) owners.add(owner);
    }
    return owners.size;
  } catch {
    return 'unknown';
  }
}

export async function fetchTop10Pct(rpc: Rpc, mint: string, bondingCurveKey: string): Promise<number | 'unknown'> {
  try {
    const largest = await rpc.call<{ value: LargestAccount[] }>('getTokenLargestAccounts', [mint]);
    const accounts = largest.value ?? [];
    if (!accounts.length) return 'unknown';

    const infos = await rpc.call<{ value: Array<ParsedAccount | null> }>(
      'getMultipleAccounts',
      [accounts.map((a) => a.address), { encoding: 'jsonParsed' }],
    );
    const owners = (infos.value ?? []).map((v) => v?.data?.parsed?.info?.owner ?? '');
    const holders = accounts.filter((_, i) => owners[i] !== bondingCurveKey);
    const top10 = holders.slice(0, 10).reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
    return (top10 / TOTAL_SUPPLY) * 100;
  } catch {
    return 'unknown';
  }
}
