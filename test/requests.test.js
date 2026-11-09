// The public source-request list: the steward gate, private notes, and the
// GitHub mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRequest, requestKey, publicRequests, publicView, withStatus, publicId } from '../worker/requests.js';
import { issueBody, issueTitle, mdText } from '../scripts/sync-request-issues.js';

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      return type === 'json' ? JSON.parse(store.get(k)) : store.get(k);
    },
    async put(k, v) {
      store.set(k, String(v));
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

test('nothing is public until the steward accepts it, and old notes stay private', async () => {
  const kv = fakeKV();
  const sent = Date.parse('2026-11-05T12:00:00Z');
  await addRequest({ body: { source: 'Norfolk City Code, Chapter 45', need: 'An old note, sent before requests were public' }, kv, visitor: 'v1', now: sent });
  await addRequest({ body: { source: 'Norfolk City Code, Chapter 45', need: 'Are Ghent trees protected?', public: true }, kv, visitor: 'v2', now: sent });
  await addRequest({ body: { source: 'ARB historic district guidelines', need: 'Front-yard trees?', public: true }, kv, visitor: 'v3', now: sent });
  let list = await publicRequests(kv, Date.parse('2026-11-06T12:00:00Z'));
  assert.deepEqual(list, { requests: [], withdrawn: [] }, 'not even a count of what awaits review');

  const key = await requestKey('Norfolk City Code, Chapter 45');
  await kv.put(key, JSON.stringify(withStatus(await kv.get(key, 'json'), 'accepted', { steward_note: 'Municode is behind a bot challenge; a copy we can re-check is needed.' })));
  list = await publicRequests(kv, Date.parse('2026-11-06T13:00:00Z'));
  assert.equal(list.requests.length, 1);
  let r = list.requests[0];
  assert.equal(r.id, publicId(key));
  assert.equal(r.count, 2);
  assert.deepEqual(r.notes, [], 'accepting a request approves none of its notes');
  for (const n of (await allRequests(kv)).find((x) => x.id === r.id).needs) assert.ok((await reviewNote(kv, { id: r.id, note: n.id, action: 'approve' })).ok);
  r = (await publicRequests(kv)).requests[0];
  assert.deepEqual(r.notes, ['Are Ghent trees protected?'], 'only approved notes written under the public notice');
  assert.match(r.steward_note, /bot challenge/);
  assert.ok(!JSON.stringify(list).includes('old note'));
});

test('steward statuses are checked, and fulfilled needs a link', () => {
  assert.throws(() => withStatus({}, 'maybe'), /Status must be one of/);
  assert.throws(() => withStatus({}, 'fulfilled', { fulfilled_by: 'javascript:alert(1)' }), /https link/);
  const done = withStatus({ source: 's', count: 1 }, 'fulfilled', { fulfilled_by: 'https://github.com/x/y/pull/9' });
  assert.equal(done.fulfilled_by, 'https://github.com/x/y/pull/9');
  assert.ok(done.decided);
  assert.equal(publicView('request:abcdef0123456789', done).status, 'fulfilled');
});

test('issue bodies show typed text literally and never ping anyone', () => {
  assert.equal(mdText('@everyone [click](https://evil.example) <img src=x> **bold**'), '@​everyone \\[click\\]\\(https://evil\\.example\\) \\<img src=x\\> \\*\\*bold\\*\\*');
  const r = { id: 'abc123def456', source: 'Norfolk City Code @team', count: 3, status: 'accepted', notes: ['ping @jedelman please'], steward_note: 'Needs a stable copy.' };
  const body = issueBody(r, 'https://x.org/ask-siren/requests', 'owner/repo');
  assert.ok(body.startsWith('<!-- source-request:abc123def456 -->'));
  assert.ok(!/(^|[^​])@jedelman/.test(body.replace(/@​/g, '')) || body.includes('@​jedelman'));
  assert.ok(!/@(?!​)/.test(body.replace(/<!--[\s\S]*?-->/, '')), 'every @ is defused');
  assert.match(body, /https:\/\/github\.com\/owner\/repo\/blob\/main\/docs\/fulfilling-requests\.md/);
  assert.ok(!issueTitle(r).match(/@(?!​)/));
});

import { decide, allRequests, reviewNote, withNoteReview, normalizeRecord, raiseResponse } from '../worker/requests.js';
import { isAdmin, userId } from '../worker/accounts.js';
import { plan, operations, withdrawnBody } from '../scripts/sync-request-issues.js';

test('only accounts named in ADMIN_EMAILS are stewards', async () => {
  const env = { INVITE_SECRET: 'test-secret-that-is-long-enough', ADMIN_EMAILS: ' Steward@Example.org , other@example.org' };
  assert.equal(await isAdmin(env, await userId(env.INVITE_SECRET, 'steward@example.org')), true);
  assert.equal(await isAdmin(env, await userId(env.INVITE_SECRET, 'someone@example.org')), false);
  assert.equal(await isAdmin({ ...env, ADMIN_EMAILS: '' }, await userId(env.INVITE_SECRET, 'steward@example.org')), false);
  assert.equal(await isAdmin(env, null), false);
});

test('the steward decides by id; the admin list shows private notes, marked', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'ARB guidelines', need: 'old note' }, kv, visitor: 'v' });
  await addRequest({ body: { source: 'ARB guidelines', need: 'new note', public: true }, kv, visitor: 'w' });
  const [r] = await allRequests(kv);
  assert.equal(r.status, 'new');
  assert.deepEqual(r.needs.map((n) => n.public), [false, true]);
  assert.equal((await decide(kv, { id: 'zzz', status: 'accepted' })).status, 400);
  assert.equal((await decide(kv, { id: r.id, status: 'fulfilled' })).status, 400, 'fulfilled needs a link');
  const ok = await decide(kv, { id: r.id, status: 'accepted', note: 'Needs the current ARB guidelines PDF.' });
  assert.ok(ok.ok);
  assert.equal(ok.request.steward_note, 'Needs the current ARB guidelines PDF.');
  assert.equal((await publicRequests(kv)).requests.length, 1);
  const cleared = await decide(kv, { id: r.id, status: 'accepted', note: '' });
  assert.equal(cleared.request.steward_note, undefined);
});

