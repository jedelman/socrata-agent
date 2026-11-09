#!/usr/bin/env node
// Where a gap refresh goes (docs/gaps.md §5.4; Jason, 2026-11-09: "yes, we
// should automate the gap refresh"). A pure decision over the gap files
// before and after a rebuild: the approved catalog's built file
// (data/gaps/<city>.json) and each proposal set's built records (the `file`
// in data/gaps/proposed-<set>.trace.json).
//
//   "commit"  only measured numbers moved, each within ±25%, and dates: the
//             rebuild commits straight to main, as the legislation refresh does
//   "pr"      anything else in the gap files moved: a pull request for review
//   "none"    the gap files are unchanged
//
// Goes to a pull request (each is a reason in the result):
//   state          a gap's state changed (open, closing, closed, unmeasured_today)
//   board          a gap moved on or off the board
//   id_added       an id is in the file that wasn't
//   id_removed     an id left the file
//   number_jump    a measured number (MEASURED_NUMBERS) moved more than ±25%,
//                  zero to nonzero included
//   failed_measure a measure failed in this build: a gap on the board with its
//                  last good measurement (unmeasured_today), or off it unmeasured
//   evidence_unverified
//                  a gap off the board, or kept off, for want of verified evidence
//   finding_dropped
//                  a finding the gap cited before is gone from its evidence
//   shape          anything else in how_much changed: a number outside the
//                  measured list, a pattern, a quote, matched values, a
//                  series point or key added or removed
//   wording        a statement, short line or consequence line changed beyond
//                  its numbers and dates
//   catalog_fields a gap's other fields changed (title, questions, actions,
//                  touches, closed_when, hand-off, topic placements ...)
//   file_fields    the file's retired ids, not-a-gap list or actions changed,
//                  or a proposal set's entries did, or a file was added or removed
//
// Evidence beyond findings (query results, URLs, trace step numbers) isn't
// compared: it is the raw reads behind how_much, and its URLs carry the
// window dates. The upcoming-meetings list isn't a gap and is only noted.
//
//   node scripts/gap-refresh.js snapshot <dir>     copy the gap files, before a rebuild
//   node scripts/gap-refresh.js decide --before <dir> [--summary <file.md>] [--result <file.json>]
//        [--context <text>] [--verify-exit <n> --verify-log <file>]
//                                                  compare <dir> with the files now; print
//                                                  the decision, write the summary and result
//   node scripts/gap-refresh.js paths              every path a gap rebuild writes (for git add)
//
// verify-cases runs read-only before a live build (§5.4 step 1), but the
// build has no input for its result: it reads each finding's verification
// from the case files. So --verify-exit and --verify-log are a signal only:
// they go in the summary, loudly when a finding failed, and never change the
// decision.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CATALOGS, paths as catalogPaths, stateChanges } from './build-gaps.js';
import { PROPOSALS } from './build-gaps-proposed.js';
import { INVENTORY_PATHS } from './gaps-inventory.js';
import { fmt } from '../src/gaps/kinds.js';
import { publicTextViolations, compileStreets } from '../src/public-text.js';
import { STALE_DAYS } from './verify-cases.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The band, in percent: a measured number may move this far, either way, and still commit. */
export const BAND_PCT = 25;

/**
 * The measured numbers in a gap's how_much: counts a build reads from the
 * portal or a bundled file. `[*]` is one point of a keyed list (KEYED), `*` one
 * key of a map. test/gap-refresh.test.js holds every integer in the schema's
 * how_much to this list or NOT_MEASURED.
 */
export const MEASURED_NUMBERS = Object.freeze([
  'part', // rows with the thing absent (or present), of
  'whole', // the rows in scope
  'no_range', // the size gap's sub-counts
  'no_diameter',
  'series[*].part', // per year, keyed by k
  'series[*].whole',
  'window.part', // the trailing window
  'window.whole',
  'window.also.*',
  'by_status[*].part', // keyed by the statuses as recorded
  'by_status[*].whole',
  'all_time.part',
  'all_time.whole',
  'columns_absent.datasets.*', // columns read, per dataset
  'siblings.datasets.*',
  'backlog.whole',
  'backlog.with_end',
  'backlog.median_days',
  'problem_codes.codes[*].n', // keyed by value
  'catalog[*].result_set_size', // keyed by the search
  'values.count',
]);

