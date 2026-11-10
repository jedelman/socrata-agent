// The requests page under its Content-Security-Policy, the assets it loads,
// the public-first copy matching what the code does, and the routes the old
// server-side model had, gone. Runs the Worker's own fetch handler through a
// module hook (as test/worker-requests.test.js does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countLine, itemHtml, endorsersHtml, esc } from '../worker/requests-page.js';
import { addRequest, decide, currentId } from '../worker/requests.js';
import { OAUTH_SCOPE, ENDORSE_NSID, buildEndorsement } from '../worker/endorse-config.js';
import { readyEnv, fakeNetwork, W } from './fake-atproto.js';

const canHook = typeof nodeModule.registerHooks === 'function';
const skip = !canHook && 'node:module has no registerHooks';
let worker;
async function loadWorker() {
  if (worker) return worker;
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && context.importAttributes?.type === 'text') {
        return { format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true };
      }
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

const ORIGIN = 'https://ask-siren.jason-edelman.org';
const BASE = '';
const get = async (w, env, path, init = {}) => w.fetch(new Request(`${ORIGIN}${BASE}${path}`, init), env, { waitUntil() {} });
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

async function withFetch(fn, impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('the page: a strict CSP, no inline script or style, and every asset it loads is served', { skip }, async () => {
  const w = await loadWorker();
  for (const env of [readyEnv({ BASE_PATH: BASE }), readyEnv({ BASE_PATH: BASE, BLUESKY_LOGIN: undefined })]) {
    const res = await get(w, env, '/requests');
    assert.equal(res.status, 200);
    const csp = res.headers.get('Content-Security-Policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    const html = await res.text();
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
    assert.ok(!/<style/.test(html) && !/\sstyle="/.test(html), 'no inline style');
    assert.ok(!/\son[a-z]+="/i.test(html), 'no inline handlers');
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'every placeholder filled');
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[0-9a-f]{16}\/[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(assets.map((a) => a.split('/').pop()).sort(), ['requests-page.js', 'requests.css']);
    // Every module the page can load, and every module those import, is served.
    const seen = new Set();
    const queue = assets.filter((a) => a.endsWith('.js'));
    while (queue.length) {
      const a = queue.shift();
      if (seen.has(a)) continue;
      seen.add(a);
      const r = await w.fetch(new Request(`${ORIGIN}${a}`), env, {});
      assert.equal(r.status, 200, a);
      assert.match(r.headers.get('Content-Type'), /^text\/javascript/);
      assert.equal(r.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
      const src = await r.text();
      for (const m of src.matchAll(/(?:from|import\()\s*'(\.\/[a-z-]+\.js)'/g)) queue.push(a.replace(/[^/]+$/, m[1].slice(2)));
    }
    assert.ok(seen.size >= 7, 'the client and its shared modules');
    const css = await w.fetch(new Request(`${ORIGIN}${assets.find((a) => a.endsWith('.css'))}`), env, {});
    assert.match(css.headers.get('Content-Type'), /^text\/css/);
    // An old hash still gets the file, never cached.
    const stale = await w.fetch(new Request(`${ORIGIN}${BASE}/assets/0000000000000000/requests-page.js`), env, {});
    assert.equal(stale.headers.get('Cache-Control'), 'no-store');
    assert.equal((await w.fetch(new Request(`${ORIGIN}${BASE}/assets/${assets[0].split('/')[2]}/index.js`), env, {})).status, 404, 'only the listed files');
  }
});

test('the flag off: the page offers no endorsing, the permalink and the new routes are 404s, and nothing calls out', { skip }, async () => {
  const w = await loadWorker();
  const env = readyEnv({ BASE_PATH: BASE, BLUESKY_LOGIN: undefined });
  await withFetch(async () => {
    const html = await (await get(w, env, '/requests')).text();
    assert.match(html, /data-endorse="off"/);
    assert.match(html, /data-origin=""/);
    assert.equal((await get(w, env, '/requests/abcdefghijklmnop')).status, 404);
    assert.equal((await get(w, env, '/api/requests/abcdefghijklmnop/endorsers')).status, 404);
    assert.equal((await get(w, env, '/api/bsky/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"account":"a.bsky.social"}' })).status, 404);
  }, async (url) => { throw new Error(`network called with the flag off: ${url}`); });
});

test('the old server-side routes are gone: login, callback, me, endorse, unendorse, forget, logout, clear, old metadata', { skip }, async () => {
  const w = await loadWorker();
  const env = readyEnv({ BASE_PATH: BASE });
  for (const path of ['/oauth/callback', '/api/bsky/me', '/oauth-client-metadata.json']) assert.equal((await get(w, env, path)).status, 404, path);
  for (const path of ['/api/bsky/login', '/api/bsky/endorse', '/api/bsky/unendorse', '/api/bsky/forget', '/api/bsky/logout', '/api/admin/requests/endorsements/clear']) {
    const res = await get(w, env, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('Set-Cookie'), null);
  }
  const meta = await get(w, env, '/endorse-client-metadata.json');
  assert.equal((await meta.json()).scope, OAUTH_SCOPE);
});

test('a request\'s own page exists only for a listed request, with endorsing on', { skip }, async () => {
  const w = await loadWorker();
  const env = readyEnv({ BASE_PATH: BASE });
  await addRequest({ body: { source: 'Listed' }, kv: env.LIMITS, visitor: 'a' });
  await addRequest({ body: { source: 'Unlisted' }, kv: env.LIMITS, visitor: 'b' });
  const listed = await currentId(env.LIMITS, 'Listed');
  const unlisted = await currentId(env.LIMITS, 'Unlisted');
  await decide(env.LIMITS, { id: listed, status: 'accepted' });
  const net = fakeNetwork();
  await withFetch(async () => {
    const page = await get(w, env, `/requests/${listed}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, new RegExp(`data-focus="${listed}"`));
    assert.match(html, /data-endorse="on"/);
    assert.match(html, /data-origin="https:\/\/ask-siren\.jason-edelman\.org"/);
    assert.ok(page.headers.get('Content-Security-Policy'));
    for (const id of [unlisted, 'zzzzzzzzzzzzzzzz', 'abcdefabcdef', '%3Cx%3E']) assert.equal((await get(w, env, `/requests/${id}`)).status, 404, id);
  }, net.fetch);
});

test('the copy says what the code does: public records, one narrow permission, no server sign-in, flags that still count', { skip }, async () => {
  const html = read('worker/requests.html');
  assert.match(html, /Endorsements are public\./);
  assert.match(html, /saves a small record in your own Bluesky account/);
  assert.match(html, /lists every account that endorsed, with its handle/);
  assert.match(html, /one permission: to create and delete these endorsement records/);
  assert.match(html, /never sees your sign-in/);
  assert.match(html, /keeps no record of who endorsed/);
  assert.match(html, /may keep their copy for a while/);
  assert.match(html, /They still count\./);
  for (const gone of ['code computed from your account', 'counters', 'your network', '7 days', "who endorsed isn't", 'INVITE_SECRET']) assert.ok(!html.includes(gone), gone);
  // "One permission": the scope requested is exactly atproto plus create and delete on the one collection.
  assert.match(OAUTH_SCOPE, /^atproto repo:[a-z0-9.-]+\.endorsement\?action=create&action=delete$/);
  // "Never sees your sign-in": no Worker route reads an Authorization or DPoP header, and none sets a Bluesky cookie.
  for (const f of readdirSync(new URL('../worker/', import.meta.url)).filter((x) => /\.js$/.test(x))) {
    const src = read(`worker/${f}`);
    assert.ok(!/headers\.get\(\s*['"](authorization|dpop)['"]/i.test(src), `${f} reads a token header`);
    assert.ok(!/siren_bsky/.test(src), `${f} has a Bluesky cookie`);
  }
  // "Keeps no record of who endorsed": serving the list and the endorser list writes nothing to KV.
  const w = await loadWorker();
  const env = readyEnv({ BASE_PATH: BASE });
  await addRequest({ body: { source: 'Listed' }, kv: env.LIMITS, visitor: 'a' });
  const id = await currentId(env.LIMITS, 'Listed');
  await decide(env.LIMITS, { id, status: 'accepted' });
  const net = fakeNetwork();
  const subject = `${ORIGIN}${BASE}/requests/${id}`;
  net.state.didDocs.set(W.DID2, { id: W.DID2, alsoKnownAs: [], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: W.PDS }] });
  net.state.putRecord(W.DID2, ENDORSE_NSID, id, buildEndorsement({ subject, id }));
  const writes = () => env.LIMITS.ops.filter((o) => o.op === 'put' || o.op === 'delete').length;
  const before = writes();
  await withFetch(async () => {
    assert.equal((await get(w, env, '/api/requests')).status, 200);
    const who = await get(w, env, `/api/requests/${id}/endorsers`);
    assert.equal(who.status, 200);
    assert.equal((await who.json()).endorsers[0].did, W.DID2);
  }, net.fetch);
  assert.equal(writes(), before, 'no KV write');
});

test('render: a count that couldn\'t be read says so, never 0; every remote string is escaped', () => {
  assert.equal(countLine({ endorsements: null, endorsements_unavailable: true }), ' · Endorsement count unavailable right now');
  assert.equal(countLine({ id: 'x', endorsements: 0 }, { endorse: true }), ' · 0 Bluesky endorsements');
  assert.equal(countLine({ id: 'x', endorsements: 3, endorsements_as_of: '2026-11-09T10:15Z' }), ' · 3 Bluesky endorsements (as of 10:15 UTC)');
  assert.match(countLine({ id: 'abcdefghijklmnop', endorsements: 2, endorsements_at_decision: 1, status: 'fulfilled' }, { endorse: true }), /2 Bluesky endorsements · 1 at decision · <button[^>]*data-who="abcdefghijklmnop"/);
  assert.equal(countLine({ count: 1 }), '', 'no endorsement fields, nothing said (flag off)');
  const item = itemHtml({ id: '<x>', source: '<img src=x onerror=alert(1)>', status: 'accepted', count: 1, first: '2026-11-01', notes: ['<b>n</b>'], endorsements: null }, { endorse: true });
  assert.ok(!item.includes('<img') && !item.includes('<b>n</b>') && !item.includes('data-id="<x>"'));
  assert.ok(!/\sstyle="/.test(item));
  const html = endorsersHtml({ total: 2, endorsers: [
    { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'a.bsky.social', displayName: '<script>alert(1)</script>', endorsed: '2026-11-08', flags: [{ kind: 'bot', reason: "Marked as a bot by the account (Bluesky's bot label)" }] },
    { did: 'javascript:alert(1)', handle: null, endorsed: '"><svg>', flags: [] },
  ], dropped: 1, cursor: 'abc' });
  assert.ok(!html.includes('<script>') && !html.includes('<svg>') && !html.includes('javascript:'));
  assert.match(html, /2 accounts endorsed this · 1 of those shown flagged\. Flagged accounts still count\./);
  assert.match(html, /href="https:\/\/bsky\.app\/profile\/did%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa"/);
  assert.match(html, /1 listed account left out/);
  assert.equal(esc(`<>"'&`), '&lt;&gt;&quot;&#39;&amp;');
});