test('the sync plan says what each issue should hold', () => {
  const p = plan([{ id: 'abc123def456', source: 'S', count: 2, status: 'fulfilled', notes: [] }], 'https://x/requests', 'o/r');
  assert.equal(p[0].state, 'closed');
  assert.equal(p[0].marker, '<!-- source-request:abc123def456 -->');
  assert.ok(p[0].body.startsWith(p[0].marker));
});

import { requestByPublicId, freezeAtDecision } from '../worker/requests.js';

test('other keys never collide with request: keys (Bluesky data lives in D1, not KV)', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'ARB guidelines' }, kv, visitor: 'v' });
  const [r] = await allRequests(kv);
  // Values that would break JSON.parse if anything read them as requests.
  await kv.put(`request-rate:2026-11-06:${'a'.repeat(32)}`, '1');
  await kv.put(`login-rate:2026-11-06T12:v:${'c'.repeat(32)}`, '');
  assert.equal((await allRequests(kv)).length, 1);
  assert.deepEqual(await publicRequests(kv), { requests: [], withdrawn: [] }, 'no count of requests awaiting review');
  assert.equal((await requestByPublicId(kv, r.id)).cur.source, 'ARB guidelines');
  assert.equal(await requestByPublicId(kv, 'nothex'), null);
  assert.ok((await decide(kv, { id: r.id, status: 'accepted' })).ok);
});

test('freezeAtDecision: live on the way into a decision, the earlier value otherwise', () => {
  const live = { n: 5, young: 1, unknown: 2 };
  assert.deepEqual(freezeAtDecision({ status: 'accepted' }, 'fulfilled', live), live);
  assert.deepEqual(freezeAtDecision({ status: 'new' }, 'declined', live), live);
  assert.deepEqual(freezeAtDecision({ status: 'declined', endorsements_at_decision: { n: 1, young: 0, unknown: 0 } }, 'fulfilled', live), { n: 1, young: 0, unknown: 0 });
  assert.deepEqual(freezeAtDecision({ status: 'fulfilled', endorsements_at_decision: { n: 1, young: 0, unknown: 0 } }, 'accepted', live), { n: 1, young: 0, unknown: 0 });
  assert.equal(freezeAtDecision({ status: 'accepted' }, 'accepted', live), undefined);
  assert.equal(freezeAtDecision({ status: 'accepted' }, 'fulfilled', undefined), undefined, 'nothing to freeze without a count');
});

// --- Inc 1: notes reviewed whatever the status, days not times, the count
// only when public, and withdrawals reaching GitHub.

const ISO_TIME = /\d{2}:\d{2}/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const at = (s) => Date.parse(s);

test('new notes are stored pending, with a day and an id; first and last are days', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'ARB guidelines', need: 'Front-yard trees?', public: true }, kv, visitor: 'v', now: at('2026-11-06T13:45:12.345Z') });
  await addRequest({ body: { source: 'ARB guidelines', need: 'Fences too?', public: true }, kv, visitor: 'w', now: at('2026-11-07T08:01:02.003Z') });
  const raw = await kv.get(await requestKey('ARB guidelines'), 'json');
  assert.equal(raw.first, '2026-11-06');
  assert.equal(raw.last, '2026-11-07');
  assert.equal(raw.needs.length, 2);
  for (const n of raw.needs) {
    assert.equal(n.review, 'pending');
    assert.match(n.day, DAY);
    assert.equal(n.at, undefined, 'no millisecond timestamp');
    assert.match(n.id, /^n[0-9a-f]{8}$/);
  }
  assert.notEqual(raw.needs[0].id, raw.needs[1].id);
  assert.ok(!ISO_TIME.test(JSON.stringify(raw)), 'no time of day anywhere in the record');
});

test('a note added after acceptance stays private until the steward approves it', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Norfolk tree ordinance', need: 'First question?', public: true }, kv, visitor: 'v' });
  const [r0] = await allRequests(kv);
  assert.ok((await decide(kv, { id: r0.id, status: 'accepted' })).ok);
  assert.ok((await reviewNote(kv, { id: r0.id, note: r0.needs[0].id, action: 'approve' })).ok);
  await addRequest({ body: { source: 'Norfolk tree ordinance', need: 'Unreviewed later note', public: true }, kv, visitor: 'w' });
  let feed = await publicRequests(kv);
  assert.deepEqual(feed.requests[0].notes, ['First question?']);
  assert.ok(!JSON.stringify(feed).includes('Unreviewed later note'));
  const later = (await allRequests(kv))[0].needs.find((n) => n.text === 'Unreviewed later note');
  assert.equal(later.review, 'pending');
  // Re-deciding the request (a new steward note, or fulfilled) approves nothing.
  assert.ok((await decide(kv, { id: r0.id, status: 'fulfilled', fulfilled_by: 'https://github.com/o/r/pull/1' })).ok);
  assert.ok(!JSON.stringify(await publicRequests(kv)).includes('Unreviewed later note'));
  await reviewNote(kv, { id: r0.id, note: later.id, action: 'approve' });
  feed = await publicRequests(kv);
  assert.deepEqual(feed.requests[0].notes, ['First question?', 'Unreviewed later note']);
});

test('notes are reviewed whatever the status: new and declined requests too', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Budget book', need: 'Tree budget by year?', public: true }, kv, visitor: 'v' });
  const [r] = await allRequests(kv);
  assert.equal(r.status, 'new');
  const ok = await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'approve' });
  assert.ok(ok.ok);
  assert.equal(ok.needs[0].review, 'ok');
  assert.deepEqual((await publicRequests(kv)).requests, [], 'an approved note on a new request is still not public');
  await decide(kv, { id: r.id, status: 'declined' });
  const del = await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'delete' });
  assert.ok(del.ok);
  assert.deepEqual(del.needs, []);
  assert.ok(![...kv.store.values()].some((v) => v.includes('Tree budget by year?')), 'a deleted note is gone from storage');
});

