// atproto OAuth client pieces: metadata checks, PKCE, DPoP, PAR, tokens, revoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientIds, clientMetadata, authServerFor, authServerMetadata, pkce, newDpopKey, dpopProof, dpopPost,
  pushAuthorization, checkTokenResponse, revokeAll, exchangeCode, authorizeUrl, publicOrigin,
} from '../worker/atproto-oauth.js';
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
  };
  for (const [field, value] of Object.entries(required)) {
    await assert.rejects(authServerMetadata(W.ISSUER, withMeta(asMeta(W.ISSUER, { [field]: value }))), { code: 'as_unsupported' }, `${field} wrong`);
    const m = asMeta();
    delete m[field];
    if (field !== 'response_types_supported') await assert.rejects(authServerMetadata(W.ISSUER, withMeta(m)), { code: 'as_unsupported' }, `${field} missing`);
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

test('DPoP proofs are ES256 JWTs that verify with their own public key', async () => {
  const { jwk } = await newDpopKey();
  assert.deepEqual(Object.keys(jwk).sort(), ['d', 'x', 'y']);
  const now = Date.now();
  const p1 = await dpopProof({ jwk, htm: 'POST', htu: 'https://auth.fixture.dev/oauth/par?x=1#frag', now });
  const p2 = await dpopProof({ jwk, htm: 'POST', htu: 'https://auth.fixture.dev/oauth/par', nonce: 'n-1', now });
  const d1 = decodeJwt(p1);
  assert.equal(d1.header.typ, 'dpop+jwt');
  assert.equal(d1.header.alg, 'ES256');
  assert.equal(d1.header.jwk.d, undefined, 'never the private part');
  assert.deepEqual(Object.keys(d1.header.jwk).sort(), ['crv', 'kty', 'x', 'y']);
  assert.equal(d1.payload.htm, 'POST');
  assert.equal(d1.payload.htu, 'https://auth.fixture.dev/oauth/par');
  assert.ok(Math.abs(d1.payload.iat - now / 1000) < 2);
  assert.equal('nonce' in d1.payload, false);
  assert.equal(decodeJwt(p2).payload.nonce, 'n-1');
  assert.notEqual(d1.payload.jti, decodeJwt(p2).payload.jti);
  assert.equal(d1.payload.iss, undefined);
  assert.equal(d1.payload.ath, undefined);
  assert.ok(await verifyProof(p1));
  assert.ok(await verifyProof(p2));
  // The compact { x, y, d } survives a round trip through JSON (the sealed flow).
  const again = JSON.parse(JSON.stringify(jwk));
  assert.ok(await verifyProof(await dpopProof({ jwk: again, htm: 'POST', htu: 'https://auth.fixture.dev/oauth/token' })));
});

const PAR_ARGS = async (net) => ({
  meta: asMeta(), clientId: 'https://jason-edelman.org/ask-siren/oauth-client-metadata.json', redirectUri: 'https://jason-edelman.org/ask-siren/oauth/callback',
  state: 'state-1', challenge: 'chal-1', loginHint: W.HANDLE, jwk: (await newDpopKey()).jwk, fetchImpl: net.fetch,
});

test('PAR retries once on use_dpop_nonce with the nonce, the same key and a new jti', async () => {
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
  assert.deepEqual(Object.keys(form).sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'login_hint', 'redirect_uri', 'response_type', 'scope', 'state']);
  assert.equal(form.scope, 'atproto');
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
  await assert.rejects(dpopPost(`${W.ISSUER}/oauth/par`, {}, { jwk: (await newDpopKey()).jwk, fetchImpl: direct.fetch }), { code: 'dpop_nonce' });
});

test('token responses must be DPoP, carry atproto, and name the bound DID', () => {
  const good = { token_type: 'DPoP', scope: 'atproto transition:generic', sub: W.DID };
  checkTokenResponse(good, W.DID);
  checkTokenResponse({ ...good, token_type: 'dpop' }, W.DID);
  assert.throws(() => checkTokenResponse({ ...good, token_type: 'Bearer' }, W.DID), { code: 'token_type' });
  assert.throws(() => checkTokenResponse({ ...good, scope: undefined }, W.DID), { code: 'scope_missing' });
  assert.throws(() => checkTokenResponse({ ...good, scope: 'transition:generic' }, W.DID), { code: 'scope_missing' });
  assert.throws(() => checkTokenResponse({ ...good, sub: W.DID2 }, W.DID), { code: 'account_mismatch' });
  assert.throws(() => checkTokenResponse({ ...good, sub: 'did:plc:NOTVALID' }, 'did:plc:NOTVALID'), { code: 'account_mismatch' });
});

