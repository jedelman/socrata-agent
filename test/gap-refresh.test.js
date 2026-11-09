// The gap refresh decision (docs/gaps.md §5.4, §15 item 2 "the refresh split,
// as a dry run"): numbers within ±25% and dates go to main; anything else to
// a pull request. No network: real rebuilds replay the stored responses
// against the pinned case files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  BAND_PCT,
  MEASURED_NUMBERS,
  NOT_MEASURED,
  DATE_FIELDS,
  withinBand,
  changePct,
  flatten,
  isMeasured,
  isDate,
  maskNumbers,
  compareGap,
  decide,
  decideFiles,
  renderSummary,
  gapSources,
  gapPaths,
  flaggedLines,
} from '../scripts/gap-refresh.js';
import { buildGaps, Recorder } from '../scripts/build-gaps.js';
import { buildProposed } from '../scripts/build-gaps-proposed.js';
import { GAP_RECORD } from '../src/gaps/schema.js';
import { pinnedRepo, replayedGaps, pinnedRepoToday } from './fixtures/gaps-pinned.js';
import { fmt } from '../src/gaps/kinds.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TRACE = JSON.parse(read('data/gaps/norfolk.trace.json'));
const PTRACE = JSON.parse(read('data/gaps/proposed-norfolk-budget.trace.json'));
const FULL = await replayedGaps();
// The proposal set replayed the same way: every proposed entry measured,
// whatever state the committed trace is in.
const PROPOSED = (await buildProposed({ recorder: new Recorder({ responses: PTRACE.responses }), today: PTRACE.built, repoToday: pinnedRepoToday(PTRACE.built), repo: pinnedRepo })).trace;

const SOURCES = gapSources();
const APPROVED = SOURCES.find((s) => s.set === 'approved norfolk');
const BUDGET = SOURCES.find((s) => s.set === 'proposed norfolk-budget');
const side = (board, entries = null) => (board ? { board, entries } : null);
/** Decide over the approved file alone. */
const approved = (before, after) => decide([{ source: APPROVED, before: side(before), after: side(after) }]);
const rules = (r) => [...new Set(r.reasons.map((x) => x.rule))].sort();
const clone = () => structuredClone(FULL);
const gapIn = (f, id) => f.gaps.find((g) => g.id === id);

const NO_STREET = 'norfolk.work-orders.removal-no-street';
const LINE_CLEARANCE = 'norfolk.utility.line-clearance';
const RESTRICTED = 'norfolk.311.restricted';
const NO_ADDRESS = 'norfolk.legislation.no-address';

// The stored responses move on every week (refresh-gaps.yml), so numbers here
// come from the replay, never from a copy of them.
const REPLAY_DAY = pinnedRepoToday(TRACE.built);
// A rebuild day other than the replay's, within the pinned case files' freshness.
const OTHER_DAY = REPLAY_DAY === '2026-11-16' ? '2026-11-17' : '2026-11-16';

/** A real offline rebuild: the stored responses, the pinned case files, and the agenda index as `index` leaves it. */
async function rebuild({ repoToday = OTHER_DAY, index = (x) => x } = {}) {
  const repo = (p) => {
    const text = pinnedRepo(p);
    if (p !== 'data/norfolk-legislation.json') return text;
    const idx = JSON.parse(text);
    idx.built = `${repoToday}T09:17:00.000Z`;
    return JSON.stringify(index(idx));
  };
  return (await buildGaps({ recorder: new Recorder({ responses: TRACE.responses }), today: TRACE.built, repoToday, previous: FULL, repo })).file;
}

// --- The band ------------------------------------------------------------------------------

