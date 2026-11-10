// The browser's endorse client (worker/endorse-client.js), run in Node
// against the fake network and the in-memory store: sign-in with PAR, PKCE
// and DPoP, the fragment return and its checks, the granted-scope check, and
// writes to the person's own PDS with ath and a nonce of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, workerResolver, MESSAGES, SESSION_MS } from '../worker/endorse-client.js';
import { memoryStore } from '../worker/endorse-store.js';
import { handleResolve, handleMetadata } from '../worker/bluesky.js';
import { ENDORSE_NSID, OAUTH_SCOPE, endorseSubject, buildEndorsement } from '../worker/endorse-config.js';
import { b64url, sha256 } from '../worker/crypto.js';
import { W, json, didDoc, asMeta, fakeNetwork, fakeLimiter, readyEnv } from './fake-atproto.js';

const ORIGIN = 'https://ask-siren.jason-edelman.org';
const BASE = '';
const ID = 'abcdefghijklmnop';
const ID2 = 'qrstuvwxyz234567';

function setup({ net = fakeNetwork(), now = Date.parse('2026-11-09T12:00:00Z'), resolveFallback } = {}) {
  const store = memoryStore();
  const clock = { t: now };
  const client = createClient({ origin: ORIGIN, base: BASE, store, fetchImpl: net.fetch, now: () => clock.t, resolveFallback, dohUrl: W.DOH, plcUrl: W.PLC });
  return { net, store, clock, client };
}

// Sign in, and play the authorization server's redirect back to the page.
async function signedIn(w, { account = W.HANDLE, after = null, iss = W.ISSUER } = {}) {
  const url = await w.client.signIn(account, after);
  const par = w.net.state.par.at(-1).form;
  const out = await w.client.finish(`#state=${encodeURIComponent(par.state)}&iss=${encodeURIComponent(iss)}&code=${W.CODE}${w.net.state.par.length}`);
  return { url, par, out };
}

test('sign-in: browser resolution, PAR with PKCE, the narrow scope and the fragment; a non-extractable key in the store', async () => {
  const w = setup();
  const url = await w.client.signIn(W.HANDLE, ID);
  assert.ok(url.startsWith(`${W.ISSUER}/oauth/authorize?client_id=${encodeURIComponent(`${ORIGIN}${BASE}/endorse-client-metadata.json`)}`));
  const form = w.net.state.par[0].form;
  assert.equal(form.scope, OAUTH_SCOPE);
  assert.equal(form.response_mode, 'fragment');
  assert.equal(form.redirect_uri, `${ORIGIN}${BASE}/requests`);
  assert.equal(form.code_challenge_method, 'S256');
  assert.equal(form.login_hint, W.HANDLE);
  const [flow] = [...w.store.flows.values()];
  assert.equal(flow.state, form.state);
  assert.equal(flow.key.privateKey.extractable, false);
  assert.equal(flow.after, ID);
  assert.equal(b64url(await sha256(flow.verifier)), form.code_challenge);
  assert.ok(!w.net.calls.some((c) => c.url.startsWith(ORIGIN)), 'nothing went to Siren');
});

