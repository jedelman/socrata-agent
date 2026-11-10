// Siren's move to its own origin (Jason, 2026-11-10): the old address
// answers with redirects only, every path the code builds works with
// BASE_PATH "" (no double slashes, no "undefined"), the subject URL and the
// client metadata come from the new origin, and the chat page carries a
// strict CSP with no inline script or style. Runs the Worker's own fetch
// handler through a module hook, as test/requests-page.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { movedFrom, moveTarget, movedResponse, httpsResponse, carryToken, readCarryToken, CARRY_SECONDS } from '../worker/moved.js';
import { endorseSubject, OAUTH_SCOPE } from '../worker/endorse-config.js';
import { newCode, inviteKey, signSession, sha256hex, normalizeCode } from '../worker/invites.js';
import { main as syncMain, pageUrlFor } from '../scripts/sync-request-issues.js';
import { userAgent } from '../worker/constellation.js';
import { publicBase } from '../worker/public-list.js';
import { addRequest, decide, currentId } from '../worker/requests.js';
import { readyEnv, fakeNetwork } from './fake-atproto.js';
// Static, not a dynamic import: under Node 24 the text hook below would hand a
// later import of crypto.js the text version the Worker also imports.
import { hmac, b64url, enc } from '../worker/crypto.js';

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

const NEW = 'https://ask-siren.jason-edelman.org';
const OLD = 'https://jason-edelman.org/ask-siren';
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
// Siren's vars as wrangler.toml sets them, with test bindings.
const sirenEnv = (over = {}) => readyEnv({ BLUESKY_LOGIN: undefined, DEPLOYMENT: 'siren', INVITE_REQUIRED: 'true', BASE_PATH: '', PUBLIC_ORIGIN: NEW, MOVED_FROM: OLD, ...over });
const ctx = { waitUntil() {} };

async function withFetch(fn, impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('wrangler.toml: the custom domain, the old routes kept, BASE_PATH "", the new origin and the old address', () => {
  const toml = read('wrangler.toml');
  const siren = toml.slice(toml.indexOf('[env.siren]'));
  assert.match(siren, /\{ pattern = "ask-siren\.jason-edelman\.org", custom_domain = true \}/);
  assert.match(siren, /\{ pattern = "jason-edelman\.org\/ask-siren", zone_name = "jason-edelman\.org" \}/);
  assert.match(siren, /\{ pattern = "jason-edelman\.org\/ask-siren\/\*", zone_name = "jason-edelman\.org" \}/);
  assert.match(siren, /^BASE_PATH = ""$/m);
  assert.match(siren, /^PUBLIC_ORIGIN = "https:\/\/ask-siren\.jason-edelman\.org"$/m);
  assert.match(siren, /^MOVED_FROM = "https:\/\/jason-edelman\.org\/ask-siren"$/m);
  assert.match(siren, /developers\.cloudflare\.com\/workers\/configuration\/routing\/custom-domains\/[\s\S]{0,80}read 2026-11-10/, 'the docs URL and date');
});

test('MOVED_FROM: one shape only, and no move that would loop', async () => {
  assert.deepEqual(movedFrom({ MOVED_FROM: OLD }), { origin: 'https://jason-edelman.org', host: 'jason-edelman.org', prefix: '/ask-siren' });
  for (const bad of [undefined, '', 'https://jason-edelman.org', 'https://jason-edelman.org/', 'https://jason-edelman.org/ask-siren/', 'http://jason-edelman.org/ask-siren',
    'https://jason-edelman.org:8443/ask-siren', 'https://jason-edelman.org/ask-siren?x', 'https://jason-edelman.org/ask-siren#x', 'https://Jason-Edelman.org/ask-siren', 'https://jason-edelman.org/a b', 'https://u@jason-edelman.org/ask-siren']) {
    assert.equal(movedFrom({ MOVED_FROM: bad }), null, String(bad));
  }
  assert.deepEqual(moveTarget({ MOVED_FROM: OLD, PUBLIC_ORIGIN: NEW }, ''), { from: movedFrom({ MOVED_FROM: OLD }), origin: NEW, base: '' });
  assert.equal(moveTarget({ MOVED_FROM: OLD }, ''), null, 'no PUBLIC_ORIGIN');
  assert.equal(moveTarget({ MOVED_FROM: OLD, PUBLIC_ORIGIN: 'http://127.0.0.1:8787' }, ''), null, 'never to a loopback origin');
  assert.equal(moveTarget({ MOVED_FROM: OLD, PUBLIC_ORIGIN: 'https://jason-edelman.org' }, '/ask-siren'), null, 'the same address');
  assert.equal(moveTarget({ MOVED_FROM: OLD, PUBLIC_ORIGIN: 'https://jason-edelman.org' }, '/ask-siren/v2'), null, 'under the old one');
  assert.ok(moveTarget({ MOVED_FROM: OLD, PUBLIC_ORIGIN: 'https://jason-edelman.org' }, '/siren'), 'a sibling path is fine');
  // Not on the old host, or no move configured: nothing to do.
  assert.equal(await movedResponse(new Request(`${NEW}/ask-siren/requests`), { MOVED_FROM: OLD, PUBLIC_ORIGIN: NEW }), null);
  assert.equal(await movedResponse(new Request(`${OLD}/requests`), { PUBLIC_ORIGIN: NEW }), null);
  assert.equal(await movedResponse(new Request('https://www.jason-edelman.org/ask-siren/'), { MOVED_FROM: OLD, PUBLIC_ORIGIN: NEW }), null, 'another host');
});

test('the old address: 301 for GET and HEAD, 308 for the rest, to the same path and query on the new origin, minus /ask-siren', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv();
  const cases = [
    ['/ask-siren/', '/'],
    ['/ask-siren/index.html', '/index.html'],
    ['/ask-siren/login', '/login'],
    ['/ask-siren/requests', '/requests'],
    ['/ask-siren/requests/abcdefghijklmnop', '/requests/abcdefghijklmnop'],
    ['/ask-siren/api/requests', '/api/requests'],
    ['/ask-siren/api/cases/norfolk-street-trees', '/api/cases/norfolk-street-trees'],
    ['/ask-siren/api/conversation?id=11111111-2222-3333-4444-555555555555', '/api/conversation?id=11111111-2222-3333-4444-555555555555'],
    ['/ask-siren/requests?a=1&b=%20two&c=%2F', '/requests?a=1&b=%20two&c=%2F'],
    ['/ask-siren/?', '/'],
    ['/ask-siren/endorse-client-metadata.json', '/endorse-client-metadata.json'],
    ['/ask-siren//evil.example/x', '//evil.example/x'],
  ];
  for (const [from, to] of cases) {
    for (const method of ['GET', 'HEAD']) {
      const res = await w.fetch(new Request(`https://jason-edelman.org${from}`, { method }), env, ctx);
      assert.equal(res.status, 301, `${method} ${from}`);
      assert.equal(res.headers.get('Location'), `${NEW}${to}`, `${method} ${from}`);
      assert.equal(new URL(res.headers.get('Location')).origin, NEW, 'always absolute, always the new origin');
      assert.equal(res.headers.get('Set-Cookie'), null);
      assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', 'a CORS fetch of the public feed can follow it');
      assert.equal(res.headers.get('Cache-Control'), 'public, max-age=86400');
      assert.equal(await res.text(), '');
    }
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const init = { method, headers: { 'Content-Type': 'application/json' }, ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: '{"question":"x"}' } : {}) };
    for (const [from, to] of [['/ask-siren/api/ask', '/api/ask'], ['/ask-siren/api/login?x=1', '/api/login?x=1']]) {
      const res = await w.fetch(new Request(`https://jason-edelman.org${from}`, init), env, ctx);
      assert.equal(res.status, 308, `${method} ${from}`);
      assert.equal(res.headers.get('Location'), `${NEW}${to}`);
    }
  }
});

