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
// Spend is priced from the response's usage, per attempt, from the table
// below. A model with no price on file is refused rather than run at an
// unknown cost, so the Worker's daily budget can't be bypassed.

import Anthropic from '@anthropic-ai/sdk';

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

export const isClaudeModel = (model) => /^claude-/.test(String(model || ''));
const API_BASE = 'https://api.anthropic.com';
/** Output allowance for Claude models when the caller sets none. Thinking counts toward it. */
export const CLAUDE_MAX_TOKENS = 8000;
// Below the SDK's non-streaming limit (it refuses requests it estimates at over 10 minutes).
const RETRY_MAX_TOKENS = 16000;

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
    return (fetchImpl || globalThis.fetch)(u, { ...init, headers });
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
 * A provider for src/agent.js. Holds the conversation in Messages API shape.
 * `complete()` returns { text, calls: [{ id, name, args }], cost, refusal }.
 */
export function anthropicProvider({ apiKey, model, maxTokens, effort, fetchImpl }) {
  if (!PRICES[model]) throw new Error(`No price on file for ${model}. Add it to PRICES in src/providers/anthropic.js before using it.`);
  // The base URL is pinned: without it the SDK reads ANTHROPIC_BASE_URL from
  // the environment, and inside a Claude Code session (or behind someone
  // else's proxy) that would send this key somewhere other than Anthropic.
  // One retry at most: a retried attempt that the API billed would not show
  // up in usage. The SDK's own non-streaming timeout (sized to max_tokens) applies.
  const client = new Anthropic({ apiKey, baseURL: API_BASE, maxRetries: 1, fetch: guardedFetch(apiKey, fetchImpl) });
  // Thinking tokens count toward max_tokens on these models; the caller sets
  // the allowance (the Worker's MAX_TOKENS_CLAUDE), default CLAUDE_MAX_TOKENS.
  const max_tokens = Number(maxTokens) > 0 ? Number(maxTokens) : CLAUDE_MAX_TOKENS;
  let system = '';
  let tools = [];
  const messages = [];
  let last = null;

  return {
    name: 'anthropic',
    init({ systemPrompt, history, question, toolDefs }) {
      system = systemPrompt;
      tools = toAnthropicTools(toolDefs);
      // The API rejects empty turns, so skip any (a client may send one back).
      for (const m of history) if (String(m.content ?? '').trim()) messages.push({ role: m.role, content: String(m.content) });
      messages.push({ role: 'user', content: question });
    },

    async complete({ allowTools = true } = {}) {
      let out = await call(allowTools, max_tokens);
      // A response cut off at max_tokens may end in a half-written tool call:
      // never run it. Retry once with more room, then give up honestly.
      if (out.truncated && max_tokens < RETRY_MAX_TOKENS) {
        const retry = await call(allowTools, RETRY_MAX_TOKENS);
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
    };
    let res;
    try {
      res = FALLBACK_MODELS.has(model)
        ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await client.messages.create(params);
    } catch (err) {
      // Report status and message only; never the request (it carries the key).
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      throw new Error(`Anthropic ${status ?? 'error'}: ${String(err?.message || err).slice(0, 300)}`);
    }
    const cost = priceUsage(res.usage, model);
    if (res.stop_reason === 'refusal') {
      last = null;
      return { text: '', calls: [], cost, refusal: res.stop_details?.category ?? 'unspecified' };
    }
    if (res.stop_reason === 'max_tokens') {
      last = null;
      return { text: '', calls: [], cost, refusal: null, truncated: true };
    }
    last = { role: 'assistant', content: res.content };
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    // Run tools only when the model stopped to call them.
    const calls = allowTools && res.stop_reason === 'tool_use'
      ? res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }))
      : [];
    return { text, calls, cost, refusal: null };
  }
}
