// A small fake of a Cloudflare D1 binding over node:sqlite, so the SQL in
// worker/endorsements.js and worker/bluesky.js really runs, against the real
// migrations in migrations/. It implements what Siren uses: prepare, bind,
// first, all, run and batch (one transaction, all or nothing), and D1's
// limit of 100 bound parameters per statement, and reports meta.changes the
// way D1 does (trigger writes included). It keeps an op log and can be told
// to fail, for the storage-error tests.
//
// node:sqlite is new (Node 22.5+). Where it's missing, `D1_SKIP` is a reason
// string and the tests that need a database skip; everything else still runs.
// SIREN_FAKE_D1=off simulates that, to check the skips.

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let sqlite = null;
if (process.env.SIREN_FAKE_D1 !== 'off') {
  try {
    sqlite = await import('node:sqlite');
  } catch {
    sqlite = null;
  }
}

export const D1_SKIP = sqlite ? false : 'node:sqlite is not available in this Node';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** The migration files, in order: [{ name, sql }]. */
export function migrations() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

const RETURNS_ROWS = /^\s*(?:--[^\n]*\n\s*)*(select|with|pragma|explain)\b|\breturning\b/i;

function check(params) {
  if (params.length > 100) throw new Error('D1_ERROR: too many SQL variables (D1 allows 100 bound parameters)');
  for (const p of params) {
    if (p === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported for value \'undefined\'');
    if (typeof p === 'boolean' || (typeof p === 'object' && p !== null)) throw new Error(`fake D1: bind a number, string or null, not ${typeof p}`);
  }
}

/** -> a D1-like binding, or null when node:sqlite is missing. */
export function fakeD1({ migrate = true } = {}) {
  if (!sqlite) return null;
  const db = new sqlite.DatabaseSync(':memory:');
  if (migrate) for (const m of migrations()) db.exec(m.sql);
  const ops = [];
  const d1 = {
    sqlite: db,
    ops,
    fail: false, // every call throws, like an unbound or over-quota database
    failWrites: false, // statements that change rows throw
    calls: () => ops.length,
    prepare(sql) {
      return statement(sql, []);
    },
    async batch(stmts) {
      ops.push({ op: 'batch', sql: stmts.map((s) => s.sql), params: stmts.map((s) => s.params) });
      if (d1.fail) throw new Error('D1_ERROR: fake failure');
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => exec(s.sql, s.params));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) {
      ops.push({ op: 'exec', sql });
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    /** Rows in a table (test helper, not part of D1). */
    rows(table) {
      return db.prepare(`SELECT * FROM ${table}`).all().map((r) => ({ ...r }));
    },
  };

  const totalChanges = () => Number(db.prepare('SELECT total_changes() AS n').get().n);

  function exec(sql, params) {
    check(params);
    const writes = !/^\s*(select|with|explain)\b/i.test(sql);
    if (writes && d1.failWrites) throw new Error('D1_ERROR: fake write failure');
    const st = db.prepare(sql);
    // meta.changes as D1 reports it: every row the statement changed,
    // including its triggers' writes (measured on local D1, wrangler 4.147,
    // 2026-11-06: one DELETE of 50 endorsements reports 100). SQLite's
    // total_changes() counts trigger writes too; its delta is that number.
    const before = totalChanges();
    const results = RETURNS_ROWS.test(sql) ? st.all(...params).map((r) => ({ ...r })) : (st.run(...params), []);
    return { success: true, results, meta: { changes: writes ? totalChanges() - before : 0 } };
  }

  function statement(sql, params) {
    return {
      sql,
      params,
      bind(...args) {
        return statement(sql, args);
      },
      async all() {
        ops.push({ op: 'all', sql, params });
        if (d1.fail) throw new Error('D1_ERROR: fake failure');
        return exec(sql, params);
      },
      async run() {
        ops.push({ op: 'run', sql, params });
        if (d1.fail) throw new Error('D1_ERROR: fake failure');
        return exec(sql, params);
      },
      async first(col) {
        ops.push({ op: 'first', sql, params });
        if (d1.fail) throw new Error('D1_ERROR: fake failure');
        const row = exec(sql, params).results[0] ?? null;
        return col === undefined || row === null ? row : row[col];
      },
    };
  }

  return d1;
}
