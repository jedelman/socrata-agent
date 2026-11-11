// The free tier through the Worker's own fetch handler (docs/free-tier.md):
// the notices' exact copy, the pages under a strict CSP with every remote
// string escaped, the assets served only with the flag on, an ask end to end
// with the agent the private chat runs, and the privacy test: no D1
// statement and no KV key or value written on the public routes puts an
// invite or a visitor hash beside a DID, and nothing logged names either.
// Loads index.js through a module hook, as test/requests-page.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { entryHtml, threadHtml, answerHtml, publicLine, md, esc, WITHDRAWN, HIDDEN, PURIFY, RECHECKS, CLOSED } from '../worker/questions-page.js';
import { rowHtml } from '../worker/admin-questions.js';
import { QUESTION_NSID, buildQuestion } from '../worker/endorse-config.js';
import { newCode, inviteKey } from '../worker/invites.js';
import { threadQuestion } from '../worker/questions.js';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import { visitorId } from '../worker/limits.js';
import { W, fakeNetwork, readyEnv, SECRET } from './fake-atproto.js';
import { fakeD1, hasSqlite } from './fake-d1.js';
import { claudeResponse } from './fake-claude.js';

const canHook = typeof nodeModule.registerHooks === 'function';
const skip = (!canHook && 'node:module has no registerHooks') || (!hasSqlite && 'node:sqlite is missing');
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
const IP = '203.0.113.9';
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The exact copy (docs/free-tier.md, "The notice").
const NOTICE = "Everything here is public. Each question, Siren's answer, how she found it, and the asker's Bluesky handle can be read by anyone.";
const ASK_NOTICE = "Ask in public. Sign in with Bluesky and an invite to ask. Your question, Siren's answer, how she found it and your Bluesky handle will be public on this site, and your question is saved as a record in your own Bluesky account, public on the network like a post. You can delete it at any time, here or in your account, and Siren takes its page down; copies other people made may remain. For a private question, use email sign-in on the main page.";
const PUBLIC_LINE = 'Public: anyone can read this question and its answer, with your handle @alice.bsky.social.';
const CHAT_LINE = 'Want to ask in public instead? Sign in with Bluesky at the public questions page.';
const DATA_NOTE = 'Each question, and what Siren finds for it, goes to Anthropic, whose model writes the answer. Anthropic keeps them for 30 days and may review them for safety and security.';

function env(over = {}) {
  return readyEnv({
    PUBLIC_ASK: 'true', INVITE_REQUIRED: 'true', SIREN_DB: fakeD1(), DEPLOYMENT: 'siren', MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-test',
    ADMIN_EMAILS: 'steward@example.org', ...over,
  });
}
const call = async (w, e, path, init = {}) => {
  const waits = [];
  const headers = new Headers(init.headers || {});
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', IP);
  const res = await w.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), e, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
};
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

// The outside world for an ask: the fake atproto network, and the model
// answering one plain sentence (keeping every request body it was sent).
function outside(net, bodies = [], opts = {}) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.anthropic.com/v1/messages')) {
      bodies.push(JSON.parse(init.body));
      // The model refusing the request outright (a 400 isn't retried).
      if (opts.fail) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_x' } });
      return claudeResponse(init, { id: 'msg_q', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: 'I found no permits at that address.' }], usage: { input_tokens: 900, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    }
    return net.fetch(url, init);
  };
}
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
function questionRecord(net, { text: t = 'What permits are open at 810 Union St?', now = Date.now(), did = W.DID, reply = null } = {}) {
  const rkey = net.state.nextTid();
  const record = buildQuestion({ text: t, city: 'norfolk', now, reply });
  net.state.putRecord(did, QUESTION_NSID, rkey, record, { index: false });
  return { uri: `at://${did}/${QUESTION_NSID}/${rkey}`, cid: net.state.cidOf(record), rkey, record };
}
async function inviteCookie(e) {
  const code = newCode();
  await e.LIMITS.put(await inviteKey(code), JSON.stringify({ label: 'test', max_uses: 5 }));
  return code;
}

