// Web search for Claude models (src/web-search.js): Anthropic's server tool,
// behind a deployment's allowed_domains. Offline, against the fake Messages
// API (test/fake-claude.js), which streams server tool blocks as the API
// documents them. Nothing here reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ask } from '../src/agent.js';
import { systemPrompt } from '../src/prompt.js';
import { getCity } from '../src/cities/index.js';
import { applyConfig, definePlugin, webSearchConfig } from '../src/plugins.js';
import { afterFallback, priceUsage, PRICES } from '../src/providers/anthropic.js';
import {
  webSearchSettings, checkWebSearchForCity, urlAllowed, searchesIn, WEB_SEARCH_STEP, WEB_SEARCH_USD, WEB_SEARCH_TOOL_TYPE,
} from '../src/web-search.js';
import siren from '../deployments/siren.config.js';
import deployments from '../deployments/index.js';
import { claudeResponse } from './fake-claude.js';
import { webSearchOffScenario } from './fixtures/web-search-off-scenario.js';

const KEY = 'sk-ant-test-secret-key-do-not-leak';
const norfolk = getCity('norfolk');
const WS = { allowedDomains: ['www.norfolk.gov', 'virginia.gov'], maxUses: 3 };
const usage = (o = {}) => ({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
const msg = (content, stop_reason, u = usage(), extra = {}) => ({ id: 'msg_w', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason, stop_details: null, usage: u, ...extra });
const HAIKU_CALL = (1000 * 0.1 + 200 * 0.5) / 1e6;

// Blocks shaped as the web search tool page shows them.
const search = (id, query, caller) => ({ type: 'server_tool_use', id, name: 'web_search', input: { query }, ...(caller ? { caller } : {}) });
const result = (id, items, caller) => ({
  type: 'web_search_tool_result', tool_use_id: id, ...(caller ? { caller } : {}),
  content: items.map(([url, title, page_age]) => ({ type: 'web_search_result', url, title, encrypted_content: `enc-${url}`, ...(page_age ? { page_age } : {}) })),
});
const failed = (id, error_code) => ({ type: 'web_search_tool_result', tool_use_id: id, content: { type: 'web_search_tool_result_error', error_code } });
const cite = (url, title) => ({ type: 'web_search_result_location', url, title, encrypted_index: `idx-${url}`, cited_text: 'Section text…' });

function mockApi(replies) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/v1/messages')) {
      const i = requests.length;
      requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return claudeResponse(init, replies[Math.min(i, replies.length - 1)]);
    }
    if (u.includes('/api/catalog/')) return new Response(JSON.stringify({ results: [], resultSetSize: 0 }));
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests };
}

const near = (a, b) => Math.abs(a - b) < 1e-12;

// --- The deployment block -------------------------------------------------

test('webSearch config: off unless set; a checked allowlist, frozen', () => {
  assert.equal(webSearchSettings(undefined), null);
  assert.equal(webSearchSettings(null), null);
  assert.equal(webSearchConfig({}), null);
  const s = webSearchSettings({ allowedDomains: ['example.gov', 'example.com/blog', 'example.org/*/articles'], maxUses: 2 });
  assert.deepEqual(s, { allowedDomains: ['example.gov', 'example.com/blog', 'example.org/*/articles'], maxUses: 2 });
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.allowedDomains));
});

