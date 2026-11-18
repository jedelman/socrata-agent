// Reads by the origin's caching rules (src/http-cache.js; Jason, 2026-11-18:
// "caching reads ... respecting invalidation"): validators sent back as
// conditional GETs and a 304 reused, a fresh lifetime honored, no-store
// honored, every request traced and counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedGet, cachingOf, cacheKey } from '../src/http-cache.js';
import { Trace } from '../src/trace.js';

function memoryStore() {
  const m = new Map();
  return {
    m,
    get: async (k, type) => (m.has(k) ? (type === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

const URL_ = 'https://norfolkcityva.iqm2.com/Citizens/FileOpen.aspx?Type=14&ID=3431&Inline=True';

test('a file with Last-Modified: read once, then revalidated with If-Modified-Since; a 304 reuses what was made of it, with no body sent', async () => {
  const store = memoryStore();
  const trace = new Trace();
  const sent = [];
  let parses = 0;
  const fetch = async (url, init) => {
    sent.push(init?.headers || {});
    if (init?.headers?.['If-Modified-Since'] === 'Wed, 14 Oct 2026 19:41:26 GMT') return new Response(null, { status: 304, headers: { 'Last-Modified': 'Wed, 14 Oct 2026 19:41:26 GMT' } });
    return new Response('agenda', { headers: { 'Cache-Control': 'public', Expires: 'Wed, 18 Nov 2026 16:34:06 GMT', Date: 'Wed, 18 Nov 2026 16:34:06 GMT', 'Last-Modified': 'Wed, 14 Oct 2026 19:41:26 GMT' } });
  };
  const parse = async (res) => {
    parses++;
    return { items: [await res.text()] };
  };
  const first = await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 'read agenda file', parse });
  assert.deepEqual(first, { value: { items: ['agenda'] }, from: 'network' });
  const second = await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 'read agenda file', parse });
  assert.deepEqual(second, { value: { items: ['agenda'] }, from: 'revalidated' });
  assert.equal(parses, 1, 'parsed once');
  assert.deepEqual(sent, [{}, { 'If-Modified-Since': 'Wed, 14 Oct 2026 19:41:26 GMT' }]);
  assert.equal(trace.steps.length, 2, 'both requests are in the trace');
  // What's kept is what parse made, never the body.
  const kept = JSON.parse(store.m.get(await cacheKey(URL_)));
  assert.deepEqual(Object.keys(kept).sort(), ['etag', 'fresh_until', 'last_modified', 'url', 'value', 'version']);
});

test('a fresh lifetime means no request until it passes; an ETag goes back as If-None-Match', async () => {
  const store = memoryStore();
  const trace = new Trace();
  let calls = 0;
  const fetch = async (url, init) => {
    calls++;
    if (init?.headers?.['If-None-Match'] === '"v1"') return new Response(null, { status: 304, headers: { ETag: '"v1"', 'Cache-Control': 'max-age=60' } });
    return new Response('x', { headers: { ETag: '"v1"', 'Cache-Control': 'max-age=60' } });
  };
  const parse = async (res) => res.text();
  const now = Date.parse('2026-11-18T12:00:00Z');
  await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, now });
  assert.deepEqual(await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, now: now + 30_000 }), { value: 'x', from: 'fresh' });
  assert.equal(calls, 1);
  assert.deepEqual(await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, now: now + 90_000 }), { value: 'x', from: 'revalidated' });
  assert.equal(calls, 2);
});

test('no-store: nothing kept, every read a full GET; what was kept before is dropped', async () => {
  const store = memoryStore();
  const trace = new Trace();
  let headers = { 'Last-Modified': 'Wed, 14 Oct 2026 19:41:26 GMT' };
  const fetch = async () => new Response('page', { headers });
  const parse = async (res) => res.text();
  await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse });
  assert.equal(store.m.size, 1);
  headers = { 'Cache-Control': 'no-cache, no-store', Expires: '-1' };
  assert.equal((await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse })).from, 'network');
  assert.equal(store.m.size, 0, 'dropped');
  assert.equal((await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse })).from, 'network');
  assert.equal(store.m.size, 0);
});