test('the notices, exactly: at the top of /questions and /q/<id>, and in the ask panel; the line beside the ask button', { skip }, async () => {
  const w = await loadWorker();
  const e = env();
  const net = fakeNetwork();
  const page = await call(w, e, '/questions');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal(text(/<p class="public-notice" id="public-notice">([\s\S]*?)<\/p>/.exec(html)[1]), NOTICE);
  assert.equal(text(/<p id="ask-notice">([\s\S]*?)<\/p>/.exec(html)[1]), ASK_NOTICE);
  assert.ok(html.indexOf('public-notice') < html.indexOf('id="ask"'), 'the notice comes first, at the top');
  assert.ok(html.includes(`<p>${DATA_NOTE}</p>`), "the footer's data note shows here too");
  assert.equal(publicLine('alice.bsky.social'), PUBLIC_LINE);
  // A question's own page carries the same notice at the top.
  const code = await inviteCookie(e);
  await withFetch(outside(net), async () => {
    const red = await call(w, e, '/api/public/redeem', post({ code }));
    const cookie = red.headers.get('Set-Cookie').split(';')[0];
    const rec = questionRecord(net);
    const out = await call(w, e, '/api/public/ask', post({ uri: rec.uri, cid: rec.cid }, { Cookie: cookie }));
    assert.equal(out.status, 200, await out.clone().text());
    const { id } = await out.json();
    const one = await call(w, e, `/q/${id}`);
    assert.equal(one.status, 200);
    const oneHtml = await one.text();
    assert.equal(text(/<p class="public-notice" id="public-notice">([\s\S]*?)<\/p>/.exec(oneHtml)[1]), NOTICE);
    assert.match(oneHtml, new RegExp(`data-focus="${id}"`));
  });
  // The docs keep the same copy (the spec is the contract).
  const spec = read('docs/free-tier.md').replace(/\n> ?/g, ' ').replace(/&lt;handle&gt;/, '<handle>');
  for (const copy of [NOTICE, ASK_NOTICE.replace('Ask in public.', '**Ask in public.**'), CHAT_LINE]) assert.ok(spec.replace(/\s+/g, ' ').includes(copy), copy.slice(0, 40));
  assert.ok(spec.replace(/\s+/g, ' ').includes('Public: anyone can read this question and its answer, with your handle @<handle>.'));
});

test("the chat page's link to the public door, and the steward's to the questions page: only with the flag on", { skip }, async () => {
  const w = await loadWorker();
  const on = await (await call(w, env(), '/')).text();
  assert.equal(text(/<p class="convbar" id="public-door">([\s\S]*?)<\/p>/.exec(on)[1]), CHAT_LINE);
  assert.match(on, /<a href="questions">the public questions page<\/a>/);
  for (const off of [env({ PUBLIC_ASK: undefined }), env({ PUBLIC_ASK: 'false' }), env({ SIREN_DB: undefined })]) {
    const html = await (await call(w, off, '/')).text();
    assert.ok(!html.includes('public-door') && !html.includes('Want to ask in public'), 'no link');
    assert.ok(!html.includes('{{PUBLIC_DOOR}}'));
  }
  const admin = await (await call(w, env(), '/admin')).text();
  assert.match(admin, /<a href="admin\/questions">Public questions<\/a>/);
  const adminOff = await (await call(w, env({ PUBLIC_ASK: undefined }), '/admin')).text();
  assert.ok(!adminOff.includes('admin/questions') && !adminOff.includes('{{QUESTIONS_LINK}}'));
});

