// The Anthropic provider streams every call (the SDK's stream helper, read to
// its final message). These tests serve scripted messages as server-sent
// events (test/fake-claude.js) and check that what comes out, what goes back
// to the API, the spend and the request count are what the non-streaming
// call gave, and that the summarized thinking reaches onEvent and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../src/agent.js';
import { afterFallback } from '../src/providers/anthropic.js';
import { getCity } from '../src/cities/index.js';
import Anthropic from '@anthropic-ai/sdk';
import { claudeResponse } from './fake-claude.js';

const KEY = 'sk-ant-test-secret-key-do-not-leak';
const norfolk = getCity('norfolk');
const usage = (o = {}) => ({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
const msg = (content, stop_reason, u = usage(), extra = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_details: null, usage: u, ...extra });
// Haiku 5.5 list prices, per call of usage() above.
const HAIKU_CALL = (1000 * 0.1 + 200 * 0.5) / 1e6;

// Each /v1/messages call gets the next scripted reply; `opts[i]` shapes how
// reply i streams (errorAfter, dropAfter, chunk).
function mockApi(replies, opts = []) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/v1/messages')) {
      const i = requests.length;
      requests.push({ url: u, body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return claudeResponse(init, replies[Math.min(i, replies.length - 1)], opts[i] || {});
    }
    if (u.includes('/api/catalog/')) return new Response(JSON.stringify({ results: [], resultSetSize: 0 }));
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests };
}

const LONG_THOUGHT = 'The person asks about trees. I should search the catalog for tree datasets first, then read what comes back.';
const LATER_THOUGHT = 'Nothing matched. I will say what I searched and what I found.';

test('every call streams; thinking deltas reach onEvent in order, and only onEvent', async () => {
  const thinking = { type: 'thinking', thinking: LONG_THOUGHT, signature: 'sig-abc' };
  const tool = { type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: { query: 'trees' } };
  const later = { type: 'thinking', thinking: LATER_THOUGHT, signature: 'sig-def' };
  const { fetchImpl, requests } = mockApi([
    msg([thinking, tool], 'tool_use'),
    msg([later, { type: 'text', text: 'I found no datasets matching trees.' }], 'end_turn'),
  ]);
  const events = [];
  const out = await ask({ question: 'Any tree data?', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, thinkingEvents: true, onEvent: (e) => events.push(e) });

  assert.equal(out.answer, 'I found no datasets matching trees.');
  assert.ok(requests.every((r) => r.body.stream === true), 'streamed');
  assert.ok(requests.every((r) => r.headers.get('x-stainless-helper-method') === 'stream'), 'through the SDK stream helper');
  assert.deepEqual(requests[0].body.thinking, { type: 'adaptive', display: 'summarized' });

  // The deltas arrive in pieces and add up to each block's text, tagged by step.
  const text = (step) => events.filter((e) => e.type === 'thinking' && e.step === step).map((e) => e.text).join('');
  assert.ok(events.filter((e) => e.type === 'thinking').length > 4, 'deltas, not one block');
  assert.equal(text(0), LONG_THOUGHT);
  assert.equal(text(1), LATER_THOUGHT);
  // Order: step 0's thinking, then its tool, then step 1's thinking.
  const kinds = events.map((e) => `${e.type}:${e.step}`);
  assert.ok(kinds.lastIndexOf('thinking:0') < kinds.indexOf('tool:0'));
  assert.ok(kinds.indexOf('tool:0') < kinds.indexOf('thinking:1'));
  assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', step: 0, name: 'search_datasets', args: { query: 'trees' } });

  // Nothing of the thinking outside onEvent: not the answer, the trace, the
  // tool results kept for later turns, or anything sent to the API except the
  // API's own thinking block, echoed whole as it requires.
  const outside = JSON.stringify({ ...out, markdown: out.markdown });
  assert.ok(!outside.includes('search the catalog for tree'), 'no thinking in the output');
  assert.deepEqual(requests[1].body.messages.at(-2), { role: 'assistant', content: [thinking, tool] }, 'the turn goes back exactly as the API sent it');
  const sentElsewhere = JSON.stringify(requests[1].body.messages.filter((m) => m.role !== 'assistant'));
  assert.ok(!sentElsewhere.includes('search the catalog for tree'));
  assert.ok(Math.abs(out.cost - 2 * HAIKU_CALL) < 1e-12, 'priced from the streamed usage');
  assert.deepEqual({ model: out.requestBudget.model, used: out.requestBudget.used }, { model: 2, used: 3 }, 'one fetch per streamed call');
});

