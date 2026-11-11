// OpenTelemetry from the Claude API: the spans Anthropic exports for the API
// workspace Siren runs in, written to Workers Logs beside Siren's own answer
// lines (telemetry.js). Jason, 2026-11-11: "the Siren workspace refers to the
// Claude API we're running her on. It can export opentelemetry traces".
//
// Cloudflare takes no OTLP in (its OpenTelemetry is export only, and never
// the protobuf encoding), so this route is the collector: the Console's
// destination posts OTLP/HTTP protobuf, usually gzipped, to
// `<origin>/otlp/v1/traces` with the header `x-otlp-token: <OTLP_TOKEN>`
// (docs/telemetry.md). Its own header, not Authorization: no Worker route
// reads an Authorization header (the Bluesky sign-in promise,
// test/requests-page.test.js). Spans arrive at least once and best effort; a line
// carries its trace and span ids, so duplicates can be told apart.
//
// What reaches a log: each span's name, kind, ids, start, duration and
// status, and only the attributes in KEEP (model, tokens, stop reason,
// service tier, error type, tool name, request id, timing). Never a prompt,
// a response, a tool's input or result, an organization, workspace or user
// id, or a URL. The destination is to be "Metadata only"; if it is ever set
// to "Full content", the content still never reaches a log, and the
// delivery's summary line says content arrived so the steward can switch it
// back.
//
// With TELEMETRY off, or OTLP_TOKEN unset (or shorter than 32 characters),
// the route doesn't exist: the path answers as every unknown path does.
//
// Cloudflare keeps at most 256 KB of log data per request and drops the rest
// (developers.cloudflare.com/workers/platform/limits/#log-size, read
// 2026-11-11), so a delivery's summary line, when it has one, goes first, and
// span lines stop at LOG_BUDGET bytes.

import { telemetryOn } from './telemetry.js';

export const OTLP_PATH = '/otlp/v1/traces';
export const TOKEN_HEADER = 'x-otlp-token';
export const MIN_TOKEN = 32;
// As sent: 4 MB gzipped; an uncompressed delivery (the API stops compressing
// for about a day after a 400, 406, 415 or 422) up to the inflated limit.
export const MAX_BODY = 4 * 1024 * 1024;
export const MAX_INFLATED = 16 * 1024 * 1024;
// Bytes of span lines a delivery may log, under Cloudflare's 256 KB.
export const LOG_BUDGET = 200 * 1024;
// Spans decoded a delivery; any beyond are counted, never built.
export const MAX_SPANS = 1000;

export const otlpOn = (env) => telemetryOn(env) && typeof env?.OTLP_TOKEN === 'string' && env.OTLP_TOKEN.length >= MIN_TOKEN;

