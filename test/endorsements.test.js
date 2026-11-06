// Endorsements: what gets written, what gets counted, and what can't be
// probed. The SQL really runs, on node:sqlite through test/fake-d1.js, over
// the real migrations; these tests skip where node:sqlite is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endorse, unendorse, endorsedBy, forgetEndorser, endorsementCounts, countFor, clearRequestEndorsements,
  publicNumber, publicPolicy, youngFlag, endorsementId, issuerBucket, orphanedIds, purgeExpired, purgeAll, sweepOrphans, PURGE_LIMIT, endorseDb, dbSetupError, StorageError, SQL,
} from '../worker/endorsements.js';
import { addRequest, decide, requestKey, publicId, publicRequests, freezeAtDecision } from '../worker/requests.js';
import { cachedPublicList, purgePublicList, computePublicList } from '../worker/public-list.js';
import { hmacHex, boundary } from '../worker/crypto.js';
import { fakeKV, fakeLimiter, fakeCache, SECRET } from './fake-atproto.js';
import { fakeD1, D1_SKIP, migrations } from './fake-d1.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const T = Math.floor(NOW / 1000);
const dbTest = (name, fn) => test(name, { skip: D1_SKIP }, fn);
const env0 = (db, over = {}) => ({ BLUESKY_LOGIN: 'true', SIREN_DB: db, INVITE_SECRET: SECRET, BSKY_SITE_RL: fakeLimiter(), BSKY_VISITOR_RL: fakeLimiter(), BSKY_INPUT_RL: fakeLimiter(), ...over });
const session = async (n = 1, over = {}) => ({ eid: await hmacHex(SECRET, `endorser:did:plc:account${n}`), handle: '', created: '2025-01-02', issuer: 'https://bsky.social', ...over });

async function world(over = {}) {
  const kv = fakeKV();
  const db = fakeD1();
  const ids = {};
  for (const [name, status] of [['open1', 'accepted'], ['open2', 'accepted'], ['fresh', 'new'], ['nope', 'declined'], ['done', 'fulfilled']]) {
    await addRequest({ body: { source: `Source ${name}` }, kv, visitor: name, now: NOW });
    const id = publicId(await requestKey(`Source ${name}`));
    ids[name] = id;
    if (status !== 'new') await decide(kv, { id, status, fulfilled_by: status === 'fulfilled' ? 'https://github.com/o/r/pull/1' : undefined }, NOW);
  }
  return { kv, db, ids, env: env0(db, over) };
}

const go = async ({ kv, db, env }, id, s, visitor = 'v1', now = NOW) => endorse({ kv, db, env, id, session: s, visitor, publicList: await computePublicList(env, kv, { now }), now });
const rateRows = (db) => db.rows('bsky_rate_counts');
const endRow = async (db, id, s) => {
  const eh = await endorsementId(SECRET, id, s.eid);
  return db.rows('endorsements').find((r) => r.eh === eh) || null;
};
const putRow = (db, id, eh, y = 0, exp = T + 86400 * 400) => db.prepare('INSERT INTO endorsements (eh, request_id, y, exp) VALUES (?1, ?2, ?3, ?4)').bind(eh, id, y, exp).run();

test('endorseDb: only with the flag on and a binding; otherwise a clear setup error', () => {
  const db = { prepare() {}, batch() {} };
  assert.equal(endorseDb({ SIREN_DB: db }), null, 'flag unset: no database, whatever is bound');
  assert.equal(endorseDb({ BLUESKY_LOGIN: 'false', SIREN_DB: db }), null);
  assert.equal(endorseDb({ BLUESKY_LOGIN: 'true', SIREN_DB: db }), db);
  assert.equal(dbSetupError({ SIREN_DB: db }), null);
  assert.equal(dbSetupError({ BLUESKY_LOGIN: 'true', SIREN_DB: db }), null);
  assert.match(dbSetupError({ BLUESKY_LOGIN: 'true' }), /SIREN_DB D1 binding is missing.*d1_databases/);
  assert.match(dbSetupError({ BLUESKY_LOGIN: 'true', SIREN_DB: {} }), /SIREN_DB/);
});

dbTest('one account counts once per request; a repeat is free', async () => {
  const w = await world();
  const s = await session();
  const first = await go(w, w.ids.open1, s);
  assert.deepEqual(first, { ok: true, endorsed: true, counted: true });
  const before = JSON.stringify(rateRows(w.db));
  const again = await go(w, w.ids.open1, s);
  assert.equal(again.already, true);
  assert.equal(JSON.stringify(rateRows(w.db)), before, 'no counter charged for a repeat');
  assert.deepEqual(await countFor(w.db, w.ids.open1, { now: NOW }), { n: 1, young: 0, unknown: 0 });
  assert.equal(w.db.rows('endorsements').length, 1);
});

