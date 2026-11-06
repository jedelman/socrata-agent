// Bluesky sign-in end to end on the fake atproto network, through the route
// handlers (index.js can't be imported in Node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleLogin, handleCallback, handleMe, handleLogout, handleEndorse, handleUnendorse, handleForget, handleMetadata,
  sealSession, openSession, sessionCookie, bskyVisitor, blueskyReady, metadataReady, BSKY_COOKIE, FLOW_COOKIE, FLOW_PURPOSE,
} from '../worker/bluesky.js';
import { seal, hmacHex } from '../worker/crypto.js';
import { signSession } from '../worker/invites.js';
import { signUser, verifyUser, userId } from '../worker/accounts.js';
import { W, json, asMeta, didDoc, fakeNetwork, fakeKV, fakeLimiter, readyEnv, thumbprint, hang, SECRET } from './fake-atproto.js';

const ORIGIN = 'https://jason-edelman.org';
const BASE = '/ask-siren';
const IP = '203.0.113.7';
const T0 = Date.parse('2026-11-06T12:00:00Z');

function post(path, body, { origin, cookie, host = ORIGIN, ip = IP } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (origin !== undefined) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  return new Request(`${host}${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
function get(path, { cookie, ip = IP } = {}) {
  return new Request(`${ORIGIN}${BASE}${path}`, { headers: { 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) } });
}
const cookieValue = (setCookie, name) => (setCookie.match(new RegExp(`^${name}=([^;]*)`)) || [])[1];

async function login({ env = readyEnv(), net = fakeNetwork(), account = W.HANDLE, now = T0, deps = {}, reqOpts = {} } = {}) {
  const res = await handleLogin(post('/api/bsky/login', { account }, reqOpts), env, null, BASE, { fetchImpl: net.fetch, now, ...deps });
  const body = await res.json();
  const setCookie = res.headers.get('Set-Cookie') || '';
  return { res, body, env, net, setCookie, flow: cookieValue(setCookie, FLOW_COOKIE) };
}

async function callback(env, net, { state, iss = W.ISSUER, code = W.CODE, flow, cookies, now = T0 + 5000, error, log } = {}) {
  const p = new URLSearchParams();
  if (state !== undefined) p.set('state', state);
  if (iss !== undefined && iss !== null) p.set('iss', iss);
  if (error) p.set('error', error);
  else if (code !== undefined) p.set('code', code);
  const cookie = cookies ?? (flow ? `${FLOW_COOKIE}=${flow}` : '');
  const deferred = [];
  const logged = [];
  const res = await handleCallback(get(`/oauth/callback?${p}`, { cookie }), env, null, BASE, {
    fetchImpl: net.fetch, now, defer: (x) => deferred.push(x), log: log || ((...a) => logged.push(a)),
  });
  await Promise.all(deferred);
  return { res, deferred, logged, location: res.headers.get('Location'), cookies: res.headers.getSetCookie() };
}

const stateOf = (net) => net.state.par.at(-1).form.state;
const tokenCalls = (net) => net.calls.filter((c) => c.url.endsWith('/oauth/token'));

test('readiness: the flag, storage, secrets, four limiters and a valid origin', () => {
  assert.ok(blueskyReady(readyEnv()));
  assert.equal(blueskyReady(readyEnv({ BLUESKY_LOGIN: undefined })), false);
  assert.equal(blueskyReady(readyEnv({ BSKY_SITE_RL: undefined })), false);
  assert.equal(blueskyReady(readyEnv({ IP_SALT: '' })), false);
  assert.equal(blueskyReady(readyEnv({ PUBLIC_ORIGIN: 'https://jason-edelman.org/' })), false);
  assert.ok(metadataReady({ PUBLIC_ORIGIN: ORIGIN }));
  assert.equal(metadataReady({ PUBLIC_ORIGIN: 'http://127.0.0.1:8787' }), false);
  assert.equal(metadataReady({}), false);
});

test('the client metadata route serves the client_id document, and 404s without an origin', async () => {
  const res = await handleMetadata(get('/oauth-client-metadata.json'), { PUBLIC_ORIGIN: ORIGIN }, BASE);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /^application\/json/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal((await res.json()).client_id, `${ORIGIN}${BASE}/oauth-client-metadata.json`);
  assert.equal((await handleMetadata(get('/oauth-client-metadata.json'), {}, BASE)).status, 404);
});

test('happy path: login, callback, a sealed session, both tokens revoked', async () => {
  const { res, body, env, net, setCookie, flow } = await login();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const redirect = new URL(body.redirect);
  assert.equal(redirect.protocol, 'https:');
  assert.equal(redirect.origin + redirect.pathname, `${W.ISSUER}/oauth/authorize`);
  assert.equal(redirect.searchParams.get('client_id'), `${ORIGIN}${BASE}/oauth-client-metadata.json`);
  assert.equal(redirect.searchParams.get('request_uri'), 'urn:ietf:params:oauth:request_uri:req-1');
  assert.match(setCookie, /; Path=\/ask-siren\/oauth\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
  const loginCalls = net.calls.length;

  const cb = await callback(env, net, { state: stateOf(net), flow });
  assert.equal(cb.res.status, 303);
  assert.equal(cb.location, `${ORIGIN}${BASE}/requests#bluesky=signed-in`);
  assert.equal(cb.res.headers.get('Cache-Control'), 'no-store');
  assert.equal(cb.res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(cb.cookies.length, 2);
  assert.match(cb.cookies[0], /^siren_bsky=[^;]+; Path=\/ask-siren\/api\/bsky\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(cb.cookies[1], /^siren_bsky_flow=; Path=\/ask-siren\/oauth\/; Max-Age=0/);

  const session = await openSession(SECRET, cookieValue(cb.cookies[0], BSKY_COOKIE), T0 + 6000);
  assert.equal(session.eid, await hmacHex(SECRET, `endorser:${W.DID}`));
  assert.equal(session.handle, W.HANDLE);
  assert.equal(session.issuer, W.ISSUER);
  assert.equal(session.created, '2025-01-02');

  const parProof = net.proofs.find((p) => p.url.endsWith('/oauth/par') && p.payload.nonce);
  const tokProof = net.proofs.find((p) => p.url.endsWith('/oauth/token'));
  assert.equal(await thumbprint(tokProof.header.jwk), await thumbprint(parProof.header.jwk), 'the same DPoP key survives the redirect');
  assert.equal(tokProof.payload.nonce, 'nonce-par-2', "the token request carries PAR's nonce");
  assert.equal(net.state.tokens[0].form.redirect_uri, `${ORIGIN}${BASE}/oauth/callback`);

  const after = net.calls.slice(loginCalls).map((c) => c.url);
  assert.ok(after.includes(`${W.PLC}/${W.DID}`), 'the DID document is re-fetched at the callback');
  assert.ok(after.includes(`${W.PDS}/.well-known/oauth-protected-resource`), 'and the protected-resource metadata');
  assert.equal(cb.deferred.length, 1);
  assert.deepEqual(net.state.revokes.map((r) => r.form.token_type_hint), ['refresh_token', 'access_token']);
});

test('the flow cookie must be one, intact, ours, and unexpired', async () => {
  const fresh = async (now = T0) => login({ now });
  let L = await fresh();
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net) })).location, /#bluesky-error=flow_expired$/, 'missing cookie');
  // Expired by one second; one second left passes.
  L = await fresh();
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow, now: T0 + 601000 })).location, /flow_expired$/);
  L = await fresh();
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow, now: T0 + 600000 })).location, /signed-in$/);
  // Tampered.
  L = await fresh();
  const i = Math.floor(L.flow.length / 2);
  const tampered = L.flow.slice(0, i) + (L.flow[i] === 'A' ? 'B' : 'A') + L.flow.slice(i + 1);
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: tampered })).location, /flow_expired$/);
  // Another secret; a session cookie as a flow cookie; two flow cookies.
  const other = await seal('another-secret-entirely', FLOW_PURPOSE, { v: 1, s: 'x', x: T0 / 1000 + 600 });
  L = await fresh();
  assert.match((await callback(L.env, L.net, { state: 'x', flow: other })).location, /flow_expired$/);
  const sess = await sealSession(SECRET, { eid: 'a'.repeat(64), handle: '', created: '', issuer: W.ISSUER }, T0);
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: sess })).location, /flow_expired$/);
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), cookies: `${FLOW_COOKIE}=${L.flow}; ${FLOW_COOKIE}=${L.flow}` })).location, /flow_expired$/);
  assert.equal(tokenCalls(L.net).length, 0);
});

