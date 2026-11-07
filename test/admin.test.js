// The steward's admin API and the daily cron's purge (worker/admin.js)
// against the fake KV and the fake D1, so the refuse-before-write path runs
// for real: with endorsements on, a decision that can't freeze the live count
// is refused before KV is touched. Skips without node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, scheduledPurge } from '../worker/admin.js';
import { addRequest, decide, requestKey, publicId } from '../worker/requests.js';
import { signUser, userId, USER_COOKIE } from '../worker/accounts.js';
import { endorsementId } from '../worker/endorsements.js';
import { readyEnv, SECRET } from './fake-atproto.js';
import { D1_SKIP } from './fake-d1.js';

const dbTest = (name, fn) => test(name, { skip: D1_SKIP }, fn);
const ORIGIN = 'https://jason-edelman.org';
const STEWARD = 'steward@example.org';
const FAR = Math.floor(Date.now() / 1000) + 400 * 86400;

async function world(over = {}) {
  const env = readyEnv({ ADMIN_EMAILS: STEWARD, ...over });
  await addRequest({ body: { source: 'Source A' }, kv: env.LIMITS, visitor: 'v' });
  const id = publicId(await requestKey('Source A'));
  await decide(env.LIMITS, { id, status: 'accepted' });
  const cookie = `${USER_COOKIE}=${await signUser(SECRET, await userId(SECRET, STEWARD))}`;
  return { env, id, cookie };
}

const endorseRows = async (db, id, n) => {
  for (let i = 0; i < n; i++) {
    await db.prepare('INSERT INTO endorsements (eh, request_id, y, exp) VALUES (?1, ?2, ?3, ?4)').bind(await endorsementId(SECRET, id, `e${i}`), id, i === 0 ? 1 : 0, FAR).run();
  }
};