test('webSearch config: bad domains, lists and limits are refused with a reason', () => {
  const bad = (allowedDomains, re, maxUses = 3) => assert.throws(() => webSearchSettings({ allowedDomains, maxUses }), re, JSON.stringify(allowedDomains));
  bad(['https://norfolk.gov'], /scheme/);
  bad(['Norfolk.gov'], /lowercase/);
  bad(['*.norfolk.gov'], /wildcard/);
  bad(['ex*.com'], /wildcard/);
  bad(['gov'], /full domain/);
  bad(['localhost'], /full domain/);
  bad(['192.168.1.1'], /top-level domain/);
  bad(['[::1]'], /port or be an IPv6|not a valid/);
  bad(['norfolk.gov:443'], /port/);
  bad(['nörfolk.gov'], /ASCII/);
  bad(['norfolk .gov'], /ASCII/);
  bad(['-bad.gov'], /not a valid domain/);
  bad([''], /non-empty/);
  bad([42], /non-empty string/);
  bad([], /at least one/);
  bad(Array.from({ length: 65 }, (_, i) => `d${i}.gov`), /64 or fewer/);
  bad(['fema.gov', 'fema.gov'], /twice/);
  bad(['virginia.gov', 'lis.virginia.gov'], /already covered by virginia\.gov/);
  bad(['example.com/blog', 'example.com/blog/2026'], /already covered/);
  for (const maxUses of [0, 11, 2.5, '3', null]) bad(['fema.gov'], /maxUses/, maxUses);
  assert.throws(() => webSearchSettings({ allowedDomains: ['fema.gov'] }), /maxUses/, 'maxUses is required: a deployment states its bound');
  assert.throws(() => webSearchSettings({ allowedDomains: ['fema.gov'], maxUses: 3, blockedDomains: ['x.com'] }), /only allowedDomains and maxUses.*no blocklist/);
  assert.throws(() => webSearchSettings(['fema.gov']), /must be an object/);
  assert.throws(() => webSearchSettings('fema.gov'), /must be an object/);
});

test("webSearch config: no list may cover the city's open data portal (its data goes through the dataset policy)", () => {
  assert.throws(() => webSearchConfig({ webSearch: { allowedDomains: ['norfolk.gov'], maxUses: 3 } }, norfolk), /covers data\.norfolk\.gov, the open data portal/);
  assert.throws(() => webSearchConfig({ webSearch: { allowedDomains: ['data.norfolk.gov'], maxUses: 3 } }, norfolk), /open data portal/);
  assert.throws(() => webSearchConfig({ webSearch: { allowedDomains: ['data.norfolk.gov/resource'], maxUses: 3 } }, norfolk), /open data portal/, 'a path does not make it another site');
  assert.throws(() => webSearchConfig({ webSearch: { allowedDomains: ['norfolk.gov/data'], maxUses: 3 } }, norfolk), /open data portal/);
  assert.throws(() => checkWebSearchForCity(webSearchSettings({ allowedDomains: ['socrata.com'], maxUses: 1 }), norfolk), /socrata\.com/);
  assert.ok(webSearchConfig({ webSearch: { allowedDomains: ['www.norfolk.gov'], maxUses: 3 } }, norfolk));
  // ask() checks it too, before any request.
  const { fetchImpl, requests } = mockApi([msg([{ type: 'text', text: 'I found it.' }], 'end_turn')]);
  return assert.rejects(ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: { allowedDomains: ['norfolk.gov'], maxUses: 3 } }), /open data portal/).then(() => assert.equal(requests.length, 0));
});

test("every deployment's webSearch block validates against its city; Siren's is official sites only", () => {
  for (const [name, config] of Object.entries(deployments)) {
    const city = applyConfig(getCity(config.city || 'norfolk'), config);
    assert.doesNotThrow(() => webSearchConfig(config, city), name);
  }
  const s = webSearchConfig(siren, applyConfig(norfolk, siren));
  assert.equal(s.maxUses, 3);
  // Official public sites: .gov hosts, some by path.
  assert.ok(s.allowedDomains.every((d) => /^[^/]+\.gov(\/|$)/.test(d)), s.allowedDomains.join(' '));
  assert.ok(!s.allowedDomains.some((d) => d.includes('nrha.org')), 'nrha.org is not the housing authority');
  const allowed = [
    'https://law.lis.virginia.gov/vacode/title15.2/', 'https://lis.virginia.gov/bill-details/20261/HB549/text/CHAP0626',
    'https://msc.fema.gov/portal', 'https://tidesandcurrents.noaa.gov/x', 'https://www.congress.gov/bill/119th-congress/house-bill/8474',
    'https://www.vdot.virginia.gov/projects/hampton-roads-district/', 'https://www.dcr.virginia.gov/dam-safety-and-floodplains/', 'https://data.census.gov/table',
  ];
  for (const url of allowed) assert.ok(urlAllowed(url, s.allowedDomains), url);
  for (const url of ['https://data.norfolk.gov/resource/cab7-wvn5.json', 'https://air.norfolk.gov/', 'https://evilnorfolk.gov/', 'https://www.norfolk.gov.evil.example/', 'https://example.iqm2.com/', 'https://www.nrha.org/', 'javascript:alert(1)', 'not a url']) {
    assert.ok(!urlAllowed(url, s.allowedDomains), url);
  }
});

