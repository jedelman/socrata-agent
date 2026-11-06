// Endorsements: what gets written, what gets counted, and what can't be probed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endorse, unendorse, endorsedBy, forgetEndorser, endorsementCounts, countFor, clearRequestEndorsements,
  publicNumber, publicPolicy, youngFlag, endorsementKey, issuerBucket, orphanedIds, StorageError,
} from '../worker/endorsements.js';
import { addRequest, decide, requestKey, publicId, publicRequests, freezeAtDecision } from '../worker/requests.js';
import { cachedPublicList, purgePublicList, computePublicList } from '../worker/public-list.js';
import { hmacHex } from '../worker/crypto.js';
import { fakeKV, fakeLimiter, fakeCache, SECRET } from './fake-atproto.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const env0 = (over = {}) => ({ INVITE_SECRET: SECRET, BSKY_SITE_RL: fakeLimiter(), BSKY_VISITOR_RL: fakeLimiter(), BSKY_INPUT_RL: fakeLimiter(), ...over });
const session = async (n = 1, over = {}) => ({ eid: await hmacHex(SECRET, `endorser:did:plc:account${n}`), handle: '', created: '2025-01-02', issuer: 'https://bsky.social', ...over });

async function world() {
  const kv = fakeKV();
  const ids = {};
  for (const [name, status] of [['open1', 'accepted'], ['open2', 'accepted'], ['fresh', 'new'], ['nope', 'declined'], ['done', 'fulfilled']]) {
    await addRequest({ body: { source: `Source ${name}` }, kv, visitor: name, now: NOW });
    const id = publicId(await requestKey(`Source ${name}`));
    ids[name] = id;
    if (status !== 'new') await decide(kv, { id, status, fulfilled_by: status === 'fulfilled' ? 'https://github.com/o/r/pull/1' : undefined }, NOW);
  }
  return { kv, ids };
}

const go = async (kv, env, id, s, visitor = 'v1', now = NOW) => endorse({ kv, env, id, session: s, visitor, publicList: await computePublicList(env, kv), now });

test('one account counts once per request; a repeat is free', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const s = await session();
  const first = await go(kv, env, ids.open1, s);
  assert.deepEqual(first, { ok: true, endorsed: true, counted: true });
  const before = [...kv.store.keys()].filter((k) => k.startsWith('endorse-ev:')).length;
  const again = await go(kv, env, ids.open1, s);
  assert.equal(again.already, true);
  assert.equal([...kv.store.keys()].filter((k) => k.startsWith('endorse-ev:')).length, before, 'no event for a repeat');
  assert.deepEqual(await countFor(kv, ids.open1), { n: 1, young: 0, unknown: 0 });
});

test('a repeat after the account ages rewrites young to established, keeping the expiration', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const s = await session(1, { created: '2026-11-01' });
  assert.equal((await go(kv, env, ids.open1, s)).counted, false);
  const key = await endorsementKey(SECRET, ids.open1, s.eid);
  const exp = kv.store.get(key).expiration;
  assert.equal(kv.store.get(key).metadata.y, 1);
  const later = NOW + 40 * 86400e3;
  assert.equal((await go(kv, env, ids.open1, s, 'v1', later)).counted, true);
  assert.equal(kv.store.get(key).metadata.y, 0);
  assert.equal(kv.store.get(key).expiration, exp);
});

test('probing: new, declined, fulfilled and unknown ids get the same 404 and no KV work', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const s = await session();
  const list = await computePublicList(env, kv);
  const opsBefore = kv.ops.length;
  const outs = [];
  for (const id of [ids.fresh, ids.nope, ids.done, 'abcdefabcdef']) outs.push(JSON.stringify(await endorse({ kv, env, id, session: s, visitor: 'v', publicList: list, now: NOW })));
  assert.equal(new Set(outs).size, 1);
  assert.match(outs[0], /No open request has that id/);
  assert.equal(kv.ops.length, opsBefore, 'no KV operation beyond the public list');
});

