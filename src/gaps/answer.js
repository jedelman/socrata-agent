// Gaps in Siren's answers (docs/gaps.md §8; Inc 7, and absence lines, Inc 8).
// Private: everything here goes to the person who asked, never to a board.
//
// Code attaches gaps, no model involved: a gap attaches when one of its
// `touches` predicates matches what this turn actually ran (a trace step, a
// tool, a case cite, or a refusal), and it "bit" when one of its `bites_when`
// predicates matched (the turn filtered on the gap's field, a tool returned
// the part the gap is about, or an absence line fired). Steps that errored,
// and every step of a tool call that threw, don't count. With gaps off nothing here runs, and every answer is
// byte-identical to one built without this file.

import { KIND_ORDER, ruleA, gapCheck, fmt, pct, quoteStatuses } from './kinds.js';
import { publicTextViolations } from '../public-text.js';
import { CASES } from './cases.js';

export const MAX_SHOWN = 3;
const REPO = 'https://github.com/jedelman/socrata-agent/blob/main';
const LIVE = new Set(['open', 'closing', 'unmeasured_today']);

/**
 * True while every finding a gap quotes is still in the bundled case file,
 * verified and checked, with the same quote (docs/gaps.md §5.3.9). A finding
 * marked unverified after the build takes its gap out of answers at once.
 */
export function findingsHold(gap, cases = CASES) {
  return (gap.evidence || [])
    .filter((e) => e.type === 'finding')
    .every((e) => {
      const f = cases?.[e.case]?.findings?.find((x) => x.id === e.id);
      return Boolean(f && !f.unverified && f.checked && f.quote && f.quote === e.quote);
    });
}

/** The gaps a built file holds that can attach to answers. */
export const liveGaps = (data, cases = CASES) => (data?.gaps || []).filter((g) => LIVE.has(g.state) && findingsHold(g, cases));