test('note review refuses bad ids, unknown notes and unknown actions', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Budget book', need: 'A note', public: true }, kv, visitor: 'v' });
  const [r] = await allRequests(kv);
  assert.equal((await reviewNote(kv, { id: 'nope', note: r.needs[0].id, action: 'approve' })).status, 400);
  assert.equal((await reviewNote(kv, { id: '000000000000', note: r.needs[0].id, action: 'approve' })).status, 404);
  assert.equal((await reviewNote(kv, { id: r.id, note: 'BAD ID!', action: 'approve' })).status, 400);
  assert.equal((await reviewNote(kv, { id: r.id, note: 'n00000000', action: 'approve' })).status, 404);
  assert.equal((await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'publish' })).status, 400);
  assert.throws(() => withNoteReview({ needs: [] }, 'n1', 'approve'), /no note/);
  assert.equal((await allRequests(kv))[0].needs[0].review, 'pending', 'nothing changed');
});

test('legacy records: notes count as reviewed only when written no later than the decision', async () => {
  const kv = fakeKV();
  const key = await requestKey('City Code Chapter 45');
  const legacy = {
    source: 'City Code Chapter 45',
    url: '',
    count: 4,
    first: '2026-10-01T10:00:00.000Z',
    last: '2026-10-20T10:00:00.000Z',
    status: 'accepted',
    decided: '2026-10-10T12:00:00.000Z',
    needs: [
      { text: 'private old note', at: '2026-10-01T10:00:00.000Z', public: false },
      { text: 'reviewed before the decision', at: '2026-10-05T10:00:00.000Z', public: true },
      { text: 'same instant as the decision', at: '2026-10-10T12:00:00.000Z', public: true },
      { text: 'after the decision', at: '2026-10-20T10:00:00.000Z', public: true },
    ],
  };
  await kv.put(key, JSON.stringify(legacy));
  let feed = await publicRequests(kv);
  const r = feed.requests[0];
  assert.deepEqual(r.notes, ['reviewed before the decision', 'same instant as the decision']);
  assert.equal(r.first, '2026-10-01');
  assert.equal(r.last, '2026-10-20');
  assert.ok(!ISO_TIME.test(JSON.stringify(feed)), 'the feed carries days only');

  // The steward sees every legacy note with a stable id and its review state.
  const before = (await allRequests(kv))[0].needs;
  // The private note was never shown, so it isn't counted as reviewed (it needs no review either).
  assert.deepEqual(before.map((n) => n.review), ['pending', 'ok', 'ok', 'pending']);
  assert.ok(before.every((n) => /^l[0-9a-f]{8}$/.test(n.id)));
  assert.equal(new Set(before.map((n) => n.id)).size, 4);

  // The next write rewrites the record in the new shape, ids and reviews kept.
  await addRequest({ body: { source: 'City Code Chapter 45', need: 'brand new', public: true }, kv, visitor: 'v', now: at('2026-11-06T09:00:00Z') });
  const raw = await kv.get(key, 'json');
  assert.deepEqual(raw.needs.slice(0, 4).map((n) => [n.id, n.review]), before.map((n) => [n.id, n.review]));
  assert.ok(raw.needs.every((n) => n.at === undefined && DAY.test(n.day)));
  assert.equal(raw.first, '2026-10-01');
  assert.equal(raw.last, '2026-11-06');
  feed = await publicRequests(kv);
  assert.deepEqual(feed.requests[0].notes, ['reviewed before the decision', 'same instant as the decision']);

  // A legacy id from the steward's page works for review.
  assert.ok((await reviewNote(kv, { id: r.id, note: before[3].id, action: 'approve' })).ok);
  assert.deepEqual((await publicRequests(kv)).requests[0].notes, ['reviewed before the decision', 'same instant as the decision', 'after the decision']);
});

test('legacy: a later decision does not approve notes written after the earlier one', () => {
  const legacy = {
    source: 'S', count: 2, status: 'accepted', decided: '2026-10-10T12:00:00.000Z',
    needs: [{ text: 'before', at: '2026-10-09T00:00:00.000Z', public: true }, { text: 'after', at: '2026-10-11T00:00:00.000Z', public: true }],
  };
  const next = withStatus(legacy, 'fulfilled', { fulfilled_by: 'https://github.com/o/r/pull/2' }, at('2026-11-06T00:00:00Z'));
  assert.deepEqual(next.needs.map((n) => n.review), ['ok', 'pending']);
  assert.deepEqual(publicView('request:abcdef012345aaaa', next).notes, ['before']);
  // A legacy request never decided: every note waits.
  const undecided = normalizeRecord({ source: 'S', count: 1, status: 'new', needs: [{ text: 'x', at: '2026-10-09T00:00:00.000Z', public: true }] });
  assert.equal(undecided.needs[0].review, 'pending');
  // Accepting it now approves none of them either.
  const accepted = withStatus({ source: 'S', count: 1, status: 'new', needs: [{ text: 'x', at: '2026-10-09T00:00:00.000Z', public: true }] }, 'accepted');
  assert.deepEqual(publicView('request:abcdef012345aaaa', accepted).notes, []);
});