test('the band: within ±25% of the number before, both ends included; zero to nonzero is a jump', () => {
  assert.equal(BAND_PCT, 25);
  for (const [a, b] of [[100, 125], [100, 75], [4, 5], [4, 3], [8, 10], [8, 6], [0, 0], [7, 7], [93997, 117496], [93997, 70498]]) assert.equal(withinBand(a, b), true, `${a} -> ${b}`);
  for (const [a, b] of [[100, 126], [100, 74], [3, 4], [3, 2], [1, 2], [1, 0], [0, 1], [0, 2378], [582, 0], [93997, 117497], [93997, 70497]]) assert.equal(withinBand(a, b), false, `${a} -> ${b}`);
  assert.equal(changePct(100, 125), '+25%');
  assert.equal(changePct(100, 74), '-26%');
  assert.equal(changePct(0, 3), 'from 0');
  assert.equal(changePct(582, 0), '-100%');
  assert.equal(changePct(93997, 93996), '-<0.1%');
  assert.equal(changePct(353, 346), '-2%');
});

test('every integer in the schema’s how_much is either a measured number or listed as not measured, and nothing listed is stale', () => {
  const ints = [];
  const walk = (node, path) => {
    if (node.type === 'integer') ints.push(path);
    else if (node.type === 'object') for (const [k, v] of Object.entries(node.props)) walk(v, path ? `${path}.${k}` : k);
    else if (node.type === 'array') walk(node.items, `${path}[*]`);
    else if (node.type === 'map') walk(node.values, `${path}.*`);
    else if (node.type === 'oneOf') for (const a of node.alts) walk(a, path);
  };
  walk(GAP_RECORD.props.how_much, '');
  assert.ok(ints.length > 15);
  for (const p of ints) assert.ok(MEASURED_NUMBERS.includes(p) || NOT_MEASURED.includes(p), `${p} is neither measured nor listed as not measured`);
  for (const p of [...MEASURED_NUMBERS, ...NOT_MEASURED]) assert.ok(ints.includes(p), `${p} isn't an integer in the schema`);
  for (const p of DATE_FIELDS) assert.ok(p.split('.').length === 2, p);
});

test('flatten keys lists by their own key, so a reordered or new point is found by name', () => {
  const g = gapIn(FULL, NO_STREET);
  const m = flatten(g.how_much);
  assert.equal(m.get('series[2024].part').value, g.how_much.series.find((x) => x.k === '2024').part);
  assert.equal(m.get('by_status[New Work Order or On-Going].whole').value, g.how_much.by_status[0].whole);
  assert.equal(m.get('window.also.no_ward_or_league').value, g.how_much.window.also.no_ward_or_league);
  assert.ok(isMeasured(m.get('series[2024].part').path));
  assert.ok(isDate(m.get('read').path) && isDate(m.get('window.from').path));
  const lc = flatten(gapIn(FULL, LINE_CLEARANCE).how_much);
  assert.equal(lc.get('catalog[line clearance].result_set_size').value, 0);
  assert.ok(isMeasured(lc.get('catalog[line clearance].result_set_size').path));
  assert.ok(isMeasured(lc.get('columns_absent.datasets.qzfe-wj25').path));
  assert.ok(isDate(lc.get('catalog[Dominion].read').path));
  assert.equal(isMeasured(lc.get('catalog[Dominion].open_to_siren[0].id').path), false);
  const pol = flatten(gapIn(FULL, RESTRICTED).how_much);
  assert.equal(isMeasured(pol.get('policy.line').path), false, 'a file line is not a measurement');
  const series = structuredClone(g.how_much);
  series.series.reverse();
  assert.deepEqual(compareGap(g, { ...g, how_much: series }).numbers, [], 'order alone moves nothing');
  assert.equal(maskNumbers('I found 1,437 items (47%) built 2026-11-02T19:30:12.391Z'), 'I found # items (#%) built <date>');
});

// --- No change, dates, numbers within the band ------------------------------------------