// The attributes a line may carry, each with the shape its value must have.
const NUM = 'number';
const KEEP = {
  'gen_ai.operation.name': /^[a-z_]{1,40}$/,
  'gen_ai.request.model': /^[a-z0-9.-]{1,80}$/,
  'gen_ai.response.model': /^[a-z0-9.-]{1,80}$/,
  'gen_ai.usage.input_tokens': NUM,
  'gen_ai.usage.output_tokens': NUM,
  'gen_ai.usage.cache_write.input_tokens': NUM,
  'gen_ai.usage.cache_read.input_tokens': NUM,
  'gen_ai.usage.reasoning.output_tokens': NUM,
  'anthropic.usage.cache_creation.ephemeral_5m_input_tokens': NUM,
  'anthropic.usage.cache_creation.ephemeral_1h_input_tokens': NUM,
  'anthropic.usage.compaction.input_tokens': NUM,
  'anthropic.usage.compaction.output_tokens': NUM,
  'anthropic.message.stop_reason': /^[a-z_]{1,40}$/,
  'anthropic.response.service_tier': /^[a-z_]{1,40}$/,
  'anthropic.request.service_tier': /^[a-z_]{1,40}$/,
  'anthropic.thinking.type': /^[a-z_]{1,40}$/,
  'gen_ai.request.reasoning.level': /^[a-z_]{1,40}$/,
  'gen_ai.request.max_tokens': NUM,
  'gen_ai.request.stream': 'boolean',
  'gen_ai.response.time_to_first_chunk': NUM,
  'error.type': /^[a-z_]{1,60}$/,
  'gen_ai.tool.name': /^[A-Za-z0-9_.-]{1,64}$/,
  'anthropic.request.id': /^req_[A-Za-z0-9]{1,64}$/,
  'http.response.status_code': NUM,
};
// Attributes that hold content (the span reference's "Content" badge). Their
// values are never read; their keys only mark the delivery as carrying it.
// (Read 2026-11-11 at platform.claude.com/docs/en/api/opentelemetry/spans.)
const CONTENT = new Set([
  'gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.request.stop_sequences',
  'gen_ai.tool.call.arguments', 'anthropic.tool_result.content', 'anthropic.session.outcome_evaluation.explanation',
  'anthropic.content.truncated',
]);
// The bytes of those keys, to tell a delivery refused as too large that it
// carried content.
const CONTENT_MARKERS = ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions', 'anthropic.tool_result.content'];
const WORKSPACE = 'anthropic.workspace.id';
const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
const STATUS = ['unset', 'ok', 'error'];

// ---------------------------------------------------------------------------
// Protobuf, as far as OTLP traces need it (opentelemetry-proto v1).

class Malformed extends Error {}

function varint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Malformed('truncated varint');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
  throw new Malformed('varint too long');
}

/** The fields of one message, one at a time: { no, wire, value }, value a BigInt or a byte view. */
function* fields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = varint(buf, pos);
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (no < 1) throw new Malformed('field number 0');
    if (wire === 0) {
      let v;
      [v, pos] = varint(buf, pos);
      yield { no, wire, value: v };
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (pos + n > buf.length) throw new Malformed('truncated fixed field');
      const value = buf.subarray(pos, pos + n);
      pos += n;
      yield { no, wire, value };
    } else if (wire === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      const end = pos + Number(len);
      if (len > BigInt(buf.length) || end > buf.length) throw new Malformed('truncated length-delimited field');
      const value = buf.subarray(pos, end);
      pos = end;
      yield { no, wire, value };
    } else {
      throw new Malformed(`wire type ${wire}`);
    }
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
const text = (bytes) => utf8.decode(bytes);
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fixed64 = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
const double = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
const signed = (v) => BigInt.asIntN(64, v);

/** An AnyValue's scalar (string, bool, int, double); arrays, maps and bytes come back undefined. */
function scalar(buf) {
  let value;
  for (const f of fields(buf)) {
    if (f.no === 1 && f.wire === 2) value = text(f.value);
    else if (f.no === 2 && f.wire === 0) value = f.value !== 0n;
    else if (f.no === 3 && f.wire === 0) value = Number(signed(f.value));
    else if (f.no === 4 && f.wire === 1) value = double(f.value);
  }
  return value;
}

/** Reads a KeyValue's key, and its value only when `wanted(key)` says so. */
function keyValue(buf, wanted) {
  let key = '';
  let raw = null;
  for (const f of fields(buf)) {
    if (f.no === 1 && f.wire === 2) key = text(f.value);
    else if (f.no === 2 && f.wire === 2) raw = f.value;
  }
  return { key, value: raw && wanted(key) ? scalar(raw) : undefined };
}

const wantedKey = (key) => Object.hasOwn(KEEP, key) || key === WORKSPACE;

