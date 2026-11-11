// The public endorser list (worker/endorsers.js): per request only, every
// listed account verified on its own server, flags shown and never used to
// exclude, hostile text cleaned, and no way to look anything up by person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { handleEndorsers, flagsFor, cleanName, getProfiles, PAGE } from '../worker/endorsers.js';
import { addRequest, decide, currentId, requestKey, publicId } from '../worker/requests.js';
import { endorseSubject, buildEndorsement, ENDORSE_NSID, BLUESKY_MODERATION_DID } from '../worker/endorse-config.js';
import { W, json, didDoc, fakeNetwork, fakeCache, fakeLimiter, readyEnv } from './fake-atproto.js';

const BASE = '';
const ORIGIN = 'https://ask-siren.jason-edelman.org';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const did = (c) => `did:plc:${c.repeat(24)}`;

async function world() {
  const env = readyEnv();
  const net = fakeNetwork();
  const ids = {};
  for (const [name, status] of [['open', 'accepted'], ['done', 'fulfilled'], ['fresh', 'new'], ['nope', 'declined']]) {
    await addRequest({ body: { source: `Source ${name}` }, kv: env.LIMITS, visitor: name });
    ids[name] = await currentId(env.LIMITS, `Source ${name}`);
    if (status !== 'new') await decide(env.LIMITS, { id: ids[name], status, fulfilled_by: 'https://github.com/o/r/pull/1' });
  }
  const subject = endorseSubject(ORIGIN, BASE, ids.open);
  const endorse = (d, { profile, rkey = ids.open, record = buildEndorsement({ subject, id: ids.open, now: Date.parse('2026-11-08T09:00:00Z') }), index = true } = {}) => {
    net.state.didDocs.set(d, didDoc({ did: d, handle: null }));
    net.state.putRecord(d, ENDORSE_NSID, rkey, record, { index });
    if (profile !== null) net.state.profiles.set(d, { did: d, handle: `${d.slice(8, 12)}.bsky.social`, createdAt: '2024-01-01T00:00:00.000Z', labels: [], ...profile });
  };
  return { env, net, ids, subject, endorse };
}

const get = (w, id, query = '', { ip = '203.0.113.5', cache = null, now = NOW } = {}) =>
  handleEndorsers(new Request(`${ORIGIN}${BASE}/api/requests/${id}/endorsers${query}`, { headers: { 'CF-Connecting-IP': ip } }), w.env, null, BASE, id, { fetchImpl: w.net.fetch, cache, now });

test('the list: each account verified on its own server, dated by its record, with its flags', async () => {
  const w = await world();
  w.endorse(did('a'), { profile: { displayName: 'Ann' } });
  w.endorse(did('b'), { profile: { labels: [{ src: did('b'), val: 'bot', cts: '1970-01-01T00:00:00.000Z' }] } });
  const res = await get(w, w.ids.open);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
  const body = await res.json();
  assert.equal(body.total, 2);
  assert.equal(body.dropped, 0);
  assert.deepEqual(body.endorsers.map((e) => [e.did, e.handle, e.endorsed]), [[did('b'), 'bbbb.bsky.social', '2026-11-08'], [did('a'), 'aaaa.bsky.social', '2026-11-08']]);
  assert.equal(body.endorsers[1].displayName, 'Ann');
  assert.deepEqual(body.endorsers[0].flags.map((f) => f.kind), ['bot'], 'flagged, and still listed and counted');
  // One getProfiles call with every DID on the page, asking for Bluesky's labels.
  const prof = w.net.calls.filter((c) => c.url.includes('getProfiles'));
  assert.equal(prof.length, 1);
  assert.equal(prof[0].headers['atproto-accept-labelers'], BLUESKY_MODERATION_DID);
  assert.ok(new URL(prof[0].url).searchParams.getAll('actors').length <= PAGE);
});

