// Telemetry: one structured log line per answer, kept by Cloudflare Workers
// Logs (wrangler.toml [env.siren.observability]; 7 days). Jason, 2026-11-11:
// "set up otel logging to Cloudflare now that we have workers Paid".
//
// What an answer's line holds: the tier (member, invite, public), model,
// steps, time, cost, which tools ran and how often, whether the answer was a
// partial one, which case files it read, follow-ups offered, links dropped,
// whether a source was suggested, and a few topic words. Never the question,
// the answer, an account, invite, conversation id, IP, address or person.
//
// Topic words (so the case-file routine can see what people ask about that
// no case file covers): only from the words a tool was asked for (prior
// research, a capital project, legislation, a budget book, an ordinance,
// City news), only when that text passes the public-text checks (no house
// number, address, corner, block, unit, contact, coordinates or person),
// and only words found in Norfolk's own adopted budget books and Zoning
// Ordinance, which name no private people. A surname or an odd word that
// isn't in those books never reaches a log.
//
// TELEMETRY = "true" turns it on. With it off nothing is logged and every
// page reads as before.

import { publicTextViolations } from '../src/public-text.js';
import { PARTIAL_LEAD } from '../src/prompt.js';
import { WEB_SEARCH_STEP } from '../src/web-search.js';
import fy2027 from '../data/documents/norfolk-budget-fy2027-departments.json' with { type: 'json' };
import fy2026 from '../data/documents/norfolk-budget-fy2026-departments.json' with { type: 'json' };
import fy2025 from '../data/documents/norfolk-budget-fy2025-departments.json' with { type: 'json' };
import fy2024 from '../data/documents/norfolk-budget-fy2024-departments.json' with { type: 'json' };
import zoning from '../data/documents/norfolk-zoning-ordinance.json' with { type: 'json' };

export const telemetryOn = (env) => env?.TELEMETRY === 'true';

/** The footer's sentence, with telemetry on. */
export const TELEMETRY_NOTE = (app) =>
  `To improve its research, ${app} logs how each answer was found (the tools it used, its cost, and a few topic words from its searches, checked against the City's own budget and zoning books), never your question, your account or an address, and keeps that for 7 days.`;

// The tool arguments topic words may come from.
const TOPIC_ARGS = { prior_research: 'query', capital_projects: 'project', find_legislation: 'text', budget_book_lookup: 'query', ordinance_lookup: 'query', city_news: 'query' };
const STOP = new Set(['about', 'after', 'also', 'been', 'city', 'does', 'from', 'have', 'into', 'more', 'norfolk', 'only', 'over', 'plan', 'that', 'than', 'their', 'them', 'then', 'there', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'your']);
export const MAX_TERMS = 8;

let vocab = null;
/** Words in Norfolk's adopted budget books and Zoning Ordinance (built once per isolate). */
export function vocabulary() {
  if (vocab) return vocab;
  vocab = new Set();
  for (const doc of [fy2027, fy2026, fy2025, fy2024, zoning]) {
    for (const s of doc.sections || []) {
      for (const w of `${s.title || ''} ${s.text || ''}`.toLowerCase().split(/[^a-z]+/)) if (w.length >= 4) vocab.add(w);
    }
  }
  return vocab;
}

/** Topic words from a tool call's arguments: public-text-checked, in the vocabulary, no stop words. */
export function topicTerms(toolResults = [], streets) {
  const words = vocabulary();
  const out = [];
  for (const t of Array.isArray(toolResults) ? toolResults : []) {
    const key = TOPIC_ARGS[t?.name];
    const text = key && typeof t.args?.[key] === 'string' ? t.args[key].slice(0, 200) : '';
    if (!text || publicTextViolations(text, { streets }).length) continue;
    for (const w of text.toLowerCase().split(/[^a-z]+/)) {
      if (w.length >= 4 && !STOP.has(w) && words.has(w) && !out.includes(w)) out.push(w);
      if (out.length >= MAX_TERMS) return out;
    }
  }
  return out;
}

/**
 * The line for one answer. `out` is ask()'s result (toolResults included);
 * `tier` is 'member', 'invite' or 'public'; `ms` how long the answer took.
 */
export function answerEvent(out, { tier, ms, city, streets } = {}) {
  const tools = {};
  for (const t of out?.toolResults || []) if (t?.name) tools[t.name] = (tools[t.name] || 0) + 1;
  const searches = (out?.trace || []).filter((s) => s?.tool === WEB_SEARCH_STEP).length;
  if (searches) tools.web_search = searches;
  const caseFiles = [...new Set((out?.toolResults || []).filter((t) => t?.name === 'case_file' && typeof t.args?.topic === 'string').map((t) => t.args.topic.slice(0, 80)))];
  return {
    event: 'siren.answer',
    v: 1,
    tier: ['member', 'invite', 'public'].includes(tier) ? tier : 'invite',
    ...(city ? { city: String(city).slice(0, 40) } : {}),
    model: typeof out?.model === 'string' ? out.model.slice(0, 60) : null,
    ms: Number.isFinite(ms) ? Math.round(ms) : null,
    steps: Number.isFinite(out?.steps) ? out.steps : null,
    cost_usd: Number.isFinite(out?.cost) ? Math.round(out.cost * 10000) / 10000 : null,
    tools,
    partial: typeof out?.answer === 'string' && out.answer.trimStart().startsWith(PARTIAL_LEAD),
    case_files: caseFiles,
    followups: Array.isArray(out?.followups) ? out.followups.length : 0,
    suggested_source: Array.isArray(out?.suggestions) && out.suggestions.length > 0,
    links_dropped: out?.answerLinks?.dropped || 0,
    voice_ok: out?.voice?.ok !== false,
    budget_reached: Boolean(out?.requestBudget?.reached),
    refused: Boolean(out?.refusal),
    terms: topicTerms(out?.toolResults, streets),
  };
}

/** Log an answer's line, with telemetry on; never throws. */
export function logAnswer(env, out, opts) {
  if (!telemetryOn(env)) return;
  try {
    console.log(JSON.stringify(answerEvent(out, opts)));
  } catch {
    console.error('telemetry: the answer line could not be written');
  }
}
