// The steward pages' header (worker/index.js adminHeader; Jason, 2026-11-16:
// "add a header menu to the admin pages"): every admin page carries the same
// header, the app's name linking to /admin, the menu with the current page
// marked, and a link back to the app. Public questions and shared sources
// join the menu only when they're on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readyEnv } from './fake-atproto.js';

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

const ORIGIN = 'https://ask-siren.jason-edelman.org';
const page = async (env, path) => {
  const w = await loadWorker();
  const res = await w.fetch(new Request(`${ORIGIN}${path}`), env, { waitUntil: () => {} });
  return { status: res.status, text: await res.text(), csp: res.headers.get('Content-Security-Policy') };
};
const menu = (html) => {
  const nav = /<nav class="adminhead-nav" aria-label="Steward pages">(.*?)<\/nav>/.exec(html)?.[1] || '';
  return [...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((m) => `${m[3]}${m[2] ? '*' : ''}`);
};

test('every steward page has the header: the name to /admin, the menu with this page marked, and the way back', { skip }, async () => {
  const env = readyEnv({ DEPLOYMENT: 'siren', BLUESKY_LOGIN: undefined });
  for (const [path, current] of [['/admin', 'Requests'], ['/admin/waitlist', 'Waitlist'], ['/admin/spend', 'Spend']]) {
    const p = await page(env, path);
    assert.equal(p.status, 200, path);
    assert.match(p.text, /<header class="adminhead"><div class="adminhead-in"><a class="adminhead-brand" href="\/admin">Siren <span>steward<\/span><\/a>/, path);
    assert.match(p.text, /<a class="adminhead-back" href="\/">Back to Siren<\/a>/, path);
    assert.deepEqual(menu(p.text), ['Requests', 'Waitlist', 'Spend'].map((m) => (m === current ? `${m}*` : m)), path);
    assert.ok(p.text.indexOf('<header class="adminhead">') < p.text.indexOf('<div class="wrap">'), `${path}: the header comes first`);
  }
  // The new pages keep the strict policy.
  for (const path of ['/admin/waitlist', '/admin/spend']) assert.match((await page(env, path)).csp, /^default-src 'none'; script-src 'self' .*style-src 'self';/, path);
});

test('with public questions and shared sources on, their pages join the menu and carry the header too', { skip }, async () => {
  const env = readyEnv({ DEPLOYMENT: 'siren', PUBLIC_ASK: 'true', SHARED_RESEARCH: 'true', INVITE_REQUIRED: 'true', SIREN_DB: { prepare: () => { throw new Error('no D1 on these pages'); } } });
  const all = ['Requests', 'Waitlist', 'Spend', 'Public questions', 'Shared sources'];
  for (const [path, current] of [['/admin', 'Requests'], ['/admin/questions', 'Public questions'], ['/admin/research', 'Shared sources']]) {
    const p = await page(env, path);
    assert.equal(p.status, 200, `${path}: ${p.text.slice(0, 120)}`);
    assert.deepEqual(menu(p.text), all.map((m) => (m === current ? `${m}*` : m)), path);
  }
});

test('the header lives in every template that a steward page serves', () => {
  for (const f of ['admin-waitlist.html', 'admin-spend.html', 'admin-questions.html', 'admin-research.html']) assert.match(readFileSync(new URL(`../worker/${f}`, import.meta.url), 'utf8'), /\{\{HEADER\}\}\n<div class="wrap">/, f);
  assert.match(readFileSync(new URL('../worker/admin.html', import.meta.url), 'utf8'), /\{\{ADMIN_HEADER\}\}\n<div class="wrap">/);
  for (const f of ['admin.css', 'questions.css', 'admin.html']) assert.match(readFileSync(new URL(`../worker/${f}`, import.meta.url), 'utf8'), /\.adminhead-nav a\[aria-current="page"\]/, f);
});