/** Classify a tool error: a restricted, excluded or denied-column refusal, or a plain error. */
export function classifyRefusal(socrata, message) {
  const m = String(message || '');
  const restricted = socrata?.policy?.restricted?.find((r) => m.includes(r.reason));
  if (restricted) return { refusal: 'restricted', dataset: restricted.id };
  const excluded = socrata?.policy?.excluded?.find((e) => m.includes(e.reason));
  if (excluded || /is excluded because it is searchable by personal name/.test(m)) return { refusal: 'excluded', ...(excluded ? { dataset: excluded.id } : {}) };
  if (/is withheld: it identifies private people|Full-text SEARCH isn't allowed|refused this result: it included the withheld column/.test(m)) return { refusal: 'denied_column' };
  return null;
}

function parse(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * What this turn ran, in the shape the predicates read. `extraCalls` are calls
 * in the current batch that haven't run yet (note_unanswered may name a gap a
 * sibling call will touch). Tool results come from ctx.toolValues, the values
 * as the tools returned them, before the agent cuts content at 16,000
 * characters; `toolResults` (parsed from content) is the fallback.
 */
export function turnFacts(ctx, toolResults = [], extraCalls = []) {
  // Calls still to run in this batch count as the queries they name, and a
  // query of an excluded or restricted dataset as the refusal it will get
  // (the open-ended tools run at GENERIC access).
  const generic = extraCalls.filter((c) => c && (c.name === 'query_dataset' || c.name === 'describe_dataset'));
  const pending = generic
    .filter((c) => !pendingRefusal(ctx, c.args?.dataset_id))
    .map((c) => (c.name === 'query_dataset' ? { ok: true, dataset: c.args?.dataset_id, soql: String(c.args?.soql || '') } : { ok: true, dataset: c.args?.dataset_id, tool: 'describe dataset' }));
  const pendingRefused = generic.map((c) => pendingRefusal(ctx, c.args?.dataset_id)).filter(Boolean);
  const extraTools = extraCalls.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  // A step counts only when it succeeded inside a call that succeeded.
  const errored = ctx.erroredSteps || new Set();
  const steps = [...ctx.trace.steps.filter((s) => s.ok && !errored.has(s)), ...pending];
  const attempted = ctx.attempted || [];
  return {
    steps,
    tools: new Set(attempted.filter((a) => a.ok).map((a) => a.name)),
    pendingTools: new Set(extraTools),
    refused: [...attempted.filter((a) => a.refusal), ...pendingRefused],
    results: Array.isArray(ctx.toolValues) ? ctx.toolValues : toolResults.map((r) => ({ name: r.name, value: parse(r.content) })),
    absences: ctx.absences || [],
  };
}

/** The refusal a GENERIC call on this dataset will get, if any. */
function pendingRefusal(ctx, dataset) {
  const id = String(dataset || '');
  if (!id || !ctx.socrata) return null;
  if (ctx.socrata.isExcluded?.(id)) return { refusal: 'excluded', dataset: id, pending: true };
  if (ctx.socrata.restricted?.(id)) return { refusal: 'restricted', dataset: id, pending: true };
  return null;
}

// A step reads a dataset when it ran a query or a describe. Socrata's own
// lookups (the "check dataset name" metadata read before a query) carry the
// dataset too, but read none of its records.
const readsData = (s) => Boolean(s.soql) || s.tool === 'describe dataset';

// A tool that ran counts for a topic's gap only if this turn also read one of
// the topic's datasets: an address-lookup miss reads no tree data.
const readTopic = (gap, facts) => !gap.topic?.datasets?.length || facts.steps.some((s) => readsData(s) && gap.topic.datasets.includes(s.dataset));

function stepMatches(facts, p) {
  return facts.steps.some((s) => readsData(s) && s.dataset === p.dataset && (p.where_includes || []).every((w) => String(s.soql || '').includes(w)));
}

export function touches(gap, facts) {
  return (gap.touches || []).some((p) => {
    if (p.dataset) return stepMatches(facts, p);
    if (p.tool && p.field) return (facts.pendingTools || new Set()).has(p.tool) || facts.results.some((r) => r.name === p.tool && r.value && r.value[p.field] != null);
    if (p.tool) return (facts.pendingTools || new Set()).has(p.tool) || (facts.tools.has(p.tool) && readTopic(gap, facts));
    if (p.case) return facts.steps.some((s) => String(s.url || '').endsWith(`/data/cases/${p.case}.json`));
    if (p.refused) return facts.refused.some((r) => r.refusal === 'restricted' && r.dataset === p.refused);
    return false;
  });
}

/**
 * How hard a gap bit this turn: 0 not at all; 1 a tool returned the part the
 * gap is about; 2 the turn filtered on the gap's field, or was refused by its
 * rule; 3 an absence line fired.
 */
export function biteStrength(gap, facts) {
  let best = 0;
  for (const p of gap.bites_when || []) {
    if (p.absence && facts.absences.some((a) => a.gap === gap.id)) best = Math.max(best, 3);
    else if (p.refused && facts.refused.some((r) => r.refusal === 'restricted' && r.dataset === p.refused)) best = Math.max(best, 2);
    else if (p.dataset && stepMatches(facts, p)) best = Math.max(best, 2);
    else if (p.tool) {
      const hit = facts.results.some((r) => {
        if (r.name !== p.tool || !r.value) return false;
        if (!p.field) return true;
        const v = r.value[p.field];
        return v != null && !(p.ok && v && typeof v === 'object' && 'error' in v);
      });
      if (hit) best = Math.max(best, 1);
    }
  }
  return best;
}
export const bites = (gap, facts) => biteStrength(gap, facts) > 0;

/**
 * The gaps to show under an answer: those this turn touched, ranked by
 * whether they bit, then whether the model named them, then kind; at most
 * three, with a count of the rest.
 */
export function matchGaps(ctx, toolResults = []) {
  const data = ctx.gaps?.data;
  const facts = turnFacts(ctx, toolResults);
  const named = new Set((ctx.unanswered || []).flatMap((u) => u.gaps || []));
  const hit = liveGaps(data)
    .filter((g) => touches(g, facts))
    .map((g) => {
      const strength = biteStrength(g, facts);
      return { g, bit: strength > 0, strength, named: named.has(g.id) };
    });
  // An absence line is the plainest bite and leads; a filter on the gap's
  // field outranks a tool that merely returned the part the gap is about.
  hit.sort((a, b) => b.strength - a.strength || Number(b.named) - Number(a.named) || KIND_ORDER.indexOf(a.g.kind) - KIND_ORDER.indexOf(b.g.kind) || a.g.id.localeCompare(b.g.id));
  return { all: hit, shown: hit.slice(0, MAX_SHOWN), more: Math.max(0, hit.length - MAX_SHOWN) };
}

/** One shown gap as the answer carries it. */
export function gapItem({ g, bit, named }, ctx) {
  // (absent is reflected in `absence` below)
  const absence = (ctx.absences || []).find((a) => a.gap === g.id);
  return {
    gap: g.id,
    public_id: g.public_id,
    kind: g.kind,
    label: g.label,
    title: g.title,
    statement: g.statement,
    measured: g.last_good || g.measured,
    state: g.state,
    ...(g.notice ? { notice: g.notice } : {}),
    bit,
    named,
    ...(absence ? { absence: absence.line } : {}),
  };
}

/** The gaps' short statements for a case file's what_i_couldnt_answer (at most three). */
export function gapStatementsFor(data, caseId) {
  return liveGaps(data)
    .filter((g) => (g.touches || []).some((p) => p.case === caseId))
    .slice(0, MAX_SHOWN)
    .map((g) => ({ gap: g.id, statement: g.short, measured: g.last_good || g.measured }));
}

// --- note_unanswered (§8.2) --------------------------------------------------------

export const NOTE_UNANSWERED_TOOL = (data) => {
  const ids = liveGaps(data).map((g) => g.id);
  return {
    type: 'function',
    function: {
      name: 'note_unanswered',
      description:
        "When the records you read can't answer the person's question, or answer it only in part, note a citywide version of it. Returns the gap statements to use for any numbers about the gaps. Call it at most once per question.",
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'a citywide question: no street, block, ward, civic league or landmark, and no names' },
          answered: { type: 'string', enum: ['no', 'partly'] },
          // An empty enum can be refused by a provider: with no live gaps, no property.
          ...(ids.length ? { gaps: { type: 'array', maxItems: 2, items: { type: 'string', enum: ids } } } : {}),
        },
        required: ['question', 'answered'],
        additionalProperties: false,
      },
    },
  };
};

