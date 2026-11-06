// The public request list with endorsement counts, served through the Cache
// API for 60 seconds per Cloudflare location, so listing every endorsement
// key happens at most once a minute per location however busy the page is.
// It holds no per-viewer state. Where the Cache API isn't present (Node tests,
// some local setups) the list is computed every time.

import { publicRequests } from './requests.js';
import { endorsementCounts, publicPolicy, orphanedIds, sweepOrphans } from './endorsements.js';

const SECONDS = 60;

const defaultCache = () => (typeof caches !== 'undefined' && caches?.default ? caches.default : null);
const cacheKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-v1`);

/**
 * The list, computed. Endorsement keys whose request was decided (or is gone)
 * are swept here, where every key and every request status is read anyway:
 * at most once a minute per location, so an orphan lives minutes, not months.
 * `defer` is ctx.waitUntil in the Worker; without one the sweep is awaited.
 */
export async function computePublicList(env, kv, { defer } = {}) {
  const counts = await endorsementCounts(kv);
  const statuses = new Map();
  const list = await publicRequests(kv, counts, { policy: publicPolicy(env), statuses });
  if (orphanedIds(counts, statuses).length) {
    const sweep = sweepOrphans(kv, counts, statuses);
    if (defer) defer(sweep);
    else await sweep;
  }
  return list;
}

/** -> { requests, awaiting_review } */
export async function cachedPublicList({ env, ctx, kv, origin, base = '', cache = defaultCache() }) {
  const key = cache ? cacheKey(origin, base) : null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return await hit.json();
    } catch {
      // a cache miss or failure falls through to computing the list
    }
  }
  const list = await computePublicList(env, kv, ctx?.waitUntil ? { defer: (p) => ctx.waitUntil(p) } : {});
  if (cache) {
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
