// The Anthropic provider, against a mocked Messages API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask, providerOf, keyNameFor } from '../src/agent.js';
import { priceUsage, toAnthropicTools } from '../src/providers/anthropic.js';
import { getCity } from '../src/cities/index.js';
import { claudeResponse } from './fake-claude.js';

const KEY = 'sk-ant-test-secret-key-do-not-leak';
const usage = (o = {}) => ({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });

// Scripted Messages API: each call to /v1/messages returns the next response.
function mockApi(responses, { status = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/v1/messages')) {
      const headers = new Headers(init.headers);
      requests.push({ body: JSON.parse(init.body), headers });
      const next = responses[Math.min(requests.length - 1, responses.length - 1)];
      if (status === 200) return claudeResponse(init, next);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
      });
    }
    // Socrata catalog and anything else the tools touch.
    if (u.includes('/api/catalog/')) return new Response(JSON.stringify({ results: [], resultSetSize: 0 }));
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests };
}
const msg = (content, stop_reason, u = usage(), extra = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_details: null, usage: u, ...extra });

test('claude-* models go to Anthropic with ANTHROPIC_API_KEY; others to OpenRouter', () => {
  assert.equal(providerOf('claude-haiku-5-5'), 'anthropic');
  assert.equal(providerOf('anthropic/claude-haiku-5.5'), 'openrouter');
  assert.equal(providerOf('openai/gpt-5.6-luna'), 'openrouter');
  assert.equal(keyNameFor('claude-sonnet-5-5'), 'ANTHROPIC_API_KEY');
  assert.equal(keyNameFor('openai/gpt-5.6-luna'), 'OPENROUTER_API_KEY');
});

test('the tool loop speaks the Messages API: tool_use in, tool_result back, content echoed unchanged', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
  const { fetchImpl, requests } = mockApi([
    msg([thinking, { type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: { query: 'trees' } }], 'tool_use'),
    msg([{ type: 'text', text: 'I found no datasets matching trees.' }], 'end_turn'),
  ]);
  const out = await ask({ question: 'Any tree data?', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', effort: 'low', fetchImpl });
  assert.equal(out.answer, 'I found no datasets matching trees.');
  assert.equal(out.steps, 1);
  assert.equal(out.voice.ok, true);
  assert.ok(out.trace.length >= 1, 'the tool call was traced');

  const [first, second] = requests;
  assert.equal(first.headers.get('authorization'), `Bearer ${KEY}`);
  assert.equal(first.body.model, 'claude-haiku-5-5');
  assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(first.body.output_config, { effort: 'low' });
  assert.equal(first.body.system[0].type, 'text');
  assert.ok(first.body.tools.every((t) => t.name && t.input_schema && !t.function), 'tools in Messages API shape');
  assert.equal(first.body.tool_choice, undefined, 'auto by default');
  assert.ok(first.body.max_tokens >= 8000, 'room for thinking');

  // Second request: the assistant turn echoed whole (thinking block included), then one user turn of tool results.
  const assistant = second.body.messages.at(-2);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content[0], thinking);
  const results = second.body.messages.at(-1);
  assert.equal(results.role, 'user');
  assert.equal(results.content[0].type, 'tool_result');
  assert.equal(results.content[0].tool_use_id, 'toolu_1');

  // 1000 in, 200 out per call at Haiku 5.5 list prices, two calls.
  assert.ok(Math.abs(out.cost - 2 * ((1000 * 0.1 + 200 * 0.5) / 1e6)) < 1e-12);
});

test('the last step asks for an answer with tool_choice none, and says why', async () => {
  const call = (i) => msg([{ type: 'tool_use', id: `toolu_${i}`, name: 'search_datasets', input: { query: 'x' } }], 'tool_use');
  const { fetchImpl, requests } = mockApi([call(1), msg([{ type: 'text', text: 'I found nothing.' }], 'end_turn')]);
  const out = await ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', maxSteps: 1, fetchImpl });
  assert.equal(out.answer, 'I found nothing.');
  const last = requests.at(-1).body;
  assert.deepEqual(last.tool_choice, { type: 'none' });
  assert.match(JSON.stringify(last.messages.at(-1)), /used all your tool steps/);
});

test('a "there is" answer gets one rewrite on the same conversation', async () => {
  const { fetchImpl, requests } = mockApi([
    msg([{ type: 'text', text: 'There are 3 open permits.' }], 'end_turn'),
    msg([{ type: 'text', text: 'I found 3 open permits.' }], 'end_turn'),
  ]);
  const out = await ask({ question: 'permits?', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl });
  assert.equal(out.answer, 'I found 3 open permits.');
  assert.equal(out.voice.rewritten, true);
  assert.equal(requests[1].body.messages.at(-2).role, 'assistant');
});

test('a refusal ends the turn honestly, without a rewrite', async () => {
  const { fetchImpl, requests } = mockApi([msg([], 'refusal', usage(), { stop_details: { type: 'refusal', category: 'general_harms' } })]);
  const out = await ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl });
  assert.match(out.answer, /^I can't answer that one/);
  assert.equal(out.refusal, 'general_harms');
  assert.equal(requests.length, 1);
});

