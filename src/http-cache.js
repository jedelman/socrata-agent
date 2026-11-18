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

// A body read up to `max` bytes; more is refused.
export async function readCapped(res, max) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`too large (over ${max} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
// The key is the URL and the reader's version: a change to how a file is read reads it again.
export const cacheKey = async (url, version = '') => `http-cache:${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${version}\n${url}`))).slice(0, 40)}`;

/** The caching rules a response states: { noStore, freshUntil (ms, or 0), etag, lastModified }. */
export function cachingOf(headers, now = Date.now()) {
  const cc = String(headers.get('cache-control') || '').toLowerCase();
  const noStore = /(?:^|,)\s*no-store\b/.test(cc);
  const noCache = /(?:^|,)\s*no-cache\b/.test(cc);
  let freshUntil = 0;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/.exec(cc);
  // Time a response already spent in caches on the way counts against its lifetime.
  const age = Math.max(0, Number(headers.get('age')) || 0);
  if (!noCache) {
    if (maxAge) freshUntil = Number(maxAge[1]) > age ? now + (Number(maxAge[1]) - age) * 1000 : 0;
    else if (headers.get('expires')) {
      const expires = Date.parse(headers.get('expires'));
      const date = Date.parse(headers.get('date') || '') || now;
      // "Expires: -1" and other bad dates are already expired.
      if (Number.isFinite(expires) && expires - age * 1000 > date) freshUntil = now + (expires - date - age * 1000);
    }
  }
  return { noStore, freshUntil, etag: headers.get('etag') || null, lastModified: headers.get('last-modified') || null };
}

/**
 * GET `url` by those rules. `store` is KV-like ({ get(key, 'json'), put(key,
 * value, { expirationTtl }) }); `fetchImpl` the caller's counting fetch; `trace`
 * a Trace (src/trace.js); `parse(response)` makes the JSON kept and returned.
 * `maxBytes` refuses a body larger than that, before reading it when it says
 * so, and as it arrives when it doesn't. `version` names the reader.
 * Returns { value, from: 'fresh' | 'revalidated' | 'network' }.
 */
export async function cachedGet({ store, fetchImpl, trace, url, tool, parse, maxBytes = 8 * 1024 * 1024, version = '', now = Date.now() }) {
  const key = await cacheKey(url, version);
  let held = null;
  try {
    held = store ? await store.get(key, 'json') : null;
  } catch { /* a cache read that fails is a miss */ }
  if (held && (held.url !== url || (held.version || '') !== version)) held = null;
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
    // Read with a cap, whatever the body says of itself, then hand parse the bytes as a response.
    const bytes = await readCapped(res, maxBytes);
    return { result: { value: await parse(new Response(bytes, { status: res.status, headers: res.headers })), from: 'network', rules }, rows: null };
  });
  if (store) {
    try {
      const keepable = out.rules.freshUntil || out.rules.etag || out.rules.lastModified || out.from === 'revalidated';
      if (out.rules.noStore || !keepable) {
        // The origin now says keep nothing, or gives nothing to check against: drop what was kept.
        if (held) await store.delete(key);
      } else {
        await store.put(key, JSON.stringify({
          url,
          version,
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