function span(buf) {
  const s = { attrs: {}, content: false, workspace: null };
  for (const f of fields(buf)) {
    if (f.no === 1 && f.wire === 2) s.trace = hex(f.value);
    else if (f.no === 2 && f.wire === 2) s.span = hex(f.value);
    else if (f.no === 4 && f.wire === 2) s.parent = f.value.length ? hex(f.value) : null;
    else if (f.no === 5 && f.wire === 2) s.name = text(f.value);
    else if (f.no === 6 && f.wire === 0) s.kind = Number(f.value);
    else if (f.no === 7 && f.wire === 1) s.start = fixed64(f.value);
    else if (f.no === 8 && f.wire === 1) s.end = fixed64(f.value);
    else if (f.no === 9 && f.wire === 2) {
      const { key, value } = keyValue(f.value, wantedKey);
      if (CONTENT.has(key)) s.content = true;
      else if (key === WORKSPACE) s.workspace = typeof value === 'string' ? value : null;
      else if (value !== undefined) s.attrs[key] = value;
    } else if (f.no === 15 && f.wire === 2) {
      for (const g of fields(f.value)) if (g.no === 3 && g.wire === 0) s.status = Number(g.value);
    }
  }
  return s;
}

/**
 * The spans in an ExportTraceServiceRequest, each with its resource's
 * workspace id: at most `max` built; any beyond are only counted (`extra`).
 */
export function decodeTraces(buf, max = MAX_SPANS) {
  const spans = [];
  let extra = 0;
  for (const rs of fields(buf)) {
    if (rs.no !== 1 || rs.wire !== 2) continue;
    let workspace = null;
    const inner = [];
    for (const f of fields(rs.value)) {
      if (f.no === 1 && f.wire === 2) {
        for (const r of fields(f.value)) {
          if (r.no !== 1 || r.wire !== 2) continue;
          const { key, value } = keyValue(r.value, (k) => k === WORKSPACE);
          if (key === WORKSPACE && typeof value === 'string') workspace = value;
        }
      } else if (f.no === 2 && f.wire === 2) {
        for (const ss of fields(f.value)) {
          if (ss.no !== 2 || ss.wire !== 2) continue;
          if (spans.length + inner.length < max) inner.push(span(ss.value));
          else extra += 1;
        }
      }
    }
    for (const s of inner) spans.push({ ...s, workspace: s.workspace || workspace });
  }
  spans.extra = extra;
  return spans;
}

// ---------------------------------------------------------------------------
// A span's line.

// A span's name is the API method or a fixed prefix and a tool name
// ("anthropic.messages.create", "anthropic.tool_use web_search"); anything
// else is logged as a fixed marker, never as its text.
const NAME_RE = /^anthropic\.[a-z_.]{1,60}( [A-Za-z0-9_.-]{1,64})?$/;
export const OTHER_NAME = '[unrecognized]';
const cleanName = (name) => (typeof name === 'string' && NAME_RE.test(name) ? name : OTHER_NAME);

export function spanEvent(s) {
  const attrs = {};
  for (const [key, value] of Object.entries(s.attrs)) {
    if (!Object.hasOwn(KEEP, key)) continue;
    const shape = KEEP[key];
    if (shape === NUM ? Number.isFinite(value) : shape === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && shape.test(value)) attrs[key] = value;
  }
  const ok = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  const startMs = typeof s.start === 'bigint' ? Number(s.start / 1000000n) : null;
  const ms = typeof s.start === 'bigint' && typeof s.end === 'bigint' && s.end >= s.start ? Number((s.end - s.start) / 1000n) / 1000 : null;
  return {
    event: 'claude.span',
    v: 1,
    name: cleanName(s.name),
    kind: KINDS[s.kind] || 'unspecified',
    trace: ok(s.trace, 32) ? s.trace : null,
    span: ok(s.span, 16) ? s.span : null,
    parent: ok(s.parent, 16) ? s.parent : null,
    start: startMs !== null && Number.isFinite(startMs) && startMs > 0 ? new Date(startMs).toISOString() : null,
    ms,
    status: STATUS[s.status] || 'unset',
    attrs,
  };
}

// ---------------------------------------------------------------------------
// The route.

