// Any model through OpenRouter's OpenAI-compatible chat completions API.
// The conversation is held in OpenAI message shape; cost comes from
// OpenRouter's own usage accounting (usage: { include: true }).

import { networkFetch } from '../budget.js';

const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

export function openrouterProvider({ apiKey, model, maxTokens, fetchImpl, referer }) {
  let tools = [];
  const messages = [];
  let last = null;

  async function post(body) {
    const res = await (fetchImpl || networkFetch)(OPENROUTER, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': referer || 'https://github.com/jedelman/socrata-agent',
        'X-Title': 'socrata-agent',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`OpenRouter ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  return {
    name: 'openrouter',
    // One fetch per call: this client never retries.
    fetchesPerCall: 1,
    fetchesPerComplete: 1,
    init({ systemPrompt, history, question, toolDefs }) {
      tools = toolDefs;
      messages.push({ role: 'system', content: systemPrompt });
      for (const m of history) messages.push({ role: m.role, content: String(m.content) });
      messages.push({ role: 'user', content: question });
    },

    async complete({ allowTools = true } = {}) {
      const withTools = allowTools && tools.length;
      const data = await post({ model, messages, ...(withTools ? { tools, tool_choice: 'auto' } : {}), max_tokens: maxTokens, usage: { include: true } });
      const msg = data.choices?.[0]?.message || {};
      const raw = withTools ? msg.tool_calls || [] : [];
      last = { role: 'assistant', content: msg.content || '', ...(raw.length ? { tool_calls: raw } : {}) };
      const calls = raw.map((c) => {
        try {
          return { id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || '{}') };
        } catch (err) {
          return { id: c.id, name: c.function.name, args: null, error: `Could not read the tool arguments: ${err.message}` };
        }
      });
      return { text: (msg.content || '').trim(), calls, cost: data.usage?.cost || 0, refusal: null };
    },

    appendAssistant() {
      if (last) messages.push(last);
    },

    appendToolResults(results, note) {
      for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      if (note) messages.push({ role: 'user', content: note });
    },

    appendUser(text) {
      messages.push({ role: 'user', content: text });
    },
  };
}