test('a listed account whose record is gone from its server is dropped and counted; other tools\' keys verify', async () => {
  const w = await world();
  w.endorse(did('a'));
  w.endorse(did('c'), { rkey: '3kother', record: buildEndorsement({ subject: w.subject, id: w.ids.open }) });
  // Constellation still lists d, but d's repo has nothing (deleted, or never there).
  w.net.state.didDocs.set(did('d'), didDoc({ did: did('d'), handle: null }));
  w.net.state.backlinks.set(w.subject, [did('d'), ...w.net.state.backlinks.get(w.subject)]);
  // e's record points at another subject.
  w.endorse(did('e'), { record: buildEndorsement({ subject: `${w.subject}x`, id: w.ids.open }), index: false });
  w.net.state.backlinks.set(w.subject, [did('e'), ...w.net.state.backlinks.get(w.subject)]);
  const body = await (await get(w, w.ids.open)).json();
  assert.deepEqual(body.endorsers.map((e) => e.did).sort(), [did('a'), did('c')]);
  assert.equal(body.dropped, 2);
  assert.equal(body.total, 4, "Constellation's number, unverified, as the count is");
});

test('flags: the bot label only from the account itself; moderation only from Bluesky; new, unknown and missing profiles', () => {
  const p = (labels, createdAt = '2024-01-01T00:00:00.000Z') => ({ handle: 'x.bsky.social', displayName: '', labels, createdAt });
  const kinds = (d, prof) => flagsFor(d, prof, { now: NOW, young: 30 }).map((f) => f.kind);
  assert.deepEqual(kinds(did('a'), p([{ src: did('b'), val: 'bot' }])), [], 'another account calling it a bot is not the self-label');
  assert.deepEqual(kinds(did('a'), p([{ src: did('a'), val: 'bot', neg: true }])), []);
  assert.deepEqual(kinds(did('a'), p([{ src: did('a'), val: 'bot' }])), ['bot']);
  assert.deepEqual(kinds(did('a'), p([{ src: 'did:plc:someotherlabelerxxxxxxxx', val: 'spam' }])), [], 'only Bluesky moderation');
  assert.deepEqual(kinds(did('a'), p([{ src: BLUESKY_MODERATION_DID, val: 'porn' }])), [], 'only the chosen values (D13)');
  const mod = flagsFor(did('a'), p([{ src: BLUESKY_MODERATION_DID, val: 'spam' }, { src: BLUESKY_MODERATION_DID, val: 'spam' }, { src: BLUESKY_MODERATION_DID, val: 'impersonation' }]), { now: NOW });
  assert.deepEqual(mod.map((f) => f.reason), ["Labelled 'spam' by Bluesky moderation", "Labelled 'impersonation' by Bluesky moderation"]);
  const young = flagsFor(did('a'), p([], '2026-11-01T00:00:00.000Z'), { now: NOW, young: 30 });
  assert.deepEqual(young, [{ kind: 'new', reason: 'Account created 8 days ago' }]);
  assert.deepEqual(kinds(did('a'), p([], null)), ['age-unknown']);
  assert.deepEqual(kinds(did('a'), p([], 'yesterday')), ['age-unknown']);
  assert.deepEqual(kinds(did('a'), p([], '2099-01-01T00:00:00Z')), ['age-unknown']);
  assert.deepEqual(kinds(did('a'), undefined), ['no-profile']);
});

test('hostile handles and display names are cleaned and capped; record text is never shown', async () => {
  const w = await world();
  const evil = `<img src=x onerror=alert(1)>‮gnp.exe\u0000${'é'.repeat(200)}`;
  w.endorse(did('a'), { profile: { handle: 'not a handle<script>', displayName: evil }, record: { ...buildEndorsement({ subject: w.subject, id: w.ids.open }), subject: { uri: w.subject, id: w.ids.open, title: '<b>pwned</b>' } } });
  const body = await (await get(w, w.ids.open)).json();
  const [e] = body.endorsers;
  assert.equal(e.handle, null, 'an invalid handle is dropped');
  assert.ok(!/[‮\u0000]/.test(e.displayName));
  assert.ok([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(e.displayName)].length <= 64);
  assert.ok(!JSON.stringify(body).includes('pwned'), "the record's own title is never served");
  assert.equal(cleanName('⁦Ann⁩  Lee'), 'Ann Lee');
});

