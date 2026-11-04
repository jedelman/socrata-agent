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
