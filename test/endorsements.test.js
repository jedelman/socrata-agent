// Endorsements: what gets written, what gets counted, and what can't be
// probed. The SQL really runs, on node:sqlite through test/fake-d1.js, over
// the real migrations; these tests skip where node:sqlite is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endorse, unendorse, endorsedBy, forgetEndorser, endorsementCounts, countFor, clearRequestEndorsements,
  publicNumber, publicPolicy, youngFlag, endorsementId, issuerBucket, orphanedIds, purgeExpired, purgeAll, sweepOrphans, PURGE_LIMIT, endorseDb, dbSetupError, StorageError, SQL,
  chargeD1, budgetCaps, ROWS, UPKEEP, LIST, VISITOR_MAX, OVER_BUDGET,
} from '../worker/endorsements.js';
import { addRequest, decide, requestKey, publicId, publicRequests, freezeAtDecision } from '../worker/requests.js';
import { cachedPublicList, purgePublicList, computePublicList } from '../worker/public-list.js';
import { hmacHex, boundary } from '../worker/crypto.js';
import { fakeKV, fakeLimiter, fakeCache, SECRET } from './fake-atproto.js';
import { fakeD1, D1_SKIP, migrations } from './fake-d1.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const T = Math.floor(NOW / 1000);
const dbTest = (name, fn) => test(name, { skip: D1_SKIP }, fn);
const env0 = (db, over = {}) => ({ BLUESKY_LOGIN: 'true', SIREN_DB: db, INVITE_SECRET: SECRET, BSKY_SITE_RL: fakeLimiter(), BSKY_VISITOR_RL: fakeLimiter(), BSKY_INPUT_RL: fakeLimiter(), BSKY_D1_RL: fakeLimiter(), ...over });
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
const mine = async (args) => (await endorsedBy(args)).endorsed;
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
  assert.deepEqual(await forgetEndorser({ db: w.db, env: w.env, session: s1 }), { ok: true, removed: 2 });
  assert.equal(w.kv.ops.length, kvOps, 'forget lists no KV keys');
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 1);
  assert.equal((await countFor(w.db, w.ids.open2, { now: NOW })).n, 0);
  assert.deepEqual(await mine({ db: w.db, env: w.env, session: s2, publicList: await computePublicList(w.env, w.kv), now: NOW }), [w.ids.open1]);
  assert.deepEqual(await forgetEndorser({ db: w.db, env: w.env, session: s1 }), { ok: true, removed: 0 });
});