test('POST /api/requests gives the count only when the request is public', async () => {
  const kv = fakeKV();
  const first = await addRequest({ body: { source: 'Zoning map layers', need: 'a' }, kv, visitor: 'v' });
  const second = await addRequest({ body: { source: 'Zoning map layers', need: 'b' }, kv, visitor: 'w' });
  assert.deepEqual(raiseResponse(first), { ok: true });
  assert.deepEqual(raiseResponse(second), { ok: true }, 'a request awaiting review gives no count');
  const [r] = await allRequests(kv);
  await decide(kv, { id: r.id, status: 'accepted' });
  assert.deepEqual(raiseResponse(await addRequest({ body: { source: 'Zoning map layers' }, kv, visitor: 'x' })), { ok: true, count: 3 });
  await decide(kv, { id: r.id, status: 'declined' });
  assert.deepEqual(raiseResponse(await addRequest({ body: { source: 'Zoning map layers' }, kv, visitor: 'y' })), { ok: true });
  const { readFileSync } = await import('node:fs');
  const ui = readFileSync(new URL('../worker/ui.html', import.meta.url), 'utf8');
  assert.match(ui, /typeof data\.count === 'number' && data\.count > 1/, 'the page shows a count only when given one');
  const index = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  assert.match(index, /json\(raiseResponse\(out\)/);
});

test('a request that was public and no longer is appears as withdrawn, with a day only', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Accepted then declined' }, kv, visitor: 'v' });
  await addRequest({ body: { source: 'Declined while new' }, kv, visitor: 'v' });
  const rows = await allRequests(kv);
  const a = rows.find((x) => x.source === 'Accepted then declined');
  const b = rows.find((x) => x.source === 'Declined while new');
  await decide(kv, { id: a.id, status: 'accepted' }, at('2026-11-01T10:00:00Z'));
  await decide(kv, { id: b.id, status: 'declined', note: 'Not a public source.' }, at('2026-11-01T10:00:00Z'));
  const view = at('2026-11-06T00:00:00Z');
  let feed = await publicRequests(kv, view);
  assert.deepEqual(feed.withdrawn, []);
  await decide(kv, { id: a.id, status: 'declined' }, at('2026-11-03T18:30:00Z'));
  feed = await publicRequests(kv, view);
  assert.deepEqual(feed.requests, []);
  assert.deepEqual(feed.withdrawn, [{ id: a.id, day: '2026-11-03' }], 'never-public requests are not listed');
  assert.ok(!JSON.stringify(feed.withdrawn).includes('Accepted then declined'));
  // Reopened, it is public again and no longer withdrawn.
  await decide(kv, { id: a.id, status: 'accepted' }, at('2026-11-04T00:00:00Z'));
  feed = await publicRequests(kv, view);
  assert.equal(feed.requests[0].id, a.id);
  assert.deepEqual(feed.withdrawn, []);
  // Set back to new, it is withdrawn too.
  await decide(kv, { id: a.id, status: 'new' }, at('2026-11-05T00:00:00Z'));
  assert.deepEqual((await publicRequests(kv, view)).withdrawn, [{ id: a.id, day: '2026-11-05' }]);
  // Listed for WITHDRAWN_DAYS, then dropped from the feed.
  assert.deepEqual((await publicRequests(kv, at('2026-12-05T00:00:00Z'))).withdrawn, [{ id: a.id, day: '2026-11-05' }]);
  assert.deepEqual((await publicRequests(kv, at('2026-12-06T00:00:00Z'))).withdrawn, []);
});

test('legacy: a request accepted before was_public existed is withdrawn when declined', async () => {
  const kv = fakeKV();
  const key = await requestKey('Old accepted source');
  await kv.put(key, JSON.stringify({ source: 'Old accepted source', url: '', count: 1, first: '2026-10-01T00:00:00.000Z', last: '2026-10-01T00:00:00.000Z', status: 'accepted', decided: '2026-10-02T00:00:00.000Z', needs: [] }));
  assert.deepEqual((await publicRequests(kv, at('2026-11-06T00:00:00Z'))).withdrawn, []);
  assert.ok((await decide(kv, { id: publicId(key), status: 'declined' }, at('2026-11-06T00:00:00Z'))).ok);
  assert.deepEqual((await publicRequests(kv, at('2026-11-07T00:00:00Z'))).withdrawn, [{ id: publicId(key), day: '2026-11-06' }]);
});

test('the plan closes withdrawn issues with a fixed body and title', () => {
  const p = plan(
    [{ id: 'aaaaaaaaaaaa', source: 'Still public', count: 1, status: 'accepted', notes: [] }],
    'https://x/requests',
    'o/r',
    [{ id: 'bbbbbbbbbbbb', day: '2026-11-03' }, { id: 'aaaaaaaaaaaa', day: '2026-11-01' }, { id: 'not-an-id', day: '2026-11-03' }, { id: 'cccccccccccc', day: '<b>x</b>' }]
  );
  assert.deepEqual(p.map((x) => [x.id, x.state, x.state_reason]), [['aaaaaaaaaaaa', 'open', undefined], ['bbbbbbbbbbbb', 'closed', 'not_planned'], ['cccccccccccc', 'closed', 'not_planned']]);
  assert.equal(p[1].body, '<!-- source-request:bbbbbbbbbbbb -->\nRemoved from the public request list by a steward on 2026-11-03.');
  assert.equal(p[1].title, 'Source request (withdrawn)', 'no id in the title');
  assert.ok(p.slice(1).every((x) => x.create_if_missing === false && x.state_reason === 'not_planned'), 'plan consumers must not create withdrawn entries');
  assert.equal(p[0].create_if_missing, undefined);
  assert.equal(p[2].body, '<!-- source-request:cccccccccccc -->\nRemoved from the public request list.', 'a malformed day is dropped, not copied');
  assert.equal(plan([{ id: 'abc123def456', source: 'S', count: 2, status: 'fulfilled', notes: [] }], 'u', 'o/r')[0].state_reason, 'completed');
  assert.equal(plan([], 'u', 'o/r').length, 0, 'no withdrawn list, nothing to close');
});

