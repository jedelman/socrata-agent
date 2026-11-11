// Claude through the Anthropic Messages API, with the official SDK.
//
// Used for any model whose id starts with "claude-" (OpenRouter's
// "anthropic/claude-..." ids still go through OpenRouter). The agent loop in
// src/agent.js stays the same; this module translates its tool definitions
// and messages to the Messages API shape and back:
//   - tools: { name, description, input_schema } instead of OpenAI functions
//   - the assistant's whole content (thinking and tool_use blocks included) is
//     sent back unchanged on the next turn, as the API requires
//   - every tool result goes back in one user message, as tool_result blocks
//   - the system prompt and tool list are a stable prefix, cached with
//     top-level cache_control
//   - every call is streamed (the SDK's stream helper, read to its final
//     message), so a caller can show the summarized thinking as it arrives
//   - with a deployment's `webSearch` on, Anthropic's web search server tool
//     is declared too (src/web-search.js): its server_tool_use and
//     web_search_tool_result blocks stay in the history exactly as the API
//     sent them, a paused turn (stop_reason "pause_turn") goes back as is
//     for the agent to resume, and the code execution container it may use
//     is sent back on later calls
// Spend is priced from the response's usage, per attempt, from the table
// below, plus each web search. A model with no price on file is refused
// rather than run at an unknown cost, so the Worker's daily budget can't be
// bypassed.

import Anthropic from '@anthropic-ai/sdk';
import { networkFetch } from '../request-budget.js';
import { WEB_SEARCH_USD, webSearchTool, searchesIn, searchesBilledIn, citationsIn } from '../web-search.js';

// USD per million tokens, Anthropic list prices as of 2026-10-06 (Claude API
// docs). cacheWrite is the 5-minute write rate. longOver: prompts with more
// input tokens than this use the `long` card (Claude Haiku 5.5 only).
// Claude Sonnet 5.5's cache hits are $0.10 / MTok, 0.05x its input price
// (https://platform.claude.com/docs/en/about-claude/pricing, read
// 2026-11-10); it was $0.20 here until then. Web searches are priced on top
// (WEB_SEARCH_USD, src/web-search.js), whatever the model.
export const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longOver: 100_000, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Possible server-side fallback targets for Sonnet 5.5 / Opus 5.5 refusals.
  // Cache rates unknown here, so priced at the full input rate (never under).
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 2, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 5, cacheWrite: 6.25 },
};
// Anything that ran but isn't in the table is priced at the most expensive rates above.
const CEILING = { input: 5, output: 25, cacheRead: 5, cacheWrite: 6.25 };

// Sonnet 5.5 and Opus 5.5 support server-side fallbacks on refusal; Haiku 5.5 does not.
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const isClaudeModel = (model) => /^claude-/.test(String(model || ''));
const API_BASE = 'https://api.anthropic.com';
/** Output allowance for Claude models when the caller sets none. Thinking counts toward it. */
export const CLAUDE_MAX_TOKENS = 8000;
// The SDK retries a failed call at most this often. Each attempt is a fetch,
// so it counts against the answer's request budget (src/request-budget.js).
// A streamed call is still one fetch: the SDK retries only before a response
// arrives (a refused connection, a 429, 5xx or timeout), never a stream that
// fails partway (node_modules/@anthropic-ai/sdk/src/client.ts, makeRequest;
// src/core/streaming.ts throws an SSE `error` event as an APIError).
const MAX_RETRIES = 1;
// The output allowance for a call cut off at max_tokens, asked once more.
const RETRY_MAX_TOKENS = 16000;
// The SDK's timeout covers the wait for response headers, not a streamed body
// that stalls. Past this, a call is aborted, priced from what it had streamed
// and fails honestly. 16,000 output tokens at a slow 60 a second is 4.5 minutes.
export const STREAM_DEADLINE_MS = 5 * 60_000;