test('a profile list that isn\'t the shape asked for is refused; extra or foreign profiles are ignored', async () => {
  const net = fakeNetwork({ 'appview.fixture.dev/xrpc/app.bsky.actor.getProfiles': () => json({ profiles: [{ did: did('z'), handle: 'z.bsky.social' }, { did: did('a'), handle: 'a.bsky.social', labels: 'x' }] }) });
  const out = await getProfiles([did('a')], { origin: W.APPVIEW, fetchImpl: net.fetch });
  assert.deepEqual([...out.keys()], [did('a')]);
  assert.deepEqual(out.get(did('a')).labels, []);
  await assert.rejects(getProfiles(Array.from({ length: 26 }, (_, i) => did('a')), { origin: W.APPVIEW, fetchImpl: net.fetch }), { code: 'unavailable' });
  const bad = fakeNetwork({ 'appview.fixture.dev/xrpc/app.bsky.actor.getProfiles': () => json({ nope: true }) });
  await assert.rejects(getProfiles([did('a')], { origin: W.APPVIEW, fetchImpl: bad.fetch }), { code: 'unavailable' });
});

test('404 for anything not on the public list: new, declined, unknown, legacy; the flag off is a plain 404', async () => {
  const w = await world();
  for (const id of [w.ids.fresh, w.ids.nope, 'zzzzzzzzzzzzzzzz', 'abcdefabcdef', '../../x']) {
    const res = await get(w, id);
    assert.equal(res.status, 404, id);
  }
  assert.ok(!w.net.calls.some((c) => /limit=25|getProfiles|getRecord|listRecords/.test(c.url)), 'no endorser lookups for them (only the list counts)');
  assert.equal((await get(w, w.ids.done)).status, 200, 'fulfilled requests list their endorsers too');
  const off = await world();
  off.env.BLUESKY_LOGIN = undefined;
  const res = await get(off, off.ids.open);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Not found');
  assert.equal(off.net.calls.length, 0);
});

test('a crafted cursor is refused before any call; a real one pages through', async () => {
  const w = await world();
  for (let i = 0; i < 30; i++) w.endorse(`did:plc:${'abcdefghijklmnopqrstuvwxyz234567'[i]}${'q'.repeat(23)}`);
  for (const c of ['bad cursor', '<x>', 'x'.repeat(300)]) assert.equal((await get(w, w.ids.open, `?cursor=${encodeURIComponent(c)}`)).status, 400, c);
  const first = await (await get(w, w.ids.open)).json();
  assert.equal(first.endorsers.length, PAGE);
  assert.equal(first.cursor, '25');
  const second = await (await get(w, w.ids.open, `?cursor=${first.cursor}`)).json();
  assert.equal(second.endorsers.length, 5);
  assert.equal(second.cursor, null);
});