test('Sonnet and Opus 5.5 opt into server-side fallbacks, and every attempt is priced', async () => {
  const iterations = [
    { type: 'message', model: null, input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ];
  const { fetchImpl, requests } = mockApi([msg([{ type: 'text', text: 'I found it.' }], 'end_turn', { ...usage(), iterations })]);
  const out = await ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl });
  assert.equal(requests[0].body.fallbacks, 'default');
  assert.match(requests[0].headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
  const expected = (1000 * 2) / 1e6 + (1000 * 5 + 100 * 25) / 1e6;
  assert.ok(Math.abs(out.cost - expected) < 1e-12, `${out.cost} vs ${expected}`);
  // Haiku has no server-side fallback: plain endpoint, no beta.
  const h = mockApi([msg([{ type: 'text', text: 'I found it.' }], 'end_turn')]);
  await ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl: h.fetchImpl });
  assert.equal(h.requests[0].body.fallbacks, undefined);
});

test("the key only ever goes to api.anthropic.com, whatever ANTHROPIC_BASE_URL says", async () => {
  const saved = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://someone-elses-proxy.example';
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    return claudeResponse(init, msg([{ type: 'text', text: 'I found it.' }], 'end_turn'));
  };
  try {
    await ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl });
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = saved;
  }
  assert.ok(seen.length && seen.every((u) => u.startsWith('https://api.anthropic.com/')), seen.join(' '));
});

test('a model with no price on file is refused before any request', async () => {
  const { fetchImpl, requests } = mockApi([msg([{ type: 'text', text: 'x' }], 'end_turn')]);
  await assert.rejects(ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-made-up-9', fetchImpl }), /No price on file/);
  assert.equal(requests.length, 0);
});

test('API errors never carry the key', async () => {
  const { fetchImpl } = mockApi([], { status: 401 });
  await assert.rejects(
    ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl }),
    (err) => {
      assert.match(err.message, /^Anthropic 401/);
      assert.ok(!err.message.includes(KEY));
      return true;
    }
  );
});

test('pricing: cache rates, and Haiku 5.5 prompts over 100k tokens on the long card', () => {
  const cached = priceUsage({ input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000 }, 'claude-haiku-5-5');
  assert.ok(Math.abs(cached - (100 * 0.1 + 10_000 * 0.01 + 2_000 * 0.125) / 1e6) < 1e-12);
  const long = priceUsage({ input_tokens: 150_000, output_tokens: 1_000 }, 'claude-haiku-5-5');
  assert.ok(Math.abs(long - (150_000 * 0.5 + 1_000 * 2.5) / 1e6) < 1e-12);
  assert.deepEqual(toAnthropicTools([{ type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object', properties: {} } } }]), [
    { name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } },
  ]);
});

test('a response cut off at max_tokens never runs its half-written tool call; one retry with more room', async () => {
  const truncated = msg([{ type: 'tool_use', id: 'toolu_cut', name: 'block_report', input: { address: '810 Un' } }], 'max_tokens');
  const { fetchImpl, requests } = mockApi([truncated, msg([{ type: 'text', text: 'I found nothing at 810 Union St.' }], 'end_turn')]);
  const out = await ask({ question: '810 Union St?', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl });
  assert.equal(out.answer, 'I found nothing at 810 Union St.');
  assert.equal(out.steps, 0, 'no tool ran');
  assert.equal(out.trace.length, 0, 'no query traced');
  assert.equal(requests[1].body.max_tokens, 16000);
  assert.ok(!JSON.stringify(requests[1].body.messages).includes('toolu_cut'), 'the cut-off turn was not sent back');
  assert.ok(Math.abs(out.cost - 2 * ((1000 * 0.1 + 200 * 0.5) / 1e6)) < 1e-12, 'both attempts counted');
});

test('cut off twice: an honest answer, never an empty one', async () => {
  const { fetchImpl } = mockApi([msg([{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens')]);
  const out = await ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl });
  assert.match(out.answer, /^I ran out of room/);
});

test('empty turns in the history are dropped, and the stable prefix carries a cache breakpoint', async () => {
  const { fetchImpl, requests } = mockApi([msg([{ type: 'text', text: 'I found it.' }], 'end_turn')]);
  await ask({
    question: 'q2', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl,
    history: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: '  ' }],
  });
  const { messages, system } = requests[0].body;
  assert.ok(messages.every((m) => typeof m.content !== 'string' || m.content.trim()), 'no empty turns');
  assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
});

test('environment headers (ANTHROPIC_CUSTOM_HEADERS) never reach the request or replace the key', async () => {
  const saved = process.env.ANTHROPIC_CUSTOM_HEADERS;
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: Bearer someone-elses-token\nX-Gw: leak';
  const { fetchImpl, requests } = mockApi([msg([{ type: 'text', text: 'I found it.' }], 'end_turn')]);
  try {
    await ask({ question: 'q', city: getCity('norfolk'), apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl });
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    else process.env.ANTHROPIC_CUSTOM_HEADERS = saved;
  }
  const h = requests[0].headers;
  assert.equal(h.get('authorization'), `Bearer ${KEY}`);
  assert.equal(h.get('x-gw'), null);
});

test('inside Claude Code, SIREN_ANTHROPIC_API_KEY wins over ANTHROPIC_API_KEY; OpenRouter models never get either', async () => {
  const { apiKeyFromEnv } = await import('../src/agent.js');
  const env = { ANTHROPIC_API_KEY: 'claude-code-own', SIREN_ANTHROPIC_API_KEY: 'siren', OPENROUTER_API_KEY: 'or' };
  assert.equal(apiKeyFromEnv('claude-haiku-5-5', env), 'siren');
  assert.equal(apiKeyFromEnv('claude-haiku-5-5', { ANTHROPIC_API_KEY: 'a' }), 'a');
  assert.equal(apiKeyFromEnv('openai/gpt-5.6-luna', env), 'or');
});