test('the old address over http, and the bare /ask-siren: first to https and the slash form on the old host, where the old invite cookie is sent', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv();
  // [url, method, status, Location]
  const cases = [
    ['https://jason-edelman.org/ask-siren', 'GET', 301, 'https://jason-edelman.org/ask-siren/'],
    ['https://jason-edelman.org/ask-siren?q=1', 'HEAD', 301, 'https://jason-edelman.org/ask-siren/?q=1'],
    ['http://jason-edelman.org/ask-siren', 'GET', 301, 'https://jason-edelman.org/ask-siren/'],
    ['http://jason-edelman.org/ask-siren/requests?a=1&b=%20', 'GET', 301, 'https://jason-edelman.org/ask-siren/requests?a=1&b=%20'],
    ['http://jason-edelman.org/ask-siren/api/ask', 'POST', 308, 'https://jason-edelman.org/ask-siren/api/ask'],
    ['https://jason-edelman.org/ask-siren', 'POST', 308, 'https://jason-edelman.org/ask-siren/'],
  ];
  for (const [u, method, status, location] of cases) {
    const res = await w.fetch(new Request(u, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) }), env, ctx);
    assert.equal(res.status, status, `${method} ${u}`);
    assert.equal(res.headers.get('Location'), location, `${method} ${u}`);
  }
  // Followed to the end, every one lands on the new origin over https, in at most two hops.
  for (const u of ['http://jason-edelman.org/ask-siren', 'http://jason-edelman.org/ask-siren/requests?x=1', 'https://jason-edelman.org/ask-siren']) {
    let at = u;
    for (let hop = 0; hop < 2 && !at.startsWith(NEW); hop++) at = (await w.fetch(new Request(at), env, ctx)).headers.get('Location');
    assert.ok(at.startsWith(`${NEW}/`), `${u} -> ${at}`);
  }
  // Paths outside /ask-siren on the old host are 404s over http too.
  assert.equal((await w.fetch(new Request('http://jason-edelman.org/ask-sirens'), env, ctx)).status, 404);
  assert.equal((await w.fetch(new Request('http://jason-edelman.org/'), env, ctx)).status, 404);
});

