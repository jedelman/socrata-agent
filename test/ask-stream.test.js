// POST /api/ask, streamed (worker/ask-stream.js) and not, through the
// Worker's own fetch handler, with the Messages API faked as server-sent
// events (test/fake-claude.js). The Worker imports .html and .json files the
// way Wrangler bundles them, so this file loads them through a module hook;
// where node:module has no registerHooks, the Worker tests skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signUser, userId, USER_COOKIE } from '../worker/accounts.js';
import { noteEvents, MAX_NOTE_CHARS, TOOL_LABELS, workingNotesOn, wantsStream } from '../worker/ask-stream.js';
import { ask } from '../src/agent.js';
import { applyConfig } from '../src/plugins.js';
import { getCity } from '../src/cities/index.js';
import { askLimits } from '../worker/limits.js';
import { claudeResponse } from './fake-claude.js';

const canHook = typeof nodeModule.registerHooks === 'function';
const skip = !canHook && 'node:module has no registerHooks';
let worker;
async function loadWorker() {
  if (worker) return worker;
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && context.importAttributes?.type === 'text') {
        return { format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true };
      }
      if (url.startsWith('file:') && url.endsWith('.html')) {
        return { format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true };
      }
      if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  worker = (await import('../worker/index.js')).default;
  return worker;
}

function fakeKV() {
  const store = new Map();
  const puts = [];
  return {
    store,
    puts,
    async get(k, type) {
      if (!store.has(k)) return null;
      return type === 'json' ? JSON.parse(store.get(k)) : store.get(k);
    },
    async put(k, v, opts) {
      puts.push(k);
      store.set(k, String(v));
      if (opts?.metadata) store.set(`${k}#meta`, JSON.stringify(opts.metadata));
    },
    async delete(k) {
      store.delete(k);
    },
    async list({ prefix }) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && !k.endsWith('#meta'));
      return { keys: keys.map((name) => ({ name, metadata: store.has(`${name}#meta`) ? JSON.parse(store.get(`${name}#meta`)) : undefined })), list_complete: true };
    },
  };
}

const SECRET = 'test-secret-that-is-long-enough';
const MODEL = 'claude-sonnet-5-5';
const THOUGHT_1 = 'The person asks about street trees. I will search the catalog first.';
const THOUGHT_2 = 'The search came back empty, so I will say what I searched.';
const ANSWER = 'I found no tree datasets in the catalog search.';
const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const msg = (content, stop_reason, extra = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content, stop_reason, stop_sequence: null, stop_details: null, usage, ...extra });
const twoSteps = () => [
  msg([{ type: 'thinking', thinking: THOUGHT_1, signature: 's1' }, { type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: { query: 'street trees' } }], 'tool_use'),
  msg([{ type: 'thinking', thinking: THOUGHT_2, signature: 's2' }, { type: 'text', text: ANSWER }], 'end_turn'),
];

// globalThis.fetch for one test: the Messages API answers from `replies`
// (or with `status`), anything else (Socrata) with an empty result.
async function withNetwork({ replies = [], status }, fn) {
  const real = globalThis.fetch;
  const model = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      const i = model.length;
      model.push(JSON.parse(init.body));
      if (status) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
      return claudeResponse(init, replies[Math.min(i, replies.length - 1)]);
    }
    return new Response(JSON.stringify({ results: [], resultSetSize: 0 }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    return await fn(model);
  } finally {
    globalThis.fetch = real;
  }
}

// A signed-in account bound to an invite: the only kind that keeps conversations.
async function member() {
  const kv = fakeKV();
  const uid = await userId(SECRET, 'reader@example.org');
  await kv.put('invite:h1', JSON.stringify({ label: 'test' }));
  await kv.put(`member:${uid}`, JSON.stringify({ invite: 'h1' }));
  kv.puts.length = 0;
  const env = { LIMITS: kv, MODEL, ANTHROPIC_API_KEY: 'k', INVITE_REQUIRED: 'true', INVITE_SECRET: SECRET, IP_SALT: 'salt' };
  return { env, kv, uid, cookie: `${USER_COOKIE}=${await signUser(SECRET, uid)}` };
}

function askReq({ cookie, stream = false, body = { question: 'Any street tree data?', city: 'norfolk' } } = {}) {
  return new Request('https://x.org/api/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}), ...(stream ? { Accept: 'application/x-ndjson, application/json' } : {}) },
    body: JSON.stringify(body),
  });
}

function ctxStub() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

