// OpenTelemetry from the Claude API (worker/otlp.js): the spans Anthropic
// exports for Siren's API workspace, written to Workers Logs. Jason,
// 2026-11-11: "the Siren workspace refers to the Claude API we're running
// her on. It can export opentelemetry traces". Only metadata ever reaches a
// log, whatever the destination's content mode; and each answer's model
// calls carry one trace id (a W3C traceparent) that its own line carries too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { handleOtlp, decodeTraces, spanEvent, otlpOn, OTLP_PATH, TOKEN_HEADER, MAX_BODY, MAX_INFLATED, LOG_BUDGET, MAX_SPANS, OTHER_NAME } from '../worker/otlp.js';
import { newTrace, traceArgs, answerEvent } from '../worker/telemetry.js';
import { guardedFetch, TRACEPARENT_RE } from '../src/providers/anthropic.js';
import { ask } from '../src/agent.js';
import { getCity } from '../src/cities/index.js';
import { claudeResponse } from './fake-claude.js';
import { signUser, userId, userCookieName } from '../worker/accounts.js';

// --- A protobuf writer, as far as OTLP traces need it. ---
const enc = new TextEncoder();
function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const tag = (no, wire) => varint((BigInt(no) << 3n) | BigInt(wire));
const ld = (no, bytes) => [...tag(no, 2), ...varint(bytes.length), ...bytes];
const vi = (no, n) => [...tag(no, 0), ...varint(n)];
const fixed = (no, setter, value) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer)[setter](0, value, true);
  return [...tag(no, 1), ...b];
};
const str = (s) => [...enc.encode(s)];
const bytesOf = (hexString) => hexString.match(/../g).map((h) => parseInt(h, 16));
const anyValue = (v) =>
  typeof v === 'string' ? ld(1, str(v))
    : typeof v === 'boolean' ? vi(2, v ? 1 : 0)
      : Array.isArray(v) ? ld(5, v.flatMap((x) => ld(1, anyValue(x))))
        : Number.isInteger(v) ? vi(3, v)
          : fixed(4, 'setFloat64', v);
const kv = (k, v) => [...ld(1, str(k)), ...ld(2, anyValue(v))];
function span({ trace = 'ab'.repeat(16), id = 'cd'.repeat(8), parent = '', name, kind = 2, start = 1762880000000000000n, end = 1762880001234567000n, attrs = {}, status = 1, statusMessage = '', traceState = '', events = [], links = [] }) {
  return [
    ...ld(1, bytesOf(trace)), ...ld(2, bytesOf(id)), ...(traceState ? ld(3, str(traceState)) : []), ...(parent ? ld(4, bytesOf(parent)) : []), ...ld(5, str(name)), ...vi(6, kind),
    ...fixed(7, 'setBigUint64', start), ...fixed(8, 'setBigUint64', end),
    ...Object.entries(attrs).flatMap(([k, v]) => ld(9, kv(k, v))),
    // Event { time 1, name 2, attributes 3 }; Link { trace_id 1, span_id 2, trace_state 3, attributes 4 }.
    ...events.flatMap((e) => ld(11, [...fixed(1, 'setBigUint64', start), ...ld(2, str(e.name)), ...Object.entries(e.attrs || {}).flatMap(([k, v]) => ld(3, kv(k, v)))])),
    ...links.flatMap((l) => ld(13, [...ld(1, bytesOf(l.trace)), ...ld(2, bytesOf(l.span)), ...ld(3, str(l.state || '')), ...Object.entries(l.attrs || {}).flatMap(([k, v]) => ld(4, kv(k, v)))])),
    ...ld(15, [...(statusMessage ? ld(2, str(statusMessage)) : []), ...vi(3, status)]),
  ];
}
function request(spans, resource = { 'service.name': 'claude-platform' }, scopeAttrs = {}) {
  const res = Object.entries(resource).flatMap(([k, v]) => ld(1, kv(k, v)));
  const scope = ld(1, [...ld(1, str('com.anthropic.claude-platform')), ...Object.entries(scopeAttrs).flatMap(([k, v]) => ld(3, kv(k, v)))]);
  return Uint8Array.from(ld(1, [...ld(1, res), ...ld(2, [...scope, ...spans.flatMap((s) => ld(2, span(s)))])]));
}

