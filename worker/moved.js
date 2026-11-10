// A deployment that moved keeps answering at its old address with a
// redirect to the new one. MOVED_FROM is the old address, an origin and a
// path prefix (Siren: "https://jason-edelman.org/ask-siren", its address
// until 2026-11-10); the new one is PUBLIC_ORIGIN plus BASE_PATH. The old
// routes stay on the Worker, so every request that reaches it on the old
// host, over http or https, gets the same path and query on the new origin,
// minus the prefix: 301 for GET and HEAD, 308 for anything else (which keeps
// the method and body). Nothing else is served on the old host, so no
// cookie is ever set there again.
//
// One thing comes along: an invite. People who redeemed a code without
// signing in by email hold it only as a cookie on the old host
// (siren_invite, Path=/ask-siren/), and redeeming the code again would spend
// another use, which a single-use or used-up code doesn't have. So a GET or
// HEAD that carries a valid one is sent to <new>/carry-invite with a token:
// HMAC-signed with INVITE_SECRET under its own label, naming the invite and
// the page asked for, valid CARRY_SECONDS. That route sets the invite cookie
// on the new host, spends no use, and sends the browser on to the page. The
// token never leaves the URL: nothing here logs it, and both responses carry
// Cache-Control: no-store and Referrer-Policy: no-referrer.
//
// An account (email sign-in) isn't carried: signing in again on the new host
// finds the invite bound to the account in KV, so it costs nothing.
//
// Also here: a plain-http request on the new host goes to the same path on
// PUBLIC_ORIGIN (https), since the session cookies are Secure and never sent
// over http. Pure apart from WebCrypto, so Node tests drive it directly.

import { publicOrigin } from './atproto-oauth.js';
import { COOKIE, readCookie, verifySession, signSession, sessionCookie, inviteCookieName, basePathOf } from './invites.js';
import { b64url, unb64url, hmac, enc } from './crypto.js';

const PREFIX_RE = /^(\/[A-Za-z0-9._~-]+)+$/;
/** The invite cookie's name on the old host: the name it had before the move. */
export const OLD_INVITE_COOKIE = COOKIE;
/** The route on the new origin (under BASE_PATH) that takes a carried invite. */
export const CARRY_PATH = '/carry-invite';
/** How long a carry token is good for: the browser follows it at once. */
export const CARRY_SECONDS = 120;
const CARRY_LABEL = 'carry-invite:';

/**
 * MOVED_FROM, checked: { origin, host, prefix } or null. It must be
 * `https://host/prefix` (no port, query, fragment or trailing slash).
 */