test('applying directly: create, update, close withdrawn, close unlisted, leave the rest', () => {
  const live = { id: 'aaaaaaaaaaaa', source: 'Live source', count: 3, status: 'accepted', notes: ['approved note'] };
  const existing = [
    { number: 1, state: 'open', title: 'Source request: Live source', body: '<!-- source-request:aaaaaaaaaaaa -->\nold body' },
    { number: 2, state: 'open', title: 'Source request: Withdrawn one', body: '<!-- source-request:bbbbbbbbbbbb -->\nPeople wanted to know about 810 Union St' },
    { number: 3, state: 'open', title: 'Source request: Deleted one', body: '<!-- source-request:cccccccccccc -->\nsome words' },
    { number: 4, state: 'open', title: 'A hand-made issue with the label', body: 'no marker here' },
    { number: 5, state: 'open', title: 'A PR', body: '<!-- source-request:dddddddddddd -->', pull_request: {} },
  ];
  const withdrawn = [{ id: 'bbbbbbbbbbbb', day: '2026-11-03' }, { id: 'eeeeeeeeeeee', day: '2026-11-03' }];
  const ops = operations({ existing, requests: [live, { id: 'ffffffffffff', source: 'New one', count: 1, status: 'accepted', notes: [] }], withdrawn, pageUrl: 'https://x/requests', repo: 'o/r' });
  const byNumber = Object.fromEntries(ops.filter((o) => o.op === 'update').map((o) => [o.number, o.patch]));
  assert.ok(byNumber[1].body.includes('approved note'));
  assert.equal(byNumber[1].state, undefined);
  assert.deepEqual(byNumber[2], { body: withdrawnBody('bbbbbbbbbbbb', '2026-11-03'), title: 'Source request (withdrawn)', state: 'closed', state_reason: 'not_planned' });
  assert.deepEqual(byNumber[3], { body: withdrawnBody('cccccccccccc'), title: 'Source request (withdrawn)', state: 'closed', state_reason: 'not_planned' }, 'marker in neither list');
  assert.equal(byNumber[4], undefined, 'an issue without a marker is left alone');
  assert.equal(byNumber[5], undefined, 'pull requests are left alone');
  const creates = ops.filter((o) => o.op === 'create');
  assert.deepEqual(creates.map((o) => o.title), ['Source request: New one'], 'a withdrawn request with no issue is not created');
  assert.ok(!JSON.stringify(byNumber[2]).includes('Union'));

  // Applying the result again changes nothing.
  const after = existing.map((i) => ({ ...i, ...(byNumber[i.number] || {}) }));
  after.push({ number: 6, state: 'open', ...creates[0] });
  assert.deepEqual(operations({ existing: after, requests: [live, { id: 'ffffffffffff', source: 'New one', count: 1, status: 'accepted', notes: [] }], withdrawn, pageUrl: 'https://x/requests', repo: 'o/r' }), []);
});

test('applying directly: no withdrawn list in the feed closes nothing unlisted; a reaccepted request reopens', () => {
  const existing = [
    { number: 3, state: 'open', title: 't', body: '<!-- source-request:cccccccccccc -->\nsome words' },
    { number: 7, state: 'closed', title: 'Source request (withdrawn)', body: withdrawnBody('aaaaaaaaaaaa', '2026-11-03') },
  ];
  const ops = operations({ existing, requests: [{ id: 'aaaaaaaaaaaa', source: 'Back again', count: 2, status: 'accepted', notes: [] }], withdrawn: undefined, pageUrl: 'u', repo: 'o/r' });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].number, 7);
  assert.equal(ops[0].patch.state, 'open');
  assert.equal(ops[0].patch.title, 'Source request: Back again');
  assert.deepEqual(operations({ existing, requests: [], withdrawn: undefined, pageUrl: 'u', repo: 'o/r' }), []);
});

// --- Review fixes: legacy declines, stale raises, trimming, no word on
// unreviewed requests, decision days, and the plan's create_if_missing.

import { trimNotes, deletedKey } from '../worker/requests.js';
import { UNLISTED_LIMIT } from '../scripts/sync-request-issues.js';

test('legacy: notes before a decline (or a reset to new) stay pending when the request is accepted later', () => {
  const note = { text: 'note naming Jane Doe at 12 Elm St', at: '2026-11-01T00:00:00Z', public: true };
  for (const status of ['declined', 'new']) {
    const legacy = { source: 'S', count: 1, status, decided: '2026-11-02T00:00:00Z', needs: [note] };
    assert.equal(normalizeRecord(legacy).needs[0].review, 'pending', status);
    const accepted = withStatus(legacy, 'accepted', {}, at('2026-11-06T00:00:00Z'));
    assert.equal(accepted.needs[0].review, 'pending', status);
    assert.deepEqual(publicView('request:abcdef012345aaaa', accepted).notes, [], status);
  }
  // Fulfilled counts as public, like accepted.
  const done = normalizeRecord({ source: 'S', count: 1, status: 'fulfilled', decided: '2026-11-02T00:00:00Z', needs: [note] });
  assert.equal(done.needs[0].review, 'ok');
});

// A KV whose reads of one key return a snapshot taken earlier, as a read at
// another location can within KV's propagation window.
function staleKV(kv, staleKeys) {
  const snap = new Map(staleKeys.map((k) => [k, kv.store.get(k)]));
  return {
    ...kv,
    async get(k, type) {
      if (!snap.has(k)) return kv.get(k, type);
      const v = snap.get(k);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
  };
}

test('a stale raise cannot bring a deleted note back', async () => {
  for (const staleTombstone of [false, true]) {
    const kv = fakeKV();
    await addRequest({ body: { source: 'Tree permits', need: 'names a person', public: true }, kv, visitor: 'v' });
    const [r] = await allRequests(kv);
    const key = await requestKey('Tree permits');
    await decide(kv, { id: r.id, status: 'accepted' });
    await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'approve' });
    assert.deepEqual((await publicRequests(kv)).requests[0].notes, ['names a person']);
    // A raise elsewhere reads the record (and maybe the tombstone) before the delete lands.
    const stale = staleKV(kv, staleTombstone ? [key, deletedKey(key)] : [key]);
    assert.ok((await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'delete' })).ok);
    assert.deepEqual((await publicRequests(kv)).requests[0].notes, []);
    await addRequest({ body: { source: 'Tree permits', need: 'later', public: true }, kv: stale, visitor: 'w' });
    const feed = await publicRequests(kv);
    assert.deepEqual(feed.requests[0].notes, [], `deleted note stays gone (stale tombstone: ${staleTombstone})`);
    assert.ok(!(await allRequests(kv))[0].needs.some((n) => n.text === 'names a person'), 'the steward does not see it again either');
    // The next raise that reads the tombstone drops it from storage too.
    await addRequest({ body: { source: 'Tree permits' }, kv, visitor: 'x' });
    assert.ok(!kv.store.get(key).includes('names a person'));
  }
});