dbTest('clearing one request removes only its rows and reports what remains', async () => {
  const w = await world();
  for (let n = 1; n <= 5; n++) await go(w, w.ids.open1, await session(n), `v${n}`);
  await go(w, w.ids.open2, await session(1));
  assert.deepEqual(await clearRequestEndorsements(w.db, w.env, w.ids.open1, { max: 3 }), { cleared: 3, remaining: 2, deferred: false });
  assert.deepEqual(await clearRequestEndorsements(w.db, w.env, w.ids.open1), { cleared: 2, remaining: 0, deferred: false });
  assert.equal((await countFor(w.db, w.ids.open2, { now: NOW })).n, 1);
  assert.deepEqual(await clearRequestEndorsements(w.db, w.env, 'not-an-id'), { cleared: 0, remaining: 0, deferred: false });
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
  assert.deepEqual((await mine({ db: w.db, env: w.env, session: s1, publicList: await computePublicList(w.env, w.kv, { sweep: false }), now: NOW })).sort(), [w.ids.open1, w.ids.open2].sort());
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
  await clearRequestEndorsements(w.db, w.env, w.ids.open1);
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

dbTest('if D1 fails, the list is still served, without counts, cached under its own key as long as a counted list (no extra KV lists)', async () => {
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
  assert.equal(cache.store.get('https://x.dev/__cache/public-requests-uncounted-v1').headers.get('Cache-Control'), 'public, max-age=60');
  assert.ok(errors.some((e) => /endorsement counts failed/.test(e)));
  // Within the 60 s, views are served from it: no KV list, no D1 call.
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

dbTest('if KV fails, the list reads no D1, remembers the failure for 30 s under its own key, and answers unavailable', async () => {
  const w = await world();
  await go(w, w.ids.open1, await session(1));
  const { LIST_UNAVAILABLE } = await import('../worker/public-list.js');
  const cache = fakeCache();
  const kvList = w.kv.list;
  let lists = 0;
  w.kv.list = async () => {
    lists++;
    throw new Error('KV list limit exceeded for the day');
  };
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const ops = w.db.ops.length;
  let out;
  try {
    out = await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache });
    assert.equal(out, LIST_UNAVAILABLE, 'no throw');
    assert.equal(w.db.ops.length, ops, 'no D1 call when KV failed');
    assert.deepEqual([...cache.store.keys()], ['https://x.dev/__cache/public-requests-failed-v1']);
    assert.equal(cache.store.get('https://x.dev/__cache/public-requests-failed-v1').headers.get('Cache-Control'), 'public, max-age=30');
    // Within the 30 s: from the cache, no KV list, no D1.
    assert.equal(await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache }), LIST_UNAVAILABLE);
    assert.equal(lists, 1);
    assert.equal(w.db.ops.length, ops);
    // Without a cache, still no throw and no D1.
    assert.equal(await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache: null }), LIST_UNAVAILABLE);
    assert.equal(w.db.ops.length, ops);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((e) => /request records unreadable/.test(e)));
  // KV back, and the cached failure dropped (or expired): counts again.
  w.kv.list = kvList;
  await purgePublicList({ origin: 'https://x.dev', cache });
  const back = await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache });
  assert.equal(back.requests.find((r) => r.id === w.ids.open1).endorsements, 1);
});

dbTest('the site-wide breaker refuses the count before any D1 call: the list is served without counts', async () => {
  const w = await world({ BSKY_D1_RL: fakeLimiter(0) });
  await putRow(w.db, w.ids.open1, 'e'.repeat(32));
  const ops = w.db.ops.length;
  const list = await computePublicList(w.env, w.kv, { now: NOW });
  assert.equal(list.endorsements_unavailable, true);
  assert.equal(w.db.ops.length, ops, 'no D1 call');
  assert.deepEqual(w.env.BSKY_D1_RL.calls, ['list']);
});