// Spend keys written, and their total in dollars (worker/limits.js recordSpend).
const spendOf = (kv) => {
  const keys = kv.puts.filter((k) => k.startsWith('spend:'));
  return { keys: keys.length, usd: keys.reduce((sum, k) => sum + JSON.parse(kv.store.get(`${k}#meta`)).micros, 0) / 1e6 };
};

const lines = async (res) => (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
// Timings differ run to run: in the trace (ms) and its markdown ("N ms").
const noMs = (v) => JSON.parse(JSON.stringify(v).replace(/"ms":\d+/g, '"ms":0').replace(/ \d+ ms /g, ' 0 ms '));

test('streamed: start, thinking deltas by step, code-written tool lines, then the final body; saved once, spent once', { skip }, async () => {
  const w = await loadWorker();
  const { env, kv, cookie } = await member();
  const ctx = ctxStub();
  await withNetwork({ replies: twoSteps() }, async (model) => {
    const res = await w.fetch(askReq({ cookie, stream: true }), env, ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'application/x-ndjson; charset=utf-8');
    assert.equal(res.headers.get('Cache-Control'), 'no-store, no-transform');
    const events = await lines(res);
    await ctx.settle();
    assert.ok(ctx.pending.length >= 1, 'the work runs under waitUntil');

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'start');
    assert.equal(types.at(-1), 'final');
    assert.equal(types.filter((t) => t === 'final').length, 1);
    const thought = (step) => events.filter((e) => e.type === 'thinking' && e.step === step).map((e) => e.text).join('');
    assert.equal(thought(0), THOUGHT_1);
    assert.equal(thought(1), THOUGHT_2);
    const tool = events.find((e) => e.type === 'tool');
    assert.deepEqual(tool, { type: 'tool', step: 0, name: 'search_datasets', label: TOOL_LABELS.search_datasets }, 'name and a fixed label, never the arguments');
    const at = events.map((e) => `${e.type}:${e.step ?? ''}`);
    assert.ok(at.lastIndexOf('thinking:0') < at.indexOf('tool:0') && at.indexOf('tool:0') < at.indexOf('thinking:1'), 'the tool line sits between the two steps');

    const final = events.at(-1).body;
    assert.equal(final.answer, ANSWER);
    assert.equal(final.conversation, events[0].conversation);
    assert.equal(final.toolResults, undefined, 'the raw tool results stay on the server');
    assert.ok(!JSON.stringify(final).includes('search the catalog first'), 'no thinking in the answer body');
    assert.deepEqual(model[0].thinking, { type: 'adaptive', display: 'summarized' });

    // Saved once, before the final line, with no thinking in it.
    const convPuts = kv.puts.filter((k) => k.startsWith('conv:'));
    assert.equal(convPuts.length, 1);
    const saved = kv.store.get(convPuts[0]);
    assert.ok(!saved.includes('search the catalog first') && !saved.includes('came back empty'), 'the notes are live only');
    assert.equal(JSON.parse(saved).turns[0].answer, ANSWER);
    const spend = spendOf(kv);
    assert.equal(spend.keys, 2, 'spend recorded once per model call');
    assert.ok(Math.abs(spend.usd - final.cost) < 1e-9, `${spend.usd} vs ${final.cost}`);
    assert.equal(kv.puts.filter((k) => k.startsWith('user-day:')).length, 1, 'one question counted');
  });
});

