// Bluesky endorsements, the Worker's side (docs/bluesky-endorsements.md).
// An endorsement is a record in the endorser's own atproto repository,
// written and deleted from the browser (endorse-client.js), which is the
// OAuth client; the Worker never sees a token, sets no Bluesky cookie and
// stores nothing about endorsers. What it serves: the public list with
// counts (public-list.js, through Constellation), the endorser list per
// request, the browser client's metadata, and a fallback for resolving
// handles a browser can't. The route handlers live here, not in index.js,
// so tests can drive them: index.js imports .html and JSON, which Node can't
// load.

import { publicOrigin, clientIds, clientMetadata } from './atproto-oauth.js';
import { parseAccountInput, resolveAccount } from './atproto-identity.js';
import { hmacHex } from './crypto.js';
import { visitorId } from './limits.js';

const RL_BINDINGS = ['BSKY_VISITOR_RL', 'BSKY_INPUT_RL', 'BSKY_SITE_RL'];

/**
 * The flag, BLUESKY_LOGIN (D8, default, pending Jason: the old name kept), request
 * storage, the salt for visitor keys, the three limiters and a valid origin.
 */
export function blueskyReady(env) {
  return env?.BLUESKY_LOGIN === 'true'
    && Boolean(env.LIMITS && env.IP_SALT)
    && RL_BINDINGS.every((b) => env[b] && typeof env[b].limit === 'function')
    && Boolean(publicOrigin(env));
}

/**
 * With BLUESKY_LOGIN "true" but something missing, what's missing, by name
 * (bindings and secret names only, never values), for the log; else null.
 */
export function blueskySetupError(env) {
  if (env?.BLUESKY_LOGIN !== 'true' || blueskyReady(env)) return null;
  const missing = [
    ...['LIMITS', 'IP_SALT'].filter((k) => !env[k]),
    ...RL_BINDINGS.filter((b) => !(env[b] && typeof env[b].limit === 'function')),
    ...(publicOrigin(env) ? [] : ['PUBLIC_ORIGIN (a valid origin)']),
  ];
  return `BLUESKY_LOGIN is "true" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing, so Bluesky endorsements are off (docs/bluesky-endorsements.md).`;
}

// ---- Routes --------------------------------------------------------------


const RESOLVE_DEADLINE_MS = 8000;

// Fixed sentences; remote text never reaches a person.
export const LOGIN_ERRORS = {
  not_set_up: "Bluesky sign-in isn't set up here.",
  not_here: "Start the sign-in from this site's own page.",
  bad_input: "That doesn't look like a Bluesky handle. Try one like alice.bsky.social.",
  busy: 'Lots of sign-ins right now. Try again in a minute.',
  timeout: 'That account took too long to look up. Try again in a minute.',
  handle_unresolved: "I couldn't find that handle. Check the spelling, or try again in a minute.",
  did_unresolved: "I couldn't read that account's public record. Try again in a minute.",
  handle_mismatch: "That handle's record doesn't point back to it, so I can't sign you in with it.",
  no_pds: "That account doesn't name a server I can sign in through.",
};
const LOGIN_STATUS = { bad_input: 400, handle_unresolved: 400, handle_mismatch: 400, no_pds: 400, did_unresolved: 502, timeout: 504, busy: 429, not_here: 403, not_set_up: 404 };

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const loginFail = (code) => jsonResponse({ error: LOGIN_ERRORS[code], code }, LOGIN_STATUS[code] || 502);

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false; // fail closed
  }
}

/** The client metadata document: a valid, non-loopback PUBLIC_ORIGIN, flag or not (so the rollout can probe). */
export function metadataReady(env) {
  const po = publicOrigin(env);
  return Boolean(po && !po.loopback);
}

/** GET <base>/endorse-client-metadata.json: the browser client's client_id document. */
export function handleMetadata(req, env, base, appName = 'Siren') {
  if (!metadataReady(env)) return new Response('Not found', { status: 404 });
  const ids = clientIds(env, base);
  if (!ids) return new Response('Not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(clientMetadata({ ...ids, appName }), null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * POST <base>/api/bsky/resolve {account}: handle or DID -> {did, handle, pds},
 * for browsers that can't resolve a handle themselves (custom domains whose
 * well-known has no CORS). Public data only: nothing is stored, no token is
 * involved, and the browser still checks the DID document itself. Limits
 * before any outbound fetch: per visitor, per account typed, site-wide.
 */
export async function handleResolve(req, env, deps = {}) {
  if (!blueskyReady(env)) {
    const why = blueskySetupError(env);
    if (why) console.error('bluesky:', why);
    return why ? jsonResponse({ error: LOGIN_ERRORS.not_set_up, code: 'not_set_up' }, 503) : new Response('Not found', { status: 404 });
  }
  const o = req.headers.get('Origin');
  if (o !== null && o !== publicOrigin(env).origin) return loginFail('not_here');
  let body = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const parsed = parseAccountInput(body?.account);
  if (!parsed) return loginFail('bad_input');
  const input = parsed.kind === 'did' ? parsed.did : parsed.handle;
  const visitor = await hmacHex(env.IP_SALT, `bsky-resolve:${visitorId(req.headers.get('CF-Connecting-IP'))}`, 32);
  if (!(await allowed(env.BSKY_VISITOR_RL, `resolve:${visitor}`))) return loginFail('busy');
  if (!(await allowed(env.BSKY_INPUT_RL, `resolve:${await hmacHex(env.IP_SALT, `bsky-acct:${input}`, 32)}`))) return loginFail('busy');
  if (!(await allowed(env.BSKY_SITE_RL, 'resolve'))) return loginFail('busy');
  const deadline = AbortSignal.timeout(deps.timeoutMs || RESOLVE_DEADLINE_MS);
  try {
    const out = await resolveAccount(parsed, { fetchImpl: deps.fetchImpl || fetch, signal: deadline, dohUrl: env.DOH_URL || 'https://cloudflare-dns.com/dns-query', plcUrl: env.PLC_URL || 'https://plc.directory' });
    return jsonResponse({ did: out.did, handle: out.handle, pds: out.pds });
  } catch (err) {
    if (deadline.aborted) return loginFail('timeout');
    return loginFail(err?.code && LOGIN_ERRORS[err.code] ? err.code : 'did_unresolved');
  }
}
