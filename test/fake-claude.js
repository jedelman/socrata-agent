// A fake Anthropic Messages API for tests: serves a message object the way
// the API streams it (server-sent events), so the provider's stream helper
// reads it exactly as it reads the real thing. Event shapes follow the API's
// raw SSE format (claude-api skill, typescript/streaming.md, "Raw SSE
// Format") and what the SDK accumulates (node_modules/@anthropic-ai/sdk/src/
// lib/BetaMessageStream.ts, #accumulateMessage).
//
//   claudeResponse(init, message, opts)  a Response for one /v1/messages call:
//       SSE when the request body asks for a stream, JSON otherwise.
//   sseEvents(message, opts)  the events, for tests that build their own.
//
// opts:
//   chunk      characters per delta (default 5), so a block arrives in pieces
//   errorAfter after this many events, an SSE `error` event (overloaded) and
//              the end of the stream, as the API does when it fails partway
//   dropAfter  after this many events, the stream just ends (a dropped
//              connection: no message_stop)

const split = (s, n) => {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
};

// What a block looks like when it opens, before its deltas fill it.
function opening(block) {
  if (block.type === 'text') return { type: 'text', text: '' };
  if (block.type === 'thinking') return { type: 'thinking', thinking: '', signature: '' };
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: {} };
  return block;
}

function deltas(block, chunk) {
  if (block.type === 'text') return split(block.text, chunk).map((text) => ({ type: 'text_delta', text }));
  if (block.type === 'thinking') {
    return [
      ...split(block.thinking, chunk).map((thinking) => ({ type: 'thinking_delta', thinking })),
      { type: 'signature_delta', signature: block.signature },
    ];
  }
  if (block.type === 'tool_use') {
    const json = block.partial_json ?? JSON.stringify(block.input ?? {});
    return split(json, chunk).map((partial_json) => ({ type: 'input_json_delta', partial_json }));
  }
  return [];
}

export function sseEvents(message, { chunk = 5 } = {}) {
  const { content = [], stop_reason, stop_details = null, usage = {}, ...rest } = message;
  const startUsage = {
    input_tokens: usage.input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    output_tokens: 1,
  };
  const events = [{ type: 'message_start', message: { ...rest, content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage: startUsage } }];
  content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: opening(block) });
    for (const delta of deltas(block, chunk)) events.push({ type: 'content_block_delta', index, delta });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason, stop_sequence: null, stop_details },
    usage: {
      output_tokens: usage.output_tokens ?? 0,
      input_tokens: usage.input_tokens ?? null,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? null,
      ...(usage.iterations ? { iterations: usage.iterations } : {}),
    },
  });
  events.push({ type: 'message_stop' });
  return events;
}

export function sseBody(events, { errorAfter, dropAfter } = {}) {
  let list = events;
  let tail = '';
  if (errorAfter != null) {
    list = events.slice(0, errorAfter);
    tail = `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`;
  } else if (dropAfter != null) {
    list = events.slice(0, dropAfter);
  }
  return list.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + tail;
}

export function claudeResponse(init, message, opts = {}) {
  let streaming = false;
  try {
    streaming = JSON.parse(init?.body || '{}').stream === true;
  } catch {}
  if (!streaming) {
    return new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  }
  return new Response(sseBody(sseEvents(message, opts), opts), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });
}