dbTest('a repeat after the account ages rewrites young to established, keeping the expiry', async () => {
  const w = await world();
  const s = await session(1, { created: '2026-11-01' });
  assert.equal((await go(w, w.ids.open1, s)).counted, false);
  const r0 = await endRow(w.db, w.ids.open1, s);
  assert.equal(r0.y, 1);
  const later = NOW + 40 * 86400e3;
  assert.equal((await go(w, w.ids.open1, s, 'v1', later)).counted, true);
  const r1 = await endRow(w.db, w.ids.open1, s);
  assert.equal(r1.y, 0);
  assert.equal(r1.exp, r0.exp);
  assert.deepEqual(w.db.rows('endorsement_counts'), [{ request_id: w.ids.open1, n: 1, young: 0, unknown: 0 }], 'the trigger moved it out of young');
});

dbTest('probing: new, declined, fulfilled and unknown ids get the same 404 and no storage work', async () => {
  const w = await world();
  const s = await session();
  const list = await computePublicList(w.env, w.kv);
  const kvOps = w.kv.ops.length;
  const dbOps = w.db.ops.length;
  const outs = [];
  for (const id of [w.ids.fresh, w.ids.nope, w.ids.done, 'abcdefabcdef']) outs.push(JSON.stringify(await endorse({ kv: w.kv, db: w.db, env: w.env, id, session: s, visitor: 'v', publicList: list, now: NOW })));
  assert.equal(new Set(outs).size, 1);
  assert.match(outs[0], /No open request has that id/);
  assert.equal(w.kv.ops.length, kvOps, 'no KV operation beyond the public list');
  assert.equal(w.db.ops.length, dbOps, 'and no D1 call');
});

dbTest('unendorse: the same 200 for every id, no request lookup, and idempotent', async () => {
  const w = await world();
  const s = await session();
  await go(w, w.ids.open1, s);
  const kvOps = w.kv.ops.length;
  const outs = [];
  for (const id of [w.ids.fresh, w.ids.nope, w.ids.done, w.ids.open1, 'abcdefabcdef', w.ids.open1]) outs.push(JSON.stringify(await unendorse({ db: w.db, env: w.env, id, session: s, visitor: 'v', now: NOW })));
  assert.equal(new Set(outs).size, 1);
  assert.equal(outs[0], JSON.stringify({ ok: true, endorsed: false }));
  assert.equal(w.kv.ops.length, kvOps, 'unendorse never touches KV, so never a request');
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 0);
  assert.deepEqual(w.db.rows('endorsement_counts'), [], 'an emptied tally row is removed');
  assert.equal((await unendorse({ db: w.db, env: w.env, id: 'zz', session: s, visitor: 'v' })).status, 400);
});

dbTest('daily limits per account, per visitor and per non-open issuer', async () => {
  let w = await world({ ENDORSE_PER_DID_DAILY: '1' });
  const s1 = await session(1);
  assert.ok((await go(w, w.ids.open1, s1)).ok);
  assert.equal((await go(w, w.ids.open2, s1)).status, 429);
  w = await world({ ENDORSE_PER_VISITOR_DAILY: '1' });
  assert.ok((await go(w, w.ids.open1, await session(1), 'same')).ok);
  assert.equal((await go(w, w.ids.open1, await session(2), 'same')).status, 429);
  w = await world({ ENDORSE_PER_ISSUER_DAILY: '1' });
  const self = { issuer: 'https://pds.selfhosted.dev' };
  assert.ok((await go(w, w.ids.open1, await session(1, self), 'a')).ok);
  assert.equal((await go(w, w.ids.open1, await session(2, self), 'b')).status, 429);
  for (let n = 3; n < 6; n++) assert.ok((await go(w, w.ids.open1, await session(n), `v${n}`)).ok, 'bsky.social is an open issuer');
  w = await world({ BSKY_SITE_RL: fakeLimiter(0) });
  assert.equal((await go(w, w.ids.open1, s1)).status, 429, 'the site breaker');
  // The next day starts fresh.
  w = await world({ ENDORSE_PER_DID_DAILY: '1' });
  assert.ok((await go(w, w.ids.open1, s1)).ok);
  assert.ok((await go(w, w.ids.open2, s1, 'v1', NOW + 86400e3)).ok);
});

dbTest('same tick: one account on two requests, two accounts on one request', async () => {
  const w = await world();
  const list = await computePublicList(w.env, w.kv);
  const s1 = await session(1);
  const s2 = await session(2);
  const outs = await Promise.all([
    endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open1, session: s1, visitor: 'v', publicList: list, now: NOW }),
    endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open2, session: s1, visitor: 'v', publicList: list, now: NOW }),
    endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open1, session: s2, visitor: 'w', publicList: list, now: NOW }),
    endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open1, session: s2, visitor: 'w', publicList: list, now: NOW }),
  ]);
  assert.ok(outs.every((o) => o.ok));
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 2, 'a same-tick repeat is still one row');
  assert.equal((await countFor(w.db, w.ids.open2, { now: NOW })).n, 1);
});

dbTest("forget removes all of one account's endorsements and nothing else", async () => {
  const w = await world();
  const s1 = await session(1);
  const s2 = await session(2);
  await go(w, w.ids.open1, s1);
  await go(w, w.ids.open2, s1);
  await go(w, w.ids.open1, s2);
  const kvOps = w.kv.ops.length;
  assert.deepEqual(await forgetEndorser({ db: w.db, env: w.env, session: s1 }), { removed: 2 });
  assert.equal(w.kv.ops.length, kvOps, 'forget lists no KV keys');
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 1);
  assert.equal((await countFor(w.db, w.ids.open2, { now: NOW })).n, 0);
  assert.deepEqual(await endorsedBy({ db: w.db, env: w.env, session: s2, publicList: await computePublicList(w.env, w.kv), now: NOW }), [w.ids.open1]);
  assert.deepEqual(await forgetEndorser({ db: w.db, env: w.env, session: s1 }), { removed: 0 });
});