test('unchanged files: none; the committed files against themselves: none', () => {
  assert.equal(approved(FULL, clone()).decision, 'none');
  const committed = JSON.parse(read('data/gaps/norfolk.json'));
  const r = decide([
    { source: APPROVED, before: side(committed), after: side(structuredClone(committed)) },
    { source: BUDGET, before: side(PROPOSED.file, PROPOSED.entries), after: side(structuredClone(PROPOSED.file), structuredClone(PROPOSED.entries)) },
  ]);
  assert.equal(r.decision, 'none');
  assert.match(renderSummary(r), /^Gap refresh: none\. No change to the gap files\./);
});

test('a real offline rebuild on another day with the same index: dates only, so commit', async () => {
  const after = await rebuild();
  const r = approved(FULL, after);
  assert.equal(r.decision, 'commit', JSON.stringify(r.reasons));
  assert.deepEqual(r.reasons, []);
  const s = renderSummary(r);
  assert.match(s, /gaps?: dates only/);
  assert.match(s, /nothing in the gap files needs review/);
});

test('a real offline rebuild after a small index change: the count moves within the band, so commit, and the summary names it', async () => {
  const after = await rebuild({ index: (idx) => ({ ...idx, items: idx.items.slice(0, idx.items.length - 40) }) });
  const r = approved(FULL, after);
  assert.equal(r.decision, 'commit', JSON.stringify(r.reasons));
  const g = r.sets[0].gaps.find((x) => x.id === NO_ADDRESS);
  assert.ok(g.numbers.some((n) => n.path === 'how_much.whole' && n.before - n.after === 40 && !n.jump));
  const w = gapIn(FULL, NO_ADDRESS).how_much.whole;
  assert.ok(renderSummary(r).includes(`whole ${fmt(w)} -> ${fmt(w - 40)} (${changePct(w, w - 40)})`));
});

test('a real offline rebuild after the index shrinks to 100 items: a jump beyond ±25%, so a pull request', async () => {
  const after = await rebuild({ index: (idx) => ({ ...idx, items: idx.items.slice(0, 100) }) });
  const r = approved(FULL, after);
  assert.equal(r.decision, 'pr');
  assert.deepEqual(rules(r), ['number_jump']);
  assert.ok(r.reasons.every((x) => x.id === NO_ADDRESS));
  const w = gapIn(FULL, NO_ADDRESS).how_much.whole;
  assert.ok(r.reasons.some((x) => x.detail === `how_much.whole ${fmt(w)} -> 100 (${changePct(w, 100)}), beyond ±25%`));
});

test('a real offline rebuild after the findings’ last check passes 30 days: evidence turns unverified, so a pull request', async () => {
  const after = await rebuild({ repoToday: '2026-12-10' });
  const r = approved(FULL, after);
  assert.equal(r.decision, 'pr');
  assert.deepEqual(rules(r), ['board', 'evidence_unverified']);
  const ids = [...new Set(r.reasons.map((x) => x.id))].sort();
  assert.deepEqual(ids, ['norfolk.tree-inventory.survey-date', 'norfolk.utility.line-clearance', 'norfolk.work-orders.no-contract-link']);
  assert.ok(r.reasons.some((x) => x.rule === 'board' && /open -> off the board \(evidence_unverified\)/.test(x.detail)));
});

// --- Each rule, one at a time ----------------------------------------------------------------

