// atproto OAuth, the client side. The browser is the client (a public web
// client, token_endpoint_auth_method "none"), on the requests page: PAR,
// PKCE S256, DPoP (ES256, a non-extractable key), the code returned in the
// URL fragment, the RFC 9207 iss check, the sub check, and a check that the
// server granted the narrow repo scope Siren asked for (it may grant less
// without saying so). Two clients share it: the endorse client (the requests
// page) and, with the free tier on, the ask client (the public questions
// page, docs/free-tier.md), each with its own client_id, redirect and scope.
// The Worker uses this module only for publicOrigin, clientIds and
// clientMetadata; it never sees a token. Built on WebCrypto
// and fetch; no dependency. Pure: every call takes `fetchImpl`. Served to
// the browser as module text by index.js.
//
// Requirements from atproto.com/specs/oauth (read 2026-11-09, "as of October
// 2026"), atproto.com/specs/permission, and RFCs 9126 (PAR), 7636 (PKCE),
// 9449 (DPoP), 9207 (iss), 9728 (protected resource metadata) and 7009
// (revocation).

import { enc, b64url, randomToken, sha256 } from './crypto.js';
import { safeFetch, safeUrl, isSupportedDid } from './atproto-identity.js';
import { OAUTH_SCOPE, ENDORSE_NSID, QUESTION_NSID, ASK_CLIENT_SCOPE } from './endorse-config.js';

export class OAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OAuthError';
    this.code = code;
  }
}

export const SCOPE = OAUTH_SCOPE;
export const MAX_ENDPOINT = 256;
const MAX_NONCE = 512;
const OAUTH_BYTES = 16384;

const parseObject = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/**
 * PUBLIC_ORIGIN, checked: { origin, loopback } or null. It must be
 * `https://host` (no port, no path), or, for local dev only,
 * `http://127.0.0.1:<port>`. The client_id is never built from the Host header.
 */
