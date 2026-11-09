// The steward's admin API and the daily cron's purge, apart from index.js
// (which imports .html modules Node can't load) so tests can run them
// against the fake D1 (test/admin.test.js).
//
// D1 follows endorseDb's rule: with BLUESKY_LOGIN unset nothing here touches
// SIREN_DB. With the flag on, a decline or fulfil freezes the live count into
// the request first; if it can't be read (no binding, or D1 failing), the
// decision is refused before anything is written, rather than losing it.
// Every D1 write here (clears, the orphan sweep, the cron's purge) is
// charged to the day's upkeep budget first (endorsements.js chargeD1).

import { isAdmin, currentUser } from './accounts.js';
import { allRequests, decide, reviewNote, requestByPublicId, isRequestId } from './requests.js';
import { endorsementCounts, countFor, clearRequestEndorsements, orphanedIds, sweepOrphans, purgeAll, endorseDb, dbSetupError } from './endorsements.js';
import { publicOrigin } from './atproto-oauth.js';
import { purgePublicList } from './public-list.js';
import { blueskyReady } from './bluesky.js';
import { setting } from './limits.js';

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

const DECIDED = new Set(['declined', 'fulfilled']);

/**
 * The steward's API: GET /api/admin/requests, POST .../decide, .../note
 * (approve or delete one note; no D1) and .../endorsements/clear. Every call checks that the signed-in account is an
 * admin (ADMIN_EMAILS secret); nothing here is cached. `ctx.waitUntil` runs
 * the background clears and purges.
 */
export async function handleAdmin(req, env, path, ctx) {
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };
  if (!env.LIMITS) return json({ error: 'This site is not configured yet.' }, 503, headers);
  const uid = await currentUser(req, env);
  if (!uid) return json({ error: 'Sign in first.', signin: true }, 401, headers);
  if (!(await isAdmin(env, uid))) return json({ error: 'This account is not a steward here.' }, 403, headers);
  const kv = env.LIMITS;
  const later = (p) => (ctx?.waitUntil ? ctx.waitUntil(p) : p);
  const purge = () => later(purgePublicList({ origin: new URL(req.url).origin, base: basePath(env) }));
  // Endorsements live in D1 (SIREN_DB), read only with BLUESKY_LOGIN on.
  const db = endorseDb(env);
  const dbMissing = dbSetupError(env);
  const storeMsg = (err) => String(err?.cause?.message || err?.message || 'unknown').slice(0, 300);
  if (req.method === 'GET' && path === '/api/admin/requests') {
    let counts = new Map();
    let problem = dbMissing;
    if (db) {
      try {
        counts = await endorsementCounts(db);
      } catch (err) {
        console.error('admin: endorsement counts failed', storeMsg(err));
        problem = `Endorsement counts couldn't be read just now (D1: ${storeMsg(err)}). The numbers below show 0 until they can.`;
      }
    }
    const requests = await allRequests(kv, counts);
    if (db && !problem) {
      // Sweep endorsements that outlived their request's decision
      // (endorsements.js orphanedIds). Expired rows are the cron's.
      const statuses = new Map(requests.map((r) => [r.id, r.status]));
      if (orphanedIds(counts, statuses).length) later(sweepOrphans(db, env, counts, statuses));
    }
    return json({ requests, bluesky: blueskyReady(env), ...(problem ? { bluesky_error: problem } : {}), young_days: setting(env.ENDORSE_YOUNG_DAYS, 30, { min: 0, max: 3650 }) }, 200, headers);
  }
  // Defense in depth over JSON-only and SameSite: a steward POST that names
  // an Origin must name this site.
  if (req.method === 'POST') {
    const o = req.headers.get('Origin');
    if (o !== null && o !== new URL(req.url).origin && o !== publicOrigin(env)?.origin) return json({ error: "Act from this site's own admin page.", code: 'not_here' }, 403, headers);
  }
  if (req.method === 'POST' && path === '/api/admin/requests/decide') {
    const body = (await readJson(req)) || {};
    const validId = isRequestId(body.id);
    // With endorsements switched on, a decision freezes the live count; if it
    // can't be read, refuse rather than lose it.
    if (dbMissing && DECIDED.has(body.status)) return json({ error: dbMissing }, 503, headers);
    let live;
    if (db && validId) {
      try {
        live = await countFor(db, body.id);
      } catch (err) {
        console.error('admin: endorsement count failed', storeMsg(err));
        if (DECIDED.has(body.status)) return json({ error: `The endorsement count couldn't be read, so nothing was decided (D1: ${storeMsg(err)}). Try again.` }, 503, headers);
      }
    }
    const out = await decide(kv, body, Date.now(), { live });
    if (!out.ok) return json({ error: out.error }, out.status, headers);
    if (db && DECIDED.has(out.request.status)) {
      later(clearRequestEndorsements(db, env, out.request.id)
        .then((c) => { if (c.deferred) console.error("clearing endorsements deferred: today's upkeep budget is spent; the orphan sweep will clear them"); })
        .catch((err) => console.error('clearing endorsements failed', storeMsg(err))));
    }
    purge();
    return json(out, 200, headers);
  }
  if (req.method === 'POST' && path === '/api/admin/requests/note') {
    const out = await reviewNote(kv, (await readJson(req)) || {});
    if (!out.ok) return json({ error: out.error }, out.status, headers);
    purge();
    return json(out, 200, headers);
  }
  if (req.method === 'POST' && path === '/api/admin/requests/endorsements/clear') {
    const body = (await readJson(req)) || {};
    if (!db) return json({ error: dbMissing || 'Bluesky endorsements are switched off here.' }, dbMissing ? 503 : 404, headers);
    if (!(await requestByPublicId(kv, body.id))) return json({ error: 'No single request has that id.' }, 404, headers);
    let out;
    try {
      out = await clearRequestEndorsements(db, env, body.id);
    } catch (err) {
      return json({ error: `Clearing failed (D1: ${storeMsg(err)}). Try again.` }, 503, headers);
    }
    if (out.deferred) return json({ error: "Nothing was cleared: today's D1 upkeep budget is spent (docs/bluesky-endorsements.md). Try again after midnight UTC, or use `node scripts/invites.js endorsements-clear`." }, 503, headers);
    purge();
    return json({ ok: true, ...out }, 200, headers);
  }
  return json({ error: 'Not found' }, 404, headers);
}

/**
 * The daily cron ([env.siren.triggers], added with BLUESKY_LOGIN in rollout
 * step 5, docs/bluesky-endorsements.md): deletes endorsement rows past their
 * expiry whether or not anyone visits, which the retention promises on the
 * requests page rely on. Without BLUESKY_LOGIN and SIREN_DB it does nothing;
 * with the flag off, `node scripts/invites.js endorsements-purge` does the
 * same from the steward's laptop. -> the purge's promise, or null
 */
export function scheduledPurge(env, ctx) {
  const db = endorseDb(env);
  if (!db) return null;
  const p = purgeAll(db, env).then((out) => {
    if (out.deferred) console.error("scheduled purge: today's upkeep budget is spent; the rest waits for tomorrow");
    return out;
  }).catch((err) => console.error('scheduled purge failed', String(err?.cause?.message || err?.message).slice(0, 300)));
  ctx?.waitUntil?.(p);
  return p;
}