test('state, iss and error are checked before any token request', async () => {
  let L = await login();
  assert.match((await callback(L.env, L.net, { state: 'wrong', flow: L.flow })).location, /state_mismatch$/);
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow, iss: null })).location, /issuer_mismatch$/);
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow, iss: 'https://evil.fixture.dev' })).location, /issuer_mismatch$/);
  const denied = await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow, error: 'access_denied' });
  assert.match(denied.location, /bluesky-error=denied$/);
  assert.deepEqual(denied.logged, [], 'a cancelled sign-in is not logged');
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow, error: 'server_error' })).location, /as_error$/);
  assert.equal(tokenCalls(L.net).length, 0);
  // What is logged is the code alone: no state, code, DID, handle or self-hosted issuer.
  const bad = await callback(L.env, L.net, { state: 'wrong', flow: L.flow });
  assert.deepEqual(bad.logged, [['bluesky callback', 'state_mismatch']]);
});

test('a sub mismatch, or a re-resolution naming another AS, revokes and sets no session', async () => {
  const subNet = fakeNetwork({ 'auth.fixture.dev/oauth/token': () => json({ access_token: W.ACCESS, refresh_token: W.REFRESH, token_type: 'DPoP', scope: 'atproto', sub: W.DID2 }, 200, { 'DPoP-Nonce': 'n9' }) });
  let L = await login({ net: subNet });
  let cb = await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow });
  assert.match(cb.location, /account_mismatch$/);
  assert.equal(L.net.state.revokes.length, 2, 'revoked even on failure');
  assert.equal(cb.cookies.length, 1, 'only the flow clear');
  assert.match(cb.cookies[0], /^siren_bsky_flow=;/);

  let prm = 0;
  const moved = fakeNetwork({ 'pds.fixture.dev/.well-known/oauth-protected-resource': () => json({ resource: W.PDS, authorization_servers: [prm++ === 0 ? W.ISSUER : 'https://other.fixture.dev'] }) });
  L = await login({ net: moved });
  cb = await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow });
  assert.match(cb.location, /issuer_mismatch$/);
  assert.equal(L.net.state.revokes.length, 2);
  assert.equal(cb.cookies.length, 1);
});

