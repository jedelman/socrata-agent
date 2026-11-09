// The public request list with endorsement counts, served through the Cache
// API for 60 seconds per Cloudflare location, so the counts are read from D1
// (one row per request with endorsements) at most once a minute per location
// however busy the page is.
// It holds no per-viewer state. Where the Cache API isn't present (Node tests,
// some local setups) the list is computed every time.
//
// What bounds its D1 reads when the cache doesn't (docs/bluesky-endorsements.md,
// "Siren's worst case on the account's D1"): a site-wide Rate Limiting
// breaker (BSKY_D1_RL, key 'list') runs before any D1 call, so a location
// asks D1 at most that often a minute whatever the cache does; and each
// computation that asks for counts is charged first to the daily 'list' pot
// in siren_d1_budget (LIST in endorsements.js), so the counts are read at
// most LIST.calls times a day across the whole account. Neither depends on
// KV's daily list operations running out, which would also stop Scout's
// runs (the doc's "The public list and the account's KV list operations").
//
// The request records are read from KV first, and D1 is asked only after
// that succeeds. Each computation is one KV list, from the account's 1,000 a
// day on Free; the 60-second cache is what holds that down, and a list
// without counts is cached as long as a counted one so a D1 outage doesn't
// add KV lists.

import { publicRequests, requestRows } from './requests.js';
import { endorsementCounts, publicPolicy, orphanedIds, sweepOrphans, endorseDb, chargeD1, ROWS } from './endorsements.js';

export const SECONDS = 60;
// A list computed without counts (D1 failed, the breaker was tripped, or the
// day's list pot is spent) is cached under its own key for as long as a
// counted one, so a D1 outage (on the Free plan, the account's daily row
// limits until midnight UTC, which Scout can reach too) costs no more KV
// lists than a normal day: about one per location a minute.
export const UNAVAILABLE_SECONDS = SECONDS;
// The request records couldn't be read at all (KV failing, or past its daily
// list operations): remembered for 30 seconds, under its own key, so each
// view in that time is a cache hit, not another KV list.
const FAILED_SECONDS = 30;

/** What /api/requests and the Bluesky routes get when the request records can't be read. */
export const LIST_UNAVAILABLE = Object.freeze({ requests: Object.freeze([]), unavailable: true });

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
 * If D1 fails, the breaker refuses or the day's list pot is spent, the list
 * is still served, without counts and flagged `endorsements_unavailable`;
 * cachedPublicList caches that for 60 seconds, under its own key.
 */
export async function computePublicList(env, kv, { defer, sweep = true, now = Date.now() } = {}) {
  const rows = await requestRows(kv);
  const db = endorseDb(env);
  let counts;
  if (db && (await allowed(env.BSKY_D1_RL, 'list'))) {
    try {
      if (await chargeD1(db, env, { pot: 'list', calls: 1, writes: ROWS.budget, now })) counts = await endorsementCounts(db);
    } catch (err) {
      console.error('public list: endorsement counts failed', err?.cause?.message || err?.message);
    }
  }
  const statuses = new Map();
  const list = await publicRequests(kv, now, { counts, policy: publicPolicy(env), statuses, rows });
  if (!counts) return { ...list, endorsements_unavailable: true };
  if (sweep && orphanedIds(counts, statuses).length) {
    const pending = sweepOrphans(db, env, counts, statuses, { now });
    if (defer) defer(pending);
    else await pending;
  }
  return list;
}

/**
 * -> { requests, withdrawn } or LIST_UNAVAILABLE. Never throws: a
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