/** Integers in how_much that aren't measured: compared exactly, so a change goes to review. */
export const NOT_MEASURED = Object.freeze(['policy.line']);

/** Dates: free to move. Every `read`, at any depth, and these. */
export const DATE_FIELDS = Object.freeze(['window.from', 'published.rows_updated', 'backlog.median_created']);

/** Lists in how_much whose points are matched by a key, not by position. */
export const KEYED = Object.freeze({
  series: (x) => x.k,
  by_status: (x) => (x.as_recorded || []).join(' or '),
  'problem_codes.codes': (x) => x.value,
  catalog: (x) => x.q,
});

// --- Paths in how_much ---------------------------------------------------------------------

// A path is a list of segments: { k } for an object key, { i } for a list point.
const show = (path) => path.map((s, n) => (s.k !== undefined ? `${n ? '.' : ''}${s.k}` : `[${s.i}]`)).join('');
const plain = (path) => path.filter((s) => s.k !== undefined).map((s) => s.k).join('.');
function parsePattern(p) {
  const out = [];
  for (const part of p.split('.')) {
    const m = /^([^[\]]+)((?:\[[^\]]*\])*)$/.exec(part);
    out.push({ k: m[1] });
    for (const b of m[2].match(/\[[^\]]*\]/g) || []) out.push({ i: b.slice(1, -1) });
  }
  return out;
}
const MEASURED = MEASURED_NUMBERS.map(parsePattern);
const matches = (pattern, path) =>
  pattern.length === path.length &&
  pattern.every((s, n) => (s.k !== undefined ? path[n].k !== undefined && (s.k === '*' || s.k === path[n].k) : path[n].i !== undefined && (s.i === '*' || s.i === path[n].i)));

export const isMeasured = (path) => MEASURED.some((p) => matches(p, path));
export const isDate = (path) => path.at(-1)?.k === 'read' || DATE_FIELDS.includes(show(path));

/** Every leaf of how_much, by its shown path: Map(path string -> { path, value }). */
export function flatten(howMuch) {
  const out = new Map();
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      const keyOf = KEYED[plain(path)];
      v.forEach((x, n) => walk(x, [...path, { i: keyOf && x && typeof x === 'object' ? String(keyOf(x)) : String(n) }]));
      if (!v.length) out.set(show(path), { path, value: '[]' });
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      for (const k of keys) walk(v[k], [...path, { k }]);
      if (!keys.length) out.set(show(path), { path, value: '{}' });
    } else {
      out.set(show(path), { path, value: v });
    }
  };
  walk(howMuch || {}, []);
  return out;
}

/** Within ±BAND_PCT of before, both ends included. Integer arithmetic, so 4 -> 5 (25%) is within. Zero to nonzero is a jump. */
export function withinBand(before, after) {
  if (before === after) return true;
  return Math.abs(after - before) * 100 <= BAND_PCT * Math.abs(before);
}

/** The change as shown: "+1.4%", "-100%", or "from 0". */
export function changePct(before, after) {
  if (before === 0) return 'from 0';
  const p = ((after - before) / Math.abs(before)) * 100;
  const r = Math.round(p * 10) / 10;
  if (r === 0) return `${p > 0 ? '+' : '-'}<0.1%`;
  return `${r > 0 ? '+' : ''}${r}%`;
}

// Text written by code from the numbers: compared with numbers and dates masked.
const ISO = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g;
export const maskNumbers = (s) => String(s ?? '').replace(ISO, '<date>').replace(/\d[\d,.]*/g, '#');
const maskDates = (s) => String(s ?? '').replace(ISO, '<date>');
const dropReads = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (k === 'read' || k === 'trace_n' ? undefined : x)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- One gap, in both files -------------------------------------------------------------------

/**
 * What moved in one gap that is in both files. Returns
 * { numbers: [{path, before, after, jump}], dates: [path], shape: [text],
 *   wording: [field], fields: [field], findings_dropped: ['case#id'] }.
 */
