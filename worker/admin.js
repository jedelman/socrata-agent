// The steward's admin API, apart from index.js (which imports .html modules
// Node can't load) so tests can run it (test/admin.test.js).
//
// Endorsements are other people's records in their own Bluesky repos, so the
// steward can read them but never remove them; there's no clear and no
// per-account tool. With BLUESKY_LOGIN on, a decline or fulfil freezes the
// live count into the request; with it off, nothing here calls the network.

import { isAdmin, currentUser } from './accounts.js';
import { allRequests, decide, reviewNote, isRequestId } from './requests.js';
import { publicOrigin } from './atproto-oauth.js';
import { purgePublicList } from './public-list.js';
import { blueskyReady } from './bluesky.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const basePath = (env) => (env.BASE_PATH || '').replace(/\/$/, '');

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * The steward's API: GET /api/admin/requests, POST .../decide and .../note
 * (approve or delete one note). Every call checks that the signed-in account
 * is an admin (ADMIN_EMAILS secret); nothing here is cached.
 * `ctx.waitUntil` runs the background cache purges.
 */
export async function handleAdmin(req, env, path, ctx, deps = {}) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  if (!env.LIMITS) return json({ error: 'This site is not configured yet.' }, 503, headers);
  const uid = await currentUser(req, env);
  if (!uid) return json({ error: 'Sign in first.', signin: true }, 401, headers);
  if (!(await isAdmin(env, uid))) return json({ error: 'This account is not a steward here.' }, 403, headers);
  const kv = env.LIMITS;
  const later = (p) => (ctx?.waitUntil ? ctx.waitUntil(p) : p);
  const purge = () => later(purgePublicList({ origin: new URL(req.url).origin, base: basePath(env), ...(deps.cache !== undefined ? { cache: deps.cache } : {}) }));
  if (req.method === 'GET' && path === '/api/admin/requests') {
    return json({ requests: await allRequests(kv), bluesky: blueskyReady(env) }, 200, headers);
  }
  // Defense in depth over JSON-only and SameSite: a steward POST that names
  // an Origin must name this site.
  if (req.method === 'POST') {
    const o = req.headers.get('Origin');
    if (o !== null && o !== new URL(req.url).origin && o !== publicOrigin(env)?.origin) return json({ error: "Act from this site's own admin page.", code: 'not_here' }, 403, headers);
  }
  if (req.method === 'POST' && path === '/api/admin/requests/decide') {
    const body = (await readJson(req)) || {};
    if (!isRequestId(body.id)) return json({ error: 'Give the request id.' }, 400, headers);
    const out = await decide(kv, body, Date.now());
    if (!out.ok) return json({ error: out.error }, out.status, headers);
    purge();
    return json(out, 200, headers);
  }
  if (req.method === 'POST' && path === '/api/admin/requests/note') {
    const out = await reviewNote(kv, (await readJson(req)) || {});
    if (!out.ok) return json({ error: out.error }, out.status, headers);
    purge();
    return json(out, 200, headers);
  }
  return json({ error: 'Not found' }, 404, headers);
}