test('a run of new notes cannot push approved notes off an accepted request', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Canopy survey', need: 'approved question', public: true }, kv, visitor: 'v' });
  const [r] = await allRequests(kv);
  await decide(kv, { id: r.id, status: 'accepted' });
  await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'approve' });
  for (let i = 0; i < 20; i++) await addRequest({ body: { source: 'Canopy survey', need: `junk ${i}`, public: true }, kv, visitor: 'spam' });
  assert.deepEqual((await publicRequests(kv)).requests[0].notes, ['approved question']);
  const needs = (await allRequests(kv))[0].needs;
  assert.equal(needs.filter((n) => n.review !== 'ok').length, 10, 'the newest pending notes are kept for review');
  assert.equal(needs.at(-1).text, 'junk 19');
  // Trimming keeps order, and keeps approved notes up to the total.
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, review: i % 2 ? 'ok' : 'pending' }));
  const kept = trimNotes(many);
  assert.ok(kept.length <= 20);
  assert.deepEqual(kept, [...kept].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))));
});

test('the public feed carries nothing about unreviewed requests, so a raise cannot tell whether someone asked already', async () => {
  const kv = fakeKV();
  const day = at('2026-11-06T09:00:00Z');
  await addRequest({ body: { source: 'Police records for 12 Elm St' }, kv, visitor: 'victim', now: day - 86400000 });
  const before = JSON.stringify(await publicRequests(kv, day));
  await addRequest({ body: { source: 'Police records for 12 Elm St' }, kv, visitor: 'prober', now: day + 1000 });
  assert.equal(JSON.stringify(await publicRequests(kv, day + 2000)), before);
  await addRequest({ body: { source: 'A fresh source' }, kv, visitor: 'prober', now: day + 3000 });
  assert.equal(JSON.stringify(await publicRequests(kv, day + 4000)), before, 'a fresh source does not change it either');
  assert.equal(JSON.stringify(await publicRequests(kv, at('2026-11-08T00:00:01Z'))), before, 'nor does a day passing');
  assert.deepEqual(Object.keys(JSON.parse(before)).sort(), ['requests', 'withdrawn']);
});

test('a decision is stored as a day', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Decided source', need: 'q', public: true }, kv, visitor: 'v' });
  const [r] = await allRequests(kv);
  await decide(kv, { id: r.id, status: 'accepted' }, at('2026-11-06T14:15:16.789Z'));
  const raw = await kv.get(await requestKey('Decided source'), 'json');
  assert.equal(raw.decided, '2026-11-06');
  assert.ok(!ISO_TIME.test(JSON.stringify(raw)), 'no time of day anywhere in the record');
  assert.equal((await allRequests(kv))[0].decided, '2026-11-06');
});

test('applying directly refuses to close every issue, or many, unless told to', () => {
  const issue = (n, id, state = 'open') => ({ number: n, state, title: 't', body: `<!-- source-request:${id} -->\nwords` });
  const two = [issue(1, 'aaaaaaaaaaaa'), issue(2, 'bbbbbbbbbbbb')];
  assert.throws(() => operations({ existing: two, requests: [], withdrawn: [], pageUrl: 'u', repo: 'o/r' }), /Refusing to close 2 of 2/);
  assert.equal(operations({ existing: two, requests: [], withdrawn: [], pageUrl: 'u', repo: 'o/r', closeUnlisted: true }).length, 2);
  const many = Array.from({ length: UNLISTED_LIMIT + 2 }, (_, i) => issue(i + 1, String(i).padStart(12, 'a')));
  const live = { id: 'ffffffffffff', source: 'Live', count: 1, status: 'accepted', notes: [] };
  assert.throws(() => operations({ existing: [...many, issue(99, 'ffffffffffff')], requests: [live], withdrawn: [], pageUrl: 'u', repo: 'o/r' }), /Refusing/);
  // One stray issue beside a listed one is closed without asking.
  const ops = operations({ existing: [issue(1, 'aaaaaaaaaaaa'), issue(99, 'ffffffffffff')], requests: [live], withdrawn: [], pageUrl: 'u', repo: 'o/r' });
  assert.equal(ops.find((o) => o.number === 1).patch.state_reason, 'not_planned');
  // Closed issues count too: an empty feed doesn't blank fulfilled ones.
  assert.throws(() => operations({ existing: [issue(1, 'aaaaaaaaaaaa', 'closed')], requests: [], withdrawn: [], pageUrl: 'u', repo: 'o/r' }), /Refusing to close 1 of 1/);
  // Issues already in the withdrawn shape don't count.
  const done = { number: 1, state: 'closed', title: 'Source request (withdrawn)', body: withdrawnBody('aaaaaaaaaaaa') };
  assert.deepEqual(operations({ existing: [done], requests: [], withdrawn: [], pageUrl: 'u', repo: 'o/r' }), []);
});

test('the steward page counts only public notes as needing review', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../worker/admin.html', import.meta.url), 'utf8');
  const line = html.match(/^const pending = .*;$/m)[0];
  const pending = new Function(`${line}; return pending;`)();
  const r = { needs: [{ public: false, review: 'pending' }, { public: true, review: 'pending' }, { public: true, review: 'ok' }] };
  assert.equal(pending(r).length, 1);
  assert.match(html, /delete the GitHub issue by hand/);
});

// --- Second review: no writes on the public read, decisions that stale raises
// can't undo, the legacy five, steward deletes that add up, and the plan's
// two contracts.