test('token responses: no DPoP-Nonce fails; a token-endpoint nonce retry succeeds', async () => {
  const bare = fakeNetwork({ 'auth.fixture.dev/oauth/token': () => json({ access_token: 'a', token_type: 'DPoP', scope: 'atproto', sub: W.DID }) });
  let L = await login({ net: bare });
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow })).location, /token_failed$/);
  let n = 0;
  const retry = fakeNetwork({
    'auth.fixture.dev/oauth/token': () => (n++ === 0
      ? json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'nonce-fresh' })
      : json({ access_token: 'a', refresh_token: 'r', token_type: 'DPoP', scope: 'atproto', sub: W.DID }, 200, { 'DPoP-Nonce': 'nonce-after' })),
  });
  L = await login({ net: retry });
  assert.match((await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow })).location, /signed-in$/);
  const proofs = L.net.proofs.filter((p) => p.url.endsWith('/oauth/token'));
  assert.equal(proofs.length, 2);
  assert.equal(proofs[1].payload.nonce, 'nonce-fresh');
  assert.equal(L.net.state.revokes[0].nonce, 'nonce-after', 'the revoke carries the newest nonce');
});

test('replay: the same cookie, state, iss and code work once', async () => {
  const L = await login();
  const first = await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow });
  const second = await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow });
  assert.match(first.location, /signed-in$/);
  assert.match(second.location, /flow_expired$/);
  assert.equal(tokenCalls(L.net).length, 1);
});