export function compareGap(before, after) {
  const out = { numbers: [], dates: [], shape: [], wording: [], fields: [], findings_dropped: [] };
  const a = flatten(before.how_much);
  const b = flatten(after.how_much);
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(key);
    const y = b.get(key);
    if (!x || !y) {
      out.shape.push(`how_much.${key} ${x ? 'removed' : 'added'}`);
      continue;
    }
    if (x.value === y.value) continue;
    if (isDate(x.path)) out.dates.push(`how_much.${key}`);
    else if (isMeasured(x.path) && Number.isInteger(x.value) && Number.isInteger(y.value)) out.numbers.push({ path: `how_much.${key}`, before: x.value, after: y.value, jump: !withinBand(x.value, y.value) });
    else out.shape.push(`how_much.${key}: ${JSON.stringify(x.value)} -> ${JSON.stringify(y.value)}`);
  }
  for (const k of ['measured', 'last_good']) if (before[k] !== after[k]) out.dates.push(k);
  for (const k of ['from', 'through']) if (before.where?.span?.[k] !== after.where?.span?.[k]) out.dates.push(`where.span.${k}`);

  // A notice comes only with a failed measure, a reason of its own.
  const texts = (g) => [['statement', g.statement], ['short', g.short], ...(g.questions || []).map((q) => [`${q.qid} consequence`, q.consequence])];
  const tb = new Map(texts(after));
  for (const [k, s] of texts(before)) if (maskNumbers(s) !== maskNumbers(tb.get(k))) out.wording.push(k);
  for (const [k] of texts(after)) if (!texts(before).some(([j]) => j === k)) out.wording.push(k);

  const findings = (g) => (g.evidence || []).filter((e) => e.type === 'finding').map((e) => `${e.case}#${e.id}`);
  const now = new Set(findings(after));
  out.findings_dropped = findings(before).filter((f) => !now.has(f));

  if (!same(dropReads(before.topic), dropReads(after.topic))) out.fields.push('topic');
  const rest = (g) => {
    // Compared elsewhere: state, how_much, evidence (findings), the code-written
    // text, the dates and the topic. Everything left comes from the catalog.
    const r = { ...g };
    for (const k of ['state', 'how_much', 'evidence', 'statement', 'short', 'notice', 'measured', 'last_good', 'topic']) delete r[k];
    const w = { ...(g.where || {}) };
    if (w.span) w.span = { field: w.span.field };
    r.where = w;
    r.questions = (g.questions || []).map((q) => {
      const x = { ...q };
      delete x.consequence;
      return x;
    });
    return r;
  };
  const ra = rest(before);
  const rb = rest(after);
  for (const k of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) if (!same(ra[k], rb[k])) out.fields.push(k);
  // Anything else that differs is a date or a read: in the evidence (read
  // times, the dates in window URLs, an index's build time) or in the text.
  const classified = out.numbers.length + out.dates.length + out.shape.length + out.wording.length + out.fields.length + out.findings_dropped.length;
  if (!classified && !same(before, after)) out.dates.push('dates in the evidence or text');
  return out;
}

// --- One file --------------------------------------------------------------------------------

const builtOf = (f) => `${f.built || 'undated'}${f.rebuilt ? `, rebuilt ${f.rebuilt}` : ''}`;
const EMPTY = Object.freeze({ gaps: [], off_board: [], retired: [], not_a_gap: [], actions: [] });
const placeOf = (f, id) => (f.gaps.some((g) => g.id === id) ? 'board' : f.off_board.some((o) => o.id === id) ? 'off' : 'absent');

/**
 * Compare one gap file's before and after. `source` is { set, file }; `before`
 * and `after` are { board, entries } (entries only for a proposal set), or
 * null for a file that isn't there. `streets` (compiled) withholds text read
 * from the portal or written by a failing build that fails the public-text
 * checks, as the inventory does: the summary goes in a public pull request.
 * Returns { set, file, changed, built, reasons, gaps, meetings_changed }.
 */
