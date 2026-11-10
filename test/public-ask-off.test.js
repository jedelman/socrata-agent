// The free tier's flag off (docs/free-tier.md): with PUBLIC_ASK unset, every
// existing route of the Worker answers byte-identically to the code before
// the free tier, and the free tier's paths stay 404s. The snapshot
// (fixtures/public-ask-off-snapshot.json) was taken from b92b124, main plus
// the spec, before any free-tier code (fixtures/public-ask-off-scenario.js
// says how it is normalized: only the asset hash, signed values and trace
// timings).
//
// Three served files changed, as code that the free tier extends: the
// shared modules the browser client is built from. Their status and headers
// must still match; their text can't, and their behavior with the flag off
// is held by the endorse client's own tests (test/endorse-client.test.js,
// test/atproto-oauth.test.js), which run unchanged. Nothing else differs.
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
// record and its scope): their bodies differ, nothing else about them.
const EXTENDED = new Set(['endorse-config.js', 'atproto-oauth.js', 'endorse-client.js']);
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
