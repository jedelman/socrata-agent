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
import { requestKey, publicId, idKey, pidKey } from '../worker/requests.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'invites.js');
const REAL_TOML = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
// The shipped config, with BLUESKY_LOGIN unset; cases add the flag they need.
const BASE_TOML = REAL_TOML;

let wranglerApi = null;
try {
  wranglerApi = await import('wrangler');
} catch {
  wranglerApi = null;
}
const SKIP = process.platform === 'win32' ? 'the npx stub is a POSIX script' : wranglerApi ? false : 'wrangler is not installed';

// A stand-in for `npx wrangler kv key ...` over a JSON file, and a fetch
// stub loaded into the CLI with --import: STUB_FETCH=ok:<n> answers
// Constellation with that total, STUB_FETCH=down fails; every URL is logged.
const STUB = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(a) + '\\n');
const store = JSON.parse(fs.readFileSync(process.env.STUB_STORE, 'utf8'));
const save = () => fs.writeFileSync(process.env.STUB_STORE, JSON.stringify(store));
if (a[0] !== 'wrangler' || a[1] !== 'kv' || a[2] !== 'key') process.exit(2);
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
`;
const FETCH_STUB = `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url) => {
  appendFileSync(process.env.STUB_FETCH_LOG, String(url) + '\\n');
  const mode = process.env.STUB_FETCH || 'down';
  if (mode === 'down') return new Response('down', { status: 503 });
  return new Response(JSON.stringify({ total: Number(mode.split(':')[1]), linking_dids: [], cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
`;

const flagOn = (toml) => toml.replace('PUBLIC_ORIGIN = "https://jason-edelman.org"', 'PUBLIC_ORIGIN = "https://jason-edelman.org"\nBLUESKY_LOGIN = "true"');
const RANDOM_ID = 'abcdefghijklmnop';

async function setup(t, toml, extraEnv = {}, { devVars, legacy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'siren-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npx'), STUB);
  chmodSync(join(bin, 'npx'), 0o755);
  writeFileSync(join(dir, 'fetch-stub.mjs'), FETCH_STUB);
  const config = join(dir, 'wrangler.toml');
  writeFileSync(config, toml);
  if (devVars) writeFileSync(join(dir, '.dev.vars'), devVars);
  const key = await requestKey('Test source');
  const id = legacy ? publicId(key) : RANDOM_ID;
  const store = join(dir, 'store.json');
  const kv = { [key]: JSON.stringify({ source: 'Test source', status: 'accepted', count: 2, needs: [] }) };
  if (!legacy) Object.assign(kv, { [idKey(key)]: JSON.stringify({ id }), [pidKey(id)]: key.slice('request:'.length) });
  writeFileSync(store, JSON.stringify(kv));
  const log = join(dir, 'log.jsonl');
  const fetchLog = join(dir, 'fetch.log');
  writeFileSync(log, '');
  writeFileSync(fetchLog, '');
  const run = (...args) => {
    const r = spawnSync(process.execPath, ['--import', join(dir, 'fetch-stub.mjs'), CLI, ...args, '--config', config], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, STUB_STORE: store, STUB_LOG: log, STUB_FETCH_LOG: fetchLog, ...extraEnv },
    });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const fetches = () => readFileSync(fetchLog, 'utf8').trim().split('\n').filter(Boolean);
  const record = () => JSON.parse(JSON.parse(readFileSync(store, 'utf8'))[key]);
  return { id, run, calls, fetches, record, dir };
}

test('the flag off: a decision writes KV only, and calls no network', { skip: SKIP }, async (t) => {
  assert.ok(!/^BLUESKY_LOGIN\s*=/m.test(REAL_TOML), 'wrangler.toml ships with BLUESKY_LOGIN unset');
  const s = await setup(t, BASE_TOML, { STUB_FETCH: 'ok:4' });
  const out = s.run('request-decline', s.id);
  assert.equal(out.code, 0, out.out);
  assert.equal(s.record().status, 'declined');
  assert.equal(s.record().endorsements_at_decision, undefined);
  assert.deepEqual(s.fetches(), []);
  assert.ok(s.calls().some((c) => c[3] === 'put'));
});

test('the flag on: a decision freezes the live Constellation count', { skip: SKIP }, async (t) => {
  const s = await setup(t, flagOn(BASE_TOML), { STUB_FETCH: 'ok:4' });
  const out = s.run('request-fulfilled', s.id, '--by', 'https://github.com/o/r/pull/1');
  assert.equal(out.code, 0, out.out);
  assert.equal(s.record().endorsements_at_decision, 4);
  assert.match(out.out, /4 endorsements frozen/);
  const [url] = s.fetches();
  assert.equal(new URL(url).origin, 'https://constellation.microcosm.blue');
  assert.equal(new URL(url).searchParams.get('subject'), `https://jason-edelman.org/ask-siren/requests/${RANDOM_ID}`);
});

test('the flag on and Constellation down: decided anyway, unfrozen, and said (D10)', { skip: SKIP }, async (t) => {
  const s = await setup(t, flagOn(BASE_TOML), { STUB_FETCH: 'down' });
  const out = s.run('request-decline', s.id);
  assert.equal(out.code, 0, out.out);
  assert.equal(s.record().status, 'declined');
  assert.equal(s.record().endorsements_at_decision, undefined);
  assert.match(out.out, /couldn't be read/);
});

test('--no-endorsements skips the count; a legacy id is never counted', { skip: SKIP }, async (t) => {
  const s = await setup(t, flagOn(BASE_TOML), { STUB_FETCH: 'ok:4' });
  assert.equal(s.run('request-decline', s.id, '--no-endorsements').code, 0);
  assert.deepEqual(s.fetches(), []);
  const legacy = await setup(t, flagOn(BASE_TOML), { STUB_FETCH: 'ok:4' }, { legacy: true });
  assert.equal(legacy.run('request-decline', legacy.id).code, 0);
  assert.deepEqual(legacy.fetches(), []);
});

test('--local reads .dev.vars: BLUESKY_LOGIN=true there turns on the freeze, as wrangler dev would', { skip: SKIP }, async (t) => {
  const s = await setup(t, BASE_TOML, { STUB_FETCH: 'ok:2' }, { devVars: 'BLUESKY_LOGIN=true\n' });
  const out = s.run('request-decline', s.id, '--local');
  assert.equal(out.code, 0, out.out);
  assert.equal(s.record().endorsements_at_decision, 2);
  assert.ok(s.calls().every((c) => c.includes('--local') && !c.includes('--remote')));
  const remote = await setup(t, BASE_TOML, { STUB_FETCH: 'ok:2' }, { devVars: 'BLUESKY_LOGIN=true\n' });
  assert.equal(remote.run('request-decline', remote.id).code, 0);
  assert.deepEqual(remote.fetches(), [], 'without --local, .dev.vars does not count');
});

test("a config wrangler can't read: decisions refuse before writing, and name the flag that bypasses it", { skip: SKIP }, async (t) => {
  const s = await setup(t, 'this is = = not toml [[[');
  const out = s.run('request-decline', s.id);
  assert.notEqual(out.code, 0);
  assert.match(out.out, /--no-endorsements/);
  assert.equal(s.record().status, 'accepted');
  assert.deepEqual(s.calls(), [], 'no KV call before the refusal');
  assert.equal(s.run('request-decline', s.id, '--no-endorsements').code, 0);
  assert.equal(s.record().status, 'declined');
});

test('endorsements <id> prints the live count and the public list link', { skip: SKIP }, async (t) => {
  const s = await setup(t, BASE_TOML, { STUB_FETCH: 'ok:7' });
  const out = s.run('endorsements', s.id);
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, new RegExp(`${RANDOM_ID}\\s+7\\s+Test source`));
  assert.match(out.out, new RegExp(`https://jason-edelman.org/ask-siren/requests/${RANDOM_ID}`));
});