async function sameToken(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(given)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const concat = (chunks, size) => {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

/** A stream's bytes up to `cap`: { bytes, over }, with what was read so far when it ran over. */
async function readCapped(stream, cap) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - size));
      size = cap;
      await reader.cancel().catch(() => {});
      return { bytes: concat(chunks, size), over: true };
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { bytes: concat(chunks, size), over: false };
}

// Whether bytes hold a content attribute's key (a delivery too large to decode).
const latin1 = new TextDecoder('latin1');
const carriesContent = (bytes) => {
  const t = latin1.decode(bytes);
  return CONTENT_MARKERS.some((m) => t.includes(m));
};

const plain = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const workspaces = (env) => new Set(String(env.OTLP_WORKSPACE || '').split(',').map((w) => w.trim()).filter(Boolean));

/** POST /otlp/v1/traces, with otlpOn(env). */
export async function handleOtlp(req, env, log = console.log) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const given = req.headers.get(TOKEN_HEADER) || '';
  if (!given || !(await sameToken(given, env.OTLP_TOKEN))) return plain(401, 'unauthorized');
  if (!/^application\/x-protobuf\b/i.test(req.headers.get('content-type') || '')) return plain(415, 'send application/x-protobuf');
  const encoding = (req.headers.get('content-encoding') || 'identity').toLowerCase();
  if (encoding !== 'gzip' && encoding !== 'identity') return plain(415, 'gzip or no encoding');
  if (!req.body) return plain(400, 'empty');
  // A refusal for size says whether what was read carried content, since
  // Full content is the likely reason a delivery is that large.
  const tooLarge = (bytes) => {
    log(JSON.stringify({ event: 'claude.otlp', v: 1, refused: 'too large', ...(bytes && carriesContent(bytes) ? { content_arrived: true } : {}) }));
    return plain(413, 'too large');
  };
  const sentCap = encoding === 'gzip' ? MAX_BODY : MAX_INFLATED;
  if (Number(req.headers.get('content-length') || 0) > sentCap) return tooLarge(null);
  const raw = await readCapped(req.body, sentCap);
  let body = raw;
  if (encoding === 'gzip' && !raw.over) {
    try {
      body = await readCapped(new Response(raw.bytes).body.pipeThrough(new DecompressionStream('gzip')), MAX_INFLATED);
    } catch {
      return plain(400, 'bad gzip');
    }
  }
  if (body.over) return tooLarge(encoding === 'gzip' && raw.over ? null : body.bytes);
  let spans;
  try {
    spans = decodeTraces(body.bytes);
  } catch (err) {
    if (!(err instanceof Malformed)) throw err;
    log(JSON.stringify({ event: 'claude.otlp', v: 1, refused: 'malformed' }));
    return plain(400, 'malformed');
  }
  // With OTLP_WORKSPACE set, only those workspaces' spans (and the Console's
  // test span, which belongs to none) reach a log. Lines are built first, so
  // the summary can lead: Cloudflare drops what comes after 256 KB.
  const only = workspaces(env);
  const lines = [];
  let bytes = 0;
  let otherWorkspace = 0;
  let overBudget = 0;
  let content = false;
  for (const s of spans) {
    content ||= s.content;
    if (only.size && s.name !== 'anthropic.test' && !only.has(s.workspace)) {
      otherWorkspace += 1;
      continue;
    }
    const line = JSON.stringify(spanEvent(s));
    if (bytes + line.length > LOG_BUDGET) {
      overBudget += 1;
      continue;
    }
    lines.push(line);
    bytes += line.length;
  }
  const notLogged = overBudget + spans.extra;
  if (content || otherWorkspace || notLogged) {
    log(JSON.stringify({ event: 'claude.otlp', v: 1, spans: spans.length + spans.extra, logged: lines.length, ...(otherWorkspace ? { other_workspace: otherWorkspace } : {}), ...(notLogged ? { not_logged: notLogged } : {}), ...(content ? { content_arrived: true } : {}) }));
  }
  for (const line of lines) log(line);
  // An empty ExportTraceServiceResponse.
  return new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'no-store' } });
}
