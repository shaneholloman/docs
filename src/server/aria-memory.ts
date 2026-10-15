import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { visitorIdSchema, visitorProfileSchema } from '../shared/aria-contracts.ts';
import type { ResponseItem, VisitorProfile } from '../shared/aria-contracts.ts';

const messageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(6000)
});
const historySchema = z.array(messageSchema).max(16);
type Row = {
  history: string;
  profile: string | null;
  first_seen: number;
  last_seen: number;
  sessions: number;
  duration_ms: number;
};

export function createVisitorStore(
  filename: string,
  { now = Date.now, retentionMilliseconds = 30 * 24 * 60 * 60_000, maxVisitors = 1000 } = {}
) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename, { create: true, strict: true });
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY, history TEXT NOT NULL DEFAULT '[]', profile TEXT,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      sessions INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS visitors_last_seen ON visitors(last_seen);`);
  const key = (id: string) =>
    new Bun.CryptoHasher('sha256').update(visitorIdSchema.parse(id)).digest('hex');
  const get = db.query<Row, [string, number]>(
    'SELECT * FROM visitors WHERE id = ? AND last_seen >= ?'
  );
  const touch = db.query(
    `INSERT INTO visitors (id, first_seen, last_seen, profile, sessions) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
       profile = COALESCE(excluded.profile, visitors.profile),
       sessions = visitors.sessions + excluded.sessions`
  );
  function prune() {
    db.query('DELETE FROM visitors WHERE last_seen < ?').run(now() - retentionMilliseconds);
    db.query(
      'DELETE FROM visitors WHERE id IN (SELECT id FROM visitors ORDER BY last_seen DESC LIMIT -1 OFFSET ?)'
    ).run(maxVisitors);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  prune();
  const cleanup = setInterval(prune, 60 * 60_000);
  cleanup.unref();
  function read(id: string) {
    const row = get.get(key(id), now() - retentionMilliseconds);
    if (!row) return;
    const messages = historySchema.parse(JSON.parse(row.history));
    const history: ResponseItem[] = messages.map(({ role, text }) => ({
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
    }));
    return {
      history,
      sessions: row.sessions,
      durationMilliseconds: row.duration_ms,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      profile: row.profile ? visitorProfileSchema.parse(JSON.parse(row.profile)) : undefined
    };
  }
  const append = db.transaction((id: string, role: 'user' | 'assistant', text: string) => {
    const value = text.trim().slice(0, 6000);
    if (!value) return;
    const hash = key(id);
    const row = get.get(hash, now() - retentionMilliseconds);
    if (!row) db.query('DELETE FROM visitors WHERE id = ?').run(hash);
    const messages = row ? historySchema.parse(JSON.parse(row.history)) : [];
    const previous = messages.at(-1);
    if (previous?.role === role && previous.text === value) return;
    messages.push({ role, text: value });
    const time = now();
    touch.run(hash, time, time, null, 0);
    db.query('UPDATE visitors SET history = ? WHERE id = ?').run(
      JSON.stringify(messages.slice(-16)),
      hash
    );
    db.query(
      'DELETE FROM visitors WHERE id IN (SELECT id FROM visitors ORDER BY last_seen DESC LIMIT -1 OFFSET ?)'
    ).run(maxVisitors);
  });
  return {
    read,
    append,
    profile(id: string, profile?: VisitorProfile) {
      if (!profile) return;
      const time = now();
      touch.run(key(id), time, time, JSON.stringify(visitorProfileSchema.parse(profile)), 0);
    },
    connected(id: string, profile?: VisitorProfile) {
      // Expired identities start fresh, even between hourly cleanup runs.
      db.query('DELETE FROM visitors WHERE id = ? AND last_seen < ?').run(
        key(id),
        now() - retentionMilliseconds
      );
      const time = now();
      touch.run(
        key(id),
        time,
        time,
        profile ? JSON.stringify(visitorProfileSchema.parse(profile)) : null,
        1
      );
      prune();
    },
    ended(id: string, durationMilliseconds: number) {
      db.query('UPDATE visitors SET duration_ms = duration_ms + ?, last_seen = ? WHERE id = ?').run(
        Math.max(0, Math.round(durationMilliseconds)),
        now(),
        key(id)
      );
    },
    prune,
    close() {
      clearInterval(cleanup);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    }
  };
}
export type VisitorStore = ReturnType<typeof createVisitorStore>;