test('exhausted callback limits answer busy without a fetch', async () => {
  const L = await login();
  const before = L.net.calls.length;
  const env = { ...L.env, BSKY_VISITOR_RL: fakeLimiter(0) };
  assert.match((await callback(env, L.net, { state: stateOf(L.net), flow: L.flow })).location, /busy$/);
  const env2 = { ...L.env, BSKY_SITE_RL: fakeLimiter(0) };
  assert.match((await callback(env2, L.net, { state: stateOf(L.net), flow: L.flow })).location, /busy$/);
  assert.equal(L.net.calls.length, before);
});

test('login start: bad input costs nothing; each limit refuses before any fetch', async () => {
  let env = readyEnv();
  let L = await login({ env, account: 'not a handle' });
  assert.equal(L.res.status, 400);
  assert.equal(L.body.code, 'bad_input');
  assert.equal(L.net.calls.length, 0);
  for (const b of ['BSKY_VISITOR_RL', 'BSKY_INPUT_RL', 'BSKY_ACCOUNT_RL', 'BSKY_SITE_RL']) assert.equal(env[b].calls.length, 0, b);

  for (const over of [{ BSKY_VISITOR_RL: fakeLimiter(0) }, { BSKY_INPUT_RL: fakeLimiter(0) }, { BSKY_SITE_RL: fakeLimiter(0) }, { BSKY_SITE_RL: fakeLimiter(5, { throws: true }) }]) {
    L = await login({ env: readyEnv(over) });
    assert.equal(L.res.status, 429, Object.keys(over)[0]);
    assert.equal(L.body.code, 'busy');
    assert.equal(L.net.calls.length, 0);
  }
  // When the per-visitor limit fails, the site breaker isn't touched.
  env = readyEnv({ BSKY_VISITOR_RL: fakeLimiter(0) });
  await login({ env });
  assert.equal(env.BSKY_SITE_RL.calls.length, 0);
  // The hourly per-visitor count, in KV.
  env = readyEnv({ BSKY_LOGIN_PER_VISITOR_HOURLY: '1' });
  const lv = await bskyVisitor(post('/x', {}), env, 'bsky-login');
  await env.LIMITS.put(`bsky-ev:${new Date(T0).toISOString().slice(0, 13)}:v:${lv}:x`, '');
  L = await login({ env });
  assert.equal(L.res.status, 429);
  assert.equal(L.net.calls.length, 0);
});