export function publicOrigin(env) {
  const o = typeof env?.PUBLIC_ORIGIN === 'string' ? env.PUBLIC_ORIGIN : '';
  if (/^https:\/\/[^/:?#@\\]+$/.test(o)) {
    const u = safeUrl(o);
    return u && u.origin === o ? { origin: o, loopback: false } : null;
  }
  const m = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(o);
  if (m && Number(m[1]) <= 65535) return { origin: o, loopback: true };
  return null;
}

// The two clients: where each one's code comes back, the client_id document
// it is named by, and the scope it declares.
// The ask client also lists the requests page as a redirect: a sign-in
// there for an account whose live session holds the question permission
// goes through the ask client, so endorsing doesn't take asking away.
const CLIENTS = {
  endorse: { page: 'requests', metadata: 'endorse-client-metadata.json', scope: SCOPE, also: [] },
  ask: { page: 'questions', metadata: 'question-client-metadata.json', scope: ASK_CLIENT_SCOPE, also: ['requests'] },
};

/**
 * { clientId, redirectUri, clientUri, loopback, scope } (and, for the ask
 * client, redirectUris: every page it may come back to) or null. A new
 * client_id URL for the browser client, since servers cache client metadata
 * for an unknown time; the code comes back to the page itself. `kind` is
 * 'endorse' (the requests page; the default) or 'ask' (the public questions
 * page, a client_id of its own so the endorse client's metadata never
 * changes); `scope` is what the client declares.
 */
export function clientIds(env, base = '', { kind = 'endorse' } = {}) {
  const c = Object.hasOwn(CLIENTS, kind) ? CLIENTS[kind] : null;
  const po = publicOrigin(env);
  if (!c || !po || typeof base !== 'string' || !/^(\/[A-Za-z0-9._~-]+)*$/.test(base)) return null;
  const redirectUri = `${po.origin}${base}/${c.page}`;
  const also = c.also.map((page) => `${po.origin}${base}/${page}`);
  const extra = also.length ? { redirectUris: [redirectUri, ...also] } : {};
  if (po.loopback) {
    // The atproto localhost client: ASes synthesize its metadata.
    const redirects = [redirectUri, ...also].map((u) => `redirect_uri=${encodeURIComponent(u)}`).join('&');
    return { clientId: `http://localhost?${redirects}&scope=${encodeURIComponent(c.scope)}`, redirectUri, clientUri: null, loopback: true, scope: c.scope, ...extra };
  }
  return { clientId: `${po.origin}${base}/${c.metadata}`, redirectUri, clientUri: `${po.origin}${base}/`, loopback: false, scope: c.scope, ...extra };
}

/** The client metadata document, served at the client_id URL. */
export function clientMetadata({ clientId, redirectUri, redirectUris, clientUri, appName = 'Siren', scope = SCOPE }) {
  return {
    client_id: clientId,
    client_name: appName,
    client_uri: clientUri,
    application_type: 'web',
    // No refresh_token: an endorsing session is one access token, and a
    // later action re-authorizes (D2, default, pending Jason). The spec
    // allows leaving it out; the rollout probe checks that ASes agree.
    grant_types: ['authorization_code'],
    response_types: ['code'],
    redirect_uris: redirectUris || [redirectUri],
    scope,
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  };
}

/** PDS origin -> its one authorization server's origin (RFC 9728), or OAuthError('pds_unsupported'). */
export async function authServerFor(pds, { fetchImpl = fetch, signal } = {}) {
  let res;
  try {
    res = await safeFetch(`${pds}/.well-known/oauth-protected-resource`, { fetchImpl, signal, maxBytes: 65536 });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OAuthError('pds_unsupported');
  }
  const fail = () => {
    throw new OAuthError('pds_unsupported');
  };
  if (res.status !== 200 || !(res.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) fail();
  const prm = parseObject(res.text);
  if (!prm || typeof prm.resource !== 'string' || prm.resource !== pds) fail();
  const as = prm.authorization_servers;
  if (!Array.isArray(as) || as.length !== 1 || typeof as[0] !== 'string') fail();
  const s = as[0];
  let u;
  try {
    u = new URL(s);
  } catch {
    fail();
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) fail();
  if (s !== u.origin && s !== `${u.origin}/`) fail();
  if (!safeUrl(u.origin)) fail();
  return u.origin;
}

// An AS endpoint Siren will POST to or send a browser to: a string of at most
// MAX_ENDPOINT characters that passes safeUrl and sits on the issuer's origin.
function sameOriginEndpoint(x, issuer) {
  if (typeof x !== 'string' || x.length > MAX_ENDPOINT) return null;
  const u = safeUrl(x);
  return u && u.origin === issuer ? u.href : null;
}

/** Issuer origin -> checked AS metadata, or OAuthError('as_unsupported' | 'issuer_mismatch'). */
export async function authServerMetadata(issuer, { fetchImpl = fetch, signal } = {}) {
  let res;
  try {
    res = await safeFetch(`${issuer}/.well-known/oauth-authorization-server`, { fetchImpl, signal, maxBytes: 65536 });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OAuthError('as_unsupported');
  }
  const meta = res.status === 200 ? parseObject(res.text) : null;
  if (!meta) throw new OAuthError('as_unsupported');
  if (meta.issuer !== issuer) throw new OAuthError('issuer_mismatch');
  const has = (field, v) => Array.isArray(meta[field]) && meta[field].includes(v);
  // Granular repo scopes can't be listed in scopes_supported, so only
  // `atproto` is checked here; the granted scope is checked on the token.
  const ok = has('scopes_supported', 'atproto')
    && has('code_challenge_methods_supported', 'S256')
    && meta.authorization_response_iss_parameter_supported === true
    && meta.require_pushed_authorization_requests === true
    && has('dpop_signing_alg_values_supported', 'ES256')
    && meta.client_id_metadata_document_supported === true
    && has('token_endpoint_auth_methods_supported', 'none')
    && (meta.response_types_supported === undefined || has('response_types_supported', 'code'))
    // The code must come back in the fragment, never in a query the Worker would log.
    && (meta.response_modes_supported === undefined || has('response_modes_supported', 'fragment'));
  if (!ok) throw new OAuthError('as_unsupported');
  const authorization_endpoint = sameOriginEndpoint(meta.authorization_endpoint, issuer);
  const pushed_authorization_request_endpoint = sameOriginEndpoint(meta.pushed_authorization_request_endpoint, issuer);
  const token_endpoint = sameOriginEndpoint(meta.token_endpoint, issuer);
  if (!authorization_endpoint || !pushed_authorization_request_endpoint || !token_endpoint) throw new OAuthError('as_unsupported');
  const revocation_endpoint = sameOriginEndpoint(meta.revocation_endpoint, issuer);
  return { issuer, authorization_endpoint, pushed_authorization_request_endpoint, token_endpoint, ...(revocation_endpoint ? { revocation_endpoint } : {}) };
}

/** PKCE S256: a 43-character verifier and its challenge. */
export async function pkce() {
  const verifier = randomToken(32);
  return { verifier, challenge: b64url(await sha256(verifier)) };
}

/**
 * A fresh P-256 key for one sign-in: { privateKey, jwk } where the private
 * key is non-extractable (it can sign, never be exported) and jwk is the
 * public part for the proof header. IndexedDB keeps a CryptoKey as is.
 */
export async function newDpopKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { kty: 'EC', crv: 'P-256', x, y } };
}

