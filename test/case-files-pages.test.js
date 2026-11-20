// The case-file hub pages (worker/case-files.js) through the Worker's own
// fetch handler: off by default (the ordinary 404), on behind
// CASE_FILE_PAGES, every source and finding shown, everything escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CASES } from '../plugins/case-file.js';
import { readyEnv } from './fake-atproto.js';

const skip = typeof nodeModule.registerHooks !== 'function' && 'node:module has no registerHooks';
let worker;
let pages; // worker/case-files.js, imported once its .css import can load
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
  pages = await import('../worker/case-files.js');
  return worker;
}
const ORIGIN = 'https://ask-siren.jason-edelman.org';
const env = (over = {}) => readyEnv({ BLUESKY_LOGIN: undefined, INVITE_REQUIRED: 'true', ...over }); // as Siren runs: invite mode, no sign-in needed for these pages
async function call(e, path, method = 'GET') {
  const w = await loadWorker();
  return w.fetch(new Request(`${ORIGIN}${path}`, { method }), e, { waitUntil: () => {} });
}
const ids = Object.keys(CASES);

test('flag off: /case-files and every case file page are the ordinary 404', { skip }, async () => {
  const e = env();
  const unknown = await call(e, '/no-such-page');
  for (const p of ['/case-files', '/case-files/', ...ids.map((id) => `/case-files/${id}`)]) {
    const res = await call(e, p);
    assert.equal(res.status, unknown.status, p);
    assert.equal(await res.text(), await (await call(e, '/no-such-page')).text(), p);
  }
});

test('flag on: the index lists every case file and pools every source once', { skip }, async () => {
  const res = await call(env({ CASE_FILE_PAGES: 'true' }), '/case-files');
  assert.equal(res.status, 200);
  const csp = res.headers.get('Content-Security-Policy');
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src|unsafe-inline/);
  assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
  const html = await res.text();
  assert.doesNotMatch(html, /<script|style=|\son\w+=/i);
  for (const id of ids) assert.ok(html.includes(`/case-files/${id}"`), id);
  const urls = new Set(Object.values(CASES).flatMap((d) => d.findings.map((f) => f.source.url)));
  const pooled = pages.pooledBibliography(Object.values(CASES)).flatMap((g) => g.sources.map((s) => s.url));
  assert.equal(pooled.length, urls.size, 'each source once');
  assert.deepEqual(new Set(pooled), urls);
  // The stylesheet it names is served, from this origin.
  const css = /href="(\/case-files\/case-files\.[0-9a-f]{8}\.css)"/.exec(html)[1];
  const sheet = await call(env({ CASE_FILE_PAGES: 'true' }), css);
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get('Content-Type'), /text\/css/);
});

test('flag on: each case file page shows every finding, quote and source; unknown ids are 404', { skip }, async () => {
  const e = env({ CASE_FILE_PAGES: 'true' });
  for (const id of ids) {
    const res = await call(e, `/case-files/${id}`);
    assert.equal(res.status, 200, id);
    const html = await res.text();
    const doc = CASES[id];
    for (const f of doc.findings) {
      assert.ok(html.includes(`id="f-${f.id}"`), `${id}#${f.id}`);
      if (f.quote && f.checked && !f.unverified) assert.ok(html.includes(pages.caseFilePage({ ...doc, findings: [f] }).match(/<blockquote>([\s\S]*?)<\/blockquote>/)[1]), `${id}#${f.id} quote`);
    }
    assert.equal((html.match(/<li class="source"/g) || []).length, pages.bibliography(doc).length, id);
  }
  for (const p of ['/case-files/nope', '/case-files/Trees', '/case-files/__proto__', '/case-files/constructor', '/case-files/a/b']) {
    assert.equal((await call(e, p)).status, 404, p);
  }
});

test('escaping: hostile case-file text never becomes markup, and only http(s) URLs become links', { skip }, async () => {
  await loadWorker();
  const { caseFilePage, publisherOf } = pages;
  const doc = {
    id: 'x', title: '<script>alert(1)</script>', summary: '"><img src=x onerror=alert(1)>', steward: 'S', license: 'CC-BY-4.0',
    pending: ['<b>p</b>'], what_would_help: [], records_to_request: [],
    findings: [
      { id: 'a"b', stance: 'confirms', claim: '<i>c</i>', quote: '</blockquote><script>', checked: '2026-01-01', found_by: '<x>', source: { title: '<t>', url: 'javascript:alert(1)' } },
      { id: 'ok', stance: 'weakens', claim: 'c', quote: 'q', checked: '2026-01-01', found_by: 'f', source: { title: 't', url: 'https://www.norfolk.gov/x' } },
    ],
  };
  const html = caseFilePage(doc);
  assert.doesNotMatch(html, /<script|<img|<i>|<b>|<t>|<x>|javascript:/i);
  assert.match(html, /href="https:\/\/www\.norfolk\.gov\/x" rel="noopener noreferrer"/);
  assert.equal(publisherOf('https://www.norfolk.gov/x'), 'City of Norfolk');
  assert.equal(publisherOf('not a url'), 'Other');
});
