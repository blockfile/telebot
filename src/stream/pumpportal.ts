import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { parseMessage } from './parse';

const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';

export class PumpPortalStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private tracked = new Set<string>();
  private backoffMs = 1000;
  private closed = false;
  private lastMessageAt = 0;
  private watchdog: NodeJS.Timeout | null = null;

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(PUMPPORTAL_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1000;
      this.lastMessageAt = Date.now();
      this.emit('status', 'connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
      if (this.tracked.size) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...this.tracked] }));
      }
    });

    ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      const parsed = parseMessage(data.toString(), Date.now());
      if (!parsed) return;
      if (parsed.type === 'new') this.emit('new', parsed.event);
      else if (parsed.type === 'migration') this.emit('migration', parsed.event);
      else this.emit('trade', parsed.event);
    });

    // 'error' always precedes 'close'; schedule the reconnect only from 'close' so it fires once
    ws.on('error', (err) => this.emit('status', `ws error: ${err.message}`));
    ws.on('close', () => {
      if (this.closed) return;
      this.emit('status', `reconnecting in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });

    this.ensureWatchdog();
  }

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (this.closed || !this.ws) return;
      if (this.lastMessageAt && Date.now() - this.lastMessageAt > 120_000) {
        this.emit('status', 'no messages for 120s — terminating stale socket');
        this.ws.terminate();
      }
    }, 60_000);
    this.watchdog.unref();
  }

  subscribeTrades(mint: string): void {
    this.tracked.add(mint);
    this.sendIfOpen({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  unsubscribeTrades(mint: string): void {
    this.tracked.delete(mint);
    this.sendIfOpen({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  close(): void {
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  private sendIfOpen(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}