const TOKEN = 'x'.repeat(48);
const WS = 'wrkspc_siren';
const PROMPT = 'What is planned at 810 Union St? Jane Smith asked.';
const CREATE = {
  name: 'anthropic.messages.create', kind: 2,
  attrs: {
    'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-sonnet-5-5', 'gen_ai.response.model': 'claude-sonnet-5-5',
    'gen_ai.usage.input_tokens': 12000, 'gen_ai.usage.output_tokens': 800, 'gen_ai.usage.cache_read.input_tokens': 9000,
    'anthropic.message.stop_reason': 'tool_use', 'anthropic.request.id': 'req_011ABC', 'http.response.status_code': 200,
    'anthropic.organization.id': 'org-123', 'anthropic.workspace.id': WS, 'user.id': 'u-42',
    'url.full': 'https://api.anthropic.com/v1/messages', 'server.address': 'api.anthropic.com', 'anthropic.beta': ['fallbacks-2026-09-01'],
  },
};
const SEARCH = { name: 'anthropic.tool_use web_search', kind: 1, id: 'ef'.repeat(8), parent: 'cd'.repeat(8), attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web_search', 'gen_ai.tool.call.id': 'srvtoolu_1', 'anthropic.workspace.id': WS } };
const CONTENT = {
  ...CREATE, id: '12'.repeat(8),
  attrs: { ...CREATE.attrs, 'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: PROMPT }] }]), 'gen_ai.system_instructions': 'You are Siren', 'gen_ai.output.messages': 'Jane Smith lives', 'gen_ai.tool.call.arguments': '{"query":"Jane Smith 810 Union"}', 'anthropic.tool_result.content': PROMPT },
};

const post = (body, { token = TOKEN, gzip = true, type = 'application/x-protobuf', headers = {} } = {}) =>
  new Request(`https://ask-siren.example${OTLP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': type, ...(gzip ? { 'content-encoding': 'gzip' } : {}), ...(token ? { [TOKEN_HEADER]: token } : {}), 'user-agent': 'Claude-Platform', ...headers },
    body: gzip ? gzipSync(body) : body,
  });
const ON = { TELEMETRY: 'true', OTLP_TOKEN: TOKEN };
async function deliver(req, env = ON) {
  const logged = [];
  const res = await handleOtlp(req, env, (line) => logged.push(JSON.parse(line)));
  return { res, logged };
}

test('decodes an OTLP request: names, kinds, ids, times, status, and only the attributes kept', () => {
  const [s] = decodeTraces(request([CREATE]));
  assert.equal(s.name, 'anthropic.messages.create');
  assert.equal(s.workspace, WS);
  const e = spanEvent(s);
  assert.equal(e.event, 'claude.span');
  assert.equal(e.kind, 'server');
  assert.equal(e.trace, 'ab'.repeat(16));
  assert.equal(e.span, 'cd'.repeat(8));
  assert.equal(e.parent, null);
  assert.equal(e.start, '2025-11-11T16:53:20.000Z');
  assert.equal(e.ms, 1234.567);
  assert.equal(e.status, 'ok');
  assert.deepEqual(e.attrs, {
    'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-sonnet-5-5', 'gen_ai.response.model': 'claude-sonnet-5-5',
    'gen_ai.usage.input_tokens': 12000, 'gen_ai.usage.output_tokens': 800, 'gen_ai.usage.cache_read.input_tokens': 9000,
    'anthropic.message.stop_reason': 'tool_use', 'anthropic.request.id': 'req_011ABC', 'http.response.status_code': 200,
  }, 'no organization, workspace or user id, no URL, no betas');
});

const noHooks = typeof nodeModule.registerHooks !== 'function' && 'node:module has no registerHooks';
let worker;
async function loadWorker() {
  if (worker) return worker;
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && (context.importAttributes?.type === 'text' || url.endsWith('.html'))) {
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

test('off without TELEMETRY, or without a token of 32 characters or more: the path answers as any unknown path does', { skip: noHooks }, async () => {
  assert.equal(otlpOn({}), false);
  assert.equal(otlpOn({ TELEMETRY: 'true', OTLP_TOKEN: 'short' }), false);
  assert.equal(otlpOn({ OTLP_TOKEN: TOKEN }), false, 'removing TELEMETRY stops it too');
  assert.equal(otlpOn(ON), true);
  const worker = await loadWorker();
  const body = request([CREATE]);
  for (const env of [{}, { TELEMETRY: 'true', OTLP_TOKEN: 'short' }, { OTLP_TOKEN: TOKEN }]) {
    const at = await worker.fetch(post(body), env, {});
    const elsewhere = await worker.fetch(new Request('https://ask-siren.example/otlp/v1/other', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: gzipSync(body) }), env, {});
    assert.equal(at.status, elsewhere.status);
    assert.equal(await at.text(), await elsewhere.text());
  }
  const on = await worker.fetch(post(body), ON, {});
  assert.equal(on.status, 200);
});

test('a delivery: gzipped or not, one line per span, an empty protobuf answer', async () => {
  for (const gzip of [true, false]) {
    const { res, logged } = await deliver(post(request([CREATE, SEARCH]), { gzip }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/x-protobuf');
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assert.deepEqual(logged.map((l) => l.name), ['anthropic.messages.create', 'anthropic.tool_use web_search']);
    assert.deepEqual(logged[1].attrs, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'web_search' });
    assert.equal(logged[1].parent, 'cd'.repeat(8));
    assert.equal(logged[1].kind, 'internal');
  }
});

test('Full content arrives: none of it reaches a log, and the summary says it arrived', async () => {
  const { res, logged } = await deliver(post(request([CONTENT])));
  assert.equal(res.status, 200);
  const all = JSON.stringify(logged);
  for (const leak of ['Jane', 'Smith', '810', 'Union', 'Siren', 'You are', 'lives', 'query', 'org-123', WS, 'u-42']) assert.ok(!all.includes(leak), leak);
  assert.deepEqual(logged[0], { event: 'claude.otlp', v: 1, spans: 1, logged: 1, content_arrived: true }, 'the summary first');
});

test('a value of the wrong shape is dropped, not logged', async () => {
  const odd = { ...CREATE, attrs: { 'gen_ai.request.model': PROMPT, 'gen_ai.tool.name': 'Jane Smith', 'anthropic.request.id': 'Jane', 'gen_ai.usage.input_tokens': 'many', 'error.type': 'Jane Smith 810' } };
  const { logged } = await deliver(post(request([odd])));
  assert.deepEqual(logged[0].attrs, {});
  const named = { ...CREATE, name: 'anthropic.tool_use <script>Jane</script>' };
  const { logged: l2 } = await deliver(post(request([named])));
  assert.ok(!/[<>/]/.test(l2[0].name));
});

test('the token: its own header, checked; never the Authorization header', async () => {
  for (const token of [null, 'y'.repeat(48), TOKEN.slice(1)]) {
    const { res, logged } = await deliver(post(request([CREATE]), { token }));
    assert.equal(res.status, 401);
    assert.equal(logged.length, 0);
  }
  const bearer = await deliver(post(request([CREATE]), { token: null, headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.equal(bearer.res.status, 401);
  assert.ok(!/headers\.get\(\s*['"]authorization/i.test(readFileSync(new URL('../worker/otlp.js', import.meta.url), 'utf8')));
});

test('refusals: not protobuf, not POST, an unknown encoding, bad gzip, malformed, too large', async () => {
  assert.equal((await deliver(post(request([CREATE]), { type: 'application/json' }))).res.status, 415);
  assert.equal((await deliver(new Request(`https://x${OTLP_PATH}`, { headers: { [TOKEN_HEADER]: TOKEN } }))).res.status, 405);
  assert.equal((await deliver(post(request([CREATE]), { gzip: false, headers: { 'content-encoding': 'br' } }))).res.status, 415);
  assert.equal((await deliver(new Request(`https://x${OTLP_PATH}`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', [TOKEN_HEADER]: TOKEN }, body: Uint8Array.from([1, 2, 3]) }))).res.status, 400);
  const malformed = await deliver(post(Uint8Array.from([0x0a, 0x40, 0x01])));
  assert.equal(malformed.res.status, 400);
  assert.deepEqual(malformed.logged, [{ event: 'claude.otlp', v: 1, refused: 'malformed' }]);
  // Uncompressed past the inflated limit; and gzipped bytes past the sent limit, refused before inflating.
  const big = await deliver(post(new Uint8Array(MAX_INFLATED + 1), { gzip: false }));
  assert.equal(big.res.status, 413);
  assert.deepEqual(big.logged, [{ event: 'claude.otlp', v: 1, refused: 'too large' }]);
  const bigZipped = await deliver(new Request(`https://x${OTLP_PATH}`, { method: 'POST', headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', [TOKEN_HEADER]: TOKEN }, body: new Uint8Array(MAX_BODY + 1) }));
  assert.equal(bigZipped.res.status, 413);
  // A small gzip that inflates past the limit.
  const bomb = await deliver(post(new Uint8Array(17 * 1024 * 1024)));
  assert.equal(bomb.res.status, 413);
});

test('OTLP_WORKSPACE: only those workspaces reach a log, and the Console test span always does', async () => {
  const other = { ...CREATE, id: '34'.repeat(8), attrs: { ...CREATE.attrs, 'anthropic.workspace.id': 'wrkspc_scout' } };
  const testSpan = { name: 'anthropic.test', id: '56'.repeat(8), attrs: {} };
  const { logged } = await deliver(post(request([CREATE, other, testSpan])), { ...ON, OTLP_WORKSPACE: WS });
  assert.deepEqual(logged.map((l) => l.name ?? l.event), ['claude.otlp', 'anthropic.messages.create', 'anthropic.test'], 'the summary first');
  assert.equal(logged[0].other_workspace, 1);
  // A workspace given on the resource counts too.
  const onResource = await deliver(post(request([{ ...CREATE, attrs: { 'gen_ai.operation.name': 'chat' } }], { 'anthropic.workspace.id': WS })), { ...ON, OTLP_WORKSPACE: WS });
  assert.equal(onResource.logged.length, 1);
});

test(`span lines stop at ${LOG_BUDGET} bytes (Cloudflare keeps 256 KB a request); the summary leads and counts the rest`, async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ ...CREATE, id: i.toString(16).padStart(16, '0') }));
  const { res, logged } = await deliver(post(request(many)));
  assert.equal(res.status, 200);
  assert.equal(logged[0].event, 'claude.otlp');
  const spanLines = logged.filter((l) => l.event === 'claude.span');
  const size = spanLines.reduce((n, l) => n + JSON.stringify(l).length, 0);
  assert.ok(size <= LOG_BUDGET, `${size} bytes`);
  assert.ok(spanLines.length > 100 && spanLines.length < 600);
  assert.equal(logged[0].logged, spanLines.length);
  assert.equal(logged[0].not_logged, 600 - spanLines.length);
  assert.ok(JSON.stringify(logged).length < 256 * 1024);
});

test(`at most ${MAX_SPANS} spans are built a delivery; empty spans by the million only count`, async () => {
  const empties = 2_000_000;
  // One ResourceSpans, one ScopeSpans, two million zero-length spans (field 2).
  const scopeBody = new Uint8Array(empties * 2);
  for (let i = 0; i < empties; i++) scopeBody[2 * i] = 0x12;
  const wrap = (no, inner) => Uint8Array.from([...tag(no, 2), ...varint(inner.length), ...inner]);
  const body = wrap(1, wrap(2, scopeBody));
  const spans = decodeTraces(body);
  assert.equal(spans.length, MAX_SPANS);
  assert.equal(spans.extra, empties - MAX_SPANS);
  const { res, logged } = await deliver(post(body));
  assert.equal(res.status, 200);
  assert.equal(logged[0].spans, empties);
  assert.equal(logged[0].not_logged, empties - logged[0].logged);
});

test('keys named like built-in object methods are attributes like any other: dropped, never a crash', async () => {
  const odd = { ...CREATE, attrs: { toString: 'x', constructor: 'y', __proto__x: 'z', hasOwnProperty: 'w', valueOf: 1, 'gen_ai.request.model': 'claude-sonnet-5-5' } };
  const { res, logged } = await deliver(post(request([odd])));
  assert.equal(res.status, 200);
  assert.deepEqual(logged[0].attrs, { 'gen_ai.request.model': 'claude-sonnet-5-5' });
});

test("a span's name is an API method or a prefix and a tool name; anything else is a fixed marker", async () => {
  const names = ['anthropic.messages.create', 'anthropic.model_request', 'anthropic.tool_use web_search', 'anthropic.mcp_tool_use list_issues', 'anthropic.test'];
  const odd = ['anthropic.tool_use Jane Smith 810 Union St asked about rezoning', 'Jane Smith', 'anthropic.tool_use <script>', 'anthropic.custom_tool_use ' + 'x'.repeat(65), ''];
  const { logged } = await deliver(post(request([...names, ...odd].map((name, i) => ({ name, id: (i + 1).toString(16).padStart(16, '0'), attrs: {} })))));
  assert.deepEqual(logged.map((l) => l.name), [...names, ...odd.map(() => OTHER_NAME)]);
});

test('nothing else in a span reaches a line: status message, events, links, trace state, scope or resource attributes', async () => {
  const leaky = {
    ...CREATE, statusMessage: 'Jane Smith 810 Union St', traceState: 'jane=810union',
    events: [{ name: 'exception Jane Smith', attrs: { 'exception.message': '810 Union St' } }],
    links: [{ trace: '99'.repeat(16), span: '88'.repeat(8), state: 'jane=smith', attrs: { who: 'Jane Smith' } }],
  };
  const { logged } = await deliver(post(request([leaky], { 'service.name': 'claude-platform', 'host.name': 'Jane Smith', 'anthropic.organization.id': 'org-123' }, { owner: 'Jane Smith 810 Union St' })));
  const all = JSON.stringify(logged);
  for (const leak of ['Jane', 'Smith', '810', 'Union', 'org-123', '9999', '8888']) assert.ok(!all.includes(leak), leak);
  assert.deepEqual(Object.keys(logged[0]).sort(), ['attrs', 'event', 'kind', 'ms', 'name', 'parent', 'span', 'start', 'status', 'trace', 'v']);
});

test('sizes: Content-Length over the cap is refused before reading; uncompressed bodies get the inflated limit', async () => {
  const early = await deliver(post(request([CREATE]), { headers: { 'content-length': String(MAX_BODY + 1) } }));
  assert.equal(early.res.status, 413);
  assert.deepEqual(early.logged, [{ event: 'claude.otlp', v: 1, refused: 'too large' }]);
  // 5 MB of valid spans, sent uncompressed (as after a 4xx the API stops compressing for a day).
  const filler = 'x'.repeat(5000);
  const bigSpans = Array.from({ length: 1100 }, (_, i) => ({ ...CREATE, id: i.toString(16).padStart(16, '0'), attrs: { ...CREATE.attrs, 'service.note': filler } }));
  const body = request(bigSpans);
  assert.ok(body.length > MAX_BODY && body.length < MAX_INFLATED, String(body.length));
  const plain = await deliver(post(body, { gzip: false }));
  assert.equal(plain.res.status, 200);
});

test('Full content too large to decode: refused, and the refusal still says content arrived', async () => {
  const huge = 'y'.repeat(800 * 1024);
  const heavy = Array.from({ length: 22 }, (_, i) => ({ ...CONTENT, id: (i + 1).toString(16).padStart(16, '0'), attrs: { ...CONTENT.attrs, 'gen_ai.input.messages': huge } }));
  const body = request(heavy);
  assert.ok(body.length > MAX_INFLATED);
  for (const gzip of [true, false]) {
    const { res, logged } = await deliver(post(body, { gzip }));
    assert.equal(res.status, 413);
    assert.deepEqual(logged, [{ event: 'claude.otlp', v: 1, refused: 'too large', content_arrived: true }]);
  }
});

test("the free tier's answer carries the same trace to ask() and to its line", () => {
  const src = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  assert.match(src, /function publicAskDeps\(req, env, base\) \{\n  const \{ config: deployment \} = getDeployment\(env\);\n[^\n]*\n  const trace = newTrace\(env\);/);
  assert.match(src, /\.\.\.publicResearch\(cityId\), \.\.\.traceArgs\(trace\) \}\)\.then\(loggedAnswer\(env, 'public', cityId, trace\)\)/);
  assert.match(src, /const loggedAnswer = \(env, tier, cityId, trace = null, started = Date\.now\(\)\) => \(out\) => \{\n  logAnswer\(env, out, \{ [^}]*trace: trace\?\.id \}\);/);
});

test('a trace per answer: off without telemetry; a sampled W3C traceparent with it', () => {
  assert.equal(newTrace({}), null);
  assert.deepEqual(traceArgs(null), {});
  const t = newTrace({ TELEMETRY: 'true' });
  assert.match(t.id, /^[0-9a-f]{32}$/);
  assert.match(t.traceparent, TRACEPARENT_RE);
  assert.ok(t.traceparent.startsWith(`00-${t.id}-`));
  assert.notEqual(newTrace({ TELEMETRY: 'true' }).id, t.id);
  assert.deepEqual(traceArgs(t), { traceparent: t.traceparent });
  assert.equal(answerEvent({}, { trace: t.id }).trace, t.id);
  assert.equal('trace' in answerEvent({}, { trace: 'Jane Smith' }), false);
  assert.equal('trace' in answerEvent({}, {}), false);
});

test('the provider sends a valid traceparent and nothing else of the kind', async () => {
  const seen = [];
  const capture = async (url, init) => {
    seen.push(new Headers(init.headers));
    return new Response('{}');
  };
  const good = '00-' + 'a1'.repeat(16) + '-' + 'b2'.repeat(8) + '-01';
  await guardedFetch('k', capture, good)('https://api.anthropic.com/v1/messages', { headers: { tracestate: 'x=1', baggage: 'user.id=jane', traceparent: '00-' + 'f'.repeat(32) + '-' + 'e'.repeat(16) + '-01' } });
  assert.equal(seen[0].get('traceparent'), good);
  assert.equal(seen[0].get('tracestate'), null);
  assert.equal(seen[0].get('baggage'), null);
  for (const bad of [null, '', 'Jane', '00-' + '0'.repeat(32) + '-' + 'b2'.repeat(8) + '-01', '00-' + 'a1'.repeat(16) + '-' + 'b2'.repeat(8) + '-00', '01-' + 'a1'.repeat(16) + '-' + 'b2'.repeat(8) + '-01']) {
    await guardedFetch('k', capture, bad)('https://api.anthropic.com/v1/messages', { headers: { traceparent: good } });
    assert.equal(seen.at(-1).get('traceparent'), null, String(bad));
  }
});

test('through ask(): every model call of one answer carries its traceparent; without one, none does', async () => {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const msg = (content, stop_reason) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason, stop_sequence: null, stop_details: null, usage });
  const replies = [msg([{ type: 'tool_use', id: 'toolu_1', name: 'search_datasets', input: { query: 'trees' } }], 'tool_use'), msg([{ type: 'text', text: 'I found no tree datasets.' }], 'end_turn')];
  const run = async (traceparent) => {
    const headers = [];
    const fetchImpl = async (url, init = {}) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.startsWith('https://api.anthropic.com/')) {
        headers.push(new Headers(init.headers));
        return claudeResponse(init, replies[Math.min(headers.length - 1, 1)]);
      }
      return new Response(JSON.stringify({ results: [], resultSetSize: 0 }), { headers: { 'content-type': 'application/json' } });
    };
    await ask({ question: 'trees?', city: getCity('norfolk'), apiKey: 'k', model: 'claude-sonnet-5-5', fetchImpl, ...(traceparent ? { traceparent } : {}) });
    return headers.map((h) => h.get('traceparent'));
  };
  const t = newTrace({ TELEMETRY: 'true' });
  assert.deepEqual(await run(t.traceparent), [t.traceparent, t.traceparent]);
  assert.deepEqual(await run(null), [null, null]);
});

