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
import { requestBudget } from './request-budget.js';

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

// Every client a tool can reach the network through gets the answer's
// counting fetch (src/request-budget.js), never `fetchImpl` itself. Without a
// `budget`, the count still runs, with no limit. Tools see only a read-only
// view of the count (`ctx.requests`), never the counter: its model lane is
// never refused and goes around the trace.
export function createContext({ city, indexes = {}, appToken, fetchImpl, plugins = [], budget = requestBudget({ fetchImpl }) }) {
  const trace = new Trace();
  const resources = new Resources();
  const socrata = new Socrata({ city, trace, resources, appToken, fetchImpl: budget.tool });
  const iqm2 = city.meetings?.kind === 'iqm2' ? new Iqm2({ base: city.meetings.iqm2, trace, resources, fetchImpl: budget.tool }) : null;
  for (const c of city.contacts || []) resources.addContact({ ...c, source: 'city profile' });
  for (const l of city.links || []) resources.addLink(l);
  const http = tracedHttp(trace, budget.tool);
  const requests = Object.freeze({
    get used() {
      return budget.used;
    },
    summary: () => budget.summary(),
  });
  return { city, indexes, trace, resources, socrata, iqm2, http, plugins, requests, suggestions: [] };
}

// What the model is told, and what the person reads, when an answer's
// request budget runs out. Code-written, in the agent's voice.
export const BUDGET_TOOL_NOTE =
  "Some of this tool's requests were not sent: this answer's outbound request budget is used up. This result holds what came back before that; the requests not sent are marked refused in the trace.";
export const BUDGET_STOP_NOTE =
  "This answer's outbound request budget is used up, so no more tools can run. Answer now from what you found, and say plainly what you could not check.";
export function budgetNote({ limit, refused }) {
  const cap = limit == null ? 'outbound request limit' : `limit of ${limit} outbound requests`;
  const skipped = refused
    ? ` The ${refused === 1 ? 'request' : `${refused} requests`} I didn't send ${refused === 1 ? 'is' : 'are'} marked "refused" in the trace.`
    : '';
  return `I stopped at this answer's ${cap} and answered from what I had found.${skipped}`;
}

