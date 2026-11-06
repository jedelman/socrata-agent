// Bluesky sign-in (atproto OAuth, identity only) and the endorsement routes.
// The route handlers live here, not in index.js, so tests can drive them:
// index.js imports .html and JSON, which Node can't load.
//
// The flow, in short (docs/bluesky-endorsements.md has the rest):
//   1. POST /api/bsky/login {account}: parse the input before charging any
//      limit; limits; resolve handle -> DID -> document -> PDS -> AS ourselves;
//      PAR with PKCE and DPoP; the pending flow (state, verifier, DPoP key,
//      nonce, bound DID and issuer) is sealed into an HttpOnly cookie scoped
//      to <base>/oauth/. KV never holds a pending flow.
//   2. GET /oauth/callback: one flow cookie, state, iss (RFC 9207), a
//      single-use marker, the token exchange, the sub check, then the account
//      is re-resolved with no cache and must still name the same AS. Both
//      tokens are revoked and dropped. The session is a sealed browser-session
//      cookie scoped to <base>/api/bsky/, holding eid = HMAC(secret,
//      "endorser:" + DID), never the DID itself.
//   3. endorse / unendorse / me / forget / logout read only that cookie.
//
// The session cookie never reaches /api/ask or conversations, so a person's
// Bluesky identity and their questions never arrive on the same request.
// A Bluesky sign-in grants endorsing and nothing else: no invite, no asking.

import { enc, hex, sha256, hmacHex, randomToken, timingSafeEqual, seal, unseal, boundary } from './crypto.js';
import { setting, visitorId } from './limits.js';
import {
  parseAccountInput, resolveAccount, resolveDidDoc, docPds, plcCreatedDay, normalizeHandle, IdentityError,
} from './atproto-identity.js';
import {
  publicOrigin, clientIds, clientMetadata, authServerFor, authServerMetadata, pkce, newDpopKey,
  pushAuthorization, authorizeUrl, exchangeCode, checkTokenResponse, revokeAll,
} from './atproto-oauth.js';
import { endorse, unendorse, endorsedBy, forgetEndorser, publicPolicy, youngFlag, openIssuer, countEvents, recordEvent, StorageError } from './endorsements.js';
import { cachedPublicList } from './public-list.js';

export const BSKY_COOKIE = 'siren_bsky';
export const FLOW_COOKIE = 'siren_bsky_flow';
export const FLOW_PURPOSE = 'siren:bsky-flow:v1';
export const SESSION_PURPOSE = 'siren:bsky-session:v1';
export const FLOW_SECONDS = 600;
export const SESSION_SECONDS = 86400;
export const MAX_COOKIE_BYTES = 3800;
const LOGIN_DEADLINE_MS = 12000;
const RL_BINDINGS = ['BSKY_VISITOR_RL', 'BSKY_INPUT_RL', 'BSKY_ACCOUNT_RL', 'BSKY_SITE_RL'];

// Fixed sentences; remote text never reaches a person.
export const LOGIN_ERRORS = {
  not_set_up: "Bluesky sign-in isn't set up here.",
  not_here: "Start the sign-in from this site's own page.",
  bad_input: "That doesn't look like a Bluesky handle. Try one like alice.bsky.social.",
  busy: 'Lots of sign-ins right now. Try again in a minute.',
  timeout: "Your Bluesky server took too long to answer. Try again in a minute.",
  handle_unresolved: "I couldn't find that handle. Check the spelling, or try again in a minute.",
  did_unresolved: "I couldn't read that account's public record. Try again in a minute.",
  handle_mismatch: "That handle's record doesn't point back to it, so I can't sign you in with it.",
  no_pds: "That account doesn't name a server I can sign in through.",
  pds_unsupported: "That account's server doesn't offer a sign-in I can use.",
  as_unsupported: "That account's sign-in server doesn't meet the checks I need.",
  issuer_mismatch: "That account's sign-in server doesn't meet the checks I need.",
  as_refused: 'Your Bluesky server refused to start the sign-in. Try again in a minute.',
};
const LOGIN_STATUS = { bad_input: 400, handle_unresolved: 400, handle_mismatch: 400, no_pds: 400, did_unresolved: 502, pds_unsupported: 502, as_unsupported: 502, issuer_mismatch: 502, as_refused: 502, timeout: 504, busy: 429, not_here: 403, not_set_up: 404 };

