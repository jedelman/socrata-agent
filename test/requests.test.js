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
  await addRequest({ body: { source: 'Norfolk City Code, Chapter 45', need: 'An old note, sent before requests were public' }, kv, visitor: 'v1' });
  await addRequest({ body: { source: 'Norfolk City Code, Chapter 45', need: 'Are Ghent trees protected?', public: true }, kv, visitor: 'v2' });
  await addRequest({ body: { source: 'ARB historic district guidelines', need: 'Front-yard trees?', public: true }, kv, visitor: 'v3' });
  let list = await publicRequests(kv);
  assert.deepEqual(list.requests, []);
  assert.equal(list.awaiting_review, 2);

  const key = await requestKey('Norfolk City Code, Chapter 45');
  await kv.put(key, JSON.stringify(withStatus(await kv.get(key, 'json'), 'accepted', { steward_note: 'Municode is behind a bot challenge; a copy we can re-check is needed.' })));
  list = await publicRequests(kv);
  assert.equal(list.requests.length, 1);
  assert.equal(list.awaiting_review, 1);
  const r = list.requests[0];
  assert.equal(r.id, publicId(key));
  assert.equal(r.count, 2);
  assert.deepEqual(r.notes, ['Are Ghent trees protected?'], 'only notes written under the public notice');
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

import { decide, allRequests } from '../worker/requests.js';
import { isAdmin, userId } from '../worker/accounts.js';
import { plan } from '../scripts/sync-request-issues.js';

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

test('endorsement and Bluesky keys never collide with request: keys', async () => {
  const kv = fakeKV();
  await addRequest({ body: { source: 'ARB guidelines' }, kv, visitor: 'v' });
  const [r] = await allRequests(kv);
  // Values that would break JSON.parse if anything read them as requests.
  await kv.put(`endorsement:${r.id}:${'a'.repeat(32)}`, '1');
  await kv.put(`endorse-ev:2026-11-06:d:${'b'.repeat(32)}:x`, '');
  await kv.put(`bsky-ev:2026-11-06T12:v:${'c'.repeat(32)}:x`, '');
  await kv.put(`bsky-flow-used:${'d'.repeat(32)}`, '1');
  assert.equal((await allRequests(kv)).length, 1);
  assert.equal((await publicRequests(kv)).awaiting_review, 1);
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