dbTest('clearing one request removes only its rows and reports what remains', async () => {
  const w = await world();
  for (let n = 1; n <= 5; n++) await go(w, w.ids.open1, await session(n), `v${n}`);
  await go(w, w.ids.open2, await session(1));
  assert.deepEqual(await clearRequestEndorsements(w.db, w.ids.open1, { max: 3 }), { cleared: 3, remaining: 2 });
  assert.deepEqual(await clearRequestEndorsements(w.db, w.ids.open1), { cleared: 2, remaining: 0 });
  assert.equal((await countFor(w.db, w.ids.open2, { now: NOW })).n, 1);
  assert.deepEqual(await clearRequestEndorsements(w.db, 'not-an-id'), { cleared: 0, remaining: 0 });
});

dbTest('counts group by id, split young and unknown; endorsedBy reports public ids only', async () => {
  const w = await world();
  await go(w, w.ids.open1, await session(1));
  await go(w, w.ids.open1, await session(2, { created: '2026-11-05' }), 'w');
  await go(w, w.ids.open1, await session(3, { created: '' }), 'x');
  await go(w, w.ids.open2, await session(1));
  const counts = await endorsementCounts(w.db, { now: NOW });
  assert.deepEqual(counts.get(w.ids.open1), { n: 3, young: 1, unknown: 1 });
  assert.deepEqual(counts.get(w.ids.open2), { n: 1, young: 0, unknown: 0 });
  const s1 = await session(1);
  await putRow(w.db, w.ids.fresh, await endorsementId(SECRET, w.ids.fresh, s1.eid));
  assert.deepEqual((await endorsedBy({ db: w.db, env: w.env, session: s1, publicList: await computePublicList(w.env, w.kv, { sweep: false }), now: NOW })).sort(), [w.ids.open1, w.ids.open2].sort());
});

dbTest('a minimum account age refuses young and unknown accounts; off, they endorse with y recorded', async () => {
  let w = await world({ ENDORSE_MIN_ACCOUNT_DAYS: '10' });
  assert.equal((await go(w, w.ids.open1, await session(1, { created: '2026-11-01' }))).status, 403);
  assert.equal((await go(w, w.ids.open1, await session(2, { created: '' }))).status, 403);
  assert.ok((await go(w, w.ids.open1, await session(3))).ok);
  w = await world();
  const young = await session(4, { created: '2026-11-01' });
  assert.ok((await go(w, w.ids.open1, young)).ok);
  assert.equal((await endRow(w.db, w.ids.open1, young)).y, 1);
  const web = await session(5, { created: '' });
  await go(w, w.ids.open1, web);
  assert.equal((await endRow(w.db, w.ids.open1, web)).y, null);
});

test('publicNumber and the policy', () => {
  const c = { n: 6, young: 1, unknown: 2 };
  assert.equal(publicNumber(c, 'established'), 3);
  assert.equal(publicNumber(c, 'all'), 6);
  assert.equal(publicPolicy({}), 'established');
  assert.equal(publicPolicy({ ENDORSE_PUBLIC: 'all' }), 'all');
  assert.equal(publicPolicy({ ENDORSE_PUBLIC: 'everything' }), 'established');
  assert.equal(youngFlag('', {}, NOW), null);
  assert.equal(youngFlag('2026-11-01', {}, NOW), 1);
  assert.equal(youngFlag('2026-01-01', {}, NOW), 0);
});

dbTest('the public view carries a number only, sorted by asks with endorsements breaking ties', async () => {
  const w = await world();
  await go(w, w.ids.open2, await session(1));
  const list = await computePublicList(w.env, w.kv);
  const text = JSON.stringify(list);
  assert.ok(!/"y"|young|unknown|unavailable/.test(text));
  assert.deepEqual(list.requests.map((r) => r.id), [w.ids.open2, w.ids.open1, w.ids.done], 'equal asks: the endorsed one first');
  assert.equal(list.requests[0].endorsements, 1);
  await addRequest({ body: { source: 'Source open1' }, kv: w.kv, visitor: 'again', now: NOW });
  assert.equal((await computePublicList(w.env, w.kv)).requests[0].id, w.ids.open1, 'asks come first');
  const plain = await publicRequests(w.kv);
  assert.ok(plain.requests.every((r) => !('endorsements' in r)), 'with the feature off, no endorsements field');
});