test('exactly ±25% on a measured number commits; one past it opens a pull request, either way', () => {
  const before = clone();
  Object.assign(gapIn(before, NO_STREET).how_much, { part: 400, whole: 2000 });
  const at = (part, whole) => {
    const f = structuredClone(before);
    Object.assign(gapIn(f, NO_STREET).how_much, { part, whole });
    return approved(before, f);
  };
  // 25% of 400 is 100, of 2,000 is 500: both ends are in the band.
  assert.equal(at(500, 2000).decision, 'commit');
  assert.equal(at(501, 2000).decision, 'pr');
  assert.equal(at(300, 2000).decision, 'commit');
  assert.equal(at(299, 2000).decision, 'pr');
  assert.equal(at(400, 2500).decision, 'commit');
  assert.equal(at(400, 2501).decision, 'pr');
  assert.equal(at(400, 1500).decision, 'commit');
  assert.equal(at(400, 1499).decision, 'pr');
  assert.equal(at(500, 2500).decision, 'commit', 'both at the edge');
  const r = at(502, 2000);
  assert.deepEqual(r.reasons.map((x) => [x.id, x.rule]), [[NO_STREET, 'number_jump']]);
  assert.equal(r.reasons[0].detail, 'how_much.part 400 -> 502 (+25.5%), beyond ±25%');
  // An odd number: 25% of 582 is 145.5, so 727 is in and 728 out.
  const odd = clone();
  gapIn(odd, NO_STREET).how_much.part = 582;
  const to = (n) => {
    const f = structuredClone(odd);
    gapIn(f, NO_STREET).how_much.part = n;
    return approved(odd, f).decision;
  };
  assert.deepEqual([to(727), to(728), to(437), to(436)], ['commit', 'pr', 'commit', 'pr']);
});

test('zero to nonzero is a jump, and so is any number to zero, on every measured kind', () => {
  const f0 = clone();
  gapIn(f0, LINE_CLEARANCE).how_much.catalog.find((c) => c.q === 'line clearance').result_set_size = 0;
  const f = structuredClone(f0);
  gapIn(f, LINE_CLEARANCE).how_much.catalog.find((c) => c.q === 'line clearance').result_set_size = 1;
  const r = approved(f0, f);
  assert.equal(r.decision, 'pr');
  assert.match(r.reasons[0].detail, /catalog\[line clearance\]\.result_set_size 0 -> 1 \(from 0\)/);
  const g0 = clone();
  gapIn(g0, NO_STREET).how_much.window.also.no_ward_or_league = 22;
  const g = structuredClone(g0);
  gapIn(g, NO_STREET).how_much.window.also.no_ward_or_league = 0;
  assert.equal(approved(g0, g).reasons[0].rule, 'number_jump');
  const h0 = clone();
  gapIn(h0, 'norfolk.work-orders.no-planned-date').how_much.backlog.median_days = 1000;
  const h = structuredClone(h0);
  gapIn(h, 'norfolk.work-orders.no-planned-date').how_much.backlog.median_days = 1300;
  assert.equal(approved(h0, h).decision, 'pr', '1,000 -> 1,300 is +30%');
});

test('a state change, a move on or off the board, and ids added or removed each open a pull request', () => {
  const closing = clone();
  gapIn(closing, NO_STREET).state = 'closing';
  assert.deepEqual(approved(FULL, closing).reasons.map((x) => [x.rule, x.detail]), [['state', 'open -> closing']]);

  const off = clone();
  off.gaps = off.gaps.filter((g) => g.id !== RESTRICTED);
  off.off_board.push({ id: RESTRICTED, state: 'unmeasured_today', reason: 'nbyu-xjez is no longer restricted.' });
  const r = approved(FULL, off);
  assert.equal(r.decision, 'pr');
  assert.deepEqual(rules(r), ['board', 'failed_measure']);

  const back = approved(off, FULL);
  assert.deepEqual(rules(back), ['board'], 'coming back onto the board is a change too');

  const removed = clone();
  removed.gaps = removed.gaps.filter((g) => g.id !== RESTRICTED);
  assert.deepEqual(approved(FULL, removed).reasons.map((x) => x.rule), ['id_removed']);
  assert.deepEqual(approved(removed, FULL).reasons.map((x) => x.rule), ['id_added']);
});