test('without thinkingEvents: no thinking parameter, no thinking events, the same answer', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
  const { fetchImpl, requests } = mockApi([msg([thinking, { type: 'text', text: 'I found it.' }], 'end_turn')]);
  const events = [];
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, onEvent: (e) => events.push(e) });
  assert.equal(out.answer, 'I found it.');
  assert.equal(requests[0].body.thinking, undefined, 'the request is as it was, streamed');
  assert.equal(requests[0].body.stream, true);
  assert.equal(events.filter((e) => e.type === 'thinking').length, 0);
});

test('streamed and non-streamed replies give the same answer, history and cost', async () => {
  // The same scripted turns read through the stream helper (SSE) and by
  // reading the JSON message whole: the provider's view must not differ.
  const script = () => [
    msg([{ type: 'thinking', thinking: 'Search first.', signature: 's1' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: { query: 'permits', note: 'café "quoted" \\ back' } }], 'tool_use'),
    msg([{ type: 'text', text: 'There are 3 open permits.' }], 'end_turn'),
    msg([{ type: 'text', text: 'I found 3 open permits.' }], 'end_turn'),
  ];
  const streamed = mockApi(script());
  const a = await ask({ question: 'permits?', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl: streamed.fetchImpl, thinkingEvents: true });
  // The non-streaming create() returned each scripted message as it is.
  const replies = script();
  assert.equal(a.answer, 'I found 3 open permits.');
  assert.equal(a.voice.rewritten, true);
  assert.equal(a.steps, 1);
  // What went back each time is the API's message content, unchanged.
  assert.deepEqual(streamed.requests[1].body.messages.at(-2).content, replies[0].content);
  assert.deepEqual(streamed.requests[2].body.messages.at(-2).content, replies[1].content);
  assert.equal(streamed.requests[1].body.messages.at(-1).content[0].tool_use_id, 'toolu_1');
  assert.ok(Math.abs(a.cost - 3 * HAIKU_CALL) < 1e-12);
});

test("the SDK's streamed final message equals the non-streaming message, block for block", async () => {
  const message = msg([
    { type: 'thinking', thinking: 'Summarized: check the block report first.', signature: 'sig-1' },
    { type: 'text', text: 'Looking it up — "quoted", café, \\ and a newline\nhere.' },
    { type: 'tool_use', id: 'toolu_1', name: 'block_report', input: { address: '810 Union St', nested: { list: [1, 'two', null, true] } } },
  ], 'tool_use', usage({ cache_read_input_tokens: 500, cache_creation_input_tokens: 20 }), { stop_sequence: null });
  const client = new Anthropic({ apiKey: KEY, baseURL: 'https://api.anthropic.com', maxRetries: 0, fetch: async (url, init) => claudeResponse(init, message, { chunk: 3 }) });
  const params = { model: 'claude-haiku-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'q' }] };
  const whole = await client.messages.create(params);
  // parsed_output is the SDK's structured-outputs field (null here; never read).
  const { parsed_output, ...streamed } = await client.messages.stream(params).finalMessage();
  assert.equal(parsed_output, null);
  assert.deepEqual(JSON.parse(JSON.stringify(streamed)), JSON.parse(JSON.stringify(whole)));
});

test('a mid-stream refusal discards the partial output: nothing of it is kept or sent back', async () => {
  const partial = [
    { type: 'thinking', thinking: 'Partial reasoning before the classifier stopped it.', signature: 's' },
    { type: 'text', text: 'I found the first part of' },
  ];
  const refused = msg(partial, 'refusal', usage(), { stop_details: { type: 'refusal', category: 'cyber' } });
  const { fetchImpl, requests } = mockApi([
    msg([{ type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: { query: 'x' } }], 'tool_use'),
    refused,
  ]);
  const events = [];
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, thinkingEvents: true, onEvent: (e) => events.push(e) });
  assert.match(out.answer, /^I can't answer that one: the model declined it/);
  assert.equal(out.refusal, 'cyber');
  assert.ok(!JSON.stringify(out).includes('first part of'), 'the partial text is not the answer');
  assert.equal(requests.length, 2, 'no rewrite, no retry');
  // The notes already sent are withdrawn by the refusal event, after them.
  const kinds = events.map((e) => `${e.type}:${e.step}`);
  assert.ok(kinds.includes('thinking:1'));
  assert.ok(kinds.lastIndexOf('thinking:1') < kinds.indexOf('refusal:1'));
  assert.ok(Math.abs(out.cost - 2 * HAIKU_CALL) < 1e-12, 'the refused call is still paid for');
});