test('no person filter: did, handle or actor parameters change nothing, and nothing filters by person', async () => {
  const w = await world();
  w.endorse(did('a'));
  w.endorse(did('b'));
  const plain = await (await get(w, w.ids.open)).json();
  const n = w.net.calls.length;
  const filtered = await (await get(w, w.ids.open, `?did=${did('a')}&handle=aaaa.bsky.social&actor=${did('a')}&repo=${did('a')}`)).json();
  assert.deepEqual(filtered.endorsers, plain.endorsers);
  for (const c of w.net.calls.slice(n).filter((x) => x.url.includes('getBacklinkDids'))) {
    const u = new URL(c.url);
    assert.deepEqual([...u.searchParams.keys()].sort(), ['limit', 'source', 'subject']);
  }
  // Across the Worker's code, no route reads a person as a query parameter.
  // The only query parameters any route reads: a conversation id, and the
  // signed-in account's own conversation list's page size and cursor and its
  // search text (index.js: each private to its account, searched only in its
  // own conversations, never logged), the endorser list's cursor, the token
  // that carries an invite over from Siren's old address (moved.js, signed,
  // two minutes), the public question list's cursor (the free tier: a
  // sequence number, never a person), and the shared research list's city,
  // page size and cursor (research.js: a sequence number, never a person).
  const read = new Set();
  for (const f of readdirSync(new URL('../worker/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(`../worker/${f}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/searchParams\.get(?:All)?\('([^']+)'\)/g)) read.add(`${f}:${m[1]}`);
  }
  assert.deepEqual([...read].sort(), ['endorsers.js:cursor', 'index.js:cursor', 'index.js:id', 'index.js:limit', 'index.js:q', 'moved.js:t', 'public-ask.js:cursor', 'research.js:before', 'research.js:city', 'research.js:limit']);
});

test('limits: the visitor limit and the site breaker refuse before any outbound call; pages are cached', async () => {
  const w = await world();
  w.endorse(did('a'));
  w.env.BSKY_VISITOR_RL = fakeLimiter(0);
  assert.equal((await get(w, w.ids.open)).status, 429);
  w.env.BSKY_VISITOR_RL = fakeLimiter();
  w.env.BSKY_SITE_RL = fakeLimiter(0);
  const before = w.net.calls.length;
  assert.equal((await get(w, w.ids.open)).status, 429);
  assert.ok(!w.net.calls.slice(before).some((c) => c.url.includes('getBacklinkDids') && c.url.includes('limit=25')), 'no list call past the breaker');
  w.env.BSKY_SITE_RL = fakeLimiter();
  const cache = fakeCache();
  assert.equal((await get(w, w.ids.open, '', { cache })).status, 200);
  const n = w.net.calls.length;
  assert.equal((await get(w, w.ids.open, '', { cache })).status, 200);
  assert.equal(w.net.calls.length, n, 'the second view is a cache hit');
});

test('Constellation or the AppView down: a 503 that says so, never an empty list', async () => {
  const w = await world();
  w.endorse(did('a'));
  w.net.routes['appview.fixture.dev/xrpc/app.bsky.actor.getProfiles'] = () => new Response('', { status: 502 });
  const res = await get(w, w.ids.open);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'unavailable');
  const w2 = await world();
  w2.endorse(did('a'));
  w2.net.state.constellationDown = true;
  assert.equal((await get(w2, w2.ids.open)).status, 503);
});

import { endorserPage, PAGE_BUDGET } from '../worker/endorsers.js';

test('a page makes at most PAGE_BUDGET outbound requests; the rest are dropped as unchecked', async () => {
  const w = await world();
  // 25 endorsers whose records sit under another key: each needs its DID
  // document, a getRecord miss and a listRecords, so 2 + 75 would be needed.
  for (let i = 0; i < 25; i++) {
    const d = `did:plc:${'abcdefghijklmnopqrstuvwxyz'[i]}${'r'.repeat(23)}`;
    w.endorse(d, { rkey: '3kother', record: buildEndorsement({ subject: w.subject, id: w.ids.open }) });
  }
  const before = w.net.calls.length;
  const page = await endorserPage(w.env, w.ids.open, { base: BASE, fetchImpl: w.net.fetch, now: NOW });
  const made = w.net.calls.length - before;
  assert.ok(made <= PAGE_BUDGET, `${made} outbound requests`);
  assert.equal(page.endorsers.length + page.dropped, 25);
  assert.ok(page.unchecked > 0 && page.unchecked === page.dropped, 'leftover DIDs reported as dropped');
});

test('each DID is charged to the site breaker; a refused one is dropped unchecked, with nothing fetched for it', async () => {
  const w = await world();
  w.endorse(did('a'));
  w.endorse(did('b'));
  const counts = new Map();
  w.env.BSKY_SITE_RL = { async limit({ key }) { counts.set(key, (counts.get(key) || 0) + 1); return { success: key !== 'verify' || counts.get(key) <= 1 }; } };
  const page = await endorserPage(w.env, w.ids.open, { base: BASE, fetchImpl: w.net.fetch, now: NOW });
  assert.equal(counts.get('verify'), 2);
  assert.equal(page.endorsers.length, 1);
  assert.equal(page.unchecked, 1);
});

