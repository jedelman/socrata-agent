// Gap kinds, their labels, the statement templates every gap is rendered
// from, and the text rules gap text has to pass (docs/gaps.md §3.1, §6).
//
// A gap has a shape and consequences, nothing else: no cause, no hypothesis,
// no prediction, no "may". These rules hold code-written text to that.
// src/voice.js stays unchanged; it runs alongside them.

import { stripQuoted } from './text-utils.js';
import { voiceViolations } from '../voice.js';
import { publicTextViolations } from '../public-text.js';

// Labels are drafts for J24 (final copy). Each is written as a report.
export const KINDS = Object.freeze({
  no_records: 'I found no records (sources checked)',
  missing_field: 'Absent or empty field (in the records I read)',
  partial_coverage: 'Partial coverage (in the records I read)',
  stale: 'Survey date stated by the source',
  created_on_or_after_end: 'Created on or after its end date',
  restricted: "Out of Siren's reach by rule",
  not_online: 'Not found at the pages checked',
  no_decision_record: 'No field naming who decided (in the records I read)',
});
export const KIND_ORDER = Object.keys(KINDS);

// Headers and panel titles (drafts for J24).
export const PANEL_TITLE = "What I couldn't answer from the records I read";
export const QUESTIONS_HEADING = "Questions these records can't answer, or answer only in part";

// --- Formatting -------------------------------------------------------------

export const fmt = (n) => Number(n).toLocaleString('en-US');
/** A whole-number percentage of part in whole. */
export const pct = (part, whole) => (whole ? Math.round((Number(part) / Number(whole)) * 100) : 0);
/** Statuses quoted as the City records them: “New Work Order” or “On-Going”. */
export const quoteStatuses = (labels) => {
  const q = labels.map((l) => `“${l}”`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} or ${q.at(-1)}`;
};
const list = (xs, last = 'and') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${last} ${xs.at(-1)}`);
/** A source as statements name it: the City's Work Orders records (qzfe-wj25). */
export const sourceName = (s) => `${s.phrase} (${s.id})`;

// --- Statement templates ----------------------------------------------------
// Every template takes values computed by code from a dated query, metadata or
// a bundled file, and returns one or more sentences that each hold a reading
// frame and, with any number, a date (rules B and I16).

