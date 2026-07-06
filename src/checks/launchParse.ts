export interface Buy {
  owner: string;
  amount: number;
}

interface TokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { uiAmount?: number | null };
}

function ui(b: TokenBalance): number {
  return typeof b.uiTokenAmount?.uiAmount === 'number' ? b.uiTokenAmount.uiAmount : 0;
}

export function buysFromTx(tx: unknown, mint: string, exclude: Set<string>): Buy[] {
  const meta = (tx as { meta?: { preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } } | null)?.meta;
  if (!meta) return [];
  const preList = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const postList = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
  const pre = new Map<number, number>();
  for (const b of preList) {
    if (b && b.mint === mint && typeof b.accountIndex === 'number') pre.set(b.accountIndex, ui(b));
  }
  const buys: Buy[] = [];
  for (const b of postList) {
    if (!b || b.mint !== mint || typeof b.accountIndex !== 'number' || !b.owner) continue;
    const delta = ui(b) - (pre.get(b.accountIndex) ?? 0);
    if (delta > 0 && !exclude.has(b.owner)) buys.push({ owner: b.owner, amount: delta });
  }
  return buys;
}

interface ParsedIx {
  program?: string;
  parsed?: { type?: string; info?: { authority?: string; mint?: string; tokenAmount?: { uiAmount?: number | null } } };
}

export function devTransfersFromTx(tx: unknown, mint: string, creator: string): number {
  const t = tx as {
    transaction?: { message?: { instructions?: ParsedIx[] } };
    meta?: { innerInstructions?: Array<{ instructions?: ParsedIx[] }> };
  } | null;
  if (!t) return 0;
  const topList = Array.isArray(t.transaction?.message?.instructions) ? t.transaction!.message!.instructions! : [];
  const innerGroups = Array.isArray(t.meta?.innerInstructions) ? t.meta!.innerInstructions! : [];
  const inner = innerGroups.flatMap((g) => (Array.isArray(g?.instructions) ? g!.instructions! : []));
  let sum = 0;
  for (const ix of [...topList, ...inner]) {
    if (!ix || (ix.program !== 'spl-token' && ix.program !== 'spl-token-2022') || ix.parsed?.type !== 'transferChecked') continue;
    const info = ix.parsed.info;
    if (info?.mint === mint && info.authority === creator && typeof info.tokenAmount?.uiAmount === 'number') {
      sum += info.tokenAmount.uiAmount;
    }
  }
  return sum;
}
