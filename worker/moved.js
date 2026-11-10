// A deployment that moved keeps answering at its old address with a
// redirect to the new one. MOVED_FROM is the old address, an origin and a
// path prefix (Siren: "https://jason-edelman.org/ask-siren", its address
// until 2026-11-10); the new one is PUBLIC_ORIGIN plus BASE_PATH. The old
// routes stay on the Worker, so every request that reaches it on the old
// origin gets the same path and query on the new one, minus the prefix:
// 301 for GET and HEAD, 308 for anything else (which keeps the method and
// body). Nothing else is served on the old origin, so no cookie is ever set
// there again. Pure, so Node tests drive it directly.

import { publicOrigin } from './atproto-oauth.js';

const PREFIX_RE = /^(\/[A-Za-z0-9._~-]+)+$/;

/**
 * MOVED_FROM, checked: { origin, prefix } or null. It must be
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
  return u.origin === m[1] && u.pathname === m[2] ? { origin: m[1], prefix: m[2] } : null;
}

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Where the old address sends people: { origin, base } of the new one, or
 * null when MOVED_FROM or PUBLIC_ORIGIN is missing or invalid, or the new
 * address sits under the old one (that would loop).
 */
export function moveTarget(env, base = '') {
  const from = movedFrom(env);
  const to = publicOrigin(env);
  if (!from || !to || to.loopback) return null;
  if (to.origin === from.origin && under(base || '/', from.prefix)) return null;
  return { from, origin: to.origin, base };
}

/**
 * The response for a request to the old origin: a redirect for a path under
 * the old prefix, a 404 for anything else there, or null when the request
 * isn't on the old origin (or no move is configured).
 */
export function movedResponse(req, env, base = '') {
  const from = movedFrom(env);
  if (!from) return null;
  const url = new URL(req.url);
  if (url.origin !== from.origin) return null;
  const target = moveTarget(env, base);
  if (!target || !under(url.pathname, from.prefix)) {
    if (!target) console.error('MOVED_FROM is set, but PUBLIC_ORIGIN is missing or invalid, or the new address is under the old one: nothing is redirected.');
    return new Response('Not found', { status: 404 });
  }
  const rest = url.pathname.slice(from.prefix.length) || '/';
  const location = `${target.origin}${target.base}${rest}${url.search}`;
  const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
  return new Response(null, {
    status,
    headers: {
      Location: location,
      // A day, not forever, so a mistake in the move can still be undone.
      'Cache-Control': 'public, max-age=86400',
      // Public JSON (the request feed, the case files) is read cross-origin;
      // a CORS fetch follows a redirect only if the redirect allows it too.
      'Access-Control-Allow-Origin': '*',
    },
  });
}
