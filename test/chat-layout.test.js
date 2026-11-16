// The chat page's layout and welcome screen (Jason, 2026-11-16: "more
// congruent with familiar chatbot interfaces (conversations on the left, new
// by default, entry at the bottom, etc.) and drop the 'what's on my block and
// who decided it?' messaging", leading with the metasearch and the
// self-improvement loop). The deployment supplies the welcome's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readyEnv } from './fake-atproto.js';
import siren from '../deployments/siren.config.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
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
const pageFor = async (env) => {
  const w = await loadWorker();
  return (await w.fetch(new Request('https://ask-siren.jason-edelman.org/'), env, { waitUntil: () => {} })).text();
};
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('the old block messaging is gone from the page and its script', () => {
  for (const f of ['worker/ui.html', 'worker/chat-page.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /what's on my block/i, f);
    assert.doesNotMatch(src, /who decided/i, f);
  }
});

test('the shell: a sidebar of conversations on the left, the composer at the bottom, a welcome screen by default', () => {
  const ui = read('worker/ui.html');
  const at = (s) => { const i = ui.indexOf(s); assert.ok(i >= 0, s); return i; };
  // The sidebar comes first and holds New conversation and the member's conversations.
  assert.ok(at('<aside class="sidebar" id="sidebar"') < at('id="conv-new"'));
  assert.ok(at('id="conv-new"') < at('<div class="convbar" id="convbar" hidden>'));
  assert.ok(at('<!-- /convbar -->') < at('<div class="main">'));
  // The main column: the top bar, the scrolling conversation, then the composer.
  assert.ok(at('<header class="topbar">') < at('<div class="scroller" id="scroller">'));
  assert.ok(at('<section class="welcome" id="welcome">') < at('<main id="log"'));
  assert.ok(at('<main id="log"') < at('<form id="f" class="composer">'));
  // The welcome screen starts visible: a new conversation is the default.
  assert.doesNotMatch(ui, /<section class="welcome" id="welcome" hidden/);
  // On a narrow screen the sidebar has a way in and a way out.
  assert.match(ui, /id="side-open" aria-label="Open the menu" aria-controls="sidebar" aria-expanded="false"/);
  assert.match(ui, /id="side-close" aria-label="Close the menu"/);
  const css = read('worker/chat.css');
  assert.match(css, /@media \(max-width: 899px\) \{\n  \.sidebar \{ position: fixed;/);
  assert.match(read('worker/chat-page.js'), /window\.matchMedia\('\(max-width: 899px\)'\)/, 'the script and the style agree on narrow');
});

test("Siren's welcome: its intro, three points and examples, escaped, with every placeholder filled", { skip }, async () => {
  const html = await pageFor(readyEnv({ DEPLOYMENT: 'siren', BLUESKY_LOGIN: undefined }));
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'no placeholder left');
  assert.equal(decode(/<p id="intro">([^<]*)<\/p>/.exec(html)[1]), siren.ui.intro);
  const points = [...html.matchAll(/<li><strong>([^<]*)<\/strong> ([^<]*)<\/li>/g)].map((m) => decode(m[1]));
  assert.deepEqual(points, siren.ui.points.map((p) => p.title));
  const examples = JSON.parse(decode(/data-examples="([^"]*)"/.exec(html)[1]));
  assert.deepEqual(examples, siren.ui.examples);
  for (const e of examples.norfolk) assert.doesNotMatch(e, /on my block|who decided/i, e);
});

test('a deployment without welcome words gets plain ones, no points and no examples of its own', { skip }, async () => {
  const html = await pageFor(readyEnv({ BLUESKY_LOGIN: undefined }));
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  assert.match(html, /<p id="intro">Ask about anything in the city&#39;s open data|<p id="intro">Ask about anything in the city's open data/);
  assert.doesNotMatch(html, /<ul class="points">/);
  assert.match(html, /data-examples="\{\}"/);
});