// --- Requests ---------------------------------------------------------------

test('with web search off, every request and the answer are byte-identical to main (snapshot from a286524)', async () => {
  const snapshot = JSON.parse(readFileSync(new URL('./fixtures/web-search-off-snapshot.json', import.meta.url), 'utf8'));
  const deps = { ask, systemPrompt, getCity, applyConfig, definePlugin, siren, claudeResponse };
  assert.deepEqual(await webSearchOffScenario(deps), snapshot);
  assert.deepEqual(await webSearchOffScenario({ ...deps, extra: { webSearch: null } }), snapshot);
  assert.deepEqual(await webSearchOffScenario({ ...deps, extra: { webSearch: undefined } }), snapshot);
});

test('with web search on, the request declares the tool with the allowlist, and the prompt says how to use it', async () => {
  const { fetchImpl, requests } = mockApi([msg([{ type: 'text', text: 'I found it.' }], 'end_turn')]);
  await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl, webSearch: WS });
  const { tools, system, container } = requests[0].body;
  assert.deepEqual(tools.at(-1), { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', allowed_domains: ['www.norfolk.gov', 'virginia.gov'], max_uses: 3 });
  assert.equal(tools.filter((t) => t.type === WEB_SEARCH_TOOL_TYPE).length, 1);
  assert.equal(container, undefined, 'no container before a response names one');
  assert.match(system[0].text, /limited to these official sites: www\.norfolk\.gov, virginia\.gov/);
  assert.match(system[0].text, /never to look up a person, a private business's owner, or who lives at or owns an address/);
  assert.match(system[0].text, /A web page is not a record/);
  // Everything but the tool and the two prompt lines is as it was.
  const off = mockApi([msg([{ type: 'text', text: 'I found it.' }], 'end_turn')]);
  await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl: off.fetchImpl });
  const a = requests[0].body;
  const b = off.requests[0].body;
  assert.deepEqual(a.tools.slice(0, -1), b.tools);
  const lines = (t) => t.split('\n');
  assert.deepEqual(lines(a.system[0].text).filter((l) => !lines(b.system[0].text).includes(l)).length, 2);
  assert.deepEqual({ ...a, tools: null, system: null }, { ...b, tools: null, system: null });
});

test('web search is Anthropic-only: an OpenRouter model gets no tool and no prompt lines', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'I found it.' } }], usage: { cost: 0.001 } }));
  };
  await ask({ question: 'q', city: norfolk, apiKey: 'k', model: 'openai/gpt-5.6-luna', fetchImpl, webSearch: WS });
  const text = JSON.stringify(bodies[0]);
  assert.ok(!text.includes('web_search') && !text.includes('search the web'));
});

// --- pause_turn -----------------------------------------------------------