test('a failed measure keeps its last good measurement on the board, and still opens a pull request', () => {
  const f = clone();
  const g = gapIn(f, NO_STREET);
  Object.assign(g, { state: 'unmeasured_today', last_good: g.measured, notice: `I couldn't measure this on 2026-11-16. I show my last measurement, from ${g.measured}.` });
  const r = approved(FULL, f);
  assert.equal(r.decision, 'pr');
  assert.deepEqual(rules(r), ['failed_measure', 'state']);
  // Still failing a week later, with nothing else moved: still a pull request.
  const later = structuredClone(f);
  gapIn(later, NO_STREET).notice = gapIn(later, NO_STREET).notice.replace('2026-11-16', '2026-11-23');
  assert.deepEqual(rules(approved(f, later)), ['failed_measure']);
  // A proposal set has no last good: its failed measure is off the board.
  const p = structuredClone(PROPOSED.file);
  const id = p.gaps[0].id;
  p.gaps = p.gaps.slice(1);
  p.off_board.push({ id, state: 'unmeasured_today', reason: 'x' });
  const rp = decide([{ source: BUDGET, before: side(PROPOSED.file, PROPOSED.entries), after: side(p, PROPOSED.entries) }]);
  assert.deepEqual(rules(rp), ['board', 'failed_measure']);
  assert.equal(rp.reasons[0].set, 'proposed norfolk-budget');
});

test('a finding gone from a gap’s evidence opens a pull request even when the state holds', () => {
  const f = clone();
  const g = gapIn(f, LINE_CLEARANCE);
  g.evidence = g.evidence.filter((e) => e.type !== 'finding');
  const r = approved(FULL, f);
  assert.deepEqual(r.reasons.map((x) => [x.rule, x.detail]), [['finding_dropped', 'finding norfolk-trees#dominion is gone from its evidence']]);
  // A finding's re-check date moving is a date.
  const d = clone();
  gapIn(d, LINE_CLEARANCE).evidence.find((e) => e.type === 'finding').checked = '1999-01-02';
  assert.equal(approved(FULL, d).decision, 'commit');
});

test('shape changes go to review: a new series point, matched values, a policy line, a quote, a dataset added', () => {
  const cases = {
    series: (f) => gapIn(f, NO_STREET).how_much.series.push({ k: '2027', part: 1, whole: 3 }),
    matched: (f) => gapIn(f, LINE_CLEARANCE).how_much.values.matched.push('Line Clearance'),
    policy: (f) => (gapIn(f, RESTRICTED).how_much.policy.line += 1),
    quote: (f) => (gapIn(f, 'norfolk.tree-inventory.survey-date').how_much.quote.text += ' More.'),
    dataset: (f) => (gapIn(f, 'norfolk.work-orders.no-approver').how_much.columns_absent.datasets['cmvv-agyb'] = 13),
    open: (f) => gapIn(f, LINE_CLEARANCE).how_much.catalog.find((c) => c.q === 'Dominion').open_to_siren.pop(),
  };
  for (const [name, edit] of Object.entries(cases)) {
    const f = clone();
    edit(f);
    const r = approved(FULL, f);
    assert.equal(r.decision, 'pr', name);
    assert.ok(r.reasons.some((x) => x.rule === 'shape'), `${name}: ${JSON.stringify(r.reasons)}`);
  }
  const f = clone();
  gapIn(f, NO_STREET).how_much.series.push({ k: '2027', part: 1, whole: 3 });
  assert.deepEqual(approved(FULL, f).reasons.map((x) => x.detail), ['how_much.series[2027].k added', 'how_much.series[2027].part added', 'how_much.series[2027].whole added']);
});

test('dates move freely: reads, the window start, the span, the measured day, rows_updated', () => {
  const f = clone();
  const g = gapIn(f, NO_STREET);
  // Days no build writes, so each is a change whatever the stored build's day.
  g.how_much.read = '1999-01-02T02:00:00.000Z';
  g.how_much.window.from = '1998-01-02';
  g.where.span.through = '1999-01-01';
  g.measured = '1999-01-02';
  const s = gapIn(f, 'norfolk.tree-inventory.survey-date');
  s.how_much.published.rows_updated = '1999-01-01T12:27:08.000Z';
  s.how_much.columns_absent.read = '1999-01-02T02:00:00.000Z';
  const r = approved(FULL, f);
  assert.equal(r.decision, 'commit', JSON.stringify(r.reasons));
  assert.deepEqual(r.sets[0].gaps.find((x) => x.id === NO_STREET).dates.sort(), ['how_much.read', 'how_much.window.from', 'measured', 'where.span.through']);
});