export function compareSet(source, before, after, { streets } = {}) {
  const set = source.set;
  const reasons = [];
  const add = (id, rule, detail) => reasons.push({ set, id, rule, detail });
  const shown = (text) => (publicTextViolations(text, { streets }).length ? 'withheld here: the text failed the public-text checks (the build output and the file hold it)' : text);
  const fa = before?.board || EMPTY;
  const fb = after?.board || EMPTY;
  if (!before && after) add(null, 'file_fields', `${source.file} is new`);
  if (before && !after) add(null, 'file_fields', `${source.file} is gone`);

  // Ids and states, as build-gaps --same-states sees them.
  for (const line of stateChanges(fa, fb)) {
    const id = line.slice(0, line.indexOf(': '));
    const pa = placeOf(fa, id);
    const pb = placeOf(fb, id);
    add(id, pa === 'absent' ? 'id_added' : pb === 'absent' ? 'id_removed' : pa !== pb ? 'board' : 'state', line.slice(id.length + 2));
  }
  // A failed measure, or evidence left unverified, in this build.
  for (const g of fb.gaps) {
    if (g.state === 'unmeasured_today') add(g.id, 'failed_measure', g.notice || `on the board with its last measurement, from ${g.last_good}`);
    if (g.state === 'evidence_unverified') add(g.id, 'evidence_unverified', 'on the board with evidence unverified');
  }
  for (const o of fb.off_board) add(o.id, o.state === 'evidence_unverified' ? 'evidence_unverified' : 'failed_measure', `off the board (${o.state}): ${shown(String(o.reason).slice(0, 300))}`);

  // Gaps on the board in both.
  const gaps = [];
  const prev = new Map(fa.gaps.map((g) => [g.id, g]));
  for (const g of fb.gaps) {
    const p = prev.get(g.id);
    if (!p) continue;
    const c = compareGap(p, g);
    for (const n of c.numbers) if (n.jump) add(g.id, 'number_jump', `${n.path} ${fmt(n.before)} -> ${fmt(n.after)} (${changePct(n.before, n.after)}), beyond ±${BAND_PCT}%`);
    for (const s of c.shape) add(g.id, 'shape', shown(s));
    if (c.wording.length) add(g.id, 'wording', `${c.wording.join(', ')} changed beyond numbers and dates`);
    if (c.fields.length) add(g.id, 'catalog_fields', `${c.fields.join(', ')} changed`);
    for (const f of c.findings_dropped) add(g.id, 'finding_dropped', `finding ${f} is gone from its evidence`);
    gaps.push({ id: g.id, state: g.state, ...c });
  }

  // The file's other fields.
  const listOf = (f, k) => f[k] || [];
  if (!same(listOf(fa, 'retired'), listOf(fb, 'retired'))) add(null, 'file_fields', 'the retired ids changed');
  if (!same(listOf(fa, 'not_a_gap'), listOf(fb, 'not_a_gap'))) add(null, 'file_fields', 'the not-a-gap list changed');
  const actions = (f) => listOf(f, 'actions').map((x) => JSON.parse(maskDates(JSON.stringify(x))));
  if (!same(actions(fa), actions(fb))) add(null, 'file_fields', 'the actions changed beyond their dates');
  if ((fa.city ?? null) !== (fb.city ?? null)) add(null, 'file_fields', 'the city changed');
  if (before && after && !same(before.entries ?? null, after.entries ?? null)) add(null, 'file_fields', "the proposal set's entries changed");

  const strip = (x) => (x ? { board: x.board, entries: x.entries ?? null } : null);
  return {
    set,
    file: source.file,
    changed: !same(strip(before), strip(after)),
    built: { before: before ? builtOf(fa) : null, after: after ? builtOf(fb) : null },
    reasons,
    gaps,
    meetings_changed: !same(fa.meetings ?? null, fb.meetings ?? null),
  };
}

/**
 * The decision over every gap file. `pairs` is [{ source, before, after }];
 * `verify` is { exit, flagged } or null (a signal only); `streets` the street
 * names the public-text checks refuse. Returns the machine-readable result.
 */
export function decide(pairs, { verify = null, streets = [] } = {}) {
  const compiled = compileStreets(streets);
  const sets = pairs.map(({ source, before, after }) => compareSet(source, before, after, { streets: compiled }));
  const reasons = sets.flatMap((s) => s.reasons);
  const changed = sets.some((s) => s.changed);
  return {
    decision: !changed ? 'none' : reasons.length ? 'pr' : 'commit',
    band_pct: BAND_PCT,
    reasons,
    sets,
    verify: verify ? { signal_only: true, exit: verify.exit, failed: verify.exit !== 0, flagged: verify.flagged || [] } : null,
  };
}

// --- The summary ---------------------------------------------------------------------------