test('through the Worker: the answer line carries the trace id its model calls sent', { skip: noHooks }, async () => {
  const w = await loadWorker();
  const store = new Map();
  const kvStub = {
    async get(k, type) { return store.has(k) ? (type === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix }) { return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
  };
  const SECRET = 'test-secret-that-is-long-enough';
  const uid = await userId(SECRET, 'reader@example.org');
  await kvStub.put('invite:h1', JSON.stringify({ label: 'test' }));
  await kvStub.put(`member:${uid}`, JSON.stringify({ invite: 'h1' }));
  const cookie = `${userCookieName('')}=${await signUser(SECRET, uid)}`;
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const reply = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'I found no tree datasets.' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage };
  const run = async (env) => {
    const real = globalThis.fetch;
    const realLog = console.log;
    const sent = [];
    const lines = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.startsWith('https://api.anthropic.com/')) {
        sent.push(new Headers(init.headers).get('traceparent'));
        return claudeResponse(init, reply);
      }
      return new Response(JSON.stringify({ results: [], resultSetSize: 0 }), { headers: { 'content-type': 'application/json' } });
    };
    console.log = (line) => lines.push(line);
    try {
      const res = await w.fetch(new Request('https://x.org/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', Cookie: cookie }, body: JSON.stringify({ question: 'Any street tree data?', city: 'norfolk' }) }), env, { waitUntil() {} });
      assert.equal(res.status, 200);
      return { sent, answerLines: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l?.event === 'siren.answer') };
    } finally {
      globalThis.fetch = real;
      console.log = realLog;
    }
  };
  const base = { LIMITS: kvStub, MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'k', INVITE_REQUIRED: 'true', INVITE_SECRET: SECRET, IP_SALT: 'salt' };
  const on = await run({ ...base, TELEMETRY: 'true' });
  assert.equal(on.answerLines.length, 1);
  assert.match(on.answerLines[0].trace, /^[0-9a-f]{32}$/);
  assert.ok(on.sent.length >= 1);
  for (const tp of on.sent) assert.equal(tp.split('-')[1], on.answerLines[0].trace);
  const off = await run(base);
  assert.equal(off.answerLines.length, 0);
  assert.deepEqual(off.sent, off.sent.map(() => null), 'no traceparent with telemetry off');
});