test('a mid-stream server-side fallback: the declined partial is not run or echoed, only its text', async () => {
  const declined = [
    { type: 'thinking', thinking: 'Declined model reasoning.', signature: 'sig-declined' },
    { type: 'text', text: 'I will search' },
    { type: 'tool_use', id: 'toolu_declined', name: 'query_dataset', partial_json: '{"dataset_id": "aaaa-', input: { dataset_id: 'aaaa-' } },
  ];
  const fallback = { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' }, trigger: { type: 'refusal', category: 'cyber' } };
  const served = [
    { type: 'thinking', thinking: 'Fallback reasoning.', signature: 'sig-served' },
    { type: 'tool_use', id: 'toolu_ok', name: 'search_datasets', input: { query: 'trees' } },
  ];
  const iterations = [
    { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ];
  const first = msg([...declined, fallback, ...served], 'tool_use', { ...usage(), iterations }, { model: 'claude-sonnet-5-5' });
  const { fetchImpl, requests } = mockApi([first, msg([{ type: 'text', text: 'I found no tree datasets.' }], 'end_turn', usage(), { model: 'claude-sonnet-5' })]);
  const out = await ask({ question: 'trees?', city: norfolk, apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl, thinkingEvents: true });

  assert.equal(requests[0].body.fallbacks, 'default');
  assert.match(requests[0].headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
  assert.equal(out.answer, 'I found no tree datasets.');
  assert.equal(out.steps, 1);
  assert.deepEqual(out.toolResults.map((t) => t.name), ['search_datasets'], 'only the served tool call ran');
  assert.ok(!JSON.stringify(out.trace).includes('aaaa-'), 'the declined call was never run');
  const echoed = requests[1].body.messages.at(-2).content;
  assert.deepEqual(echoed, [declined[1], fallback, ...served], 'text and the fallback block stay where they were; the rest of the partial is omitted');
  const results = requests[1].body.messages.at(-1).content;
  assert.deepEqual(results.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id), ['toolu_ok']);
  // Every attempt priced (iterations), then the second call at Sonnet 5's card.
  const expected = (1000 * 2 + 50 * 10) / 1e6 + (1000 * 2 + 100 * 10) / 1e6 + (1000 * 2 + 200 * 10) / 1e6;
  assert.ok(Math.abs(out.cost - expected) < 1e-12, `${out.cost} vs ${expected}`);
});

test('afterFallback: unchanged without a fallback block; keeps every fallback block and text before the last', () => {
  const plain = [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a', name: 'n', input: {} }];
  assert.equal(afterFallback(plain), plain);
  const f1 = { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } };
  const f2 = { type: 'fallback', from: { model: 'b' }, to: { model: 'c' } };
  const t = (x) => ({ type: 'text', text: x });
  const th = { type: 'thinking', thinking: 'x', signature: 's' };
  assert.deepEqual(afterFallback([th, t('1'), f1, th, t('2'), f2, th, t('3')]), [t('1'), f1, t('2'), f2, th, t('3')]);
});

test('cut off at max_tokens inside a tool input: never run, retried once with more room, both priced', async () => {
  const cut = msg([
    { type: 'thinking', thinking: 'Look up the address.', signature: 's' },
    { type: 'tool_use', id: 'toolu_cut', name: 'block_report', partial_json: '{"address": "810 Un', input: { address: '810 Un' } },
  ], 'max_tokens');
  const { fetchImpl, requests } = mockApi([cut, msg([{ type: 'text', text: 'I found nothing at 810 Union St.' }], 'end_turn')]);
  const out = await ask({ question: '810 Union St?', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, thinkingEvents: true });
  assert.equal(out.answer, 'I found nothing at 810 Union St.');
  assert.equal(out.steps, 0);
  assert.equal(out.trace.length, 0, 'no query ran');
  assert.equal(requests[1].body.max_tokens, 16000);
  assert.ok(!JSON.stringify(requests[1].body.messages).includes('toolu_cut'), 'the cut-off turn is not sent back');
  assert.ok(Math.abs(out.cost - 2 * HAIKU_CALL) < 1e-12);
  assert.equal(out.requestBudget.model, 2, 'two streamed calls, two fetches');
});

test('a stream that fails partway is not retried, never carries the key, and its input is still priced', async () => {
  const reply = msg([{ type: 'thinking', thinking: 'Starting to think about this question at some length.', signature: 's' }, { type: 'text', text: 'I found' }], 'end_turn');
  const { fetchImpl, requests } = mockApi([reply], [{ errorAfter: 6 }]);
  const events = [];
  let spent = 0;
  await assert.rejects(
    ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, thinkingEvents: true, onEvent: (e) => events.push(e), onCost: (usd) => { spent += usd; } }),
    (err) => {
      assert.match(err.message, /^Anthropic error: /);
      assert.match(err.message, /Overloaded/);
      assert.ok(!err.message.includes(KEY));
      return true;
    }
  );
  assert.equal(requests.length, 1, 'one fetch: the SDK retries only before a response arrives');
  assert.ok(events.some((e) => e.type === 'thinking'), 'the notes had started');
  // message_start reported 1000 input tokens (and 1 output token so far).
  assert.ok(Math.abs(spent - (1000 * 0.1 + 1 * 0.5) / 1e6) < 1e-12, `${spent}`);
});

