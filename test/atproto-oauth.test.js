// atproto OAuth client pieces, run by the browser: metadata checks, PKCE,
// DPoP with a non-extractable key and ath, PAR, tokens and the granted
// scope, revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientIds, clientMetadata, authServerFor, authServerMetadata, pkce, newDpopKey, dpopProof, dpopPost,
  pushAuthorization, checkTokenResponse, revokeTokens, exchangeCode, authorizeUrl, publicOrigin, grantsEndorse,
} from '../worker/atproto-oauth.js';
import { OAUTH_SCOPE, ENDORSE_SCOPE, ENDORSE_NSID } from '../worker/endorse-config.js';
import { b64url, sha256, enc, unb64url } from '../worker/crypto.js';
import { W, json, asMeta, fakeNetwork, decodeJwt, thumbprint } from './fake-atproto.js';

const PRM = 'pds.fixture.dev/.well-known/oauth-protected-resource';
const ASM = 'auth.fixture.dev/.well-known/oauth-authorization-server';

test('protected-resource metadata must name this PDS and exactly one plain https AS', async () => {
  const ok = await authServerFor(W.PDS, { fetchImpl: fakeNetwork().fetch });
  assert.equal(ok, W.ISSUER);
  assert.equal(await authServerFor(W.PDS, { fetchImpl: fakeNetwork({ [PRM]: () => json({ resource: W.PDS, authorization_servers: [`${W.ISSUER}/`] }) }).fetch }), W.ISSUER);
  const bad = [
    () => json({ authorization_servers: [W.ISSUER] }),
    () => json({ resource: 'https://other.fixture.dev', authorization_servers: [W.ISSUER] }),
    () => json({ resource: W.PDS, authorization_servers: [W.ISSUER, 'https://b.fixture.dev'] }),
    () => json({ resource: W.PDS, authorization_servers: [`${W.ISSUER}/path`] }),
    () => json({ resource: W.PDS, authorization_servers: ['https://auth.fixture.dev:443'] }),
    () => json({ resource: W.PDS, authorization_servers: ['https://u:p@auth.fixture.dev'] }),
    () => json({ resource: W.PDS, authorization_servers: ['http://auth.fixture.dev'] }),
    () => json({ resource: W.PDS, authorization_servers: ['https://10.1.2.3'] }),
    () => new Response(null, { status: 204 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://pds.fixture.dev/x' } }),
    () => new Response(JSON.stringify({ resource: W.PDS, authorization_servers: [W.ISSUER] }), { headers: { 'Content-Type': 'text/plain' } }),
  ];
  for (const [i, handler] of bad.entries()) {
    await assert.rejects(authServerFor(W.PDS, { fetchImpl: fakeNetwork({ [PRM]: handler }).fetch }), { code: 'pds_unsupported' }, `case ${i}`);
  }
});

test('AS metadata is checked field by field, and every endpoint must share the issuer origin', async () => {
  const meta = await authServerMetadata(W.ISSUER, { fetchImpl: fakeNetwork().fetch });
  assert.equal(meta.token_endpoint, `${W.ISSUER}/oauth/token`);
  assert.equal(meta.revocation_endpoint, `${W.ISSUER}/oauth/revoke`);
  const withMeta = (m) => ({ fetchImpl: fakeNetwork({ [ASM]: () => json(m) }).fetch });
  await assert.rejects(authServerMetadata(W.ISSUER, withMeta(asMeta('https://evil.fixture.dev'))), { code: 'issuer_mismatch' });
  const required = {
    scopes_supported: ['transition:generic'],
    code_challenge_methods_supported: ['plain'],
    authorization_response_iss_parameter_supported: false,
    require_pushed_authorization_requests: false,
    dpop_signing_alg_values_supported: ['RS256'],
    client_id_metadata_document_supported: false,
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    response_types_supported: ['token'],
    response_modes_supported: ['query'],
  };
  for (const [field, value] of Object.entries(required)) {
    await assert.rejects(authServerMetadata(W.ISSUER, withMeta(asMeta(W.ISSUER, { [field]: value }))), { code: 'as_unsupported' }, `${field} wrong`);
    const m = asMeta();
    delete m[field];
    if (field !== 'response_types_supported' && field !== 'response_modes_supported') await assert.rejects(authServerMetadata(W.ISSUER, withMeta(m)), { code: 'as_unsupported' }, `${field} missing`);
  }
  for (const [field, value] of [
    ['token_endpoint', 'http://auth.fixture.dev/oauth/token'],
    ['token_endpoint', 'https://other.fixture.dev/oauth/token'],
    ['pushed_authorization_request_endpoint', 'https://other.fixture.dev/par'],
    ['authorization_endpoint', 'https://other.fixture.dev/authorize'],
    ['token_endpoint', `${W.ISSUER}/${'t'.repeat(256)}`],
  ]) {
    await assert.rejects(authServerMetadata(W.ISSUER, withMeta(asMeta(W.ISSUER, { [field]: value }))), { code: 'as_unsupported' }, `${field}=${value.slice(0, 40)}`);
  }
  const dropped = await authServerMetadata(W.ISSUER, withMeta(asMeta(W.ISSUER, { revocation_endpoint: 'https://other.fixture.dev/revoke' })));
  assert.equal(dropped.revocation_endpoint, undefined, 'a foreign revocation endpoint is dropped, not fatal');
});

test('PKCE: a 43-character verifier, an S256 challenge, fresh each time', async () => {
  const a = await pkce();
  const b = await pkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, b64url(await sha256(a.verifier)));
  assert.notEqual(a.verifier, b.verifier);
});

async function verifyProof(jwt) {
  const { header, signingInput, signature } = decodeJwt(jwt);
  const key = await crypto.subtle.importKey('jwk', header.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64url(signature), enc.encode(signingInput));
}

test('DPoP proofs are ES256 JWTs that verify with their own public key; the private key never leaves', async () => {
  const key = await newDpopKey();
  assert.equal(key.privateKey.extractable, false, 'non-extractable');
  await assert.rejects(crypto.subtle.exportKey('jwk', key.privateKey));
  assert.deepEqual(Object.keys(key.jwk).sort(), ['crv', 'kty', 'x', 'y']);
  const now = Date.now();
  const p1 = await dpopProof({ key, htm: 'POST', htu: 'https://auth.fixture.dev/oauth/par?x=1#frag', now });
  const p2 = await dpopProof({ key, htm: 'POST', htu: 'https://auth.fixture.dev/oauth/par', nonce: 'n-1', now });
  const d1 = decodeJwt(p1);
  assert.equal(d1.header.typ, 'dpop+jwt');
  assert.equal(d1.header.alg, 'ES256');
  assert.equal(d1.header.jwk.d, undefined, 'never the private part');
  assert.equal(d1.payload.htu, 'https://auth.fixture.dev/oauth/par');
  assert.ok(Math.abs(d1.payload.iat - now / 1000) < 2);
  assert.equal('nonce' in d1.payload, false);
  assert.equal(d1.payload.ath, undefined, 'no ath without a token');
  assert.equal(decodeJwt(p2).payload.nonce, 'n-1');
  assert.notEqual(d1.payload.jti, decodeJwt(p2).payload.jti);
  assert.ok(await verifyProof(p1));
  assert.ok(await verifyProof(p2));
  // With an access token, for the PDS: ath = base64url(SHA-256(token)).
  const p3 = decodeJwt(await dpopProof({ key, htm: 'POST', htu: `${W.PDS}/xrpc/com.atproto.repo.createRecord`, accessToken: W.ACCESS }));
  assert.equal(p3.payload.ath, b64url(await sha256(W.ACCESS)));
});

const PAR_ARGS = async (net) => ({
  meta: asMeta(), clientId: 'https://ask-siren.jason-edelman.org/endorse-client-metadata.json', redirectUri: 'https://ask-siren.jason-edelman.org/requests',
  state: 'state-1', challenge: 'chal-1', loginHint: W.HANDLE, key: await newDpopKey(), fetchImpl: net.fetch,
});

test('PAR asks for the narrow scope and the fragment, retrying once on use_dpop_nonce with the same key', async () => {
  const net = fakeNetwork();
  const args = await PAR_ARGS(net);
  const out = await pushAuthorization(args);
  assert.equal(out.requestUri, 'urn:ietf:params:oauth:request_uri:req-1');
  assert.equal(out.nonce, 'nonce-par-2');
  assert.equal(net.proofs.length, 2);
  const [a, b] = net.proofs;
  assert.equal(b.payload.nonce, 'nonce-par-1');
  assert.equal(await thumbprint(a.header.jwk), await thumbprint(b.header.jwk));
  assert.notEqual(a.payload.jti, b.payload.jti);
  const form = net.state.par[0].form;
  assert.deepEqual(Object.keys(form).sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'login_hint', 'redirect_uri', 'response_mode', 'response_type', 'scope', 'state']);
  assert.equal(form.scope, OAUTH_SCOPE);
  assert.equal(form.scope, `atproto repo:${ENDORSE_NSID}?action=create&action=delete`);
  assert.equal(form.response_mode, 'fragment', 'the code never reaches the Worker');
  assert.equal(form.code_challenge_method, 'S256');
  assert.equal(form.login_hint, W.HANDLE);
  assert.equal(form.client_secret, undefined);
  assert.equal(authorizeUrl(args.meta, args.clientId, out.requestUri), `${W.ISSUER}/oauth/authorize?client_id=${encodeURIComponent(args.clientId)}&request_uri=${encodeURIComponent(out.requestUri)}`);
});

