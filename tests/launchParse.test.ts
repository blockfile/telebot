import { describe, it, expect } from 'vitest';
import { buysFromTx, devTransfersFromTx } from '../src/checks/launchParse';

const MINT = 'MintX';

// A pump buy: buyer's token balance for MINT goes 0 -> 1,000,000; bonding curve (excluded) drops.
const buyTx = (owner: string, pre: number, post: number) => ({
  meta: {
    preTokenBalances: pre === 0 ? [] : [{ accountIndex: 3, mint: MINT, owner, uiTokenAmount: { uiAmount: pre } }],
    postTokenBalances: [{ accountIndex: 3, mint: MINT, owner, uiTokenAmount: { uiAmount: post } }],
  },
});

describe('buysFromTx', () => {
  it('returns positive balance deltas for the mint, excluding listed owners', () => {
    expect(buysFromTx(buyTx('buyer1', 0, 1_000_000), MINT, new Set())).toEqual([{ owner: 'buyer1', amount: 1_000_000 }]);
    expect(buysFromTx(buyTx('dev1', 0, 2_000_000), MINT, new Set(['dev1']))).toEqual([]);
  });

  it('ignores other mints, sells (negative delta), and malformed txs', () => {
    const otherMint = { meta: { preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, mint: 'OTHER', owner: 'x', uiTokenAmount: { uiAmount: 5 } }] } };
    expect(buysFromTx(otherMint, MINT, new Set())).toEqual([]);
    expect(buysFromTx(buyTx('seller', 1_000_000, 400_000), MINT, new Set())).toEqual([]); // sold, delta negative
    expect(buysFromTx(null, MINT, new Set())).toEqual([]);
    expect(buysFromTx({}, MINT, new Set())).toEqual([]);
  });

  it('returns []/0 on nested-malformed input instead of throwing', () => {
    expect(buysFromTx({ meta: { postTokenBalances: [null], preTokenBalances: 'nope' } }, 'MintX', new Set())).toEqual([]);
  });
});

describe('devTransfersFromTx', () => {
  const transferTx = (authority: string, mint: string, amount: number, inner = false) => {
    const ix = { program: 'spl-token', parsed: { type: 'transferChecked', info: { authority, mint, tokenAmount: { uiAmount: amount } } } };
    return inner
      ? { meta: { innerInstructions: [{ instructions: [ix] }] }, transaction: { message: { instructions: [] } } }
      : { meta: { innerInstructions: [] }, transaction: { message: { instructions: [ix] } } };
  };

  it('sums transferChecked of the mint authorized by the dev (top-level and inner)', () => {
    expect(devTransfersFromTx(transferTx('dev1', MINT, 62_000_000), MINT, 'dev1')).toBe(62_000_000);
    expect(devTransfersFromTx(transferTx('dev1', MINT, 5_000_000, true), MINT, 'dev1')).toBe(5_000_000);
  });

  it('ignores transfers by others, of other mints, and non-transfer instructions', () => {
    expect(devTransfersFromTx(transferTx('someoneElse', MINT, 9), MINT, 'dev1')).toBe(0);
    expect(devTransfersFromTx(transferTx('dev1', 'OTHER', 9), MINT, 'dev1')).toBe(0);
    expect(devTransfersFromTx(null, MINT, 'dev1')).toBe(0);
  });

  it('sums transferChecked under the token-2022 program', () => {
    const tx = { meta: { innerInstructions: [] }, transaction: { message: { instructions: [
      { program: 'spl-token-2022', parsed: { type: 'transferChecked', info: { authority: 'dev1', mint: 'MintX', tokenAmount: { uiAmount: 7_000_000 } } } },
    ] } } };
    expect(devTransfersFromTx(tx, 'MintX', 'dev1')).toBe(7_000_000);
  });

  it('returns []/0 on nested-malformed input instead of throwing', () => {
    expect(devTransfersFromTx({ transaction: { message: { instructions: [null] } }, meta: { innerInstructions: [null] } }, 'MintX', 'dev1')).toBe(0);
  });
});