test('a stream that just stops (no message_stop) is an error, not a short answer', async () => {
  const reply = msg([{ type: 'text', text: 'I found three permits on the block and' }], 'end_turn');
  const { fetchImpl, requests } = mockApi([reply], [{ dropAfter: 5 }]);
  await assert.rejects(ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl }), { message: /^Anthropic error: stream ended/ });
  assert.equal(requests.length, 1);
});

test('a retryable status before the stream opens is retried once by the SDK, and both fetches are counted', async () => {
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (!String(url).startsWith('https://api.anthropic.com/')) return new Response(JSON.stringify({ results: [] }));
    n++;
    if (n === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
    return claudeResponse(init, msg([{ type: 'text', text: 'I found it.' }], 'end_turn'));
  };
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, subrequestBudget: 45 });
  assert.equal(out.answer, 'I found it.');
  assert.equal(out.requestBudget.model, 2);
});

test('the voice rewrite streams too, as its own step; a listener that throws never breaks the answer', async () => {
  const { fetchImpl } = mockApi([
    msg([{ type: 'thinking', thinking: 'Answer directly.', signature: 's1' }, { type: 'text', text: 'There are 3 open permits.' }], 'end_turn'),
    msg([{ type: 'thinking', thinking: 'Reword it.', signature: 's2' }, { type: 'text', text: 'I found 3 open permits.' }], 'end_turn'),
  ]);
  const events = [];
  const out = await ask({
    question: 'permits?', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, thinkingEvents: true,
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'thinking') throw new Error('a broken listener');
    },
  });
  assert.equal(out.answer, 'I found 3 open permits.');
  const kinds = events.map((e) => `${e.type}:${e.step}`);
  assert.ok(kinds.indexOf('rewrite:1') > kinds.lastIndexOf('thinking:0'));
  assert.ok(kinds.indexOf('thinking:1') > kinds.indexOf('rewrite:1'));
  const rewrite = events.find((e) => e.type === 'rewrite');
  assert.deepEqual({ type: rewrite.type, step: rewrite.step, n: rewrite.violations.length }, { type: 'rewrite', step: 1, n: 1 });
});

test('OpenRouter models: no thinking events, the request unchanged', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'I found it.' } }], usage: { cost: 0.001 } }));
  };
  const events = [];
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'or', fetchImpl, thinkingEvents: true, onEvent: (e) => events.push(e) });
  assert.equal(out.answer, 'I found it.');
  assert.equal(events.length, 0);
  assert.equal(bodies[0].stream, undefined);
  assert.equal(bodies[0].thinking, undefined);
});