test("the final line's body is exactly the non-streaming body, which is exactly what it was", { skip }, async () => {
  const w = await loadWorker();
  let streamed;
  let plain;
  let plainRes;
  let plainModel;
  {
    const { env, cookie } = await member();
    await withNetwork({ replies: twoSteps() }, async () => {
      streamed = (await lines(await w.fetch(askReq({ cookie, stream: true }), env, ctxStub()))).at(-1).body;
    });
  }
  {
    const { env, cookie } = await member();
    const ctx = ctxStub();
    await withNetwork({ replies: twoSteps() }, async (model) => {
      plainRes = await w.fetch(askReq({ cookie }), env, ctx);
      plain = await plainRes.json();
      plainModel = model;
      await ctx.settle();
    });
  }
  assert.equal(plainRes.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(plainModel[0].thinking, undefined, 'the non-streaming path asks for no thinking display');
  const { conversation: c1, ...s } = streamed;
  const { conversation: c2, ...p } = plain;
  assert.ok(c1 && c2);
  assert.deepEqual(noMs(s), noMs(p));

  // And the non-streaming body is what the handler always built: the city,
  // ask()'s output without its tool results, then the conversation.
  const env = { MODEL, ANTHROPIC_API_KEY: 'k' };
  const legislation = JSON.parse(readFileSync(new URL('../data/norfolk-legislation.json', import.meta.url), 'utf8'));
  const out = await withNetwork({ replies: twoSteps() }, () => ask({
    question: 'Any street tree data?', history: [], carried: [], city: applyConfig(getCity('norfolk'), {}), plugins: [],
    indexes: { 'norfolk-legislation': legislation }, apiKey: 'k', appToken: undefined, model: MODEL, effort: undefined,
    ...askLimits(env, 'anthropic'), referer: 'https://x.org', onCost: () => {},
  }));
  const { toolResults, ...answer } = out;
  assert.equal(JSON.stringify(noMs(plain)), JSON.stringify(noMs({ city: 'norfolk', ...answer, conversation: c2 })), 'byte for byte, key order included');
});

test('the thinking sent is capped per answer, with one notice', { skip }, async () => {
  const w = await loadWorker();
  const { env, cookie } = await member();
  const long = 'abcdefghij'.repeat(3000); // 30,000 characters
  const replies = [msg([{ type: 'thinking', thinking: long, signature: 's' }, { type: 'text', text: ANSWER }], 'end_turn')];
  await withNetwork({ replies }, async () => {
    const events = await lines(await w.fetch(askReq({ cookie, stream: true }), env, ctxStub()));
    const sent = events.filter((e) => e.type === 'thinking').map((e) => e.text).join('');
    assert.equal(sent.length, MAX_NOTE_CHARS);
    assert.equal(sent, long.slice(0, MAX_NOTE_CHARS));
    const types = events.map((e) => e.type);
    assert.equal(types.filter((t) => t === 'notes_capped').length, 1);
    assert.ok(types.lastIndexOf('thinking') < types.indexOf('notes_capped'));
    assert.equal(events.at(-1).body.answer, ANSWER);
  });
});

test('WORKING_NOTES = "off": the plain JSON answer, even when a stream is asked for', { skip }, async () => {
  const w = await loadWorker();
  const { env, cookie } = await member();
  env.WORKING_NOTES = 'off';
  await withNetwork({ replies: twoSteps() }, async (model) => {
    const res = await w.fetch(askReq({ cookie, stream: true }), env, ctxStub());
    assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal((await res.json()).answer, ANSWER);
    assert.equal(model[0].thinking, undefined);
  });
  assert.equal(workingNotesOn({}), true, 'on by default');
  assert.equal(workingNotesOn({ WORKING_NOTES: ' OFF ' }), false);
});

test('an error while answering: the same body as the JSON path, as an error line; nothing saved or spent', { skip }, async () => {
  const w = await loadWorker();
  let jsonBody;
  {
    const { env, cookie } = await member();
    await withNetwork({ status: 500 }, async () => {
      const res = await w.fetch(askReq({ cookie }), env, ctxStub());
      assert.equal(res.status, 502);
      jsonBody = await res.json();
    });
  }
  const { env, kv, cookie } = await member();
  await withNetwork({ status: 500 }, async (model) => {
    const ctx = ctxStub();
    const events = await lines(await w.fetch(askReq({ cookie, stream: true }), env, ctx));
    await ctx.settle();
    assert.deepEqual(events.at(-1), { type: 'error', status: 502, body: jsonBody });
    assert.deepEqual(jsonBody, { error: 'Something went wrong answering that. Try again, or rephrase.', detail: 'Anthropic 500' });
    assert.equal(model.length, 2, 'the SDK retried once, before any stream opened');
    assert.equal(kv.puts.filter((k) => k.startsWith('conv:') || k.startsWith('spend:')).length, 0);
  });
});

test('a refusal: that step\'s notes are discarded, and the answer says the model declined', { skip }, async () => {
  const w = await loadWorker();
  const { env, cookie } = await member();
  const replies = [msg([{ type: 'thinking', thinking: 'Partial thought.', signature: 's' }], 'refusal', { stop_details: { type: 'refusal', category: 'general_harms' } })];
  await withNetwork({ replies }, async () => {
    const events = await lines(await w.fetch(askReq({ cookie, stream: true }), env, ctxStub()));
    const types = events.map((e) => `${e.type}:${e.step ?? ''}`);
    assert.ok(types.indexOf('discard:0') > types.lastIndexOf('thinking:0'));
    const final = events.at(-1).body;
    assert.match(final.answer, /^I can't answer that one/);
    assert.equal(final.refusal, 'general_harms');
  });
});

test('errors before the answer starts stay JSON, whatever the Accept header', { skip }, async () => {
  const w = await loadWorker();
  const { env, cookie } = await member();
  await withNetwork({ replies: twoSteps() }, async (model) => {
    const empty = await w.fetch(askReq({ cookie, stream: true, body: { question: ' ' } }), env, ctxStub());
    assert.equal(empty.status, 400);
    assert.equal(empty.headers.get('Content-Type'), 'application/json; charset=utf-8');
    const gate = await w.fetch(askReq({ stream: true }), env, ctxStub());
    assert.equal(gate.status, 401);
    assert.equal((await gate.json()).gate, 'invite');
    assert.equal(model.length, 0);
  });
});

test('a reader who leaves mid-stream: the answer still finishes (within the grace period), is saved once and spent once per call', { skip }, async () => {
  const w = await loadWorker();
  const { env, kv, cookie } = await member();
  const ctx = ctxStub();
  await withNetwork({ replies: twoSteps() }, async (model) => {
    const res = await w.fetch(askReq({ cookie, stream: true }), env, ctx);
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel();
    await ctx.settle();
    assert.equal(model.length, 2, 'both model calls ran');
    assert.equal(kv.puts.filter((k) => k.startsWith('conv:')).length, 1);
    assert.equal(spendOf(kv).keys, 2);
    assert.equal(kv.puts.filter((k) => k.startsWith('user-day:')).length, 1);
  });
});

test('noteEvents: tool lines only for declared tools, never arguments or model text; the cap counts across steps', () => {
  const sent = [];
  const on = noteEvents((e) => sent.push(e), { known: new Set(['block_report', 'budget_for', 'new_plugin']), maxChars: 10 });
  on({ type: 'tool', step: 0, name: 'block_report', args: { address: '810 Union St' } });
  on({ type: 'tool', step: 0, name: 'made_up_tool', args: {} });
  on({ type: 'tool', step: 0, name: 'new_plugin', args: {} });
  on({ type: 'rewrite', step: 3, violations: ['There are 3 permits on the block.'] });
  on({ type: 'thinking', step: 1, text: 'abcdef' });
  on({ type: 'thinking', step: 2, text: 'ghijkl' });
  on({ type: 'thinking', step: 2, text: 'more' });
  on({ type: 'refusal', step: 2 });
  on({ type: 'fallback', step: 4 });
  on({ type: 'thinking', step: 2, text: '' });
  on(null);
  assert.deepEqual(sent, [
    { type: 'tool', step: 0, name: 'block_report', label: TOOL_LABELS.block_report },
    { type: 'tool', step: 0, name: 'new_plugin', label: 'Using the new_plugin tool' },
    { type: 'rewrite', step: 3, label: 'Rewording the answer to say only what the records show' },
    { type: 'thinking', step: 1, text: 'abcdef' },
    { type: 'thinking', step: 2, text: 'ghij' },
    { type: 'notes_capped' },
    { type: 'discard', step: 2 },
    { type: 'discard', step: 4, reason: 'fallback' },
  ]);
  assert.ok(!JSON.stringify(sent).includes('810 Union') && !JSON.stringify(sent).includes('permits'));
  assert.equal(wantsStream(new Request('https://x.org', { headers: { Accept: 'application/x-ndjson' } })), true);
  assert.equal(wantsStream(new Request('https://x.org', { headers: { Accept: 'application/json' } })), false);
});

test('every tool Siren declares has a label', async () => {
  const { toolsFor } = await import('../src/tools.js');
  const { definePlugin } = await import('../src/plugins.js');
  const siren = (await import('../deployments/siren.config.js')).default;
  const city = applyConfig(getCity('norfolk'), siren);
  const gaps = JSON.parse(readFileSync(new URL('../data/gaps/norfolk.json', import.meta.url), 'utf8'));
  const names = toolsFor(city, siren.plugins.map(definePlugin), { gaps }).map((t) => t.function.name);
  assert.deepEqual(names.filter((n) => !TOOL_LABELS[n]), []);
});

test('the JSON path records spend per model call too, adding up to the answer\'s cost', { skip }, async () => {
  const w = await loadWorker();
  const { env, kv, cookie } = await member();
  const ctx = ctxStub();
  await withNetwork({ replies: twoSteps() }, async () => {
    const body = await (await w.fetch(askReq({ cookie }), env, ctx)).json();
    await ctx.settle();
    const spend = spendOf(kv);
    assert.equal(spend.keys, 2);
    assert.ok(Math.abs(spend.usd - body.cost) < 1e-9);
  });
});

test('a reader leaves and the platform cancels the work at its deadline: each call already made is still in spend', { skip }, async () => {
  const w = await loadWorker();
  const { env, kv, cookie } = await member();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  // The second model call is a long one: it hangs until released.
  let release;
  let hung;
  const hanging = new Promise((r) => { hung = r; });
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!u.startsWith('https://api.anthropic.com/')) return new Response(JSON.stringify({ results: [], resultSetSize: 0 }), { headers: { 'content-type': 'application/json' } });
    if (calls++ === 0) return claudeResponse(init, twoSteps()[0]);
    hung();
    return new Promise((resolve) => {
      release = () => resolve(new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'gone' } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    });
  };
  try {
    const res = await w.fetch(askReq({ cookie, stream: true }), env, ctx);
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel(); // the reader leaves
    await hanging; // the answer is now in its second, long model call
    // The platform's grace period ends here: what the store holds now is all
    // that survives a cancelled invocation.
    await new Promise((r) => setTimeout(r, 100));
    const survived = { puts: [...kv.puts], store: new Map(kv.store) };
    const spendKeys = survived.puts.filter((k) => k.startsWith('spend:'));
    assert.equal(spendKeys.length, 1, 'the first call is in spend');
    const micros = JSON.parse(survived.store.get(`${spendKeys[0]}#meta`)).micros;
    assert.equal(micros, (1000 * 2 + 200 * 10), 'priced at Sonnet 5.5 rates: $0.004');
    assert.equal(survived.puts.filter((k) => k.startsWith('conv:')).length, 0, 'no answer, so no turn to save');
  } finally {
    release?.();
    await Promise.allSettled(pending);
    globalThis.fetch = real;
  }
});

