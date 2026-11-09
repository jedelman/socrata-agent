// The running inventory of gaps (scripts/gaps-inventory.js) and the budget
// topic it lists. No network: everything here reads committed files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateInventory } from '../src/gaps/schema.js';
import { gapCheck } from '../src/gaps/kinds.js';
import { publicTextViolations, compileStreets } from '../src/public-text.js';
import * as norfolk from '../src/gaps/norfolk.js';
import * as proposal from '../src/gaps/proposed/norfolk-budget.js';
import { CATALOGS, gapTextProblems, buildGaps, Recorder } from '../scripts/build-gaps.js';
import { buildInventory, checkInventory, readInputs, changesBetween, statesOf, anchors, INVENTORY_PATHS } from '../scripts/gaps-inventory.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const INV = JSON.parse(read(INVENTORY_PATHS.file));
const INPUTS = readInputs({ root: ROOT, catalogs: CATALOGS });
const STREETS = compileStreets(JSON.parse(read('data/gaps/norfolk-streets.json')).streets);
const PTRACE = JSON.parse(read('data/gaps/proposed-norfolk-budget.trace.json'));
const clone = (x) => structuredClone(x);
// The inputs hold catalog modules, which can't be cloned: copy the rest.
const cloneInputs = (i) => ({ ...i, approved: i.approved.map((c) => ({ ...c, built: clone(c.built) })), proposed: i.proposed.map((p) => ({ ...p, trace: clone(p.trace) })) });

test('the committed inventory fits its schema and is what the committed gap files build', () => {
  assert.deepEqual(validateInventory(INV), []);
  assert.deepEqual(checkInventory({ root: ROOT, catalogs: CATALOGS }), []);
  // Unknown keys fail, as in the gap file: no cause can be added quietly.
  const bad = clone(INV);
  bad.approved[0].entries[0].why = 'x';
  assert.ok(validateInventory(bad).some((e) => /unknown key "why"/.test(e)));
});

test('every approved entry is listed once with its board state, every proposal once as proposed, and they stay apart', () => {
  const appr = INV.approved.flatMap((c) => c.entries);
  const prop = INV.proposed.flatMap((p) => p.entries);
  assert.deepEqual(appr.map((e) => e.id).sort(), norfolk.GAPS.map((g) => g.id).sort());
  assert.deepEqual(prop.map((e) => e.id).sort(), proposal.GAPS.map((g) => g.id).sort());
  for (const e of appr) assert.notEqual(e.state, 'proposed', e.id);
  for (const e of prop) {
    assert.equal(e.state, 'proposed', e.id);
    assert.match(e.awaiting, /Jason/);
    assert.ok(!norfolk.GAPS.some((g) => g.id === e.id), `${e.id} is in the approved catalog`);
  }
  assert.deepEqual(INV.retired.map((r) => r.id).sort(), [...norfolk.RETIRED].sort());
  assert.deepEqual(INV.not_a_gap.map((n) => n.id), norfolk.NOT_A_GAP.map((n) => n.id));
  // Counts add up.
  assert.equal(INV.counts.approved.total, appr.length);
  assert.equal(INV.counts.proposed.total, prop.length);
  assert.equal(Object.values(INV.counts.approved.by_state).reduce((a, b) => a + b, 0), appr.length);
  assert.equal(Object.values(INV.counts.proposed.by_topic).reduce((a, b) => a + b, 0), prop.length);
  assert.equal(INV.counts.proposed.by_topic.budget, proposal.GAPS.length);
  assert.equal(INV.candidates.recorded, false);
});

test('each entry carries its questions, actions, measured shape and date, and links to its doc section and evidence', () => {
  const docs = new Map();
  for (const e of [...INV.approved, ...INV.proposed].flatMap((c) => c.entries)) {
    assert.ok(e.questions.length, e.id);
    assert.ok(e.actions.length, e.id);
    const [doc, anchor] = e.doc.split('#');
    if (!docs.has(doc)) docs.set(doc, anchors(read(doc)).map((a) => a.anchor));
    assert.ok(docs.get(doc).includes(anchor), `${e.id}: ${e.doc}`);
    if (e.state !== 'off_board' && !e.not_measured) {
      assert.match(e.measured, /^\d{4}-\d{2}-\d{2}$/, e.id);
      assert.ok(e.short && e.shape && e.evidence.length, e.id);
      for (const q of e.questions) assert.ok(q.consequence, `${e.id} ${q.qid}`);
    }
  }
  assert.equal(anchors('## A (b) “c”\n## A (b) “c”\n').at(-1).anchor, 'a-b-c-1');
});

