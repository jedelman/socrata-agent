// atproto OAuth, the client side, for identity only. Siren is a public web
// client (token_endpoint_auth_method "none") that asks for scope "atproto"
// and nothing else: PAR, PKCE S256, DPoP (ES256), the RFC 9207 iss check and
// the sub check, then it revokes both tokens and throws them away. Built on
// WebCrypto and fetch; no dependency. Pure: every call takes `fetchImpl`.
//
// Requirements from atproto.com/specs/oauth (read 2026-11-06, "as of October
// 2026") and RFCs 9126 (PAR), 7636 (PKCE), 9449 (DPoP), 9207 (iss), 9728
// (protected resource metadata) and 7009 (revocation).

import { enc, b64url, randomToken, sha256 } from './crypto.js';
import { safeFetch, safeUrl, isSupportedDid } from './atproto-identity.js';

export class OAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OAuthError';
    this.code = code;
  }
}

export const SCOPE = 'atproto';
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

/** { clientId, redirectUri, clientUri, loopback } or null. */
export function clientIds(env, base = '') {
  const po = publicOrigin(env);
  if (!po || typeof base !== 'string' || !/^(\/[A-Za-z0-9._~-]+)*$/.test(base)) return null;
  const redirectUri = `${po.origin}${base}/oauth/callback`;
  if (po.loopback) {
    // The atproto localhost client: ASes synthesize its metadata.
    return { clientId: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${SCOPE}`, redirectUri, clientUri: null, loopback: true };
  }
  return { clientId: `${po.origin}${base}/oauth-client-metadata.json`, redirectUri, clientUri: `${po.origin}${base}/`, loopback: false };
}

/** The client metadata document, served at the client_id URL. */
export function clientMetadata({ clientId, redirectUri, clientUri, appName = 'Siren' }) {
  return {
    client_id: clientId,
    client_name: appName,
    client_uri: clientUri,
    application_type: 'web',
    // No refresh_token: Siren never refreshes. The spec allows leaving it out;
    // the rollout probe (scripts/bsky-probe.js) checks that ASes agree.
    grant_types: ['authorization_code'],
    response_types: ['code'],
    redirect_uris: [redirectUri],
    scope: SCOPE,
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
  const ok = has('scopes_supported', SCOPE)
    && has('code_challenge_methods_supported', 'S256')
    && meta.authorization_response_iss_parameter_supported === true
    && meta.require_pushed_authorization_requests === true
    && has('dpop_signing_alg_values_supported', 'ES256')
    && meta.client_id_metadata_document_supported === true
    && has('token_endpoint_auth_methods_supported', 'none')
    && (meta.response_types_supported === undefined || has('response_types_supported', 'code'));
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

/** A fresh P-256 key for one flow, kept compactly as { x, y, d }. */
export async function newDpopKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { jwk: { x, y, d } };
}

async function signingKey(jwk) {
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** A DPoP proof JWT (RFC 9449) for one request. No `ath`: Siren never calls a resource server. */
export async function dpopProof({ jwk, htm, htu, nonce, now = Date.now() }) {
  const u = new URL(htu);
  u.search = '';
  u.hash = '';
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
  const payload = { jti: randomToken(16), htm, htu: u.href, iat: Math.floor(now / 1000), ...(nonce ? { nonce } : {}) };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(jwk), enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/**
 * A form POST with a DPoP proof, retried once with a fresh proof when the
 * server asks for a nonce. -> { status, json, nonce (the final response's
 * DPoP-Nonce, or null), latestNonce (the newest one seen) }.
 */
export async function dpopPost(url, params, { jwk, nonce, fetchImpl = fetch, signal, now = Date.now() } = {}) {
  const body = new URLSearchParams(params).toString();
  let latest = nonce || null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const proof = await dpopProof({ jwk, htm: 'POST', htu: url, nonce: latest, now });
    const res = await safeFetch(url, {
      fetchImpl, method: 'POST', body, signal, maxBytes: OAUTH_BYTES,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', DPoP: proof },
    });
    const got = res.headers.get('DPoP-Nonce') || null;
    if (got && got.length > MAX_NONCE) throw new OAuthError('dpop_nonce');
    if (got) latest = got;
    const json = parseObject(res.text);
    const asksNonce = json?.error === 'use_dpop_nonce'
      || (res.status === 401 && /use_dpop_nonce/.test(res.headers.get('WWW-Authenticate') || ''));
    if ((res.status === 400 || res.status === 401) && asksNonce && got) {
      if (attempt === 0) continue;
      throw new OAuthError('dpop_nonce');
    }
    return { status: res.status, json, nonce: got, latestNonce: latest };
  }
  throw new OAuthError('dpop_nonce');
}

/** PAR (RFC 9126) with DPoP. -> { requestUri, nonce, expiresIn } or OAuthError('as_refused'). */
export async function pushAuthorization({ meta, clientId, redirectUri, state, challenge, loginHint, jwk, fetchImpl = fetch, signal, now = Date.now() }) {
  const form = {
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {}),
  };
  let out;
  try {
    out = await dpopPost(meta.pushed_authorization_request_endpoint, form, { jwk, fetchImpl, signal, now });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new OAuthError('as_refused');
  }
  const uri = out.json?.request_uri;
  if ((out.status !== 201 && out.status !== 200) || typeof uri !== 'string' || !uri || uri.length > 2048 || !out.nonce) throw new OAuthError('as_refused');
  return { requestUri: uri, nonce: out.nonce, expiresIn: typeof out.json.expires_in === 'number' ? out.json.expires_in : null };
}

export function authorizeUrl(meta, clientId, requestUri) {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('request_uri', requestUri);
  return u.href;
}

/**
 * The token request for the code. -> { token, nonce } or OAuthError('token_failed').
 * A refused response that still carries a token (a 200 with no DPoP-Nonce)
 * puts it on the error as `token` and `nonce`, so the caller can revoke it.
 */
export async function exchangeCode({ tokenEndpoint, code, verifier, clientId, redirectUri, jwk, nonce, fetchImpl = fetch, signal, now = Date.now() }) {
  let out;
  try {
    out = await dpopPost(tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId }, { jwk, nonce, fetchImpl, signal, now });
  } catch {
    throw new OAuthError('token_failed');
  }
  if (out.status !== 200 || !out.json || !out.nonce) {
    const err = new OAuthError('token_failed');
    if (out.json && ['access_token', 'refresh_token'].some((k) => typeof out.json[k] === 'string' && out.json[k])) {
      err.token = out.json;
      err.nonce = out.latestNonce;
    }
    throw err;
  }
  return { token: out.json, nonce: out.latestNonce };
}

/** The token response must be DPoP-bound, carry the atproto scope, and name the bound DID. */
export function checkTokenResponse(token, expectedDid) {
  if (String(token?.token_type).toLowerCase() !== 'dpop') throw new OAuthError('token_type');
  if (typeof token.scope !== 'string' || !token.scope.split(' ').includes(SCOPE)) throw new OAuthError('scope_missing');
  if (typeof token.sub !== 'string' || !isSupportedDid(token.sub) || token.sub !== expectedDid) throw new OAuthError('account_mismatch');
}

/**
 * RFC 7009: revoke the refresh token, then the access token, each with a
 * DPoP proof, carrying the nonce forward. Best effort; never throws.
 */
export async function revokeAll({ revocationEndpoint, token, clientId, jwk, nonce, fetchImpl = fetch, now = Date.now() }) {
  let n = nonce || null;
  for (const hint of ['refresh_token', 'access_token']) {
    const value = token?.[hint];
    if (typeof value !== 'string' || !value) continue;
    try {
      const out = await dpopPost(revocationEndpoint, { token: value, token_type_hint: hint, client_id: clientId }, { jwk, nonce: n, fetchImpl, now });
      n = out.latestNonce || n;
    } catch {
      // Revocation is best effort: the tokens are discarded either way.
    }
  }
}
