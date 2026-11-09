// Counting endorsements through Constellation (worker/constellation.js) and
// the counted public list (worker/public-list.js): untrusted answers are
// checked, and a count that can't be read is never shown as 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backlinkDids, countEndorsers, constellationOrigin, CONSTELLATION_DEFAULT, validCursor } from '../worker/constellation.js';
import { liveCounts, computePublicList, cachedPublicList, CONCURRENCY } from '../worker/public-list.js';
import { addRequest, decide, currentId, requestKey, publicId } from '../worker/requests.js';
import { endorseSubject, ENDORSE_SOURCE, buildEndorsement, ENDORSE_NSID } from '../worker/endorse-config.js';
import { W, json, fakeNetwork, fakeCache, fakeLimiter, readyEnv } from './fake-atproto.js';

const BASE = '/ask-siren';
const C = 'constellation.fixture.dev/xrpc/blue.microcosm.links.getBacklinkDids';
const subj = (id) => endorseSubject('https://jason-edelman.org', BASE, id);
const DIDS = Array.from({ length: 30 }, (_, i) => `did:plc:${String.fromCharCode(97 + (i % 26)).repeat(23)}${'234567'[i % 6]}`);

test('the instance is the public one unless CONSTELLATION_URL is a bare https origin', () => {
  assert.equal(constellationOrigin({}), CONSTELLATION_DEFAULT);
  assert.equal(constellationOrigin({ CONSTELLATION_URL: 'https://links.example.org' }), 'https://links.example.org');
  for (const bad of ['http://links.example.org', 'https://links.example.org/x', 'https://10.0.0.1', 'https://links.example.org:8443', 'https://links.example.org/?q']) {
    assert.equal(constellationOrigin({ CONSTELLATION_URL: bad }), null, bad);
  }
});

test('getBacklinkDids: the subject, source, limit and User-Agent go out; distinct accounts come back', async () => {
  const net = fakeNetwork();
  net.state.backlinks.set(subj('abcdefghijklmnop'), DIDS.slice(0, 3));
  const out = await backlinkDids({ origin: W.CONSTELLATION, subject: subj('abcdefghijklmnop'), limit: 25, fetchImpl: net.fetch, ua: 'Siren (+https://jason-edelman.org/ask-siren/)' });
  assert.deepEqual(out, { total: 3, dids: DIDS.slice(0, 3), cursor: null });
  const call = new URL(net.calls[0].url);
  assert.equal(call.searchParams.get('subject'), subj('abcdefghijklmnop'));
  assert.equal(call.searchParams.get('source'), ENDORSE_SOURCE);
  assert.equal(call.searchParams.get('limit'), '25');
  assert.equal(call.searchParams.get('did'), null, 'never filtered by person');
  assert.equal(net.calls[0].headers['User-Agent'], 'Siren (+https://jason-edelman.org/ask-siren/)');
  assert.ok(!/@/.test(net.calls[0].headers['User-Agent']), 'no personal contact (D5)');
  assert.equal(await countEndorsers({ origin: W.CONSTELLATION, subject: subj('abcdefghijklmnop'), fetchImpl: net.fetch }), 3);
});