const ENDORSE_ERRORS = {
  signed_out: 'Sign in with Bluesky first.',
  not_here: "Endorse from this site's own page.",
  busy: 'Lots of activity right now. Try again in a minute.',
};

/** Login, callback, endorse and the rest: the flag, storage, secrets, all four limiters and a valid origin. */
export function blueskyReady(env) {
  return env?.BLUESKY_LOGIN === 'true'
    && Boolean(env.LIMITS && env.INVITE_SECRET && env.IP_SALT)
    && RL_BINDINGS.every((b) => env[b] && typeof env[b].limit === 'function')
    && Boolean(publicOrigin(env));
}

/** The client metadata document: a valid, non-loopback PUBLIC_ORIGIN, flag or not (so the rollout can probe). */
export function metadataReady(env) {
  const po = publicOrigin(env);
  return Boolean(po && !po.loopback);
}

/** Every value of cookie `name`, in header order. */
export function readCookies(req, name) {
  const out = [];
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** A visitor hash for one Bluesky purpose ('bsky-login' | 'bsky-endorse'), shared with no other counter. */
export async function bskyVisitor(req, env, purpose) {
  return hmacHex(env.IP_SALT, `${purpose}:${visitorId(req.headers.get('CF-Connecting-IP'))}`, 32);
}

export async function endorserId(secret, did) {
  return hmacHex(secret, `endorser:${did}`);
}

export async function sealSession(secret, { eid, handle, created, issuer }, now = Date.now()) {
  return seal(secret, SESSION_PURPOSE, { v: 1, e: eid, h: handle || '', c: created || '', s: issuer, x: Math.floor(now / 1000) + SESSION_SECONDS });
}

const BARE_HTTPS = /^https:\/\/[a-z0-9.-]+$/;

export async function openSession(secret, value, now = Date.now()) {
  const s = await unseal(secret, SESSION_PURPOSE, value);
  if (!s || s.v !== 1) return null;
  if (typeof s.e !== 'string' || !/^[0-9a-f]{64}$/.test(s.e)) return null;
  if (typeof s.h !== 'string' || (s.h !== '' && normalizeHandle(s.h) !== s.h)) return null;
  if (typeof s.c !== 'string' || (s.c !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(s.c))) return null;
  if (typeof s.s !== 'string' || !BARE_HTTPS.test(s.s)) return null;
  if (typeof s.x !== 'number' || s.x < Math.floor(now / 1000)) return null;
  return { eid: s.e, handle: s.h, created: s.c, issuer: s.s };
}

/** { session, duplicate, invalid }: two or more cookies mean signed out (one may be planted). */
export async function currentSession(req, env, now = Date.now()) {
  const values = readCookies(req, BSKY_COOKIE);
  if (values.length === 0) return { session: null, duplicate: false, invalid: false };
  if (values.length > 1) return { session: null, duplicate: true, invalid: false };
  const session = await openSession(env.INVITE_SECRET, values[0], now);
  return { session, duplicate: false, invalid: !session };
}

// No Max-Age: a browser-session cookie, capped at 24 h by the sealed expiry.
export const sessionCookie = (value, base) => `${BSKY_COOKIE}=${value}; Path=${base}/api/bsky/; HttpOnly; Secure; SameSite=Lax`;
export const clearSessionCookie = (base) => `${BSKY_COOKIE}=; Path=${base}/api/bsky/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
export const flowCookie = (value, base) => `${FLOW_COOKIE}=${value}; Path=${base}/oauth/; Max-Age=${FLOW_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
export const clearFlowCookie = (base) => `${FLOW_COOKIE}=; Path=${base}/oauth/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/**
 * Every path a cookie sent with a request for `pathname` could carry: "/",
 * then each segment with and without its trailing slash. A browser sends a
 * cookie whose Path is any of these, and a Max-Age=0 clear removes only the
 * one with the same Domain and Path, so a clear must name each.
 */
export function pathPrefixes(pathname) {
  const out = ['/'];
  let acc = '';
  for (const part of String(pathname || '/').split('/').filter(Boolean).slice(0, 12)) {
    acc += `/${part}`;
    out.push(acc, `${acc}/`);
  }
  return out;
}

/**
 * Clears for copies of cookie `name` that Siren didn't set: one planted on
 * the parent domain (Domain=<the PUBLIC_ORIGIN host> or a domain above it) by
 * a sibling subdomain or a dangling CNAME, or a host-only one at another path,
 * at every path the request could have carried it on. Siren's own host-only
 * copy at `ownPath` is cleared only when `clearOwn` is set: on a duplicate it
 * is kept, so once the others are gone the visitor is signed in as themself,
 * and if one survives they stay signed out rather than become its owner.
 */
export function cookieClears(env, name, { pathname, ownPath, clearOwn = false }) {
  const paths = [...new Set([...pathPrefixes(pathname), ...pathPrefixes(ownPath)])];
  const attrs = 'Max-Age=0; HttpOnly; Secure; SameSite=Lax';
  const out = paths.filter((path) => clearOwn || path !== ownPath).map((path) => `${name}=; Path=${path}; ${attrs}`);
  const po = publicOrigin(env);
  if (po && !po.loopback) {
    const labels = new URL(po.origin).hostname.split('.');
    for (let i = 0; i <= labels.length - 2; i++) {
      const domain = labels.slice(i).join('.');
      for (const path of paths) out.push(`${name}=; Domain=${domain}; Path=${path}; ${attrs}`);
    }
  }
  return out;
}

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false; // fail closed
  }
}

const resolverOpts = (env, fetchImpl, signal) => ({ fetchImpl, signal, dohUrl: env.DOH_URL || 'https://cloudflare-dns.com/dns-query', plcUrl: env.PLC_URL || 'https://plc.directory' });

/**
 * Steps 3 to 15 of a login start (the gate and origin checks are the route's).
 * -> { ok: true, redirect, cookie } | { ok: false, status, code, error }
 */
export async function startBlueskyLogin({ body, env, kv, visitor, base, fetchImpl = fetch, now = Date.now(), timeoutMs = LOGIN_DEADLINE_MS, maxCookieBytes = MAX_COOKIE_BYTES }) {
  const fail = (code) => ({ ok: false, status: LOGIN_STATUS[code] || 502, code, error: LOGIN_ERRORS[code] || LOGIN_ERRORS.as_refused });
  // 3. Parse the input before charging anything.
  const parsed = parseAccountInput(body?.account);
  if (!parsed) return fail('bad_input');
  const input = parsed.kind === 'did' ? parsed.did : parsed.handle;
  const ids = clientIds(env, base);
  if (!ids) return fail('not_set_up');

  // 4. Limits, before any outbound fetch, stopping at the first that fails.
  if (!(await allowed(env.BSKY_VISITOR_RL, `login:${visitor}`))) return fail('busy');
  const evPrefix = `bsky-ev:${new Date(now).toISOString().slice(0, 13)}:v:${visitor}:`;
  let used;
  try {
    used = await countEvents(kv, evPrefix);
  } catch {
    return fail('busy');
  }
  if (used >= setting(env.BSKY_LOGIN_PER_VISITOR_HOURLY, 60, { min: 1 })) return fail('busy');
  if (!(await allowed(env.BSKY_INPUT_RL, `login:${await hmacHex(env.INVITE_SECRET, `bsky-acct:${input}`, 32)}`))) return fail('busy');
  if (!(await allowed(env.BSKY_SITE_RL, 'login'))) return fail('busy');
  try {
    await recordEvent(kv, evPrefix, boundary(now, 'hour', 2));
  } catch {
    console.error('bluesky login: event write failed');
  }

  // 5. One deadline for every fetch below.
  const deadline = AbortSignal.timeout(timeoutMs);
  const opts = resolverOpts(env, fetchImpl, deadline);
  try {
    // 6-9. Handle -> DID -> document, the handle checked both ways, and the PDS.
    const { did, handle, pds } = await resolveAccount(parsed, opts);
    // 10. Account age and the AS, in parallel.
    const [created, issuer] = await Promise.all([
      did.startsWith('did:plc:') ? plcCreatedDay(did, opts) : Promise.resolve(''),
      authServerFor(pds, opts),
    ]);
    // 11. AS metadata: every endpoint on the issuer's origin.
    const meta = await authServerMetadata(issuer, opts);
    // 12. Per-flow secrets.
    const state = randomToken(32);
    const { verifier, challenge } = await pkce();
    const { jwk } = await newDpopKey();
    // 13. PAR.
    const { requestUri, nonce } = await pushAuthorization({
      meta, clientId: ids.clientId, redirectUri: ids.redirectUri, state, challenge, loginHint: input, jwk, fetchImpl, signal: deadline, now,
    });
    // 14. Seal the flow; endpoint paths only, since the origin is the issuer.
    const tokenUrl = new URL(meta.token_endpoint);
    const revUrl = meta.revocation_endpoint ? new URL(meta.revocation_endpoint) : null;
    const sealed = await seal(env.INVITE_SECRET, FLOW_PURPOSE, {
      v: 1, s: state, d: did, h: handle || '', c: created, i: issuer,
      tp: tokenUrl.pathname + tokenUrl.search,
      rp: revUrl ? revUrl.pathname + revUrl.search : '',
      cv: verifier, k: { x: jwk.x, y: jwk.y, d: jwk.d }, n: nonce, x: Math.floor(now / 1000) + FLOW_SECONDS,
    });
    const cookie = flowCookie(sealed, base);
    // A browser drops an oversized cookie silently; refuse instead.
    if (cookie.length > maxCookieBytes) return fail('as_unsupported');
    // 15.
    return { ok: true, redirect: authorizeUrl(meta, ids.clientId, requestUri), cookie };
  } catch (err) {
    if (deadline.aborted) return fail('timeout');
    return fail(err?.code && LOGIN_ERRORS[err.code] ? err.code : 'as_refused');
  }
}

/**
 * The callback. -> { ok: true, cookie, handle } | { ok: false, code }.
 * `defer(promise)` is ctx.waitUntil in the Worker and a collector in tests.
 */
export async function finishBlueskyLogin({ params, flowValues, env, kv, visitor, base, fetchImpl = fetch, defer = (p) => p, now = Date.now(), log = console.error }) {
  let issuerForLog = null;
  const fail = (code) => {
    // Never the state, code, tokens, DID, handle or AS text; the issuer host
    // only for large open servers, since a self-hosted host names its person.
    if (code !== 'denied') {
      if (issuerForLog && openIssuer(issuerForLog, env)) log('bluesky callback', code, new URL(issuerForLog).host);
      else log('bluesky callback', code);
    }
    return { ok: false, code };
  };
  // 1. The per-visitor limit, before reading anything. The site-wide breaker
  // is charged below, once the checks that need no I/O have passed, so
  // requests with no genuine sealed flow can't trip it for everyone.
  if (!(await allowed(env.BSKY_VISITOR_RL, `cb:${visitor}`))) return fail('busy');
  // 2. Exactly one flow cookie that opens, is version 1 and hasn't expired.
  if (!Array.isArray(flowValues) || flowValues.length !== 1) return fail('flow_expired');
  const flow = await unseal(env.INVITE_SECRET, FLOW_PURPOSE, flowValues[0]);
  if (!flow || flow.v !== 1 || typeof flow.x !== 'number' || flow.x < Math.floor(now / 1000)) return fail('flow_expired');
  if (typeof flow.s !== 'string' || typeof flow.d !== 'string' || typeof flow.i !== 'string' || typeof flow.tp !== 'string' || !flow.k) return fail('flow_expired');
  issuerForLog = flow.i;
  // 3. State, compared in constant time; no AS call before it matches.
  const state = params.get('state');
  if (typeof state !== 'string' || !timingSafeEqual(enc.encode(state), enc.encode(flow.s))) return fail('state_mismatch');
  // 4. Issuer (RFC 9207), before reading error or code.
  if (params.get('iss') !== flow.i) return fail('issuer_mismatch');
  // 5. An error response.
  const error = params.get('error');
  if (error !== null) return fail(error === 'access_denied' ? 'denied' : 'as_error');
  // 6. The code.
  const code = params.get('code');
  if (typeof code !== 'string' || code.length < 1 || code.length > 2048) return fail('as_error');
  // The site-wide breaker, before any KV or outbound request.
  if (!(await allowed(env.BSKY_SITE_RL, 'callback'))) return fail('busy');
  // 7. Single use: a serial replay of the same cookie, state and iss is refused.
  const used = `bsky-flow-used:${hex(await sha256(flow.s)).slice(0, 32)}`;
  try {
    if ((await kv.get(used)) !== null) return fail('flow_expired');
    await kv.put(used, '1', { expiration: boundary(now, 'hour', 1) + 3600 });
  } catch {
    return fail('busy'); // no token request without the marker
  }

  const ids = clientIds(env, base);
  if (!ids) return fail('flow_expired');
  const jwk = flow.k;
  // 8. The token request.
  let token;
  let nonce;
  const revoke = () => {
    if (flow.rp) defer(revokeAll({ revocationEndpoint: flow.i + flow.rp, token, clientId: ids.clientId, jwk, nonce, fetchImpl, now }));
  };
  try {
    ({ token, nonce } = await exchangeCode({ tokenEndpoint: flow.i + flow.tp, code, verifier: flow.cv, clientId: ids.clientId, redirectUri: ids.redirectUri, jwk, nonce: flow.n, fetchImpl, now }));
  } catch (err) {
    // A refused response that still issued tokens: revoke them too.
    if (err?.token) {
      token = err.token;
      nonce = err.nonce || flow.n;
      revoke();
    }
    return fail('token_failed');
  }
  // 9. The token response must be DPoP, atproto, and the bound DID.
  try {
    checkTokenResponse(token, flow.d);
  } catch (err) {
    revoke();
    return fail(err.code || 'account_mismatch');
  }
  // 10. Re-resolve the account with no cache: it must still name this AS.
  try {
    const opts = resolverOpts(env, fetchImpl, AbortSignal.timeout(10000));
    const doc = await resolveDidDoc(flow.d, opts);
    const pds = docPds(doc);
    if (!pds) throw new IdentityError('no_pds');
    if ((await authServerFor(pds, opts)) !== flow.i) {
      revoke();
      return fail('issuer_mismatch');
    }
  } catch {
    revoke();
    return fail('did_unresolved');
  }
  // 11. Revoke and discard: nothing below holds the tokens or the key.
  revoke();
  // 12. The session. The DID goes no further than this function.
  const eid = await endorserId(env.INVITE_SECRET, flow.d);
  const sealed = await sealSession(env.INVITE_SECRET, { eid, handle: flow.h, created: flow.c, issuer: flow.i }, now);
  return { ok: true, cookie: sessionCookie(sealed, base), handle: flow.h || null };
}

// ---- Route handlers ------------------------------------------------------

const jsonResponse = (body, status = 200, headers = {}) => {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else h.set(k, v);
  }
  return new Response(JSON.stringify(body), { status, headers: h });
};
const notFound = () => jsonResponse({ error: LOGIN_ERRORS.not_set_up }, 404);

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** The Origin header, when present, must be PUBLIC_ORIGIN (defense in depth over JSON-only and SameSite). */
function foreignOrigin(req, env) {
  const o = req.headers.get('Origin');
  return o !== null && o !== publicOrigin(env)?.origin;
}

export async function handleMetadata(req, env, base, appName = 'Siren') {
  if (!metadataReady(env)) return new Response('Not found', { status: 404 });
  const ids = clientIds(env, base);
  if (!ids) return new Response('Not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(clientMetadata({ ...ids, appName }), null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function handleLogin(req, env, ctx, base, deps = {}) {
  if (!blueskyReady(env)) return notFound();
  if (new URL(req.url).origin !== publicOrigin(env).origin || foreignOrigin(req, env)) {
    return jsonResponse({ error: LOGIN_ERRORS.not_here, code: 'not_here' }, 403);
  }
  const out = await startBlueskyLogin({
    body: await readJson(req), env, kv: env.LIMITS, visitor: await bskyVisitor(req, env, 'bsky-login'), base,
    fetchImpl: deps.fetchImpl || fetch, now: deps.now ?? Date.now(),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}), ...(deps.maxCookieBytes ? { maxCookieBytes: deps.maxCookieBytes } : {}),
  });
  if (!out.ok) return jsonResponse({ error: out.error, code: out.code }, out.status);
  return jsonResponse({ ok: true, redirect: out.redirect }, 200, { 'Set-Cookie': out.cookie });
}

export async function handleCallback(req, env, ctx, base, deps = {}) {
  if (!blueskyReady(env)) return new Response('Not found', { status: 404 });
  const flowValues = readCookies(req, FLOW_COOKIE);
  let out;
  try {
    out = await finishBlueskyLogin({
      params: new URL(req.url).searchParams,
      flowValues,
      env, kv: env.LIMITS, visitor: await bskyVisitor(req, env, 'bsky-login'), base,
      fetchImpl: deps.fetchImpl || fetch,
      defer: deps.defer || ((p) => (ctx?.waitUntil ? ctx.waitUntil(p) : p)),
      now: deps.now ?? Date.now(),
      ...(deps.log ? { log: deps.log } : {}),
    });
  } catch {
    // Every exit is still a 303 that clears the flow cookie.
    (deps.log || console.error)('bluesky callback', 'as_error');
    out = { ok: false, code: 'as_error' };
  }
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  headers.set('Location', `${publicOrigin(env).origin}${base}/requests#${out.ok ? 'bluesky=signed-in' : `bluesky-error=${encodeURIComponent(out.code)}`}`);
  if (out.ok) headers.append('Set-Cookie', out.cookie);
  headers.append('Set-Cookie', clearFlowCookie(base));
  // Two flow cookies: clear every other copy too, so the next sign-in works.
  if (flowValues.length > 1) {
    for (const c of cookieClears(env, FLOW_COOKIE, { pathname: new URL(req.url).pathname, ownPath: `${base}/oauth/` })) headers.append('Set-Cookie', c);
  }
  // Never Response.redirect: its headers are immutable.
  return new Response(null, { status: 303, headers });
}

// Clears for every copy of the session cookie, Siren's own included.
const allSessionClears = (req, env, base) => cookieClears(env, BSKY_COOKIE, { pathname: new URL(req.url).pathname, ownPath: `${base}/api/bsky/`, clearOwn: true });

async function signedIn(req, env, base, now) {
  const { session, duplicate, invalid } = await currentSession(req, env, now);
  // On a duplicate, clear every copy but Siren's own: clearing ours and
  // missing a planted one would sign the visitor in as the planter.
  const clears = duplicate ? cookieClears(env, BSKY_COOKIE, { pathname: new URL(req.url).pathname, ownPath: `${base}/api/bsky/` })
    : invalid ? [clearSessionCookie(base)] : [];
  return { session, clear: clears.length ? { 'Set-Cookie': clears } : {} };
}

async function accountAllowed(env, session) {
  return allowed(env.BSKY_ACCOUNT_RL, `act:${await hmacHex(env.INVITE_SECRET, `bsky-rl:${session.eid}`, 32)}`);
}

// No orphan sweep here: /api/requests and the admin page do that.
const listFor = (req, env, ctx, base, deps) => deps.publicList
  || cachedPublicList({ env, ctx, kv: env.LIMITS, origin: new URL(req.url).origin, base, sweep: false, ...(deps.cache !== undefined ? { cache: deps.cache } : {}) });

export async function handleMe(req, env, ctx, base, deps = {}) {
  if (!blueskyReady(env)) return jsonResponse({ bluesky: { available: false }, endorsed: [] });
  const now = deps.now ?? Date.now();
  const policy = publicPolicy(env);
  const youngDays = setting(env.ENDORSE_YOUNG_DAYS, 30, { min: 0, max: 3650 });
  const retentionMonths = setting(env.ENDORSE_RETENTION_MONTHS, 12, { min: 1, max: 24 });
  const info = { available: true, policy, young_days: youngDays, retention_months: retentionMonths };
  const { session, clear } = await signedIn(req, env, base, now);
  // Signed out touches no KV and no limiter.
  if (!session) return jsonResponse({ bluesky: { ...info, signed_in: false, handle: null, counted: false, age: null }, endorsed: [] }, 200, clear);
  const y = youngFlag(session.created, env, now);
  const counted = policy === 'all' || y === 0;
  // 'unknown' (did:web, or a failed lookup) never ages into the count; the page says so.
  const age = y === 1 ? 'young' : y === 0 ? 'established' : 'unknown';
  const signed = { ...info, signed_in: true, handle: session.handle || null, counted, age };
  // Over the limit: still say who is signed in (so the page keeps Sign out),
  // but read no KV.
  if (!(await accountAllowed(env, session))) return jsonResponse({ bluesky: { ...signed, busy: true }, endorsed: [], error: ENDORSE_ERRORS.busy, code: 'busy' }, 429);
  let endorsed;
  try {
    endorsed = await endorsedBy({ kv: env.LIMITS, env, session, publicList: await listFor(req, env, ctx, base, deps), now });
  } catch {
    return jsonResponse({ bluesky: { ...signed, busy: true }, endorsed: [], error: ENDORSE_ERRORS.busy, code: 'busy' }, 503);
  }
  return jsonResponse({ bluesky: signed, endorsed });
}

export async function handleLogout(req, env, base) {
  if (!blueskyReady(env)) return notFound();
  if (foreignOrigin(req, env)) return jsonResponse({ error: ENDORSE_ERRORS.not_here, code: 'not_here' }, 403);
  // Only the Bluesky session (never siren_user or siren_invite), but every
  // copy of it, so a session planted on the parent domain doesn't survive.
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': allSessionClears(req, env, base) });
}

// The shared front half of endorse, unendorse and forget.
async function guarded(req, env, base, deps) {
  if (!blueskyReady(env)) return { response: notFound() };
  if (foreignOrigin(req, env)) return { response: jsonResponse({ error: ENDORSE_ERRORS.not_here, code: 'not_here' }, 403) };
  const now = deps.now ?? Date.now();
  const { session, clear } = await signedIn(req, env, base, now);
  if (!session) return { response: jsonResponse({ error: ENDORSE_ERRORS.signed_out, code: 'signed_out' }, 401, clear) };
  if (!(await accountAllowed(env, session))) return { response: jsonResponse({ error: ENDORSE_ERRORS.busy, code: 'busy' }, 429) };
  return { session, now };
}

// A KV failure is a JSON 503, never a bare 500.
async function storageSafe(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof StorageError)) console.error('bluesky: storage error', err?.message);
    return jsonResponse({ error: ENDORSE_ERRORS.busy, code: 'busy' }, 503);
  }
}