import { decisionKey } from '../worker/requests.js';

test('the public feed never writes to KV, so a KV out of writes still serves it', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Tree canopy layer', need: 'q', public: true }, kv, visitor: 'v', now: at('2026-11-05T10:00:00Z') });
  const [r] = await allRequests(kv);
  await decide(kv, { id: r.id, status: 'accepted' }, at('2026-11-05T11:00:00Z'));
  await addRequest({ body: { source: 'Another source' }, kv, visitor: 'v', now: at('2026-11-05T12:00:00Z') });
  let puts = 0;
  const full = { ...kv, async put() { puts++; throw new Error('KV put failed: 429 Too Many Requests'); } };
  const feed = await publicRequests(full, at('2026-11-06T09:00:00Z'));
  assert.equal(feed.requests.length, 1);
  assert.equal(puts, 0, 'no write at all');
  assert.ok(![...kv.store.keys()].some((k) => k === 'request-stats'));
});

test('the public page shows no count of requests awaiting review', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../worker/requests.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /awaiting_review/);
  assert.match(html, /Requests appear here after a steward reviews them\./);
});

test('a stale raise cannot undo a decline: the request stays withdrawn', async () => {
  for (const staleDecision of [false, true]) {
    const kv = fakeKV();
    await addRequest({ body: { source: 'Records about 12 Elm St owner', need: 'q', public: true }, kv, visitor: 'v' });
    const [r] = await allRequests(kv);
    const key = await requestKey('Records about 12 Elm St owner');
    await decide(kv, { id: r.id, status: 'accepted', note: 'ok' }, at('2026-11-05T10:00:00Z'));
    await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'approve' });
    // A raise elsewhere read the record (and maybe the decision) before the decline landed.
    const stale = staleKV(kv, staleDecision ? [key, decisionKey(key)] : [key]);
    await decide(kv, { id: r.id, status: 'declined' }, at('2026-11-06T10:00:00Z'));
    await addRequest({ body: { source: 'Records about 12 Elm St owner', need: 'later', public: true }, kv: stale, visitor: 'w' });
    assert.equal(JSON.parse(kv.store.get(key)).status, staleDecision ? 'accepted' : 'declined', 'the record itself may carry the stale status');
    const feed = await publicRequests(kv, at('2026-11-06T12:00:00Z'));
    assert.deepEqual(feed.requests, [], `still off the list (stale decision read: ${staleDecision})`);
    assert.deepEqual(feed.withdrawn, [{ id: r.id, day: '2026-11-06' }]);
    const admin = (await allRequests(kv))[0];
    assert.equal(admin.status, 'declined');
    assert.equal(admin.steward_note, 'ok');
    assert.deepEqual(raiseResponse(await addRequest({ body: { source: 'Records about 12 Elm St owner' }, kv, visitor: 'x' })), { ok: true }, 'no count for a declined request');
  }
});

test('a cleared steward note stays cleared, even under an older record', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Budget PDF' }, kv, visitor: 'v' });
  const [r] = await allRequests(kv);
  const key = await requestKey('Budget PDF');
  await decide(kv, { id: r.id, status: 'accepted', note: 'first note' });
  const stale = staleKV(kv, [key]);
  await decide(kv, { id: r.id, status: 'accepted', note: '' });
  await addRequest({ body: { source: 'Budget PDF' }, kv: stale, visitor: 'w' });
  assert.equal((await publicRequests(kv)).requests[0].steward_note, undefined);
});

test('legacy: only notes the old list showed (the last five public) count as reviewed', async () => {
  const kv = fakeKV();
  const key = await requestKey('Legacy eight');
  const needs = Array.from({ length: 8 }, (_, i) => ({ text: `n${i + 1}`, at: `2026-10-0${i + 1}T00:00:00.000Z`, public: true }));
  // Decided between n5 and n6: the old list showed n4..n8.
  await kv.put(key, JSON.stringify({ source: 'Legacy eight', url: '', count: 8, first: '2026-10-01', last: '2026-10-08', status: 'accepted', decided: '2026-10-05T12:00:00.000Z', needs }));
  const feed = await publicRequests(kv);
  assert.deepEqual(feed.requests[0].notes, ['n4', 'n5'], 'n1 to n3 were never published, and n6 to n8 came after the decision');
  assert.deepEqual((await allRequests(kv))[0].needs.map((n) => n.review), ['pending', 'pending', 'pending', 'ok', 'ok', 'pending', 'pending', 'pending']);
});

test('steward deletes add up even when the tombstone read is stale', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'Permit notes', need: 'names Jane Doe', public: true }, kv, visitor: 'v' });
  await addRequest({ body: { source: 'Permit notes', need: 'second note', public: true }, kv, visitor: 'w' });
  const [r] = await allRequests(kv);
  const key = await requestKey('Permit notes');
  await decide(kv, { id: r.id, status: 'accepted' });
  for (const n of r.needs) await reviewNote(kv, { id: r.id, note: n.id, action: 'approve' });
  const stale = staleKV(kv, [key, deletedKey(key)]);
  assert.ok((await reviewNote(kv, { id: r.id, note: r.needs[0].id, action: 'delete' })).ok);
  // The second delete reads both keys stale, but sends what this page already deleted.
  assert.ok((await reviewNote(stale, { id: r.id, note: r.needs[1].id, action: 'delete', deleted: [r.needs[0].id, 'BAD ID!', 7] })).ok);
  assert.deepEqual((await publicRequests(kv)).requests[0].notes, []);
  assert.deepEqual(JSON.parse(kv.store.get(deletedKey(key))).sort(), [r.needs[0].id, r.needs[1].id].sort(), 'only valid note ids are kept');
});

