export const TOTAL_SUPPLY = 1_000_000_000;

export interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  devBuyTokens: number;
  devBuySol: number;
  bondingCurveKey: string;
  marketCapSol: number;
  signature: string;
  receivedAt: number;
}

export interface TradeEvent {
  mint: string;
  trader: string;
  isBuy: boolean;
  tokenAmount: number;
  solAmount: number;
  marketCapSol: number;
  signature: string;
  receivedAt: number;
}

export interface TokenMeta {
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface MigrationEvent {
  mint: string;
  signature: string;
  receivedAt: number;
}