/**
 * A DPoP proof JWT (RFC 9449) for one request. With `accessToken`, it
 * carries `ath`, the base64url SHA-256 of the token, as a resource server
 * (the PDS) requires.
 */
export async function dpopProof({ key, htm, htu, nonce, accessToken, now = Date.now() }) {
  const u = new URL(htu);
  u.search = '';
  u.hash = '';
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: key.jwk.x, y: key.jwk.y } };
  const payload = {
    jti: randomToken(16), htm, htu: u.href, iat: Math.floor(now / 1000),
    ...(nonce ? { nonce } : {}),
    ...(accessToken ? { ath: b64url(await sha256(accessToken)) } : {}),
  };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/**
 * A POST with a DPoP proof, retried once with a fresh proof when the server
 * asks for a nonce: a form to the authorization server, or JSON to the PDS
 * with `Authorization: DPoP <token>`. The AS and the PDS keep separate
 * nonces; the caller passes and keeps each. -> { status, json, nonce (the
 * newest DPoP-Nonce seen, or the one passed in), responseNonce (the final
 * response's own, or null) }.
 */
export async function dpopPost(url, { form, json, key, nonce, accessToken, fetchImpl = fetch, signal, now = Date.now() } = {}) {
  const body = form ? new URLSearchParams(form).toString() : JSON.stringify(json);
  let latest = nonce || null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proof = await dpopProof({ key, htm: 'POST', htu: url, nonce: latest, accessToken, now });
    const res = await safeFetch(url, {
      fetchImpl, method: 'POST', body, signal, maxBytes: OAUTH_BYTES,
      headers: {
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        Accept: 'application/json',
        DPoP: proof,
        ...(accessToken ? { Authorization: `DPoP ${accessToken}` } : {}),
      },
    });
    const got = res.headers.get('DPoP-Nonce') || null;
    if (got && got.length > MAX_NONCE) throw new OAuthError('dpop_nonce');
    if (got) latest = got;
    const parsed = parseObject(res.text);
    const asksNonce = parsed?.error === 'use_dpop_nonce'
      || (res.status === 401 && /use_dpop_nonce/.test(res.headers.get('WWW-Authenticate') || ''));
    if ((res.status === 400 || res.status === 401) && asksNonce && got) {
      if (attempt === 0) continue;
      throw new OAuthError('dpop_nonce');
    }
    return { status: res.status, json: parsed, nonce: latest, responseNonce: got };
  }
  throw new OAuthError('dpop_nonce');
}

/**
 * PAR (RFC 9126) with DPoP, asking for the code in the URL fragment so it
 * never reaches the Worker or its logs. -> { requestUri, nonce } or
 * OAuthError('as_refused').
 */
export async function pushAuthorization({ meta, clientId, redirectUri, state, challenge, loginHint, key, fetchImpl = fetch, signal, now = Date.now(), scope = SCOPE }) {
  const form = {
    client_id: clientId,
    response_type: 'code',
    response_mode: 'fragment',
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {}),
  };
  let out;
  try {
    out = await dpopPost(meta.pushed_authorization_request_endpoint, { form, key, fetchImpl, signal, now });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OAuthError('as_refused');
  }
  const uri = out.json?.request_uri;
  if ((out.status !== 201 && out.status !== 200) || typeof uri !== 'string' || !uri || uri.length > 2048 || !out.responseNonce) throw new OAuthError('as_refused');
  return { requestUri: uri, nonce: out.nonce };
}

