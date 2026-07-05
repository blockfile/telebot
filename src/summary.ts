import type { Db } from './db/index';

export async function maybeSendSummary(
  db: Db,
  send: (text: string) => Promise<boolean>,
  hourLocal: number,
  now: Date,
  lastSentDay: number,
): Promise<number> {
  if (now.getHours() !== hourLocal || now.getDate() === lastSentDay) return lastSentDay;
  const c = db.countsSince(now.getTime() - 24 * 3_600_000);
  await send(`📊 Trenches daily: scanned ${c.seen} • watched ${c.watched} • alerted ${c.alerted}`);
  return now.getDate();
}