export const NOTE_UNANSWERED_NOTE =
  'Say plainly what the records you read couldn’t answer, using only the statements above for numbers about the gaps. Don’t say the question was added, and don’t guess at an answer.';

export function noteUnanswered(ctx, args = {}) {
  if (!ctx.gaps) throw new Error('Unknown tool note_unanswered');
  ctx.unanswered = ctx.unanswered || [];
  if (ctx.unanswered.length) return { noted: false, note: 'This question is already noted.' };
  // The refusal rules cover the whole turn: calls so far, and the calls
  // still to run in this batch. refilterUnanswered applies them again after
  // the loop, whatever order the calls came in.
  const facts = turnFacts(ctx, ctx.toolResults || [], ctx.batchCalls || []);
  if (facts.refused.some((r) => r.refusal === 'excluded' || r.refusal === 'denied_column')) return { noted: false };
  const restricted = facts.refused.some((r) => r.refusal === 'restricted');
  const answered = args.answered === 'partly' ? 'partly' : 'no';
  const live = liveGaps(ctx.gaps.data);
  const wanted = Array.isArray(args.gaps) ? args.gaps.slice(0, 2) : [];
  // A gap a later tool call in the batch may touch is noted (and re-checked
  // after the loop), but its statement comes back only when a call so far, or
  // a query still to run, touches it: a tool such as trees_on_my_block can
  // still miss the address and read nothing.
  const gaps = live.filter((g) => wanted.includes(g.id) && touches(g, facts));
  const said = gaps.filter((g) => touches(g, { ...facts, pendingTools: new Set() }));
  let question = '';
  if (!restricted) {
    question = String(args.question ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
    if (ruleA(question).length || publicTextViolations(question, { streets: ctx.gaps.streets }).length) question = '';
  }
  ctx.unanswered.push({ ...(question ? { question } : {}), answered, gaps: gaps.map((g) => g.id) });
  return {
    noted: true,
    statements: said.map((g) => ({ gap: g.id, statement: g.statement, measured: g.last_good || g.measured })),
    general_questions: said.flatMap((g) => g.questions.map((q) => q.text)),
    note: NOTE_UNANSWERED_NOTE,
  };
}

/**
 * After the loop: keep only named gaps this turn really touched, and apply
 * the refusal rules over the whole turn (§8.2 item 3): after an excluded or
 * withheld-column refusal nothing is noted, and after a restricted one the
 * question's text is dropped, whichever came first in the batch.
 */
export function refilterUnanswered(ctx, toolResults) {
  const facts = turnFacts(ctx, toolResults);
  if (facts.refused.some((r) => r.refusal === 'excluded' || r.refusal === 'denied_column')) return [];
  const restricted = facts.refused.some((r) => r.refusal === 'restricted');
  const live = new Map(liveGaps(ctx.gaps.data).map((g) => [g.id, g]));
  return (ctx.unanswered || []).map(({ question, ...u }) => ({ ...(question && !restricted ? { question } : {}), ...u, gaps: (u.gaps || []).filter((id) => live.has(id) && touches(live.get(id), facts)) }));
}

// --- Absence lines (§8.6; Inc 8) ----------------------------------------------------
// One adapter: trees_on_my_block. It writes a line only when the street query
// ran without error and found no Forestry removal on the street, and pairs
// only with the gap whose scope is that same query (Forestry removals). The
// street name appears only in the person's own answer.

export const ABSENCE_ADAPTERS = Object.freeze({
  trees_on_my_block: {
    gap: 'norfolk.work-orders.removal-no-street',
    line(result, gap, today) {
      const s = result?.on_your_street;
      if (!s || typeof s !== 'object' || 'error' in s) return null;
      if (!Array.isArray(s.by_task_and_reason) || s.by_task_and_reason.some((r) => r.task === 'Removal')) return null;
      // The plugin's GROUP BY stops at 50 rows: at the cap a Removal group may be cut off.
      if (s.by_task_and_reason.length >= 50) return null;
      if (!s.street || !Number.isFinite(Number(s.ward))) return null;
      const through = result.work_orders_cover?.to;
      const hm = gap.how_much || {};
      if (!through || !Number.isFinite(hm.part) || !Number.isFinite(hm.whole) || !gap.where?.status) return null;
      const measured = gap.last_good || gap.measured;
      return (
        `I found no Forestry work orders with task “Removal” on ${s.street} in ward ${Number(s.ward)} in the City's Work Orders records (qzfe-wj25), created through ${through}, as I read them on ${today}. ` +
        `In Siren's gap catalog, measured ${measured}, I found no street on ${fmt(hm.part)} of ${fmt(hm.whole)} Forestry removal work orders with status ${quoteStatuses(gap.where.status.as_recorded)} (${pct(hm.part, hm.whole)}%); a street search can't find those.`
      );
    },
  },
});

/** Run the absence adapter for one tool result; records the line on ctx when it passes its checks. */
export function absenceFor(ctx, name, value, today) {
  if (!ctx.gaps?.absenceLines) return;
  const a = ABSENCE_ADAPTERS[name];
  if (!a) return;
  const gap = liveGaps(ctx.gaps.data).find((g) => g.id === a.gap);
  if (!gap || gap.state === 'unmeasured_today') return;
  const line = a.line(value, gap, today);
  if (!line || gapCheck(line, 'absence').length) return;
  ctx.absences = [...(ctx.absences || []).filter((x) => x.gap !== gap.id), { gap: gap.id, line }];
}

/** The code-written trace step that says the catalog was read. No request. */
export function citeCatalog(ctx, n) {
  const data = ctx.gaps.data;
  return ctx.trace.record(
    { tool: `read the gap catalog: ${n} gap${n === 1 ? '' : 's'}, measured ${data.built}`, url: `${REPO}/docs/gaps-${data.city}.md` },
    async () => ({ result: null, rows: n })
  );
}

/** Markdown for the CLI: the panel, after the answer. */
export function gapsMarkdown(out) {
  if (!out?.shown?.length) return '';
  const lines = out.shown.map((g) => `- **${g.label}** · ${g.title}\n  ${g.statement} (measured ${g.measured}${g.notice ? `; ${g.notice}` : ''})${g.absence ? `\n  ${g.absence}` : ''}`);
  if (out.more) lines.push(`- ${out.more} more in the gap catalog`);
  return lines.join('\n');
}
