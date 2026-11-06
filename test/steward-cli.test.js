// The steward CLI (scripts/invites.js) against a stub `npx wrangler`, so no
// account or network is needed. The point: decisions touch D1 only when the
// target env has BLUESKY_LOGIN = "true" and binds SIREN_DB, as the Worker does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestKey, publicId } from '../worker/requests.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'invites.js');
const REAL_TOML = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');

let wranglerApi = null;
try {
  wranglerApi = await import('wrangler');
} catch {
  wranglerApi = null;
}
const SKIP = process.platform === 'win32' ? 'the npx stub is a POSIX script' : wranglerApi ? false : 'wrangler is not installed';

// A stand-in for `npx wrangler kv key ...` over a JSON file, and for
// `npx wrangler d1 execute ...`, which fails as wrangler 4.147 does without a
// binding (STUB_D1=missing) or answers with STUB_D1_TALLY's count.
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

async function setup(t, toml, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'siren-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), STUB);
  chmodSync(join(bin, 'npx'), 0o755);
  const config = join(dir, 'wrangler.toml');
  writeFileSync(config, toml);
  const key = await requestKey('Test source');
  const id = publicId(key);
  const store = join(dir, 'store.json');
  writeFileSync(store, JSON.stringify({ [key]: JSON.stringify({ source: 'Test source', status: 'accepted', count: 2, needs: [] }) }));
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const run = (...args) => {
    try {
      const stderr = execFileSync(process.execPath, [CLI, ...args, '--config', config], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_STORE: store, STUB_LOG: log, ...extraEnv },
      });
      return { code: 0, out: stderr };
    } catch (err) {
      return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const record = () => JSON.parse(JSON.parse(readFileSync(store, 'utf8'))[key]);
  return { id, run, calls, record };
}

const d1Calls = (calls) => calls.filter((c) => c[1] === 'd1');

test('request-decline still writes the decision with no SIREN_DB and no flag (the shipped config)', { skip: SKIP }, async (t) => {
  assert.ok(!/^\[\[env\.siren\.d1_databases\]\]/m.test(REAL_TOML) && !/^BLUESKY_LOGIN\s*=/m.test(REAL_TOML), 'the test assumes wrangler.toml ships without the binding and the flag');
  const s = await setup(t, REAL_TOML, { STUB_D1: 'missing' });
  const out = s.run('request-decline', s.id);
  assert.equal(out.code, 0, out.out);
  assert.equal(s.record().status, 'declined');
  assert.equal(s.record().endorsements_at_decision, undefined);
  assert.deepEqual(d1Calls(s.calls()), [], 'no D1 call at all');
  assert.ok(s.calls().some((c) => c[3] === 'put'));
});

test('a binding without the flag: decisions skip D1, as the Worker does', { skip: SKIP }, async (t) => {
  const s = await setup(t, withDb(REAL_TOML), { STUB_D1: 'missing' });
  const out = s.run('request-fulfilled', s.id, '--by', 'https://github.com/o/r/pull/9');
  assert.equal(out.code, 0, out.out);
  assert.equal(s.record().status, 'fulfilled');
  assert.deepEqual(d1Calls(s.calls()), []);
});

test('the flag and the binding: a decision freezes the count, then clears the rows', { skip: SKIP }, async (t) => {
  const id = publicId(await requestKey('Test source'));
  const tally = JSON.stringify([{ request_id: id, n: 3, young: 1, unknown: 0 }]);
  const s2 = await setup(t, withDb(flagOn(REAL_TOML)), { STUB_D1_TALLY: tally });
  const out2 = s2.run('request-decline', s2.id);
  assert.equal(out2.code, 0, out2.out);
  assert.equal(s2.record().status, 'declined');
  assert.equal(s2.record().endorsements_at_decision?.n, 3);
  const d1 = d1Calls(s2.calls());
  assert.equal(d1.length, 2, 'the tally, then the clear');
  assert.match(d1[1][d1[1].indexOf('--command') + 1], /^DELETE FROM endorsements WHERE request_id = '[0-9a-f]{12}'$/);
  const order = s2.calls().map((c) => (c[1] === 'd1' ? 'd1' : c[3]));
  assert.ok(order.indexOf('put') > order.indexOf('d1') && order.lastIndexOf('d1') > order.indexOf('put'), 'read, write the decision, clear');
});

test('the flag on and D1 failing: the decision is refused before anything is written', { skip: SKIP }, async (t) => {
  const s = await setup(t, withDb(flagOn(REAL_TOML)), { STUB_D1: 'missing' });
  const out = s.run('request-decline', s.id);
  assert.notEqual(out.code, 0);
  assert.equal(s.record().status, 'accepted', 'nothing decided');
  assert.ok(!s.calls().some((c) => c[3] === 'put'));
});

test('--endorsements and --no-endorsements override the flag; the read commands need the binding', { skip: SKIP }, async (t) => {
  const s = await setup(t, withDb(REAL_TOML), { STUB_D1_TALLY: '[]' });
  assert.equal(s.run('request-decline', s.id, '--endorsements').code, 0);
  assert.equal(d1Calls(s.calls()).length, 1, 'forced: the tally is read (nothing to clear)');
  const bare = await setup(t, REAL_TOML);
  const forced = bare.run('request-decline', bare.id, '--endorsements');
  assert.notEqual(forced.code, 0);
  assert.match(forced.out, /binds no SIREN_DB/);
  assert.equal(bare.record().status, 'accepted');
  const on = await setup(t, withDb(flagOn(REAL_TOML)), { STUB_D1: 'missing' });
  assert.equal(on.run('request-decline', on.id, '--no-endorsements').code, 0);
  assert.equal(on.record().status, 'declined');
  assert.deepEqual(d1Calls(on.calls()), []);
  const listed = bare.run('endorsements');
  assert.notEqual(listed.code, 0);
  assert.match(listed.out, /binds no SIREN_DB/);
  assert.deepEqual(d1Calls(bare.calls()), []);
});
