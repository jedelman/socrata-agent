// The public request list with endorsement counts, served through the Cache
// API for 60 seconds per Cloudflare location. Only with BLUESKY_LOGIN on
// (callers check blueskyReady); with it off, index.js serves the
// requests-only list as before. It holds no per-viewer state. Where the
// Cache API isn't present (Node tests, some local setups) the list is
// computed every time.

import { publicRequests, requestRows } from './requests.js';

export const SECONDS = 60;
// The request records couldn't be read at all (KV failing): remembered for
// 30 seconds, under its own key, so each view in that time is a cache hit,
// not another KV list.
const FAILED_SECONDS = 30;

/** What /api/requests and the endorser route get when the request records can't be read. */
export const LIST_UNAVAILABLE = Object.freeze({ requests: Object.freeze([]), unavailable: true });

const defaultCache = () => (typeof caches !== 'undefined' && caches?.default ? caches.default : null);
const cacheKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-v2`);
const failedKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-failed-v2`);

/** The list, computed. Throws if the request records can't be read. */
export async function computePublicList(env, kv, { now = Date.now() } = {}) {
  const rows = await requestRows(kv);
  return publicRequests(kv, now, { rows });
}

/**
 * -> { requests, withdrawn } or LIST_UNAVAILABLE. Never throws: a failure to
 * read the request records is logged, remembered for 30 seconds under its
 * own key, and answered as LIST_UNAVAILABLE.
 */
export async function cachedPublicList({ env, ctx, kv, origin, base = '', cache = defaultCache(), ...deps }) {
  if (cache) {
    for (const key of [cacheKey(origin, base), failedKey(origin, base)]) {
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
  const put = async (key, body, seconds) => {
    if (!cache) return;
    const p = cache.put(key, new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` } }))
      .catch((err) => console.error('public list: cache put failed', err?.message));
    if (ctx?.waitUntil) ctx.waitUntil(p);
    else await p;
  };
  let list;
  try {
    list = await computePublicList(env, kv, { ...deps, cache, origin, base });
  } catch (err) {
    console.error('public list: request records unreadable', String(err?.message || 'unknown').slice(0, 300));
    await put(failedKey(origin, base), { unavailable: true }, FAILED_SECONDS);
    return LIST_UNAVAILABLE;
  }
  await put(cacheKey(origin, base), list, SECONDS);
  return list;
}

/** Drop the cached lists in this location, after a steward decision. */
export async function purgePublicList({ origin, base = '', cache = defaultCache() }) {
  if (!cache) return false;
  let dropped = false;
  for (const key of [cacheKey(origin, base), failedKey(origin, base)]) {
    try {
      dropped = (await cache.delete(key)) || dropped;
    } catch {
      // nothing cached, or the cache is unavailable
    }
  }
  return dropped;
}
