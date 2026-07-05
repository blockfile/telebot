import type { Rpc } from '../rpc';
import { TOTAL_SUPPLY } from '../types';

interface LargestAccount { address: string; uiAmount: number | null }
interface ParsedAccount { data?: { parsed?: { info?: { owner?: string } } } }

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