test('plain http on the new host goes to the same path over https; nothing else does', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv();
  for (const [path, method, status] of [['/', 'GET', 301], ['/requests?x=1', 'HEAD', 301], ['/api/ask', 'POST', 308], ['/login', 'GET', 301]]) {
    const res = await w.fetch(new Request(`http://ask-siren.jason-edelman.org${path}`, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) }), env, ctx);
    assert.equal(res.status, status, `${method} ${path}`);
    assert.equal(res.headers.get('Location'), `${NEW}${path}`);
    assert.equal(res.headers.get('Set-Cookie'), null);
  }
  assert.equal(httpsResponse(new Request(`${NEW}/`), env), null, 'https is served');
  assert.equal(httpsResponse(new Request('http://other.example/'), env), null, 'another host is not ours to send');
  assert.equal(httpsResponse(new Request('http://127.0.0.1:8787/'), { PUBLIC_ORIGIN: 'http://127.0.0.1:8787' }), null, 'local dev stays on http');
  assert.equal(httpsResponse(new Request(`http://ask-siren.jason-edelman.org/`), {}), null, 'no PUBLIC_ORIGIN, no redirect');
});

// An invite redeemed on the old address, held only as its cookie there.
async function oldInvite(env, record = { label: 'old', max_uses: 1 }) {
  const code = newCode();
  await env.LIMITS.put(await inviteKey(code), JSON.stringify(record));
  const hash = await sha256hex(normalizeCode(code));
  await env.LIMITS.put(`redeemed:${hash}:first`, '2026-11-01T00:00:00.000Z'); // its one use, spent
  return { code, hash, cookie: `siren_invite=${await signSession(env.INVITE_SECRET, hash)}` };
}

test('carry-over: an invite held as a cookie on the old address follows the person to the new host, spending no use', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv();
  const { hash, cookie } = await oldInvite(env);
  const logged = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, console[k]]);
  for (const [k] of spies) console[k] = (...a) => logged.push(a.join(' '));
  let token;
  try {
    for (const method of ['GET', 'HEAD']) {
      const first = await w.fetch(new Request(`${OLD}/requests?x=1`, { method, headers: { Cookie: `other=1; ${cookie}` } }), env, ctx);
      assert.equal(first.status, 302, method);
      assert.equal(first.headers.get('Cache-Control'), 'no-store');
      assert.equal(first.headers.get('Referrer-Policy'), 'no-referrer');
      assert.equal(first.headers.get('Set-Cookie'), null, 'nothing set on the old host');
      const loc = new URL(first.headers.get('Location'));
      assert.equal(`${loc.origin}${loc.pathname}`, `${NEW}/carry-invite`);
      assert.deepEqual([...loc.searchParams.keys()], ['t']);
      token = loc.searchParams.get('t');
      assert.deepEqual(await readCarryToken(env.INVITE_SECRET, token), { hash, to: '/requests?x=1' });
      const carried = await w.fetch(new Request(loc.href, { method }), env, ctx);
      assert.equal(carried.status, 302);
      assert.equal(carried.headers.get('Location'), `${NEW}/requests?x=1`, 'on to the page asked for');
      assert.equal(carried.headers.get('Cache-Control'), 'no-store');
      assert.equal(carried.headers.get('Referrer-Policy'), 'no-referrer');
      const set = carried.headers.get('Set-Cookie');
      assert.match(set, /^__Host-siren_invite=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
      // The carried cookie works on the new host, though the code has no use left.
      const session = await (await w.fetch(new Request(`${NEW}/api/session`, { headers: { Cookie: set.split(';')[0] } }), env, ctx)).json();
      assert.equal(session.invited, true, method);
    }
  } finally {
    for (const [k, f] of spies) console[k] = f;
  }
  assert.ok(!logged.some((l) => l.includes(token) || l.includes('carry-invite?t=')), 'the token is never logged');
  assert.deepEqual([...env.LIMITS.store.keys()].filter((k) => k.startsWith('redeemed:')), [`redeemed:${hash}:first`], 'no use spent');
});

