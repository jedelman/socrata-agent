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
import { requestBudget } from './request-budget.js';
import { webSearchSettings, checkWebSearchForCity, traceSearches, handOffWebPages } from './web-search.js';
import { filterAnswerLinks, handoffUrls } from './answer-links.js';
import { finalFollowups } from './followups.js';
import { RESEARCH_SCOPES } from './prior-research.js';

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna';

/**
 * The research scopes an answer may search: those `priorResearch` names
 * (with a search function), never 'account' on a public thread.
 */
export function researchScopesFor(priorResearch, publicThread = false) {
  if (!priorResearch || typeof priorResearch.search !== 'function') return [];
  return RESEARCH_SCOPES.filter((s) => (priorResearch.scopes || []).includes(s) && !(publicThread && s === 'account'));
}
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
  return { city, indexes, trace, resources, socrata, iqm2, http, plugins, requests, suggestions: [], followups: [] };
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
 * `gaps` (off by default) is { data, streets?, absenceLines? }: a built gap
 * file (data/gaps/<city>.json) and options (docs/gaps.md §8). With gaps off,
 * every output is byte-identical to a build without gaps.
 * `webSearch` (off by default) is a deployment's { allowedDomains, maxUses }
 * (src/web-search.js): for Claude models it declares Anthropic's web search
 * tool, limited to those sites by the API. Each search the API's response
 * shows gets a code-written trace step, and the pages the answer cites (or
 * every result, when it cites none) are handed off as records of kind
 * 'web'. A paused turn (pause_turn) is resumed as its own model call, which
 * counts as a step and against the request budget like any other; the answer
 * is the whole turn's text. A call that resumes server-side work never sends
 * tool_choice none, and a client tool it asks for past the cap isn't run:
 * the answer ends as at the step cap. With web search off, every request and
 * output is as it was before it.
 * `subrequestBudget` caps the outbound requests this answer may make, model
 * calls included (unset: no cap; the Worker sets SUBREQUEST_BUDGET). Tool
 * requests stop short of it, keeping enough for the final answer.
 * `publicThread` (the free tier's follow-ups): the history is a public
 * thread, its earlier questions maybe other people's (wrapped in
 * <thread_question> by worker/questions.js). The prompt gets a line saying
 * so, and the carried-results trace step shows only how many were carried,
 * never their arguments (the step is public, and an earlier question may
 * since have been withdrawn). Off, everything is as before.
 * `budget` (optional) is a counter from src/request-budget.js the caller
 * already started, for fetches made on this answer's behalf before it (the
 * free tier reads the asker's question record through it); the answer then
 * counts on it, and `subrequestBudget` and `fetchImpl` are not used. Unset,
 * the answer starts its own, as before.
 * `priorResearch` (off by default) is the Worker's research memory: {
 * scopes, search(terms, { scopes }), private, streets } (src/prior-research.js,
 * worker/research.js). It declares the prior_research tool and its prompt
 * line; a public thread never gets the 'account' scope, and the trace shows
 * the words searched only when `private` is set. Off, everything is as before.
 * `onEvent` hears the answer's progress, each event with `step`, the model
 * call it belongs to (counted from 0; a step's tools follow its thinking):
 *   { type: 'thinking', step, text }  a delta of the model's summarized
 *       thinking, only with `thinkingEvents: true` and a Claude model. It goes
 *       to onEvent and nowhere else: not the trace, the answer, the voice
 *       check, toolResults or the history sent back to the model (the API's
 *       own thinking blocks still go back unchanged, as it requires).
 *   { type: 'tool', step, name, args }  a tool about to run
 *   { type: 'rewrite', step, violations }  the voice rewrite call about to go
 *   { type: 'refusal', step }  the model declined that step: its output,
 *       thinking included, is discarded
 *   { type: 'fallback', step }  (with thinkingEvents) the model declined
 *       partway and another model continues the step: the thinking sent so far
 *       in that step came from the model that declined
 * Returns { answer, trace, resources, voice, cost, model, steps, requestBudget },
 * plus { gaps, unanswered, fallback } when gaps are on, `followups` (sources
 * offered with offer_followup) when there are any, and `answerLinks` ({ kept,
 * dropped } counts) when the answer had links. The answer's links are only
 * ever to URLs this answer handed off (src/answer-links.js).
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
  thinkingEvents = false,
  gaps = null,
  webSearch = null,
  budget: given = null,
  publicThread = false,
  priorResearch = null,
  traceparent = null,
}) {
  if (!apiKey) throw new Error(`No API key for ${model}. Set ${keyNameFor(model)}.`);
  // Checked whatever the model, so a bad list fails here; declared only for
  // Claude models (it is Anthropic's server tool).
  const searchSettings = checkWebSearchForCity(webSearchSettings(webSearch), city);
  const searchOn = Boolean(searchSettings) && providerOf(model) === 'anthropic';
  // A bad setting must never make the tool loop unbounded.
  maxSteps = Number.isFinite(Number(maxSteps)) && Number(maxSteps) >= 1 ? Math.min(Number(maxSteps), 12) : 8;
  // One counter for every fetch this answer makes: tools and model alike.
  const budget = given || requestBudget({ limit: subrequestBudget, fetchImpl });
  const ctx = createContext({ city, indexes, appToken, plugins, budget });
  const gapsOn = Boolean(gaps?.data);
  const today = new Date().toISOString().slice(0, 10);
  if (gapsOn) {
    ctx.gaps = { data: gaps.data, streets: gaps.streets, absenceLines: gaps.absenceLines === true };
    ctx.attempted = [];
    // Trace steps recorded during a tool call that threw: a step can be ok
    // (the dataset-name check before a failed query) while its call errored.
    ctx.erroredSteps = new Set();
    ctx.unanswered = [];
    // Each tool's value as it returned, for the gap predicates: content is
    // cut at RESULT_CHARS, and a cut JSON value doesn't parse.
    ctx.toolValues = [];
  }
  // Absence lines date their reading as the gap statements do (America/New_York).
  const gapDay = gapsOn ? buildDate() : null;
  if (carried.length) {
    await ctx.trace.record(
      publicThread
        ? { tool: `${carried.length} earlier result${carried.length === 1 ? '' : 's'} from this thread ${carried.length === 1 ? 'was' : 'were'} carried as data` }
        : {
          tool: 'results kept from earlier in this conversation',
          soql: carried.map((c) => `turn ${c.turn}: ${c.name} ${JSON.stringify(c.args)}`).join('; ').slice(0, 1500),
        },
      async () => ({ result: null, rows: carried.length })
    );
  }
  // Tool results from this question, returned so a conversation can keep them.
  const toolResults = [];
  // The model call in progress (onEvent's `step`), and the next one's number.
  let step = -1;
  let nextStep = 0;
  const onThinking = thinkingEvents ? (text) => onEvent({ type: 'thinking', step, text }) : undefined;
  const onFallback = thinkingEvents ? () => onEvent({ type: 'fallback', step }) : undefined;
  const llm = providerOf(model) === 'anthropic'
    ? anthropicProvider({ apiKey, model, maxTokens, effort, fetchImpl: budget.model, onThinking, onFallback, ...(searchOn ? { webSearch: searchSettings } : {}), ...(traceparent ? { traceparent } : {}) })
    : openrouterProvider({ apiKey, model, maxTokens: maxTokens || 1500, fetchImpl: budget.model, referer });
  // Fetches one API call can take, and one complete() at worst (a cut-off
  // call's second try, each with its retry).
  const perCall = llm.fetchesPerCall || 1;
  const perComplete = llm.fetchesPerComplete || perCall;
  // Tool requests stop while enough is left for the model calls that finish
  // the answer: the final answer at its worst, and one voice rewrite call.
  budget.setReserve(perComplete + perCall);
  // Research memory (src/prior-research.js): the Worker's search over the
  // scopes this answer may read. A public thread never reads an account's.
  const researchScopes = researchScopesFor(priorResearch, publicThread);
  if (researchScopes.length) ctx.priorResearch = { scopes: researchScopes, search: priorResearch.search, private: !publicThread && priorResearch.private === true, streets: priorResearch.streets };
  const promptOpts = { ...(gapsOn ? { gaps: true } : {}), ...(searchOn ? { webSearch: searchSettings } : {}), ...(publicThread ? { publicThread: true } : {}), ...(researchScopes.length ? { priorResearch: true } : {}) };
  const toolOpts = { ...(gapsOn ? { gaps: gaps.data } : {}), ...(researchScopes.length ? { priorResearch: { scopes: researchScopes } } : {}) };
  llm.init({
    systemPrompt: Object.keys(promptOpts).length ? systemPrompt(city, today, promptOpts) : systemPrompt(city, today),
    history,
    question,
    toolDefs: Object.keys(toolOpts).length ? toolsFor(city, plugins, toolOpts) : toolsFor(city, plugins),
  });
  let cost = 0;
  let answer = '';
  let steps = 0;
  let refusal = null;
  let fallback = false;
  // Set when the request budget ended the tool loop.
  let budgetStopped = false;
  // Web search: the results that may be handed off, and the citations on
  // the text that became the answer.
  const webResults = [];
  // offer_followup may offer a page search returned before it's handed off.
  ctx.webResults = webResults;
  let answerCitations = [];
  // Every search a response shows gets a trace step, written from its blocks.
  const traceWeb = async (out) => {
    if (!searchOn || !out.searches?.length) return;
    webResults.push(...(await traceSearches(ctx.trace, out.searches, { allowedDomains: searchSettings.allowedDomains, withheld: Boolean(out.refusal) })));
  };
  const spend = (usd) => {
    cost += usd;
    onCost(usd);
  };
  // One model call. A call that fails partway may carry the cost of what the
  // API reported reading before it failed; that is spent before the error goes up.
  const complete = async (opts) => {
    step = nextStep++;
    try {
      return await llm.complete(opts);
    } catch (err) {
      if (Number.isFinite(err?.cost) && err.cost > 0) spend(err.cost);
      throw err;
    }
  };

  for (;;) {
    // Tools are offered only while this call, a tool request after it and the
    // reserve all fit. Otherwise the model answers now, with tools off.
    if (!budget.roomForTools(perComplete)) budgetStopped = true;
    const lastStep = steps >= maxSteps || budgetStopped;
    const out = await complete({ allowTools: !lastStep });
    spend(out.cost);
    await traceWeb(out);
    if (out.refusal) {
      onEvent({ type: 'refusal', step });
      refusal = out.refusal;
      fallback = true;
      answer = "I can't answer that one: the model declined it. The queries I ran before it stopped are in the trace below.";
      break;
    }
    // The API paused its server-side loop (web search): the turn goes back as
    // it is and the next call resumes it. That call is a step of its own.
    if (out.paused && !lastStep) {
      steps++;
      llm.appendAssistant();
      continue;
    }
    if (!out.calls.length || lastStep) {
      // A paused turn's text is unfinished: never the answer. Nor is a
      // response past the cap that still asks for a client tool (one that
      // resumed web search's server-side work goes without tool_choice none):
      // its tools don't run and it ends with the step cap's fallback.
      answer = out.paused || out.calls.length ? '' : out.text;
      if (answer) answerCitations = out.citations || [];
      if (!answer) {
        fallback = true;
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
    for (const [i, call] of out.calls.entries()) {
      let content;
      let isError = false;
      let value;
      const mark = ctx.trace.steps.length;
      const refusedBefore = budget.refused;
      if (gapsOn) {
        ctx.batchCalls = out.calls.slice(i + 1).map((c) => ({ name: c.name, args: c.args }));
        ctx.toolResults = toolResults;
      }
      try {
        if (call.error) throw new Error(call.error);
        onEvent({ type: 'tool', step, name: call.name, args: call.args });
        value = await runTool(ctx, call.name, call.args);
        // The tool returns what it has; code adds the note, whatever the tool,
        // ahead of the result so a long result cut to size still carries it.
        content = JSON.stringify(budget.refused > refusedBefore ? { request_budget: BUDGET_TOOL_NOTE, result: value } : value);
      } catch (err) {
        isError = true;
        content = JSON.stringify({ ...(budget.refused > refusedBefore ? { request_budget: BUDGET_TOOL_NOTE } : {}), error: String(err?.message || err) });
        if (gapsOn) {
          ctx.attempted.push({ name: call.name, ok: false, ...(classifyRefusal(ctx.socrata, err?.message || err) || {}) });
          for (const s of ctx.trace.steps.slice(mark)) ctx.erroredSteps.add(s);
        }
      }
      if (gapsOn && !isError) {
        if (budget.refused > refusedBefore) {
          // A result the request budget cut short counts for gaps as an
          // errored call does: none of its steps, no value, no absence line,
          // so a budget stop never makes a gap touch or bite.
          ctx.attempted.push({ name: call.name, ok: false, budget: true });
          for (const s of ctx.trace.steps.slice(mark)) ctx.erroredSteps.add(s);
        } else {
          ctx.attempted.push({ name: call.name, ok: true });
          ctx.toolValues.push({ name: call.name, value });
          absenceFor(ctx, call.name, value, gapDay);
        }
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
  // With gaps on, world claims and predictions are caught in the same rewrite.
  const check = gapsOn ? (a) => [...voiceViolations(a), ...worldClaimViolations(a)] : voiceViolations;
  let violations = refusal ? [] : check(answer);
  let rewritten = false;
  let rewriteSkipped = false;
  if (violations.length && budget.limit - budget.used < perCall) rewriteSkipped = true;
  else if (violations.length) {
    onEvent({ type: 'rewrite', step: nextStep, violations });
    llm.appendAssistant();
    llm.appendUser(gapsOn ? `${REWRITE_INSTRUCTION} ${GAP_REWRITE_ADDENDUM}` : REWRITE_INSTRUCTION);
    const out = await complete({ allowTools: false, retryTruncated: false });
    spend(out.cost);
    await traceWeb(out);
    if (out.refusal) onEvent({ type: 'refusal', step });
    if (out.text && !out.refusal && !out.truncated && !out.paused) {
      answer = out.text;
      rewritten = true;
      violations = check(answer);
      // The rewrite rewords the same answer: its citations join the first's.
      answerCitations = [...answerCitations, ...(out.citations || [])];
    }
  }

  // The web pages behind the answer, handed off by code from the API's blocks.
  if (searchOn && webResults.length) handOffWebPages(ctx.resources, webResults, answerCitations);

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

  // Links in the answer's own words: kept only to what this answer handed
  // off (src/answer-links.js), after any rewrite and once the web pages are
  // handed off. Follow-up offers keep only sources still in the hand-off.
  const handedOff = ctx.resources.toJSON();
  const linked = filterAnswerLinks(answer, handoffUrls(handedOff));
  // Words a link held apart can meet once it's gone: the check reads the
  // answer as it will be shown.
  if (linked.text !== answer && !refusal) violations = check(linked.text);
  answer = linked.text;
  const followups = finalFollowups(ctx.followups, handedOff);

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
    // Sources the answer mentions and Siren can read next (offer_followup),
    // and how many links in the answer's text were kept and taken out; each
    // only when there is one, so an answer without them reads as before.
    ...(followups.length ? { followups } : {}),
    ...(linked.kept || linked.dropped ? { answerLinks: { kept: linked.kept, dropped: linked.dropped } } : {}),
    // For the answer record: how many outbound requests this answer made, and
    // in plain words when its budget ended the search.
    requestBudget: { ...used, reached, ...(reached ? { note: budgetNote(used) } : {}) },
    ...(refusal ? { refusal } : {}),
    ...(gapsOn ? { gaps: gapOut, unanswered, fallback } : {}),
    markdown: {
      trace: ctx.trace.toMarkdown(),
      resources: ctx.resources.toMarkdown(),
      ...(gapsOn ? { gaps: gapsMarkdown(gapOut) } : {}),
    },
  };
}
