// The request routes through the Worker's own fetch handler, and the issue
// sync's command line with a stubbed fetch. The Worker imports .html and
// .json files the way Wrangler bundles them, so this file loads them through
// a module hook; where node:module has no registerHooks, those tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signUser, userId, USER_COOKIE } from '../worker/accounts.js';
import { main as syncMain } from '../scripts/sync-request-issues.js';

const canHook = typeof nodeModule.registerHooks === 'function';
let worker;
async function loadWorker() {
  if (worker) return worker;
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && url.endsWith('.html')) {
        return { format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true };
      }
      if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  worker = (await import('../worker/index.js')).default;
  return worker;
}

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
    async delete(k) {
      store.delete(k);
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

const SECRET = 'test-secret-that-is-long-enough';
const env = () => ({ LIMITS: fakeKV(), INVITE_SECRET: SECRET, IP_SALT: 'salt', ADMIN_EMAILS: 'steward@example.org' });
const post = (path, body, headers = {}) =>
  new Request(`https://x.org${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers }, body: JSON.stringify(body) });
const cookieFor = async (email) => ({ Cookie: `${USER_COOKIE}=${await signUser(SECRET, await userId(SECRET, email))}` });

test('the steward routes refuse anyone who is not a signed-in steward', { skip: !canHook && 'node:module has no registerHooks' }, async () => {
  const w = await loadWorker();
  const e = env();
  const raised = await w.fetch(post('/api/requests', { source: 'Tree inventory', need: 'q', public: true }), e, {});
  assert.deepEqual(await raised.json(), { ok: true }, 'a raise answers exactly {ok: true} while awaiting review');
  const [listed] = (await (await w.fetch(new Request('https://x.org/api/admin/requests', { headers: await cookieFor('steward@example.org') }), e, {})).json()).requests;
  const { id } = listed;
  const note = listed.needs[0].id;
  const body = { id, note, action: 'approve' };
  assert.equal((await w.fetch(post('/api/admin/requests/note', body), e, {})).status, 401);
  assert.equal((await w.fetch(post('/api/admin/requests/note', body, await cookieFor('someone@example.org')), e, {})).status, 403);
  assert.equal((await w.fetch(post('/api/admin/requests/decide', { id, status: 'accepted' }, await cookieFor('someone@example.org')), e, {})).status, 403);
  assert.equal((await w.fetch(new Request('https://x.org/api/admin/requests'), e, {})).status, 401);
  const ok = await w.fetch(post('/api/admin/requests/note', body, await cookieFor('steward@example.org')), e, {});
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).needs[0].review, 'ok');
  assert.equal((await w.fetch(post('/api/admin/requests/decide', { id, status: 'accepted' }, await cookieFor('steward@example.org')), e, {})).status, 200);
  const again = await w.fetch(post('/api/requests', { source: 'Tree inventory' }, { 'CF-Connecting-IP': '203.0.113.10' }), e, {});
  assert.deepEqual(await again.json(), { ok: true, count: 2 }, 'the count only once public');
  const feed = await (await w.fetch(new Request('https://x.org/api/requests'), e, {})).json();
  assert.deepEqual(feed.requests[0].notes, ['q']);
  assert.ok(Array.isArray(feed.withdrawn));
});

test('GET /api/requests on a site without storage carries no withdrawn list', { skip: !canHook && 'node:module has no registerHooks' }, async () => {
  const w = await loadWorker();
  const res = await w.fetch(new Request('https://x.org/api/requests'), {}, {});
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.requests, []);
  assert.ok(!('withdrawn' in body), 'so a direct sync against it closes nothing');
});

const feedFetch = (feed, { status = 200 } = {}) => async (url) => {
  if (String(url).startsWith('https://feed')) return new Response(JSON.stringify(feed), { status });
  if (String(url).includes('/issues?')) return new Response('[]', { status: 200 });
  return new Response('{}', { status: 201 });
};
const syncEnv = { REQUESTS_URL: 'https://feed.example/api/requests', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'x' };

test('the sync refuses a feed that failed or has no requests list', async () => {
  await assert.rejects(syncMain({ argv: ['--plan'], env: syncEnv, fetchImpl: feedFetch({}, { status: 503 }), log: () => {} }), /answered 503; nothing was synced/);
  await assert.rejects(syncMain({ argv: ['--plan'], env: syncEnv, fetchImpl: feedFetch({ error: 'x' }), log: () => {} }), /no requests list/);
  await assert.rejects(syncMain({ argv: [], env: {}, fetchImpl: feedFetch({}), log: () => {} }), /Set REQUESTS_URL/);
});

test('--plan --with-withdrawn prints withdrawn entries only when the feed lists them, marked never to be created', async () => {
  const req = { id: 'aaaaaaaaaaaa', source: 'S', count: 1, status: 'accepted', notes: [] };
  let out = '';
  await syncMain({ argv: ['--plan', '--with-withdrawn'], env: syncEnv, fetchImpl: feedFetch({ requests: [req] }), log: (s) => (out = s) });
  assert.deepEqual(JSON.parse(out).map((x) => x.id), ['aaaaaaaaaaaa']);
  await syncMain({ argv: ['--plan', '--with-withdrawn'], env: syncEnv, fetchImpl: feedFetch({ requests: [req], withdrawn: [{ id: 'bbbbbbbbbbbb', day: '2026-11-03' }] }), log: (s) => (out = s) });
  const p = JSON.parse(out);
  assert.deepEqual(p.map((x) => x.id), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.equal(p[1].create_if_missing, false);
  assert.equal(p[1].state_reason, 'not_planned');
  assert.equal(p[1].title, 'Source request (withdrawn)');
});

test('applying directly against an empty feed writes nothing to GitHub', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method || 'GET', String(url)]);
    if (String(url).startsWith('https://feed')) return new Response(JSON.stringify({ requests: [], withdrawn: [] }));
    if (String(url).includes('/issues?')) return new Response(JSON.stringify([{ number: 1, state: 'open', title: 't', body: '<!-- source-request:aaaaaaaaaaaa -->' }]));
    return new Response('{}', { status: 201 });
  };
  await assert.rejects(syncMain({ argv: [], env: syncEnv, fetchImpl, log: () => {} }), /Refusing to close 1 of 1/);
  assert.ok(calls.every(([m]) => m === 'GET'), 'no label, no patch');
  calls.length = 0;
  await syncMain({ argv: ['--close-unlisted'], env: syncEnv, fetchImpl, log: () => {} });
  assert.ok(calls.some(([m, u]) => m === 'PATCH' && u.endsWith('/issues/1')));
});

test('plain --plan keeps its first contract: safe for a caller that creates every missing entry', async () => {
  const req = { id: 'aaaaaaaaaaaa', source: 'S', count: 1, status: 'accepted', notes: [] };
  let out = '';
  await syncMain({ argv: ['--plan'], env: syncEnv, fetchImpl: feedFetch({ requests: [req], withdrawn: [{ id: 'bbbbbbbbbbbb', day: '2026-11-03' }] }), log: (s) => (out = s) });
  const p = JSON.parse(out);
  // The routine's old rule: create every entry no issue matches; close every closed one as completed.
  const created = p.map((x) => x.id);
  assert.deepEqual(created, ['aaaaaaaaaaaa'], 'a withdrawn request never becomes a new issue');
  assert.ok(p.every((x) => x.create_if_missing === undefined && x.state === 'open'));
  assert.ok(!out.includes('bbbbbbbbbbbb'), 'nor does its id reach the plan');
});

test('a dry run with a token lists issues and previews closes and refusals, writing nothing', async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method || 'GET');
    if (String(url).startsWith('https://feed')) return new Response(JSON.stringify({ requests: [], withdrawn: [] }));
    if (String(url).includes('/issues?')) return new Response(JSON.stringify([{ number: 1, state: 'open', title: 't', body: '<!-- source-request:aaaaaaaaaaaa -->' }, { number: 2, state: 'open', title: 't', body: '<!-- source-request:bbbbbbbbbbbb -->' }]));
    return new Response('{}', { status: 201 });
  };
  await assert.rejects(syncMain({ argv: ['--dry-run'], env: syncEnv, fetchImpl, log: (s) => logs.push(s) }), /Refusing to close 2 of 2/);
  await syncMain({ argv: ['--dry-run', '--close-unlisted'], env: syncEnv, fetchImpl, log: (s) => logs.push(s) });
  assert.deepEqual(logs, ['update #1: body, title, state, state_reason', 'update #2: body, title, state, state_reason']);
  assert.ok(calls.every((m) => m === 'GET'), 'reads only');
});

// The fetch handler's JSON gate (isJson) runs before handleAdmin, so a same-site
// text/plain POST carrying the steward's SameSite=Lax cookie never reaches it.
test('steward writes refuse a body that is not JSON', { skip: !canHook && 'node:module has no registerHooks' }, async () => {
  const w = await loadWorker();
  const e = env();
  await w.fetch(post('/api/requests', { source: 'Tree inventory', need: 'q', public: true }), e, {});
  const [listed] = (await (await w.fetch(new Request('https://x.org/api/admin/requests', { headers: await cookieFor('steward@example.org') }), e, {})).json()).requests;
  const cookie = await cookieFor('steward@example.org');
  for (const path of ['/api/admin/requests/note', '/api/admin/requests/decide']) {
    const body = path.endsWith('note') ? { id: listed.id, note: listed.needs[0].id, action: 'approve' } : { id: listed.id, status: 'accepted' };
    const res = await w.fetch(new Request(`https://x.org${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...cookie }, body: JSON.stringify(body) }), e, {});
    assert.equal(res.status, 415, path);
  }
  const [after] = (await (await w.fetch(new Request('https://x.org/api/admin/requests', { headers: cookie }), e, {})).json()).requests;
  assert.equal(after.status, 'new');
  assert.equal(after.needs[0].review, 'pending');
});

test('the public feed is served from the cache, whatever the query string', { skip: !canHook && 'node:module has no registerHooks' }, async () => {
  const w = await loadWorker();
  const e = env();
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  globalThis.caches = { default: { async match(req) { return store.get(req.url)?.clone(); }, async put(req, res) { store.set(req.url, res); } } };
  try {
    let gets = 0;
    const kv = e.LIMITS;
    e.LIMITS = { ...kv, async get(...a) { gets++; return kv.get(...a); }, async list(...a) { gets++; return kv.list(...a); } };
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const first = await w.fetch(new Request('https://x.org/api/requests'), e, ctx);
    await Promise.all(waits);
    assert.equal(first.status, 200);
    const before = gets;
    const again = await w.fetch(new Request('https://x.org/api/requests?bust=1'), e, ctx);
    assert.deepEqual((await again.json()).requests, []);
    assert.equal(gets, before, 'no KV reads on a cache hit');
    assert.deepEqual([...store.keys()], ['https://x.org/api/requests']);
  } finally {
    if (had) Object.defineProperty(globalThis, 'caches', had);
    else delete globalThis.caches;
  }
});