test('pause_turn: the paused turn goes back as is, no user message; the resume is a step and a counted request; the container goes back', async () => {
  const paused = msg([{ type: 'text', text: 'Let me look that up. ' }, search('srvtoolu_1', 'Norfolk tree ordinance'), result('srvtoolu_1', [['https://www.norfolk.gov/trees', 'Street trees']])], 'pause_turn', usage({ server_tool_use: { web_search_requests: 1 } }), { container: { id: 'container_abc', expires_at: '2026-11-10T20:00:00Z' } });
  const done = msg([{ type: 'text', text: 'A page on www.norfolk.gov says street trees are the City\'s.', citations: [cite('https://www.norfolk.gov/trees', 'Street trees')] }], 'end_turn');
  const { fetchImpl, requests } = mockApi([paused, done]);
  const out = await ask({ question: 'Who owns street trees?', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS });

  assert.equal(requests.length, 2);
  const second = requests[1].body;
  assert.equal(second.messages.at(-1).role, 'assistant', 'resumed with the paused turn last, no new user message');
  assert.deepEqual(second.messages.at(-1).content, paused.content, 'exactly as the API sent it');
  assert.equal(second.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(second.container, 'container_abc');
  assert.equal(second.tool_choice, undefined, 'tools still allowed: the step cap is not reached');
  assert.equal(out.steps, 1, 'the resume counts as a step');
  assert.equal(out.requestBudget.model, 2, 'and as a request');
  assert.equal(out.answer, "A page on www.norfolk.gov says street trees are the City's.");
  assert.ok(near(out.cost, 2 * HAIKU_CALL + WEB_SEARCH_USD), String(out.cost));
});

test('pause_turn: a resume that is the last step must answer (tool_choice none); a turn that keeps pausing ends honestly at the step cap', async () => {
  const paused = (i) => msg([search(`srvtoolu_${i}`, `q${i}`), result(`srvtoolu_${i}`, [])], 'pause_turn', usage({ server_tool_use: { web_search_requests: 1 } }));
  const one = mockApi([paused(1), msg([{ type: 'text', text: 'I found no page about it.' }], 'end_turn')]);
  const a = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl: one.fetchImpl, webSearch: WS, maxSteps: 1 });
  assert.deepEqual(one.requests[1].body.tool_choice, { type: 'none' });
  assert.equal(a.answer, 'I found no page about it.');

  const always = mockApi([paused(1), paused(2), paused(3), paused(4)]);
  const b = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl: always.fetchImpl, webSearch: WS, maxSteps: 2 });
  assert.equal(always.requests.length, 3, 'two resumes, then the last step');
  assert.match(b.answer, /^I ran out of steps/);
  assert.equal(b.trace.filter((s) => s.tool === WEB_SEARCH_STEP).length, 3);
});

test('pause_turn resumes stop at the request budget like any model call', async () => {
  const paused = msg([search('srvtoolu_p', 'q'), result('srvtoolu_p', [])], 'pause_turn');
  const { fetchImpl, requests } = mockApi([paused]);
  // Haiku: a call can take 2 fetches (one SDK retry), a complete() 4, and the
  // reserve is 6. With 11: the first call offers tools (0 used + 4 + 1 + 6
  // <= 11); after it (1 used), 1 + 4 + 1 + 6 > 11, so the resume must answer.
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS, subrequestBudget: 11 });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.tool_choice, { type: 'none' });
  assert.match(out.answer, /request limit/);
  assert.equal(out.requestBudget.model, 2);
  assert.ok(out.requestBudget.used <= 11);
});

// --- Trace and hand-off -----------------------------------------------------

