// The steward's command line for source requests (scripts/invites.js), run
// against a stand-in `npx wrangler` on PATH that keeps KV in a JSON file.
// Skips on Windows, where a shebang script can't stand in for npx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestKey, deletedKey, decisionKey, publicId, idKey, pidKey } from '../worker/requests.js';

const skip = process.platform === 'win32' && 'needs a POSIX shebang for the npx stand-in';
const CLI = fileURLToPath(new URL('../scripts/invites.js', import.meta.url));

// `npx wrangler kv key get|put|list|delete <...> --binding LIMITS ...`, as
// the CLI calls it. A missing key behaves as wrangler does: with --local,
// `get` prints "Value not found" and exits 0; against the deployed KV
// (--remote, the CLI's default), it prints "404: Not Found" to stderr and
// exits 1.
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_KV;
const kv = JSON.parse(fs.readFileSync(file, 'utf8'));
const [, , , , , op, ...rest] = process.argv;
const key = rest[0];
const local = rest.includes('--local');
const fail = process.env.FAKE_FAIL_KEY;
const failList = process.env.FAKE_FAIL_LIST;
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, [op, key].join(' ') + '\\n');
if (fail && op === 'get' && key === fail) { process.stderr.write('Authentication error [code: 10000]\\n'); process.exit(1); }
if (op === 'get') {
  if (key in kv) process.stdout.write(kv[key]);
  else if (local) process.stdout.write('Value not found');
  else { process.stderr.write('✘ [ERROR] 404: Not Found\\n'); process.exit(1); }
} else if (op === 'put') { kv[key] = rest[1]; fs.writeFileSync(file, JSON.stringify(kv)); }
else if (op === 'delete') { delete kv[key]; fs.writeFileSync(file, JSON.stringify(kv)); }
else if (op === 'list') {
  const p = rest[rest.indexOf('--prefix') + 1];
  if (failList && p === failList) { process.stderr.write('✘ [ERROR] A request to the Cloudflare API failed. [code: 10013]\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(Object.keys(kv).filter((k) => k.startsWith(p)).map((name) => ({ name }))));
}
else process.exit(2);
`;

function world(store) {
  const dir = mkdtempSync(join(tmpdir(), 'requests-cli-'));
  writeFileSync(join(dir, 'npx'), FAKE_NPX);
  chmodSync(join(dir, 'npx'), 0o755);
  const file = join(dir, 'kv.json');
  writeFileSync(file, JSON.stringify(store));
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_KV: file, ...extra } });
    return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
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

// --- Remote mode: wrangler's `get` of a missing key exits 1 there, so the CLI
// finds optional keys by listing them and gets only keys that exist.

for (const mode of ['remote', 'local']) {
  test(`every request command works with no side keys stored (${mode})`, { skip }, async () => {
    const { key, rec } = await fixture();
    const w = world({ [key]: JSON.stringify(rec) });
    const flags = mode === 'local' ? ['--local'] : [];
    try {
      const id = publicId(key);
      const steps = [
        ['requests'],
        ['request-note', id, 'n00000004', 'approve'],
        ['request-note', id, 'n00000002', 'delete'],
        ['request-decline', id, '--note', 'Not a source we can add.'],
        ['request-reopen', id],
        ['request-fulfilled', id, '--by', 'https://github.com/o/r/pull/1'],
        ['request-accept', id],
        ['requests', '--status', 'accepted'],
      ];
      for (const args of steps) {
        const out = w.run([...args, ...flags]);
        assert.equal(out.code, 0, `${args.join(' ')}: ${out.stderr}`);
        // Start the next step from a world with no side keys again, as a fresh deploy would be.
        if (args[0] === 'request-note' && args[3] === 'approve') continue;
        const kv = w.read();
        delete kv[decisionKey(key)];
        delete kv[deletedKey(key)];
        w.write(kv);
      }
      assert.match(w.run(['requests', ...flags]).stdout, new RegExp(`${id}\\s+accepted`));
      assert.equal(JSON.parse(w.read()[key]).needs.find((n) => n.id === 'n00000004').review, 'ok');
    } finally {
      w.done();
    }
  });

  test(`revoke and waitlist-remove say "no match" for a missing key, and stop on a failed listing (${mode})`, { skip }, async () => {
    const w = world({});
    const flags = mode === 'local' ? ['--local'] : [];
    try {
      const missing = w.run(['revoke', 'SIREN-ABCDE-FGHJK', ...flags]);
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /No invite matches/);
      const gone = w.run(['waitlist-remove', 'someone@example.org', ...flags]);
      assert.match(gone.stderr, /not on the waitlist/);
      const failed = w.run(['revoke', 'a'.repeat(64), ...flags], { FAKE_FAIL_LIST: `invite:${'a'.repeat(64)}` });
      assert.notEqual(failed.code, 0);
      assert.match(failed.stderr, /Cloudflare API failed/);
      assert.doesNotMatch(failed.stderr, /No invite matches/, 'a failed listing is not reported as a missing invite');
    } finally {
      w.done();
    }
  });
}

test('a failed side-key listing stops the command and writes nothing', { skip }, async () => {
  const { key, rec } = await fixture();
  const w = world({ [key]: JSON.stringify(rec), [deletedKey(key)]: JSON.stringify(['n00000001']) });
  try {
    const id = publicId(key);
    const before = JSON.stringify(w.read());
    for (const [args, prefix] of [
      [['request-note', id, 'n00000002', 'delete'], deletedKey(key)],
      [['request-decline', id], decisionKey(key)],
      [['requests'], 'request-deleted:'],
      [['requests'], 'request-decision:'],
    ]) {
      const out = w.run(args, { FAKE_FAIL_LIST: prefix });
      assert.notEqual(out.code, 0, `${args.join(' ')} with ${prefix} failing`);
      assert.match(out.stderr, /Cloudflare API failed/);
      assert.equal(JSON.stringify(w.read()), before, 'nothing written');
    }
  } finally {
    w.done();
  }
});

test('requests lists the side keys once, and gets only the ones that exist', { skip }, async () => {
  const store = {};
  const keys = [];
  for (const s of ['One source', 'Two source', 'Three source']) {
    const k = await requestKey(s);
    keys.push(k);
    store[k] = JSON.stringify({ source: s, count: 1, first: '2026-11-01', last: '2026-11-01', status: 'new', needs: [] });
  }
  store[decisionKey(keys[0])] = JSON.stringify({ status: 'declined', decided: '2026-11-02', was_public: true });
  const w = world(store);
  const log = join(tmpdir(), `requests-cli-log-${process.pid}-${Date.now()}`);
  try {
    const out = w.run(['requests'], { FAKE_LOG: log });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`${publicId(keys[0])}\\s+declined`));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((c) => c.startsWith('list')).length, 4, 'request:, request-deleted:, request-decision: and request-id:');
    const gets = calls.filter((c) => c.startsWith('get')).map((c) => c.split(' ')[1]);
    assert.deepEqual(gets.sort(), [...keys, decisionKey(keys[0])].sort());
  } finally {
    rmSync(log, { force: true });
    w.done();
  }
});

test('request-ids: a dry run by default; --apply gives each legacy request a random id, keeping the old one only where it was public', { skip }, async () => {
  const store = {};
  const pub = await requestKey('Public source');
  const priv = await requestKey('Private source');
  store[pub] = JSON.stringify({ source: 'Public source', count: 1, status: 'accepted', needs: [] });
  store[priv] = JSON.stringify({ source: 'Private source', count: 1, status: 'new', needs: [] });
  const w = world(store);
  try {
    const dry = w.run(['request-ids']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stderr, /Dry run: 2 requests would get a random id/);
    assert.deepEqual(Object.keys(w.read()).sort(), [priv, pub].sort(), 'a dry run writes nothing');
    const out = w.run(['request-ids', '--apply']);
    assert.equal(out.code, 0, out.stderr);
    const kv = w.read();
    const pubIds = JSON.parse(kv[idKey(pub)]);
    const privIds = JSON.parse(kv[idKey(priv)]);
    assert.match(pubIds.id, /^[a-z2-7]{16}$/);
    assert.equal(pubIds.formerly, publicId(pub), 'the public one keeps its issue marker id');
    assert.equal(privIds.formerly, undefined, 'a never-public legacy id is dropped, never published');
    assert.equal(kv[pidKey(pubIds.id)], pub.slice('request:'.length));
    // Again: nothing to do, and nothing rewritten.
    assert.match(w.run(['request-ids', '--apply']).stderr, /already has a random id/);
    assert.deepEqual(JSON.parse(w.read()[idKey(pub)]), pubIds);
    // The steward tools take the new id, and refuse the old one now.
    const listed = w.run(['requests']);
    assert.match(listed.stdout, new RegExp(`^${pubIds.id}\\s+accepted`, 'm'));
    assert.ok(!listed.stdout.includes(publicId(pub)), 'one id per request');
    assert.equal(w.run(['request-decline', pubIds.id]).code, 0);
    const old = w.run(['request-accept', publicId(pub)]);
    assert.notEqual(old.code, 0);
    assert.match(old.stderr, /now has the id/);
  } finally {
    w.done();
  }
});