dbTest('freeze: a decision writes the count once, then the rows go; reopening starts fresh', async () => {
  const w = await world();
  for (let n = 1; n <= 3; n++) await go(w, w.ids.open1, await session(n), `v${n}`);
  await go(w, w.ids.open1, await session(9, { created: '2026-11-05' }), 'v9');
  const key = await requestKey('Source open1');
  const live = await countFor(w.db, w.ids.open1, { now: NOW });
  const opsBefore = w.kv.ops.length;
  const out = await decide(w.kv, { id: w.ids.open1, status: 'fulfilled', fulfilled_by: 'https://github.com/o/r/pull/2' }, NOW, { live });
  assert.ok(out.ok);
  assert.equal(w.kv.ops.slice(opsBefore).filter((o) => o.op === 'put' && o.key === key).length, 1, 'written once');
  assert.deepEqual((await w.kv.get(key, 'json')).endorsements_at_decision, { n: 4, young: 1, unknown: 0 });
  await clearRequestEndorsements(w.db, w.ids.open1);
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 0);
  assert.equal(w.db.rows('endorsements').length, 0, 'the rows are deleted; the number is kept in the request');
  let r = (await computePublicList(w.env, w.kv)).requests.find((x) => x.id === w.ids.open1);
  assert.equal(r.endorsements, 3, 'fulfilled shows the frozen public number');
  await decide(w.kv, { id: w.ids.open1, status: 'accepted' }, NOW, { live: await countFor(w.db, w.ids.open1, { now: NOW }) });
  r = (await computePublicList(w.env, w.kv)).requests.find((x) => x.id === w.ids.open1);
  assert.equal(r.endorsements, 0, 'reopened: live endorsements only');
  assert.deepEqual((await w.kv.get(key, 'json')).endorsements_at_decision, { n: 4, young: 1, unknown: 0 }, 'the steward still sees it');
  assert.deepEqual(freezeAtDecision({ status: 'fulfilled', endorsements_at_decision: { n: 2, young: 0, unknown: 0 } }, 'declined', { n: 0, young: 0, unknown: 0 }), { n: 2, young: 0, unknown: 0 });
  assert.equal(freezeAtDecision({ status: 'accepted' }, 'fulfilled', undefined), undefined);
  assert.equal(freezeAtDecision({ status: 'new' }, 'accepted', { n: 3, young: 0, unknown: 0 }), undefined);
});

dbTest('the public list is served from the cache until purged', async () => {
  const w = await world();
  const cache = fakeCache();
  const args = { env: w.env, kv: w.kv, origin: 'https://jason-edelman.org', base: '/ask-siren', cache };
  const first = await cachedPublicList(args);
  await go(w, w.ids.open1, await session(1));
  assert.deepEqual(await cachedPublicList(args), first, 'a cached list, though counts changed');
  const reads = w.db.ops.length;
  await cachedPublicList(args);
  assert.equal(w.db.ops.length, reads, 'a cached call reads nothing');
  await purgePublicList(args);
  const third = await cachedPublicList(args);
  assert.equal(third.requests.find((r) => r.id === w.ids.open1).endorsements, 1);
});

dbTest('if D1 fails, the list is still served, without counts, cached only briefly under its own key', async () => {
  const w = await world();
  await go(w, w.ids.open1, await session(1));
  w.db.fail = true;
  const cache = fakeCache();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let list;
  try {
    list = await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache });
  } finally {
    console.error = orig;
  }
  assert.equal(list.endorsements_unavailable, true);
  assert.equal(list.requests.length, 3);
  assert.ok(list.requests.every((r) => !('endorsements' in r)), 'no wrong zeros');
  assert.deepEqual([...cache.store.keys()], ['https://x.dev/__cache/public-requests-uncounted-v1'], 'never under the counted key');
  assert.equal(cache.store.get('https://x.dev/__cache/public-requests-uncounted-v1').headers.get('Cache-Control'), 'public, max-age=30');
  assert.ok(errors.some((e) => /endorsement counts failed/.test(e)));
  // Within the 30 s, views are served from it: no KV list, no D1 call.
  const kvList = w.kv.list;
  let lists = 0;
  w.kv.list = (...a) => { lists++; return kvList.apply(w.kv, a); };
  const ops = w.db.ops.length;
  assert.deepEqual(await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache }), list);
  assert.equal(lists, 0);
  assert.equal(w.db.ops.length, ops);
  // A steward decision drops it, and D1 back means counts again.
  assert.equal(await purgePublicList({ origin: 'https://x.dev', cache }), true);
  w.db.fail = false;
  const back = await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache });
  assert.equal(back.requests.find((r) => r.id === w.ids.open1).endorsements, 1);
});

dbTest('a repeat after an unknown age becomes known rewrites null to the known flag, and counted follows the stored flag', async () => {
  const w = await world();
  const failedLookup = await session(1, { created: '' });
  assert.equal((await go(w, w.ids.open1, failedLookup)).counted, false);
  const r0 = await endRow(w.db, w.ids.open1, failedLookup);
  assert.equal(r0.y, null);
  const again = await go(w, w.ids.open1, await session(1, { created: '2020-01-01' }));
  assert.deepEqual(again, { ok: true, endorsed: true, already: true, counted: true });
  const r1 = await endRow(w.db, w.ids.open1, failedLookup);
  assert.equal(r1.y, 0);
  assert.equal(r1.exp, r0.exp);
  assert.equal(publicNumber(await countFor(w.db, w.ids.open1, { now: NOW }), 'established'), 1);
  // Never downgraded: an established flag stays, and an unknown session doesn't erase it.
  await go(w, w.ids.open1, await session(1, { created: '' }));
  assert.equal((await endRow(w.db, w.ids.open1, failedLookup)).y, 0);
  await go(w, w.ids.open1, await session(1, { created: '2026-11-05' }));
  assert.equal((await endRow(w.db, w.ids.open1, failedLookup)).y, 0, 'never back to young');
  // A young account whose stored flag is still young reports counted: false.
  const y = await session(2, { created: '2026-11-01' });
  await go(w, w.ids.open1, y, 'v2');
  assert.equal((await go(w, w.ids.open1, y, 'v2')).counted, false);
});