test('a body that says it is too large is refused before it is read; an error is in the trace; the rules as parsed', async () => {
  const trace = new Trace();
  const fetch = async () => new Response('x', { headers: { 'Content-Length': String(127179609) } });
  await assert.rejects(cachedGet({ store: memoryStore(), fetchImpl: fetch, trace, url: URL_, tool: 'packet', parse: async () => 'never', maxBytes: 5 * 1024 * 1024 }), /too large/);
  assert.match(trace.steps[0].error, /too large/);
  await assert.rejects(cachedGet({ store: memoryStore(), fetchImpl: async () => new Response('', { status: 503 }), trace, url: URL_, tool: 't', parse: async () => '' }), /HTTP 503/);
  const h = (o) => new Headers(o);
  assert.deepEqual(cachingOf(h({ 'Cache-Control': 'no-cache, no-store', Expires: '-1' })), { noStore: true, freshUntil: 0, etag: null, lastModified: null });
  assert.equal(cachingOf(h({ Expires: 'Wed, 18 Nov 2026 16:34:06 GMT', Date: 'Wed, 18 Nov 2026 16:34:06 GMT' })).freshUntil, 0, 'Expires at Date is already stale');
  assert.equal(cachingOf(h({ 'Cache-Control': 'public, max-age=3600' }), 1000).freshUntil, 1000 + 3600_000);
  assert.equal(cachingOf(h({ 'Cache-Control': 'no-cache, max-age=3600' }), 1000).freshUntil, 0, 'no-cache always revalidates');
});

test("the reader's version is in the key: a new reader reads the file again, even unchanged", async () => {
  const store = memoryStore();
  const trace = new Trace();
  let parses = 0;
  const fetch = async (url, init) => (init?.headers?.['If-Modified-Since'] ? new Response(null, { status: 304 }) : new Response('agenda', { headers: { 'Last-Modified': 'Wed, 14 Oct 2026 19:41:26 GMT' } }));
  const parse = async (res) => `${++parses}:${await res.text()}`;
  assert.equal((await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, version: 'v1' })).value, '1:agenda');
  assert.deepEqual(await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, version: 'v1' }), { value: '1:agenda', from: 'revalidated' });
  assert.deepEqual(await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, version: 'v2' }), { value: '2:agenda', from: 'network' });
  assert.notEqual(await cacheKey(URL_, 'v1'), await cacheKey(URL_, 'v2'));
});

test('a body past the cap is refused as it arrives when it gives no Content-Length; nothing is parsed or kept', async () => {
  const store = memoryStore();
  const trace = new Trace();
  let parsed = false;
  const chunk = new Uint8Array(64 * 1024);
  let sent = 0;
  const fetch = async () => new Response(new ReadableStream({
    pull(c) {
      if (sent >= 64) return c.close();
      sent++;
      c.enqueue(chunk);
    },
  }), { headers: { 'Last-Modified': 'Wed, 14 Oct 2026 19:41:26 GMT' } });
  await assert.rejects(cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', maxBytes: 256 * 1024, parse: async () => { parsed = true; } }), /too large/);
  assert.equal(parsed, false);
  assert.ok(sent < 64, `stopped reading early (${sent} of 64 chunks)`);
  assert.equal(store.m.size, 0);
  // Within the cap, the same stream reads in full.
  sent = 60;
  const ok = await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', maxBytes: 256 * 1024 + 1, parse: async (res) => (await res.arrayBuffer()).byteLength });
  assert.equal(ok.value, 4 * 64 * 1024);
});

test("Age counts against a lifetime; a 200 with neither validators nor a lifetime drops what was kept", async () => {
  const store = memoryStore();
  const trace = new Trace();
  const now = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(cachingOf(new Headers({ 'Cache-Control': 'max-age=600', Age: '540' }), now).freshUntil, now + 60_000);
  assert.equal(cachingOf(new Headers({ 'Cache-Control': 'max-age=600', Age: '900' }), now).freshUntil, 0);
  assert.equal(cachingOf(new Headers({ Expires: 'Wed, 18 Nov 2026 12:10:00 GMT', Date: 'Wed, 18 Nov 2026 12:00:00 GMT', Age: '300' }), now).freshUntil, now + 300_000);
  let headers = { 'Last-Modified': 'Wed, 14 Oct 2026 19:41:26 GMT' };
  const fetch = async () => new Response('page', { headers });
  const parse = async (res) => res.text();
  await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, now });
  assert.equal(store.m.size, 1);
  headers = {};
  await cachedGet({ store, fetchImpl: fetch, trace, url: URL_, tool: 't', parse, now });
  assert.equal(store.m.size, 0, 'nothing to check a kept copy against: dropped');
});
