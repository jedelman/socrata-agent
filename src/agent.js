// The agent loop: tool calling through a provider (Anthropic's Messages API for
// claude-* models, OpenRouter for the rest; see src/providers/). The model
// answers; code owns the trace, the resources list, and the voice check.

import { Trace } from './trace.js';
import { Resources } from './resources.js';
import { Socrata } from './socrata.js';
import { Iqm2 } from './adapters/iqm2.js';
import { toolsFor, runTool } from './tools.js';
import { systemPrompt } from './prompt.js';
import { voiceViolations, REWRITE_INSTRUCTION } from './voice.js';
import { tracedHttp } from './plugins.js';
import { openrouterProvider } from './providers/openrouter.js';
import { anthropicProvider, isClaudeModel } from './providers/anthropic.js';

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const RESULT_CHARS = 16000;

/** Which API serves a model: "claude-..." ids go to Anthropic directly, the rest to OpenRouter. */
export const providerOf = (model) => (isClaudeModel(model) ? 'anthropic' : 'openrouter');
/** The environment variable that holds the key for a model's provider. */
export const keyNameFor = (model) => (providerOf(model) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY');

export function createContext({ city, indexes = {}, appToken, fetchImpl, plugins = [] }) {
  const trace = new Trace();
  const resources = new Resources();
  const socrata = new Socrata({ city, trace, resources, appToken, fetchImpl });
  const iqm2 = city.meetings?.kind === 'iqm2' ? new Iqm2({ base: city.meetings.iqm2, trace, resources, fetchImpl }) : null;
  for (const c of city.contacts || []) resources.addContact({ ...c, source: 'city profile' });
  for (const l of city.links || []) resources.addLink(l);
  const http = tracedHttp(trace, fetchImpl);
  return { city, indexes, trace, resources, socrata, iqm2, http, plugins };
}

/**
 * Ask one question. `history` is prior [{role, content}] turns (user/assistant text only).
 * `apiKey` is the key for the model's provider (see keyNameFor). `effort`
 * (low|medium|high|xhigh|max) applies to Claude models only.
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
  effort,
  fetchImpl,
  referer,
  plugins = [],
  onEvent = () => {},
  onCost = () => {},
}) {
  if (!apiKey) throw new Error(`No API key for ${model}. Set ${keyNameFor(model)}.`);
  // A bad setting must never make the tool loop unbounded.
  maxSteps = Number.isFinite(Number(maxSteps)) && Number(maxSteps) >= 1 ? Math.min(Number(maxSteps), 12) : 8;
  const ctx = createContext({ city, indexes, appToken, fetchImpl, plugins });
  const llm = providerOf(model) === 'anthropic'
    ? anthropicProvider({ apiKey, model, maxTokens, effort, fetchImpl })
    : openrouterProvider({ apiKey, model, maxTokens, fetchImpl, referer });
  llm.init({
    systemPrompt: systemPrompt(city, new Date().toISOString().slice(0, 10)),
    history,
    question,
    toolDefs: toolsFor(city, plugins),
  });
  let cost = 0;
  let answer = '';
  let steps = 0;
  let refusal = null;
  const spend = (usd) => {
    cost += usd;
    onCost(usd);
  };

  for (;;) {
    const lastStep = steps >= maxSteps;
    const out = await llm.complete({ allowTools: !lastStep });
    spend(out.cost);
    if (out.refusal) {
      refusal = out.refusal;
      answer = "I can't answer that one: the model declined it. The queries I ran before it stopped are in the trace below.";
      break;
    }
    if (!out.calls.length || lastStep) {
      answer = out.text;
      if (!answer && lastStep) answer = 'I ran out of steps before I could answer. The queries I ran are in the trace below.';
      break;
    }
    steps++;
    llm.appendAssistant();
    const results = [];
    for (const call of out.calls) {
      let content;
      let isError = false;
      try {
        if (call.error) throw new Error(call.error);
        onEvent({ type: 'tool', name: call.name, args: call.args });
        content = JSON.stringify(await runTool(ctx, call.name, call.args));
      } catch (err) {
        isError = true;
        content = JSON.stringify({ error: String(err?.message || err) });
      }
      if (content.length > RESULT_CHARS) content = `${content.slice(0, RESULT_CHARS)}… [truncated; the full result is in the operator's download links]`;
      results.push({ id: call.id, content, isError });
    }
    llm.appendToolResults(results, steps >= maxSteps ? 'You have used all your tool steps. Answer now from what you found.' : null);
  }

  // Voice check: one rewrite, then report honestly if it still fails.
  let violations = refusal ? [] : voiceViolations(answer);
  let rewritten = false;
  if (violations.length) {
    onEvent({ type: 'rewrite', violations });
    llm.appendAssistant();
    llm.appendUser(REWRITE_INSTRUCTION);
    const out = await llm.complete({ allowTools: false });
    spend(out.cost);
    if (out.text && !out.refusal) {
      answer = out.text;
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
    ...(refusal ? { refusal } : {}),
    markdown: {
      trace: ctx.trace.toMarkdown(),
      resources: ctx.resources.toMarkdown(),
    },
  };
}