test('login start: origin, AS checks, cookie size and the deadline', async () => {
  let L = await login({ reqOpts: { host: 'https://siren.fixture.dev' } });
  assert.equal(L.res.status, 403);
  L = await login({ reqOpts: { origin: 'https://evil.fixture.dev' } });
  assert.equal(L.res.status, 403);
  L = await login({ reqOpts: { origin: ORIGIN } });
  assert.equal(L.res.status, 200);

  L = await login({ net: fakeNetwork({ 'auth.fixture.dev/.well-known/oauth-authorization-server': () => json(asMeta('https://evil.fixture.dev')) }) });
  assert.equal(L.body.code, 'issuer_mismatch');
  L = await login({ net: fakeNetwork({ 'auth.fixture.dev/.well-known/oauth-authorization-server': () => json(asMeta(W.ISSUER, { token_endpoint: 'https://other.fixture.dev/token' })) }) });
  assert.equal(L.body.code, 'as_unsupported');
  assert.ok(!L.net.calls.some((c) => c.url.endsWith('/oauth/par')), 'refused before PAR');

  L = await login({ deps: { maxCookieBytes: 500 } });
  assert.equal(L.body.code, 'as_unsupported');
  assert.equal(L.res.headers.get('Set-Cookie'), null);

  const hung = fakeNetwork({ 'dns.fixture.dev/dns-query': (u, init) => hang(init.signal), [`${W.HANDLE}/.well-known/atproto-did`]: (u, init) => hang(init.signal) });
  // AbortSignal.timeout's timer doesn't hold Node's event loop open; this does.
  const keepAlive = setTimeout(() => {}, 2000);
  L = await login({ net: hung, deps: { timeoutMs: 50 } });
  clearTimeout(keepAlive);
  assert.equal(L.res.status, 504);
  assert.equal(L.body.code, 'timeout');
});

test('a DID typed in signs in, showing the handle only if it resolves back', async () => {
  const L = await login({ account: W.DID });
  assert.equal(L.res.status, 200);
  const cb = await callback(L.env, L.net, { state: stateOf(L.net), flow: L.flow });
  assert.equal((await openSession(SECRET, cookieValue(cb.cookies[0], BSKY_COOKIE), T0 + 6000)).handle, W.HANDLE);
  assert.equal(L.net.state.par[0].form.login_hint, W.DID);
});