test('wording: code-written text may change only in its numbers and dates', () => {
  const f = clone();
  const g = gapIn(f, NO_STREET);
  g.statement = g.statement.replace(/\d[\d,]*/, (n) => String(Number(n.replace(/,/g, '')) + 1)).replace(/\d{4}-\d{2}-\d{2}/, '1999-01-02');
  assert.equal(approved(FULL, f).decision, 'commit');
  g.statement = g.statement.replace('I found', 'I counted');
  const r = approved(FULL, f);
  assert.deepEqual(r.reasons.map((x) => [x.rule, x.detail]), [['wording', 'statement changed beyond numbers and dates']]);
  const c = clone();
  gapIn(c, NO_STREET).questions[0].consequence += ' Extra.';
  assert.match(approved(FULL, c).reasons[0].detail, /q1 consequence changed/);
});

test('catalog fields and the file’s own fields go to review; the topic’s reads and the meetings list don’t', () => {
  const t = clone();
  gapIn(t, NO_STREET).title = 'Another title';
  assert.deepEqual(approved(FULL, t).reasons.map((x) => [x.rule, x.detail]), [['catalog_fields', 'title changed']]);

  const topic = clone();
  for (const g of topic.gaps) if (g.topic) for (const x of g.topic.not_in_topic) if (x.read) x.read = '1999-01-02T02:00:00.000Z';
  assert.equal(approved(FULL, topic).decision, 'commit');
  gapIn(topic, NO_STREET).topic.not_in_topic[0].reason = 'Changed.';
  assert.deepEqual(rules(approved(FULL, topic)), ['catalog_fields']);

  const retired = clone();
  retired.retired = [...retired.retired, 'norfolk.x.y'];
  assert.deepEqual(approved(FULL, retired).reasons.map((x) => [x.id, x.rule]), [[null, 'file_fields']]);

  const frame = clone();
  for (const a of frame.actions) if (a.draft) a.draft.frame = a.draft.frame.replace(/\d{4}-\d{2}-\d{2}/, '1999-01-02');
  assert.equal(approved(FULL, frame).decision, 'commit', 'an action frame’s date is a date');
  const action = clone();
  action.actions[0].text = `${action.actions[0].text || ''} More.`;
  assert.deepEqual(rules(approved(FULL, action)), ['file_fields']);

  const meetings = clone();
  meetings.meetings = { ...(meetings.meetings || {}), read: '1999-01-02T02:00:00.000Z', listed: [], calendar: 'x', note: 'y' };
  const m = approved(FULL, meetings);
  assert.equal(m.decision, 'commit');
  assert.equal(m.sets[0].meetings_changed, true);
  assert.match(renderSummary(m), /upcoming-meetings list was re-read \(not a gap\)/);
});

test('a proposal set: its entries changing, or the file appearing or going, opens a pull request', () => {
  const entries = structuredClone(PROPOSED.entries);
  entries[0].title = 'Renamed';
  assert.deepEqual(rules(decide([{ source: BUDGET, before: side(PROPOSED.file, PROPOSED.entries), after: side(PROPOSED.file, entries) }])), ['file_fields']);
  const added = decide([{ source: BUDGET, before: null, after: side(PROPOSED.file, PROPOSED.entries) }]);
  assert.equal(added.decision, 'pr');
  assert.ok(added.reasons.some((x) => x.rule === 'file_fields' && /is new/.test(x.detail)));
  assert.equal(added.reasons.filter((x) => x.rule === 'id_added').length, PROPOSED.file.gaps.length);
  assert.ok(decide([{ source: BUDGET, before: side(PROPOSED.file, PROPOSED.entries), after: null }]).reasons.some((x) => /is gone/.test(x.detail)));
});