const MAX_LINES = 40;
const RULE_WORDS = {
  state: 'state changed',
  board: 'moved on or off the board',
  id_added: 'id added',
  id_removed: 'id removed',
  number_jump: `measured number beyond ±${BAND_PCT}%`,
  failed_measure: 'failed measure',
  evidence_unverified: 'evidence unverified',
  finding_dropped: 'finding dropped',
  shape: 'shape changed',
  wording: 'wording changed',
  catalog_fields: 'catalog fields changed',
  file_fields: 'file changed',
};

/** The commit message body or pull request body: short, plain Markdown, no headings. */
export function renderSummary(result, { context = '' } = {}) {
  const L = [];
  const head = {
    none: 'No change to the gap files.',
    commit: `Only measured numbers moved, each within ±${BAND_PCT}%, and dates: nothing in the gap files needs review (docs/gaps.md §5.4).`,
    pr: `Needs review (docs/gaps.md §5.4): ${result.reasons.length} reason${result.reasons.length === 1 ? '' : 's'} below.`,
  }[result.decision];
  L.push(`Gap refresh: ${result.decision}. ${head}`, '');
  if (context) L.push(context, '');
  if (result.decision === 'pr') {
    L.push('Why it needs review:', '');
    const lines = result.reasons.map((r) => `- ${r.id ? `\`${r.id}\`` : r.set} (${RULE_WORDS[r.rule] || r.rule}): ${r.detail}`);
    L.push(...lines.slice(0, MAX_LINES));
    if (lines.length > MAX_LINES) L.push(`- and ${lines.length - MAX_LINES} more (see the result file in the job's log)`);
    L.push('');
  }
  for (const s of result.sets) {
    L.push(`${s.set} (\`${s.file}\`): before, built ${s.built.before || 'none (no file)'}; after, built ${s.built.after || 'none (no file)'}:`, '');
    if (!s.changed) {
      L.push('- unchanged', '');
      continue;
    }
    const lines = [];
    let datesOnly = 0;
    for (const g of s.gaps) {
      const bits = g.numbers.map((n) => `${n.path.replace(/^how_much\./, '')} ${fmt(n.before)} -> ${fmt(n.after)} (${changePct(n.before, n.after)}${n.jump ? ', beyond the band' : ''})`);
      const extra = s.reasons.filter((r) => r.id === g.id && !['number_jump'].includes(r.rule)).length;
      if (!bits.length && !extra) {
        if (g.dates.length) datesOnly++;
        continue;
      }
      if (bits.length > 6) bits.splice(6, bits.length - 6, `${g.numbers.length - 6} more number${g.numbers.length === 7 ? '' : 's'}`);
      lines.push(`- \`${g.id}\` (${g.state}): ${bits.length ? bits.join('; ') : 'no measured number moved'}${extra ? `; ${extra} other change${extra === 1 ? '' : 's'} listed above` : ''}`);
    }
    const listed = new Set(s.gaps.map((g) => g.id));
    for (const id of [...new Set(s.reasons.map((r) => r.id).filter((id) => id && !listed.has(id)))]) lines.push(`- \`${id}\`: see above`);
    L.push(...lines.slice(0, MAX_LINES));
    if (lines.length > MAX_LINES) L.push(`- and ${lines.length - MAX_LINES} more`);
    if (datesOnly) L.push(`- ${datesOnly} gap${datesOnly === 1 ? '' : 's'}: dates only`);
    if (s.meetings_changed) L.push('- the upcoming-meetings list was re-read (not a gap)');
    if (!lines.length && !datesOnly) L.push(s.reasons.some((r) => !r.id) ? '- changed outside the gaps (see above)' : '- no gap changed; only the file’s own dates did (the rebuild date, action frames)');
    L.push('');
  }
  if (result.verify) {
    const v = result.verify;
    L.push(
      v.failed
        ? `Case files: verify-cases (read-only) FAILED (exit ${v.exit}). The gap build reads each finding's verification from the case files, not from this run, so this result is a signal only and changed nothing here: a finding that failed stays cited until a steward marks it unverified, or its last check is more than ${STALE_DAYS} days old. Fix or mark the finding:`
        : `Case files: verify-cases (read-only) passed (exit ${v.exit}); a signal only, since the gap build reads each finding's verification from the case files.${v.flagged.length ? ' Lines to look at:' : ''}`,
      ''
    );
    if (v.flagged.length) {
      L.push('```', ...v.flagged.slice(0, 20), ...(v.flagged.length > 20 ? [`... and ${v.flagged.length - 20} more`] : []), '```', '');
    }
  }
  return `${L.join('\n').replace(/\n+$/, '')}\n`;
}

// --- Files -----------------------------------------------------------------------------------

/** The gap files the decision reads: each approved catalog's built file, each proposal set's built trace. */
export function gapSources({ catalogs = CATALOGS, proposals = PROPOSALS } = {}) {
  return [
    ...Object.keys(catalogs)
      .sort()
      .map((city) => ({ set: `approved ${city}`, file: catalogPaths(city).file, read: (j) => ({ board: j, entries: null }) })),
    ...Object.entries(proposals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, p]) => ({ set: `proposed ${name}`, file: p.trace, read: (j) => ({ board: j.file, entries: j.entries }) })),
  ];
}

