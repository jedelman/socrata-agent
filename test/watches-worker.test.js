// Watches and civic-league feeds through the Worker's own fetch handler
// (worker/index.js): with WATCHES and LEAGUE_FEEDS off nothing changes; on,
// the pages, API, one-click stop, session flag, chat page links and privacy
// line, and offer_watch reaching the model for a signed-in member.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import { buildSnapshot, stopToken } from '../worker/watches.js';
import { getCity } from '../src/cities/index.js';
import { readyEnv, SECRET } from './fake-atproto.js';
import { claudeResponse } from './fake-claude.js';

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
const USER = 'member@example.org';
const MODEL = 'claude-sonnet-5-5';
const base = (over = {}) => readyEnv({ BLUESKY_LOGIN: undefined, INVITE_REQUIRED: 'true', RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>', MODEL, ANTHROPIC_API_KEY: 'k', ...over });
async function member(env) {
  const uid = await userId(SECRET, USER);
  await env.LIMITS.put('invite:h1', JSON.stringify({ label: 'test' }));
  await env.LIMITS.put(`member:${uid}`, JSON.stringify({ invite: 'h1' }));
  return `${userCookieName('')}=${await signUser(SECRET, uid)}`;
}
async function call(env, path, { method = 'GET', cookie = '', body, type = 'application/json', headers = {} } = {}) {
  const w = await loadWorker();
  const req = new Request(`${ORIGIN}${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': type } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  return w.fetch(req, env, { waitUntil: () => {} });
}
const PATHS = ['/watches', '/watch/stop', '/api/watches', '/feeds', '/feeds/all.atom', '/feeds/ghent.atom'];

test('both flags off: every watches and feeds path is a 404, the one-click path is JSON-gated as before, and the page is unchanged', { skip }, async () => {
  const env = base();
  const cookie = await member(env);
  for (const p of PATHS) assert.equal((await call(env, p, { cookie })).status, 404, p);
  assert.equal((await call(env, '/watch/stop?t=x.y', { method: 'POST', body: 'List-Unsubscribe=One-Click', type: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call(env, '/api/watches', { method: 'POST', cookie, body: { terms: ['rental'] } })).status, 404);
  const page = await (await call(env, '/')).text();
  assert.doesNotMatch(page, /Your watches|Neighborhood feeds|\{\{/);
  assert.match(page, /Your email address is not stored; it's sent to our mail provider only to deliver your sign-in link\./);
  const session = await (await call(env, '/api/session', { cookie })).json();
  assert.equal('watches' in session, false);
  // Their assets aren't served.
  const hash = /\/assets\/([0-9a-f]{16})\/chat\.css/.exec(page)[1];
  for (const a of ['watches-page.js', 'watch-stop.js', 'watches.css']) assert.equal((await call(env, `/assets/${hash}/${a}`)).status, 404, a);
});

test('WATCHES on: the page links them and says what a watch keeps, the session says so, and the pages carry a strict CSP', { skip }, async () => {
  const env = base({ WATCHES: 'true' });
  const cookie = await member(env);
  const page = await (await call(env, '/')).text();
  assert.match(page, /<a href="requests">Source requests<\/a> · <a href="watches">Your watches<\/a> · <button/);
  assert.match(page, /except by a watch you start: it keeps the address, encrypted, to send its emails, and deletes it when the watch stops/);
  assert.equal((await (await call(env, '/api/session', { cookie })).json()).watches, true);
  assert.equal('watches' in (await (await call(env, '/api/session')).json()), false, 'only for a member');
  const res = await call(env, '/watches');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'; script-src 'self'; style-src 'self'/);
  const html = await res.text();
  assert.doesNotMatch(html, /\{\{|<script>|style=/);
  assert.match(html, /City Council and Planning Commission/);
  assert.match(html, /keeps the email you signed in with, encrypted, with the watch, and deletes it when the watch stops or ends/);
  assert.equal((await call(env, '/watch/stop?t=abc')).status, 200);
  for (const p of ['/feeds', '/feeds/all.atom']) assert.equal((await call(env, p)).status, 404, `feeds stay off: ${p}`);
  // Set but not ready: the pages say so.
  assert.equal((await call(base({ WATCHES: 'true', RESEND_API_KEY: undefined }), '/watches')).status, 503);
});

test('the one-click stop: a form POST from a mail client stops the watch it names, and only that one', { skip }, async () => {
  const env = base({ WATCHES: 'true' });
  const cookie = await member(env);
  const made = await (await call(env, '/api/watches', { method: 'POST', cookie, body: { terms: ['kennel'], email: USER }, headers: { Origin: ORIGIN } })).json();
  assert.ok(made.ok, JSON.stringify(made));
  const t = await stopToken(SECRET, made.watch.id);
  assert.equal((await call(env, `/watch/stop?t=${made.watch.id}.nope`, { method: 'POST', body: 'List-Unsubscribe=One-Click', type: 'application/x-www-form-urlencoded' })).status, 400);
  assert.ok(await env.LIMITS.get(`watch:${made.watch.id}`));
  const res = await call(env, `/watch/stop?t=${encodeURIComponent(t)}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', type: 'application/x-www-form-urlencoded' });
  assert.equal(res.status, 200);
  assert.equal(await env.LIMITS.get(`watch:${made.watch.id}`), null);
});

test('LEAGUE_FEEDS on: the feeds page and the Atom feeds, once the agendas have been read', { skip }, async () => {
  const env = base({ LEAGUE_FEEDS: 'true' });
  assert.equal((await call(env, '/feeds')).status, 503, 'before the first read');
  const city = getCity('norfolk');
  const fetchImpl = async (input) => {
    const url = String(input?.url || input);
    if (url.includes('dszu-h9cf')) return Response.json([{ date_and_time: '2026-12-01T18:00:00.000', organization: 'City Council', type: 'Formal Session', location: 'Council Chamber', meeting_link: { url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=4454' } }]);
    if (url.includes('ere7-kake') && /GROUP%20BY/.test(url)) return Response.json([{ civic_league: 'Ghent' }, { civic_league: 'Ocean View' }]);
    if (url.includes('ere7-kake')) return Response.json([{ full_address: '1039 SAMPLE AVE', civic_league: 'Ocean View' }]);
    if (url.includes('Detail_Meeting.aspx?ID=4454')) return new Response(`<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4454&MediaPosition=&ID=7001&CssClass='>Ordinance No. 1 : An Ordinance Granting a Conditional Use Permit to Authorize a Short-Term Rental Unit on Property Located at 1039 Sample Avenue.</a>`);
    return new Response('', { status: 404 });
  };
  await buildSnapshot({ kv: env.LIMITS, city, cityId: 'norfolk', fetchImpl, now: Date.parse('2026-11-17T12:00:00Z') });
  const page = await call(env, '/feeds');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<a href="\/feeds\/ocean-view\.atom">Ocean View<\/a> <small>\(1 upcoming\)<\/small>/);
  assert.match(html, /<a href="\/feeds\/ghent\.atom">Ghent<\/a><\/li>/);
  assert.doesNotMatch(page.headers.get('Content-Security-Policy'), /script-src/);
  const feed = await call(env, '/feeds/ocean-view.atom');
  assert.equal(feed.headers.get('Content-Type'), 'application/atom+xml; charset=utf-8');
  assert.match(await feed.text(), /Short-Term Rental Unit on Property Located at 1039 Sample Avenue/);
  assert.equal((await call(env, '/feeds/atlantis.atom')).status, 404);
  assert.equal((await call(env, '/watches')).status, 404, 'watches stay off');
  // The chat page links the feeds.
  assert.match(await (await call(env, '/')).text(), /<a href="requests">Source requests<\/a> · <a href="feeds">Neighborhood feeds<\/a> · <button/);
});

// The model offers a watch; the answer carries it. Without WATCHES, the tool isn't there.
async function askWith(env, cookie) {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const msg = (content, stop_reason) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content, stop_reason, stop_sequence: null, stop_details: null, usage });
  const replies = [
    msg([{ type: 'tool_use', id: 'toolu_1', name: 'offer_watch', input: { terms: ['short-term rental', 'vacation rental', 'Jane Doe'] } }], 'tool_use'),
    msg([{ type: 'text', text: 'I can watch the agendas for short-term rental items. Start the watch on the card below.' }], 'end_turn'),
  ];
  const real = globalThis.fetch;
  const model = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      const i = model.length;
      model.push(JSON.parse(init.body));
      return claudeResponse(init, replies[Math.min(i, replies.length - 1)]);
    }
    return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const res = await call(env, '/api/ask', { method: 'POST', cookie, body: { question: 'Let me know if Planning Commission takes up short-term rentals', city: 'norfolk' }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
    return { body: await res.json(), model };
  } finally {
    globalThis.fetch = real;
  }
}

test('offer_watch reaches the model only for a signed-in member with WATCHES on, and the answer carries the card', { skip }, async () => {
  const on = base({ WATCHES: 'true' });
  const { body, model } = await askWith(on, await member(on));
  assert.ok(model[0].tools.some((t) => t.name === 'offer_watch'));
  assert.match(model[0].system.map ? model[0].system.map((b) => b.text).join('') : model[0].system, /call offer_watch/);
  assert.deepEqual(body.watchOffer.terms, ['short term rental', 'vacation rental']);
  assert.deepEqual(body.watchOffer.bodies, ['City Council', 'Planning Commission']);
  const off = base();
  const plain = await askWith(off, await member(off));
  assert.ok(!plain.model[0].tools.some((t) => t.name === 'offer_watch'));
  assert.equal('watchOffer' in plain.body, false);
});