test('unendorse: the same 200 for every id, no request lookup, and idempotent', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const s = await session();
  await go(kv, env, ids.open1, s);
  const opsBefore = kv.ops.length;
  const outs = [];
  for (const id of [ids.fresh, ids.nope, ids.done, ids.open1, 'abcdefabcdef', ids.open1]) outs.push(JSON.stringify(await unendorse({ kv, env, id, session: s, visitor: 'v', now: NOW })));
  assert.equal(new Set(outs).size, 1);
  assert.equal(outs[0], JSON.stringify({ ok: true, endorsed: false }));
  assert.ok(!kv.ops.slice(opsBefore).some((o) => (o.key || '').startsWith('request:') || (o.keys || []).some((k) => k.startsWith('request:'))));
  assert.equal((await countFor(kv, ids.open1)).n, 0);
  assert.equal((await unendorse({ kv, env, id: 'zz', session: s, visitor: 'v' })).status, 400);
});

test('daily limits per account, per visitor and per non-open issuer', async () => {
  let { kv, ids } = await world();
  let env = env0({ ENDORSE_PER_DID_DAILY: '1' });
  const s1 = await session(1);
  assert.ok((await go(kv, env, ids.open1, s1)).ok);
  assert.equal((await go(kv, env, ids.open2, s1)).status, 429);
  ({ kv, ids } = await world());
  env = env0({ ENDORSE_PER_VISITOR_DAILY: '1' });
  assert.ok((await go(kv, env, ids.open1, await session(1), 'same')).ok);
  assert.equal((await go(kv, env, ids.open1, await session(2), 'same')).status, 429);
  ({ kv, ids } = await world());
  env = env0({ ENDORSE_PER_ISSUER_DAILY: '1' });
  const self = { issuer: 'https://pds.selfhosted.dev' };
  assert.ok((await go(kv, env, ids.open1, await session(1, self), 'a')).ok);
  assert.equal((await go(kv, env, ids.open1, await session(2, self), 'b')).status, 429);
  for (let n = 3; n < 6; n++) assert.ok((await go(kv, env, ids.open1, await session(n), `v${n}`)).ok, 'bsky.social is an open issuer');
  ({ kv, ids } = await world());
  assert.equal((await go(kv, env0({ BSKY_SITE_RL: fakeLimiter(0) }), ids.open1, s1)).status, 429, 'the site breaker');
});

test('same tick: one account on two requests, two accounts on one request', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const list = await computePublicList(env, kv);
  const s1 = await session(1);
  const s2 = await session(2);
  const outs = await Promise.all([
    endorse({ kv, env, id: ids.open1, session: s1, visitor: 'v', publicList: list, now: NOW }),
    endorse({ kv, env, id: ids.open2, session: s1, visitor: 'v', publicList: list, now: NOW }),
    endorse({ kv, env, id: ids.open1, session: s2, visitor: 'w', publicList: list, now: NOW }),
  ]);
  assert.ok(outs.every((o) => o.ok));
  assert.equal((await countFor(kv, ids.open1)).n, 2);
  assert.equal((await countFor(kv, ids.open2)).n, 1);
});

test('forget removes all of one account\'s endorsements and nothing else', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const s1 = await session(1);
  const s2 = await session(2);
  await go(kv, env, ids.open1, s1);
  await go(kv, env, ids.open2, s1);
  await go(kv, env, ids.open1, s2);
  assert.deepEqual(await forgetEndorser({ kv, env, session: s1 }), { removed: 2 });
  assert.equal((await countFor(kv, ids.open1)).n, 1);
  assert.equal((await countFor(kv, ids.open2)).n, 0);
  assert.deepEqual(await endorsedBy({ kv, env, session: s2, publicList: await computePublicList(env, kv) }), [ids.open1]);
});

test('clearing one request removes only its keys and reports what remains', async () => {
  const { kv, ids } = await world();
  const env = env0();
  for (let n = 1; n <= 5; n++) await go(kv, env, ids.open1, await session(n), `v${n}`);
  await go(kv, env, ids.open2, await session(1));
  assert.deepEqual(await clearRequestEndorsements(kv, ids.open1, { max: 3 }), { cleared: 3, remaining: 2 });
  assert.deepEqual(await clearRequestEndorsements(kv, ids.open1), { cleared: 2, remaining: 0 });
  assert.equal((await countFor(kv, ids.open2)).n, 1);
});

