import type { NewTokenEvent, TradeEvent, MigrationEvent } from '../types';

type Parsed =
  | { type: 'new'; event: NewTokenEvent }
  | { type: 'trade'; event: TradeEvent }
  | { type: 'migration'; event: MigrationEvent }
  | { type: 'notice'; text: string }
  | null;

export function parseMessage(raw: string, receivedAt: number): Parsed {
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object') return null;
  // server acks and errors (e.g. "subscribeTokenTrade requires an API key") must never be dropped silently
  if (typeof msg.message === 'string') return { type: 'notice', text: msg.message };
  if (typeof msg.mint !== 'string' || !msg.mint) return null;

  if (msg.txType === 'create') {
    return {
      type: 'new',
      event: {
        mint: msg.mint,
        name: String(msg.name ?? ''),
        symbol: String(msg.symbol ?? ''),
        uri: String(msg.uri ?? ''),
        creator: String(msg.traderPublicKey ?? ''),
        devBuyTokens: Number(msg.initialBuy ?? 0),
        devBuySol: Number(msg.solAmount ?? 0),
        bondingCurveKey: String(msg.bondingCurveKey ?? ''),
        marketCapSol: Number(msg.marketCapSol ?? 0),
        signature: String(msg.signature ?? ''),
        receivedAt,
      },
    };
  }
  if (msg.txType === 'migrate') {
    return {
      type: 'migration',
      event: { mint: msg.mint, signature: String(msg.signature ?? ''), receivedAt },
    };
  }
  if (msg.txType === 'buy' || msg.txType === 'sell') {
    return {
      type: 'trade',
      event: {
        mint: msg.mint,
        trader: String(msg.traderPublicKey ?? ''),
        isBuy: msg.txType === 'buy',
        tokenAmount: Number(msg.tokenAmount ?? 0),
        solAmount: Number(msg.solAmount ?? 0),
        marketCapSol: Number(msg.marketCapSol ?? 0),
        signature: String(msg.signature ?? ''),
        receivedAt,
      },
    };
  }
  return null;
}
