import type { Rpc } from '../rpc';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

export interface DevHistory {
  priorLaunches: number;
  anyGraduated: boolean;
  funder: string | null;
}

interface SigInfo { signature: string; blockTime: number | null }

export async function fetchDevHistory(
  rpc: Rpc,
  creator: string,
  currentMint: string,
  dbPriorLaunches: number,
  dbGraduated: number,
  maxTxFetch = 40,
): Promise<DevHistory | 'unknown'> {
  try {
    const sigs = await rpc.call<SigInfo[]>('getSignaturesForAddress', [creator, { limit: 1000 }]);

    let funder: string | null = null;
    if (sigs.length > 0 && sigs.length < 1000) {
      funder = await findFunder(rpc, creator, sigs[sigs.length - 1].signature);
    }

    let onchainCreations = 0;
    const toInspect = sigs.slice(0, maxTxFetch);
    for (let i = 0; i < toInspect.length; i += 5) {
      const batch = toInspect.slice(i, i + 5);
      const txs = await Promise.all(batch.map((s) =>
        rpc.call<TxJson | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }])
          .catch(() => null),
      ));
      for (const tx of txs) {
        if (isPumpCreation(tx) && !accountKeys(tx).includes(currentMint)) onchainCreations++;
      }
    }
    return {
      priorLaunches: Math.max(onchainCreations, dbPriorLaunches),
      anyGraduated: dbGraduated > 0,
      funder,
    };
  } catch {
    return 'unknown';
  }
}

interface TxJson {
  meta?: { logMessages?: string[] };
  transaction?: { message?: { accountKeys?: string[]; instructions?: unknown[] } };
}

function accountKeys(tx: TxJson | null): string[] {
  return tx?.transaction?.message?.accountKeys ?? [];
}

function isPumpCreation(tx: TxJson | null): boolean {
  if (!tx) return false;
  const logs = tx.meta?.logMessages ?? [];
  return accountKeys(tx).includes(PUMP_PROGRAM) && logs.some((l) => l.includes('Instruction: Create'));
}

interface ParsedTx {
  transaction?: {
    message?: {
      instructions?: Array<{ program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string } } }>;
    };
  };
}

async function findFunder(rpc: Rpc, wallet: string, oldestSig: string): Promise<string | null> {
  try {
    const tx = await rpc.call<ParsedTx | null>('getTransaction', [oldestSig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    for (const ix of tx?.transaction?.message?.instructions ?? []) {
      if (ix.program === 'system' && ix.parsed?.type === 'transfer' && ix.parsed.info?.destination === wallet) {
        return ix.parsed.info.source ?? null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
