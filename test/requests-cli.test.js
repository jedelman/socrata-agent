// The steward's command line for source requests (scripts/invites.js), run
// against a stand-in `npx wrangler` on PATH that keeps KV in a JSON file.
// Skips on Windows, where a shebang script can't stand in for npx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestKey, deletedKey, decisionKey, publicId } from '../worker/requests.js';

const skip = process.platform === 'win32' && 'needs a POSIX shebang for the npx stand-in';
const CLI = fileURLToPath(new URL('../scripts/invites.js', import.meta.url));

// `npx wrangler kv key get|put|list <...> --binding LIMITS ...`, as the CLI calls it.
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_KV;
const kv = JSON.parse(fs.readFileSync(file, 'utf8'));
const [, , , , , op, ...rest] = process.argv;
const key = rest[0];
const fail = process.env.FAKE_FAIL_KEY;
if (fail && key === fail) { process.stderr.write('Authentication error [code: 10000]\\n'); process.exit(1); }
if (op === 'get') process.stdout.write(key in kv ? kv[key] : 'Value not found');
else if (op === 'put') { kv[key] = rest[1]; fs.writeFileSync(file, JSON.stringify(kv)); }
else if (op === 'list') { const p = rest[rest.indexOf('--prefix') + 1]; process.stdout.write(JSON.stringify(Object.keys(kv).filter((k) => k.startsWith(p)).map((name) => ({ name })))); }
else process.exit(2);
`;

function world(store) {
  const dir = mkdtempSync(join(tmpdir(), 'requests-cli-'));
  writeFileSync(join(dir, 'npx'), FAKE_NPX);
  chmodSync(join(dir, 'npx'), 0o755);
  const file = join(dir, 'kv.json');
  writeFileSync(file, JSON.stringify(store));
  const run = (args, extra = {}) => {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_KV: file, ...extra } });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') };
    }
  };
  return { run, read: () => JSON.parse(readFileSync(file, 'utf8')), write: (kv) => writeFileSync(file, JSON.stringify(kv)), done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function fixture() {
  const key = await requestKey('Tree permits');
  const rec = {
    source: 'Tree permits', url: '', count: 3, first: '2026-11-01', last: '2026-11-05', status: 'accepted', decided: '2026-11-02', was_public: true,
    needs: [
      { id: 'n00000001', text: 'first', day: '2026-11-01', public: true, review: 'ok' },
      { id: 'n00000002', text: 'names Jane Doe', day: '2026-11-03', public: true, review: 'ok' },
      { id: 'n00000003', text: 'private one', day: '2026-11-04', public: false, review: 'pending' },
      { id: 'n00000004', text: 'awaiting', day: '2026-11-05', public: true, review: 'pending' },
    ],
  };
  return { key, rec };
}

test('request-note delete keeps earlier tombstones, and a failed tombstone read writes nothing', { skip }, async () => {
  const { key, rec } = await fixture();
  const w = world({ [key]: JSON.stringify(rec), [deletedKey(key)]: JSON.stringify(['n00000001']) });
  try {
    const id = publicId(key);
    const failed = w.run(['request-note', id, 'n00000002', 'delete'], { FAKE_FAIL_KEY: deletedKey(key) });
    assert.notEqual(failed.code, 0, 'a tombstone read that fails stops the delete');
    assert.match(failed.stderr, /Authentication error/);
    assert.deepEqual(JSON.parse(w.read()[deletedKey(key)]), ['n00000001'], 'the stored tombstone is untouched');
    assert.ok(w.read()[key].includes('names Jane Doe'));

    assert.equal(w.run(['request-note', id, 'n00000002', 'delete']).code, 0);
    assert.deepEqual(JSON.parse(w.read()[deletedKey(key)]), ['n00000001', 'n00000002']);
    assert.ok(!w.read()[key].includes('names Jane Doe'));
    assert.equal(w.run(['request-note', id, 'n00000004', 'approve']).code, 0);
    assert.equal(JSON.parse(w.read()[key]).needs.find((n) => n.id === 'n00000004').review, 'ok');
  } finally {
    w.done();
  }
});

test('a missing tombstone counts as empty', { skip }, async () => {
  const { key, rec } = await fixture();
  const w = world({ [key]: JSON.stringify(rec) });
  try {
    assert.equal(w.run(['request-note', publicId(key), 'n00000002', 'delete']).code, 0);
    assert.deepEqual(JSON.parse(w.read()[deletedKey(key)]), ['n00000002']);
  } finally {
    w.done();
  }
});

test('request-decline writes the decision key; requests marks only public notes pending', { skip }, async () => {
  const { key, rec } = await fixture();
  const w = world({ [key]: JSON.stringify(rec) });
  try {
    const id = publicId(key);
    assert.equal(w.run(['request-decline', id]).code, 0);
    const decision = JSON.parse(w.read()[decisionKey(key)]);
    assert.equal(decision.status, 'declined');
    assert.equal(decision.was_public, true);
    // A stale raise rewrites the record as accepted; the CLI still reads it as declined.
    w.write({ ...w.read(), [key]: JSON.stringify(rec) });
    const out = w.run(['requests']);
    assert.equal(out.code, 0);
    assert.match(out.stdout, new RegExp(`${id}\\s+declined`));
    const lines = out.stdout.split('\n');
    assert.match(lines.find((l) => l.includes('awaiting')), /\[pending\]/);
    assert.ok(!lines.find((l) => l.includes('private one')).includes('[pending]'), 'a private note needs no review');
    assert.match(lines.find((l) => l.includes('private one')), /\[private\]/);
  } finally {
    w.done();
  }
});