test('each search gets a trace step written from the response blocks; the cited page is handed off as a web record', async () => {
  const caller = { type: 'code_execution_20260120', tool_id: 'srvtoolu_code' };
  const reply = msg([
    { type: 'text', text: 'I searched for that. ' },
    search('srvtoolu_a', 'Norfolk stormwater utility fee'),
    result('srvtoolu_a', [['https://www.norfolk.gov/stormwater', 'Stormwater Utility', 'March 3, 2026'], ['https://www.norfolk.gov/fees', 'Fee schedule']]),
    { type: 'server_tool_use', id: 'srvtoolu_code', name: 'code_execution', input: { code: 'r = await web_search({"query": "Virginia Code 15.2-2114"})' } },
    search('srvtoolu_b', 'Virginia Code 15.2-2114', caller),
    result('srvtoolu_b', [['https://law.lis.virginia.gov/vacode/title15.2/chapter21/section15.2-2114/', '§ 15.2-2114. Regulation of stormwater']], caller),
    { type: 'code_execution_tool_result', tool_use_id: 'srvtoolu_code', content: { type: 'code_execution_result', stdout: '1 result', stderr: '', return_code: 0, content: [] } },
    { type: 'text', text: 'A page on www.norfolk.gov says the fee is billed monthly.', citations: [cite('https://www.norfolk.gov/stormwater', 'Stormwater Utility')] },
  ], 'end_turn', usage({ server_tool_use: { web_search_requests: 2 } }));
  const { fetchImpl } = mockApi([reply]);
  const out = await ask({ question: 'How is the stormwater fee billed?', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS });

  const steps = out.trace.filter((s) => s.tool === WEB_SEARCH_STEP);
  assert.equal(steps.length, 2, 'one per search; the code execution run is not a search');
  const [a, b] = steps;
  assert.equal(a.ok, true);
  assert.equal(a.rows, 2);
  assert.equal(a.query, 'Norfolk stormwater utility fee');
  assert.equal(a.url, 'https://www.norfolk.gov/stormwater');
  assert.deepEqual(a.results, [{ url: 'https://www.norfolk.gov/stormwater', title: 'Stormwater Utility', page_age: 'March 3, 2026' }, { url: 'https://www.norfolk.gov/fees', title: 'Fee schedule' }]);
  assert.match(a.soql, /^"Norfolk stormwater utility fee" → 2 results: Stormwater Utility <https:\/\/www\.norfolk\.gov\/stormwater>; Fee schedule/);
  assert.match(a.soql, /Run by Anthropic for the model.*this app sent no request of its own/);
  assert.equal(b.rows, 1);
  assert.match(b.soql, /Called from code the model ran on Anthropic's servers/);
  // The answer cites one page: only that one is handed off, as a web page.
  assert.deepEqual(out.resources.records, [{ kind: 'web', title: 'Stormwater Utility', url: 'https://www.norfolk.gov/stormwater', page_age: 'March 3, 2026' }]);
  assert.match(out.markdown.resources, /\*\*Web pages\*\* \(found by web search; pages, not records\)\n- \[Stormwater Utility\]\(https:\/\/www\.norfolk\.gov\/stormwater\), March 3, 2026/);
  assert.ok(!/Public records/.test(out.markdown.resources));
  assert.match(out.markdown.trace, /web search \(run by Anthropic\)/);
  assert.ok(near(out.cost, HAIKU_CALL + 2 * WEB_SEARCH_USD));
});

test('with no citations every result is handed off; results outside the allowlist never are; model text never becomes a trace step', async () => {
  const reply = msg([
    search('srvtoolu_c', 'tree removal permit'),
    result('srvtoolu_c', [['https://www.norfolk.gov/trees/permit', 'Tree permits'], ['https://www.example.com/blog', 'A blog']]),
    { type: 'text', text: 'I searched norfolk.gov and found the permit page. I also searched data.norfolk.gov for the warrants list.' },
  ], 'end_turn', usage({ server_tool_use: { web_search_requests: 1 } }));
  const { fetchImpl } = mockApi([reply]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS });
  const steps = out.trace.filter((s) => s.tool === WEB_SEARCH_STEP);
  assert.equal(steps.length, 1, 'the search the model only claims in its text has no step');
  assert.equal(steps[0].rows, 2);
  assert.match(steps[0].soql, /1 outside the allowed sites, not handed off/);
  assert.ok(!JSON.stringify(steps[0]).includes('example.com'), 'not listed as a usable result');
  assert.deepEqual(out.resources.records.map((r) => r.url), ['https://www.norfolk.gov/trees/permit']);
});

test('search errors: a failed step in the trace, no crash, not billed; the answer goes on', async () => {
  const reply = msg([
    search('srvtoolu_e1', 'first'), result('srvtoolu_e1', [['https://www.norfolk.gov/a', 'A']]),
    search('srvtoolu_e2', 'second'), failed('srvtoolu_e2', 'max_uses_exceeded'),
    search('srvtoolu_e3', 'third'), failed('srvtoolu_e3', 'unavailable'),
    search('srvtoolu_e4', 'fourth'), { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_e4', content: { type: 'something_new' } },
    { type: 'text', text: 'I found one page; the other searches failed.' },
  ], 'end_turn', usage({ server_tool_use: { web_search_requests: 1 } }));
  const { fetchImpl } = mockApi([reply]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS });
  assert.equal(out.answer, 'I found one page; the other searches failed.');
  const steps = out.trace.filter((s) => s.tool === WEB_SEARCH_STEP);
  assert.deepEqual(steps.map((s) => [s.ok, s.error ?? null]), [
    [true, null],
    [false, "this step's search limit was reached"],
    [false, 'the search service was unavailable'],
    [false, 'search error: unrecognized_result'],
  ]);
  assert.ok(steps.every((s) => !s.refused));
  assert.ok(near(out.cost, HAIKU_CALL + WEB_SEARCH_USD), 'one search billed: failed ones are not');
});