dbTest("the list pot caps the counts' D1 reads a day without KV failing: past it, one refused charge and the list without counts, cached 60 s", async () => {
  const w = await world();
  await putRow(w.db, w.ids.open1, 'e'.repeat(32));
  const kvList = w.kv.list;
  let lists = 0;
  w.kv.list = (...a) => { lists++; return kvList.apply(w.kv, a); };
  // Spend all but one of today's list computations.
  assert.ok(await chargeD1(w.db, w.env, { pot: 'list', calls: LIST.calls - 1, writes: LIST.writes - 1, now: NOW }));
  let mark = w.db.ops.length;
  const last = await computePublicList(w.env, w.kv, { sweep: false, now: NOW });
  assert.equal(last.requests.find((r) => r.id === w.ids.open1).endorsements, 1, 'the last one granted reads the counts');
  assert.deepEqual(w.db.ops.slice(mark).map((o) => o.sql.split(' ')[0]), ['INSERT', 'SELECT'], 'the charge, then the counts');
  const spent = JSON.stringify(w.db.rows('siren_d1_budget'));
  // KV keeps working, so nothing here leans on KV's list operations running out.
  mark = w.db.ops.length;
  const over = await computePublicList(w.env, w.kv, { now: NOW });
  assert.equal(over.endorsements_unavailable, true);
  assert.ok(over.requests.every((r) => !('endorsements' in r)), 'no wrong zeros');
  assert.deepEqual(w.db.ops.slice(mark).map((o) => o.sql.split(' ')[0]), ['INSERT'], 'one refused charge, no count read, no sweep');
  assert.equal(JSON.stringify(w.db.rows('siren_d1_budget')), spent, 'a refused charge writes nothing');
  assert.equal(lists, 2, 'KV answered both times');
  // Through the cache (which charges at the real time): served without counts
  // for as long as a counted list. Today's pot is spent first, whatever day it is.
  await chargeD1(w.db, w.env, { pot: 'list', calls: LIST.calls, writes: LIST.writes });
  const cache = fakeCache();
  const out = await cachedPublicList({ env: w.env, kv: w.kv, origin: 'https://x.dev', cache });
  assert.equal(out.endorsements_unavailable, true);
  assert.deepEqual([...cache.store.keys()], ['https://x.dev/__cache/public-requests-uncounted-v1']);
  assert.equal(cache.store.get('https://x.dev/__cache/public-requests-uncounted-v1').headers.get('Cache-Control'), 'public, max-age=60');
  // Each UTC day has its own pot (the day before NOW: never the real today).
  const next = await computePublicList(w.env, w.kv, { sweep: false, now: NOW - 86400e3 });
  assert.equal(next.requests.find((r) => r.id === w.ids.open1).endorsements, 1);
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
  await mine({ db: w.db, env: w.env, session: youngThen, publicList: list, now: NOW + 86400e3 });
  assert.equal((await endRow(w.db, w.ids.open1, youngThen)).y, 1, 'still young: nothing changes');
  const later = NOW + 40 * 86400e3;
  const ids2 = await mine({ db: w.db, env: w.env, session: youngThen, publicList: list, now: later });
  assert.deepEqual(ids2.sort(), [w.ids.open1, w.ids.open2].sort());
  assert.equal((await endRow(w.db, w.ids.open1, youngThen)).y, 0);
  assert.equal((await endRow(w.db, w.ids.open1, youngThen)).exp, exp, 'the month it was made in is kept');
  assert.equal(publicNumber(await countFor(w.db, w.ids.open1, { now: NOW }), 'established'), 1);
  assert.equal(publicNumber(await countFor(w.db, w.ids.open2, { now: NOW }), 'established'), 1);
  assert.equal((await computePublicList(w.env, w.kv)).requests.find((r) => r.id === w.ids.open1).endorsements, 1);
  // Nothing left to rewrite: the budget charge and one SELECT, no UPDATE.
  const calls = w.db.ops.length;
  await mine({ db: w.db, env: w.env, session: youngThen, publicList: list, now: later });
  assert.deepEqual(w.db.ops.slice(calls).map((o) => o.sql.split(' ')[0]), ['INSERT', 'SELECT']);
  assert.match(w.db.ops.at(-1).sql, /^SELECT eh, y FROM endorsements/);
});

dbTest('me is one SELECT over the first 99 accepted requests; forget splits long id lists under D1\'s 100-parameter limit', async () => {
  const w = await world();
  const s = await session(1);
  const many = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(12, '0'));
  for (const id of many.filter((_, i) => i % 3 === 0)) await putRow(w.db, id, await endorsementId(SECRET, id, s.eid));
  const list = { requests: many.map((id) => ({ id, status: 'accepted', source: id })) };
  const before = w.db.ops.length;
  const got = await mine({ db: w.db, env: w.env, session: s, publicList: list, now: NOW });
  assert.equal(got.length, 33, 'the first 99 on the list: ids 0, 3, ... 96');
  assert.equal(w.db.ops.slice(before).filter((o) => /^SELECT/.test(o.sql)).length, 1, 'one SELECT');
  assert.deepEqual(await forgetEndorser({ db: w.db, env: w.env, session: s }), { ok: true, removed: 84 });
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
  assert.deepEqual(await mine({ db: w.db, env: w.env, session: aged, publicList: list, now: NOW }), []);
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
  const swept = await sweepOrphans(w.db, w.env, counts, new Map());
  assert.equal(swept.length, 120, 'every orphan is reported');
  assert.deepEqual(w.db.ops.slice(mark).map((o) => o.sql.split(' ')[0]), ['INSERT', 'DELETE'], 'the upkeep charge, then one statement');
  assert.ok(w.db.ops.at(-1).params.length <= 100, "within D1's 100 bound parameters");
  assert.equal(w.db.rows('endorsements').length, 21, 'the first 99 ids this sweep (budget 100 rows), the rest next time');
  await sweepOrphans(w.db, w.env, await endorsementCounts(w.db, { now: NOW }), new Map());
  assert.equal(w.db.rows('endorsements').length, 0);
});