dbTest('aging takes effect on `me` (endorsedBy): young and unknown flags become established without a click', async () => {
  const w = await world();
  const youngThen = await session(1, { created: '2026-11-01' });
  assert.equal((await go(w, w.ids.open1, youngThen)).counted, false);
  await go(w, w.ids.open2, await session(1, { created: '' }));
  const exp = (await endRow(w.db, w.ids.open1, youngThen)).exp;
  assert.equal(publicNumber(await countFor(w.db, w.ids.open1, { now: NOW }), 'established'), 0);
  const list = await computePublicList(w.env, w.kv, { sweep: false });
  await endorsedBy({ db: w.db, env: w.env, session: youngThen, publicList: list, now: NOW + 86400e3 });
  assert.equal((await endRow(w.db, w.ids.open1, youngThen)).y, 1, 'still young: nothing changes');
  const later = NOW + 40 * 86400e3;
  const ids2 = await endorsedBy({ db: w.db, env: w.env, session: youngThen, publicList: list, now: later });
  assert.deepEqual(ids2.sort(), [w.ids.open1, w.ids.open2].sort());
  assert.equal((await endRow(w.db, w.ids.open1, youngThen)).y, 0);
  assert.equal((await endRow(w.db, w.ids.open1, youngThen)).exp, exp, 'the month it was made in is kept');
  assert.equal(publicNumber(await countFor(w.db, w.ids.open1, { now: NOW }), 'established'), 1);
  assert.equal(publicNumber(await countFor(w.db, w.ids.open2, { now: NOW }), 'established'), 1);
  assert.equal((await computePublicList(w.env, w.kv)).requests.find((r) => r.id === w.ids.open1).endorsements, 1);
  // One batch per `me`, whatever it found.
  const calls = w.db.ops.length;
  await endorsedBy({ db: w.db, env: w.env, session: youngThen, publicList: list, now: later });
  assert.equal(w.db.ops.length, calls + 1);
});

dbTest('endorsedBy and forget split long id lists under D1\'s 100-parameter limit', async () => {
  const w = await world();
  const s = await session(1);
  const many = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(12, '0'));
  for (const id of many.filter((_, i) => i % 3 === 0)) await putRow(w.db, id, await endorsementId(SECRET, id, s.eid));
  const list = { requests: many.map((id) => ({ id, status: 'accepted', source: id })) };
  const got = await endorsedBy({ db: w.db, env: w.env, session: s, publicList: list, now: NOW });
  assert.equal(got.length, 84);
  assert.deepEqual(await forgetEndorser({ db: w.db, env: w.env, session: s }), { removed: 84 });
  assert.equal(w.db.rows('endorsements').length, 0);
});

dbTest('burst limits: the visitor and per-server bindings refuse before any D1 count', async () => {
  let w = await world({ BSKY_VISITOR_RL: fakeLimiter(0) });
  const s = await session(1);
  assert.equal((await go(w, w.ids.open1, s)).status, 429);
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 0, 'nothing written');
  assert.deepEqual(w.env.BSKY_VISITOR_RL.calls, ['end:v1']);
  assert.deepEqual(rateRows(w.db), [], 'no counter charged');
  assert.equal((await unendorse({ db: w.db, env: w.env, id: w.ids.open1, session: s, visitor: 'v', now: NOW })).status, 429);
  w = await world({ BSKY_VISITOR_RL: fakeLimiter(5, { throws: true }) });
  assert.equal((await go(w, w.ids.open1, s)).status, 429, 'fails closed');
  w = await world({ BSKY_INPUT_RL: fakeLimiter(0) });
  assert.equal((await go(w, w.ids.open1, await session(2, { issuer: 'https://pds.selfhosted.dev' }))).status, 429);
  assert.ok((await go(w, w.ids.open1, await session(3))).ok, 'bsky.social is open');
  assert.equal(w.env.BSKY_INPUT_RL.calls.length, 1);
  assert.match(w.env.BSKY_INPUT_RL.calls[0], /^iss:[0-9a-f]{32}$/);
});