// Only these request headers leave the Worker. The SDK also reads settings
// from the environment (ANTHROPIC_CUSTOM_HEADERS, for one) that could add
// headers or replace the Authorization header; this wrapper drops anything
// else, sets the key itself, and refuses any host but api.anthropic.com.
const SENT_HEADERS = new Set(['accept', 'content-type', 'user-agent', 'anthropic-version', 'anthropic-beta']);
// A W3C traceparent the caller chose (the Worker's per-answer trace id, with
// telemetry on): sampled, version 00, ids not all zeros. The API's
// OpenTelemetry spans for the call then carry its trace id. Anything else
// is never sent, and no other trace header (tracestate, baggage) ever is.
export const TRACEPARENT_RE = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-01$/;
export function guardedFetch(apiKey, fetchImpl, traceparent = null) {
  const trace = typeof traceparent === 'string' && TRACEPARENT_RE.test(traceparent) ? traceparent : null;
  return async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!u.startsWith(`${API_BASE}/`)) throw new Error('Refusing to send the Anthropic key anywhere but api.anthropic.com.');
    const headers = new Headers();
    for (const [k, v] of new Headers(init.headers)) if (SENT_HEADERS.has(k) || k.startsWith('x-stainless-')) headers.set(k, v);
    if (trace) headers.set('traceparent', trace);
    headers.set('authorization', `Bearer ${apiKey}`);
    return (fetchImpl || networkFetch)(u, { ...init, headers });
  };
}

function priceTokens(u, model) {
  const card = PRICES[model] || CEILING;
  const promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const rates = card.longOver && promptTokens > card.longOver ? card.long : card;
  return (
    ((u.input_tokens || 0) * rates.input +
      (u.output_tokens || 0) * rates.output +
      (u.cache_read_input_tokens || 0) * rates.cacheRead +
      (u.cache_creation_input_tokens || 0) * rates.cacheWrite) /
    1e6
  );
}

/**
 * Web searches billed in a response's usage (usage.server_tool_use
 * .web_search_requests). With fallbacks, top-level usage covers only the
 * attempt that answered and `usage.iterations` lists every attempt; whether
 * each attempt carries its own server_tool_use isn't documented, so this
 * takes the larger of the two counts, which never counts a search twice.
 */
export function billedSearches(usage) {
  if (!usage) return 0;
  const n = (u) => Math.max(0, Number(u?.server_tool_use?.web_search_requests) || 0);
  const perAttempt = Array.isArray(usage.iterations) ? usage.iterations.reduce((sum, it) => sum + n(it), 0) : 0;
  return Math.max(n(usage), perAttempt);
}

/** USD for one response: tokens, per attempt with fallbacks (`usage.iterations`), and web searches. */
export function priceUsage(usage, model) {
  if (!usage) return 0;
  const tokens = Array.isArray(usage.iterations) && usage.iterations.length
    ? usage.iterations.reduce((sum, it) => sum + priceTokens(it, it.model || model), 0)
    : priceTokens(usage, model);
  const searches = billedSearches(usage);
  return searches ? tokens + searches * WEB_SEARCH_USD : tokens;
}

/**
 * Usage with at least as many web searches as the response's blocks show
 * returned (each one billed), so a usage report that leaves some out can't
 * price a search at nothing. Unchanged when the blocks show no more.
 */
export function withSearchFloor(usage, content) {
  const seen = searchesBilledIn(content);
  if (!usage || seen <= billedSearches(usage)) return usage;
  return { ...usage, server_tool_use: { ...(usage.server_tool_use || {}), web_search_requests: seen } };
}

/** OpenAI-style function tools (from src/tools.js) as Messages API tools. */
export function toAnthropicTools(tools = []) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

const isServerToolResult = (b) => typeof b?.type === 'string' && b.type !== 'tool_result' && b.type.endsWith('_tool_result') && typeof b.tool_use_id === 'string';

/**
 * The server-tool calls in `blocks` that are complete: a server_tool_use
 * with its result block (web_search_tool_result, code_execution_tool_result
 * and the like, paired by tool_use_id). A call made from code (its `caller`
 * names a code execution call) counts only while that call is complete too.
 */
function pairedServerTools(blocks) {
  const uses = new Map(blocks.filter((b) => b.type === 'server_tool_use').map((b) => [b.id, b]));
  const results = new Set(blocks.filter(isServerToolResult).map((b) => b.tool_use_id));
  const paired = new Set([...uses.keys()].filter((id) => results.has(id)));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of paired) {
      const by = uses.get(id).caller?.tool_id;
      if (by && !paired.has(by)) {
        paired.delete(id);
        changed = true;
      }
    }
  }
  return paired;
}