dbTest('purges are bounded per statement, and the cron purge finishes a backlog', async () => {
  const w = await world();
  for (let n = 0; n < 7; n++) await putRow(w.db, w.ids.open1, await endorsementId(SECRET, w.ids.open1, `x${n}`), 0, T - 10);
  await putRow(w.db, w.ids.open1, await endorsementId(SECRET, w.ids.open1, 'live'), 0, T + 86400);
  assert.equal(PURGE_LIMIT, 200);
  assert.deepEqual(await purgeExpired(w.db, w.env, NOW, { limit: 3 }), { endorsements: 3, rates: 0, budget: 0, deferred: false });
  assert.equal(w.db.rows('endorsements').length, 5);
  const mark = w.db.ops.length;
  assert.deepEqual(await purgeAll(w.db, w.env, NOW, { limit: 3 }), { endorsements: 4, rates: 0, budget: 0, deferred: false });
  assert.equal(w.db.ops.length - mark, 6, 'a count, a charge and one delete batch per round, stopping once a round comes up short');
  assert.equal(w.db.rows('endorsements').length, 1, 'the live one stays');
  assert.equal((await countFor(w.db, w.ids.open1, { now: NOW })).n, 1, 'the tally followed');
});

dbTest('purges report rows deleted, not D1 meta.changes (which counts the tally triggers too)', async () => {
  const w = await world();
  for (let n = 0; n < 6; n++) await putRow(w.db, w.ids.open1, await endorsementId(SECRET, w.ids.open1, `x${n}`), 0, T - 10);
  // The fake reports changes as D1 does: a DELETE of 2 rows also updates
  // the tally twice and deletes it once it reaches 0.
  const probe = await w.db.prepare('DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements LIMIT 2)').run();
  assert.ok(probe.meta.changes > 2, `meta.changes ${probe.meta.changes} counts trigger writes`);
  assert.deepEqual(await purgeExpired(w.db, w.env, NOW, { limit: 4 }), { endorsements: 4, rates: 0, budget: 0, deferred: false });
  // With exactly `limit` rows left, purgeAll stops after the round that finds none.
  for (let n = 0; n < 4; n++) await putRow(w.db, w.ids.open1, await endorsementId(SECRET, w.ids.open1, `y${n}`), 0, T - 10);
  const mark = w.db.ops.length;
  assert.deepEqual(await purgeAll(w.db, w.env, NOW, { limit: 5 }), { endorsements: 4, rates: 0, budget: 0, deferred: false });
  assert.equal(w.db.ops.length - mark, 3, 'a short round ends it: one round, not two');
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

dbTest('retention: expired rows are never reported, and the daily purge deletes them (the tallies follow)', async () => {
  const w = await world();
  const s = await session(1);
  assert.ok((await go(w, w.ids.open1, s)).ok);
  const r = await endRow(w.db, w.ids.open1, s);
  assert.equal(r.exp, boundary(NOW, 'month', 13), 'a month boundary 13 months ahead with the default 12');
  assert.equal(new Date(r.exp * 1000).getUTCDate(), 1);
  const after = r.exp * 1000 + 1000;
  const list = await computePublicList(w.env, w.kv, { sweep: false, now: NOW });
  assert.deepEqual(await mine({ db: w.db, env: w.env, session: s, publicList: list, now: after }), [], 'expired: not reported');
  // Counting reads the tallies only, so an expired row counts until the purge deletes it.
  assert.equal(w.db.rows('endorsements').length, 1, 'counting and the list only read');
  await computePublicList(w.env, w.kv, { now: after });
  assert.equal(w.db.rows('endorsements').length, 1, 'the list computation deletes nothing expired');
  const purged = await purgeExpired(w.db, w.env, after);
  assert.equal(purged.endorsements, 1);
  assert.equal(w.db.rows('endorsements').length, 0);
  assert.deepEqual(w.db.rows('endorsement_counts'), [], 'the tally followed');
  assert.equal((await endorsementCounts(w.db)).size, 0);
  // An expired row is replaced by a fresh endorsement, not mistaken for a repeat.
  await putRow(w.db, w.ids.open1, r.eh, 0, T - 10);
  const again = await go(w, w.ids.open1, s, 'v1', NOW);
  assert.deepEqual(again, { ok: true, endorsed: true, counted: true });
  assert.equal((await countFor(w.db, w.ids.open1)).n, 1, 're-made in place: still one in the tally');
  // Rate counters (about a day) and past days' budget rows go too.
  assert.ok(w.db.rows('bsky_rate_counts').length > 0);
  assert.ok(w.db.rows('siren_d1_budget').length > 0);
  const later = await purgeExpired(w.db, w.env, NOW + 3 * 86400e3);
  assert.ok(later.rates > 0 && later.budget >= 1);
  assert.deepEqual(w.db.rows('bsky_rate_counts'), []);
  assert.ok(!w.db.rows('siren_d1_budget').some((b) => b.day === '2026-11-06'), "a past day's budget rows are deleted");
  assert.ok(w.db.rows('siren_d1_budget').some((b) => b.day === '2026-11-09' && b.pot === 'upkeep'), "the purge's own charge stays");
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
  assert.deepEqual(ops.map((o) => o.op), ['all', 'batch', 'batch'], 'the budget charge, one read batch, one write batch');
  assert.match(ops[0].sql, /^INSERT INTO siren_d1_budget/);
  assert.equal(ops[2].sql.length, 5, 'the endorsement and four counters together');
  for (const o of w.db.ops) for (const sql of [].concat(o.sql)) assert.ok(!sql.includes(s.eid) && !Object.values(w.ids).some((id) => sql.includes(id)), 'no value in SQL text');
});

dbTest('indexes: every hot statement reads by key or index, never a full scan of a growing table', async () => {
  const db = fakeD1();
  const plan = (sql, n) => db.sqlite.prepare(`EXPLAIN QUERY PLAN ${typeof sql === 'function' ? sql(n || 3) : sql}`).all().map((r) => r.detail).join(' | ');
  const keyed = ['get', 'upgrade', 'remove', 'countOne', 'clear', 'clearIn', 'purgeEndorsements', 'purgeRates', 'expiredCounts', 'mine', 'upgradeIn', 'removeIn', 'rates', 'charge'];
  for (const name of keyed) {
    const p = plan(SQL[name]);
    // SCAN, with or without an index, reads every row; SEARCH reads only the matching ones.
    assert.ok(!/SCAN (endorsements|bsky_rate_counts)\b/.test(p), `${name}: ${p}`);
  }
  // The tallies are one row per request with endorsements: reading them all is the point.
  assert.match(plan(SQL.counts), /endorsement_counts/);
});

test('the migrations create only hashed, WITHOUT ROWID tables', () => {
  const sql = migrations().map((m) => m.sql).join('\n');
  const dropped = new Set([...sql.matchAll(/DROP TABLE IF EXISTS (\w+);/g)].map((m) => m[1]));
  const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\) WITHOUT ROWID;/g)].filter((t) => !dropped.has(t[1]));
  assert.deepEqual(tables.map((t) => t[1]), ['endorsements', 'endorsement_counts', 'bsky_rate_counts', 'siren_d1_budget']);
  assert.deepEqual([...dropped], ['bsky_flows_used'], 'the sign-in markers are gone');
  assert.equal((sql.match(/CREATE TABLE/g) || []).length, tables.length + dropped.size, 'every table is WITHOUT ROWID');
  const columns = tables.flatMap((t) => [...t[2].matchAll(/^\s*(\w+) /gm)].map((m) => m[1])).filter((c) => c !== 'PRIMARY');
  assert.deepEqual([...new Set(columns)].sort(), ['calls', 'day', 'eh', 'exp', 'k', 'n', 'pot', 'request_id', 'unknown', 'writes', 'y', 'young'].sort());
  const live = fakeD1();
  if (live) assert.deepEqual(live.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name), ['bsky_rate_counts', 'endorsement_counts', 'endorsements', 'siren_d1_budget']);
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