test('PAR: 401 nonce variants retry; a second nonce error, or a bad final nonce, is refused', async () => {
  const par = (first, then) => {
    let n = 0;
    return () => (n++ === 0 ? first() : then());
  };
  const okPar = () => json({ request_uri: 'urn:x' }, 201, { 'DPoP-Nonce': 'n2' });
  for (const first of [
    () => json({ error: 'use_dpop_nonce' }, 401, { 'DPoP-Nonce': 'n1' }),
    () => new Response('', { status: 401, headers: { 'DPoP-Nonce': 'n1', 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' } }),
  ]) {
    const net = fakeNetwork({ 'auth.fixture.dev/oauth/par': par(first, okPar) });
    assert.equal((await pushAuthorization(await PAR_ARGS(net))).requestUri, 'urn:x');
  }
  const always = () => json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'n1' });
  await assert.rejects(pushAuthorization(await PAR_ARGS(fakeNetwork({ 'auth.fixture.dev/oauth/par': always }))), { code: 'as_refused' });
  const noNonce = () => json({ request_uri: 'urn:x' }, 201);
  await assert.rejects(pushAuthorization(await PAR_ARGS(fakeNetwork({ 'auth.fixture.dev/oauth/par': noNonce }))), { code: 'as_refused' });
  const longNonce = () => json({ request_uri: 'urn:x' }, 201, { 'DPoP-Nonce': 'n'.repeat(513) });
  await assert.rejects(pushAuthorization(await PAR_ARGS(fakeNetwork({ 'auth.fixture.dev/oauth/par': longNonce }))), { code: 'as_refused' });
  const direct = fakeNetwork({ 'auth.fixture.dev/oauth/par': always });
  await assert.rejects(dpopPost(`${W.ISSUER}/oauth/par`, { form: {}, key: await newDpopKey(), fetchImpl: direct.fetch }), { code: 'dpop_nonce' });
});

test('the granted scope must let Siren create and delete its records; less is refused', () => {
  assert.ok(grantsEndorse(OAUTH_SCOPE));
  assert.ok(grantsEndorse(`atproto repo:${ENDORSE_NSID}`), 'no action means all three');
  assert.ok(grantsEndorse(`atproto repo?collection=${ENDORSE_NSID}&action=delete&action=create`));
  assert.ok(grantsEndorse('atproto repo:*'));
  assert.ok(!grantsEndorse('atproto'), 'the server dropped the repo scope');
  assert.ok(!grantsEndorse(`atproto repo:${ENDORSE_NSID}?action=create`), 'create without delete');
  assert.ok(!grantsEndorse('atproto repo:app.bsky.feed.post'));
  assert.ok(!grantsEndorse('atproto repo:org.jason-edelman.*'), 'no partial wildcards');
  assert.ok(!grantsEndorse('atproto transition:generic'), 'never relied on (D3)');
  assert.equal(ENDORSE_SCOPE, `repo:${ENDORSE_NSID}?action=create&action=delete`);
});

test('token responses must be DPoP, carry atproto and the endorse scope, and name the bound DID', () => {
  const good = { token_type: 'DPoP', scope: OAUTH_SCOPE, sub: W.DID, access_token: 'a' };
  checkTokenResponse(good, W.DID);
  checkTokenResponse({ ...good, token_type: 'dpop' }, W.DID);
  assert.throws(() => checkTokenResponse({ ...good, token_type: 'Bearer' }, W.DID), { code: 'token_type' });
  assert.throws(() => checkTokenResponse({ ...good, scope: undefined }, W.DID), { code: 'scope_missing' });
  assert.throws(() => checkTokenResponse({ ...good, scope: ENDORSE_SCOPE }, W.DID), { code: 'scope_missing' });
  assert.throws(() => checkTokenResponse({ ...good, scope: 'atproto' }, W.DID), { code: 'scope_narrow' });
  assert.throws(() => checkTokenResponse({ ...good, sub: W.DID2 }, W.DID), { code: 'account_mismatch' });
  assert.throws(() => checkTokenResponse({ ...good, sub: 'did:plc:NOTVALID' }, 'did:plc:NOTVALID'), { code: 'account_mismatch' });
  assert.throws(() => checkTokenResponse({ ...good, access_token: undefined }, W.DID), { code: 'token_failed' });
});

test('the token request carries the verifier and nonce; a missing final nonce fails', async () => {
  const net = fakeNetwork();
  const key = await newDpopKey();
  const out = await exchangeCode({ tokenEndpoint: `${W.ISSUER}/oauth/token`, code: W.CODE, verifier: 'v', clientId: 'c', redirectUri: 'r', key, nonce: 'nonce-par-2', fetchImpl: net.fetch });
  assert.equal(out.token.sub, W.DID);
  assert.equal(net.state.tokens[0].nonce, 'nonce-par-2');
  assert.equal(net.state.tokens[0].form.code_verifier, 'v');
  const bare = fakeNetwork({ 'auth.fixture.dev/oauth/token': () => json({ access_token: 'a', token_type: 'DPoP', scope: OAUTH_SCOPE, sub: W.DID }) });
  await assert.rejects(exchangeCode({ tokenEndpoint: `${W.ISSUER}/oauth/token`, code: 'c', verifier: 'v', clientId: 'c', redirectUri: 'r', key, nonce: 'n', fetchImpl: bare.fetch }), { code: 'token_failed' });
});

test('client metadata: a new client_id URL, the narrow scope, the requests page as redirect, no refresh grant', () => {
  // Siren: its own origin, at the root (2026-11-10).
  const env = { PUBLIC_ORIGIN: 'https://ask-siren.jason-edelman.org' };
  const ids = clientIds(env, '');
  const m = clientMetadata({ ...ids, appName: 'Siren' });
  assert.equal(m.client_id, 'https://ask-siren.jason-edelman.org/endorse-client-metadata.json');
  assert.deepEqual(m.redirect_uris, ['https://ask-siren.jason-edelman.org/requests']);
  assert.equal(m.client_uri, 'https://ask-siren.jason-edelman.org/');
  // A deployment under a path still works.
  const under = clientIds({ PUBLIC_ORIGIN: 'https://example.org' }, '/ask-siren');
  assert.equal(under.clientId, 'https://example.org/ask-siren/endorse-client-metadata.json');
  assert.equal(under.redirectUri, 'https://example.org/ask-siren/requests');
  assert.equal(under.clientUri, 'https://example.org/ask-siren/');
  assert.equal(m.scope, OAUTH_SCOPE, 'the scope is the constant');
  assert.equal(m.token_endpoint_auth_method, 'none');
  assert.equal(m.dpop_bound_access_tokens, true);
  assert.deepEqual(m.grant_types, ['authorization_code']);
  assert.equal(m.application_type, 'web');
  assert.equal(new URL(m.client_uri).hostname, new URL(m.client_id).hostname);
  const local = clientIds({ PUBLIC_ORIGIN: 'http://127.0.0.1:8787' }, '/ask-siren');
  assert.equal(local.clientId, `http://localhost?redirect_uri=${encodeURIComponent('http://127.0.0.1:8787/ask-siren/requests')}&scope=${encodeURIComponent(OAUTH_SCOPE)}`);
  assert.ok(local.loopback);
  for (const bad of ['', 'https://jason-edelman.org/', 'https://jason-edelman.org:443', 'http://jason-edelman.org', 'http://localhost:8787', 'https://10.0.0.1', 'https://jason-edelman.org/ask-siren']) {
    assert.equal(publicOrigin({ PUBLIC_ORIGIN: bad }), null, bad);
  }
});

test('revokeTokens revokes with a proof each, carrying the nonce; never throws', async () => {
  const net = fakeNetwork();
  const key = await newDpopKey();
  await revokeTokens({ revocationEndpoint: `${W.ISSUER}/oauth/revoke`, token: { access_token: W.ACCESS, refresh_token: W.REFRESH }, clientId: 'c', key, nonce: 'nonce-tok-2', fetchImpl: net.fetch });
  assert.deepEqual(net.state.revokes.map((r) => [r.form.token_type_hint, r.form.token]), [['refresh_token', W.REFRESH], ['access_token', W.ACCESS]]);
  assert.deepEqual(net.state.revokes.map((r) => r.nonce), ['nonce-tok-2', 'nonce-rev-1']);
  const broken = fakeNetwork({ 'auth.fixture.dev/oauth/revoke': () => new Response('boom', { status: 500 }) });
  await revokeTokens({ revocationEndpoint: `${W.ISSUER}/oauth/revoke`, token: { access_token: 'a' }, clientId: 'c', key, fetchImpl: broken.fetch });
  await revokeTokens({ revocationEndpoint: `${W.ISSUER}/oauth/revoke`, token: { access_token: 'a' }, clientId: 'c', key, fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(await revokeTokens({ revocationEndpoint: null, token: { access_token: 'a' }, clientId: 'c', key, nonce: 'n' }), 'n', 'no endpoint, nothing sent');
});
