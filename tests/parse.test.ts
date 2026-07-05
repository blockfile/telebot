import { describe, it, expect } from 'vitest';
import { parseMessage } from '../src/stream/parse';

const CREATE = JSON.stringify({
  signature: 'sig1', mint: 'MintPubkey111', traderPublicKey: 'DevWallet111', txType: 'create',
  initialBuy: 35000000, solAmount: 1.0, bondingCurveKey: 'Curve111',
  vTokensInBondingCurve: 1000000000, vSolInBondingCurve: 31, marketCapSol: 31.5,
  name: 'Cool Token', symbol: 'COOL', uri: 'https://ipfs.io/ipfs/abc', pool: 'pump',
});

const BUY = JSON.stringify({
  signature: 'sig2', mint: 'MintPubkey111', traderPublicKey: 'Buyer111', txType: 'buy',
  tokenAmount: 1000000, solAmount: 0.5, newTokenBalance: 1000000,
  bondingCurveKey: 'Curve111', marketCapSol: 33.1, pool: 'pump',
});

describe('parseMessage', () => {
  it('parses a create message into NewTokenEvent', () => {
    const r = parseMessage(CREATE, 1234);
    expect(r?.type).toBe('new');
    if (r?.type !== 'new') return;
    expect(r.event).toMatchObject({
      mint: 'MintPubkey111', creator: 'DevWallet111', symbol: 'COOL', name: 'Cool Token',
      uri: 'https://ipfs.io/ipfs/abc', devBuyTokens: 35000000, devBuySol: 1.0,
      bondingCurveKey: 'Curve111', marketCapSol: 31.5, signature: 'sig1', receivedAt: 1234,
    });
  });

  it('parses buy and sell messages into TradeEvent', () => {
    const r = parseMessage(BUY, 5678);
    expect(r?.type).toBe('trade');
    if (r?.type !== 'trade') return;
    expect(r.event).toMatchObject({
      mint: 'MintPubkey111', trader: 'Buyer111', isBuy: true,
      tokenAmount: 1000000, solAmount: 0.5, marketCapSol: 33.1, receivedAt: 5678,
    });
    const sell = parseMessage(BUY.replace('"buy"', '"sell"'), 1);
    expect(sell?.type === 'trade' && sell.event.isBuy).toBe(false);
  });

  it('returns null for confirmations, garbage, and missing mint', () => {
    expect(parseMessage('{"message":"Successfully subscribed"}', 1)).toBeNull();
    expect(parseMessage('not json', 1)).toBeNull();
    expect(parseMessage('{"txType":"create"}', 1)).toBeNull();
  });
});