// ---- The daily D1 budget (docs/bluesky-endorsements.md, "Siren's worst case on the account's D1")

test("the budget's ceilings stay within 5% of the Free plan's daily D1 writes, whatever the config says", () => {
  const caps = budgetCaps({ ENDORSE_D1_WRITES_DAILY: '999999', ENDORSE_D1_CALLS_DAILY: '999999' });
  assert.equal(caps.visitor.writes, VISITOR_MAX.writes);
  assert.equal(caps.visitor.calls, VISITOR_MAX.calls);
  assert.ok(VISITOR_MAX.writes + UPKEEP.writes + LIST.writes <= 5000, '5% of 100,000 rows written, the list pot included');
  assert.deepEqual(budgetCaps({}).list, LIST);
  assert.ok(LIST.writes >= LIST.calls * ROWS.budget, 'each list computation writes only its budget row');
  assert.deepEqual(budgetCaps({ ENDORSE_D1_WRITES_DAILY: 'lots', ENDORSE_D1_CALLS_DAILY: '-3' }).visitor, { calls: 300, writes: 2400 }, 'a typo falls back to the default');
  assert.deepEqual(budgetCaps({}).upkeep, UPKEEP);
  // Each action is charged at least what D1 measured for it (the doc's table,
  // local D1, 2026-11-06), plus the budget row.
  assert.ok(ROWS.budget + ROWS.endorsement + 4 * ROWS.counter >= 12 + 1, 'new endorsement, four new counters: 12 rows');
  assert.ok(ROWS.budget + ROWS.endorsement + 2 * ROWS.counter >= 5 + 1, 'a withdrawal: 5 rows');
});