test('counts group by id, split young and unknown; endorsedBy reports public ids only', async () => {
  const { kv, ids } = await world();
  const env = env0();
  await go(kv, env, ids.open1, await session(1));
  await go(kv, env, ids.open1, await session(2, { created: '2026-11-05' }), 'w');
  await go(kv, env, ids.open1, await session(3, { created: '' }), 'x');
  await go(kv, env, ids.open2, await session(1));
  const counts = await endorsementCounts(kv);
  assert.deepEqual(counts.get(ids.open1), { n: 3, young: 1, unknown: 1 });
  assert.deepEqual(counts.get(ids.open2), { n: 1, young: 0, unknown: 0 });
  const s1 = await session(1);
  await kv.put(await endorsementKey(SECRET, ids.fresh, s1.eid), '1', { metadata: { y: 0 } });
  assert.deepEqual((await endorsedBy({ kv, env, session: s1, publicList: await computePublicList(env, kv) })).sort(), [ids.open1, ids.open2].sort());
});

test('a minimum account age refuses young and unknown accounts; off, they endorse with y recorded', async () => {
  const { kv, ids } = await world();
  const on = env0({ ENDORSE_MIN_ACCOUNT_DAYS: '10' });
  assert.equal((await go(kv, on, ids.open1, await session(1, { created: '2026-11-01' }))).status, 403);
  assert.equal((await go(kv, on, ids.open1, await session(2, { created: '' }))).status, 403);
  assert.ok((await go(kv, on, ids.open1, await session(3))).ok);
  const off = env0();
  const young = await session(4, { created: '2026-11-01' });
  assert.ok((await go(kv, off, ids.open1, young)).ok);
  assert.equal(kv.store.get(await endorsementKey(SECRET, ids.open1, young.eid)).metadata.y, 1);
  const web = await session(5, { created: '' });
  await go(kv, off, ids.open1, web);
  assert.equal(kv.store.get(await endorsementKey(SECRET, ids.open1, web.eid)).metadata.y, null);
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

test('the public view carries a number only, sorted by asks with endorsements breaking ties', async () => {
  const { kv, ids } = await world();
  const env = env0();
  await go(kv, env, ids.open2, await session(1));
  const list = await computePublicList(env, kv);
  const text = JSON.stringify(list);
  assert.ok(!/"y"|endorsement:|young|unknown/.test(text));
  assert.deepEqual(list.requests.map((r) => r.id), [ids.open2, ids.open1, ids.done], 'equal asks: the endorsed one first');
  assert.equal(list.requests[0].endorsements, 1);
  await addRequest({ body: { source: 'Source open1' }, kv, visitor: 'again', now: NOW });
  assert.equal((await computePublicList(env, kv)).requests[0].id, ids.open1, 'asks come first');
  const plain = await publicRequests(kv);
  assert.ok(plain.requests.every((r) => !('endorsements' in r)), 'with the feature off, no endorsements field');
});

test('freeze: a decision writes the count once, then the keys go; reopening starts fresh', async () => {
  const { kv, ids } = await world();
  const env = env0();
  for (let n = 1; n <= 3; n++) await go(kv, env, ids.open1, await session(n), `v${n}`);
  await go(kv, env, ids.open1, await session(9, { created: '2026-11-05' }), 'v9');
  const key = await requestKey('Source open1');
  const live = await countFor(kv, ids.open1);
  const opsBefore = kv.ops.length;
  const out = await decide(kv, { id: ids.open1, status: 'fulfilled', fulfilled_by: 'https://github.com/o/r/pull/2' }, NOW, { live });
  assert.ok(out.ok);
  assert.equal(kv.ops.slice(opsBefore).filter((o) => o.op === 'put' && o.key === key).length, 1, 'written once');
  assert.deepEqual((await kv.get(key, 'json')).endorsements_at_decision, { n: 4, young: 1, unknown: 0 });
  await clearRequestEndorsements(kv, ids.open1);
  assert.equal((await countFor(kv, ids.open1)).n, 0);
  let row = (await computePublicList(env, kv)).requests.find((r) => r.id === ids.open1);
  assert.equal(row.endorsements, 3, 'fulfilled shows the frozen public number');
  await decide(kv, { id: ids.open1, status: 'accepted' }, NOW, { live: await countFor(kv, ids.open1) });
  row = (await computePublicList(env, kv)).requests.find((r) => r.id === ids.open1);
  assert.equal(row.endorsements, 0, 'reopened: live endorsements only');
  assert.deepEqual((await kv.get(key, 'json')).endorsements_at_decision, { n: 4, young: 1, unknown: 0 }, 'the steward still sees it');
  // fulfilled -> declined keeps the earlier frozen value.
  assert.deepEqual(freezeAtDecision({ status: 'fulfilled', endorsements_at_decision: { n: 2, young: 0, unknown: 0 } }, 'declined', { n: 0, young: 0, unknown: 0 }), { n: 2, young: 0, unknown: 0 });
  assert.equal(freezeAtDecision({ status: 'accepted' }, 'fulfilled', undefined), undefined);
  assert.equal(freezeAtDecision({ status: 'new' }, 'accepted', { n: 3, young: 0, unknown: 0 }), undefined);
});

test('the public list is served from the cache until purged', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const cache = fakeCache();
  const args = { env, kv, origin: 'https://jason-edelman.org', base: '/ask-siren', cache };
  const first = await cachedPublicList(args);
  await go(kv, env, ids.open1, await session(1));
  assert.deepEqual(await cachedPublicList(args), first, 'a cached list, though counts changed');
  const listsNow = kv.ops.filter((o) => o.op === 'list').length;
  await cachedPublicList(args);
  assert.equal(kv.ops.filter((o) => o.op === 'list').length, listsNow, 'a cached call lists nothing');
  await purgePublicList(args);
  const third = await cachedPublicList(args);
  assert.equal(third.requests.find((r) => r.id === ids.open1).endorsements, 1);
});

test('a repeat after an unknown age becomes known rewrites null to the known flag, and counted follows the stored flag', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const failedLookup = await session(1, { created: '' }); // the plc audit lookup failed at that sign-in
  assert.equal((await go(kv, env, ids.open1, failedLookup)).counted, false);
  const key = await endorsementKey(SECRET, ids.open1, failedLookup.eid);
  assert.equal(kv.store.get(key).metadata.y, null);
  const exp = kv.store.get(key).expiration;
  // Signed in again, the lookup worked: the stored flag is upgraded, the expiration kept.
  const again = await go(kv, env, ids.open1, await session(1, { created: '2020-01-01' }));
  assert.deepEqual(again, { ok: true, endorsed: true, already: true, counted: true });
  assert.equal(kv.store.get(key).metadata.y, 0);
  assert.equal(kv.store.get(key).expiration, exp);
  assert.equal(publicNumber(await countFor(kv, ids.open1), 'established'), 1);
  // Never downgraded: an established flag stays, and an unknown session doesn't erase it.
  await go(kv, env, ids.open1, await session(1, { created: '' }));
  assert.equal(kv.store.get(key).metadata.y, 0);
  // A young account whose stored flag is still young reports counted: false.
  const y = await session(2, { created: '2026-11-01' });
  await go(kv, env, ids.open1, y, 'v2');
  assert.equal((await go(kv, env, ids.open1, y, 'v2')).counted, false);
});