export const T = Object.freeze({
  /** missing_field (share): part of whole with something absent. */
  share: ({ part, whole, scope, status, absent, source, span, read, leaving_out }) =>
    `I found ${fmt(part)} of ${fmt(whole)} ${scope}${status ? ` with status ${quoteStatuses(status)}` : ''} (${pct(part, whole)}%) ${absent} in ${sourceName(source)}${leaving_out ? `, ${leaving_out}` : ''}${span ? `, created ${span.from} through ${span.through}` : ''}, as I read ${source.pronoun || 'them'} on ${read}.`,
  /** A trailing-window line under a share. */
  windowLine: ({ whole, part, status, since, absent, also, read }) =>
    `Of the ${fmt(whole)} with status ${quoteStatuses(status)} created since ${since}, I found ${fmt(part)} with ${absent}${also ? `, and ${fmt(also.part)} of those ${fmt(part)} with ${also.absent} either` : ''}, as I read them on ${read}.`,
  /** A by-status line under a share. */
  statusLine: ({ whole, part, status, absent, read }) =>
    `Of the ${fmt(whole)} with status ${quoteStatuses(status)}, I found ${fmt(part)} with ${absent}, as I read them on ${read}.`,
  /** missing_field (columns): no column for a concept in one dataset. */
  columnsAbsent: ({ concept, count, source, read, data = false }) =>
    `I found no column ${concept} among the ${fmt(count)} ${data ? 'data ' : ''}columns of ${sourceName(source)}, as I read them on ${read}.`,
  /** No column for a concept in any topic dataset. */
  columnsAbsentTopic: ({ concept, datasets, topic, read }) =>
    `I found no column ${concept} in any of the ${fmt(datasets.length)} ${topic} datasets I read (${datasets.join(', ')}), as I read them on ${read}.`,
  /** A field described in the source's own words. */
  fieldQuote: ({ field, quote }) => `Its description of ${field}, in its words: “${quote}”`,
  /** The backlog line: open orders, with a median age. */
  backlog: ({ whole, scope, status, with_end, median_days, read }) =>
    `I found ${fmt(whole)} ${scope} with status ${quoteStatuses(status)} (${fmt(with_end)} of them with an end date), a median of ${fmt(median_days)} days since created, as I read them on ${read}.`,
  createdOnOrAfterEnd: ({ whole, scope, status, from, through, part, before, same, source, read }) =>
    `Of ${fmt(whole)} ${scope} with status ${quoteStatuses(status)} and an end date from ${from} through ${through}, I found ${fmt(part)} (${pct(part, whole)}%) with an end date on or before the day they were created (${fmt(before)} before it, ${fmt(same)} the same day), in ${sourceName(source)}, as I read them on ${read}.`,
  /** stale: the source dates its own observations, quoted whole. */
  stale: ({ owner, source, read, quote }) => `${owner} own description (${source.id}), as I read it on ${read}, says: “${quote}”`,
  /** A finding quoted, never its claim. */
  findingQuote: ({ who, quote, checked }) => `${who} says: “${quote}” (quote checked ${checked}).`,
  /** A count over part of whole, for a contrasting measure. */
  partOf: ({ what, part, whole, scope, status, read }) =>
    `I found ${what} on ${fmt(part)} of ${fmt(whole)} ${scope}${status ? ` with status ${quoteStatuses(status)}` : ''} (${pct(part, whole)}%), as I read them on ${read}.`,
  catalogSearch: ({ portal, searches, read }) =>
    `I found ${searches.map((s, i) => `${i === 0 ? '' : i === searches.length - 1 ? ', and ' : ', '}${fmt(s.result_set_size)} ${i === 0 ? `datasets in ${portal} catalog for the search` : 'for'} “${s.q}”${s.open && s.result_set_size ? `, ${s.open === s.result_set_size ? 'all ' : `${fmt(s.open)} `}open to Siren: ${s.names.join(', ')}` : ''}`).join('')} (searched ${read}).`,
  valuesAbsent: ({ count, what, source, terms, read }) =>
    `I found ${fmt(count)} ${what} in ${sourceName(source)}, none matching ${list(terms.map((t) => `“${t}”`), 'or')}, as I read them on ${read}.`,
  restricted: ({ name, id, read, reason }) =>
    `I don't query ${name} (${id}) for open-ended questions. Siren's rule, read from its city profile on ${read}, in its words: “${reason}”`,
  index: ({ part, whole, what, absent, index, built, from, through, consequence }) =>
    `I found ${absent} in the titles of ${fmt(part)} of ${fmt(whole)} ${what} (${pct(part, whole)}%) in ${index} (built ${built}, meetings ${from} through ${through}), so ${consequence}.`,
  consequencePart: ({ source, finding, measured, tail }) =>
    `With ${sourceName(source)} I can answer this only in part: ${finding}, measured ${measured}${tail ? `, ${tail}` : ''}.`,
  consequenceAll: ({ concept, datasets, topic, measured }) =>
    `I found no column ${concept} in any of the ${fmt(datasets.length)} ${topic} datasets I read (${datasets.join(', ')}), measured ${measured}, so I can't answer this from them.`,
  consequenceRestricted: ({ name, read }) => `I can't answer this: I don't query ${name} for open-ended questions, by Siren's rule as read on ${read}.`,
  consequenceNoRecords: ({ what, read }) => `I can't answer this from the records I read: I found no record of ${what} in them, searched ${read}.`,
  unmeasured: ({ today, last }) => `I couldn't measure this on ${today}. I show my last measurement, from ${last}.`,
});

// --- Rule A: banned outside quotes, for every type -----------------------
const APOS = "['’]";
const RULE_A_WORDS = new RegExp(
  [
    'never', 'always', 'no longer',
    'ha(?:s|ve) not been', `ha(?:s|ve)n${APOS}t been`,
    'do(?:es)? not exist', '(?:is|are) missing',
    'will', `won${APOS}t`, 'going to', 'scheduled to',
    'may', 'might', 'could', 'likely', 'unlikely', 'probably', 'perhaps', 'possibly', 'suggests?', 'appears? to', 'seems?',
  ].map((w) => `\\b${w}\\b`).join('|'),
  'gi'
);
// "does not", "didn't" and the rest, unless the subject is "I" or "Siren".
// Case-insensitive, so "Does not ..." at a sentence's start and "DOES NOT" count.
const RULE_A_NEGATION = new RegExp(`(?<!\\b(?:I|Siren) )\\b(?:does|do|did)(?:n${APOS}t| not)\\b`, 'gi');

const hits = (re, text) => [...text.matchAll(re)].map((m) => m[0]);

/** Rule A hits in text (quoted spans stripped first). */
export function ruleA(text) {
  const clean = stripQuoted(String(text || ''));
  return [...hits(RULE_A_WORDS, clean), ...hits(RULE_A_NEGATION, clean)].map((w) => `A: "${w}"`);
}