dbTest('chargeD1: granted up to each cap exactly, refused past it with nothing written, fresh the next UTC day', async () => {
  const db = fakeD1();
  const env = { ENDORSE_D1_WRITES_DAILY: '10', ENDORSE_D1_CALLS_DAILY: '3' };
  assert.equal(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: 4, now: NOW }), true);
  assert.equal(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: 6, now: NOW }), true);
  const full = JSON.stringify(db.rows('siren_d1_budget'));
  assert.equal(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: 1, now: NOW }), false, 'writes cap reached');
  assert.equal(JSON.stringify(db.rows('siren_d1_budget')), full, 'a refusal writes nothing');
  assert.equal(await chargeD1(db, env, { pot: 'visitor', writes: 11, now: NOW + 86400e3 }), false, 'more than a whole day asks for is refused, even first');
  assert.deepEqual(db.rows('siren_d1_budget').map((r) => r.day), ['2026-11-06'], 'and writes no row');
  assert.equal(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: 1, now: NOW + 86400e3 }), true, 'the next UTC day starts fresh');
  assert.equal(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: 1, now: NOW + 86400e3 }), true);
  assert.equal(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: 1, now: NOW + 86400e3 }), true);
  assert.equal(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: 1, now: NOW + 86400e3 }), false, 'calls cap reached');
  assert.equal(await chargeD1(db, env, { pot: 'upkeep', calls: 1, writes: 100, now: NOW }), true, "the pots are separate: visitors can't spend the upkeep budget");
  // Charges landing together can't both take the last of a cap.
  const db2 = fakeD1();
  const results = await Promise.all(Array.from({ length: 10 }, () => chargeD1(db2, { ENDORSE_D1_WRITES_DAILY: '14' }, { pot: 'visitor', calls: 1, writes: 14, now: NOW })));
  assert.equal(results.filter(Boolean).length, 1);
  await assert.rejects(chargeD1(db, env, { pot: 'other', writes: 1, now: NOW }), /Unknown budget pot/);
});