dbTest('the per-server caps: one per server, one per registrable domain, no length heuristic', async () => {
  assert.equal(issuerBucket('https://a1.evil.dev'), 'evil.dev');
  assert.equal(issuerBucket('https://a1.abc.dev'), 'abc.dev');
  assert.equal(issuerBucket('https://a2.abc.dev'), 'abc.dev');
  assert.equal(issuerBucket('https://x.y.q7z.xyz'), 'q7z.xyz');
  assert.equal(issuerBucket('https://a1.abc.io'), issuerBucket('https://a2.abc.io'));
  assert.equal(issuerBucket('https://pds1.ab.dev'), issuerBucket('https://pds2.ab.dev'));
  assert.equal(issuerBucket('https://pds.example.co.uk'), 'example.co.uk');
  assert.equal(issuerBucket('https://a.b.example.com.au'), 'example.com.au');
  assert.equal(issuerBucket('https://pds1.github.io'), 'pds1.github.io');
  assert.notEqual(issuerBucket('https://pds1.github.io'), issuerBucket('https://pds2.github.io'));
  assert.equal(issuerBucket('https://svc-abc.a.run.app'), 'svc-abc.a.run.app');
  assert.equal(issuerBucket('https://bsky.social'), 'bsky.social');
  let w = await world({ ENDORSE_PER_ISSUER_DAILY: '1' });
  assert.ok((await go(w, w.ids.open1, await session(1, { issuer: 'https://a1.abc.dev' }), 'a')).ok);
  assert.equal((await go(w, w.ids.open2, await session(2, { issuer: 'https://a1.abc.dev' }), 'b')).status, 429);
  assert.ok((await go(w, w.ids.open1, await session(3, { issuer: 'https://a2.abc.dev' }), 'c')).ok, 'another server under the same domain');
  w = await world({ ENDORSE_PER_DOMAIN_DAILY: '2' });
  assert.ok((await go(w, w.ids.open1, await session(1, { issuer: 'https://a1.abc.dev' }), 'a')).ok);
  assert.ok((await go(w, w.ids.open1, await session(2, { issuer: 'https://a2.abc.dev' }), 'b')).ok);
  assert.equal((await go(w, w.ids.open1, await session(3, { issuer: 'https://a3.abc.dev' }), 'c')).status, 429);
  assert.ok((await go(w, w.ids.open1, await session(4, { issuer: 'https://pds1.github.io' }), 'd')).ok, 'another domain');
  assert.ok((await go(w, w.ids.open1, await session(5, { issuer: 'https://pds2.github.io' }), 'e')).ok, 'shared-hosting tenants are separate');
  // Counter rows name no request, and a withdraw and re-endorse charges again.
  w = await world({ ENDORSE_PER_ISSUER_DAILY: '2' });
  const s = await session(1, { issuer: 'https://pds.community.dev' });
  assert.ok((await go(w, w.ids.open1, s, 'a')).ok);
  assert.ok((await unendorse({ db: w.db, env: w.env, id: w.ids.open1, session: s, visitor: 'a', now: NOW })).ok);
  const issuerRows = rateRows(w.db).filter((r) => /^e[ir]:/.test(r.k));
  assert.deepEqual(issuerRows.map((r) => r.n), [1, 1], 'one per-server and one per-domain row, each charged once');
  for (const r of rateRows(w.db)) {
    assert.match(r.k, /^(ed|ev|ei|er):2026-11-06:[0-9a-z]+$/);
    for (const id of Object.values(w.ids)) assert.ok(!r.k.includes(id), 'no request id in a counter');
  }
  assert.ok((await go(w, w.ids.open1, s, 'a')).ok);
  assert.equal((await go(w, w.ids.open2, await session(2, { issuer: 'https://pds.community.dev' }), 'b')).status, 429, "the re-endorse used the server's day");
});

dbTest('an age-flag rewrite racing a withdrawal leaves the endorsement withdrawn', async () => {
  // The rewrite is one conditional UPDATE: a row deleted first stays deleted.
  const w = await world();
  const young = await session(1, { created: '2026-10-30' });
  assert.ok((await go(w, w.ids.open1, young)).ok);
  const aged = { ...young, created: '2026-01-01' };
  const list = await computePublicList(w.env, w.kv, { sweep: false });
  const eh = await endorsementId(SECRET, w.ids.open1, aged.eid);
  // Withdraw between endorse's read and its UPDATE.
  const real = w.db.prepare.bind(w.db);
  let withdrew = null;
  w.db.prepare = (sql) => {
    if (withdrew === null && sql === SQL.upgrade) {
      withdrew = 'pending';
      w.db.sqlite.prepare('DELETE FROM endorsements WHERE eh = ?').run(eh);
    }
    return real(sql);
  };
  const out = await endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open1, session: aged, visitor: 'v1', publicList: list, now: NOW });
  assert.equal(withdrew, 'pending');
  assert.equal(out.endorsed, false);
  assert.equal(w.db.rows('endorsements').length, 0);
  w.db.prepare = real;
  assert.deepEqual(await endorsedBy({ db: w.db, env: w.env, session: aged, publicList: list, now: NOW }), []);
});

dbTest('the orphan sweep stops at its budget, and endorse and me never sweep', async () => {
  const w = await world();
  for (let n = 0; n < 150; n++) await putRow(w.db, w.ids.done, await endorsementId(SECRET, w.ids.done, `e${n}`));
  await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache: null, sweep: false });
  assert.equal((await countFor(w.db, w.ids.done, { now: NOW })).n, 150);
  await computePublicList(w.env, w.kv, { now: NOW });
  assert.equal((await countFor(w.db, w.ids.done, { now: NOW })).n, 50, 'one sweep deletes at most 100');
  await computePublicList(w.env, w.kv, { now: NOW });
  assert.equal((await countFor(w.db, w.ids.done, { now: NOW })).n, 0, 'the next sweep finishes it');
});