test('the token request carries the verifier and nonce; a missing final nonce fails', async () => {
  const net = fakeNetwork();
  const { jwk } = await newDpopKey();
  const out = await exchangeCode({ tokenEndpoint: `${W.ISSUER}/oauth/token`, code: W.CODE, verifier: 'v', clientId: 'c', redirectUri: 'r', jwk, nonce: 'nonce-par-2', fetchImpl: net.fetch });
  assert.equal(out.token.sub, W.DID);
  assert.equal(net.state.tokens[0].nonce, 'nonce-par-2');
  assert.equal(net.state.tokens[0].form.code_verifier, 'v');
  const bare = fakeNetwork({ 'auth.fixture.dev/oauth/token': () => json({ access_token: 'a', token_type: 'DPoP', scope: 'atproto', sub: W.DID }) });
  await assert.rejects(exchangeCode({ tokenEndpoint: `${W.ISSUER}/oauth/token`, code: 'c', verifier: 'v', clientId: 'c', redirectUri: 'r', jwk, nonce: 'n', fetchImpl: bare.fetch }), { code: 'token_failed' });
});

test('client metadata: the client_id is its own URL, identity scope only, no refresh grant', () => {
  const env = { PUBLIC_ORIGIN: 'https://jason-edelman.org' };
  const ids = clientIds(env, '/ask-siren');
  const m = clientMetadata({ ...ids, appName: 'Siren' });
  assert.equal(m.client_id, 'https://jason-edelman.org/ask-siren/oauth-client-metadata.json');
  assert.deepEqual(m.redirect_uris, ['https://jason-edelman.org/ask-siren/oauth/callback']);
  assert.equal(m.scope, 'atproto');
  assert.equal(m.token_endpoint_auth_method, 'none');
  assert.equal(m.dpop_bound_access_tokens, true);
  assert.deepEqual(m.grant_types, ['authorization_code']);
  assert.equal(new URL(m.client_uri).hostname, new URL(m.client_id).hostname);
  const local = clientIds({ PUBLIC_ORIGIN: 'http://127.0.0.1:8787' }, '/ask-siren');
  assert.equal(local.clientId, `http://localhost?redirect_uri=${encodeURIComponent('http://127.0.0.1:8787/ask-siren/oauth/callback')}&scope=atproto`);
  assert.equal(local.redirectUri, 'http://127.0.0.1:8787/ask-siren/oauth/callback');
  assert.ok(local.loopback);
  for (const bad of ['', 'https://jason-edelman.org/', 'https://jason-edelman.org:443', 'http://jason-edelman.org', 'http://localhost:8787', 'https://10.0.0.1', 'https://jason-edelman.org/ask-siren']) {
    assert.equal(publicOrigin({ PUBLIC_ORIGIN: bad }), null, bad);
  }
});

test('revokeAll revokes refresh then access with a proof each, carrying the nonce; never throws', async () => {
  const net = fakeNetwork();
  const { jwk } = await newDpopKey();
  await revokeAll({ revocationEndpoint: `${W.ISSUER}/oauth/revoke`, token: { access_token: W.ACCESS, refresh_token: W.REFRESH }, clientId: 'c', jwk, nonce: 'nonce-tok-2', fetchImpl: net.fetch });
  assert.deepEqual(net.state.revokes.map((r) => [r.form.token_type_hint, r.form.token]), [['refresh_token', W.REFRESH], ['access_token', W.ACCESS]]);
  assert.deepEqual(net.state.revokes.map((r) => r.nonce), ['nonce-tok-2', 'nonce-rev-1']);
  assert.equal(net.proofs.length, 2);
  const broken = fakeNetwork({ 'auth.fixture.dev/oauth/revoke': () => new Response('boom', { status: 500 }) });
  await revokeAll({ revocationEndpoint: `${W.ISSUER}/oauth/revoke`, token: { access_token: 'a', refresh_token: 'r' }, clientId: 'c', jwk, fetchImpl: broken.fetch });
  await revokeAll({ revocationEndpoint: `${W.ISSUER}/oauth/revoke`, token: { access_token: 'a' }, clientId: 'c', jwk, fetchImpl: async () => { throw new Error('network down'); } });
});