test('a DID with no findable PDS is remembered briefly; a budget miss is never remembered', async () => {
  const w = await world();
  w.net.state.backlinks.set(w.subject, [did('n')]); // no DID document anywhere
  const cache = fakeCache();
  await endorserPage(w.env, w.ids.open, { base: BASE, fetchImpl: w.net.fetch, cache, cacheBase: `${ORIGIN}${BASE}`, now: NOW });
  const hit = await cache.match(new Request(`${ORIGIN}${BASE}/__cache/did-pds-v1/${encodeURIComponent(did('n'))}`));
  assert.equal(await hit.text(), 'none');
  assert.equal(hit.headers.get('Cache-Control'), 'public, max-age=300');
  const before = w.net.calls.filter((c) => c.url.includes(did('n'))).length;
  await endorserPage(w.env, w.ids.open, { base: BASE, fetchImpl: w.net.fetch, cache, cacheBase: `${ORIGIN}${BASE}`, now: NOW });
  assert.equal(w.net.calls.filter((c) => c.url.includes(did('n'))).length, before, 'not looked up again');
  // Out of budget before the lookup: nothing cached for that DID.
  const w2 = await world();
  w2.endorse(did('m'));
  const cache2 = fakeCache();
  const page = await endorserPage(w2.env, w2.ids.open, { base: BASE, fetchImpl: w2.net.fetch, cache: cache2, cacheBase: `${ORIGIN}${BASE}`, now: NOW, budgetSize: 2 });
  assert.equal(page.unchecked, 1);
  assert.equal(await cache2.match(new Request(`${ORIGIN}${BASE}/__cache/did-pds-v1/${encodeURIComponent(did('m'))}`)), undefined);
});

test('verification stops at its deadline: a PDS that never answers can\'t hold the page', async () => {
  const w = await world();
  w.endorse(did('a'));
  w.net.routes['pds.fixture.dev/xrpc/com.atproto.repo.getRecord'] = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  w.net.routes['pds.fixture.dev/xrpc/com.atproto.repo.listRecords'] = w.net.routes['pds.fixture.dev/xrpc/com.atproto.repo.getRecord'];
  const keep = setTimeout(() => {}, 5000);
  const t = Date.now();
  const page = await endorserPage(w.env, w.ids.open, { base: BASE, fetchImpl: w.net.fetch, now: NOW, deadlineMs: 300 }).finally(() => clearTimeout(keep));
  assert.ok(Date.now() - t < 2000);
  assert.equal(page.dropped, 1);
  assert.equal(page.unchecked, 1);
});

test('the route takes only short cursors', async () => {
  const w = await world();
  w.endorse(did('a'));
  assert.equal((await get(w, w.ids.open, `?cursor=${'a'.repeat(65)}`)).status, 400);
  assert.equal((await get(w, w.ids.open, `?cursor=${'1'.repeat(10)}`)).status, 200);
});

test('a DID-document lookup cut off by the deadline is unchecked, and not remembered as "no PDS"', async () => {
  const w = await world();
  w.endorse(did('h'));
  const hang = (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  w.net.state.didDocs.delete(did('h'));
  w.net.routes[`plc.fixture.dev/${did('h')}`] = hang;
  const cache = fakeCache();
  const keep = setTimeout(() => {}, 5000);
  const page = await endorserPage(w.env, w.ids.open, { base: BASE, fetchImpl: w.net.fetch, cache, cacheBase: `${ORIGIN}${BASE}`, now: NOW, deadlineMs: 200 }).finally(() => clearTimeout(keep));
  assert.equal(page.unchecked, 1);
  assert.equal(await cache.match(new Request(`${ORIGIN}${BASE}/__cache/did-pds-v1/${encodeURIComponent(did('h'))}`)), undefined);
});