dbTest('over the budget, endorse, unendorse, me and forget answer over_budget after one D1 call and write nothing', async () => {
  const w = await world({ ENDORSE_D1_WRITES_DAILY: '28' });
  const s = await session(1);
  assert.ok((await go(w, w.ids.open1, s, 'a')).ok, '10 rows for an open server');
  assert.ok((await go(w, w.ids.open2, await session(2, { issuer: 'https://pds.example.dev' }), 'b')).ok, '14 for a capped one');
  const list = await computePublicList(w.env, w.kv, { sweep: false, now: NOW });
  const rows = JSON.stringify(['endorsements', 'bsky_rate_counts', 'siren_d1_budget'].map((t) => w.db.rows(t)));
  const mark = w.db.ops.length;
  assert.deepEqual(await endorse({ kv: w.kv, db: w.db, env: w.env, id: w.ids.open2, session: await session(3, { issuer: 'https://pds.example.dev' }), visitor: 'c', publicList: list, now: NOW }), OVER_BUDGET);
  assert.deepEqual(await unendorse({ db: w.db, env: w.env, id: w.ids.open1, session: s, visitor: 'a', now: NOW }), OVER_BUDGET);
  assert.equal(w.db.ops.length - mark, 2, 'one refused charge each, and nothing read past it');
  assert.equal(JSON.stringify(['endorsements', 'bsky_rate_counts', 'siren_d1_budget'].map((t) => w.db.rows(t))), rows, 'nothing written');
  // With the calls cap spent, me and forget stop at the charge too.
  const w2 = await world({ ENDORSE_D1_CALLS_DAILY: '1' });
  assert.ok((await go(w2, w2.ids.open1, s)).ok);
  const list2 = await computePublicList(w2.env, w2.kv, { sweep: false });
  const m2 = w2.db.ops.length;
  assert.deepEqual(await endorsedBy({ db: w2.db, env: w2.env, session: s, publicList: list2, now: NOW }), OVER_BUDGET);
  assert.deepEqual(await forgetEndorser({ db: w2.db, env: w2.env, session: s, now: NOW }), OVER_BUDGET);
  assert.equal(w2.db.ops.length - m2, 2);
  assert.equal(w2.db.rows('endorsements').length, 1, 'forget refused: nothing deleted');
});

dbTest('the upkeep budget bounds the purge, the sweep and the clears; refused, they delete nothing and say so', async () => {
  const w = await world();
  for (let n = 0; n < 30; n++) await putRow(w.db, w.ids.open1, await endorsementId(SECRET, w.ids.open1, `x${n}`), 0, T - 10);
  // Spend all but 50 rows of today's upkeep budget.
  assert.ok(await chargeD1(w.db, w.env, { pot: 'upkeep', calls: 1, writes: UPKEEP.writes - 50, now: NOW }));
  const out = await purgeAll(w.db, w.env, NOW, { limit: 200 });
  assert.equal(out.deferred, true);
  assert.ok(out.endorsements > 0 && out.endorsements < 30, `some deleted within the budget (${out.endorsements}), the rest left`);
  const upkeep = w.db.rows('siren_d1_budget').find((r) => r.pot === 'upkeep');
  assert.ok(upkeep.writes <= UPKEEP.writes);
  const left = w.db.rows('endorsements').length;
  // A clear the budget can't cover deletes nothing.
  assert.deepEqual(await clearRequestEndorsements(w.db, w.env, w.ids.open1, { now: NOW }), { cleared: 0, remaining: left, deferred: true });
  // Nor does a sweep.
  await sweepOrphans(w.db, w.env, await endorsementCounts(w.db), new Map(), { now: NOW });
  assert.equal(w.db.rows('endorsements').length, left);
  // Tomorrow's budget finishes it.
  const next = await purgeAll(w.db, w.env, NOW + 86400e3);
  assert.equal(next.deferred, false);
  assert.equal(w.db.rows('endorsements').length, 0);
});