/**
 * Ask one question. `history` is prior [{role, content}] turns (user/assistant
 * text). `carried` lists tool results that history brings back from earlier in
 * a conversation ({name, args, turn, at}); they get a code-written trace step,
 * so an answer built on them still shows where its data came from.
 * `apiKey` is the key for the model's provider (see keyNameFor). `effort`
 * (low|medium|high|xhigh|max) applies to Claude models only.
 * `subrequestBudget` caps the outbound requests this answer may make, model
 * calls included (unset: no cap; the Worker sets SUBREQUEST_BUDGET). Tool
 * requests stop short of it, keeping enough for the final answer.
 * Returns { answer, trace, resources, voice, cost, model, steps, requestBudget }.
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
  subrequestBudget,
  onEvent = () => {},
  onCost = () => {},
}) {
  if (!apiKey) throw new Error(`No API key for ${model}. Set ${keyNameFor(model)}.`);
  // A bad setting must never make the tool loop unbounded.
  maxSteps = Number.isFinite(Number(maxSteps)) && Number(maxSteps) >= 1 ? Math.min(Number(maxSteps), 12) : 8;
  // One counter for every fetch this answer makes: tools and model alike.
  const budget = requestBudget({ limit: subrequestBudget, fetchImpl });
  const ctx = createContext({ city, indexes, appToken, plugins, budget });
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
    ? anthropicProvider({ apiKey, model, maxTokens, effort, fetchImpl: budget.model })
    : openrouterProvider({ apiKey, model, maxTokens: maxTokens || 1500, fetchImpl: budget.model, referer });
  // Fetches one API call can take, and one complete() at worst (a cut-off
  // call's second try, each with its retry).
  const perCall = llm.fetchesPerCall || 1;
  const perComplete = llm.fetchesPerComplete || perCall;
  // Tool requests stop while enough is left for the model calls that finish
  // the answer: the final answer at its worst, and one voice rewrite call.
  budget.setReserve(perComplete + perCall);
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
  // Set when the request budget ended the tool loop.
  let budgetStopped = false;
  const spend = (usd) => {
    cost += usd;
    onCost(usd);
  };

  for (;;) {
    // Tools are offered only while this call, a tool request after it and the
    // reserve all fit. Otherwise the model answers now, with tools off.
    if (!budget.roomForTools(perComplete)) budgetStopped = true;
    const lastStep = steps >= maxSteps || budgetStopped;
    const out = await llm.complete({ allowTools: !lastStep });
    spend(out.cost);
    if (out.refusal) {
      refusal = out.refusal;
      answer = "I can't answer that one: the model declined it. The queries I ran before it stopped are in the trace below.";
      break;
    }
    if (!out.calls.length || lastStep) {
      answer = out.text;
      if (!answer) {
        answer = out.truncated
          ? 'I ran out of room before I could finish. The queries I ran are in the trace below.'
          : budgetStopped
            ? "I reached this answer's request limit before I could answer. The queries I ran are in the trace below."
            : lastStep
            ? 'I ran out of steps before I could answer. The queries I ran are in the trace below.'
            : "I couldn't put an answer together. The queries I ran are in the trace below.";
      }
      break;
    }
    steps++;
    llm.appendAssistant();
    const results = [];
    for (const call of out.calls) {
      let content;
      let isError = false;
      const refusedBefore = budget.refused;
      try {
        if (call.error) throw new Error(call.error);
        onEvent({ type: 'tool', name: call.name, args: call.args });
        const result = await runTool(ctx, call.name, call.args);
        // The tool returns what it has; code adds the note, whatever the tool,
        // ahead of the result so a long result cut to size still carries it.
        content = JSON.stringify(budget.refused > refusedBefore ? { request_budget: BUDGET_TOOL_NOTE, result } : result);
      } catch (err) {
        isError = true;
        content = JSON.stringify({ ...(budget.refused > refusedBefore ? { request_budget: BUDGET_TOOL_NOTE } : {}), error: String(err?.message || err) });
      }
      if (content.length > RESULT_CHARS) content = `${content.slice(0, RESULT_CHARS)}… [truncated; the sources are in the operator's links]`;
      results.push({ id: call.id, content, isError });
      // A result the budget cut short isn't kept for later turns: a follow-up
      // runs the tool again under its own budget.
      if (!isError && budget.refused === refusedBefore) toolResults.push({ name: call.name, args: call.args, content });
    }
    llm.appendToolResults(
      results,
      !budget.roomForTools(perComplete) ? BUDGET_STOP_NOTE : steps >= maxSteps ? 'You have used all your tool steps. Answer now from what you found.' : null
    );
  }

  // Voice check: one rewrite, then report honestly if it still fails. The
  // rewrite is one API call (no second try when cut off), sent only if it fits
  // in what is left of the budget; otherwise the check fails honestly.
  let violations = refusal ? [] : voiceViolations(answer);
  let rewritten = false;
  let rewriteSkipped = false;
  if (violations.length && budget.limit - budget.used < perCall) rewriteSkipped = true;
  else if (violations.length) {
    onEvent({ type: 'rewrite', violations });
    llm.appendAssistant();
    llm.appendUser(REWRITE_INSTRUCTION);
    const out = await llm.complete({ allowTools: false, retryTruncated: false });
    spend(out.cost);
    if (out.text && !out.refusal && !out.truncated) {
      answer = out.text;
      rewritten = true;
      violations = voiceViolations(answer);
    }
  }

  const used = budget.summary();
  const reached = budgetStopped || used.refused > 0;
  return {
    answer,
    trace: ctx.trace.toJSON(),
    resources: ctx.resources.toJSON(),
    voice: { ok: violations.length === 0, rewritten, violations, ...(rewriteSkipped ? { rewriteSkipped } : {}) },
    cost,
    model,
    steps,
    toolResults,
    suggestions: ctx.suggestions,
    // For the answer record: how many outbound requests this answer made, and
    // in plain words when its budget ended the search.
    requestBudget: { ...used, reached, ...(reached ? { note: budgetNote(used) } : {}) },
    ...(refusal ? { refusal } : {}),
    markdown: {
      trace: ctx.trace.toMarkdown(),
      resources: ctx.resources.toMarkdown(),
    },
  };
}