test('a closed issue is re-closed when the reason changes (fulfilled, then withdrawn)', () => {
  const withdrawn = [{ id: 'aaaaaaaaaaaa', day: '2026-11-06' }];
  const issue = { number: 1, state: 'closed', state_reason: 'completed', title: 'Source request (withdrawn)', body: withdrawnBody('aaaaaaaaaaaa', '2026-11-06') };
  const ops = operations({ existing: [issue], requests: [], withdrawn, pageUrl: 'u', repo: 'o/r' });
  assert.deepEqual(ops, [{ op: 'update', number: 1, patch: { state: 'closed', state_reason: 'not_planned' } }]);
  assert.deepEqual(operations({ existing: [{ ...issue, state_reason: 'not_planned' }], requests: [], withdrawn, pageUrl: 'u', repo: 'o/r' }), [], 'then nothing');
  // And a fulfilled request whose issue was closed as not planned.
  const done = { id: 'bbbbbbbbbbbb', source: 'Done', count: 1, status: 'fulfilled', notes: [] };
  const [want] = plan([done], 'u', 'o/r');
  const ops2 = operations({ existing: [{ number: 2, state: 'closed', state_reason: 'not_planned', title: want.title, body: want.body }], requests: [done], withdrawn: [], pageUrl: 'u', repo: 'o/r' });
  assert.deepEqual(ops2, [{ op: 'update', number: 2, patch: { state: 'closed', state_reason: 'completed' } }]);
});

test('a note that could go public is checked before anything is written, and the refusal never repeats it', async () => {
  const kv = fakeKV();
  const out = await addRequest({ body: { source: 'Norfolk tree ordinance', need: 'Is the oak at 1500 Bolling Ave protected? Call 757-664-4253', public: true }, kv, visitor: 'v', streets: ['BOLLING'] });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.error, /house numbers/);
  assert.doesNotMatch(out.error, /Bolling|1500|757/);
  assert.equal(kv.store.size, 0, 'no rate key, no record');
  const ok = await addRequest({ body: { source: 'Norfolk tree ordinance', need: 'Are street trees protected citywide?', public: true }, kv, visitor: 'v', streets: ['BOLLING'] });
  assert.equal(ok.ok, true);
  assert.equal((await addRequest({ body: { source: 'Norfolk tree ordinance', need: '1500 BOLLING?' }, kv, visitor: 'v', streets: ['BOLLING'] })).ok, false, 'a number before a street name');
  assert.equal((await addRequest({ body: { source: 'Norfolk tree ordinance' }, kv, visitor: 'v' })).ok, true, 'no note, nothing to check');
});

test('the admin page and the contributor guide promise a closed issue only once the sync runs with --with-withdrawn', async () => {
  const { readFileSync } = await import('node:fs');
  const admin = readFileSync(new URL('../worker/admin.html', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../docs/fulfilling-requests.md', import.meta.url), 'utf8');
  const routine = readFileSync(new URL('../docs/request-sync-routine.md', import.meta.url), 'utf8');
  for (const text of [admin, guide]) {
    assert.doesNotMatch(text, /closes its GitHub issue at the next sync|the next sync\s+closes its issue/);
    assert.match(text, /Once the nightly sync runs with `?--with-withdrawn`?|once the nightly sync runs with `--with-withdrawn`/i);
  }
  // The routine doc carries the exact replacement prompt and the merge step.
  assert.match(routine, /## Merge step: update the routine \(Jason only\)/);
  assert.match(routine, /sync-request-issues\.js --plan --with-withdrawn > \/tmp\/plan\.json/);
  assert.match(routine, /create_if_missing: false, do nothing \(never create it\)/);
});

test('an issue withdrawn long enough ago to leave the feed is done: no rewrite, and it does not count toward the refusal', async () => {
  const { isWithdrawnDone } = await import('../scripts/sync-request-issues.js');
  const ids = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc', 'dddddddddddd', 'eeeeeeeeeeee'];
  // Closed by earlier syncs while the feed listed them, so their bodies carry the day.
  const done = ids.map((id, i) => ({ number: i + 1, state: 'closed', state_reason: 'not_planned', title: 'Source request (withdrawn)', body: withdrawnBody(id, '2026-10-01') }));
  const live = { id: 'ffffffffffff', source: 'Live', count: 1, status: 'accepted', notes: [] };
  const [want] = plan([live], 'u', 'o/r');
  const liveIssue = { number: 9, state: 'open', title: want.title, body: want.body };
  // 30 days on, the feed no longer lists them: more than UNLISTED_LIMIT, and once every one of them.
  assert.deepEqual(operations({ existing: [...done, liveIssue], requests: [live], withdrawn: [], pageUrl: 'u', repo: 'o/r' }), []);
  assert.deepEqual(operations({ existing: done, requests: [], withdrawn: [], pageUrl: 'u', repo: 'o/r' }), []);
  // GitHub may hand bodies back with CRLF line ends.
  assert.ok(isWithdrawnDone({ ...done[0], body: done[0].body.replace(/\n/g, '\r\n') }, ids[0]));
  // Done issues don't dilute the refusal either: one open unlisted issue among them is still "all of them".
  const stray = { number: 20, state: 'open', title: 't', body: '<!-- source-request:111111111111 -->\nwords' };
  assert.throws(() => operations({ existing: [...done, stray], requests: [], withdrawn: [], pageUrl: 'u', repo: 'o/r' }), /Refusing to close 1 of 1/);
  // Not done: open, closed as completed, another title, or a body edited by hand.
  for (const changed of [{ state: 'open' }, { state_reason: 'completed' }, { title: 'Source request: Tree permits' }, { body: `${done[0].body}\nedited` }]) {
    assert.equal(isWithdrawnDone({ ...done[0], ...changed }, ids[0]), false, JSON.stringify(changed));
  }
  assert.equal(isWithdrawnDone(done[0], ids[1]), false, 'the body must be for its own id');
  const ops = operations({ existing: [{ ...done[0], body: `${done[0].body}\nedited` }, liveIssue], requests: [live], withdrawn: [], pageUrl: 'u', repo: 'o/r' });
  assert.deepEqual(ops, [{ op: 'update', number: 1, patch: { body: withdrawnBody(ids[0]) } }]);
});