test('session cookies: sealed, scoped, short, and unforgeable from other cookies', async () => {
  const value = await sealSession(SECRET, { eid: 'e'.repeat(64), handle: W.HANDLE, created: '2025-01-02', issuer: W.ISSUER }, T0);
  assert.ok(await openSession(SECRET, value, T0));
  assert.ok(await openSession(SECRET, value, T0 + 86400e3));
  assert.equal(await openSession(SECRET, value, T0 + 86401e3), null, 'expired');
  const i = Math.floor(value.length / 2);
  assert.equal(await openSession(SECRET, value.slice(0, i) + (value[i] === 'A' ? 'B' : 'A') + value.slice(i + 1), T0), null, 'tampered');
  assert.equal(await openSession('another-secret-entirely', value, T0), null, 'wrong secret');
  assert.equal(await openSession(SECRET, await signSession(SECRET, 'a'.repeat(64), T0), T0), null, 'an invite cookie');
  const uid = await userId(SECRET, 'n@example.org');
  assert.equal(await openSession(SECRET, await signUser(SECRET, uid, T0), T0), null, 'an email account cookie');
  assert.equal(await verifyUser(SECRET, value, T0), null, 'a Bluesky session is not an account cookie');
  assert.match(sessionCookie(value, BASE), /^siren_bsky=[^;]+; Path=\/ask-siren\/api\/bsky\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.ok(!'/ask-siren/api/ask'.startsWith('/ask-siren/api/bsky/'));
});

async function signedInCookie(over = {}) {
  return `${BSKY_COOKIE}=${await sealSession(SECRET, { eid: await hmacHex(SECRET, `endorser:${W.DID}`), handle: W.HANDLE, created: '2025-01-02', issuer: W.ISSUER, ...over }, Date.now())}`;
}

const LIST = { requests: [{ id: 'aaaaaaaaaaaa', status: 'accepted', source: 'A' }, { id: 'bbbbbbbbbbbb', status: 'fulfilled', source: 'B' }], awaiting_review: 0 };

test('me: off, signed out (no KV), signed in (accepted public ids only, counted by policy)', async () => {
  let res = await handleMe(get('/api/bsky/me'), {}, null, BASE);
  assert.deepEqual(await res.json(), { bluesky: { available: false }, endorsed: [] });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  const env = readyEnv();
  res = await handleMe(get('/api/bsky/me'), env, null, BASE, { publicList: LIST });
  const out = await res.json();
  assert.equal(out.bluesky.available, true);
  assert.equal(out.bluesky.signed_in, false);
  assert.equal(env.LIMITS.ops.length, 0, 'signed out touches no KV');
  assert.equal(env.BSKY_ACCOUNT_RL.calls.length, 0);

  const { endorsementKey } = await import('../worker/endorsements.js');
  const eid = await hmacHex(SECRET, `endorser:${W.DID}`);
  for (const id of ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc']) await env.LIMITS.put(await endorsementKey(SECRET, id, eid), '1', { metadata: { y: 0 } });
  res = await handleMe(get('/api/bsky/me', { cookie: await signedInCookie() }), env, null, BASE, { publicList: LIST });
  const me = await res.json();
  assert.deepEqual(me.endorsed, ['aaaaaaaaaaaa']);
  assert.equal(me.bluesky.handle, W.HANDLE);
  assert.equal(me.bluesky.counted, true);
  const young = await (await handleMe(get('/api/bsky/me', { cookie: await signedInCookie({ created: new Date().toISOString().slice(0, 10) }) }), env, null, BASE, { publicList: LIST })).json();
  assert.equal(young.bluesky.counted, false);
  const all = await (await handleMe(get('/api/bsky/me', { cookie: await signedInCookie({ created: '' }) }), { ...env, ENDORSE_PUBLIC: 'all' }, null, BASE, { publicList: LIST })).json();
  assert.equal(all.bluesky.counted, true);
  // Two session cookies mean signed out, and Siren clears its own.
  res = await handleMe(get('/api/bsky/me', { cookie: `${await signedInCookie()}; ${await signedInCookie()}` }), env, null, BASE, { publicList: LIST });
  assert.equal((await res.json()).bluesky.signed_in, false);
  assert.match(res.headers.get('Set-Cookie'), /^siren_bsky=; Path=\/ask-siren\/api\/bsky\/; Max-Age=0/);
});

test('every new POST refuses a foreign Origin, and all are 404 with the flag off', async () => {
  const env = readyEnv();
  const cookie = await signedInCookie();
  const calls = [
    [handleLogin, '/api/bsky/login', { account: W.HANDLE }],
    [handleEndorse, '/api/bsky/endorse', { id: 'aaaaaaaaaaaa' }],
    [handleUnendorse, '/api/bsky/unendorse', { id: 'aaaaaaaaaaaa' }],
    [handleForget, '/api/bsky/forget', {}],
    [(req, e, ctx, base) => handleLogout(req, e, base), '/api/bsky/logout', {}],
  ];
  for (const [fn, path, body] of calls) {
    const res = await fn(post(path, body, { origin: 'https://evil.fixture.dev', cookie }), env, null, BASE, { fetchImpl: fakeNetwork().fetch, publicList: LIST });
    assert.equal(res.status, 403, path);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
    const off = await fn(post(path, body, { cookie }), { ...env, BLUESKY_LOGIN: undefined }, null, BASE, { publicList: LIST });
    assert.equal(off.status, 404, `${path} off`);
  }
  assert.equal((await handleCallback(get('/oauth/callback?state=x'), { ...env, BLUESKY_LOGIN: 'false' }, null, BASE)).status, 404);
});

test('logout clears only the Bluesky cookie; signed-out endorse is a 401', async () => {
  const env = readyEnv();
  const res = await handleLogout(post('/api/bsky/logout', {}, { origin: ORIGIN }), env, BASE);
  assert.deepEqual(res.headers.getSetCookie(), ['siren_bsky=; Path=/ask-siren/api/bsky/; Max-Age=0; HttpOnly; Secure; SameSite=Lax']);
  const r401 = await handleEndorse(post('/api/bsky/endorse', { id: 'aaaaaaaaaaaa' }), env, null, BASE, { publicList: LIST });
  assert.equal(r401.status, 401);
  assert.equal((await r401.json()).code, 'signed_out');
});