test('aging takes effect on `me` (endorsedBy): young and unknown flags become established without a click', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const youngThen = await session(1, { created: '2026-11-01' });
  assert.equal((await go(kv, env, ids.open1, youngThen)).counted, false);
  await go(kv, env, ids.open2, await session(1, { created: '' })); // stored unknown
  const k1 = await endorsementKey(SECRET, ids.open1, youngThen.eid);
  const exp = kv.store.get(k1).expiration;
  assert.equal(publicNumber(await countFor(kv, ids.open1), 'established'), 0);
  // While still young, `me` changes nothing.
  await endorsedBy({ kv, env, session: youngThen, publicList: await computePublicList(env, kv), now: NOW + 86400e3 });
  assert.equal(kv.store.get(k1).metadata.y, 1);
  // 40 days later the same account loads the page.
  const later = NOW + 40 * 86400e3;
  const ids2 = await endorsedBy({ kv, env, session: youngThen, publicList: await computePublicList(env, kv), now: later });
  assert.deepEqual(ids2.sort(), [ids.open1, ids.open2].sort());
  assert.equal(kv.store.get(k1).metadata.y, 0);
  assert.equal(kv.store.get(k1).expiration, exp, 'the month it was made in is kept');
  assert.equal(publicNumber(await countFor(kv, ids.open1), 'established'), 1);
  assert.equal(publicNumber(await countFor(kv, ids.open2), 'established'), 1);
  assert.equal((await computePublicList(env, kv)).requests.find((r) => r.id === ids.open1).endorsements, 1);
  // Nothing left to rewrite: a second call writes nothing.
  const puts = kv.ops.filter((o) => o.op === 'put').length;
  await endorsedBy({ kv, env, session: youngThen, publicList: await computePublicList(env, kv), now: later });
  assert.equal(kv.ops.filter((o) => o.op === 'put').length, puts);
});