test('a declined step keeps its search steps but withholds the queries and results, and hands nothing off', async () => {
  const reply = msg([search('srvtoolu_r', 'something declined'), result('srvtoolu_r', [['https://www.norfolk.gov/x', 'X']])], 'refusal', usage({ server_tool_use: { web_search_requests: 1 } }), { stop_details: { type: 'refusal', category: 'general_harms' } });
  const { fetchImpl } = mockApi([reply]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS });
  assert.match(out.answer, /^I can't answer that one/);
  const [step] = out.trace.filter((s) => s.tool === WEB_SEARCH_STEP);
  assert.equal(step.withheld, true);
  assert.ok(!JSON.stringify(step).includes('something declined') && !JSON.stringify(step).includes('/x'));
  assert.deepEqual(out.resources.records, []);
  assert.ok(near(out.cost, HAIKU_CALL + WEB_SEARCH_USD), 'the search was still billed');
});

test('a search waiting on a client tool (stop_reason tool_use) is paired when its result arrives in the next response, and traced once', async () => {
  const { fetchImpl, requests } = mockApi([
    msg([search('srvtoolu_m', 'Norfolk zoning map'), { type: 'tool_use', id: 'toolu_m', name: 'search_datasets', input: { query: 'zoning' } }], 'tool_use'),
    msg([result('srvtoolu_m', [['https://www.norfolk.gov/zoning', 'Zoning']]), { type: 'text', text: 'I found the zoning page.' }], 'end_turn', usage({ server_tool_use: { web_search_requests: 1 } })),
  ]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS });
  // The follow-up holds only the tool_result: no text after it.
  assert.deepEqual(requests[1].body.messages.at(-1).content.map((b) => b.type), ['tool_result']);
  const steps = out.trace.filter((s) => s.tool === WEB_SEARCH_STEP);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].query, 'Norfolk zoning map');
  assert.equal(out.trace.indexOf(steps[0]) > out.trace.findIndex((s) => s.tool !== WEB_SEARCH_STEP), true, 'after the catalog search that ran first');
  assert.deepEqual(out.resources.records.map((r) => r.url), ['https://www.norfolk.gov/zoning']);
});

test('searchesIn ignores other server tools and keeps unknown shapes from crashing', () => {
  const pending = new Map();
  assert.deepEqual(searchesIn([{ type: 'server_tool_use', id: 's1', name: 'web_fetch', input: { url: 'https://x' } }, { type: 'web_fetch_tool_result', tool_use_id: 's1', content: {} }], pending), []);
  assert.deepEqual(searchesIn([null, { type: 'web_search_tool_result', tool_use_id: 'nope', content: [] }], pending), [{ id: 'nope', query: '(query not in the response)', caller: null, results: [] }], 'a result with no call seen still ran');
  assert.deepEqual(searchesIn(undefined), []);
});

// --- Pricing ------------------------------------------------------------------

test("pricing: Claude Sonnet 5.5 cache hits at $0.10 / MTok, and $10 per 1,000 web searches on top of tokens", () => {
  assert.equal(PRICES['claude-sonnet-5-5'].cacheRead, 0.1);
  assert.equal(WEB_SEARCH_USD, 0.01);
  const u = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 };
  assert.ok(near(priceUsage(u, 'claude-sonnet-5-5'), (100 * 2 + 50 * 10 + 10_000 * 0.1) / 1e6));
  assert.ok(near(priceUsage({ ...u, server_tool_use: { web_search_requests: 3 } }, 'claude-sonnet-5-5'), (100 * 2 + 50 * 10 + 10_000 * 0.1) / 1e6 + 0.03));
});