async function call(w, path, body) {
  const waits = [];
  const req = new Request(`${ORIGIN}/ask-siren${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: w.cookie, ...(body ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handleAdmin(req, w.env, path, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return { status: res.status, body: await res.json() };
}

const snapshot = (kv) => JSON.stringify([...kv.store.entries()]);
const record = async (w) => JSON.parse(w.env.LIMITS.store.get(await requestKey('Source A')).value);

dbTest('admin: a decision freezes the live count into the request, then clears the rows', async () => {
  const w = await world();
  await endorseRows(w.env.SIREN_DB, w.id, 3);
  const listed = await call(w, '/api/admin/requests');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.requests.find((r) => r.id === w.id).endorsements.n, 3);
  const out = await call(w, '/api/admin/requests/decide', { id: w.id, status: 'declined' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual((await record(w)).endorsements_at_decision, { n: 3, young: 1, unknown: 0 });
  assert.deepEqual(w.env.SIREN_DB.rows('endorsements'), [], 'rows cleared after the freeze');
  assert.deepEqual(w.env.SIREN_DB.rows('endorsement_counts'), []);
});

dbTest('admin: flag on and SIREN_DB missing, a decline is refused (503) and KV is untouched', async () => {
  const w = await world({ SIREN_DB: undefined });
  const before = snapshot(w.env.LIMITS);
  const out = await call(w, '/api/admin/requests/decide', { id: w.id, status: 'declined' });
  assert.equal(out.status, 503);
  assert.match(out.body.error, /SIREN_DB/);
  assert.equal(snapshot(w.env.LIMITS), before);
  // Accepting needs no count, so it still goes through.
  assert.equal((await call(w, '/api/admin/requests/decide', { id: w.id, status: 'accepted' })).status, 200);
});

dbTest('admin: a count that fails to read refuses a decline or fulfil (503), KV untouched', async () => {
  const w = await world();
  await endorseRows(w.env.SIREN_DB, w.id, 2);
  w.env.SIREN_DB.fail = true;
  const before = snapshot(w.env.LIMITS);
  for (const body of [{ id: w.id, status: 'declined' }, { id: w.id, status: 'fulfilled', fulfilled_by: 'https://github.com/o/r/pull/1' }]) {
    const out = await call(w, '/api/admin/requests/decide', body);
    assert.equal(out.status, 503, body.status);
    assert.match(out.body.error, /nothing was decided/);
  }
  assert.equal(snapshot(w.env.LIMITS), before);
  w.env.SIREN_DB.fail = false;
  assert.equal(w.env.SIREN_DB.rows('endorsements').length, 2, 'the endorsements are still there to freeze');
});

dbTest('admin: the flag off means no D1 call at all, and decisions work as before', async () => {
  const w = await world({ BLUESKY_LOGIN: undefined });
  await endorseRows(w.env.SIREN_DB, w.id, 2);
  const mark = w.env.SIREN_DB.ops.length;
  assert.equal((await call(w, '/api/admin/requests')).status, 200);
  assert.equal((await call(w, '/api/admin/requests/decide', { id: w.id, status: 'declined' })).status, 200);
  assert.equal((await call(w, '/api/admin/requests/endorsements/clear', { id: w.id })).status, 404);
  assert.equal(w.env.SIREN_DB.ops.length, mark, 'no D1 call');
  assert.equal((await record(w)).endorsements_at_decision, undefined);
  assert.equal(scheduledPurge(w.env, null), null, 'the cron does nothing either');
});

dbTest('admin: the clear route, the list-time sweep of decided requests, and the purge', async () => {
  const w = await world();
  await endorseRows(w.env.SIREN_DB, w.id, 2);
  const cleared = await call(w, '/api/admin/requests/endorsements/clear', { id: w.id });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, 2);
  assert.equal((await call(w, '/api/admin/requests/endorsements/clear', { id: 'abcdefabcdef' })).status, 404);
  // Rows left on a decided request (a stale location) are swept where the
  // admin list is computed, and expired rows are purged there too.
  await decide(w.env.LIMITS, { id: w.id, status: 'declined' });
  await endorseRows(w.env.SIREN_DB, w.id, 2);
  await w.env.SIREN_DB.prepare('INSERT INTO bsky_rate_counts (k, n, exp) VALUES (?1, 1, ?2)').bind('ed:old:x', 1).run();
  assert.equal((await call(w, '/api/admin/requests')).status, 200);
  assert.deepEqual(w.env.SIREN_DB.rows('endorsements'), []);
  assert.deepEqual(w.env.SIREN_DB.rows('bsky_rate_counts'), []);
});

dbTest('the daily cron purges expired rows of every kind, and only those', async () => {
  const w = await world();
  const db = w.env.SIREN_DB;
  await endorseRows(db, w.id, 1);
  await db.prepare('INSERT INTO endorsements (eh, request_id, y, exp) VALUES (?1, ?2, 0, 1)').bind('0'.repeat(32), w.id).run();
  await db.prepare('INSERT INTO bsky_rate_counts (k, n, exp) VALUES (?1, 1, 1)').bind('ev:old:x').run();
  await db.prepare('INSERT INTO bsky_flows_used (sh, exp) VALUES (?1, 1)').bind('f'.repeat(32)).run();
  const waits = [];
  assert.deepEqual(await scheduledPurge(w.env, { waitUntil: (p) => waits.push(p) }), { endorsements: 1, rates: 1, flows: 1 });
  assert.equal(waits.length, 1, 'handed to waitUntil');
  assert.equal(db.rows('endorsements').length, 1, 'the live endorsement stays');
  assert.deepEqual(db.rows('bsky_rate_counts'), []);
  assert.deepEqual(db.rows('bsky_flows_used'), []);
  // A failing D1 is logged, never thrown.
  db.fail = true;
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await scheduledPurge(w.env, null);
  } finally {
    console.error = orig;
  }
  assert.match(errors.join('\n'), /scheduled purge failed/);
});
