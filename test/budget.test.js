// The per-answer outbound request budget (src/budget.js), offline: every
// fetch an answer makes is counted at the fetch boundary, tool requests stop
// short of the limit, and the final model call still happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ask, createContext, BUDGET_STOP_NOTE, BUDGET_TOOL_NOTE } from '../src/agent.js';
import { requestBudget, RequestBudgetError } from '../src/budget.js';
import { Trace } from '../src/trace.js';
import { getCity } from '../src/cities/index.js';
import { applyConfig, definePlugin } from '../src/plugins.js';
import siren from '../deployments/siren.config.js';
import { askLimits } from '../worker/limits.js';
import norfolkLegislation from '../data/norfolk-legislation.json' with { type: 'json' };

const norfolk = getCity('norfolk');
const ADDRESS_ROW = {
  full_address: '111 PENNSYLVANIA AVENUE', gpin: '1438184218', house_number: '111', full_street_name: 'PENNSYLVANIA AVENUE',
  street_name: 'PENNSYLVANIA', ward_district: '2', parcel_centroid_latitude: '36.88223592', parcel_centroid_longitude: '-76.28240994',
  census_tract_number: '28', civic_league: 'Colonial Place and Riverview', evacuation_zone: 'B',
};

// A fake network for every source an answer can reach, and a scripted
// OpenRouter: each chat completion returns the next reply.
function fakeNet(replies) {
  const calls = [];
  const modelBodies = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('https://openrouter.ai')) {
      modelBodies.push(JSON.parse(init.body));
      const reply = replies[Math.min(modelBodies.length - 1, replies.length - 1)];
      return new Response(JSON.stringify({ choices: [{ message: reply }], usage: { cost: 0.001 } }));
    }
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Some Dataset', columns: [{ fieldName: 'area' }] }));
    if (u.includes('/api/catalog/')) return new Response(JSON.stringify({ results: [] }));
    if (u.includes('/resource/ere7-kake')) return new Response(JSON.stringify([ADDRESS_ROW]));
    if (u.includes('iqm2.com')) return new Response('<html><body></body></html>');
    return new Response('[]');
  };
  return { fetchImpl, calls, modelBodies, modelCalls: () => calls.filter((u) => u.startsWith('https://openrouter.ai')).length };
}
const toolCalls = (calls) => ({
  content: '',
  tool_calls: calls.map(([name, args], i) => ({ id: `t${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
});

test('the counter: tool fetches stop at the limit less the reserve; model fetches are counted, never refused', async () => {
  const seen = [];
  const b = requestBudget({ limit: 5, fetchImpl: async (u) => (seen.push(u), new Response('ok')) });
  b.setReserve(2);
  await b.tool('https://a/1');
  await b.tool('https://a/2');
  await b.tool('https://a/3');
  assert.equal(b.exhausted, true, '3 used + 2 kept = 5');
  await assert.rejects(b.tool('https://a/4'), (err) => err instanceof RequestBudgetError && /limit of 5 outbound requests/.test(err.message));
  await b.model('https://m/1');
  await b.model('https://m/2');
  assert.deepEqual(b.summary(), { limit: 5, used: 5, tools: 3, model: 2, refused: 1 });
  assert.deepEqual(seen, ['https://a/1', 'https://a/2', 'https://a/3', 'https://m/1', 'https://m/2'], 'the refused request never went out');

  // No limit (the CLI's default): everything goes out, and is still counted.
  for (const limit of [undefined, '', '0', 'lots', Infinity]) {
    const open = requestBudget({ limit, fetchImpl: async () => new Response('ok') });
    open.setReserve(4);
    for (let i = 0; i < 60; i++) await open.tool('https://a');
    assert.equal(open.exhausted, false);
    assert.deepEqual(open.summary(), { limit: null, used: 60, tools: 60, model: 0, refused: 0 });
  }
});

test('a refused request is in the trace, marked refused with the reason, written by code', async () => {
  const b = requestBudget({ limit: 1, fetchImpl: async () => new Response('[]') });
  b.setReserve(1);
  const trace = new Trace();
  await assert.rejects(trace.record({ tool: 'query', url: 'https://x' }, async () => ({ result: await b.tool('https://x'), rows: 0 })));
  assert.equal(trace.steps[0].ok, false);
  assert.equal(trace.steps[0].refused, true);
  assert.match(trace.steps[0].error, /^Not sent: this answer's limit of 1 outbound requests/);
  assert.match(trace.toMarkdown(), /refused: Not sent/);
});

test('a turn whose tools need more than the budget still ends in an answer from a final model call', async () => {
  // Six generic queries on six datasets: each is a metadata read plus the
  // query, 12 tool fetches, against a budget of 10 with 2 kept for the model.
  const ids = ['aaaa-0001', 'aaaa-0002', 'aaaa-0003', 'aaaa-0004', 'aaaa-0005', 'aaaa-0006'];
  const net = fakeNet([
    toolCalls(ids.map((id) => ['query_dataset', { dataset_id: id, soql: 'SELECT area, count(*) AS n GROUP BY area' }])),
    { content: 'I found results for three of the six datasets; I could not check the rest.' },
  ]);
  const out = await ask({ question: 'Compare six datasets', city: norfolk, apiKey: 'test', fetchImpl: net.fetchImpl, subrequestBudget: 10 });

  assert.equal(out.answer, 'I found results for three of the six datasets; I could not check the rest.');
  assert.equal(net.modelCalls(), 2, 'the final model call happened');
  const final = net.modelBodies[1];
  assert.equal(final.tools, undefined, 'tools are off for the final call');
  assert.equal(final.messages.at(-1).content, BUDGET_STOP_NOTE, 'the model is told the budget is used up');
  const toolMsgs = final.messages.filter((m) => m.role === 'tool');
  assert.ok(toolMsgs.slice(4).every((m) => JSON.parse(m.content).request_budget === BUDGET_TOOL_NOTE), 'refused tools carry the note');
  assert.ok(!JSON.parse(toolMsgs[0].content).request_budget, 'a tool that got everything carries none');
  // Results the budget cut short aren't kept for a follow-up turn: it runs them again.
  const whole = toolMsgs.filter((m) => !JSON.parse(m.content).request_budget).length;
  assert.ok(whole >= 1 && whole < ids.length);
  assert.equal(out.toolResults.length, whole);
  assert.ok(out.toolResults.every((r) => !JSON.parse(r.content).request_budget));

  // The count includes the model calls, and never passes the budget.
  assert.equal(out.requestBudget.used, net.calls.length);
  assert.equal(out.requestBudget.model, 2);
  assert.ok(out.requestBudget.used <= 10, `${out.requestBudget.used} requests`);
  assert.equal(out.requestBudget.tools, 7, '10, less the first model call and the 2 kept to finish');
  // Refused requests are in the trace, and the record says so in plain words.
  const refused = out.trace.filter((s) => s.refused);
  assert.equal(refused.length, out.requestBudget.refused);
  assert.ok(refused.length >= 2);
  assert.equal(out.requestBudget.reached, true);
  assert.match(out.requestBudget.note, /^I stopped at this answer's limit of 10 outbound requests and answered from what I had found\. The \d+ requests I didn't send are marked "refused" in the trace\.$/);
  assert.match(out.markdown.trace, /refused: Not sent/);
});

test("a block report cut short returns what it found, and the loop asks no more of the tools", async () => {
  const net = fakeNet([
    toolCalls([['block_report', { address: '111 Pennsylvania Ave' }]]),
    { content: 'I found the address and part of the block.' },
  ]);
  const out = await ask({ question: "What's on my block?", city: norfolk, apiKey: 'test', fetchImpl: net.fetchImpl, subrequestBudget: 8 });
  assert.equal(out.answer, 'I found the address and part of the block.');
  assert.equal(net.modelCalls(), 2);
  assert.equal(net.modelBodies[1].tools, undefined, 'no more tools were offered: the budget was gone');
  const result = JSON.parse(net.modelBodies[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(result.result.address.address, '111 PENNSYLVANIA AVENUE', 'what came back is kept');
  assert.ok(result.result.datasets.some((d) => /^Not sent/.test(d.error || '')), 'the datasets not read say why');
  assert.equal(result.request_budget, BUDGET_TOOL_NOTE);
  assert.ok(out.requestBudget.used <= 8);
});

test('the count includes provider calls and their retries (Anthropic SDK)', async () => {
  let n = 0;
  const msg = (content, stop_reason) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/')) {
      n++;
      // The first attempt is overloaded; the SDK retries it once.
      if (n === 1) return new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
      const body = n === 2
        ? msg([{ type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: { query: 'trees' } }], 'tool_use')
        : msg([{ type: 'text', text: 'I found no tree datasets.' }], 'end_turn');
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ results: [] }));
  };
  const out = await ask({ question: 'trees?', city: norfolk, apiKey: 'k', model: 'claude-haiku-5-5', fetchImpl, subrequestBudget: 45 });
  assert.equal(out.answer, 'I found no tree datasets.');
  assert.deepEqual(out.requestBudget, { limit: 45, used: 4, tools: 1, model: 3, refused: 0, reached: false });
});

test('no path on an answer fetches around the counter: every tool, every plugin, the model', async () => {
  const city = applyConfig(norfolk, siren);
  const plugins = siren.plugins.map(definePlugin);
  const A = { address: '111 Pennsylvania Ave' };
  const net = fakeNet([
    toolCalls([
      ['search_datasets', { query: 'trees' }],
      ['describe_dataset', { dataset_id: 'qzfe-wj25' }],
      ['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT area, count(*) AS n GROUP BY area' }],
      ['lookup_address', A],
      ['block_report', A],
      ['get_legislation', { legislation_id: '5832' }],
      ['find_legislation', { text: 'Pennsylvania' }],
      ['upcoming_meetings', { days: 30 }],
      ['suggest_data_source', { need: 'n', source: 's', why: 'w' }],
      ['trees_on_my_block', A],
      ['water_on_my_block', A],
      ['litter_on_my_street', A],
      ['sponge_site_screen', { intervention: 'rain garden' }],
      ['case_file', { topic: 'norfolk-trees' }],
    ]),
    { content: 'I found it.' },
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('a fetch went around the counter');
  };
  let out;
  try {
    out = await ask({ question: 'everything', city, plugins, indexes: { 'norfolk-legislation': norfolkLegislation }, apiKey: 'test', fetchImpl: net.fetchImpl });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(out.answer, 'I found it.');
  assert.ok(net.calls.length > 40, `${net.calls.length} requests`);
  assert.equal(out.requestBudget.used, net.calls.length, 'every request that reached the network was counted');
  assert.equal(out.requestBudget.model, 2);
  assert.ok(!JSON.stringify(out.trace).includes('around the counter'));
  assert.deepEqual({ limit: out.requestBudget.limit, refused: out.requestBudget.refused, reached: out.requestBudget.reached }, { limit: null, refused: 0, reached: false }, 'no limit unless one is set');
  assert.equal(out.requestBudget.note, undefined);
});

test('createContext hands tools only the counting fetch, and only a read-only view of the count', async () => {
  const seen = [];
  const budget = requestBudget({ fetchImpl: async (u) => (seen.push(String(u)), new Response('[]')) });
  const ctx = createContext({ city: norfolk, budget });
  await ctx.socrata.query('qzfe-wj25', 'SELECT area LIMIT 1');
  await ctx.http.text('https://example.org/x');
  await ctx.iqm2.getHTML('https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=1', 'read');
  assert.equal(ctx.requests.used, seen.length);
  assert.equal(ctx.requests.summary().tools, seen.length);
  assert.equal(ctx.socrata.fetch, budget.tool);
  assert.equal(ctx.iqm2.fetch, budget.tool);
  // No tool gets the counter itself: its model lane is never refused and skips the trace.
  assert.equal(ctx.budget, undefined);
  assert.ok(!Object.values(ctx.requests).includes(budget.model));
  assert.ok(Object.isFrozen(ctx.requests));
});

// Comments and string literals out, so prose about fetching doesn't count.
const stripCode = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
const BARE_FETCH = /(?<![.\w$])fetch(?![\w$]|\s*:)/;

test('the source scan catches every way of naming the real network', () => {
  for (const bad of [
    'await fetch(u)',
    'await (fetchImpl || fetch)(OPENROUTER, {',
    'this.fetch = fetchImpl || fetch;',
    'const f = fetch; f(u)',
    'fetch.call(null, u)',
  ]) assert.ok(BARE_FETCH.test(stripCode(bad)), bad);
  for (const bad of ['const f = self.fetch; f(u)', 'self["fetch"](u)', 'window.fetch(u)']) assert.ok(/\b(self|window)\s*[.[]/.test(stripCode(bad)), bad);
  for (const ok of [
    'this.fetch(u)',
    'const res = await this.fetch(url, init);',
    'fetchImpl: budget.tool',
    'new Anthropic({ fetch: guardedFetch(apiKey, fetchImpl) })',
    'fetchesPerCall: 1',
    "throw new Error('Could not fetch the page')",
    '// fetch(u) in a comment',
  ]) assert.ok(!BARE_FETCH.test(stripCode(ok)), ok);
});

// The spirit of test/conformance.js, for core: in src/, only src/budget.js
// may name the real network. Everything else takes a fetch it is given.
test('in src/, only the budget module names the real network', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}${e.name}/`);
      else if (e.name.endsWith('.js')) files.push(`${dir}${e.name}`);
    }
  };
  walk('../src/');
  assert.ok(files.length > 10);
  const problems = [];
  for (const f of files) {
    if (f === '../src/budget.js') continue;
    const code = stripCode(readFileSync(new URL(f, import.meta.url), 'utf8'));
    if (/\bglobalThis\b/.test(code)) problems.push(`${f} uses globalThis`);
    if (/\b(self|window)\s*[.[]/.test(code)) problems.push(`${f} reaches a global object`);
    // Any bare `fetch` (a call, a fallback, an alias); property names such as
    // this.fetch, fetchImpl, fetchesPerCall and an option key `fetch:` pass.
    if (BARE_FETCH.test(code)) problems.push(`${f} names fetch directly`);
    if (/\bXMLHttpRequest\b|\bWebSocket\b|from\s+['"]node:(http|https|net|tls)['"]/.test(code)) problems.push(`${f} opens its own connection`);
  }
  assert.deepEqual(problems, []);
});

// A scripted Anthropic API. Each complete() is `plan` entries; every attempt
// can be overloaded first (the SDK retries it), and a reply can be cut off at
// max_tokens (the provider asks once more, with more room).
function fakeClaude({ replies, overloadEvery = false, truncateFirst = false }) {
  const calls = [];
  const bodies = [];
  let attempt = 0;
  let reply = 0;
  const msg = (content, stop_reason) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (!u.startsWith('https://api.anthropic.com/')) {
      if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Some Dataset', columns: [{ fieldName: 'area' }] }));
      return new Response('[]');
    }
    attempt++;
    if (overloadEvery && attempt % 2 === 1) return json({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 529);
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (truncateFirst && body.max_tokens < 16000) return json(msg([{ type: 'text', text: 'I found' }], 'max_tokens'));
    const r = replies[Math.min(reply++, replies.length - 1)];
    return json(r.calls
      ? msg(r.calls.map(([name, input], i) => ({ type: 'tool_use', id: `toolu_${reply}_${i}`, name, input })), 'tool_use')
      : msg([{ type: 'text', text: r.text }], 'end_turn'));
  };
  return { fetchImpl, calls, bodies, model: () => calls.filter((u) => u.startsWith('https://api.anthropic.com/')).length };
}
const queries = (n) => Array.from({ length: n }, (_, i) => ['query_dataset', { dataset_id: `aaaa-000${i}`, soql: 'SELECT area, count(*) AS n GROUP BY area' }]);

test('Claude at its worst (every try retried, every reply cut off once) still stays within the budget', async () => {
  const net = fakeClaude({
    overloadEvery: true,
    truncateFirst: true,
    replies: [{ calls: queries(8) }, { text: 'There is a permit on the block.' }],
  });
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', model: 'claude-haiku-5-5', fetchImpl: net.fetchImpl, subrequestBudget: 20 });
  assert.equal(out.answer, 'There is a permit on the block.', 'the cut-off rewrite is not used');
  assert.ok(out.requestBudget.used <= 20, `${out.requestBudget.used} requests of 20`);
  assert.equal(out.requestBudget.used, net.calls.length);
  // The reserve is the final answer at its worst (4: a cut-off call's second
  // try, each retried) plus one rewrite call with its retry (2): 6. The first
  // call took 4, so tools had 20 - 4 - 6.
  assert.equal(out.requestBudget.tools, 10);
  assert.equal(out.requestBudget.model, 10, 'first call 4, final 4, rewrite 2');
  assert.deepEqual(net.bodies.map((b) => b.tool_choice?.type !== 'none'), [true, true, false, false, false], 'tools are offered on the first call only');
  assert.equal(out.voice.ok, false);
  assert.equal(out.voice.rewritten, false);
});

test('Claude with retries: tools are not offered when no tool request could follow the call', async () => {
  // Budget 20, reserve 6, each call 2 requests (overloaded, then answered).
  // After the first call (2) and three queries (6), used is 8: a second
  // tools-on call (up to 4) plus a tool request plus the reserve needs 11,
  // and 12 are left, so it is offered. After the next query (2 more) only 8
  // are left, so the model answers with tools off.
  const net = fakeClaude({
    overloadEvery: true,
    replies: [{ calls: queries(3) }, { calls: queries(1) }, { calls: queries(1) }, { text: 'I found three datasets.' }],
  });
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', model: 'claude-haiku-5-5', fetchImpl: net.fetchImpl, subrequestBudget: 20 });
  assert.deepEqual(net.bodies.map((b) => b.tool_choice?.type !== 'none'), [true, true, false]);
  assert.equal(out.requestBudget.refused, 0, 'no tool request is made only to be refused');
  assert.ok(out.requestBudget.used <= 20);
  assert.equal(out.requestBudget.reached, true);
});

test('OpenRouter: tools ending one short of the reserve do not buy a paid call whose tools are all refused', async () => {
  // Budget 10, reserve 2. The first call and three queries make 7; a tools-on
  // call would leave room for no tool request, so the next call is the last.
  const net = fakeNet([
    toolCalls(queries(3)),
    toolCalls(queries(1)),
    { content: 'I found three datasets.' },
  ]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'test', fetchImpl: net.fetchImpl, subrequestBudget: 10 });
  assert.equal(net.modelCalls(), 2);
  assert.equal(net.modelBodies[1].tools, undefined);
  assert.equal(net.modelBodies[1].messages.at(-1).content, BUDGET_STOP_NOTE);
  assert.deepEqual({ used: out.requestBudget.used, refused: out.requestBudget.refused, reached: out.requestBudget.reached }, { used: 8, refused: 0, reached: true });
});

test('the voice rewrite goes out only if it fits; otherwise the check fails honestly', async () => {
  const net = fakeNet([{ content: 'There is a permit.' }]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'test', fetchImpl: net.fetchImpl, subrequestBudget: 1 });
  assert.equal(net.modelCalls(), 1);
  assert.deepEqual(out.voice, { ok: false, rewritten: false, violations: out.voice.violations, rewriteSkipped: true });
  assert.ok(out.voice.violations.length);
  assert.equal(out.requestBudget.used, 1);
});

test("the Worker's limits: SUBREQUEST_BUDGET defaults to 45, stays 10-10000, and reaches ask()", () => {
  for (const [value, want] of [[undefined, 45], ['', 45], ['5', 45], ['abc', 45], ['4O', 45], ['99999', 10000], ['60', 60]]) {
    assert.equal(askLimits({ SUBREQUEST_BUDGET: value }, 'openrouter').subrequestBudget, want, String(value));
  }
  assert.deepEqual(askLimits({}, 'anthropic'), { maxSteps: 6, subrequestBudget: 45, maxTokens: 8000 });
  assert.deepEqual(askLimits({}, 'openrouter'), { maxSteps: 6, subrequestBudget: 45, maxTokens: 1200 });
  // The Worker passes them to ask() (it can't be imported outside the Workers runtime).
  const worker = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  const call = worker.slice(worker.indexOf('await ask({'), worker.indexOf('});', worker.indexOf('await ask({')));
  assert.match(call, /\.\.\.askLimits\(env, providerOf\(model\)\),/);
  assert.doesNotMatch(call, /subrequestBudget|maxSteps|maxTokens/, 'nothing after the spread overrides it');
});

test('the CLI refuses a SUBREQUEST_BUDGET that is not a whole number of at least 10', () => {
  for (const value of ['3', '4O', '0', '12.5']) {
    const r = spawnSync(process.execPath, [new URL('../bin/socrata-agent.js', import.meta.url).pathname, 'ask', 'hi'], {
      env: { ...process.env, SUBREQUEST_BUDGET: value, OPENROUTER_API_KEY: '' },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0, value);
    assert.match(r.stderr, /SUBREQUEST_BUDGET must be a whole number of at least 10/, value);
  }
});