/** Every path a gap rebuild writes, for git add and restore: data/gaps and each page. */
export function gapPaths({ catalogs = CATALOGS, proposals = PROPOSALS } = {}) {
  const all = new Set(['data/gaps', INVENTORY_PATHS.doc]);
  for (const city of Object.keys(catalogs)) all.add(catalogPaths(city).doc);
  for (const p of Object.values(proposals)) all.add(p.doc);
  for (const p of all) if (p !== 'data/gaps' && !p.startsWith('docs/')) throw new Error(`Unexpected gap path ${p}.`);
  return [...all].sort();
}

/** The lines of a verify-cases log worth showing: failures (XX) and findings to look at (??). */
export function flaggedLines(log) {
  return String(log || '')
    .split('\n')
    .filter((l) => /^\s+(XX|\?\?) /.test(l))
    .map((l) => l.trim());
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

/** Read the before files from `dir` and the after files from `root`, and decide. */
export function decideFiles({ beforeDir, root = ROOT, verify = null, sources = gapSources(), catalogs = CATALOGS }) {
  const pairs = sources.map((source) => {
    const b = readJson(join(beforeDir, basename(source.file)));
    const a = readJson(join(root, source.file));
    return { source, before: b && source.read(b), after: a && source.read(a) };
  });
  const streets = Object.keys(catalogs).flatMap((city) => readJson(join(root, catalogPaths(city).streets))?.streets || []);
  return decide(pairs, { verify, streets });
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'paths') {
    console.log(gapPaths().join('\n'));
    return;
  }
  if (cmd === 'snapshot') {
    if (!rest[0]) throw new Error('snapshot needs a directory.');
    mkdirSync(rest[0], { recursive: true });
    for (const s of gapSources()) {
      const from = join(ROOT, s.file);
      if (existsSync(from)) copyFileSync(from, join(rest[0], basename(s.file)));
    }
    console.log(`Copied ${gapSources().map((s) => s.file).join(', ')} to ${rest[0]}.`);
    return;
  }
  if (cmd === 'decide') {
    const { values } = parseArgs({
      args: rest,
      options: { before: { type: 'string' }, summary: { type: 'string' }, result: { type: 'string' }, context: { type: 'string', default: '' }, 'verify-exit': { type: 'string' }, 'verify-log': { type: 'string' } },
    });
    if (!values.before) throw new Error('decide needs --before <dir> (from gap-refresh.js snapshot).');
    const verify = values['verify-exit'] !== undefined && values['verify-exit'] !== '' ? { exit: Number(values['verify-exit']), flagged: values['verify-log'] && existsSync(values['verify-log']) ? flaggedLines(readFileSync(values['verify-log'], 'utf8')) : [] } : null;
    const result = decideFiles({ beforeDir: values.before, verify });
    const summary = renderSummary(result, { context: values.context });
    if (values.summary) writeFileSync(values.summary, summary);
    if (values.result) writeFileSync(values.result, `${JSON.stringify(result, null, 2)}\n`);
    console.log(summary);
    console.log(`decision=${result.decision}`);
    return;
  }
  throw new Error('Usage: gap-refresh.js snapshot <dir> | decide --before <dir> [--summary f] [--result f] [--context t] [--verify-exit n --verify-log f] | paths');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