const reply = (out) => (out.ok ? jsonResponse(Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'status'))) : jsonResponse({ error: out.error, code: out.code }, out.status));

export async function handleEndorse(req, env, ctx, base, deps = {}) {
  const g = await guarded(req, env, base, deps);
  if (g.response) return g.response;
  const body = await readJson(req);
  return storageSafe(async () => reply(await endorse({
    kv: env.LIMITS, env, id: body?.id, session: g.session, visitor: await bskyVisitor(req, env, 'bsky-endorse'),
    publicList: await listFor(req, env, ctx, base, deps), now: g.now,
  })));
}

export async function handleUnendorse(req, env, ctx, base, deps = {}) {
  const g = await guarded(req, env, base, deps);
  if (g.response) return g.response;
  const body = await readJson(req);
  return storageSafe(async () => reply(await unendorse({ kv: env.LIMITS, env, id: body?.id, session: g.session, visitor: await bskyVisitor(req, env, 'bsky-endorse'), now: g.now })));
}

export async function handleForget(req, env, ctx, base, deps = {}) {
  const g = await guarded(req, env, base, deps);
  if (g.response) return g.response;
  return storageSafe(async () => {
    const { removed } = await forgetEndorser({ kv: env.LIMITS, env, session: g.session });
    return jsonResponse({ ok: true, removed }, 200, { 'Set-Cookie': allSessionClears(req, env, base) });
  });
}