test('untrusted answers: bad shapes are refused, bad DIDs dropped, lists capped, failures are "unavailable"', async () => {
  const run = (handler, opts = {}) => backlinkDids({ origin: W.CONSTELLATION, subject: subj('abcdefghijklmnop'), limit: 2, fetchImpl: fakeNetwork({ [C]: handler }).fetch, ...opts });
  for (const body of [[], { total: -1 }, { total: 1.5 }, { total: '3' }, { total: 1e12 }, { total: 2, linking_dids: 'x' }, { total: 2, linking_dids: [], cursor: '<script>' }, { total: 2, linking_dids: [], cursor: 'x'.repeat(300) }]) {
    await assert.rejects(run(() => json(body)), { code: 'bad_response' }, JSON.stringify(body));
  }
  await assert.rejects(run(() => new Response('not json', { status: 200 })), { code: 'bad_response' });
  await assert.rejects(run(() => new Response('', { status: 500 })), { code: 'unavailable' });
  await assert.rejects(run(() => new Response('x'.repeat(70000), { status: 200 })), { code: 'unavailable' }, 'over 64 KB');
  await assert.rejects(run(() => { throw new TypeError('network down'); }), { code: 'unavailable' });
  const out = await run(() => json({ total: 9, linking_dids: ['did:plc:NOTVALID', DIDS[0], DIDS[0], 'javascript:alert(1)', DIDS[1], DIDS[2]], cursor: '2' }));
  assert.deepEqual(out.dids, [DIDS[0]], 'two at most read, invalid and repeated DIDs dropped');
  assert.equal(out.cursor, '2');
  await assert.rejects(run(() => json({ total: 0 }), { cursor: 'bad cursor!' }), { code: 'bad_request' });
  assert.ok(validCursor('abc123_-=') && !validCursor('') && !validCursor('a b'));
});

async function world({ n = 3 } = {}) {
  const env = readyEnv();
  const net = fakeNetwork();
  const ids = [];
  for (let i = 0; i < n; i++) {
    await addRequest({ body: { source: `Source ${i}` }, kv: env.LIMITS, visitor: `v${i}` });
    const id = await currentId(env.LIMITS, `Source ${i}`);
    await decide(env.LIMITS, { id, status: 'accepted' });
    ids.push(id);
  }
  return { env, net, ids };
}

test('counts: the distinct-account total for each listed request, through one breaker charge', async () => {
  const { env, net, ids } = await world();
  net.state.backlinks.set(subj(ids[0]), DIDS.slice(0, 2));
  const list = await computePublicList(env, env.LIMITS, { base: BASE, fetchImpl: net.fetch, cache: fakeCache() });
  const byId = Object.fromEntries(list.requests.map((r) => [r.id, r]));
  assert.equal(byId[ids[0]].endorsements, 2);
  assert.equal(byId[ids[1]].endorsements, 0, 'a real zero, read from Constellation');
  assert.equal(list.requests[0].id, ids[0], 'endorsements break the tie');
  assert.deepEqual(env.BSKY_SITE_RL.calls, ['counts']);
  assert.equal(net.calls.length, 3);
});

test('Constellation down: the last good count with its time, else "unavailable", never 0', async () => {
  const { env, net, ids } = await world({ n: 2 });
  const cache = fakeCache();
  net.state.backlinks.set(subj(ids[0]), DIDS.slice(0, 4));
  const t0 = Date.parse('2026-11-09T10:15:30Z');
  const first = await liveCounts(env, [ids[0]], { base: BASE, fetchImpl: net.fetch, cache, now: t0 });
  assert.deepEqual(first.get(ids[0]), { endorsements: 4 });
  net.state.constellationDown = true;
  const later = await liveCounts(env, ids, { base: BASE, fetchImpl: net.fetch, cache, now: t0 + 3600e3 });
  assert.deepEqual(later.get(ids[0]), { endorsements: 4, as_of: '2026-11-09T10:15Z' });
  assert.deepEqual(later.get(ids[1]), { endorsements: null, unavailable: true });
  const stale = await liveCounts(env, [ids[0]], { base: BASE, fetchImpl: net.fetch, cache, now: t0 + 25 * 3600e3 });
  assert.deepEqual(stale.get(ids[0]), { endorsements: null, unavailable: true }, 'older than 24 hours is not served');
  // Through the list: the field says so, and the number is null, not 0.
  const list = await computePublicList(env, env.LIMITS, { base: BASE, fetchImpl: net.fetch, cache, now: t0 + 3600e3 });
  const r1 = list.requests.find((r) => r.id === ids[1]);
  assert.equal(r1.endorsements, null);
  assert.equal(r1.endorsements_unavailable, true);
  const r0 = list.requests.find((r) => r.id === ids[0]);
  assert.equal(r0.endorsements_as_of, '2026-11-09T10:15Z');
});