test('nothing in the inventory names an address or a person: every shown string passes the board checks', () => {
  for (const e of [...INV.approved, ...INV.proposed].flatMap((c) => c.entries)) {
    assert.deepEqual([...gapCheck(e.title, 'title'), ...publicTextViolations(e.title, { streets: STREETS })], [], e.title);
    if (e.short) assert.deepEqual([...gapCheck(e.short, 'short'), ...publicTextViolations(e.short, { streets: STREETS })], [], e.short);
    for (const q of e.questions) assert.deepEqual(publicTextViolations(q.text, { streets: STREETS }), [], q.text);
  }
  for (const t of INV.topics) for (const x of [...t.placements, ...t.cleared]) assert.deepEqual([...gapCheck(x.reason, 'statement'), ...publicTextViolations(x.reason, { streets: STREETS })], [], x.reason);
  // A title that names an address fails the build; a build-written reason that does is withheld.
  const inputs = cloneInputs(INPUTS);
  inputs.approved[0].catalog = { ...norfolk, GAPS: norfolk.GAPS.map((g, i) => (i ? g : { ...g, title: 'Trees at 1500 Granby Street' })) };
  assert.throws(() => buildInventory(inputs, null), /inventory's text fails a check/);
  const off = cloneInputs(INPUTS);
  const id = norfolk.GAPS[0].id;
  off.approved[0].built.gaps = off.approved[0].built.gaps.filter((g) => g.id !== id);
  off.approved[0].built.off_board = [{ id, state: 'unmeasured_today', reason: 'A row reads 1500 Granby Street.' }];
  off.approved[0].docText += '\n## Off the board today\n';
  const e = buildInventory(off, null).inventory.approved[0].entries.find((x) => x.id === id);
  assert.equal(e.state, 'off_board');
  assert.match(e.off_board.reason, /^Withheld/);
});

test('what changed: opened, closed, dropped off, newly proposed and left the proposals, against the build before', () => {
  const before = { as_of: '2026-11-01', states: { a: 'open', b: 'open', c: 'proposed', d: 'off_board', e: 'open' } };
  const ch = changesBetween(before, { a: 'open', b: 'off_board', c: 'open', d: 'open', e: 'closed', f: 'proposed' });
  assert.deepEqual(ch.dropped_off, ['b']);
  assert.deepEqual(ch.opened, ['c', 'd']);
  assert.deepEqual(ch.left_proposals, ['c']);
  assert.deepEqual(ch.closed, ['e']);
  assert.deepEqual(ch.newly_proposed, ['f']);
  assert.equal(ch.since, '2026-11-01');
  assert.match(changesBetween(null, {}).note, /first inventory/);
});

test('a rebuild with no state change keeps the earlier comparison; a state change moves it forward', () => {
  const prior = clone(INV);
  prior.previous = { as_of: '2026-11-01', states: { ...statesOf(INV), 'norfolk.budget.cip-no-ward': 'not listed' } };
  const same = buildInventory(INPUTS, prior).inventory;
  assert.deepEqual(same.previous, prior.previous);
  assert.deepEqual(same.changes.newly_proposed, ['norfolk.budget.cip-no-ward']);
  // A gap dropping off the board is a change: previous becomes the prior's states.
  const off = cloneInputs(INPUTS);
  const id = 'norfolk.legislation.no-address';
  off.approved[0].built.gaps = off.approved[0].built.gaps.filter((g) => g.id !== id);
  off.approved[0].built.off_board = [{ id, state: 'unmeasured_today', reason: 'The index was unreadable.' }];
  off.approved[0].docText += '\n## Off the board today\n';
  const moved = buildInventory(off, prior).inventory;
  assert.equal(moved.previous.as_of, prior.as_of);
  assert.deepEqual(moved.changes.dropped_off, [id]);
});

test('the inventory reads proposal outputs, never a proposal module', () => {
  const src = read('scripts/gaps-inventory.js');
  // The pattern test/gaps-proposed.test.js holds everything shipped to: a proposal module or the proposal builder.
  assert.doesNotMatch(src, /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\bproposed(?:\/|\.js['"])/);
  assert.doesNotMatch(read('scripts/build-gaps.js'), /proposed/);
});

// --- The budget topic ---------------------------------------------------------------

test('the budget topic: its datasets, a placement for every other catalog hit, and clearances with a reviewer and reason', () => {
  const t = norfolk.TOPICS.budget;
  assert.equal(t.search, 'budget');
  const search = Object.entries(PTRACE.responses).find(([u]) => /catalog\/v1\?.*&q=budget$/.test(u))[1].body;
  const hits = search.results.map((r) => r.resource.id);
  assert.equal(hits.length, search.resultSetSize);
  for (const id of hits) assert.ok(t.datasets.includes(id) || t.not_in_topic.some((x) => x.id === id), id);
  for (const x of t.not_in_topic) {
    assert.ok(x.reason && x.placed, x.id);
    assert.ok(x.policy || x.quote?.length, `${x.id}: a placement quotes its description or rests on the rule`);
  }
  for (const c of t.cleared) assert.ok(c.reason && c.by && /^\d{4}-\d{2}-\d{2}$/.test(c.date), c.column);
  // Restricted datasets are placed by the rule, with its file:line, and never described.
  const rendered = PTRACE.file.gaps[0].topic;
  for (const x of rendered.not_in_topic.filter((p) => p.policy)) {
    assert.match(read(x.policy.file).split('\n')[x.policy.line - 1], new RegExp(`id: '${x.id}'`));
    assert.ok(!PTRACE.steps.some((s) => s.dataset === x.id), `${x.id} was read`);
  }
  // Every proposed budget entry names the topic and carries it as checked.
  for (const g of PTRACE.file.gaps) assert.equal(g.topic.name, 'budget', g.id);
});

test('the catalog build measures only the topics its entries name: the budget topic adds no request to it', () => {
  const trace = JSON.parse(read('data/gaps/norfolk.trace.json'));
  assert.ok(!trace.steps.some((s) => /q=budget/.test(s.url)));
  assert.ok(!norfolk.GAPS.some((g) => g.topic === 'budget'));
  const built = JSON.parse(read('data/gaps/norfolk.json'));
  assert.ok(!built.gaps.some((g) => g.topic?.name === 'budget'));
});

test('an entry naming an undefined topic fails the build', async () => {
  const catalog = { ...norfolk, GAPS: [{ ...norfolk.GAPS[0], topic: 'nope' }] };
  await assert.rejects(
    buildGaps({ recorder: new Recorder({ responses: JSON.parse(read('data/gaps/norfolk.trace.json')).responses }), today: '2026-11-06', catalogs: { norfolk: { ...CATALOGS.norfolk, catalog } } }),
    /topic nope/
  );
});

test('budget "can’t answer" questions are checked over every budget dataset; one dataset short is refused', () => {
  const alls = PTRACE.file.gaps.flatMap((g) => g.questions.filter((q) => q.blocks === 'all').map((q) => [g, q]));
  assert.deepEqual(alls.map(([g]) => g.id).sort(), ['norfolk.budget.contractual-no-link', 'norfolk.budget.no-amendment-history']);
  for (const [g, q] of alls) {
    assert.deepEqual(Object.keys(g.how_much.columns_absent.datasets).sort(), [...norfolk.TOPICS.budget.datasets].sort(), g.id);
    assert.match(q.consequence, /in any of the 8 budget datasets I read/);
    const entry = proposal.GAPS.find((x) => x.id === g.id);
    assert.deepEqual(gapTextProblems(g, { entry, streets: STREETS }), []);
    const short = clone(g);
    delete short.how_much.columns_absent.datasets['fumf-ph9r'];
    assert.ok(gapTextProblems(short, { entry, streets: STREETS }).some((p) => /blocks "all" needs columns_absent over every topic dataset/.test(p)));
  }
  // The amendment entry names the columns a reviewer cleared, and the record carries each reason.
  const amend = PTRACE.file.gaps.find((g) => g.id === 'norfolk.budget.no-amendment-history');
  assert.deepEqual(amend.how_much.columns_absent.siblings_cleared.map((c) => `${c.dataset}.${c.column}`), ['7jsp-eyjg.fy_2027_adopted', '6njp-hen5.adopted_amount_fy_25', '6njp-hen5.adopted_amount_fy_25_fy_29']);
  assert.match(amend.statement, /I found 3 more columns matching it that a reviewer cleared/);
});