test('burst limits: the visitor and per-server bindings refuse before the lagging KV counts', async () => {
  let { kv, ids } = await world();
  const s = await session(1);
  let env = env0({ BSKY_VISITOR_RL: fakeLimiter(0) });
  const out = await go(kv, env, ids.open1, s);
  assert.equal(out.status, 429);
  assert.equal((await countFor(kv, ids.open1)).n, 0, 'nothing written');
  assert.deepEqual(env.BSKY_VISITOR_RL.calls, ['end:v1']);
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('endorse-ev:')), 'KV counts are zero');
  assert.equal((await unendorse({ kv, env, id: ids.open1, session: s, visitor: 'v', now: NOW })).status, 429);
  assert.equal((await go(kv, env0({ BSKY_VISITOR_RL: fakeLimiter(5, { throws: true }) }), ids.open1, s)).status, 429, 'fails closed');
  // The per-server binding, keyed by the day's server hash, for non-open servers only.
  ({ kv, ids } = await world());
  env = env0({ BSKY_INPUT_RL: fakeLimiter(0) });
  assert.equal((await go(kv, env, ids.open1, await session(2, { issuer: 'https://pds.selfhosted.dev' }))).status, 429);
  assert.ok((await go(kv, env, ids.open1, await session(3))).ok, 'bsky.social is open');
  assert.equal(env.BSKY_INPUT_RL.calls.length, 1);
  assert.match(env.BSKY_INPUT_RL.calls[0], /^iss:[0-9a-f]{32}$/);
});