dbTest('the orphan sweep is one D1 query however many requests are orphaned (Free: 50 per invocation)', async () => {
  const w = await world();
  const ids = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(12, '0'));
  for (const id of ids) await putRow(w.db, id, await endorsementId(SECRET, id, 'e1'));
  const counts = await endorsementCounts(w.db, { now: NOW });
  assert.equal(counts.size, 120);
  const mark = w.db.ops.length;
  const swept = await sweepOrphans(w.db, counts, new Map());
  assert.equal(swept.length, 120, 'every orphan is reported');
  assert.equal(w.db.ops.length - mark, 1, 'one statement');
  assert.ok(w.db.ops.at(-1).params.length <= 100, "within D1's 100 bound parameters");
  assert.equal(w.db.rows('endorsements').length, 21, 'the first 99 ids this sweep (budget 100 rows), the rest next time');
  await sweepOrphans(w.db, await endorsementCounts(w.db, { now: NOW }), new Map());
  assert.equal(w.db.rows('endorsements').length, 0);
});

dbTest('purges are bounded per statement, and the cron purge finishes a backlog', async () => {
  const w = await world();
  for (let n = 0; n < 7; n++) await putRow(w.db, w.ids.open1, await endorsementId(SECRET, w.ids.open1, `x${n}`), 0, T - 10);
  await putRow(w.db, w.ids.open1, await endorsementId(SECRET, w.ids.open1, 'live'), 0, T + 86400);
  assert.equal(PURGE_LIMIT, 500);
  assert.deepEqual(await purgeExpired(w.db, NOW, { limit: 3 }), { endorsements: 3, rates: 0, flows: 0 });
  assert.equal(w.db.rows('endorsements').length, 5);
  const mark = w.db.ops.length;
  assert.deepEqual(await purgeAll(w.db, NOW, { limit: 3 }), { endorsements: 4, rates: 0, flows: 0 });
  assert.equal(w.db.ops.length - mark, 2, 'one batch per round, stopping once a round comes up short');
  assert.equal(w.db.rows('endorsements').length, 1, 'the live one stays');
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 1, 'the tally followed');
});

dbTest('orphans: rows that outlive a decision are swept where the list is computed', async () => {
  const w = await world();
  await go(w, w.ids.open1, await session(1));
  const s2 = await session(2);
  for (const id of [w.ids.done, w.ids.nope, 'abcdefabcdef']) await putRow(w.db, id, await endorsementId(SECRET, id, s2.eid));
  await putRow(w.db, w.ids.fresh, await endorsementId(SECRET, w.ids.fresh, s2.eid));
  const counts = await endorsementCounts(w.db, { now: NOW });
  const statuses = new Map([[w.ids.open1, 'accepted'], [w.ids.fresh, 'new'], [w.ids.done, 'fulfilled'], [w.ids.nope, 'declined']]);
  assert.deepEqual(orphanedIds(counts, statuses).sort(), [w.ids.done, w.ids.nope, 'abcdefabcdef'].sort());
  await computePublicList(w.env, w.kv, { now: NOW });
  for (const id of [w.ids.done, w.ids.nope, 'abcdefabcdef']) assert.equal((await countFor(w.db, id, { now: NOW })).n, 0);
  assert.equal((await countFor(w.db, w.ids.fresh, { now: NOW })).n, 1);
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 1);
  await putRow(w.db, w.ids.done, await endorsementId(SECRET, w.ids.done, s2.eid));
  const deferred = [];
  await cachedPublicList({ env: w.env, kv: w.kv, ctx: { waitUntil: (p) => deferred.push(p) }, origin: 'https://x.dev', cache: null });
  assert.equal(deferred.length, 1);
  await Promise.all(deferred);
  assert.equal((await countFor(w.db, w.ids.done, { now: NOW })).n, 0);
});

