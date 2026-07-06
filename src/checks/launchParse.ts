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
  const pre = new Map<number, number>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint === mint && typeof b.accountIndex === 'number') pre.set(b.accountIndex, ui(b));
  }
  const buys: Buy[] = [];
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mint || typeof b.accountIndex !== 'number' || !b.owner) continue;
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
  const top = t.transaction?.message?.instructions ?? [];
  const inner = (t.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? []);
  let sum = 0;
  for (const ix of [...top, ...inner]) {
    if (ix.program !== 'spl-token' || ix.parsed?.type !== 'transferChecked') continue;
    const info = ix.parsed.info;
    if (info?.mint === mint && info.authority === creator && typeof info.tokenAmount?.uiAmount === 'number') {
      sum += info.tokenAmount.uiAmount;
    }
  }
  return sum;
}