test('/api/requests answers a JSON 503 when the request records can\'t be read, with or without endorsements (index.js)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("path === '/api/requests')"), src.indexOf('// Bluesky sign-in (bluesky.js)'));
  assert.match(route, /try \{\s*list = await publicRequests\(env\.LIMITS\);\s*\} catch/, 'flag off: a KV failure is caught');
  assert.match(route, /if \(list\.unavailable\) return unavailable\(\);/, 'flag on: cachedPublicList reports it');
  assert.match(route, /json\(\{ error: [^}]*code: 'unavailable'[^}]*\}, 503/);
});

// --- Requests + Bluesky endorsements together ---

dbTest('flag on: counts only on public requests, layered on the reviewed, day-granular list; nothing about requests awaiting review', async () => {
  const w = await world();
  for (const id of [w.ids.open1, w.ids.open2]) await go(w, id, await session(1));
  // A pending note on an accepted request stays hidden; a withdrawal shows id and day only.
  await addRequest({ body: { source: 'Source open1', need: 'not reviewed yet', public: true }, kv: w.kv, visitor: 'note', now: NOW });
  await decide(w.kv, { id: w.ids.open2, status: 'declined' }, NOW, { live: await countFor(w.db, w.ids.open2, { now: NOW }) });
  const list = await computePublicList(w.env, w.kv, { now: NOW });
  assert.deepEqual(Object.keys(list).sort(), ['requests', 'withdrawn']);
  assert.ok(!('awaiting_review' in list));
  assert.deepEqual(list.requests.map((r) => r.id).sort(), [w.ids.open1, w.ids.done].sort(), 'new and declined requests are not listed, so carry no count');
  for (const r of list.requests) {
    assert.equal(typeof r.endorsements, 'number');
    assert.match(r.first, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.last, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(list.requests.find((r) => r.id === w.ids.open1).endorsements, 1);
  assert.deepEqual(list.requests.find((r) => r.id === w.ids.open1).notes, []);
  assert.ok(!JSON.stringify(list).includes('not reviewed yet'));
  assert.deepEqual(list.withdrawn, [{ id: w.ids.open2, day: '2026-11-06' }]);
  // Without counts, the same list minus the endorsements field.
  const plain = await publicRequests(w.kv, NOW);
  assert.deepEqual(plain, { ...list, requests: list.requests.map(({ endorsements, ...r }) => r) });
});

dbTest('a stale raise after a fulfil cannot drop the frozen count: it lives in the decision key too', async () => {
  const w = await world();
  for (let n = 1; n <= 2; n++) await go(w, w.ids.open1, await session(n), `v${n}`);
  const key = await requestKey('Source open1');
  const stale = await w.kv.get(key, 'json');
  await decide(w.kv, { id: w.ids.open1, status: 'fulfilled', fulfilled_by: 'https://github.com/o/r/pull/3' }, NOW, { live: await countFor(w.db, w.ids.open1, { now: NOW }) });
  await clearRequestEndorsements(w.db, w.env, w.ids.open1);
  // A raise elsewhere that read the record before the decision rewrites it whole.
  await w.kv.put(key, JSON.stringify({ ...stale, count: stale.count + 1 }));
  const r = (await computePublicList(w.env, w.kv, { now: NOW })).requests.find((x) => x.id === w.ids.open1);
  assert.equal(r.status, 'fulfilled');
  assert.equal(r.endorsements, 2);
});