test('across files: one file within the band and another needing review is a pull request', () => {
  const f = clone();
  gapIn(f, NO_STREET).how_much.part += 3;
  const p = structuredClone(PROPOSED.file);
  p.gaps[0].state = 'closing';
  const r = decide([
    { source: APPROVED, before: side(FULL), after: side(f) },
    { source: BUDGET, before: side(PROPOSED.file, PROPOSED.entries), after: side(p, PROPOSED.entries) },
  ]);
  assert.equal(r.decision, 'pr');
  assert.deepEqual(r.reasons.map((x) => x.set), ['proposed norfolk-budget']);
  const s = renderSummary(r);
  assert.match(s, /Why it needs review:/);
  const p0 = gapIn(FULL, NO_STREET).how_much.part;
  assert.ok(s.includes(`\`${NO_STREET}\` (open): part ${fmt(p0)} -> ${fmt(p0 + 3)}`), s);
});

// --- The summary and the result --------------------------------------------------------------

test('the summary: no heading lines (it is a commit message too), bounded, and verify-cases a loud signal that never decides', () => {
  const f = clone();
  for (const g of f.gaps) g.state = 'closing';
  const failed = decide([{ source: APPROVED, before: side(FULL), after: side(f) }], { verify: { exit: 1, flagged: ['XX dominion: quote not found: "x"'] } });
  assert.equal(failed.decision, 'pr');
  const s = renderSummary(failed, { context: 'Weekly live re-measure.' });
  for (const line of s.split('\n')) assert.doesNotMatch(line, /^#/, 'a # line would be dropped from a commit message edited in git');
  assert.match(s, /^Gap refresh: pr\. Needs review/);
  assert.match(s, /Weekly live re-measure\./);
  assert.match(s, /verify-cases \(read-only\) FAILED \(exit 1\)\. The gap build reads each finding's verification from the case files, not from this run, so this result is a signal only/);
  assert.match(s, /XX dominion/);
  assert.equal(failed.verify.signal_only, true);
  // The same rebuild with verify passing or failing decides the same.
  const dates = clone();
  gapIn(dates, NO_STREET).measured = '1999-01-02';
  for (const exit of [0, 1]) assert.equal(decide([{ source: APPROVED, before: side(FULL), after: side(dates) }], { verify: { exit, flagged: [] } }).decision, 'commit');
  assert.match(renderSummary(decide([{ source: APPROVED, before: side(FULL), after: side(dates) }], { verify: { exit: 0, flagged: [] } })), /verify-cases \(read-only\) passed/);
  // Many reasons are cut, never the decision.
  const many = clone();
  for (const g of many.gaps) {
    g.state = 'closing';
    g.title += ' x';
    g.statement += ' Extra.';
    Object.assign(g.how_much, { extra_one: 1, extra_two: 2 });
  }
  const big = renderSummary(approved(FULL, many));
  assert.match(big, /and \d+ more/);
  assert.ok(big.length < 20000);
});

test('text from the portal or a failing build that fails the public-text checks is withheld from the summary', () => {
  const f = clone();
  f.gaps = f.gaps.filter((g) => g.id !== RESTRICTED);
  f.off_board.push({ id: RESTRICTED, state: 'unmeasured_today', reason: 'A row reads 1500 Granby Street.' });
  const r = decide([{ source: APPROVED, before: side(FULL), after: side(f) }], { streets: ['GRANBY'] });
  const failed = r.reasons.find((x) => x.rule === 'failed_measure');
  assert.match(failed.detail, /^off the board \(unmeasured_today\): withheld here/);
  assert.doesNotMatch(renderSummary(r), /Granby/i);
  const ok = clone();
  ok.gaps = ok.gaps.filter((g) => g.id !== RESTRICTED);
  ok.off_board.push({ id: RESTRICTED, state: 'unmeasured_today', reason: 'nbyu-xjez is no longer restricted.' });
  assert.match(decide([{ source: APPROVED, before: side(FULL), after: side(ok) }], { streets: ['GRANBY'] }).reasons.find((x) => x.rule === 'failed_measure').detail, /no longer restricted/);
});

test('flaggedLines keeps the failures and the findings to look at from a verify-cases log', () => {
  const log = ['', 'norfolk-trees', '  ok dominion', '  ?? contract-removal: the live page no longer shows the quote', '  XX tree-commission: quote not found: "x"', '  -  measure-dropped: unverified, served as unverified', '', '1 finding(s) failed.'].join('\n');
  assert.deepEqual(flaggedLines(log), ['?? contract-removal: the live page no longer shows the quote', 'XX tree-commission: quote not found: "x"']);
});

test('decideFiles reads a snapshot and the files now; a missing file counts as absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gap-refresh-'));
  const before = join(dir, 'before');
  const root = join(dir, 'root');
  mkdirSync(before);
  mkdirSync(join(root, 'data/gaps'), { recursive: true });
  writeFileSync(join(before, 'norfolk.json'), JSON.stringify(FULL));
  const f = clone();
  gapIn(f, NO_STREET).how_much.whole += 10;
  writeFileSync(join(root, 'data/gaps/norfolk.json'), JSON.stringify(f));
  writeFileSync(join(before, 'proposed-norfolk-budget.trace.json'), JSON.stringify(PROPOSED));
  writeFileSync(join(root, 'data/gaps/proposed-norfolk-budget.trace.json'), JSON.stringify(PROPOSED));
  const r = decideFiles({ beforeDir: before, root });
  assert.equal(r.decision, 'commit');
  assert.deepEqual(r.sets.map((s) => [s.set, s.changed]), [['approved norfolk', true], ['proposed norfolk-budget', false]]);
  // A file in the snapshot that isn't there now went away, which is a review.
  writeFileSync(join(before, 'missing.trace.json'), JSON.stringify(PROPOSED));
  const gone = decideFiles({ beforeDir: before, root, sources: [APPROVED, { ...BUDGET, file: 'data/gaps/missing.trace.json' }] });
  assert.equal(gone.decision, 'pr');
  assert.ok(gone.reasons.some((x) => x.rule === 'file_fields' && /missing\.trace\.json is gone/.test(x.detail)));
});

