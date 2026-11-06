// The public request list with endorsement counts, served through the Cache
// API for 60 seconds per Cloudflare location, so the counts are read from D1
// (one row per request) at most once a minute per location however busy the
// page is.
// It holds no per-viewer state. Where the Cache API isn't present (Node tests,
// some local setups) the list is computed every time.

import { publicRequests } from './requests.js';
import { endorsementCounts, publicPolicy, orphanedIds, sweepOrphans, purgeExpired, endorseDb } from './endorsements.js';

const SECONDS = 60;

const defaultCache = () => (typeof caches !== 'undefined' && caches?.default ? caches.default : null);
const cacheKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-v1`);

/**
 * The list, computed. Endorsements whose request was decided (or is gone)
 * are swept here, where every count and every request status is read anyway:
 * at most once a minute per location, so an orphan lives minutes, not months.
 * Rows past their expiry (rate counters, sign-in markers) are deleted here too.
 * `defer` is ctx.waitUntil in the Worker; without one the sweep is awaited.
 * `sweep: false` skips both: the endorse and `me` routes pass that, so a
 * person's own action never carries a sweep's writes.
 *
 * Only with BLUESKY_LOGIN on and SIREN_DB bound (callers check blueskyReady).
 * If D1 fails (on the Free plan, past the daily row limits), the list is
 * still served, without counts and flagged `endorsements_unavailable`, and
 * isn't cached, so the next request tries again.
 */
export async function computePublicList(env, kv, { defer, sweep = true, now = Date.now() } = {}) {
  const db = endorseDb(env);
  let counts;
  try {
    counts = db ? await endorsementCounts(db, { now }) : undefined;
  } catch (err) {
    console.error('public list: endorsement counts failed', err?.cause?.message || err?.message);
  }
  const statuses = new Map();
  const list = await publicRequests(kv, counts, { policy: publicPolicy(env), statuses });
  if (!counts) return { ...list, endorsements_unavailable: true };
  if (sweep) {
    const orphans = orphanedIds(counts, statuses).length ? sweepOrphans(db, counts, statuses) : null;
    const purge = purgeExpired(db, now).catch((err) => console.error('public list: purge failed', err?.cause?.message || err?.message));
    const pending = Promise.all([orphans, purge]);
    if (defer) defer(pending);
    else await pending;
  }
  return list;
}

/** -> { requests, awaiting_review } */
export async function cachedPublicList({ env, ctx, kv, origin, base = '', cache = defaultCache(), sweep = true }) {
  const key = cache ? cacheKey(origin, base) : null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return await hit.json();
    } catch {
      // a cache miss or failure falls through to computing the list
    }
  }
  const list = await computePublicList(env, kv, { sweep, ...(ctx?.waitUntil ? { defer: (p) => ctx.waitUntil(p) } : {}) });
  if (cache && !list.endorsements_unavailable) {
    const put = cache.put(key, new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${SECONDS}` } }))
      .catch((err) => console.error('public list: cache put failed', err?.message));
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return list;
}

/** Drop the cached list in this location, after a steward decision or a clear. */
export async function purgePublicList({ origin, base = '', cache = defaultCache() }) {
  if (!cache) return false;
  try {
    return await cache.delete(cacheKey(origin, base));
  } catch {
    return false;
  }
}