test('the per-server caps: one per server, one per registrable domain, no length heuristic', async () => {
  assert.equal(issuerBucket('https://a1.evil.dev'), 'evil.dev');
  // Short second-level labels are ordinary domains, not suffixes.
  assert.equal(issuerBucket('https://a1.abc.dev'), 'abc.dev');
  assert.equal(issuerBucket('https://a2.abc.dev'), 'abc.dev');
  assert.equal(issuerBucket('https://x.y.q7z.xyz'), 'q7z.xyz');
  assert.equal(issuerBucket('https://a1.abc.io'), issuerBucket('https://a2.abc.io'));
  assert.equal(issuerBucket('https://pds1.ab.dev'), issuerBucket('https://pds2.ab.dev'));
  // Listed multi-label suffixes keep one more label.
  assert.equal(issuerBucket('https://pds.example.co.uk'), 'example.co.uk');
  assert.equal(issuerBucket('https://a.b.example.com.au'), 'example.com.au');
  assert.equal(issuerBucket('https://pds1.github.io'), 'pds1.github.io');
  assert.notEqual(issuerBucket('https://pds1.github.io'), issuerBucket('https://pds2.github.io'));
  assert.equal(issuerBucket('https://svc-abc.a.run.app'), 'svc-abc.a.run.app');
  assert.equal(issuerBucket('https://bsky.social'), 'bsky.social');
  // Per server: one server's 1 a day doesn't touch its neighbour's.
  let { kv, ids } = await world();
  let env = env0({ ENDORSE_PER_ISSUER_DAILY: '1' });
  assert.ok((await go(kv, env, ids.open1, await session(1, { issuer: 'https://a1.abc.dev' }), 'a')).ok);
  assert.equal((await go(kv, env, ids.open2, await session(2, { issuer: 'https://a1.abc.dev' }), 'b')).status, 429);
  assert.ok((await go(kv, env, ids.open1, await session(3, { issuer: 'https://a2.abc.dev' }), 'c')).ok, 'another server under the same domain');
  // Per domain: a wildcard farm under abc.dev shares one cap.
  ({ kv, ids } = await world());
  env = env0({ ENDORSE_PER_DOMAIN_DAILY: '2' });
  assert.ok((await go(kv, env, ids.open1, await session(1, { issuer: 'https://a1.abc.dev' }), 'a')).ok);
  assert.ok((await go(kv, env, ids.open1, await session(2, { issuer: 'https://a2.abc.dev' }), 'b')).ok);
  assert.equal((await go(kv, env, ids.open1, await session(3, { issuer: 'https://a3.abc.dev' }), 'c')).status, 429);
  assert.ok((await go(kv, env, ids.open1, await session(4, { issuer: 'https://pds1.github.io' }), 'd')).ok, 'another domain');
  assert.ok((await go(kv, env, ids.open1, await session(5, { issuer: 'https://pds2.github.io' }), 'e')).ok, 'shared-hosting tenants are separate');
  // Event keys are uuids: nothing in them names a request, and a re-endorse charges again.
  ({ kv, ids } = await world());
  env = env0({ ENDORSE_PER_ISSUER_DAILY: '2' });
  const s = await session(1, { issuer: 'https://pds.community.dev' });
  assert.ok((await go(kv, env, ids.open1, s, 'a')).ok);
  assert.ok((await unendorse({ kv, env, id: ids.open1, session: s, visitor: 'a', now: NOW })).ok);
  const issuerEvents = [...kv.store.keys()].filter((k) => /^endorse-ev:[^:]+:[ir]:/.test(k));
  assert.equal(issuerEvents.length, 2, 'one per-server and one per-domain event');
  for (const k of issuerEvents) assert.match(k, /:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const tag = await hmacHex(SECRET, `issuer-ev:${new Date(NOW).toISOString().slice(0, 10)}:${ids.open1}:${s.eid}`, 32);
  assert.ok(![...kv.store.keys()].some((k) => k.includes(tag)), 'no per-(request, account) tag survives the withdrawal');
  assert.ok((await go(kv, env, ids.open1, s, 'a')).ok);
  assert.equal((await go(kv, env, ids.open2, await session(2, { issuer: 'https://pds.community.dev' }), 'b')).status, 429, 'the re-endorse used the server\'s day');
});

test('an age-flag rewrite racing a withdrawal leaves the endorsement withdrawn', async () => {
  for (const via of ['me', 'repeat']) {
    const { kv, ids } = await world();
    const env = env0();
    const young = await session(1, { created: '2026-10-30' });
    assert.ok((await go(kv, env, ids.open1, young)).ok);
    const aged = { ...young, created: '2026-01-01' };
    const ekey = await endorsementKey(SECRET, ids.open1, aged.eid);
    // Withdraw while the rewrite is between its first read and its put (the expiration listing).
    const realList = kv.list.bind(kv);
    let withdrew = null;
    kv.list = async (opts) => {
      if (withdrew === null && opts.prefix === ekey) withdrew = await unendorse({ kv, env, id: ids.open1, session: aged, visitor: 'v9', now: NOW });
      return realList(opts);
    };
    const list = await computePublicList(env, kv);
    const out = via === 'me'
      ? await endorsedBy({ kv, env, session: aged, publicList: list, now: NOW })
      : await endorse({ kv, env, id: ids.open1, session: aged, visitor: 'v1', publicList: list, now: NOW });
    assert.deepEqual(withdrew, { ok: true, endorsed: false }, via);
    assert.equal(kv.store.has(ekey), false, `${via}: the withdrawn key stays deleted`);
    if (via === 'me') assert.deepEqual(out, [], 'and me no longer lists it');
    else assert.equal(out.endorsed, false);
  }
});

test('the orphan sweep stops at its budget, and endorse and me never sweep', async () => {
  const { kv, ids } = await world();
  const env = env0();
  for (let n = 0; n < 150; n++) await kv.put(await endorsementKey(SECRET, ids.done, `e${n}`), '1', { metadata: { y: 0 } });
  const deletes = () => kv.ops.filter((o) => o.op === 'delete').length;
  // The bluesky routes compute the list with sweep: false.
  await cachedPublicList({ env, kv, origin: 'https://x.dev', cache: null, sweep: false });
  assert.equal(deletes(), 0);
  await computePublicList(env, kv);
  assert.equal(deletes(), 100, 'one sweep deletes at most 100');
  assert.equal((await countFor(kv, ids.done)).n, 50);
  await computePublicList(env, kv);
  assert.equal((await countFor(kv, ids.done)).n, 0, 'the next sweep finishes it');
});

test('orphans: keys that outlive a decision are swept where the list is computed', async () => {
  const { kv, ids } = await world();
  const env = env0();
  await go(kv, env, ids.open1, await session(1));
  // Written after the decision's own clear ran (list lag, or a stale list elsewhere).
  const s2 = await session(2);
  for (const id of [ids.done, ids.nope, 'abcdefabcdef']) await kv.put(await endorsementKey(SECRET, id, s2.eid), '1', { metadata: { y: 0 } });
  // A request moved back to new keeps its endorsements (undecided).
  await kv.put(await endorsementKey(SECRET, ids.fresh, s2.eid), '1', { metadata: { y: 0 } });
  const counts = await endorsementCounts(kv);
  const statuses = new Map([[ids.open1, 'accepted'], [ids.fresh, 'new'], [ids.done, 'fulfilled'], [ids.nope, 'declined']]);
  assert.deepEqual(orphanedIds(counts, statuses).sort(), [ids.done, ids.nope, 'abcdefabcdef'].sort());
  await computePublicList(env, kv);
  assert.equal((await countFor(kv, ids.done)).n, 0);
  assert.equal((await countFor(kv, ids.nope)).n, 0);
  assert.equal((await countFor(kv, 'abcdefabcdef')).n, 0);
  assert.equal((await countFor(kv, ids.fresh)).n, 1);
  assert.equal((await countFor(kv, ids.open1)).n, 1);
  // In the Worker the sweep is deferred to waitUntil.
  await kv.put(await endorsementKey(SECRET, ids.done, s2.eid), '1', { metadata: { y: 0 } });
  const deferred = [];
  await cachedPublicList({ env, kv, ctx: { waitUntil: (p) => deferred.push(p) }, origin: 'https://x.dev', cache: null });
  assert.equal(deferred.length, 1);
  await Promise.all(deferred);
  assert.equal((await countFor(kv, ids.done)).n, 0);
});

test('a failed endorsement write charges nothing and surfaces as a storage error', async () => {
  const { kv, ids } = await world();
  const env = env0();
  const list = await computePublicList(env, kv);
  kv.failPut = true;
  await assert.rejects(endorse({ kv, env, id: ids.open1, session: await session(1), visitor: 'v', publicList: list, now: NOW }), StorageError);
  await assert.rejects(unendorse({ kv, env, id: ids.open1, session: await session(1), visitor: 'v', now: NOW }), StorageError);
  kv.failPut = false;
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('endorse-ev:')), 'no event charged');
});