test('the return: state, iss and expiry are checked before any token request', async () => {
  for (const [name, frag, code] of [
    ['unknown state', (s) => `#state=nope&iss=${W.ISSUER}&code=c`, 'flow_expired'],
    ['wrong issuer', (s) => `#state=${s}&iss=https://evil.fixture.dev&code=c`, 'issuer_mismatch'],
    ['no issuer', (s) => `#state=${s}&code=c`, 'issuer_mismatch'],
    ['denied', (s) => `#state=${s}&iss=${W.ISSUER}&error=access_denied`, 'denied'],
    ['other error', (s) => `#state=${s}&iss=${W.ISSUER}&error=server_error`, 'as_error'],
    ['long code', (s) => `#state=${s}&iss=${W.ISSUER}&code=${'c'.repeat(3000)}`, 'as_error'],
  ]) {
    const w = setup();
    await w.client.signIn(W.HANDLE);
    const state = w.net.state.par[0].form.state;
    await assert.rejects(w.client.finish(frag(encodeURIComponent(state))), { code }, name);
    assert.equal(w.net.state.tokens.length, 0, `${name}: no token request`);
    assert.equal(await w.store.getSession(), null);
  }
  // Expired: 10 minutes.
  const w = setup();
  await w.client.signIn(W.HANDLE);
  const state = w.net.state.par[0].form.state;
  w.clock.t += 11 * 60e3;
  await assert.rejects(w.client.finish(`#state=${state}&iss=${W.ISSUER}&code=c`), { code: 'flow_expired' });
  // Used once: the flow is gone after a first return.
  const w2 = setup();
  const { par } = await signedIn(w2);
  await assert.rejects(w2.client.finish(`#state=${par.state}&iss=${W.ISSUER}&code=again`), { code: 'flow_expired' });
  assert.equal(await setup().client.finish('#bluesky=signed-in'), null, 'not a sign-in return');
});

test('a happy return keeps a 24-hour session in the browser only', async () => {
  const w = setup();
  const { out } = await signedIn(w, { after: ID });
  assert.deepEqual(out, { handle: W.HANDLE, did: W.DID, after: ID });
  const s = await w.store.getSession();
  assert.equal(s.accessToken, W.ACCESS);
  assert.equal(s.did, W.DID);
  assert.equal(s.pds, W.PDS);
  assert.equal(s.expires, w.clock.t + SESSION_MS);
  assert.equal(s.tokenExpires, w.clock.t + 300e3);
  assert.deepEqual(await w.client.current(), { did: W.DID, handle: W.HANDLE, tokenLive: true });
  w.clock.t += SESSION_MS + 1;
  assert.equal(await w.client.current(), null);
  assert.equal(await w.store.getSession(), null, 'deleted on load once past 24 hours');
});

test('a server that grants less than the repo scope: the token is revoked and nothing is kept', async () => {
  const w = setup();
  w.net.state.grantedScope = 'atproto';
  await assert.rejects(signedIn(w), { code: 'scope_narrow' });
  assert.equal(await w.store.getSession(), null);
  assert.deepEqual(w.net.state.revokes.map((r) => r.form.token), [W.ACCESS]);
  assert.match(MESSAGES.scope_narrow, /narrow permission/);
});

test('a sub mismatch, or a re-resolution naming another AS, revokes and keeps nothing', async () => {
  const w = setup({ net: fakeNetwork({ 'auth.fixture.dev/oauth/token': () => json({ access_token: W.ACCESS, token_type: 'DPoP', scope: OAUTH_SCOPE, sub: W.DID2, expires_in: 300 }, 200, { 'DPoP-Nonce': 'n' }) }) });
  await assert.rejects(signedIn(w), { code: 'account_mismatch' });
  assert.equal(w.net.state.revokes.length, 1);
  assert.equal(await w.store.getSession(), null);
  let moved = false;
  const w2 = setup({ net: fakeNetwork({ 'pds.fixture.dev/.well-known/oauth-protected-resource': () => json({ resource: W.PDS, authorization_servers: [moved ? 'https://other.fixture.dev' : W.ISSUER] }) }) });
  await w2.client.signIn(W.HANDLE);
  moved = true;
  await assert.rejects(w2.client.finish(`#state=${w2.net.state.par[0].form.state}&iss=${W.ISSUER}&code=c`), { code: 'issuer_mismatch' });
  assert.equal(w2.net.state.revokes.length, 1);
  assert.equal(await w2.store.getSession(), null);
});

