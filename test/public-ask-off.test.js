// The free tier's flag off (docs/free-tier.md): with PUBLIC_ASK unset, every
// existing route of the Worker answers byte-identically to the code before
// the free tier, and the free tier's paths stay 404s. The snapshot
// (fixtures/public-ask-off-snapshot.json) was taken from main at f6f0e9e, main plus
// the spec, before any free-tier code, and retaken on f6f0e9e plus
// conversation browsing and search, which isn't free-tier code, and again
// with the answer-links change's diff to chat-page.js and chat.css (links
// checked against the hand-off, follow-up offers, the stacked request card;
// only those two assets' bodies moved, in all three envs), and with research
// memory's chat.css rules (the "Share these sources" card; only chat.css's
// three entries were retaken, from a run on the change: nothing else moved)
// (fixtures/public-ask-off-scenario.js says how it is normalized: only the
// asset hash, signed values and trace timings).
//
// Four served files changed. Three are code that the free tier extends: the
// shared modules the browser client is built from; their behavior with the
// flag off is held by the endorse client's own tests (test/endorse-client.test.js,
// test/atproto-oauth.test.js), which run unchanged. The fourth is the chat
// page's script: its DOMPurify options now also drop data attributes, form
// controls and dialogs from model output (the free tier's review asked for
// it on every page that renders answers; test/move.test.js pins the line).
// Their status and headers must still match; their text can't. Nothing else
// differs. The scheduled handler (the free tier's sweep, and its ping to the
// Jetstream watcher, a Durable Object exported from index.js since the
// instant-takedowns change) does none of the free tier's work with the flag
// off: tested below. Since the steward's spend page (2026-11-16) it does one
// thing then, the daily spend rollup, in KV alone. The steward pages it
// added changed one existing route: GET /admin carries the steward pages'
// header menu, so its three entries were retaken from a run on that change
// (nothing else moved). The chat page's new layout (2026-11-16: a sidebar of
// conversations, the composer at the bottom, a welcome screen) retook GET /,
// /index.html, /login and chat.css in each env the same way, from a run on
// that change; HEAD / and everything else stayed as they were. Watches and
// civic-league feeds (2026-11-16, behind WATCHES and LEAGUE_FEEDS, both off
// here) add the watch card's style to chat.css, so its three entries were
// retaken from a run on that change; the page itself, with both flags off,
// came out byte for byte as before (asset hash aside). The new export and binding change no route: the scenario's envs
// don't carry the binding, and its snapshot is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publicAskOffScenario } from './fixtures/public-ask-off-scenario.js';

const skip = typeof nodeModule.registerHooks !== 'function' && 'node:module has no registerHooks';
let worker;
async function loadWorker() {
  if (worker) return worker;
  const asText = (url) => ({ format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true });
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && (context.importAttributes?.type === 'text' || url.endsWith('.html'))) return asText(url);
      if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  worker = (await import('../worker/index.js')).default;
  return worker;
}

const SNAPSHOT = JSON.parse(readFileSync(new URL('./fixtures/public-ask-off-snapshot.json', import.meta.url), 'utf8'));
// The served modules the free tier extends (the ask client, the question
// record and its scope) and the chat script (its sanitizer options): their
// bodies differ, nothing else about them.
const EXTENDED = new Set(['endorse-config.js', 'atproto-oauth.js', 'endorse-client.js', 'chat-page.js']);
const extended = (e) => [...EXTENDED].some((f) => e.label === `GET asset ${f}` || (e.label === 'GET stale asset' && f === 'endorse-client.js'));

function compare(now) {
  assert.equal(now.length, SNAPSHOT.length, 'the same cases');
  for (let i = 0; i < SNAPSHOT.length; i++) {
    const want = SNAPSHOT[i];
    const got = now[i];
    const where = `${want.env} ${want.label}`;
    assert.equal(got.label, want.label, where);
    if (extended(want)) {
      assert.equal(got.status, want.status, where);
      assert.deepEqual(got.headers, want.headers, where);
      assert.notDeepEqual(got.body, want.body, `${where}: expected to have changed; if not, take it off EXTENDED`);
      continue;
    }
    assert.deepEqual(got, want, where);
  }
}

test('flag off: every existing route answers exactly as before the free tier, and its paths are 404s', { skip }, async () => {
  const w = await loadWorker();
  compare(await publicAskOffScenario({ worker: w }));
});

test('flag off: PUBLIC_ASK set to anything but "true" is the same as unset', { skip }, async () => {
  const w = await loadWorker();
  for (const value of ['false', '1', 'TRUE', ' true', '']) compare(await publicAskOffScenario({ worker: w, extraEnv: { PUBLIC_ASK: value } }));
});

test('flag off: the scheduled handler does none of the free tier\'s work (no D1 call, fetch, Durable Object or log), only the spend rollup in KV', { skip }, async () => {
  const w = await loadWorker();
  const touched = [];
  const d1 = new Proxy({}, { get: (t, k) => () => { touched.push(`D1 ${String(k)}`); throw new Error('D1 touched'); } });
  // The Jetstream watcher's namespace (worker/question-watcher.js): never even asked for an id.
  const watcher = new Proxy({}, { get: (t, k) => () => { touched.push(`QUESTION_WATCHER ${String(k)}`); throw new Error('Durable Object touched'); } });
  const real = { fetch: globalThis.fetch, error: console.error, log: console.log };
  globalThis.fetch = async (u) => { touched.push(`fetch ${u}`); throw new Error('network'); };
  console.error = (...a) => touched.push(`log ${a.join(' ')}`);
  console.log = console.error;
  const limiter = { limit: async () => { touched.push('limiter'); return { success: true }; } };
  try {
    for (const flag of [undefined, 'false', '', 'TRUE']) {
      // A KV that records every key it's asked about: only the spend rollup's.
      const store = new Map();
      const LIMITS = {
        async get(k) { touched.push(`kv get ${k}`); return store.get(k) ?? null; },
        async put(k, v) { touched.push(`kv put ${k}`); store.set(k, v); },
        async list({ prefix }) { touched.push(`kv list ${prefix}`); return { keys: [], list_complete: true }; },
        async delete(k) { touched.push(`kv delete ${k}`); },
      };
      const env = { PUBLIC_ASK: flag, BLUESKY_LOGIN: 'true', INVITE_REQUIRED: 'true', INVITE_SECRET: 's'.repeat(32), IP_SALT: 'x', LIMITS, SIREN_DB: d1, QUESTION_WATCHER: watcher, PUBLIC_ORIGIN: 'https://ask-siren.jason-edelman.org', BSKY_VISITOR_RL: limiter, BSKY_INPUT_RL: limiter, BSKY_SITE_RL: limiter };
      const waits = [];
      await w.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p) });
      assert.equal(waits.length, 1, `${flag}: one job, the rollup`);
      await Promise.all(waits);
      // Without a usable KV (none, or one without list), nothing at all.
      const none = [];
      await w.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, { ...env, LIMITS: {} }, { waitUntil: (p) => none.push(p) });
      assert.equal(none.length, 0, String(flag));
    }
  } finally {
    Object.assign(globalThis, { fetch: real.fetch });
    console.error = real.error;
    console.log = real.log;
  }
  // Only spend keys: the rollup's marker, its daily totals and the call records it sums.
  assert.ok(touched.length > 0, 'the rollup ran');
  for (const t of touched) assert.match(t, /^kv (get|put|list) (spend-since|spend-day:\d{4}-\d{2}-\d{2}|spend:\d{4}-\d{2}-\d{2}:)$/, t);
});
