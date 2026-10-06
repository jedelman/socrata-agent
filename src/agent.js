// The agent loop: OpenRouter chat completions with tool calling. The model
// answers; code owns the trace, the resources list, and the voice check.

import { Trace } from './trace.js';
import { Resources } from './resources.js';
import { Socrata } from './socrata.js';
import { Iqm2 } from './adapters/iqm2.js';
import { toolsFor, runTool } from './tools.js';
import { systemPrompt } from './prompt.js';
import { voiceViolations, REWRITE_INSTRUCTION } from './voice.js';

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const RESULT_CHARS = 16000;

export function createContext({ city, indexes = {}, appToken, fetchImpl }) {
  const trace = new Trace();
  const resources = new Resources();
  const socrata = new Socrata({ city, trace, resources, appToken, fetchImpl });
  const iqm2 = city.meetings?.kind === 'iqm2' ? new Iqm2({ base: city.meetings.iqm2, trace, resources, fetchImpl }) : null;
  for (const c of city.contacts || []) resources.addContact({ ...c, source: 'city profile' });
  for (const l of city.links || []) resources.addLink(l);
  return { city, indexes, trace, resources, socrata, iqm2 };
}

async function complete({ apiKey, model, messages, tools, maxTokens, fetchImpl, referer }) {
  const res = await (fetchImpl || fetch)(OPENROUTER, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': referer || 'https://github.com/jedelman/socrata-agent',
      'X-Title': 'socrata-agent',
    },
    body: JSON.stringify({ model, messages, ...(tools ? { tools, tool_choice: 'auto' } : {}), max_tokens: maxTokens, usage: { include: true } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`OpenRouter ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/**
 * Ask one question. `history` is prior [{role, content}] turns (user/assistant text only).
 * Returns { answer, trace, resources, voice, cost, model, steps }.
 */
export async function ask({
  question,
  history = [],
  city,
  indexes,
  apiKey,
  model = DEFAULT_MODEL,
  appToken,
  maxSteps = 8,
  maxTokens = 1500,
  fetchImpl,
  referer,
  onEvent = () => {},
}) {
  if (!apiKey) throw new Error('No OpenRouter API key. Set OPENROUTER_API_KEY.');
  const ctx = createContext({ city, indexes, appToken, fetchImpl });
  const tools = toolsFor(city);
  const messages = [
    { role: 'system', content: systemPrompt(city, new Date().toISOString().slice(0, 10)) },
    ...history.map((m) => ({ role: m.role, content: String(m.content) })),
    { role: 'user', content: question },
  ];
  let cost = 0;
  let answer = '';
  let steps = 0;

  for (;;) {
    const lastStep = steps >= maxSteps;
    const data = await complete({ apiKey, model, messages, tools: lastStep ? undefined : tools, maxTokens, fetchImpl, referer });
    cost += data.usage?.cost || 0;
    const msg = data.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length || lastStep) {
      answer = (msg.content || '').trim();
      if (!answer && lastStep) answer = 'I ran out of steps before I could answer. The queries I ran are in the trace below.';
      break;
    }
    steps++;
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      let content;
      try {
        args = JSON.parse(call.function.arguments || '{}');
        onEvent({ type: 'tool', name: call.function.name, args });
        const result = await runTool(ctx, call.function.name, args);
        content = JSON.stringify(result);
      } catch (err) {
        content = JSON.stringify({ error: String(err?.message || err) });
      }
      if (content.length > RESULT_CHARS) content = `${content.slice(0, RESULT_CHARS)}… [truncated; the full result is in the operator's download links]`;
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
    if (steps >= maxSteps) messages.push({ role: 'user', content: 'You have used all your tool steps. Answer now from what you found.' });
  }

  // Voice check: one rewrite, then report honestly if it still fails.
  let violations = voiceViolations(answer);
  let rewritten = false;
  if (violations.length) {
    onEvent({ type: 'rewrite', violations });
    const data = await complete({
      apiKey,
      model,
      messages: [...messages, { role: 'assistant', content: answer }, { role: 'user', content: REWRITE_INSTRUCTION }],
      maxTokens,
      fetchImpl,
      referer,
    });
    cost += data.usage?.cost || 0;
    const fixed = (data.choices?.[0]?.message?.content || '').trim();
    if (fixed) {
      answer = fixed;
      rewritten = true;
      violations = voiceViolations(answer);
    }
  }

  return {
    answer,
    trace: ctx.trace.toJSON(),
    resources: ctx.resources.toJSON(),
    voice: { ok: violations.length === 0, rewritten, violations },
    cost,
    model,
    steps,
    markdown: {
      trace: ctx.trace.toMarkdown(),
      resources: ctx.resources.toMarkdown(),
    },
  };
}