test('endorse: createRecord on the own PDS with the token, ath, and a PDS nonce kept apart from the AS nonce', async () => {
  const w = setup();
  await signedIn(w);
  const out = await w.client.endorse({ id: ID, source: 'Tree inventory' });
  assert.deepEqual(out, { ok: true, already: false });
  const writes = w.net.proofs.filter((p) => p.url.endsWith('createRecord'));
  assert.equal(writes.length, 2, 'one retry for the PDS nonce');
  assert.equal(writes[0].payload.nonce, undefined, 'the AS nonce is never sent to the PDS');
  assert.equal(writes[1].payload.nonce, 'nonce-pds-1');
  assert.equal(writes[1].payload.ath, b64url(await sha256(W.ACCESS)));
  const s = await w.store.getSession();
  assert.equal(s.pdsNonce, 'nonce-pds-1');
  assert.equal(s.asNonce, 'nonce-tok-2', 'the AS nonce is unchanged');
  const [wr] = w.net.state.pdsWrites;
  assert.equal(wr.body.collection, ENDORSE_NSID);
  assert.equal(wr.body.rkey, ID);
  assert.equal(wr.body.repo, W.DID);
  assert.equal('validate' in wr.body, false);
  assert.equal(wr.body.record.subject.uri, endorseSubject(ORIGIN, BASE, ID));
  assert.equal(wr.body.record.subject.title, 'Tree inventory');
  // Again: the PDS says it exists; the record is this endorsement, so that's success.
  assert.deepEqual(await w.client.endorse({ id: ID, source: 'Tree inventory' }), { ok: true, already: true });
  assert.ok(!w.net.calls.some((c) => c.url.startsWith(ORIGIN)), 'no token ever goes to Siren');
  await assert.rejects(w.client.endorse({ id: 'abcdefabcdef', source: 'x' }), { code: 'not_listed' }, 'legacy ids are never subjects');
});

test('withdraw is idempotent and catches records other tools wrote; endorsedIds reads the own repo without a token', async () => {
  const w = setup();
  await signedIn(w);
  await w.client.endorse({ id: ID, source: 'A' });
  await w.client.endorse({ id: ID2, source: 'B' });
  w.net.state.putRecord(W.DID, ENDORSE_NSID, '3kotherkey', buildEndorsement({ subject: endorseSubject(ORIGIN, BASE, ID), id: ID }));
  assert.deepEqual([...(await w.client.endorsedIds([ID, ID2, 'zzzzzzzzzzzzzzzz']))].sort(), [ID, ID2].sort());
  const lists = w.net.calls.filter((c) => c.url.includes('listRecords'));
  assert.ok(lists.every((c) => !c.headers.Authorization), 'read without a token');
  const out = await w.client.withdraw(ID);
  assert.equal(out.removed, 2);
  assert.deepEqual([...(await w.client.endorsedIds([ID, ID2]))], [ID2]);
  assert.ok((await w.client.withdraw(ID)).ok, 'withdrawing again is fine');
});

test('remove all: every page of the own records, deleted in batches', async () => {
  const w = setup();
  await signedIn(w);
  for (let i = 0; i < 130; i++) w.net.state.putRecord(W.DID, ENDORSE_NSID, `k${i}`, buildEndorsement({ subject: `${ORIGIN}${BASE}/requests/x${i}`, id: `x${i}` }), { index: false });
  w.net.state.putRecord(W.DID, 'app.bsky.feed.post', 'p1', { text: 'not ours' }, { index: false });
  const out = await w.client.removeAll();
  assert.equal(out.removed, 130);
  const batches = w.net.state.pdsWrites.filter((x) => x.method === 'applyWrites');
  assert.deepEqual(batches.map((b) => b.body.writes.length), [50, 50, 30]);
  assert.ok(batches.every((b) => b.body.writes.every((x) => x.collection === ENDORSE_NSID && x.$type === 'com.atproto.repo.applyWrites#delete')));
  assert.equal(w.net.state.repos.get(W.DID).get(ENDORSE_NSID).size, 0);
  assert.equal(w.net.state.repos.get(W.DID).get('app.bsky.feed.post').size, 1, 'nothing outside the collection');
});