test('the CLI: paths lists what a rebuild writes; snapshot and decide over the committed files decide none', () => {
  const out = spawnSync(process.execPath, ['scripts/gap-refresh.js', 'paths'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split('\n'), gapPaths());
  assert.deepEqual(gapPaths(), ['data/gaps', 'docs/gaps-budget-proposed.md', 'docs/gaps-inventory.md', 'docs/gaps-norfolk.md']);
  const dir = mkdtempSync(join(tmpdir(), 'gap-refresh-cli-'));
  const snap = spawnSync(process.execPath, ['scripts/gap-refresh.js', 'snapshot', join(dir, 'before')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(snap.status, 0, snap.stderr);
  assert.deepEqual(readdirSync(join(dir, 'before')).sort(), ['norfolk.json', 'proposed-norfolk-budget.trace.json']);
  const d = spawnSync(process.execPath, ['scripts/gap-refresh.js', 'decide', '--before', join(dir, 'before'), '--summary', join(dir, 's.md'), '--result', join(dir, 'r.json'), '--verify-exit', '0'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /decision=none/);
  const result = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
  assert.equal(result.decision, 'none');
  assert.equal(result.band_pct, 25);
  assert.equal(result.verify.exit, 0);
  assert.match(readFileSync(join(dir, 's.md'), 'utf8'), /^Gap refresh: none/);
  const bad = spawnSync(process.execPath, ['scripts/gap-refresh.js', 'decide'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /needs --before/);
});