/** Whether `blocks` hold a server tool call with no result: one the API runs at the start of the next request. */
function unpairedServerTool(blocks) {
  const done = new Set(blocks.filter(isServerToolResult).map((b) => b.tool_use_id));
  return blocks.some((b) => b.type === 'server_tool_use' && !done.has(b.id));
}

/**
 * With server-side fallbacks, a stream keeps what a declining model wrote
 * before the switch, then a `fallback` block, then the fallback model's turn
 * (a non-streaming response leaves that partial out). The API's rule for
 * echoing such a turn: before the last `fallback` block, send back text
 * blocks (the fallback model continued from them), paired server-tool
 * blocks (a server_tool_use with its result) and the `fallback` blocks where
 * they are; thinking, tool_use, a server_tool_use without its result and
 * anything else from the declined partial is omitted
 * (shared/model-migration.md, "Echoing fallback turns back"; read again
 * 2026-11-10). A tool_use from before the switch is never run.
 */
export function afterFallback(content) {
  const cut = content.findLastIndex((b) => b.type === 'fallback');
  if (cut < 0) return content;
  const paired = pairedServerTools(content.slice(0, cut));
  const keep = (b) => b.type === 'text' || b.type === 'fallback' || (b.type === 'server_tool_use' ? paired.has(b.id) : isServerToolResult(b) && paired.has(b.tool_use_id));
  return content.filter((b, i) => i >= cut || keep(b));
}

/**
 * Usage for a call that failed partway: what message_start reported (the
 * input), with output estimated from what had streamed, one token per three
 * characters, since the API reports output only at the end. The summary of
 * thinking is shorter than the thinking billed, so this can still be under.
 */
export function partialUsage(message) {
  if (!message?.usage) return null;
  let chars = 0;
  for (const b of message.content || []) {
    if (b.type === 'text') chars += (b.text || '').length;
    else if (b.type === 'thinking') chars += (b.thinking || '').length;
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') chars += JSON.stringify(b.input ?? {}).length;
  }
  // Web searches that returned before the failure were billed too.
  return withSearchFloor({ ...message.usage, output_tokens: Math.max(message.usage.output_tokens || 0, Math.ceil(chars / 3)) }, message.content);
}

/**
 * A provider for src/agent.js. Holds the conversation in Messages API shape.
 * `complete()` returns { text, calls: [{ id, name, args }], cost, refusal,
 * searches, citations }, with `paused: true` when the API paused the turn
 * (pause_turn: append the assistant turn and call again, with no new user
 * message). A resumed response's `text` and `citations` are the whole
 * turn's, the paused parts first. A call that resumes server-side work (a
 * paused turn, or a server tool left to run) never sends tool_choice none,
 * so past the agent's cap it can still return `calls`, which the agent
 * doesn't run. `searches` are the web searches the response's blocks show ran
 * (src/web-search.js searchesIn; from every attempt complete() made, a
 * cut-off one included); `citations` the web citations on the text kept.
 * `webSearch` (checked settings from src/web-search.js) declares the web
 * search tool; without it, requests are exactly as they were before it.
 * `onThinking(text)`, when given, gets each summarized-thinking delta as it
 * streams, and asks the API for display "summarized" (display changes what
 * comes back, not what is billed). It sees thinking only: never the answer,
 * the trace or the conversation, and the thinking blocks still go back to the
 * API unchanged with the rest of the turn. `onFallback()`, with onThinking, is
 * called when a server-side fallback starts mid-stream after thinking was
 * forwarded: the declining model's notes are to be withdrawn.
 * `streamDeadlineMs` bounds each call (default STREAM_DEADLINE_MS).
 */
