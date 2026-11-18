// Reads that respect the origin's caching rules (Jason, 2026-11-18: "caching
// reads ... and respecting invalidation"). Siren's requests are plain fetch,
// in Node and in Workers; neither keeps an HTTP cache for these reads (Node
// has none, and Cloudflare caches a subrequest by its URL's extension, which
// an .aspx file link isn't), so this does it by the HTTP rules:
// - `Cache-Control: no-store`: nothing is kept; every read is a full GET.
// - A fresh lifetime (`max-age`, or `Expires` past the response's `Date`):
//   no request until it passes.
// - Validators (`ETag`, `Last-Modified`): kept, and sent back as
//   `If-None-Match` / `If-Modified-Since`. A 304 reuses what was made of the
//   body before; the body isn't sent again.
// That's one request either way. A HEAD and then a GET would be two whenever
// the file had changed, and Cloudflare's cache may send a HEAD on as a GET.
// Checked 2026-11-18: iqm2's agenda files send `Last-Modified` and answer
// `If-Modified-Since` with a 304; its item and meeting pages send `no-cache,
// no-store` with no validators; a Socrata query's ETag never comes back 304.
//
// What's kept is what `parse` made of the body (JSON), never the body itself,
// keyed by a hash of the URL, for 30 days unless read again. Every request
// goes through the caller's trace and counting fetch.

const KEEP = 30 * 86400;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const cacheKey = async (url) => `http-cache:${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(url)))).slice(0, 40)}`;

/** The caching rules a response states: { noStore, freshUntil (ms, or 0), etag, lastModified }. */
export function cachingOf(headers, now = Date.now()) {
  const cc = String(headers.get('cache-control') || '').toLowerCase();
  const noStore = /(?:^|,)\s*no-store\b/.test(cc);
  const noCache = /(?:^|,)\s*no-cache\b/.test(cc);
  let freshUntil = 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/.exec(cc);
  if (!noCache) {
    if (maxAge) freshUntil = now + Number(maxAge[1]) * 1000;
    else if (headers.get('expires')) {
      const expires = Date.parse(headers.get('expires'));
      const date = Date.parse(headers.get('date') || '') || now;
      // "Expires: -1" and other bad dates are already expired.
      if (Number.isFinite(expires) && expires > date) freshUntil = now + (expires - date);
    }
  }
  return { noStore, freshUntil, etag: headers.get('etag') || null, lastModified: headers.get('last-modified') || null };
}

/**
 * GET `url` by those rules. `store` is KV-like ({ get(key, 'json'), put(key,
 * value, { expirationTtl }) }); `fetchImpl` the caller's counting fetch; `trace`
 * a Trace (src/trace.js); `parse(response)` makes the JSON kept and returned.
 * `maxBytes` refuses a body that says it's larger, before reading it.
 * Returns { value, from: 'fresh' | 'revalidated' | 'network' }.
 */
export async function cachedGet({ store, fetchImpl, trace, url, tool, parse, maxBytes = 8 * 1024 * 1024, now = Date.now() }) {
  const key = await cacheKey(url);
  let held = null;
  try {
    held = store ? await store.get(key, 'json') : null;
  } catch { /* a cache read that fails is a miss */ }
  if (held && held.url !== url) held = null;
  if (held && held.fresh_until > now) return { value: held.value, from: 'fresh' };
  const headers = {};
  if (held?.etag) headers['If-None-Match'] = held.etag;
  if (held?.last_modified) headers['If-Modified-Since'] = held.last_modified;
  const out = await trace.record({ tool, url }, async () => {
    const res = await fetchImpl(url, Object.keys(headers).length ? { headers } : undefined);
    const rules = cachingOf(res.headers, now);
    if (res.status === 304 && held) {
      await res.body?.cancel?.();
      return { result: { value: held.value, from: 'revalidated', rules, keep: held }, rows: null };
    }
    if (!res.ok) {
      await res.body?.cancel?.();
      throw new Error(`HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length') || 0);
    if (length > maxBytes) {
      await res.body?.cancel?.();
      throw new Error(`too large (${length} bytes)`);
    }
    return { result: { value: await parse(res), from: 'network', rules }, rows: null };
  });
  if (store) {
    try {
      if (out.rules.noStore) {
        // The origin now says keep nothing: drop what was kept.
        if (held) await store.delete(key);
      } else if (out.rules.freshUntil || out.rules.etag || out.rules.lastModified || out.from === 'revalidated') {
        await store.put(key, JSON.stringify({
          url,
          etag: out.rules.etag || (out.from === 'revalidated' ? held?.etag : null) || null,
          last_modified: out.rules.lastModified || (out.from === 'revalidated' ? held?.last_modified : null) || null,
          fresh_until: out.rules.freshUntil,
          value: out.value,
        }), { expirationTtl: KEEP });
      }
    } catch { /* the cache is a convenience; the read itself succeeded */ }
  }
  return { value: out.value, from: out.from };
}
