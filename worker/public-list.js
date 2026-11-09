// The public request list with endorsement counts, served through the Cache
// API for 60 seconds per Cloudflare location. Only with BLUESKY_LOGIN on
// (callers check blueskyReady); with it off, index.js serves the
// requests-only list as before and nothing here runs. It holds no
// per-viewer state. Where the Cache API isn't present (Node tests, some
// local setups) the list is computed every time.
//
// Counts come from Constellation (constellation.js): one call per listed
// request with a random id, at most CONCURRENCY at a time, behind the
// site-wide breaker BSKY_SITE_RL ('counts'), so at most one round a minute
// per location whatever the traffic. A count that can't be read is never
// shown as 0: the last good one (kept up to 24 hours in the Cache API, with
// its time) is served with `endorsements_as_of`, and without one the item
// says `endorsements_unavailable`.

import { publicRequests, requestRows, idsOf, PUBLIC_ID_RE } from './requests.js';
import { constellationOrigin, countEndorsers, userAgent } from './constellation.js';
import { endorseSubject } from './endorse-config.js';
import { publicOrigin } from './atproto-oauth.js';

export const SECONDS = 60;
export const LAST_GOOD_SECONDS = 86400;
export const CONCURRENCY = 6;
// The request records couldn't be read at all (KV failing): remembered for
// 30 seconds, under its own key, so each view in that time is a cache hit,
// not another KV list.
const FAILED_SECONDS = 30;

/** What /api/requests and the endorser route get when the request records can't be read. */
export const LIST_UNAVAILABLE = Object.freeze({ requests: Object.freeze([]), unavailable: true });

const defaultCache = () => (typeof caches !== 'undefined' && caches?.default ? caches.default : null);
const cacheKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-v2`);
const failedKey = (origin, base) => new Request(`${origin}${base}/__cache/public-requests-failed-v2`);
const lastGoodKey = (origin, base, id) => new Request(`${origin}${base}/__cache/endorse-count-v1/${id}`);

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false; // a limiter that fails counts as limited
  }
}

/** Run `fn` over `items`, at most `n` at a time, in order. */
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** The public base URL (PUBLIC_ORIGIN + base path), for subjects and the User-Agent; null without an origin. */
export function publicBase(env, base) {
  const po = publicOrigin(env);
  return po ? `${po.origin}${base}` : null;
}

/**
 * Live counts for these request ids: Map(id -> { endorsements: n } |
 * { endorsements: n, as_of } | { endorsements: null, unavailable: true }).
 * Only random ids are counted (a legacy id is never a subject). `origin` is
 * the request's own origin, for cache keys only; subjects come from
 * PUBLIC_ORIGIN.
 */
export async function liveCounts(env, ids, { base = '', origin, fetchImpl = fetch, cache = defaultCache(), ctx, now = Date.now() } = {}) {
  const out = new Map();
  const countable = ids.filter((id) => PUBLIC_ID_RE.test(id));
  if (!countable.length) return out;
  const pub = publicOrigin(env);
  const cOrigin = constellationOrigin(env);
  const ua = userAgent(`${pub?.origin || ''}${base}/`);
  const cacheOrigin = origin || pub?.origin || 'https://siren.invalid';
  // One breaker charge per round, before any outbound call.
  const go = Boolean(pub && cOrigin) && (await allowed(env.BSKY_SITE_RL, 'counts'));
  const later = (p) => (ctx?.waitUntil ? ctx.waitUntil(p) : p);
  await mapLimit(countable, CONCURRENCY, async (id) => {
    if (go) {
      try {
        const total = await countEndorsers({ origin: cOrigin, subject: endorseSubject(pub.origin, base, id), fetchImpl, ua });
        out.set(id, { endorsements: total });
        if (cache) {
          const body = JSON.stringify({ total, at: now });
          await later(cache.put(lastGoodKey(cacheOrigin, base, id), new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${LAST_GOOD_SECONDS}` } })).catch(() => {}));
        }
        return;
      } catch {
        // fall through to the last good count
      }
    }
    let lg = null;
    if (cache) {
      try {
        const hit = await cache.match(lastGoodKey(cacheOrigin, base, id));
        lg = hit ? await hit.json() : null;
      } catch {
        lg = null;
      }
    }
    if (lg && Number.isSafeInteger(lg.total) && lg.total >= 0 && Number.isFinite(lg.at) && lg.at <= now && now - lg.at <= LAST_GOOD_SECONDS * 1000) {
      out.set(id, { endorsements: lg.total, as_of: new Date(lg.at).toISOString().slice(0, 16) + 'Z' });
    } else {
      out.set(id, { endorsements: null, unavailable: true });
    }
  });
  return out;
}

/** The list, computed: KV first (throws if it can't be read), then the counts for listed requests. */
export async function computePublicList(env, kv, { now = Date.now(), ...deps } = {}) {
  const rows = await requestRows(kv);
  const listed = rows.filter(([, r]) => r.status === 'accepted' || r.status === 'fulfilled').map(([k, , ids]) => (ids || idsOf(k, null)).id);
  const counts = await liveCounts(env, listed, { ...deps, now });
  return publicRequests(kv, now, { rows, counts });
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
    list = await computePublicList(env, kv, { ...deps, ctx, cache, origin, base });
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