// --- Rule B: a reading frame, for statements and the like ----------------
const FRAMES = new RegExp(
  [
    'I found', `I can${APOS}t`, 'I can answer [^.]*only in part', `I couldn${APOS}t`, `I don${APOS}t query`,
    'as I read', 'checked', 'searched', 'measured \\d{4}-\\d{2}-\\d{2}', 'counted by code', 'Siren drafted', 'through Siren', `Siren${APOS}s rule`,
  ].join('|')
);
const ATTRIBUTED = /(?:says|in its words|in their words):\s*“/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;
const HAS_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const DATASET_ID = /\b[a-z0-9]{4}-[a-z0-9]{4}\b/g;
/** Names with digits in them that aren't counts. */
export const NAME_ALLOWLIST = Object.freeze(['MyNorfolk 311']);

const dropAllowed = (s, allow) => allow.reduce((t, a) => t.split(a).join(' '), s);
function hasNumber(s, allow) {
  const t = dropAllowed(s, allow).replace(DATASET_ID, ' ').replace(ISO_DATE, ' ').replace(/\bFY\d{4}\b/g, ' ');
  return /\b\d[\d,.]*%?/.test(t);
}

/** Split into sentences, never inside a “quotation”. */
export function sentences(text) {
  const spans = [];
  const prot = String(text).replace(/“[^”]*”/g, (m) => {
    spans.push(m);
    return `\u0000${spans.length - 1}\u0000`;
  });
  return prot
    // Any sentence start counts (a digit, a quote, a lowercase word), so a
    // sentence can't borrow the frame or date of the one before it. Common
    // abbreviations ("Va.", "No.", "St.", "Sec.") don't end a sentence.
    .split(/(?<=[.?!;])(?<!\b(?:Va|No|Nos|St|Sec|Secs|Mr|Mrs|Ms|Mx|Dr|Ave|Rd|Blvd|Inc|Jr|Sr|Co|Corp|vs|Ch|Art|U\.S|e\.g|i\.e)\.)\s+(?=\S)/)
    .map((s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]))
    .filter((s) => s.trim());
}

export function ruleB(text, { allow = NAME_ALLOWLIST } = {}) {
  const out = [];
  for (const s of sentences(text)) {
    const c = stripQuoted(s);
    const num = hasNumber(c, allow);
    if ((num || /\bno\b/i.test(c)) && !FRAMES.test(c) && !ATTRIBUTED.test(s)) out.push(`B: no reading frame: ${s.slice(0, 80)}`);
    if (num && !HAS_DATE.test(s)) out.push(`B: a number with no date: ${s.slice(0, 80)}`);
  }
  return out;
}

// --- Rule C: noun phrases, for titles, labels, chips, headers ------------
const C_VERBS = /\b(?:is|are|was|were|exists?|has|have|had|missing)\b/i;
export function ruleC(text, { allow = NAME_ALLOWLIST } = {}) {
  const t = dropAllowed(String(text), allow);
  const out = [];
  if (/\d/.test(t)) out.push('C: digits in a title or label');
  const verb = stripQuoted(t).match(C_VERBS);
  if (verb) out.push(`C: "${verb[0]}" in a title or label`);
  return out;
}

const B_TYPES = new Set(['statement', 'short', 'consequence', 'absence', 'bot']);
const C_TYPES = new Set(['title', 'label', 'chip', 'panel', 'header']);
export const TEXT_TYPES = Object.freeze([...B_TYPES, ...C_TYPES, 'steward_note', 'prefill', 'question', 'action']);

/**
 * The gap rules for one string of a given type (docs/gaps.md §6.2). Rule A
 * applies to every type; rule B to statements, consequence lines, absence
 * lines and bot text; rule C to titles, labels, chips, panel titles and
 * headers. Steward notes may hold digits only as dates, dataset ids, or
 * numbers equal to a stored measure (`measures`). For 'question' (residents'
 * words and general questions) the result is a hint for the steward, never a
 * block; callers decide. Returns [] when the text passes.
 */
export function gapTextViolations(text, type, { allow = NAME_ALLOWLIST, measures = [] } = {}) {
  if (!TEXT_TYPES.includes(type)) throw new Error(`Unknown gap text type "${type}".`);
  const out = ruleA(text);
  if (B_TYPES.has(type)) out.push(...ruleB(text, { allow }));
  if (C_TYPES.has(type)) out.push(...ruleC(text, { allow }));
  if (type === 'steward_note') {
    const ok = new Set(measures.map((m) => String(m).replace(/,/g, '')));
    const t = dropAllowed(String(text), allow).replace(DATASET_ID, ' ').replace(ISO_DATE, ' ');
    for (const m of t.matchAll(/\b\d[\d,.]*/g)) {
      const n = m[0].replace(/[,.]$/, '').replace(/,/g, '');
      if (!ok.has(n)) out.push(`steward note: the number ${m[0]} is not a date, an id or a stored measure`);
    }
  }
  return out;
}

