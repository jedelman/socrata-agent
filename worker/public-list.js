// The public request list with endorsement counts, served through the Cache
// API for 60 seconds per Cloudflare location, so the counts are read from D1
// (one row per request with endorsements) at most once a minute per location
// however busy the page is.
// It holds no per-viewer state. Where the Cache API isn't present (Node tests,
// some local setups) the list is computed every time.
//
// What bounds its D1 reads when the cache doesn't (docs/bluesky-endorsements.md,
// "Siren's worst case on the account's D1"): the request records are read from
// KV first, and D1 is asked only after that succeeds, so on the Free plan the
// list's D1 reads can't outnumber the account's 1,000 KV list operations a
// day; and a site-wide Rate Limiting breaker (BSKY_D1_RL, key 'list') runs
// before the D1 read, so a location computes counts at most that often a
// minute whatever the cache does.

import { publicRequests, requestRows } from './requests.js';
import { endorsementCounts, publicPolicy, orphanedIds, sweepOrphans, endorseDb } from './endorsements.js';

const SECONDS = 60;
// A list computed without counts (D1 failed, or the breaker was tripped) is
// cached briefly under its own key, so a D1 outage (on the Free plan, the
// daily row limits until midnight UTC) doesn't turn every view into a KV list
// of the requests, while D1 is still retried every half minute per location.
const UNAVAILABLE_SECONDS = 30;
// The request records couldn't be read at all (KV failing, or past its daily
// list operations): remembered for as long, under its own key, so each view
// in that time is a cache hit, not another KV list.
const FAILED_SECONDS = 30;

/** What /api/requests and the Bluesky routes get when the request records can't be read. */
export const LIST_UNAVAILABLE = Object.freeze({ requests: Object.freeze([]), awaiting_review: 0, unavailable: true });

const defaultCache = () => (typeof caches !== 'undefined' && caches?.default ? caches.default : null);
const cacheKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-v1`);
const uncountedKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-uncounted-v1`);
const failedKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-failed-v1`);

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false; // a limiter that fails counts as limited
  }
}

/**
 * The list, computed. KV first: if the request records can't be read, this
 * throws before any D1 call. Then the counts, behind the site-wide breaker.
 * Endorsements whose request was decided (or is gone) are swept here, where
 * every count and every request status is read anyway (charged to the
 * upkeep budget). `defer` is ctx.waitUntil in the Worker; without one the
 * sweep is awaited. `sweep: false` skips it: the endorse and `me` routes pass
 * that, so a person's own action never carries a sweep's writes.
 *
 * Only with BLUESKY_LOGIN on and SIREN_DB bound (callers check blueskyReady).
 * If D1 fails or the breaker refuses, the list is still served, without
 * counts and flagged `endorsements_unavailable`; cachedPublicList caches that
 * for 30 seconds only, under its own key.
 */
export async function computePublicList(env, kv, { defer, sweep = true, now = Date.now() } = {}) {
  const rows = await requestRows(kv);
  const db = endorseDb(env);
  let counts;
  if (db && (await allowed(env.BSKY_D1_RL, 'list'))) {
    try {
      counts = await endorsementCounts(db);
    } catch (err) {
      console.error('public list: endorsement counts failed', err?.cause?.message || err?.message);
    }
  }
  const statuses = new Map();
  const list = await publicRequests(kv, counts, { policy: publicPolicy(env), statuses, rows });
  if (!counts) return { ...list, endorsements_unavailable: true };
  if (sweep && orphanedIds(counts, statuses).length) {
    const pending = sweepOrphans(db, env, counts, statuses, { now });
    if (defer) defer(pending);
    else await pending;
  }
  return list;
}

/**
 * -> { requests, awaiting_review } or LIST_UNAVAILABLE. Never throws: a
 * failure to read the request records is logged, remembered for 30 seconds
 * under its own key, and answered as LIST_UNAVAILABLE.
 */
export async function cachedPublicList({ env, ctx, kv, origin, base = '', cache = defaultCache(), sweep = true }) {
  if (cache) {
    for (const key of [cacheKey(origin, base), uncountedKey(origin, base), failedKey(origin, base)]) {
      try {
        const hit = await cache.match(key);
        if (hit) {
          const body = await hit.json();
          return body?.unavailable ? LIST_UNAVAILABLE : body;
        }
      } catch {
        // a cache miss or failure falls through to computing the list
      }
    }
  }
  const later = (p) => (ctx?.waitUntil ? ctx.waitUntil(p) : p);
  const put = async (key, body, seconds) => {
    if (!cache) return;
    const p = cache.put(key, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` } }))
      .catch((err) => console.error('public list: cache put failed', err?.message));
    if (ctx?.waitUntil) ctx.waitUntil(p);
    else await p;
  };
  let list;
  try {
    list = await computePublicList(env, kv, { sweep, ...(ctx?.waitUntil ? { defer: (p) => later(p) } : {}) });
  } catch (err) {
    console.error('public list: request records unreadable', String(err?.message || 'unknown').slice(0, 300));
    await put(failedKey(origin, base), { unavailable: true }, FAILED_SECONDS);
    return LIST_UNAVAILABLE;
  }
  if (list.endorsements_unavailable) await put(uncountedKey(origin, base), list, UNAVAILABLE_SECONDS);
  else await put(cacheKey(origin, base), list, SECONDS);
  return list;
}

/** Drop the cached lists in this location, after a steward decision or a clear. */
export async function purgePublicList({ origin, base = '', cache = defaultCache() }) {
  if (!cache) return false;
  let dropped = false;
  for (const key of [cacheKey(origin, base), uncountedKey(origin, base), failedKey(origin, base)]) {
    try {
      dropped = (await cache.delete(key)) || dropped;
    } catch {
      // nothing cached, or the cache is unavailable
    }
  }
  return dropped;
}
