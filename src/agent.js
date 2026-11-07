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
import { worldClaimViolations, GAP_REWRITE_ADDENDUM } from './gaps/kinds.js';
import { matchGaps, gapItem, citeCatalog, classifyRefusal, refilterUnanswered, absenceFor, gapsMarkdown } from './gaps/answer.js';
import { buildDate } from './gaps/measures.js';
import { anthropicProvider, isClaudeModel } from './providers/anthropic.js';

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';
const RESULT_CHARS = 16000;

/** Which API serves a model: "claude-..." ids go to Anthropic directly, the rest to OpenRouter. */
export const providerOf = (model) => (isClaudeModel(model) ? 'anthropic' : 'openrouter');
/** The environment variable that holds the key for a model's provider. */
export const keyNameFor = (model) => (providerOf(model) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY');
/**
 * The key for a model from an environment object. Inside a Claude Code
 * session ANTHROPIC_API_KEY belongs to Claude Code itself, so
 * SIREN_ANTHROPIC_API_KEY wins when both are set.
 */
export const apiKeyFromEnv = (model, env = {}) =>
  providerOf(model) === 'anthropic' ? env.SIREN_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY : env.OPENROUTER_API_KEY;

export function createContext({ city, indexes = {}, appToken, fetchImpl, plugins = [] }) {
  const trace = new Trace();
  const resources = new Resources();
  const socrata = new Socrata({ city, trace, resources, appToken, fetchImpl });
  const iqm2 = city.meetings?.kind === 'iqm2' ? new Iqm2({ base: city.meetings.iqm2, trace, resources, fetchImpl }) : null;
  for (const c of city.contacts || []) resources.addContact({ ...c, source: 'city profile' });
  for (const l of city.links || []) resources.addLink(l);
  const http = tracedHttp(trace, fetchImpl);
  return { city, indexes, trace, resources, socrata, iqm2, http, plugins, suggestions: [] };
}

/**
 * Ask one question. `history` is prior [{role, content}] turns (user/assistant
 * text). `carried` lists tool results that history brings back from earlier in
 * a conversation ({name, args, turn, at}); they get a code-written trace step,
 * so an answer built on them still shows where its data came from.
 * `apiKey` is the key for the model's provider (see keyNameFor). `effort`
 * (low|medium|high|xhigh|max) applies to Claude models only.
 * `gaps` (off by default) is { data, streets?, absenceLines? }: a built gap
 * file (data/gaps/<city>.json) and options (docs/gaps.md §8). With gaps off,
 * every output is byte-identical to a build without gaps.
 * Returns { answer, trace, resources, voice, cost, model, steps }, plus
 * { gaps, unanswered, fallback } when gaps are on.
 */
export async function ask({
  question,
  history = [],
  carried = [],
  city,
  indexes,
  apiKey,
  model = DEFAULT_MODEL,
  appToken,
  maxSteps = 8,
  maxTokens,
  effort,
  fetchImpl,
  referer,
  plugins = [],
  onEvent = () => {},
  onCost = () => {},
  gaps = null,
}) {
  if (!apiKey) throw new Error(`No API key for ${model}. Set ${keyNameFor(model)}.`);
  // A bad setting must never make the tool loop unbounded.
  maxSteps = Number.isFinite(Number(maxSteps)) && Number(maxSteps) >= 1 ? Math.min(Number(maxSteps), 12) : 8;
  const ctx = createContext({ city, indexes, appToken, fetchImpl, plugins });
  const gapsOn = Boolean(gaps?.data);
  const today = new Date().toISOString().slice(0, 10);
  if (gapsOn) {
    ctx.gaps = { data: gaps.data, streets: gaps.streets, absenceLines: gaps.absenceLines === true };
    ctx.attempted = [];
    ctx.unanswered = [];
    // Each tool's value as it returned, for the gap predicates: content is
    // cut at RESULT_CHARS, and a cut JSON value doesn't parse.
    ctx.toolValues = [];
  }
  // Absence lines date their reading as the gap statements do (America/New_York).
  const gapDay = gapsOn ? buildDate() : null;
  if (carried.length) {
    await ctx.trace.record(
      {
        tool: 'results kept from earlier in this conversation',
        soql: carried.map((c) => `turn ${c.turn}: ${c.name} ${JSON.stringify(c.args)}`).join('; ').slice(0, 1500),
      },
      async () => ({ result: null, rows: carried.length })
    );
  }
  // Tool results from this question, returned so a conversation can keep them.
  const toolResults = [];
  const llm = providerOf(model) === 'anthropic'
    ? anthropicProvider({ apiKey, model, maxTokens, effort, fetchImpl })
    : openrouterProvider({ apiKey, model, maxTokens: maxTokens || 1500, fetchImpl, referer });
  llm.init({
    systemPrompt: gapsOn ? systemPrompt(city, today, { gaps: true }) : systemPrompt(city, today),
    history,
    question,
    toolDefs: gapsOn ? toolsFor(city, plugins, { gaps: gaps.data }) : toolsFor(city, plugins),
  });
  let cost = 0;
  let answer = '';
  let steps = 0;
  let refusal = null;
  let fallback = false;
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
      fallback = true;
      answer = "I can't answer that one: the model declined it. The queries I ran before it stopped are in the trace below.";
      break;
    }
    if (!out.calls.length || lastStep) {
      answer = out.text;
      if (!answer) {
        fallback = true;
        answer = out.truncated
          ? 'I ran out of room before I could finish. The queries I ran are in the trace below.'
          : lastStep
            ? 'I ran out of steps before I could answer. The queries I ran are in the trace below.'
            : "I couldn't put an answer together. The queries I ran are in the trace below.";
      }
      break;
    }
    steps++;
    llm.appendAssistant();
    const results = [];
    for (const [i, call] of out.calls.entries()) {
      let content;
      let isError = false;
      let value;
      if (gapsOn) {
        ctx.batchCalls = out.calls.slice(i + 1).map((c) => ({ name: c.name, args: c.args }));
        ctx.toolResults = toolResults;
      }
      try {
        if (call.error) throw new Error(call.error);
        onEvent({ type: 'tool', name: call.name, args: call.args });
        value = await runTool(ctx, call.name, call.args);
        content = JSON.stringify(value);
      } catch (err) {
        isError = true;
        content = JSON.stringify({ error: String(err?.message || err) });
        if (gapsOn) ctx.attempted.push({ name: call.name, ok: false, ...(classifyRefusal(ctx.socrata, err?.message || err) || {}) });
      }
      if (gapsOn && !isError) {
        ctx.attempted.push({ name: call.name, ok: true });
        ctx.toolValues.push({ name: call.name, value });
        absenceFor(ctx, call.name, value, gapDay);
      }
      if (content.length > RESULT_CHARS) content = `${content.slice(0, RESULT_CHARS)}… [truncated; the sources are in the operator's links]`;
      results.push({ id: call.id, content, isError });
      if (!isError) toolResults.push({ name: call.name, args: call.args, content });
    }
    llm.appendToolResults(results, steps >= maxSteps ? 'You have used all your tool steps. Answer now from what you found.' : null);
  }

  // Voice check: one rewrite, then report honestly if it still fails. With
  // gaps on, world claims and predictions are caught in the same rewrite.
  const check = gapsOn ? (a) => [...voiceViolations(a), ...worldClaimViolations(a)] : voiceViolations;
  let violations = refusal ? [] : check(answer);
  let rewritten = false;
  if (violations.length) {
    onEvent({ type: 'rewrite', violations });
    llm.appendAssistant();
    llm.appendUser(gapsOn ? `${REWRITE_INSTRUCTION} ${GAP_REWRITE_ADDENDUM}` : REWRITE_INSTRUCTION);
    const out = await llm.complete({ allowTools: false });
    spend(out.cost);
    if (out.text && !out.refusal) {
      answer = out.text;
      rewritten = true;
      violations = check(answer);
    }
  }

  // Gaps: attached by code from what this turn ran, never by the model.
  let gapOut = null;
  let unanswered = [];
  if (gapsOn) {
    unanswered = refilterUnanswered(ctx, toolResults);
    ctx.unanswered = unanswered;
    const m = fallback || refusal ? { shown: [], more: 0 } : matchGaps(ctx, toolResults);
    if (m.shown.length) await citeCatalog(ctx, m.shown.length + m.more);
    gapOut = { shown: m.shown.map((x) => gapItem(x, ctx)), more: m.more, measured: gaps.data.built, noted: unanswered.length > 0 };
  }

  return {
    answer,
    trace: ctx.trace.toJSON(),
    resources: ctx.resources.toJSON(),
    voice: { ok: violations.length === 0, rewritten, violations },
    cost,
    model,
    steps,
    toolResults,
    suggestions: ctx.suggestions,
    ...(refusal ? { refusal } : {}),
    ...(gapsOn ? { gaps: gapOut, unanswered, fallback } : {}),
    markdown: {
      trace: ctx.trace.toMarkdown(),
      resources: ctx.resources.toMarkdown(),
      ...(gapsOn ? { gaps: gapsMarkdown(gapOut) } : {}),
    },
  };
}
