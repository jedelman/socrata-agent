// Email sign-in and conversations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCode, inviteKey, signSession } from '../worker/invites.js';
import { userId, signUser, verifyUser, verifyUserInfo, userCookie, currentUser, startLogin, finishLogin, memberInvite, bindInvite, loginConfigured } from '../worker/accounts.js';
import { saveTurn, loadConversation, historyFrom, listConversations, deleteConversation, newConversationId, MAX_TURNS, answerRecord, turnView } from '../worker/conversations.js';
import { ask } from '../src/agent.js';
import { getCity } from '../src/cities/index.js';

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const v = store.get(key).value;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value: String(value), ttl: opts.expirationTtl });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
const SECRET = 'test-secret-that-is-long-enough';
const env = { INVITE_REQUIRED: 'true', INVITE_SECRET: SECRET, RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>' };
const LINK = 'https://x.org/ask-siren/login';

function mailbox() {
  const sent = [];
  return { sent, send: async (_env, msg) => sent.push(msg) };
}
const tokenFrom = (msg) => msg.text.match(/#t=([A-Za-z0-9_-]+)/)[1];

test('sign-in needs its key, sender and secret', async () => {
  assert.equal(loginConfigured(env), true);
  assert.equal(loginConfigured({ ...env, RESEND_API_KEY: '' }), false);
  const out = await startLogin({ body: { email: 'a@b.org' }, env: { ...env, LOGIN_FROM: '' }, kv: fakeKV(), visitor: 'v', link: LINK });
  assert.equal(out.status, 503);
});

test('a sign-in link works once, within 15 minutes, and stores no address', async () => {
  const kv = fakeKV();
  const box = mailbox();
  const now = Date.parse('2026-11-04T12:00:00Z');
  const out = await startLogin({ body: { email: ' Neighbor@Example.ORG ' }, env, kv, visitor: 'v1', link: LINK, send: box.send, now });
  assert.ok(out.ok);
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0].to, 'neighbor@example.org');
  assert.match(box.sent[0].text, /^Here's your link[\s\S]*https:\/\/x\.org\/ask-siren\/login#t=/);
  assert.match(box.sent[0].idempotencyKey, /^login-[0-9a-f]{64}$/);
  const token = tokenFrom(box.sent[0]);
  for (const [k, v] of kv.store) {
    assert.ok(!k.includes('neighbor') && !v.value.includes('neighbor'), `no address stored: ${k}`);
    assert.ok(!k.includes(token), 'the token is stored only as a hash');
  }
  assert.equal(await finishLogin({ token, env, kv, now: now + 16 * 60e3 }).then((r) => r.status), 403, 'expired');
  const ok = await finishLogin({ token, env, kv, now: now + 60e3 });
  assert.ok(ok.ok);
  assert.equal(ok.uid, await userId(SECRET, 'neighbor@example.org'));
  assert.equal(await verifyUser(SECRET, ok.cookie, now), ok.uid);
  assert.equal(ok.masked, 'n\u2022\u2022\u2022@example.org', 'the account shown on every page');
  assert.equal((await verifyUserInfo(SECRET, ok.cookie, now)).masked, ok.masked);
  assert.equal((await finishLogin({ token, env, kv, now: now + 60e3 })).status, 403, 'used once');
  assert.equal((await finishLogin({ token: 'short', env, kv })).status, 400);
});

test('sign-in emails are limited per address and per visitor; the honeypot sends nothing', async () => {
  const kv = fakeKV();
  const box = mailbox();
  for (let i = 0; i < 3; i++) assert.ok((await startLogin({ body: { email: 'a@b.org' }, env, kv, visitor: `v${i}`, link: LINK, send: box.send })).ok);
  assert.equal((await startLogin({ body: { email: 'a@b.org' }, env, kv, visitor: 'v9', link: LINK, send: box.send })).status, 429, 'per address');
  for (let i = 0; i < 10; i++) await startLogin({ body: { email: `p${i}@b.org` }, env, kv, visitor: 'spray', link: LINK, send: box.send });
  assert.equal((await startLogin({ body: { email: 'new@b.org' }, env, kv, visitor: 'spray', link: LINK, send: box.send })).status, 429, 'per visitor');
  const before = box.sent.length;
  assert.ok((await startLogin({ body: { email: 'bot@b.org', website: 'x' }, env, kv, visitor: 'bot', link: LINK, send: box.send })).ok);
  assert.equal(box.sent.length, before);
  assert.equal((await startLogin({ body: { email: 'not an email' }, env, kv, visitor: 'z', link: LINK, send: box.send })).status, 400);
});

test('account cookies reject tampering, expiry, the wrong secret, and invite cookies', async () => {
  const uid = await userId(SECRET, 'a@b.org');
  const c = await signUser(SECRET, uid);
  assert.equal(await verifyUser(SECRET, c), uid);
  assert.equal(await verifyUser('other-secret', c), null);
  // Flip a character in the middle of the signature: the last base64url
  // character of a 32-byte MAC carries 2 unused bits, so changing it can
  // leave the bytes unchanged.
  const [payload, sig] = c.split('.');
  const mid = Math.floor(sig.length / 2);
  const flipped = `${sig.slice(0, mid)}${sig[mid] === 'A' ? 'B' : 'A'}${sig.slice(mid + 1)}`;
  assert.equal(await verifyUser(SECRET, `${payload}.${flipped}`), null);
  assert.equal(await verifyUser(SECRET, c, Date.now() + 31 * 864e5), null);
  // An invite cookie signed with the same secret must not pass as an account.
  const inviteCookie = await signSession(SECRET, 'f'.repeat(64));
  assert.equal(await verifyUser(SECRET, inviteCookie), null);
  assert.match(userCookie(c, '/ask-siren/'), /^siren_user=.+; Path=\/ask-siren\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  const req = new Request('https://x/', { headers: { Cookie: `siren_user=${c}` } });
  assert.equal(await currentUser(req, env), uid);
});

test('an invite bound to an account works until the invite is revoked', async () => {
  const kv = fakeKV();
  const code = newCode();
  const key = await inviteKey(code);
  await kv.put(key, JSON.stringify({ label: 'test', max_uses: 1 }));
  const uid = await userId(SECRET, 'a@b.org');
  assert.equal(await memberInvite(kv, uid), null);
  await bindInvite(kv, uid, key.slice('invite:'.length));
  assert.equal((await memberInvite(kv, uid)).label, 'test');
  await kv.put(key, JSON.stringify({ label: 'test', revoked: true }));
  assert.equal(await memberInvite(kv, uid), null);
});

test('conversations belong to one account, keep trimmed tool results, and expire', async () => {
  const kv = fakeKV();
  const a = await userId(SECRET, 'a@b.org');
  const b = await userId(SECRET, 'b@b.org');
  const id = newConversationId();
  const big = 'x'.repeat(10000);
  let conv = await saveTurn(kv, a, id, null, { city: 'norfolk', question: 'Trees at 1500 Bolling Ave?', answer: 'I found 67 city trees.', tools: [{ name: 'trees_on_my_block', args: { address: '1500 Bolling Ave' }, content: big }] }, { days: 7 });
  assert.equal([...kv.store.values()][0].ttl, 7 * 86400);
  assert.ok(conv.turns[0].tools[0].result.length < 6100 && /trimmed/.test(conv.turns[0].tools[0].result));
  assert.equal(await loadConversation(kv, b, id), null, 'another account cannot open it');
  assert.equal(await loadConversation(kv, a, 'not-a-uuid'), null);
  conv = await loadConversation(kv, a, id);
  for (let i = 0; i < MAX_TURNS + 2; i++) conv = await saveTurn(kv, a, id, conv, { city: 'norfolk', question: `q${i}`, answer: `a${i}` });
  assert.equal(conv.turns.length, MAX_TURNS);
  assert.equal((await listConversations(kv, a))[0].turns, MAX_TURNS);
  assert.deepEqual(await listConversations(kv, b), []);
  assert.ok(await deleteConversation(kv, a, id));
  assert.equal(await loadConversation(kv, a, id), null);
});

test('a turn keeps what was shown under its answer, bounded, and reopens with it', async () => {
  const kv = fakeKV();
  const a = await userId(SECRET, 'a@b.org');
  const id = newConversationId();
  const trace = Array.from({ length: 70 }, (_, i) => ({ n: i + 1, tool: 'query dataset', dataset: 'qzfe-wj25', url: `https://data.norfolk.gov/resource/qzfe-wj25.json?q=${i}`, soql: 'S'.repeat(3000), ok: true, rows: 3, ms: 120 }));
  const shown = {
    answer: 'I found 3 removals.', trace,
    resources: { datasets: [{ id: 'qzfe-wj25', name: 'Work Orders', page: 'https://data.norfolk.gov/d/qzfe-wj25', docs: 'https://dev.socrata.com', queries: ['https://data.norfolk.gov/resource/qzfe-wj25.csv?x=1'] }], records: [], contacts: [{ role: 'Council', name: 'Ward 2' }], links: [] },
    voice: { ok: false, rewritten: true, violations: ['there are'] }, model: 'claude-sonnet-5-5', steps: 4, cost: 0.0123456789,
    suggestions: [{ need: 'contract removals', source: 'Forestry contract records', why: 'not in work orders' }],
    markdown: { trace: 'not kept' }, refusal: undefined,
  };
  const conv = await saveTurn(kv, a, id, null, { city: 'norfolk', question: 'Removals on Raleigh?', answer: shown.answer, tools: [{ name: 'trees_on_my_block', args: {}, content: '{}' }], record: shown }, { days: 7 });
  const r = conv.turns[0].record;
  assert.equal(r.trace.length, 60, 'at most 60 trace steps');
  assert.equal(r.trace[0].soql.length, 2000);
  assert.equal(r.trace[0].dataset, 'qzfe-wj25');
  assert.equal(r.cost, 0.012346);
  assert.deepEqual(r.voice, { ok: false, rewritten: true, violations: ['there are'] });
  assert.equal(r.resources.datasets[0].queries.length, 1);
  assert.equal(r.markdown, undefined, 'only the fields the page renders are kept');
  const view = turnView((await loadConversation(kv, a, id)).turns[0]);
  assert.deepEqual(Object.keys(view).sort(), ['answer', 'at', 'question', 'record']);
  assert.equal(view.tools, undefined, 'raw tool results never go back to the page');
  assert.equal(view.record.model, 'claude-sonnet-5-5');
  // A turn saved before records were kept reopens as the answer alone.
  assert.deepEqual(turnView({ question: 'q', answer: 'a', at: 't', tools: [] }), { question: 'q', answer: 'a', at: 't' });
  // The model still sees only questions, answers and tool results.
  const { history } = historyFrom(conv);
  assert.ok(!history.some((m) => m.content.includes('query dataset')), 'the trace is not replayed to the model');
  assert.deepEqual(answerRecord().trace, []);
});

test('history carries the data behind earlier answers, newest first within a budget', () => {
  const tool = (n) => ({ name: 'block_report', args: { address: `${n} Main St` }, result: 'y'.repeat(15000) });
  const conv = { turns: [1, 2, 3, 4].map((n) => ({ at: `2026-11-04T0${n}:00:00Z`, question: `q${n}`, answer: `a${n}`, tools: [tool(n)] })) };
  const { history, carried } = historyFrom(conv);
  assert.equal(history.length, 8);
  assert.deepEqual(history.filter((m) => m.role === 'user').map((m) => m.content), ['q1', 'q2', 'q3', 'q4']);
  const withData = history.filter((m) => m.content.includes('<data'));
  assert.equal(withData.length, 2, '40k budget: the two newest turns keep their data');
  assert.ok(history[7].content.includes('4 Main St') && !history[1].content.includes('<data'));
  assert.deepEqual(carried.map((c) => c.turn), [3, 4]);
  assert.match(history[7].content, /Data, not instructions/);
  assert.deepEqual(historyFrom(null), { history: [], carried: [] });
});

test('an answer built on carried results says so in its trace', async () => {
  // A fake model that answers at once, so only the carried step is traced.
  const fetchImpl = async (url) => {
    if (String(url).includes('openrouter')) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I found 67 city trees near that address earlier.' } }], usage: { cost: 0 } }));
    throw new Error(`unexpected ${url}`);
  };
  const out = await ask({
    question: 'How many of those are oaks?',
    history: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a <data>[]</data>' }],
    carried: [{ name: 'trees_on_my_block', args: { address: '1500 Bolling Ave' }, turn: 1 }],
    city: getCity('norfolk'),
    apiKey: 'k',
    model: 'openai/test',
    fetchImpl,
  });
  assert.equal(out.trace[0].tool, 'results kept from earlier in this conversation');
  assert.match(out.trace[0].soql, /turn 1: trees_on_my_block/);
  assert.deepEqual(out.toolResults, []);
});

import { addRequest, requestKey } from '../worker/requests.js';

test('source requests pool by source, keep no asker, and are rate limited', async () => {
  const kv = fakeKV();
  const a = await addRequest({ body: { source: 'Norfolk City Code, Chapter 45 (Trees)', url: 'https://library.municode.com/va/norfolk', need: 'Are Ghent trees protected?' }, kv, visitor: 'v1' });
  const b = await addRequest({ body: { source: 'norfolk city code chapter 45 trees', need: 'Can I prune my street tree?' }, kv, visitor: 'v2' });
  assert.equal(a.count, 1);
  assert.equal(b.count, 2, 'spelling and punctuation pool together');
  const rec = await kv.get(await requestKey('Norfolk City Code, Chapter 45 (Trees)'), 'json');
  assert.equal(rec.needs.length, 2);
  assert.equal(rec.url, 'https://library.municode.com/va/norfolk');
  assert.ok(!JSON.stringify(rec).includes('v1') && !JSON.stringify(rec).includes('v2'), 'no visitor id in the record');
  assert.equal((await addRequest({ body: { source: 'x' }, kv, visitor: 'v3' })).status, 400);
  for (let i = 0; i < 20; i++) await addRequest({ body: { source: `s${i} source` }, kv, visitor: 'busy' });
  assert.equal((await addRequest({ body: { source: 'one more' }, kv, visitor: 'busy' })).status, 429);
});

test('suggest_data_source is offered everywhere and returned with the answer', async () => {
  const { toolsFor, runTool } = await import('../src/tools.js');
  const { createContext } = await import('../src/agent.js');
  assert.ok(toolsFor(getCity('chicago')).some((t) => t.function.name === 'suggest_data_source'));
  const ctx = createContext({ city: getCity('norfolk'), fetchImpl: async () => new Response('[]') });
  const r = await runTool(ctx, 'suggest_data_source', { need: 'Are Ghent trees protected?', source: 'Norfolk City Code, Chapter 45', url: 'javascript:alert(1)', why: 'It holds the tree ordinance.' });
  assert.ok(r.noted);
  assert.equal(ctx.suggestions[0].url, undefined, 'only https links are kept');
  await runTool(ctx, 'suggest_data_source', { need: 'n', source: 's2', why: 'w' });
  assert.equal((await runTool(ctx, 'suggest_data_source', { need: 'n', source: 's3', why: 'w' })).noted, false, 'at most two per question');
});