test('carry-over refuses what it should: forged, expired, relabelled or malformed tokens; a browser that already holds an invite keeps it', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv();
  const { hash, cookie } = await oldInvite(env);
  const secret = env.INVITE_SECRET;
  const route = (t, headers = {}) => w.fetch(new Request(`${NEW}/carry-invite?t=${encodeURIComponent(t)}`, { headers }), env, ctx);
  const refused = async (t, why) => {
    const res = await route(t);
    assert.equal(res.status, 302, why);
    assert.equal(res.headers.get('Location'), `${NEW}/`, `${why}: to the home page`);
    assert.equal(res.headers.get('Set-Cookie'), null, `${why}: no cookie`);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  };
  const good = await carryToken(secret, hash, '/requests');
  const [payload, sig] = good.split('.');
  const mid = Math.floor(sig.length / 2);
  await refused(`${payload}.${sig.slice(0, mid)}${sig[mid] === 'A' ? 'B' : 'A'}${sig.slice(mid + 1)}`, 'a changed signature');
  await refused(await carryToken('another-secret-that-is-long-enough', hash, '/requests'), 'another secret');
  await refused(await carryToken(secret, hash, '/requests', Date.now() - (CARRY_SECONDS + 1) * 1000), 'expired');
  const other = Buffer.from(JSON.stringify({ k: 'a'.repeat(64), t: '/', e: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  await refused(`${other}.${sig}`, 'a payload swapped under a real signature');
  await refused(await signSession(secret, hash), 'an invite session cookie is not a carry token (its own label)');
  for (const junk of ['', 'x', 'a.b.c', `${payload}.`, `.${sig}`, `${good}.x`, 'é'.repeat(10)]) await refused(junk, `malformed: ${junk}`);
  // A valid token whose expiry reaches far ahead is refused too (it could only be forged).
  const far = b64url(enc.encode(JSON.stringify({ k: hash, t: '/', e: Math.floor(Date.now() / 1000) + 3600 })));
  await refused(`${far}.${b64url(await hmac(secret, `carry-invite:${far}`))}`, 'an expiry beyond the window');
  assert.equal(await readCarryToken(secret, good, Date.now() + (CARRY_SECONDS + 1) * 1000), null, 'it lasts CARRY_SECONDS');
  assert.ok(CARRY_SECONDS <= 300, 'five minutes at most');
  // No route without INVITE_SECRET.
  assert.equal((await w.fetch(new Request(`${NEW}/carry-invite?t=${good}`), sirenEnv({ INVITE_SECRET: undefined }), ctx)).status, 404);
  // Someone who already holds an invite on the new host keeps their own: a carry link someone sent can't swap it.
  const mine = `__Host-siren_invite=${await signSession(secret, 'b'.repeat(64))}`;
  const kept = await route(good, { Cookie: mine });
  assert.equal(kept.headers.get('Set-Cookie'), null);
  assert.equal(kept.headers.get('Location'), `${NEW}/requests`);
  // On the old host, only a valid cookie is carried, and only by a GET or HEAD over https.
  const plain = await w.fetch(new Request(`${OLD}/`, { headers: { Cookie: 'siren_invite=forged.value' } }), env, ctx);
  assert.equal(plain.status, 301);
  assert.equal(plain.headers.get('Location'), `${NEW}/`);
  const expired = `siren_invite=${await signSession(secret, hash, Date.now() - 31 * 86400e3)}`;
  assert.equal((await w.fetch(new Request(`${OLD}/`, { headers: { Cookie: expired } }), env, ctx)).status, 301);
  const posted = await w.fetch(new Request(`${OLD}/api/ask`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }), env, ctx);
  assert.equal(posted.status, 308);
  assert.equal(posted.headers.get('Location'), `${NEW}/api/ask`);
  // The new names are not carried from the old host: only the cookie it really set there.
  assert.equal((await w.fetch(new Request(`${OLD}/`, { headers: { Cookie: `__Host-${cookie}` } }), env, ctx)).status, 301);
});

test('the old address serves nothing else: no page, no KV, no cookie; and the new origin serves normally', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv();
  for (const path of ['/ask-sirens', '/', '/requests', '/api/requests']) {
    const res = await w.fetch(new Request(`https://jason-edelman.org${path}`), env, ctx);
    assert.equal(res.status, 404, path);
  }
  // A signed-in cookie on the old origin changes nothing: it is redirected before anything reads it.
  const res = await w.fetch(new Request(`${OLD}/api/session`, { headers: { Cookie: 'siren_user=x; siren_invite=y' } }), env, ctx);
  assert.equal(res.status, 301);
  assert.deepEqual(env.LIMITS.ops, [], 'no KV read for a redirect');
  // The new origin: the page, the feed.
  const page = await w.fetch(new Request(`${NEW}/`), env, ctx);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type'), /^text\/html/);
  const feed = await w.fetch(new Request(`${NEW}/api/requests`), env, ctx);
  assert.equal(feed.status, 200);
  assert.deepEqual((await feed.json()).requests, []);
  // MOVED_FROM set but no valid PUBLIC_ORIGIN: the old origin answers 404, never the app.
  const broken = sirenEnv({ PUBLIC_ORIGIN: 'https://jason-edelman.org/ask-siren' });
  const real = console.error;
  console.error = () => {};
  try {
    assert.equal((await w.fetch(new Request(`${OLD}/`), broken, ctx)).status, 404);
  } finally {
    console.error = real;
  }
});