export function authorizeUrl(meta, clientId, requestUri) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('request_uri', requestUri);
  return u.href;
}

/**
 * The token request for the code. -> { token, nonce } or OAuthError('token_failed').
 * A refused response that still carries a token puts it on the error as
 * `token` and `nonce`, so the caller can revoke it.
 */
export async function exchangeCode({ tokenEndpoint, code, verifier, clientId, redirectUri, key, nonce, fetchImpl = fetch, signal, now = Date.now() }) {
  let out;
  try {
    out = await dpopPost(tokenEndpoint, { form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId }, key, nonce, fetchImpl, signal, now });
  } catch {
    throw new OAuthError('token_failed');
  }
  if (out.status !== 200 || !out.json || !out.responseNonce) {
    const err = new OAuthError('token_failed');
    if (out.json && ['access_token', 'refresh_token'].some((k) => typeof out.json[k] === 'string' && out.json[k])) {
      err.token = out.json;
      err.nonce = out.nonce;
    }
    throw err;
  }
  return { token: out.json, nonce: out.nonce };
}

/**
 * Whether a granted scope string lets Siren create and delete records of
 * one collection: a `repo:` permission (atproto.com/specs/permission)
 * naming the collection (or `*`), whose actions (all three when none is
 * given) include create and delete. Partial wildcards aren't a thing.
 */
export function grantsRepo(scope, nsid) {
  if (typeof scope !== 'string' || scope.length > 4096) return false;
  for (const tok of scope.split(' ')) {
    let collections;
    let params;
    if (tok.startsWith('repo:')) {
      const rest = tok.slice(5);
      const q = rest.indexOf('?');
      collections = [q < 0 ? rest : rest.slice(0, q)];
      params = new URLSearchParams(q < 0 ? '' : rest.slice(q + 1));
    } else if (tok.startsWith('repo?')) {
      params = new URLSearchParams(tok.slice(5));
      collections = params.getAll('collection');
    } else {
      continue;
    }
    const actions = params.getAll('action');
    const acts = actions.length ? actions : ['create', 'update', 'delete'];
    if (collections.some((c) => c === nsid || c === '*') && acts.includes('create') && acts.includes('delete')) return true;
  }
  return false;
}

/** Whether a granted scope lets Siren create and delete its endorsement records. */
export const grantsEndorse = (scope) => grantsRepo(scope, ENDORSE_NSID);
/** Whether a granted scope lets Siren create and delete its question records (the free tier). */
export const grantsQuestion = (scope) => grantsRepo(scope, QUESTION_NSID);

/**
 * The token response must be DPoP-bound, carry `atproto` and the
 * permission the client needs (`grants`: the endorse permission unless
 * told otherwise), and name the bound DID.
 */
export function checkTokenResponse(token, expectedDid, { grants = grantsEndorse } = {}) {
  if (String(token?.token_type).toLowerCase() !== 'dpop') throw new OAuthError('token_type');
  if (typeof token.scope !== 'string' || !token.scope.split(' ').includes('atproto')) throw new OAuthError('scope_missing');
  if (!grants(token.scope)) throw new OAuthError('scope_narrow');
  if (typeof token.sub !== 'string' || !isSupportedDid(token.sub) || token.sub !== expectedDid) throw new OAuthError('account_mismatch');
  if (typeof token.access_token !== 'string' || !token.access_token || token.access_token.length > 8192) throw new OAuthError('token_failed');
}

/**
 * RFC 7009: revoke the access token (and a refresh token, should a server
 * issue one unasked) with a DPoP proof, carrying the nonce forward. Best
 * effort; never throws. -> the newest nonce.
 */
export async function revokeTokens({ revocationEndpoint, token, clientId, key, nonce, fetchImpl = fetch, now = Date.now() }) {
  let n = nonce || null;
  if (!revocationEndpoint) return n;
  for (const hint of ['refresh_token', 'access_token']) {
    const value = token?.[hint];
    if (typeof value !== 'string' || !value) continue;
    try {
      const out = await dpopPost(revocationEndpoint, { form: { token: value, token_type_hint: hint, client_id: clientId }, key, nonce: n, fetchImpl, now });
      n = out.nonce || n;
    } catch {
      // Revocation is best effort: the token is discarded either way.
    }
  }
  return n;
}
