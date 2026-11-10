// A D1 binding for tests, over node:sqlite with the real migration applied,
// so the free tier's statements run as written. Every statement run is
// logged with its bound values (`log`), for the privacy test. Where
// node:sqlite is missing (Node before 22.13), `hasSqlite` is false and the
// tests that need it skip.

import { readFileSync } from 'node:fs';

let sqlite = null;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = null;
}
export const hasSqlite = Boolean(sqlite?.DatabaseSync);

const MIGRATION = new URL('../migrations/0004_public_questions.sql', import.meta.url);

export function fakeD1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(readFileSync(MIGRATION, 'utf8'));
  const log = [];
  const binding = { db, log, fail: false };
  const plain = (r) => (r ? { ...r } : null);
  const stmt = (sql, params = []) => ({
    bind: (...args) => stmt(sql, args),
    async first(col) {
      log.push({ sql, params });
      if (binding.fail) throw new Error('D1_ERROR: unavailable');
      const r = plain(db.prepare(sql).get(...params));
      return r && col ? r[col] : r;
    },
    async all() {
      log.push({ sql, params });
      if (binding.fail) throw new Error('D1_ERROR: unavailable');
      return { results: db.prepare(sql).all(...params).map(plain), success: true, meta: {} };
    },
    async run() {
      log.push({ sql, params });
      if (binding.fail) throw new Error('D1_ERROR: unavailable');
      const out = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(out.changes), last_row_id: Number(out.lastInsertRowid) } };
    },
  });
  binding.prepare = (sql) => stmt(sql);
  binding.batch = async (list) => Promise.all(list.map((s) => s.run()));
  /** Every row, as stored. */
  binding.rows = () => db.prepare('SELECT * FROM public_questions ORDER BY seq').all().map(plain);
  return binding;
}