test('the new pages: a strict CSP, no inline script, style or handler, noindex, and every module they load is served', { skip }, async () => {
  const w = await loadWorker();
  const e = env();
  for (const path of ['/questions', '/admin/questions']) {
    const res = await call(w, e, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('X-Robots-Tag'), 'noindex', path);
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    const csp = res.headers.get('Content-Security-Policy');
    assert.match(csp, /^default-src 'none'; /);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /style-src 'self';/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), path);
    const scripts = /script-src ([^;]+);/.exec(csp)[1].split(' ');
    const allowed = ["'self'", 'https://static.cloudflareinsights.com/beacon.min.js', 'https://static.cloudflareinsights.com/beacon.min.js/',
      ...(path === '/questions' ? ['https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js'] : [])];
    assert.deepEqual(scripts.sort(), allowed.sort(), `${path}: this origin, the two pinned files, the beacon`);
    if (path === '/admin/questions') assert.match(csp, /connect-src 'self';/);
    const html = await res.text();
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline script');
    assert.ok(!/<style/.test(html) && !/\sstyle="/.test(html), 'no inline style');
    assert.ok(!/\son[a-z]+="/i.test(html), 'no inline handlers');
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'every placeholder filled');
    for (const m of html.matchAll(/<script src="(https:[^"]+)"([^>]*)>/g)) assert.match(m[2], /integrity="sha384-[^"]+" crossorigin="anonymous"/, 'pinned with integrity');
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[0-9a-f]{16}\/[^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    const queue = assets.filter((a) => a.endsWith('.js'));
    while (queue.length) {
      const a = queue.shift();
      if (seen.has(a)) continue;
      seen.add(a);
      const r = await call(w, e, a);
      assert.equal(r.status, 200, a);
      for (const m of (await r.text()).matchAll(/(?:from|import\()\s*'(\.\/[a-z-]+\.js)'/g)) queue.push(a.replace(/[^/]+$/, m[1].slice(2)));
    }
    if (path === '/questions') assert.ok(seen.size >= 7, 'the page, the client and its shared modules');
  }
  // With the flag off, the new files aren't served; with it on, they are.
  const hash = /\/assets\/([0-9a-f]{16})\//.exec(await (await call(w, e, '/questions')).text())[1];
  for (const f of ['questions-page.js', 'questions.css', 'admin-questions.js']) {
    assert.equal((await call(w, e, `/assets/${hash}/${f}`)).status, 200, f);
    assert.equal((await call(w, env({ PUBLIC_ASK: undefined }), `/assets/${hash}/${f}`)).status, 404, f);
  }
  // An id with no page is a 404; a page that exists only with the flag on.
  assert.equal((await call(w, e, '/q/abcdefghijklmnop')).status, 404);
  assert.equal((await call(w, e, '/q/%3Cscript%3E')).status, 404);
  assert.equal((await call(w, env({ SIREN_DB: undefined }), '/questions')).status, 503, 'the flag on, SIREN_DB missing: fails closed');
});

test('render: every remote string escaped, the answer through marked and DOMPurify with no style attributes', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const html = entryHtml({
    id: 'abcdefghijklmnop', uri: `at://${W.DID}/x/"><svg onload=alert(1)>`, did: 'javascript:alert(1)', handle: `${hostile}.example`, day: '"><b>', city: hostile, question: hostile, answer: 'ok',
    record: { model: hostile, steps: 1, trace: [{ tool: hostile, soql: hostile, ok: false, error: hostile, ms: 1, url: 'javascript:alert(1)' }], resources: { contacts: [{ role: hostile, email: hostile, url: 'javascript:x' }], records: [{ title: hostile, url: 'data:text/html,x' }] }, suggestions: [{ source: hostile }], voice: { ok: false }, requestBudget: { used: 3, limit: 120, note: hostile } },
    flags: [{ kind: 'bot', reason: hostile }],
  }, { mine: true, render: (s) => `<p>${esc(s)}</p>`, cityName: (c) => c });
  assert.ok(!html.includes('<img') && !html.includes('<svg') && !html.includes('<b>'), 'nothing remote becomes markup');
  assert.ok(!html.includes('javascript:') && !html.includes('data:text'), 'no script links');
  assert.ok(!/\sstyle="/.test(html));
  assert.match(html, /href="#"/, 'a bad profile link goes nowhere');
  assert.match(html, /This answer states some things as fact/);
  assert.match(html, /data-withdraw="at:\/\/did:plc:[a-z2-7]+\/x\/&quot;&gt;&lt;svg onload=alert\(1\)&gt;"/);
  assert.ok(!entryHtml({ id: 'abcdefghijklmnop', did: W.DID, handle: 'a.bsky.social', question: 'q', answer: 'a', record: {} }, { render: (s) => s }).includes('data-withdraw'), 'a Withdraw button on your own questions only');
  // marked then DOMPurify, with style attributes forbidden, as the chat page does.
  const seen = [];
  globalThis.marked = { parse: (s) => `<p style="x">${s}</p>` };
  globalThis.DOMPurify = { sanitize: (s, opts) => { seen.push(opts); return s.replace(/ style="[^"]*"/, ''); } };
  try {
    assert.equal(md('hi'), '<p>hi</p>');
    assert.deepEqual(seen, [{ FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true, FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'dialog'] }], 'no data attributes, form controls or dialogs from model output');
    assert.deepEqual(seen[0], { ...PURIFY });
  } finally {
    delete globalThis.marked;
    delete globalThis.DOMPurify;
  }
  assert.equal(md('<b>x</b>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>', 'without them, escaped text');
  assert.match(answerHtml('a', { trace: [{ tool: 'web search (run by Anthropic)', ok: true, rows: 2, ms: 1, url: 'https://msc.fema.gov/' }] }, { render: (s) => s }), /\(1 web search\)/);
  assert.equal(WITHDRAWN, 'The asker withdrew this question.');
  // When a withdrawal can't reach Siren, the page says what's true, and promises no time.
  assert.equal(RECHECKS, 'Siren checks every public question regularly and takes it down when it finds the record gone.');
  assert.ok(!read('worker/questions-page.js').includes('when Siren next checks'));
  assert.match(CLOSED.full, /full, so it takes no more follow-ups/);
  assert.match(entryHtml({ id: 'abcdefghijklmnop', did: W.DID, handle: 'a.bsky.social', question: 'q', answer: 'a', record: {}, replies: 24, thread_full: true, followup: null }, { render: (x) => x }), /24 replies<\/a> · thread full/);
  const row = rowHtml({ id: 'abcdefghijklmnop', status: 'answered', handle: hostile, day: hostile, question: hostile, answer: hostile });
  assert.ok(!row.includes('<img'));
  assert.match(row, /data-hidden="true">Hide</);
  assert.match(rowHtml({ id: 'abcdefghijklmnop', status: 'hidden', day: '2026-11-10' }), /data-hidden="false">Unhide</);
  assert.ok(!rowHtml({ id: 'abcdefghijklmnop', status: 'withdrawn', day: '2026-11-10' }).includes('<button'), 'a withdrawn one has no button');
});

test('an ask end to end: the agent the private chat runs, on the record\'s text; then public on the list and its page', { skip }, async () => {
  const w = await loadWorker();
  const e = env();
  const net = fakeNetwork();
  const bodies = [];
  const code = await inviteCookie(e);
  await withFetch(outside(net, bodies), async () => {
    const cookie = (await call(w, e, '/api/public/redeem', post({ code }))).headers.get('Set-Cookie').split(';')[0];
    const session = await (await call(w, e, '/api/public/session', { headers: { Cookie: cookie } })).json();
    assert.equal(session.invited, true);
    assert.ok(Math.abs(session.now - Date.now()) < 5000);
    const rec = questionRecord(net, { text: 'Who decided the kennel at 111 Pennsylvania Ave?' });
    const res = await call(w, e, '/api/public/ask', post({ uri: rec.uri, cid: rec.cid, question: 'not this one' }, { Cookie: cookie }));
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.deepEqual(Object.keys(out).sort(), ['answer', 'id', 'record', 'url']);
    assert.equal(out.answer, 'I found no permits at that address.');
    assert.equal(out.url, `${ORIGIN}/q/${out.id}`);
    // The model got the record's text, with Siren's deployment (its prompt and tools).
    assert.equal(bodies.length, 1);
    const sent = JSON.stringify(bodies[0].messages);
    assert.ok(sent.includes('Who decided the kennel at 111 Pennsylvania Ave?'));
    assert.ok(!sent.includes('not this one'));
    assert.ok(bodies[0].tools.some((t) => t.name === 'block_report'), "the private chat's tools");
    // The DID document, the record and the handle's lookups, then the one model call: one counter.
    assert.ok(out.record.requestBudget.used >= 4, `the record check counted on the answer: ${out.record.requestBudget.used}`);
    assert.equal(out.record.requestBudget.limit, 120);
    const list = await call(w, e, '/api/questions');
    assert.equal(list.headers.get('X-Robots-Tag'), 'noindex');
    const q = (await list.json()).questions[0];
    assert.equal(q.id, out.id);
    assert.equal(q.handle, W.HANDLE);
    assert.equal(q.question, 'Who decided the kennel at 111 Pennsylvania Ave?');
    const one = await call(w, e, `/api/q/${out.id}`);
    assert.equal(one.headers.get('X-Robots-Tag'), 'noindex');
    assert.equal((await one.json()).question.answer, out.answer);
    // A follow-up from another account: the model gets the thread before it, as a conversation's earlier turns.
    const bob = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
    net.state.didDocs.set(bob, { id: bob, alsoKnownAs: [], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: W.PDS }] });
    const follow = questionRecord(net, { did: bob, text: 'Which of those were approved?', reply: { root: q.followup.root, parent: q.followup.parent } });
    const f = await call(w, e, '/api/public/ask', post({ uri: follow.uri, cid: follow.cid }, { Cookie: cookie }));
    assert.equal(f.status, 200, await f.clone().text());
    const turns = bodies[1].messages.map((m) => [m.role, typeof m.content === 'string' ? m.content : m.content.map((c) => c.text || '').join('')]);
    assert.deepEqual(turns.map(([r]) => r), ['user', 'assistant', 'user']);
    assert.equal(turns[0][1], threadQuestion('Who decided the kennel at 111 Pennsylvania Ave?'), "marked as someone else's words");
    assert.ok(turns[1][1].startsWith('I found no permits at that address.'));
    assert.ok(turns[2][1].includes('Which of those were approved?'));
    // The prompt says it's a public thread for the follow-up only; the private chat's is unchanged.
    assert.match(bodies[1].system[0].text, /This is a public thread: each earlier question comes wrapped in <thread_question>/);
    assert.ok(!bodies[0].system[0].text.includes('public thread'));
    const thread = (await (await call(w, e, `/api/q/${(await f.json()).id}`)).json()).thread;
    assert.deepEqual(thread.map((t) => [t.parent, t.depth]), [[null, 0], [out.id, 1]]);
    assert.equal(thread[1].handle, null, 'an account with no handle shows none');
  });
});

test('threads render nested, root first, the current one highlighted; withdrawn and hidden ones as placeholders with their replies', () => {
  const q = (id, parent, extra = {}) => ({ id, parent, did: W.DID, handle: 'a.bsky.social', day: '2026-11-10', question: `question ${id}`, answer: 'a', record: {}, ...extra });
  const t = [
    q('aaaaaaaaaaaaaaaa', null, { followup: { root: {}, parent: {} } }),
    { id: 'bbbbbbbbbbbbbbbb', parent: 'aaaaaaaaaaaaaaaa', withdrawn: true, depth: 1 },
    q('cccccccccccccccc', 'bbbbbbbbbbbbbbbb', { followup: { root: {}, parent: {} } }),
    { id: 'dddddddddddddddd', parent: 'aaaaaaaaaaaaaaaa', hidden: true, depth: 1 },
    q('eeeeeeeeeeeeeeee', 'aaaaaaaaaaaaaaaa'),
  ];
  const html = threadHtml(t, { current: 'cccccccccccccccc', render: (s) => s, mine: (x) => x.id === 'eeeeeeeeeeeeeeee' });
  const order = [...html.matchAll(/id="q-([a-z]+)"/g)].map((m) => m[1][0]);
  assert.deepEqual(order, ['a', 'b', 'c', 'd', 'e'], 'root first, each reply under its parent');
  // c is nested inside b, which is nested inside a.
  const b = html.indexOf('id="q-bbbbbbbbbbbbbbbb"');
  const c = html.indexOf('id="q-cccccccccccccccc"');
  assert.ok(html.slice(b, c).includes('<ol class="replies">'));
  assert.match(html, /<li class="q current" id="q-cccccccccccccccc">/);
  assert.match(html, new RegExp(`<li class="q placeholder" id="q-bbbbbbbbbbbbbbbb"><p class="small">${WITHDRAWN}</p>`));
  assert.match(html, new RegExp(`<li class="q placeholder" id="q-dddddddddddddddd"><p class="small">${HIDDEN}</p>`));
  assert.equal(HIDDEN, 'Hidden by the steward.');
  assert.equal((html.match(/data-followup=/g) || []).length, 2, 'a follow-up button where the thread takes one');
  assert.equal((html.match(/data-withdraw=/g) || []).length, 1, 'withdraw on your own only');
  assert.ok(!html.slice(html.indexOf('id="q-bbbbbbbbbbbbbbbb"'), c).includes('question b'), 'a placeholder carries no text');
  // A root on the list links its replies; a cycle or a missing parent can't loop or drop it.
  assert.match(entryHtml(q('aaaaaaaaaaaaaaaa', null, { replies: 2 }), { render: (s) => s }), /<a href="\/q\/aaaaaaaaaaaaaaaa">2 replies<\/a>/);
  assert.equal([...threadHtml([q('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa'), q('bbbbbbbbbbbbbbbb', 'zzzzzzzzzzzzzzzz')], { render: (s) => s }).matchAll(/class="q"/g)].length, 2);
});

test("every element the page's script reaches for is on the page", () => {
  const src = read('worker/questions-page.js');
  const html = read('worker/questions.html');
  const ids = new Set([...src.slice(src.indexOf('async function main')).matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 15);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
  const admin = read('worker/admin-questions.js');
  for (const m of admin.matchAll(/\$\('([a-z-]+)'\)/g)) assert.match(read('worker/admin-questions.html'), new RegExp(`id="${m[1]}"`), m[1]);
});

test('privacy: no D1 statement or KV write on the public routes puts an invite or a visitor hash beside a DID or handle, and nothing logged names either', { skip }, async () => {
  const w = await loadWorker();
  const e = env();
  const net = fakeNetwork();
  const code = await inviteCookie(e);
  const inviteHash = (await inviteKey(code)).slice('invite:'.length);
  const visitor = createHash('sha256').update(`${e.IP_SALT}:${visitorId(IP)}`).digest('hex').slice(0, 32);
  const steward = `${userCookieName('')}=${await signUser(SECRET, await userId(SECRET, 'steward@example.org'))}`;
  const uid = await userId(SECRET, 'steward@example.org');
  const logged = [];
  const real = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(real)) console[k] = (...a) => logged.push(a.map(String).join(' '));
  const kvBefore = e.LIMITS.ops.length;
  let cookie;
  try {
    await withFetch(outside(net), async () => {
      const red = await call(w, e, '/api/public/redeem', post({ code }));
      cookie = red.headers.get('Set-Cookie').split(';')[0];
      await call(w, e, '/api/public/session', { headers: { Cookie: cookie } });
      const rec = questionRecord(net);
      const { id } = await (await call(w, e, '/api/public/ask', post({ uri: rec.uri, cid: rec.cid }, { Cookie: cookie }))).json();
      await call(w, e, '/api/public/ask', post({ uri: rec.uri, cid: rec.cid }, { Cookie: cookie }));
      const bad = questionRecord(net, { now: Date.now() - 3600e3 });
      await call(w, e, '/api/public/ask', post({ uri: bad.uri, cid: bad.cid }, { Cookie: cookie }));
      await call(w, e, '/api/questions');
      await call(w, e, `/api/q/${id}`);
      await call(w, e, `/q/${id}`);
      await call(w, e, '/api/admin/questions', { headers: { Cookie: steward } });
      await call(w, e, '/api/admin/questions/hide', post({ id, hidden: true }, { Cookie: steward }));
      await call(w, e, '/api/admin/questions/hide', post({ id, hidden: false }, { Cookie: steward }));
      // A follow-up from another account.
      const bob = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
      net.state.didDocs.set(bob, { id: bob, alsoKnownAs: [], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: W.PDS }] });
      const follow = questionRecord(net, { did: bob, text: 'And then?', reply: { root: { uri: rec.uri, cid: rec.cid }, parent: { uri: rec.uri, cid: rec.cid } } });
      const f = await call(w, e, '/api/public/ask', post({ uri: follow.uri, cid: follow.cid }, { Cookie: cookie }));
      assert.equal(f.status, 200, await f.clone().text());
      const fid = (await f.json()).id;
      // An answer that fails.
      await withFetch(outside(net, [], { fail: true }), async () => {
        const doomed = questionRecord(net, { text: 'Doomed?' });
        assert.equal((await call(w, e, '/api/public/ask', post({ uri: doomed.uri, cid: doomed.cid }, { Cookie: cookie }))).status, 502);
      });
      // D1 down: every route's error path.
      e.SIREN_DB.fail = true;
      const later = questionRecord(net, { text: 'D1 down?' });
      for (const [path, init] of [['/api/questions'], [`/api/q/${id}`], [`/q/${id}`], ['/api/public/ask', post({ uri: later.uri, cid: later.cid }, { Cookie: cookie })], ['/api/public/withdraw', post({ uri: rec.uri })], ['/api/admin/questions', { headers: { Cookie: steward } }]]) {
        assert.equal((await call(w, e, path, init)).status, 503, path);
      }
      await w.scheduled({ cron: '*/10 * * * *' }, e, { waitUntil() {} });
      e.SIREN_DB.fail = false;
      // Bob deletes his record elsewhere; the root's page re-checks the thread and withdraws it.
      net.state.repos.get(bob).get(QUESTION_NSID).delete(follow.rkey);
      e.SIREN_DB.db.prepare('UPDATE public_questions SET checked_ms = 0 WHERE id = ?').run(fid);
      const thread = (await (await call(w, e, `/api/q/${id}`)).json()).thread;
      assert.equal(thread.find((t) => t.id === fid).withdrawn, true);
      // The sweep: Alice deletes hers; the scheduled run withdraws it.
      net.state.repos.get(W.DID).get(QUESTION_NSID).delete(rec.rkey);
      e.SIREN_DB.db.prepare('UPDATE public_questions SET checked_ms = 0 WHERE id = ?').run(id);
      const waits = [];
      await w.scheduled({ cron: '*/10 * * * *' }, e, { waitUntil: (p) => waits.push(p) });
      await Promise.all(waits);
      assert.equal(e.SIREN_DB.rows().find((r) => r.id === id).status, 'withdrawn');
      assert.equal((await call(w, e, '/api/public/withdraw', post({ uri: rec.uri }, { Cookie: cookie }))).status, 404, 'already withdrawn by the sweep');
    });
  } finally {
    Object.assign(console, real);
  }
  assert.ok(logged.some((l) => /D1/.test(l)), 'the D1 error paths logged');
  assert.ok(logged.some((l) => /the answer failed/.test(l)), 'the failed answer logged');
  // Every D1 statement, with every value it bound.
  const statements = e.SIREN_DB.log;
  assert.ok(statements.length > 5);
  const secrets = [inviteHash, inviteHash.slice(0, 32), cookie.split('=')[1], visitor, uid, IP, code];
  for (const { sql, params } of statements) {
    assert.ok(!/invite|visitor|email|conversation|inv-day/i.test(sql), sql);
    for (const p of params) for (const s of secrets) assert.ok(!String(p).includes(s), `${sql} binds ${String(p).slice(0, 20)}`);
  }
  assert.ok(statements.some(({ params }) => params.includes(W.DID)), 'the DID is stored, as the asker chose');
  // Every KV key and value written on these routes.
  const writes = e.LIMITS.ops.slice(kvBefore).filter((o) => o.op === 'put' || o.op === 'delete');
  assert.ok(writes.length > 0);
  for (const o of writes) {
    const value = e.LIMITS.store.get(o.key)?.value ?? '';
    for (const s of [W.DID, W.HANDLE, QUESTION_NSID, 'at://']) {
      assert.ok(!o.key.includes(s) && !String(value).includes(s), `${o.key} holds ${s}`);
    }
    assert.match(o.key, /^(redeemed|inv-day|spend):/, `only an invite's use, its daily count and spend: ${o.key}`);
    // No exact time beside an invite: the count expires on a day boundary.
    if (o.key.startsWith('inv-day:')) assert.equal(o.opts.expirationTtl, undefined);
  }
  // The log.
  for (const line of logged) for (const s of [W.DID, W.HANDLE, 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'at://', ...secrets]) assert.ok(!line.includes(s), line);
});