export function anthropicProvider({ apiKey, model, maxTokens, effort, fetchImpl, onThinking, onFallback, webSearch, traceparent = null, streamDeadlineMs = STREAM_DEADLINE_MS }) {
  if (!PRICES[model]) throw new Error(`No price on file for ${model}. Add it to PRICES in src/providers/anthropic.js before using it.`);
  // The base URL is pinned: without it the SDK reads ANTHROPIC_BASE_URL from
  // the environment, and inside a Claude Code session (or behind someone
  // else's proxy) that would send this key somewhere other than Anthropic.
  // One retry at most: a retried attempt that the API billed would not show
  // up in usage. Streaming calls get the SDK's default timeout (10 minutes).
  const client = new Anthropic({ apiKey, baseURL: API_BASE, maxRetries: MAX_RETRIES, fetch: guardedFetch(apiKey, fetchImpl, traceparent) });
  // Thinking tokens count toward max_tokens on these models; the caller sets
  // the allowance (the Worker's MAX_TOKENS_CLAUDE), default CLAUDE_MAX_TOKENS.
  const max_tokens = Number(maxTokens) > 0 ? Number(maxTokens) : CLAUDE_MAX_TOKENS;
  let system = '';
  let tools = [];
  const messages = [];
  let last = null;
  // Web search only: the code execution container a response named (dynamic
  // filtering runs there), sent back so a resumed turn keeps it, and the
  // searches whose result waits on a client tool (paired in a later response).
  let container = null;
  const pendingSearches = new Map();

  return {
    name: 'anthropic',
    // Fetches one API call can take: the attempt and the SDK's retry.
    fetchesPerCall: 1 + MAX_RETRIES,
    // Fetches one complete() can take at worst: a call cut off at max_tokens
    // is asked once more with more room, and each of the two can be retried.
    fetchesPerComplete: (1 + MAX_RETRIES) * (max_tokens < RETRY_MAX_TOKENS ? 2 : 1),
    init({ systemPrompt, history, question, toolDefs }) {
      system = systemPrompt;
      tools = toAnthropicTools(toolDefs);
      if (webSearch) tools.push(webSearchTool(webSearch));
      // The API rejects empty turns, so skip any (a client may send one back).
      for (const m of history) if (String(m.content ?? '').trim()) messages.push({ role: m.role, content: String(m.content) });
      messages.push({ role: 'user', content: question });
    },

    // `retryTruncated: false` makes one API call (fetchesPerCall) and returns
    // a cut-off response as it is, marked truncated.
    async complete({ allowTools = true, retryTruncated = true } = {}) {
      let out = await call(allowTools, max_tokens);
      // A response cut off at max_tokens may end in a half-written tool call:
      // never run it. Retry once with more room, then give up honestly.
      if (retryTruncated && out.truncated && max_tokens < RETRY_MAX_TOKENS) {
        let retry;
        try {
          retry = await call(allowTools, RETRY_MAX_TOKENS);
        } catch (err) {
          // The cut-off attempt was paid for too: it goes up with the error.
          err.cost = (Number(err.cost) || 0) + out.cost;
          throw err;
        }
        retry.cost += out.cost;
        // The cut-off attempt's searches ran (and were billed) too.
        retry.searches = [...out.searches, ...retry.searches];
        out = retry;
      }
      return out;
    },

    appendAssistant() {
      if (last) messages.push(last);
    },

    appendToolResults(results, note) {
      const content = results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) }));
      if (note && content.length && unpairedServerTool(assistantTurn(messages.length - 1))) {
        // The turn holds a server tool the API has yet to run (with dynamic
        // filtering, code execution called alongside a client tool): the
        // follow-up "must contain nothing except tool_result blocks" (server
        // tools docs, "Mixing server tools and client tools"; a text block is
        // a 400), so the note goes inside the last result.
        const r = content.at(-1);
        r.content = [...(r.content ? [{ type: 'text', text: String(r.content) }] : []), { type: 'text', text: note }];
      } else if (note) content.push({ type: 'text', text: note });
      messages.push({ role: 'user', content });
    },

    appendUser(text) {
      messages.push({ role: 'user', content: text });
    },
  };

  // The blocks of the assistant turn that ends at messages[end]: consecutive
  // assistant messages are one turn, resumed after pause_turn.
  function assistantTurn(end) {
    const blocks = [];
    for (let i = end; i >= 0 && messages[i].role === 'assistant'; i--) {
      if (Array.isArray(messages[i].content)) blocks.unshift(...messages[i].content);
    }
    return blocks;
  }

  async function call(allowTools, maxTokensNow) {
    // A paused turn resumed (the conversation ends with it), or a server tool
    // the API runs at the start of this request (the turn before the tool
    // results left one without its result). Both happen only with server
    // tools. The turn so far is what a resumed response continues.
    const paused = messages.at(-1)?.role === 'assistant';
    const resumedTurn = paused ? assistantTurn(messages.length - 1) : [];
    const resumes = paused || unpairedServerTool(assistantTurn(messages.length - 2));
    const params = {
      model,
      max_tokens: maxTokensNow,
      // An explicit breakpoint on the stable prefix (tools, then system), and
      // automatic caching for the growing conversation after it.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
      cache_control: { type: 'ephemeral' },
      ...(tools.length ? { tools } : {}),
      // Tools stay declared (history may contain tool_use blocks); "none"
      // makes the model answer in text. A call that resumes server-side work
      // never sends it: the docs don't say how it meets a pending server
      // tool. If such a call asks for a client tool when tools aren't
      // allowed, the calls go back and the agent ends the answer without
      // running them, as at its step cap.
      ...(tools.length && !allowTools && !resumes ? { tool_choice: { type: 'none' } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      // Adaptive is these models' default; asking for the summary is what
      // makes the thinking readable (its display is otherwise "omitted").
      ...(onThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(container ? { container } : {}),
    };
    const stream = FALLBACK_MODELS.has(model)
      ? client.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
      : client.messages.stream(params);
    if (onThinking) {
      // Listeners that throw would end the stream; the notes are never worth that.
      let forwarded = false;
      stream.on('thinking', (delta) => {
        try {
          if (!delta) return;
          forwarded = true;
          onThinking(delta);
        } catch {}
      });
      // A `fallback` block mid-stream: the model that wrote the notes so far
      // declined. (One that opens the message carries no notes before it.)
      if (onFallback) {
        stream.on('streamEvent', (event) => {
          try {
            if (event.type === 'content_block_start' && event.content_block?.type === 'fallback' && forwarded) {
              forwarded = false;
              onFallback();
            }
          } catch {}
        });
      }
    }
    let stalled = false;
    const deadline = setTimeout(() => {
      stalled = true;
      stream.abort();
    }, streamDeadlineMs);
    let res;
    try {
      res = await stream.finalMessage();
    } catch (err) {
      // Report status and message only; never the request (it carries the key).
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      const why = stalled ? `the response did not finish within ${Math.round(streamDeadlineMs / 1000)} s and was stopped` : String(err?.message || err).slice(0, 300);
      const failed = new Error(`Anthropic ${status ?? 'error'}: ${why}`);
      // A stream that failed or stalled partway: priced from what it had
      // streamed (partialUsage), so a failed call still counts toward the
      // daily budget. Nothing is retried here.
      failed.cost = priceUsage(partialUsage(stream.currentMessage), model);
      throw failed;
    } finally {
      clearTimeout(deadline);
    }
    const cost = priceUsage(withSearchFloor(res.usage, res.content), model);
    if (webSearch && typeof res.container?.id === 'string') container = res.container.id;
    // Every search the blocks show ran on Anthropic's side, whatever happens
    // to the content below; the agent traces them (withheld on a refusal).
    const searches = searchesIn(res.content, pendingSearches);
    // A refusal can come mid-stream, after partial output: discard all of it.
    if (res.stop_reason === 'refusal') {
      last = null;
      return { text: '', calls: [], cost, refusal: res.stop_details?.category ?? 'unspecified', searches, citations: [] };
    }
    if (res.stop_reason === 'max_tokens') {
      last = null;
      return { text: '', calls: [], cost, refusal: null, truncated: true, searches, citations: [] };
    }
    const content = afterFallback(res.content);
    last = { role: 'assistant', content };
    // A resumed response holds only what came after the pause: the text and
    // citations are the whole turn's, the paused parts first, in order, read
    // as one unpaused response would be.
    const turn = resumedTurn.length ? [...resumedTurn, ...content] : content;
    const text = turn.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const citations = citationsIn(turn);
    // The API paused its server-side loop mid-turn: the turn goes back as is
    // and is resumed by calling again, with no new user message (server
    // tools docs, "The server-side loop and pause_turn", read 2026-11-10).
    if (res.stop_reason === 'pause_turn') return { text, calls: [], cost, refusal: null, paused: true, searches, citations };
    // Run tools only when the model stopped to call them. A call that
    // resumed server-side work could ask for them past the agent's cap (it
    // went without tool_choice none): they go back, and the agent doesn't run them.
    const calls = (allowTools || resumes) && res.stop_reason === 'tool_use'
      ? content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }))
      : [];
    return { text, calls, cost, refusal: null, searches, citations };
  }
}
