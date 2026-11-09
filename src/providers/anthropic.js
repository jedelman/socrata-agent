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
// Spend is priced from the response's usage, per attempt, from the table
// below. A model with no price on file is refused rather than run at an
// unknown cost, so the Worker's daily budget can't be bypassed.

import Anthropic from '@anthropic-ai/sdk';
import { networkFetch } from '../request-budget.js';

// USD per million tokens, Anthropic list prices as of 2026-10-06 (Claude API
// docs). cacheWrite is the 5-minute write rate. longOver: prompts with more
// input tokens than this use the `long` card (Claude Haiku 5.5 only).
export const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longOver: 100_000, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
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
export function guardedFetch(apiKey, fetchImpl) {
  return async (url, init = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (!u.startsWith(`${API_BASE}/`)) throw new Error('Refusing to send the Anthropic key anywhere but api.anthropic.com.');
    const headers = new Headers();
    for (const [k, v] of new Headers(init.headers)) if (SENT_HEADERS.has(k) || k.startsWith('x-stainless-')) headers.set(k, v);
    headers.set('authorization', `Bearer ${apiKey}`);
    return (fetchImpl || networkFetch)(u, { ...init, headers });
  };
}

function priceOne(u, model) {
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

/** USD for one response. With fallbacks, `usage.iterations` lists every attempt. */
export function priceUsage(usage, model) {
  if (!usage) return 0;
  if (Array.isArray(usage.iterations) && usage.iterations.length) {
    return usage.iterations.reduce((sum, it) => sum + priceOne(it, it.model || model), 0);
  }
  return priceOne(usage, model);
}

/** OpenAI-style function tools (from src/tools.js) as Messages API tools. */
export function toAnthropicTools(tools = []) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters || { type: 'object', properties: {} },
  }));
}

/**
 * With server-side fallbacks, a stream keeps what a declining model wrote
 * before the switch, then a `fallback` block, then the fallback model's turn
 * (a non-streaming response leaves that partial out). The API's rule for
 * echoing such a turn: before the last `fallback` block, send back only text
 * blocks (the fallback model continued from them) and the `fallback` blocks
 * where they are; thinking, tool_use and anything else from the declined
 * partial is omitted (shared/model-migration.md, "Echoing fallback turns
 * back"). A tool_use from before the switch is never run.
 */
export function afterFallback(content) {
  const cut = content.findLastIndex((b) => b.type === 'fallback');
  if (cut < 0) return content;
  return content.filter((b, i) => i >= cut || b.type === 'text' || b.type === 'fallback');
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
    else if (b.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length;
  }
  return { ...message.usage, output_tokens: Math.max(message.usage.output_tokens || 0, Math.ceil(chars / 3)) };
}

/**
 * A provider for src/agent.js. Holds the conversation in Messages API shape.
 * `complete()` returns { text, calls: [{ id, name, args }], cost, refusal }.
 * `onThinking(text)`, when given, gets each summarized-thinking delta as it
 * streams, and asks the API for display "summarized" (display changes what
 * comes back, not what is billed). It sees thinking only: never the answer,
 * the trace or the conversation, and the thinking blocks still go back to the
 * API unchanged with the rest of the turn. `onFallback()`, with onThinking, is
 * called when a server-side fallback starts mid-stream after thinking was
 * forwarded: the declining model's notes are to be withdrawn.
 * `streamDeadlineMs` bounds each call (default STREAM_DEADLINE_MS).
 */
export function anthropicProvider({ apiKey, model, maxTokens, effort, fetchImpl, onThinking, onFallback, streamDeadlineMs = STREAM_DEADLINE_MS }) {
  if (!PRICES[model]) throw new Error(`No price on file for ${model}. Add it to PRICES in src/providers/anthropic.js before using it.`);
  // The base URL is pinned: without it the SDK reads ANTHROPIC_BASE_URL from
  // the environment, and inside a Claude Code session (or behind someone
  // else's proxy) that would send this key somewhere other than Anthropic.
  // One retry at most: a retried attempt that the API billed would not show
  // up in usage. Streaming calls get the SDK's default timeout (10 minutes).
  const client = new Anthropic({ apiKey, baseURL: API_BASE, maxRetries: MAX_RETRIES, fetch: guardedFetch(apiKey, fetchImpl) });
  // Thinking tokens count toward max_tokens on these models; the caller sets
  // the allowance (the Worker's MAX_TOKENS_CLAUDE), default CLAUDE_MAX_TOKENS.
  const max_tokens = Number(maxTokens) > 0 ? Number(maxTokens) : CLAUDE_MAX_TOKENS;
  let system = '';
  let tools = [];
  const messages = [];
  let last = null;

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
        out = retry;
      }
      return out;
    },

    appendAssistant() {
      if (last) messages.push(last);
    },

    appendToolResults(results, note) {
      const content = results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) }));
      if (note) content.push({ type: 'text', text: note });
      messages.push({ role: 'user', content });
    },

    appendUser(text) {
      messages.push({ role: 'user', content: text });
    },
  };

  async function call(allowTools, maxTokensNow) {
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
      // makes the model answer in text.
      ...(tools.length && !allowTools ? { tool_choice: { type: 'none' } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      // Adaptive is these models' default; asking for the summary is what
      // makes the thinking readable (its display is otherwise "omitted").
      ...(onThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
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
    const cost = priceUsage(res.usage, model);
    // A refusal can come mid-stream, after partial output: discard all of it.
    if (res.stop_reason === 'refusal') {
      last = null;
      return { text: '', calls: [], cost, refusal: res.stop_details?.category ?? 'unspecified' };
    }
    if (res.stop_reason === 'max_tokens') {
      last = null;
      return { text: '', calls: [], cost, refusal: null, truncated: true };
    }
    const content = afterFallback(res.content);
    last = { role: 'assistant', content };
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    // Run tools only when the model stopped to call them.
    const calls = allowTools && res.stop_reason === 'tool_use'
      ? content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }))
      : [];
    return { text, calls, cost, refusal: null };
  }
}