test('the source keeps the rule: no KV write and no log line in the free tier\'s modules carries a DID or handle', () => {
  const src = read('worker/public-ask.js');
  for (const m of src.matchAll(/kv\.put\(([^;]+);/g)) assert.ok(!/did|handle|uri/i.test(m[1].replace(/invite\.hash/, '')), m[1]);
  for (const m of src.matchAll(/console\.(?:error|log|warn)\(([^;]+);/g)) assert.ok(!/\b(did|handle|uri|invite|p\.did|row\.did)\b/.test(m[1].replace(/'[^']*'/g, '')), m[1]);
  assert.ok(!/visitorHash|visitorId|hmacHex/.test(read('worker/questions.js')), 'the D1 module computes no visitor hash');
  // public-ask.js computes one only as a rate-limiter key (as the endorsement routes do), in one place.
  assert.equal((src.match(/hmacHex\(/g) || []).length, 1);
  const fn = src.slice(src.indexOf('async function visitorAllowed'), src.indexOf('\n}\n', src.indexOf('async function visitorAllowed')));
  assert.match(fn, /hmacHex\(env\.IP_SALT, `bsky-q:\$\{visitorId/);
  assert.match(fn, /return allowed\(env\.BSKY_VISITOR_RL, `q:\$\{visitor\}`\);/);
  assert.ok(!/memberInvite|inviteAccess/.test(src), 'the public routes never read an email account for the invite');
});

// The page's own script, run against a small stand-in for the DOM with its
// fetches going to the Worker: it renders the list and a thread, and the
// follow-up button opens the ask panel for that question.
let pageHook = false;
async function runPage(w, e, path) {
  // The page imports the client at run time. Under Node 24 a module imported
  // after its text import is the text version (index.js says so), so the
  // page run here gets its own copies of the client and what it imports.
  if (!pageHook) {
    pageHook = true;
    nodeModule.registerHooks({
      resolve(specifier, context, next) {
        const out = next(specifier, context);
        const parent = String(context.parentURL || '');
        if ((parent.includes('questions-page.js?page=') || parent.endsWith('.js?page')) && /\/worker\/[a-z-]+\.js$/.test(out.url)) return { ...out, url: `${out.url}?page` };
        return out;
      },
    });
  }
  const html = await (await call(w, e, path)).text();
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const listeners = {};
      els.set(id, { id, textContent: '', innerHTML: '', hidden: new RegExp(`id="${id}"[^>]*\\bhidden\\b`).test(html), value: '', disabled: false, dataset: {}, listeners, addEventListener: (t, f) => { listeners[t] = f; }, focus() {}, scrollIntoView() {} });
    }
    return els.get(id);
  };
  for (const m of html.matchAll(/id="([a-z-]+)"/g)) el(m[1]);
  const dataset = Object.fromEntries([.../<body ([^>]*)>/.exec(html)[1].matchAll(/data-([a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const missing = [];
  const saved = Object.fromEntries(['document', 'window', 'location', 'history', 'confirm', 'fetch'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  Object.assign(globalThis, {
    window: { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } },
    location: { hash: '', pathname: path, search: '', assign() {} },
    history: { replaceState() {} },
    confirm: () => true,
    fetch: async (u, init = {}) => w.fetch(new Request(new URL(u, ORIGIN), init), e, { waitUntil() {} }),
    document: { body: { dataset }, getElementById: (id) => { if (!els.has(id)) missing.push(id); return el(id); } },
  });
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
  try {
    await import(`../worker/questions-page.js?page=${encodeURIComponent(path)}`);
    for (let i = 0; i < 50 && !el('list').innerHTML; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 30));
  } catch (err) {
    restore();
    throw err;
  }
  return { el, missing, restore };
}

test("the page's script renders the list and a thread, and the follow-up button opens the panel for that question", { skip }, async () => {
  const w = await loadWorker();
  const e = env({ APPVIEW_URL: 'https://appview.invalid' });
  const db = e.SIREN_DB.db;
  const ins = db.prepare("INSERT INTO public_questions (id, question_uri, question_cid, did, handle, city, question, answer, record, status, day, checked_ms, root_uri, parent_uri, depth) VALUES (?, ?, 'bafyreiaaaaaaaa', ?, ?, 'norfolk', ?, ?, '{}', ?, '2026-11-10', ?, ?, ?, ?)");
  const u = (n) => `at://${W.DID}/${QUESTION_NSID}/3kaaaaaaaaaa${n}`;
  ins.run('aaaaaaaaaaaaaaaa', u(2), W.DID, 'alice.example', 'Root <img src=x onerror=alert(1)>?', 'I found three.', 'answered', Date.now(), null, null, 0);
  ins.run('bbbbbbbbbbbbbbbb', null, null, null, null, null, 'withdrawn', 0, u(2), u(2), 1);
  ins.run('cccccccccccccccc', u(4), 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'bob.example', 'Which were approved?', 'I found one.', 'answered', Date.now(), u(2), 'withdrawn:bbbbbbbbbbbbbbbb', 2);
  const list = await runPage(w, e, '/questions');
  list.restore();
  assert.deepEqual(list.missing, []);
  assert.match(list.el('list').innerHTML, /id="q-aaaaaaaaaaaaaaaa"/);
  assert.match(list.el('list').innerHTML, />1 reply</);
  assert.ok(!list.el('list').innerHTML.includes('<img'));
  assert.ok(!list.el('list').innerHTML.includes('q-cccccccccccccccc'), 'the list shows roots only');
  assert.equal(list.el('ask').hidden, false);
  const one = await runPage(w, e, '/q/cccccccccccccccc');
  let guarded;
  try {
    // A button inside an answer (model output) does nothing, whatever it claims to be.
    await one.el('list').listeners.click({ target: { closest: (sel) => (sel === '.answer' ? {} : sel === 'button[data-followup]' ? { dataset: { followup: 'cccccccccccccccc' } } : sel === 'button[data-withdraw]' ? { dataset: { withdraw: 'at://x' } } : null) } });
    guarded = { hidden: one.el('ask').hidden, title: one.el('ask-title').textContent };
    await one.el('list').listeners.click({ target: { closest: (sel) => (sel === 'button[data-followup]' ? { dataset: { followup: 'cccccccccccccccc' } } : null) } });
  } finally {
    one.restore();
  }
  assert.deepEqual(guarded, { hidden: true, title: 'Ask a question' }, 'a click inside .answer is ignored');
  assert.deepEqual(one.missing, []);
  const t = one.el('list').innerHTML;
  assert.ok(t.indexOf('q-aaaaaaaaaaaaaaaa') < t.indexOf('q-bbbbbbbbbbbbbbbb') && t.indexOf('q-bbbbbbbbbbbbbbbb') < t.indexOf('q-cccccccccccccccc'));
  assert.match(t, /<li class="q current" id="q-cccccccccccccccc">/);
  assert.match(t, /The asker withdrew this question\./);
  assert.equal(one.el('ask').hidden, false, 'opened by the follow-up button');
  assert.equal(one.el('ask-title').textContent, 'Ask a follow-up');
  assert.equal(one.el('reply-text').textContent, 'Following up on: Which were approved?');
  assert.equal(one.el('city').disabled, true, "a follow-up is about its thread's city");
});

test("the page's script: an answer's offer to read a source next fills the ask box with its question, in that question's thread", { skip }, async () => {
  const w = await loadWorker();
  const e = env({ APPVIEW_URL: 'https://appview.invalid' });
  const db = e.SIREN_DB.db;
  const ins = db.prepare("INSERT INTO public_questions (id, question_uri, question_cid, did, handle, city, question, answer, record, status, day, checked_ms, root_uri, parent_uri, depth) VALUES (?, ?, 'bafyreiaaaaaaaa', ?, ?, 'norfolk', ?, ?, ?, 'answered', '2026-11-10', ?, NULL, NULL, 0)");
  const legi = 'https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=7337';
  const record = { resources: { records: [{ kind: 'legislation', title: 'ORD 48-512', url: legi }] }, followups: [{ question: 'What does the kennel ordinance say?', source_title: 'ORD 48-512 <b>', url: legi }] };
  ins.run('dddddddddddddddd', `at://${W.DID}/${QUESTION_NSID}/3kaaaaaaaaaa9`, W.DID, 'alice.example', 'What about the kennel?', `I found [an ordinance](${legi}).`, JSON.stringify(record), Date.now());
  const one = await runPage(w, e, '/q/dddddddddddddddd');
  let html;
  try {
    html = one.el('list').innerHTML;
    await one.el('list').listeners.click({ target: { closest: (sel) => (sel === 'button[data-offer]' ? { dataset: { offer: 'dddddddddddddddd', n: '0' } } : null) } });
  } finally {
    one.restore();
  }
  assert.deepEqual(one.missing, []);
  assert.match(html, /<button type="button" class="offer" data-offer="dddddddddddddddd" data-n="0" title="What does the kennel ordinance say\?">Would you like me to look into that\?<\/button> <small><a href="https:\/\/norfolkcityva\.iqm2\.com\/Citizens\/Detail_LegiFile\.aspx\?ID=7337" target="_blank" rel="noopener noreferrer">ORD 48-512 &lt;b&gt;<\/a><\/small>/);
  assert.equal(one.el('q').value, 'What does the kennel ordinance say?', 'the question is in the box, for the asker to read and ask');
  assert.equal(one.el('ask').hidden, false);
  assert.equal(one.el('ask-title').textContent, 'Ask a follow-up');
  assert.equal(one.el('reply-text').textContent, 'Following up on: What about the kennel?');
});