test('an expired token asks for a sign-in again; sign out revokes and forgets', async () => {
  const w = setup();
  await signedIn(w);
  w.clock.t += 301e3;
  await assert.rejects(w.client.endorse({ id: ID, source: 'A' }), { code: 'reauth' });
  // Silent re-authorization: PAR with the DID as login_hint.
  await w.client.signIn(W.DID, ID);
  assert.equal(w.net.state.par.at(-1).form.login_hint, W.DID);
  await w.client.signOut();
  assert.equal(await w.store.getSession(), null);
  assert.equal(w.net.state.revokes.at(-1).form.token, W.ACCESS);
  await assert.rejects(w.client.endorse({ id: ID, source: 'A' }), { code: 'signed_out' });
});

test('a handle the browser cannot resolve goes to the Worker for the DID only; the browser still checks the document', async () => {
  const net = fakeNetwork({ 'dns.fixture.dev/dns-query': () => json({ Status: 3 }), [`${W.HANDLE}/.well-known/atproto-did`]: () => { throw new TypeError('blocked by CORS'); } });
  let asked = null;
  const w = setup({ net, resolveFallback: async (h) => { asked = h; return { did: W.DID, pds: 'https://evil.fixture.dev' }; } });
  await w.client.signIn(W.HANDLE);
  assert.equal(asked, W.HANDLE);
  assert.equal([...w.store.flows.values()][0].pds, W.PDS, "the PDS comes from the browser's own read of the DID document");
  const liar = setup({ net: fakeNetwork({ 'dns.fixture.dev/dns-query': () => json({ Status: 3 }), [`${W.HANDLE}/.well-known/atproto-did`]: () => new Response('', { status: 404 }) }), resolveFallback: async () => ({ did: W.DID2 }) });
  liar.net.state.didDocs.set(W.DID2, didDoc({ did: W.DID2, handle: 'someone.else.dev' }));
  await assert.rejects(liar.client.signIn(W.HANDLE), { code: 'handle_mismatch' });
});

test('the Worker resolver: public data only, nothing stored, rate-limited, Origin-checked', async () => {
  const env = readyEnv();
  const net = fakeNetwork();
  const before = env.LIMITS.ops.length;
  const req = (body, headers = {}) => new Request(`${ORIGIN}${BASE}/api/bsky/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers }, body: JSON.stringify(body) });
  const ok = await handleResolve(req({ account: W.HANDLE }), env, { fetchImpl: net.fetch });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { did: W.DID, handle: W.HANDLE, pds: W.PDS });
  assert.equal(ok.headers.get('Set-Cookie'), null);
  assert.equal(env.LIMITS.ops.length, before, 'no storage touched');
  assert.equal((await handleResolve(req({ account: 'not a handle' }), env, { fetchImpl: net.fetch })).status, 400);
  assert.equal((await handleResolve(req({ account: W.HANDLE }, { Origin: 'https://evil.example' }), env, { fetchImpl: net.fetch })).status, 403);
  const limited = readyEnv({ BSKY_INPUT_RL: fakeLimiter(0) });
  const n = net.calls.length;
  assert.equal((await handleResolve(req({ account: W.HANDLE }), limited, { fetchImpl: net.fetch })).status, 429);
  assert.equal(net.calls.length, n, 'refused before any fetch');
  assert.equal((await handleResolve(req({ account: W.HANDLE }), { ...env, BLUESKY_LOGIN: undefined }, { fetchImpl: net.fetch })).status, 404);
  // The browser side of it.
  const r = workerResolver(BASE, async (url, init) => handleResolve(new Request(`${ORIGIN}${url}`, init), env, { fetchImpl: net.fetch }));
  assert.deepEqual(await r(W.HANDLE), { did: W.DID });
});

test('the metadata route serves the client_id document with the constant scope, flag or not', async () => {
  const res = handleMetadata(new Request(`${ORIGIN}${BASE}/endorse-client-metadata.json`), { PUBLIC_ORIGIN: ORIGIN }, BASE, 'Siren');
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.client_id, `${ORIGIN}${BASE}/endorse-client-metadata.json`);
  assert.equal(m.scope, OAUTH_SCOPE);
  assert.equal(handleMetadata(new Request(`${ORIGIN}/x`), {}, BASE).status, 404);
});