dbTest('retention: expired rows are never counted or reported, and are deleted where the list is computed', async () => {
  const w = await world();
  const s = await session(1);
  assert.ok((await go(w, w.ids.open1, s)).ok);
  const r = await endRow(w.db, w.ids.open1, s);
  assert.equal(r.exp, boundary(NOW, 'month', 13), 'a month boundary 13 months ahead with the default 12');
  assert.equal(new Date(r.exp * 1000).getUTCDate(), 1);
  const after = r.exp * 1000 + 1000;
  const list = await computePublicList(w.env, w.kv, { sweep: false, now: NOW });
  assert.deepEqual(await endorsedBy({ db: w.db, env: w.env, session: s, publicList: list, now: after }), [], 'expired: not reported');
  assert.equal((await countFor(w.db, w.ids.open1, { now: after })).n, 0, 'expired: not counted');
  assert.equal((await endorsementCounts(w.db, { now: after })).size, 0);
  assert.equal(w.db.rows('endorsements').length, 1, 'counting only reads');
  await computePublicList(w.env, w.kv, { now: after });
  assert.equal(w.db.rows('endorsements').length, 0, 'the list computation deleted it');
  assert.deepEqual(w.db.rows('endorsement_counts'), [], 'the tally followed');
  // An expired row is replaced by a fresh endorsement, not mistaken for a repeat.
  await putRow(w.db, w.ids.open1, r.eh, 0, T - 10);
  const again = await go(w, w.ids.open1, s, 'v1', NOW);
  assert.deepEqual(again, { ok: true, endorsed: true, counted: true });
  // Rate counters (about a day) and sign-in markers (up to two hours) go too.
  assert.ok(w.db.rows('bsky_rate_counts').length > 0);
  w.db.sqlite.prepare('INSERT INTO bsky_flows_used (sh, exp) VALUES (?, ?)').run('f'.repeat(32), T + 3600);
  const purged = await purgeExpired(w.db, NOW + 3 * 86400e3);
  assert.ok(purged.rates > 0 && purged.flows === 1);
  assert.deepEqual(w.db.rows('bsky_rate_counts'), []);
  assert.deepEqual(w.db.rows('bsky_flows_used'), []);
  assert.equal(w.db.rows('endorsements').length, 1, 'a live endorsement stays');
});

dbTest('a failed write charges nothing and surfaces as a storage error', async () => {
  const w = await world();
  const list = await computePublicList(w.env, w.kv);
  w.db.failWrites = true;
  await assert.rejects(endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open1, session: await session(1), visitor: 'v', publicList: list, now: NOW }), StorageError);
  await assert.rejects(unendorse({ db: w.db, env: w.env, id: w.ids.open1, session: await session(1), visitor: 'v', now: NOW }), StorageError);
  w.db.failWrites = false;
  assert.deepEqual(rateRows(w.db), [], 'no counter charged: the batch is all or nothing');
  assert.equal(w.db.rows('endorsements').length, 0);
});

dbTest('every write path is one batch, and every statement is prepared with bound values', async () => {
  const w = await world();
  const s = await session(1, { issuer: 'https://pds.community.dev' });
  const list = await computePublicList(w.env, w.kv);
  const mark = w.db.ops.length;
  await endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open1, session: s, visitor: 'v', publicList: list, now: NOW });
  const ops = w.db.ops.slice(mark);
  assert.deepEqual(ops.map((o) => o.op), ['first', 'all', 'batch'], 'read, counts, one write batch');
  assert.equal(ops[2].sql.length, 5, 'the endorsement and four counters together');
  for (const o of w.db.ops) for (const sql of [].concat(o.sql)) assert.ok(!sql.includes(s.eid) && !Object.values(w.ids).some((id) => sql.includes(id)), 'no value in SQL text');
});

dbTest('indexes: every hot statement reads by key or index, never a full scan of a growing table', async () => {
  const db = fakeD1();
  const plan = (sql, n) => db.sqlite.prepare(`EXPLAIN QUERY PLAN ${typeof sql === 'function' ? sql(n || 3) : sql}`).all().map((r) => r.detail).join(' | ');
  const keyed = ['get', 'upgrade', 'remove', 'countOne', 'expired', 'expiredOne', 'clear', 'clearIn', 'purgeEndorsements', 'purgeRates', 'purgeFlows', 'endorsedIn', 'upgradeIn', 'removeIn', 'rates'];
  for (const name of keyed) {
    const p = plan(SQL[name]);
    // SCAN, with or without an index, reads every row; SEARCH reads only the matching ones.
    assert.ok(!/SCAN (endorsements|bsky_rate_counts|bsky_flows_used)\b/.test(p), `${name}: ${p}`);
  }
  // The tallies are one row per request with endorsements: reading them all is the point.
  assert.match(plan(SQL.counts), /endorsement_counts/);
});

test('the migrations create only hashed, WITHOUT ROWID tables', () => {
  const sql = migrations().map((m) => m.sql).join('\n');
  const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\) WITHOUT ROWID;/g)];
  assert.deepEqual(tables.map((t) => t[1]), ['endorsements', 'endorsement_counts', 'bsky_rate_counts', 'bsky_flows_used']);
  assert.equal((sql.match(/CREATE TABLE/g) || []).length, tables.length, 'every table is WITHOUT ROWID');
  const columns = tables.flatMap((t) => [...t[2].matchAll(/^\s*(\w+) /gm)].map((m) => m[1]));
  assert.deepEqual([...new Set(columns)].sort(), ['eh', 'exp', 'k', 'n', 'request_id', 'sh', 'unknown', 'y', 'young'].sort());
});

dbTest("wrangler's splitter cuts the migrations into statements that each apply", async (t) => {
  let split;
  try {
    ({ unstable_splitSqlQuery: split } = await import('wrangler'));
  } catch {
    t.skip('wrangler is not installed');
    return;
  }
  const db = fakeD1({ migrate: false });
  for (const m of migrations()) {
    const parts = split(m.sql);
    assert.ok(parts.filter((p) => /CREATE TRIGGER/.test(p)).every((p) => /\bEND$/.test(p.trim())), 'triggers stay whole');
    for (const p of parts) db.sqlite.exec(p);
  }
  assert.deepEqual(db.rows('endorsements'), []);
});