test('pricing with fallbacks: each attempt at its own rates, and every search counted once', () => {
  const it = (type, model, o = {}) => ({ type, model, input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
  const tokens = (1000 * 2 + 100 * 10) / 1e6 + (1000 * 2 + 100 * 10) / 1e6;
  // Per-attempt counts (1 + 2) beat the top level's (2: the answering attempt only).
  const perAttempt = { ...it('message', null), server_tool_use: { web_search_requests: 2 }, iterations: [it('message', null, { server_tool_use: { web_search_requests: 1 } }), it('fallback_message', 'claude-sonnet-5', { server_tool_use: { web_search_requests: 2 } })] };
  assert.ok(near(priceUsage(perAttempt, 'claude-sonnet-5-5'), tokens + 3 * WEB_SEARCH_USD));
  // Attempts without their own counts: the top-level count stands.
  const topOnly = { ...it('message', null), server_tool_use: { web_search_requests: 2 }, iterations: [it('message', null), it('fallback_message', 'claude-sonnet-5')] };
  assert.ok(near(priceUsage(topOnly, 'claude-sonnet-5-5'), tokens + 2 * WEB_SEARCH_USD));
});

test('a usage report that shows fewer searches than the blocks returned is priced from the blocks', async () => {
  const reply = msg([search('s1', 'a'), result('s1', []), search('s2', 'b'), result('s2', []), { type: 'text', text: 'I found no page.' }], 'end_turn', usage());
  const { fetchImpl } = mockApi([reply]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-haiku-5-5', fetchImpl, webSearch: WS });
  assert.ok(near(out.cost, HAIKU_CALL + 2 * WEB_SEARCH_USD), String(out.cost));
});

// --- Fallbacks ----------------------------------------------------------------

test('fallback echo: before the last fallback block, text and paired server-tool blocks go back; thinking, tool_use and unpaired calls do not', () => {
  const code = { type: 'code_execution_20260120', tool_id: 'srvtoolu_code' };
  const content = [
    { type: 'thinking', thinking: 'x', signature: 's' },
    { type: 'text', text: 'Looking. ' },
    search('srvtoolu_1', 'paired'), result('srvtoolu_1', [['https://www.norfolk.gov/a', 'A']]),
    search('srvtoolu_2', 'unpaired'),
    { type: 'server_tool_use', id: 'srvtoolu_code', name: 'code_execution', input: { code: '…' } },
    search('srvtoolu_3', 'from unfinished code', code), result('srvtoolu_3', [], code),
    { type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: {} },
    { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
    { type: 'thinking', thinking: 'y', signature: 't' },
    search('srvtoolu_4', 'after'), result('srvtoolu_4', []),
    { type: 'text', text: 'I found it.' },
  ];
  const kept = afterFallback(content);
  assert.deepEqual(kept.map((b) => b.id || b.tool_use_id || b.type), ['text', 'srvtoolu_1', 'srvtoolu_1', 'fallback', 'thinking', 'srvtoolu_4', 'srvtoolu_4', 'text']);
  assert.equal(kept[2].content[0].encrypted_content, 'enc-https://www.norfolk.gov/a', 'result blocks unchanged');
  // Without server tools, the rule is what it was.
  const plain = [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'a' }, { type: 'fallback', from: {}, to: {} }, { type: 'text', text: 'b' }];
  assert.deepEqual(afterFallback(plain), plain.slice(1));
});

test('a fallback mid-stream with a search: the pair is echoed, the declined partial’s search is traced and priced at each model’s rates', async () => {
  const iterations = [
    { type: 'message', model: null, input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 } },
    { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ];
  const first = msg([
    { type: 'thinking', thinking: 'declined notes', signature: 's1' },
    search('srvtoolu_f', 'Norfolk floodplain ordinance'), result('srvtoolu_f', [['https://www.norfolk.gov/flood', 'Floodplain']]),
    { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
    { type: 'tool_use', id: 'toolu_f', name: 'search_datasets', input: { query: 'flood' } },
  ], 'tool_use', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 }, iterations });
  const { fetchImpl, requests } = mockApi([first, { ...msg([{ type: 'text', text: 'I found the floodplain page.' }], 'end_turn'), model: 'claude-sonnet-5' }]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: KEY, model: 'claude-sonnet-5-5', fetchImpl, webSearch: WS });
  const echoed = requests[1].body.messages.at(-2);
  assert.deepEqual(echoed.content.map((b) => b.type), ['server_tool_use', 'web_search_tool_result', 'fallback', 'tool_use']);
  assert.equal(out.trace.filter((s) => s.tool === WEB_SEARCH_STEP).length, 1);
  const firstCost = (1000 * 2 + 50 * 10) / 1e6 + (1000 * 2 + 100 * 10) / 1e6 + WEB_SEARCH_USD;
  const secondCost = (1000 * 2 + 200 * 10) / 1e6;
  assert.ok(near(out.cost, firstCost + secondCost), `${out.cost} vs ${firstCost + secondCost}`);
});

// --- The Worker -------------------------------------------------------------

// The Worker imports .html, .json and text modules the way Wrangler bundles
// them (the same hook as test/ask-stream.test.js).
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

function memoryKV() {
  const store = new Map();
  return {
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, String(v));
    },
    async delete(k) {
      store.delete(k);
    },
    async list() {
      return { keys: [], list_complete: true };
    },
  };
}