export function movedFrom(env) {
  const s = typeof env?.MOVED_FROM === 'string' ? env.MOVED_FROM : '';
  const m = /^(https:\/\/[a-z0-9.-]+)(\/[^?#]*)$/.exec(s);
  if (!m || !PREFIX_RE.test(m[2])) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  return u.origin === m[1] && u.pathname === m[2] ? { origin: m[1], host: u.hostname, prefix: m[2] } : null;
}

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Where the old address sends people: { from, origin, base } of the new one,
 * or null when MOVED_FROM or PUBLIC_ORIGIN is missing or invalid, or the new
 * address sits under the old one (that would loop).
 */
export function moveTarget(env, base = '') {
  const from = movedFrom(env);
  const to = publicOrigin(env);
  if (!from || !to || to.loopback) return null;
  if (new URL(to.origin).hostname === from.host && under(base || '/', from.prefix)) return null;
  return { from, origin: to.origin, base };
}

const redirect = (location, method, extra = {}) => new Response(null, {
  status: method === 'GET' || method === 'HEAD' ? 301 : 308,
  headers: {
    Location: location,
    // A day, not forever, so a mistake in the move can still be undone.
    'Cache-Control': 'public, max-age=86400',
    // Public JSON (the request feed, the case files) is read cross-origin;
    // a CORS fetch follows a redirect only if the redirect allows it too.
    'Access-Control-Allow-Origin': '*',
    ...extra,
  },
});

// For the responses that carry a token: never stored, never sent on as a Referer.
const PRIVATE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/** Where on the new origin a token may send the browser: a path and query on it, nothing else. */
const DEST_RE = /^\/[^\s\\#]{0,2047}$/;

/** A carry token for one invite and one destination path, good for CARRY_SECONDS. */
export async function carryToken(secret, inviteHash, to, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ k: inviteHash, t: DEST_RE.test(to) ? to : '/', e: Math.floor(now / 1000) + CARRY_SECONDS })));
  return `${payload}.${b64url(await hmac(secret, `${CARRY_LABEL}${payload}`))}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** { hash, to } for a valid, unexpired carry token, else null. */
export async function readCarryToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 4096) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  let body;
  try {
    if (!timingSafeEqual(unb64url(sig), await hmac(secret, `${CARRY_LABEL}${payload}`))) return null;
    body = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    return null;
  }
  const t = Math.floor(now / 1000);
  if (typeof body?.k !== 'string' || !/^[0-9a-f]{64}$/.test(body.k)) return null;
  if (typeof body.e !== 'number' || body.e < t || body.e > t + CARRY_SECONDS + 60) return null;
  if (typeof body.t !== 'string' || !DEST_RE.test(body.t)) return null;
  return { hash: body.k, to: body.t };
}

/**
 * The response for a request to the old host: a redirect for a path under
 * the old prefix (carrying a valid invite along), a 404 for anything else
 * there, or null when the request isn't on the old host (or no move is
 * configured).
 */
export async function movedResponse(req, env, base = '') {
  const from = movedFrom(env);
  if (!from) return null;
  const url = new URL(req.url);
  if (url.hostname !== from.host) return null;
  const target = moveTarget(env, base);
  if (!target || !under(url.pathname, from.prefix)) {
    if (!target) console.error('MOVED_FROM is set, but PUBLIC_ORIGIN is missing or invalid, or the new address is under the old one: nothing is redirected.');
    return new Response('Not found', { status: 404 });
  }
  // The old invite cookie is Secure with Path=/ask-siren/: a browser sends it
  // only over https, and not to the bare /ask-siren. So those two go to the
  // https, slash form on the old host first, which can then carry it.
  if (url.protocol !== 'https:' || url.pathname === from.prefix) {
    return redirect(`${from.origin}${url.pathname === from.prefix ? `${from.prefix}/` : url.pathname}${url.search}`, req.method);
  }
  const to = `${url.pathname.slice(from.prefix.length) || '/'}${url.search}`;
  if ((req.method === 'GET' || req.method === 'HEAD') && env.INVITE_SECRET) {
    const hash = await verifySession(env.INVITE_SECRET, readCookie(req, OLD_INVITE_COOKIE));
    if (hash) {
      const token = await carryToken(env.INVITE_SECRET, hash, to);
      return new Response(null, { status: 302, headers: { Location: `${target.origin}${target.base}${CARRY_PATH}?t=${token}`, ...PRIVATE } });
    }
  }
  return redirect(`${target.origin}${target.base}${to}`, req.method);
}

/**
 * GET <base>/carry-invite?t=<token>: set the carried invite's cookie on this
 * host and go on to the page the old address was asked for. A token that is
 * forged, expired or malformed sets nothing and goes to the home page. A
 * browser that already holds a valid invite here keeps its own. Spends no
 * use of the code: the invite was redeemed on the old host.
 */
export async function carryInviteResponse(req, env, base = '') {
  const url = new URL(req.url);
  const origin = publicOrigin(env)?.origin || url.origin;
  const go = (path, cookie) => new Response(null, { status: 302, headers: { Location: `${origin}${base}${path}`, ...PRIVATE, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  if (!env.INVITE_SECRET) return new Response('Not found', { status: 404, headers: PRIVATE });
  const carried = await readCarryToken(env.INVITE_SECRET, url.searchParams.get('t'));
  if (!carried) return go('/');
  const held = await verifySession(env.INVITE_SECRET, readCookie(req, inviteCookieName(basePathOf(env))));
  if (held) return go(carried.to);
  return go(carried.to, sessionCookie(await signSession(env.INVITE_SECRET, carried.hash), `${base}/`));
}

/**
 * A plain-http request on the new host: the same path and query on
 * PUBLIC_ORIGIN (https). The session cookies are Secure, so over http a
 * signed-in person would look signed out. Null for anything else.
 */
export function httpsResponse(req, env) {
  const po = publicOrigin(env);
  if (!po || po.loopback) return null;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' || url.hostname !== new URL(po.origin).hostname) return null;
  return redirect(`${po.origin}${url.pathname}${url.search}`, req.method);
}
