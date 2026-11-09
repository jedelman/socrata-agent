// The steward CLI (scripts/invites.js) against a stub `npx wrangler`, so no
// account or network is needed. The point: decisions touch nothing but KV
// unless the target env has BLUESKY_LOGIN = "true", as the Worker does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestKey, publicId } from '../worker/requests.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'invites.js');
const REAL_TOML = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
// The shipped config binds SIREN_DB (created 2026-11-09) with BLUESKY_LOGIN
// unset. Tests build each case from it with the D1 block taken out, then add
// back the binding or the flag they need.
const BASE_TOML = REAL_TOML.replace(/^\[\[env\.siren\.d1_databases\]\]\n(?:[a-z_]+ = .*\n)+/m, '');

let wranglerApi = null;
try {
  wranglerApi = await import('wrangler');
} catch {
  wranglerApi = null;
}
const SKIP = process.platform === 'win32' ? 'the npx stub is a POSIX script' : wranglerApi ? false : 'wrangler is not installed';

// A stand-in for `npx wrangler kv key ...` over a JSON file, and for
// `npx wrangler d1 execute ...`, which fails as wrangler 4.147 does without a
// binding (STUB_D1=missing), runs the SQL against a real SQLite file with the
// migrations applied (STUB_DB, where node:sqlite exists), or answers with
// STUB_D1_TALLY's count.
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(a) + '\\n');
const store = JSON.parse(fs.readFileSync(process.env.STUB_STORE, 'utf8'));
const save = () => fs.writeFileSync(process.env.STUB_STORE, JSON.stringify(store));
if (a[0] !== 'wrangler') process.exit(2);
if (a[1] === 'kv' && a[2] === 'key') {
  const op = a[3];
  if (op === 'list') {
    const prefix = a[a.indexOf('--prefix') + 1];
    process.stdout.write(JSON.stringify(Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name }))));
  } else if (op === 'get') {
    process.stdout.write(store[a[4]] ?? 'Value not found');
  } else if (op === 'put') {
    store[a[4]] = a[5];
    save();
  } else if (op === 'delete') {
    delete store[a[4]];
    save();
  }
  process.exit(0);
}
if (a[1] === 'd1' && a[2] === 'execute') {
  if (process.env.STUB_D1 === 'missing') {
    process.stdout.write(JSON.stringify({ error: { text: "Couldn't find a D1 DB with the name or binding 'SIREN_DB' in your wrangler.toml file." } }));
    process.exit(1);
  }
  const sql = a[a.indexOf('--command') + 1];
  if (process.env.STUB_DB) {
    // Run the CLI's SQL for real, one result array per statement, as wrangler does.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.env.STUB_DB);
    const out = sql.split(';').map((q) => q.trim()).filter(Boolean).map((q) => {
      const st = db.prepare(q);
      return { results: /^select\\b|\\breturning\\b/i.test(q) ? st.all().map((r) => ({ ...r })) : (st.run(), []) };
    });
    db.close();
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  if (/SELECT request_id, n/.test(sql)) {
    process.stdout.write(JSON.stringify([{ results: [] }, { results: JSON.parse(process.env.STUB_D1_TALLY || '[]') }]));
  } else {
    process.stdout.write(JSON.stringify([{ results: [] }]));
  }
  process.exit(0);
}
process.exit(3);
`;

const flagOn = (toml) => toml.replace('PUBLIC_ORIGIN = "https://jason-edelman.org"', 'PUBLIC_ORIGIN = "https://jason-edelman.org"\nBLUESKY_LOGIN = "true"');
const withDb = (toml) => `${toml}\n[[env.siren.d1_databases]]\nbinding = "SIREN_DB"\ndatabase_name = "siren"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n`;

async function setup(t, toml, extraEnv = {}, { devVars } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'siren-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), STUB);
  chmodSync(join(bin, 'npx'), 0o755);
  const config = join(dir, 'wrangler.toml');
  writeFileSync(config, toml);
  if (devVars) writeFileSync(join(dir, '.dev.vars'), devVars);
  const key = await requestKey('Test source');
  const id = publicId(key);
  const store = join(dir, 'store.json');
  writeFileSync(store, JSON.stringify({ [key]: JSON.stringify({ source: 'Test source', status: 'accepted', count: 2, needs: [] }) }));
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--config', config], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_STORE: store, STUB_LOG: log, ...extraEnv },
    });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const record = () => JSON.parse(JSON.parse(readFileSync(store, 'utf8'))[key]);
  return { id, run, calls, record, dir };
}

const d1Calls = (calls) => calls.filter((c) => c[1] === 'd1');

test('request-decline still writes the decision with no SIREN_DB and no flag', { skip: SKIP }, async (t) => {
  assert.ok(!/^BLUESKY_LOGIN\s*=/m.test(REAL_TOML), 'wrangler.toml ships with BLUESKY_LOGIN unset');
  assert.ok(!/^\[\[env\.siren\.d1_databases\]\]/m.test(BASE_TOML), 'BASE_TOML has no binding');
  const s = await setup(t, BASE_TOML, { STUB_D1: 'missing' });
  const out = s.run('request-decline', s.id);
  assert.equal(out.code, 0, out.out);
  assert.equal(s.record().status, 'declined');
  assert.equal(s.record().endorsements_at_decision, undefined);
  assert.deepEqual(d1Calls(s.calls()), [], 'no D1 call at all');
  assert.ok(s.calls().some((c) => c[3] === 'put'));
});