// The page's stream reader and its wait for a dropped answer, run as the
// page runs them (the marked helpers block in worker/ui.html).
const pageHelpers = () => {
  const ui = readFileSync(new URL('../worker/ui.html', import.meta.url), 'utf8');
  const start = ui.indexOf('// ---- helpers');
  const end = ui.indexOf('// ---- end helpers');
  assert.ok(start > 0 && end > start, 'the helpers block is marked');
  return new Function(`${ui.slice(start, end)}\nreturn { readLines, savedTurn };`)();
};

test('page: reading stops at the final line, so a connection error after it cannot replace the answer', async () => {
  const { readLines } = pageHelpers();
  const encoder = new TextEncoder();
  const chunks = ['{"type":"thinking","step":0,"text":"a"}\n', '{"type":"final","body":{"answer":"I found it."}}\n{"type":"thin'];
  let n = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(c) {
      if (n < chunks.length) c.enqueue(encoder.encode(chunks[n++]));
      else c.error(new Error('connection reset'));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const seen = [];
  await readLines(new Response(body), (ev) => {
    seen.push(ev.type);
    return ev.type === 'final' || ev.type === 'error';
  });
  assert.deepEqual(seen, ['thinking', 'final']);
  assert.ok(cancelled, 'the rest of the stream is let go');
});

test('page: after a dropped stream, savedTurn polls the conversation until the answer is saved, or gives up at a minute', async () => {
  const { savedTurn } = pageHelpers();
  const since = Date.now();
  const saved = { question: 'Any street tree data?', answer: ANSWER, at: new Date(since + 5000).toISOString(), record: {} };
  const run = async (responses) => {
    const waits = [];
    const urls = [];
    let i = 0;
    const turn = await savedTurn('11111111-2222-3333-4444-555555555555', 'Any street tree data?', since, {
      wait: async (ms) => { waits.push(ms); },
      get: async (u) => {
        urls.push(u);
        const r = responses[Math.min(i++, responses.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    });
    return { turn, waits, urls };
  };
  const ok = (turns) => new Response(JSON.stringify({ city: 'norfolk', turns }));
  // Saved by the second poll.
  let r = await run([ok([]), ok([saved])]);
  assert.deepEqual(r.turn, saved);
  assert.deepEqual(r.waits, [25000, 35000]);
  assert.equal(r.urls[0], 'api/conversation?id=11111111-2222-3333-4444-555555555555');
  // Saved by the first: no second poll.
  r = await run([ok([saved])]);
  assert.deepEqual(r.waits, [25000]);
  // Never saved (a failed read, then an older turn with the same question): null, a minute in all.
  const older = { ...saved, at: new Date(since - 10 * 60_000).toISOString() };
  r = await run([new Error('offline'), ok([older])]);
  assert.equal(r.turn, null);
  assert.equal(r.waits.reduce((a, b) => a + b, 0), 60000);
  // Not yet in the store at all (404 while the save is pending).
  r = await run([new Response('{}', { status: 404 })]);
  assert.equal(r.turn, null);
});
