import { describe, it, expect } from 'vitest';
import { maybeSendSummary } from '../src/summary';
import { Db } from '../src/db/index';

describe('maybeSendSummary', () => {
  it('sends once when the hour matches, then not again the same day', async () => {
    const db = new Db(':memory:');
    const sent: string[] = [];
    const send = async (t: string) => { sent.push(t); return true; };

    const at9 = new Date(2026, 6, 5, 9, 0, 0);
    let last = await maybeSendSummary(db, send, 9, at9, -1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/scanned 0 • watched 0 • alerted 0/);
    expect(last).toBe(5);

    last = await maybeSendSummary(db, send, 9, at9, last);
    expect(sent).toHaveLength(1); // no double send

    const at8 = new Date(2026, 6, 6, 8, 0, 0);
    last = await maybeSendSummary(db, send, 9, at8, last);
    expect(sent).toHaveLength(1); // wrong hour
  });
});