test('the Worker sends Siren\'s allowlist on every model call, and WEB_SEARCH = "off" drops it', { skip }, async () => {
  const w = await loadWorker();
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      bodies.push(JSON.parse(init.body));
      return claudeResponse(init, { ...msg([{ type: 'text', text: 'I found it.' }], 'end_turn'), model: 'claude-sonnet-5-5' });
    }
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  };
  const req = () => new Request('https://x.org/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' }, body: JSON.stringify({ question: 'q', city: 'norfolk' }) });
  const env = { LIMITS: memoryKV(), MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'k', DEPLOYMENT: 'siren', IP_SALT: 'salt' };
  try {
    const on = await w.fetch(req(), env, { waitUntil() {} });
    assert.equal(on.status, 200);
    const tool = bodies[0].tools.find((t) => t.type === WEB_SEARCH_TOOL_TYPE);
    assert.deepEqual(tool, { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', allowed_domains: siren.webSearch.allowedDomains, max_uses: 3 });
    const off = await w.fetch(req(), { ...env, WEB_SEARCH: 'off' }, { waitUntil() {} });
    assert.equal(off.status, 200);
    assert.ok(!bodies[1].tools.some((t) => t.type === WEB_SEARCH_TOOL_TYPE));
    assert.ok(!bodies[1].system[0].text.includes('search the web'));
  } finally {
    globalThis.fetch = real;
  }
});

test("Siren's list reaches no page found naming private people (probed 2026-11-10)", async () => {
  const { default: siren } = await import('../deployments/siren.config.js');
  const list = siren.webSearch.allowedDomains;
  // Each URL is a kind of page a probe found on a site once listed: police
  // news naming arrested and missing people, hearing packets listing nearby
  // owners, wanted and missing persons, clemency lists, public comments,
  // fugitives, debarment lists, permit holders, fraud sentencings, hearing
  // exhibits. None may be reachable through the list.
  const refused = [
    'https://www.norfolk.gov/CivicAlerts.aspx?AID=1', 'https://www.norfolk.gov/m/newsflash/Home/Detail/1',
    'https://norfolkcityva.iqm2.com/Citizens/FileOpen.aspx?Type=1&ID=1',
    'https://vsp.virginia.gov/sex-offender-registry/', 'https://rga.lis.virginia.gov/Published/2024/SD2/PDF',
    'https://townhall.virginia.gov/L/viewcomments.cfm?commentid=1', 'https://downloads.regulations.gov/x/attachment_1.pdf',
    'https://www.epa.gov/enforcement/epa-fugitives', 'https://www.hud.gov/hud-partners/limited-denial',
    'https://apps-garfo.fisheries.noaa.gov/permits/data/permits_2025.csv', 'https://www.fema.gov/press-release/1',
    'https://www.congress.gov/119/meeting/house/1/documents/x.pdf', 'https://www.vdot.virginia.gov/media/vdotvirginiagov/projects/x.pdf',
    'https://www.dhcd.virginia.gov/certification', 'https://www.deq.virginia.gov/permits-regulations/enforcement',
  ];
  for (const url of refused) assert.ok(!urlAllowed(url, list), url);
  assert.ok(!list.includes('virginia.gov') && !list.includes('lis.virginia.gov'));
});