test('a slow Constellation times out into the same fallback', async () => {
  const { env, ids } = await world({ n: 1 });
  const slow = fakeNetwork({ [C]: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
  const t = Date.now();
  // AbortSignal.timeout doesn't hold the event loop open on its own.
  const keep = setTimeout(() => {}, 10000);
  const out = await liveCounts(env, ids, { base: BASE, fetchImpl: slow.fetch, cache: fakeCache() }).finally(() => clearTimeout(keep));
  assert.deepEqual(out.get(ids[0]), { endorsements: null, unavailable: true });
  assert.ok(Date.now() - t < 6000, 'bounded by the 4-second timeout');
});

test('at most six calls at a time', async () => {
  const { env } = await world({ n: 0 });
  let inFlight = 0;
  let peak = 0;
  const net = fakeNetwork({
    [C]: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return json({ total: 1, linking_dids: [], cursor: null });
    },
  });
  const ids = Array.from({ length: 20 }, (_, i) => `${'abcdefghijklmno'}${'abcdefghijklmnopqrst'[i]}`);
  const out = await liveCounts(env, ids, { base: BASE, fetchImpl: net.fetch, cache: null });
  assert.equal(out.size, 20);
  assert.equal(peak, CONCURRENCY);
});

test('the breaker refusing means no outbound call; legacy ids are never counted', async () => {
  const { env, net, ids } = await world({ n: 1 });
  env.BSKY_SITE_RL = fakeLimiter(0);
  const out = await liveCounts(env, [...ids, 'abcdefabcdef'], { base: BASE, fetchImpl: net.fetch, cache: fakeCache() });
  assert.equal(net.calls.length, 0);
  assert.deepEqual(out.get(ids[0]), { endorsements: null, unavailable: true });
  assert.equal(out.has('abcdefabcdef'), false);
  // A legacy request on the list carries no endorsement fields at all.
  const key = await requestKey('Legacy listed');
  await env.LIMITS.put(key, JSON.stringify({ source: 'Legacy listed', count: 1, status: 'accepted', needs: [] }));
  const list = await computePublicList(env, env.LIMITS, { base: BASE, fetchImpl: fakeNetwork().fetch, cache: null });
  const legacy = list.requests.find((r) => r.id === publicId(key));
  assert.equal('endorsements' in legacy, false);
});

test('a fulfilled request shows the count frozen at its decision and its live count (D7)', async () => {
  const { env, net, ids } = await world({ n: 1 });
  net.state.backlinks.set(subj(ids[0]), DIDS.slice(0, 5));
  await decide(env.LIMITS, { id: ids[0], status: 'fulfilled', fulfilled_by: 'https://github.com/o/r/pull/1' }, Date.now(), { live: 3 });
  const [r] = (await computePublicList(env, env.LIMITS, { base: BASE, fetchImpl: net.fetch, cache: null })).requests;
  assert.equal(r.endorsements_at_decision, 3);
  assert.equal(r.endorsements, 5);
});

test('the counted list is cached for 60 seconds per location', async () => {
  const { env, net } = await world({ n: 1 });
  const cache = fakeCache();
  const args = { env, kv: env.LIMITS, origin: 'https://jason-edelman.org', base: BASE, cache, fetchImpl: net.fetch };
  await cachedPublicList(args);
  const n = net.calls.length;
  await cachedPublicList(args);
  assert.equal(net.calls.length, n, 'served from the cache');
  const hit = await cache.match(new Request('https://jason-edelman.org/ask-siren/__cache/public-requests-v2'));
  assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=60');
});

test('records written by other tools count the same: the record is the endorsement', async () => {
  const { env, net, ids } = await world({ n: 1 });
  net.state.putRecord(W.DID, ENDORSE_NSID, 'some-other-key', buildEndorsement({ subject: subj(ids[0]), id: ids[0] }));
  const out = await liveCounts(env, ids, { base: BASE, fetchImpl: net.fetch, cache: null });
  assert.deepEqual(out.get(ids[0]), { endorsements: 1 });
});