test('BASE_PATH "": the chat page, its assets, the requests page and the links it carries have no double slash and no "undefined"', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv({ BLUESKY_LOGIN: 'true' });
  // Outside a URL's scheme, no "//": a path built as base + "/" + "/x" would show one.
  const clean = (label, text) => {
    assert.ok(!/undefined/.test(text), `${label}: "undefined"`);
    assert.ok(!text.replace(/https?:\/\/[a-z0-9.-]+/gi, '').includes('//'), `${label}: a double slash`);
  };
  for (const path of ['/', '/index.html', '/login']) {
    const res = await w.fetch(new Request(`${NEW}${path}`), env, ctx);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    clean(path, html);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[0-9a-f]{16}\/[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(assets.map((a) => a.split('/').pop()).sort(), ['chat-page.js', 'chat.css'], path);
    for (const a of assets) {
      const r = await w.fetch(new Request(`${NEW}${a}`), env, ctx);
      assert.equal(r.status, 200, a);
      assert.match(r.headers.get('Content-Type'), a.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
      assert.equal(r.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
      assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    }
  }
  const requests = await (await w.fetch(new Request(`${NEW}/requests`), env, ctx)).text();
  clean('/requests', requests);
  assert.match(requests, /data-base=""/);
  assert.match(requests, /data-origin="https:\/\/ask-siren\.jason-edelman\.org"/);
  assert.match(requests, /<a href="\/">Ask Siren<\/a>/);
  assert.match(requests, /href="\/assets\/[0-9a-f]{16}\/requests\.css"/);
  // A deployment under a path still gets its prefix everywhere, and the bare path still goes to the slash form.
  const under = readyEnv({ BLUESKY_LOGIN: undefined, BASE_PATH: '/ask-siren', PUBLIC_ORIGIN: 'https://example.org' });
  const bare = await w.fetch(new Request('https://example.org/ask-siren?q=1'), under, ctx);
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('Location'), 'https://example.org/ask-siren/?q=1');
  const html = await (await w.fetch(new Request('https://example.org/ask-siren/'), under, ctx)).text();
  assert.match(html, /href="\/ask-siren\/assets\/[0-9a-f]{16}\/chat\.css"/);
  assert.match(html, /src="\/ask-siren\/assets\/[0-9a-f]{16}\/chat-page\.js"/);
  assert.equal((await w.fetch(new Request(`https://example.org${html.match(/src="(\/ask-siren\/assets\/[^"]+)"/)[1]}`), under, ctx)).status, 200);
});

test('BASE_PATH "": sign-in links, cookies at Path=/ on the new host only, and case annotation ids', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv({ RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@send.example.org>' });
  const sent = [];
  const post = (path, body, headers = {}) => new Request(`${NEW}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.20', ...headers }, body: JSON.stringify(body) });
  await withFetch(async () => {
    // The link is built from PUBLIC_ORIGIN, never the Host header.
    const res = await w.fetch(post('/api/login', { email: 'reader@example.org' }), env, ctx);
    assert.equal(res.status, 200);
  }, async (url, init) => {
    assert.equal(String(url), 'https://api.resend.com/emails');
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(sent.length, 1);
  const link = sent[0].text.match(/https:\/\/\S+#t=[A-Za-z0-9_-]+/)[0];
  assert.ok(link.startsWith(`${NEW}/login#t=`), link);
  assert.ok(sent[0].html.includes(`${NEW}/login#t=`));
  // Verify: the account cookie, host-only (no Domain), Path=/.
  const verified = await w.fetch(post('/api/login/verify', { token: link.split('#t=')[1] }), env, ctx);
  assert.equal(verified.status, 200);
  const userCookie = verified.headers.get('Set-Cookie');
  assert.match(userCookie, /^__Host-siren_user=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(!/Domain=/i.test(userCookie), 'host-only: never shared with jason-edelman.org or another subdomain');
  // An invite redeemed without an account: the invite cookie, the same way.
  const code = newCode();
  await env.LIMITS.put(await inviteKey(code), JSON.stringify({ label: 'test' }));
  const redeemed = await w.fetch(post('/api/redeem', { code }), env, ctx);
  assert.equal(redeemed.status, 200);
  const inviteCookie = redeemed.headers.get('Set-Cookie');
  assert.match(inviteCookie, /^__Host-siren_invite=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  // The session renews it at Path=/ too.
  const session = await w.fetch(new Request(`${NEW}/api/session`, { headers: { Cookie: inviteCookie.split(';')[0] } }), env, ctx);
  assert.match(session.headers.get('Set-Cookie'), /^__Host-siren_invite=[^;]+; Path=\/; /);
  assert.equal((await (await w.fetch(new Request(`${NEW}/api/session`, { headers: { Cookie: inviteCookie.split(';')[0].replace('__Host-', '') } }), env, ctx)).json()).invited, false, 'the old name means nothing on the new host');
  const out = await w.fetch(post('/api/logout', {}), env, ctx);
  assert.match(out.headers.get('Set-Cookie'), /^__Host-siren_user=; Path=\/; Max-Age=0; /);
  // Case files as Web Annotations: ids on the new origin, whatever host the request came in on.
  const list = await (await w.fetch(new Request(`${NEW}/api/cases`), env, ctx)).json();
  assert.ok(list.cases.length > 0);
  for (const c of list.cases) assert.equal(c.annotations, `${NEW}/api/cases/${c.id}`);
  for (const c of list.cases) {
    const doc = JSON.parse(await (await w.fetch(new Request(`${NEW}/api/cases/${c.id}`), env, ctx)).text());
    assert.equal(doc.id, `${NEW}/api/cases/${c.id}`);
    assert.equal(doc.first.id, `${doc.id}?page=1`);
    assert.ok(doc.first.items.length > 0);
    for (const a of doc.first.items) assert.ok(a.id.startsWith(`${doc.id}#`), a.id);
  }
});

test('the subject URL, the client metadata and the Constellation User-Agent are on the new origin', { skip }, async () => {
  const w = await loadWorker();
  const env = sirenEnv();
  const id = 'abcdefghijklmnop';
  assert.equal(endorseSubject(env.PUBLIC_ORIGIN, env.BASE_PATH, id), `${NEW}/requests/${id}`);
  const meta = await w.fetch(new Request(`${NEW}/endorse-client-metadata.json`), env, ctx);
  assert.equal(meta.status, 200, 'served with the flag off, for the rollout probe');
  const m = await meta.json();
  assert.equal(m.client_id, `${NEW}/endorse-client-metadata.json`);
  assert.deepEqual(m.redirect_uris, [`${NEW}/requests`]);
  assert.equal(m.client_uri, `${NEW}/`);
  assert.equal(m.scope, OAUTH_SCOPE);
  // Constellation hears the new public URL: the counts route sends it as the User-Agent.
  assert.equal(publicBase(env, env.BASE_PATH), NEW);
  const on = sirenEnv({ BLUESKY_LOGIN: 'true' });
  await addRequest({ body: { source: 'Tree inventory' }, kv: on.LIMITS, visitor: 'a' });
  const listed = await currentId(on.LIMITS, 'Tree inventory');
  await decide(on.LIMITS, { id: listed, status: 'accepted' });
  const net = fakeNetwork();
  await withFetch(async () => {
    const list = await w.fetch(new Request(`${NEW}/api/requests`), on, ctx);
    assert.equal(list.status, 200);
  }, net.fetch);
  const call = net.calls.find((c) => c.url.includes('getBacklinkDids'));
  assert.ok(call, 'the count was asked for');
  assert.equal(new URL(call.url).searchParams.get('subject'), `${NEW}/requests/${listed}`);
  assert.equal(call.headers['User-Agent'], userAgent(`${NEW}/`));
  assert.equal(userAgent(`${NEW}/`), `Siren (+${NEW}/; https://github.com/jedelman/socrata-agent)`);
  // Nothing in the shipped config, code or docs still builds the old address, outside the redirect itself and its history.
  const allowed = /MOVED_FROM|moved|until 2026-11-10|before that|from `https:\/\/jason-edelman\.org\/ask-siren|lived at|redirect|old address|old routes|stored prompt|zone_name = "jason-edelman\.org"/i;
  for (const f of ['wrangler.toml', 'worker/index.js', 'worker/bluesky.js', 'worker/public-list.js', 'worker/endorsers.js', 'worker/admin.js', 'scripts/sync-request-issues.js', 'scripts/bsky-probe.js', 'deployments/siren.config.js', 'README.md', 'docs/request-sync-routine.md', 'docs/bluesky-endorsements.md', 'docs/fulfilling-requests.md', 'data/cases/README.md', 'lexicons/org/jason-edelman/siren/endorsement.json', 'CLAUDE.md']) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => {
      if (/jason-edelman\.org\/ask-siren/.test(line)) {
        const around = lines.slice(Math.max(0, i - 3), i + 2).join('\n');
        assert.match(around, allowed, `${f}:${i + 1} still points at the old address: ${line.trim()}`);
      }
    });
  }
});

test('the chat page: a strict CSP, no inline script, style or handler, and only what the CSP allows', { skip }, async () => {
  const w = await loadWorker();
  for (const [label, env, fonts] of [['siren', sirenEnv(), true], ['default (plain skin)', readyEnv({ BLUESKY_LOGIN: undefined, BASE_PATH: '', PUBLIC_ORIGIN: NEW }), false]]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await w.fetch(new Request(`${NEW}/`, { method }), env, ctx);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('Content-Security-Policy'), `${label} ${method}`);
      assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
      assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    }
    const res = await w.fetch(new Request(`${NEW}/login`), env, ctx);
    const csp = res.headers.get('Content-Security-Policy');
    const dirs = Object.fromEntries(csp.split(/;\s*/).map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    assert.deepEqual(dirs['default-src'], ["'none'"]);
    assert.deepEqual(dirs['connect-src'], ["'self'"], 'the page talks only to Siren');
    assert.deepEqual(dirs['frame-ancestors'], ["'none'"]);
    assert.deepEqual(dirs['base-uri'], ["'none'"]);
    assert.deepEqual(dirs['form-action'], ["'self'"]);
    assert.deepEqual(dirs['img-src'], ["'self'", 'data:']);
    assert.ok(!/unsafe-inline|unsafe-eval|unsafe-hashes|\*/.test(csp), `${label}: ${csp}`);
    assert.equal(dirs['script-src'][0], "'self'");
    // Exact files, not the whole CDN; and Cloudflare's analytics beacon, the file and its versioned copies only.
    const beacon = ['https://static.cloudflareinsights.com/beacon.min.js', 'https://static.cloudflareinsights.com/beacon.min.js/'];
    for (const s of dirs['script-src'].slice(1)) assert.ok(beacon.includes(s) || /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[a-z]+\/[0-9.]+\/[a-z.]+\.js$/.test(s), `${label}: ${s}`);
    assert.ok(beacon.every((b) => dirs['script-src'].includes(b)), 'the analytics beacon runs (Jason, 2026-11-10)');
    if (fonts) {
      assert.deepEqual(dirs['style-src'], ["'self'", 'https://fonts.googleapis.com']);
      assert.deepEqual(dirs['font-src'], ['https://fonts.gstatic.com']);
    } else {
      assert.deepEqual(dirs['style-src'], ["'self'"]);
      assert.equal(dirs['font-src'], undefined);
    }
    const html = await res.text();
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'every placeholder filled');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
    assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html), 'no inline style');
    assert.ok(!/\son[a-z]+=/i.test(html), 'no inline handlers');
    assert.ok(!/javascript:/i.test(html));
    // Every script and stylesheet the page loads is allowed by the policy.
    for (const [, src] of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
      if (src.startsWith('/')) assert.match(src, /^\/assets\/[0-9a-f]{16}\/chat-page\.js$/);
      else assert.ok(dirs['script-src'].includes(src), `${src} is not in script-src`);
    }
    assert.equal([...html.matchAll(/<script[^>]*\bsrc="https:[^"]+"[^>]*\bintegrity="sha384-[^"]+"/g)].length, 2, 'the CDN scripts keep their integrity');
    for (const [, href] of html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"|<link[^>]*href="([^"]+)"[^>]*rel="stylesheet"/g)) {
      if (!href) continue;
      if (href.startsWith('/')) assert.match(href, /^\/assets\/[0-9a-f]{16}\/chat\.css$/);
      else assert.ok(dirs['style-src'].includes(new URL(href).origin), `${href} is not in style-src`);
    }
    for (const [, href] of html.matchAll(/<link[^>]*href="(https:[^"]+)"[^>]*rel="stylesheet"/g)) assert.ok(dirs['style-src'].includes(new URL(href).origin), href);
    for (const [, href] of html.matchAll(/<link rel="icon" href="([^"]+)"/g)) assert.ok(href.startsWith('data:image/svg+xml,'), 'the favicon is a data: URL (img-src data:)');
    assert.match(html, /data-app-name="Siren"|data-app-name="socrata-agent"/);
  }
});

test('the chat script and style: static files with nothing per deployment, no inline style made at run time, behaviour kept', () => {
  const js = read('worker/chat-page.js');
  const css = read('worker/chat.css');
  const ui = read('worker/ui.html');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(js) && !/\{\{[A-Z_]+\}\}/.test(css), 'no placeholders: one file for every deployment, cached by its hash');
  // Markup the script writes carries no style attribute or handler (the CSP would block them).
  assert.ok(!/\sstyle=/.test(js), 'no style attribute in markup the script writes');
  assert.ok(!/\son[a-z]+=["$]/i.test(js), 'no inline handlers in markup the script writes');
  assert.ok(!/\beval\(|new Function|setTimeout\(\s*['"`]/.test(js), 'nothing that needs unsafe-eval');
  // Model output loses style attributes in DOMPurify, before the CSP would refuse them with a console error each;
  // and data attributes, form controls and dialogs, so it can't pose as the page's own controls.
  assert.match(js, /DOMPurify\.sanitize\(marked\.parse\(s \|\| ''\), \{ FORBID_ATTR: \['style'\], ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true, FORBID_TAGS: \['form', 'input', 'button', 'select', 'textarea', 'option', 'dialog'\] \}\)/);
  // What were inline style attributes are classes now, styled in chat.css.
  assert.match(js, /<code class="ds">/);
  assert.match(js, /<textarea name="need" class="need"/);
  assert.match(ui, /<button type="button" id="signout" class="textbtn">Sign out<\/button>/);
  for (const rule of ['ol.trace code.ds { display: inline; }', 'form.suggest textarea.need { width: 100%; margin-top: 4px; }', 'button.textbtn {']) assert.ok(css.includes(rule), rule);
  // The page's pieces are where they were: the working notes, the answer, the stream reader, the sign-in.
  for (const name of ['function renderAnswer(', 'function notesPanel(', 'async function readLines(', 'async function savedTurn(', 'async function finishSignIn(', "const NDJSON = 'application/x-ndjson'", 'DOMPurify.sanitize(marked.parse(']) assert.ok(js.includes(name), name);
  assert.match(ui, /<template id="notes-tpl">/);
  assert.match(js, /document\.documentElement\.dataset\.appName/);
  assert.match(ui, /<html lang="en" data-skin="\{\{SKIN\}\}" data-loading="\{\{LOADING\}\}" data-app-name="\{\{APP_NAME\}\}">/);
  // The chat script loads after marked and DOMPurify, at the end of the body, where the inline script was.
  const tail = ui.slice(ui.indexOf('</footer>'));
  assert.ok(tail.indexOf('marked.min.js') < tail.indexOf('purify.min.js') && tail.indexOf('purify.min.js') < tail.indexOf('chat-page.js'));
  assert.match(tail, /<script src="\{\{ASSETS\}\}\/chat-page\.js"><\/script>\n<\/body>/);
  // The siren skin's palette moved too.
  assert.match(css, /:root\[data-skin="siren"\] \{/);
});

test('the issue sync: the new feed links the new page, and the old feed, followed through its redirect, does too', { skip }, async () => {
  assert.equal(pageUrlFor(`${NEW}/api/requests`), `${NEW}/requests`);
  const w = await loadWorker();
  const env = sirenEnv();
  // Through the Worker, following redirects the way fetch does.
  const follow = async (url) => {
    let u = url;
    for (let i = 0; i < 3; i++) {
      const res = await w.fetch(new Request(u), env, ctx);
      if (res.status !== 301 && res.status !== 308) {
        Object.defineProperty(res, 'url', { value: u });
        return res;
      }
      u = res.headers.get('Location');
    }
    throw new Error('too many redirects');
  };
  const req = { id: 'abcdefghijklmnop', source: 'Tree inventory', count: 2, status: 'accepted', notes: [] };
  const feedFrom = (url) => async (u) => {
    const res = await follow(String(u));
    assert.equal(res.url, `${NEW}/api/requests`);
    return Object.defineProperty(new Response(JSON.stringify({ requests: [req], withdrawn: [] })), 'url', { value: res.url });
  };
  for (const feed of [`${NEW}/api/requests`, `${OLD}/api/requests`]) {
    let out = '';
    await syncMain({ argv: ['--plan', '--with-withdrawn'], env: { REQUESTS_URL: feed, GITHUB_REPOSITORY: 'jedelman/socrata-agent' }, fetchImpl: feedFrom(feed), log: (s) => (out = s) });
    const [entry] = JSON.parse(out);
    assert.ok(entry.body.includes(`[the request list](${NEW}/requests)`), `${feed}: ${entry.body}`);
    assert.ok(!entry.body.includes('jason-edelman.org/ask-siren'));
  }
  // A response without a usable url (a stub, an odd redirect) falls back to REQUESTS_URL.
  let out = '';
  await syncMain({ argv: ['--plan'], env: { REQUESTS_URL: `${NEW}/api/requests`, GITHUB_REPOSITORY: 'o/r' }, fetchImpl: async () => new Response(JSON.stringify({ requests: [req] })), log: (s) => (out = s) });
  assert.ok(JSON.parse(out)[0].body.includes(`[the request list](${NEW}/requests)`));
  await syncMain({ argv: ['--plan'], env: { REQUESTS_URL: `${NEW}/api/requests`, GITHUB_REPOSITORY: 'o/r' }, fetchImpl: async () => Object.defineProperty(new Response(JSON.stringify({ requests: [req] })), 'url', { value: 'https://elsewhere.example/feed.json' }), log: (s) => (out = s) });
  assert.ok(JSON.parse(out)[0].body.includes(`[the request list](${NEW}/requests)`), 'an unexpected final URL is not trusted for the link');
});

test('the docs: the routine prompt reads the new feed, the stored prompt is flagged for an update, D4 is settled', () => {
  const routine = read('docs/request-sync-routine.md');
  assert.match(routine, /REQUESTS_URL=https:\/\/ask-siren\.jason-edelman\.org\/api\/requests GITHUB_REPOSITORY=jedelman\/socrata-agent node scripts\/sync-request-issues\.js --plan --with-withdrawn/);
  assert.ok(!routine.includes('REQUESTS_URL=https://jason-edelman.org/ask-siren'), 'the copy of the prompt is the new text');
  assert.match(routine, /after the deploy/i);
  assert.match(routine, /keeps working[\s\S]{0,80}redirect/);
  assert.match(routine, /"Siren: fulfill a source request", also fetches the\nfeed by its old URL/);
  const readme = read('README.md');
  assert.match(readme, /"Siren: sync source requests to issues"[\s\S]{0,80}"Siren: fulfill a source request"/);
  assert.match(readme, /Tabs left open across the deploy must be reloaded/);
  assert.match(readme, /An invite held only as a cookie comes along/);
  assert.match(readme, /`__Host-siren_user` and `__Host-siren_invite`/);
  const doc = read('docs/bluesky-endorsements.md');
  assert.match(doc, /The subject is fixed from here on\./);
  assert.match(doc, /\*\*The chat page carries a strict CSP too\*\*/);
  assert.match(doc, /apart from jason-edelman\.org's other pages/);
  const lexicon = JSON.parse(read('lexicons/org/jason-edelman/siren/endorsement.json'));
  assert.match(lexicon.defs.requestRef.properties.uri.description, /https:\/\/ask-siren\.jason-edelman\.org\/requests\/<id>/);
});