/** voiceViolations plus the gap rules for the type: what every code-written gap string must pass. */
export function gapCheck(text, type, opts) {
  return [...voiceViolations(text).map((v) => `voice: ${v}`), ...gapTextViolations(text, type, opts)];
}

// --- Siren's answers when gaps are on (§6.4) ---------------------------------
// A rule A subset: world claims and predictions, plus "there will/may/... be".
// Hedges are left out, because answers address the reader ("you may").
const WORLD = new RegExp(
  [
    'never', 'always', 'no longer', 'ha(?:s|ve) not been', `ha(?:s|ve)n${APOS}t been`, 'do(?:es)? not exist', '(?:is|are) missing',
    'will', `won${APOS}t`, 'going to', 'scheduled to', 'there (?:will|may|might|could|would) be',
  ].map((w) => `\\b${w}\\b`).join('|'),
  'gi'
);
export function worldClaimViolations(answer) {
  const clean = stripQuoted(String(answer || ''));
  const found = [];
  for (const m of clean.matchAll(WORLD)) {
    const start = Math.max(0, m.index - 40);
    found.push(clean.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim());
  }
  return found;
}

export const GAP_REWRITE_ADDENDUM =
  'Also rewrite every sentence that claims what is true of the world in general or what will happen ' +
  '("never", "always", "no longer", "has not been", "does not exist", "is missing", "will", "going to", "scheduled to", "there will be") ' +
  'so it reports what the records you read show, as of when you read them. Use only numbers from the tool results.';

// --- The bot (§10.3; Inc 9) --------------------------------------------------
// botText is pure. A bot that posts it must still run a daily cap and a kill
// switch; none exists yet.
export const BOT_PREFIX = Object.freeze({
  no_records: 'Not in the records Siren reads:',
  restricted: "Out of Siren's reach by rule:",
  not_online: 'Not found at the pages checked:',
});
const DEFAULT_PREFIX = 'Gap in the records Siren reads:';
export const BOT_MAX_GRAPHEMES = 300;
export const BOT_MAX_AGE_DAYS = 14;

export function graphemes(s) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length;
  return [...s].length;
}

const daysBetween = (a, b) => Math.floor((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

/**
 * A post about one gap, from code-written text only: the gap's short
 * statement and, when given, a demand line counted by code. Never residents'
 * words. Refuses unless the gap is open and measured at most 14 days before
 * `today` (YYYY-MM-DD). Every check runs before the link is appended, and the
 * whole post, link included, stays within 300 graphemes.
 * demand: { raised, as_of } (raises of questions code linked to the gap).
 * When the post with the demand line would run over, the demand line is
 * dropped (and `demand_dropped` set). Returns { ok: true, text } or
 * { ok: false, reason }.
 */
export function botText(gap, demand = null, { today, link = '', streets } = {}) {
  if (!gap || typeof gap !== 'object') return { ok: false, reason: 'no gap' };
  if (gap.state !== 'open') return { ok: false, reason: `the gap is ${gap.state || 'in no state'}, not open` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return { ok: false, reason: 'today must be a YYYY-MM-DD date' };
  const measured = String(gap.measured || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(measured)) return { ok: false, reason: 'the gap has no measured date' };
  const age = daysBetween(measured, today);
  if (!(age >= 0 && age <= BOT_MAX_AGE_DAYS)) return { ok: false, reason: `the measure is ${age} days old; the bot posts only measures at most ${BOT_MAX_AGE_DAYS} days old` };
  if (!gap.short) return { ok: false, reason: 'the gap has no short statement' };
  const base = `${BOT_PREFIX[gap.kind] || DEFAULT_PREFIX} ${gap.short}`;
  let demandLine = '';
  if (demand && Number(demand.raised) > 0) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(demand.as_of || ''))) return { ok: false, reason: 'the demand count has no date' };
    const n = Number(demand.raised);
    demandLine = ` Questions linked to it were raised ${fmt(n)} time${n === 1 ? '' : 's'} through Siren as of ${demand.as_of}; one person can raise more than once.`;
  }
  // With the demand line first; when the post would run over, without it.
  let last = null;
  for (const text of demandLine ? [base + demandLine, base] : [base]) {
    const bad = [...gapCheck(text, 'bot'), ...publicTextViolations(text, { streets })];
    if (bad.length) return { ok: false, reason: `the text fails a check: ${bad[0]}` };
    const out = link ? `${text} ${link}` : text;
    if (graphemes(out) <= BOT_MAX_GRAPHEMES) return { ok: true, text: out, ...(demandLine && text === base ? { demand_dropped: true } : {}) };
    last = out;
  }
  return { ok: false, reason: `the post is ${graphemes(last)} graphemes; the limit is ${BOT_MAX_GRAPHEMES}` };
}
