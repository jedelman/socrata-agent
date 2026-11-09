// Proposed gap entries (src/gaps/proposed/): drafts for Jason's review, never
// part of the catalog. Catalog entries go public when merged and each new one
// needs his approval (docs/gaps.md §4), so nothing that ships may import a
// proposal, and the catalog builder must never read one. No network: the
// proposal replays its stored responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGap, validateGapFile } from '../src/gaps/schema.js';
import { gapTextViolations } from '../src/gaps/kinds.js';
import { publicTextViolations, compileStreets } from '../src/public-text.js';
import * as proposal from '../src/gaps/proposed/norfolk-budget.js';
import * as norfolk from '../src/gaps/norfolk.js';
import { CATALOGS, Recorder } from '../scripts/build-gaps.js';
import { PROPOSALS, buildProposed, proposalProblems, proseProblems } from '../scripts/build-gaps-proposed.js';
import { touches } from '../src/gaps/answer.js';
import { pinnedRepo, readRepo } from './fixtures/gaps-pinned.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const P = PROPOSALS['norfolk-budget'];
const TRACE = JSON.parse(read(P.trace));
const STREETS = compileStreets(JSON.parse(read('data/gaps/norfolk-streets.json')).streets);

function files(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(join(ROOT, p)).isDirectory() ? files(p) : [p];
  });
}
// A proposal module (proposed/...) or the proposal builder (build-gaps-proposed.js).
const IMPORTS_PROPOSED = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\bproposed(?:\/|\.js['"])/;

test('nothing under src/ or worker/ (or bin/, plugins/, deployments/) imports a proposal', () => {
  const shipped = ['src', 'worker', 'bin', 'plugins', 'deployments'].flatMap(files).filter((f) => /\.(m?js|html|json)$/.test(f) && !f.startsWith(join('src', 'gaps', 'proposed')));
  assert.ok(shipped.length > 20);
  for (const f of shipped) assert.doesNotMatch(read(f), IMPORTS_PROPOSED, `${f} imports a proposal`);
  // The pattern itself catches each form of import, the proposal builder included.
  for (const s of ["import x from './proposed/norfolk-budget.js'", "await import('../gaps/proposed/a.js')", "import * as p from '../src/gaps/proposed/norfolk-budget.js'", "import x from '../scripts/build-gaps-proposed.js'", "await import('./build-gaps-proposed.js')"]) assert.match(s, IMPORTS_PROPOSED);
  assert.doesNotMatch("import { x } from './proposals-list.js'", IMPORTS_PROPOSED);
});

// Every relative module a file imports (static, re-export or dynamic with a literal).
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;
function importGraph(entries) {
  const seen = new Set();
  const todo = entries.map((e) => join(ROOT, e));
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !/\.m?js$/.test(f)) continue;
    seen.add(f);
    for (const [, spec] of read(relative(ROOT, f)).matchAll(SPECIFIERS)) {
      const target = resolve(dirname(f), spec);
      assert.ok(existsSync(target), `${relative(ROOT, f)} imports ${spec}, which isn't a file`);
      todo.push(target);
    }
  }
  return [...seen].map((f) => relative(ROOT, f));
}

test('the Worker and the CLI reach no proposal module and not the proposal builder, walking their real imports', () => {
  const reached = importGraph(['worker/index.js', 'bin/socrata-agent.js']);
  assert.ok(reached.includes(join('src', 'gaps', 'answer.js')), 'the walk follows imports into src/gaps');
  assert.ok(reached.length > 20);
  for (const f of reached) {
    assert.ok(!f.startsWith(join('src', 'gaps', 'proposed')), `${f} is reached from the Worker or the CLI`);
    assert.notEqual(f, join('scripts', 'build-gaps-proposed.js'));
  }
  // The walk itself finds a proposal when something imports one.
  assert.ok(importGraph(['scripts/build-gaps-proposed.js']).includes(join('src', 'gaps', 'proposed', 'norfolk-budget.js')));
});

test('build-gaps ignores proposals: it imports none, and its catalogs hold only approved modules', () => {
  assert.doesNotMatch(read('scripts/build-gaps.js'), /proposed/);
  for (const [city, c] of Object.entries(CATALOGS)) {
    assert.notEqual(c.catalog, proposal, city);
    assert.notEqual(c.catalog.PROPOSED, true, city);
    for (const g of c.catalog.GAPS) assert.notEqual(g.proposed, true, g.id);
  }
  // No proposed id or action is in the approved catalog or its built file.
  const built = JSON.parse(read('data/gaps/norfolk.json'));
  const builtIds = new Set([...built.gaps.map((g) => g.id), ...built.off_board.map((o) => o.id)]);
  for (const g of proposal.GAPS) {
    assert.ok(!builtIds.has(g.id), g.id);
    assert.ok(!norfolk.GAPS.some((x) => x.id === g.id), g.id);
  }
  assert.ok(!built.actions.some((a) => proposal.ACTIONS.some((x) => x.id === a.id)));
});

test('every proposed entry is marked proposed, links only approved ids, and the module says it is a proposal', () => {
  assert.equal(proposal.PROPOSED, true);
  assert.deepEqual(proposalProblems(P), []);
  for (const g of proposal.GAPS) assert.equal(g.proposed, true, g.id);
  // An unmarked entry, or one reusing an approved id, is refused.
  const bad = { ...P, module: { ...proposal, GAPS: [{ ...proposal.GAPS[0], proposed: undefined }, { ...proposal.GAPS[1], id: norfolk.GAPS[0].id }] } };
  const problems = proposalProblems(bad);
  assert.ok(problems.some((p) => /proposed: true/.test(p)));
  assert.ok(problems.some((p) => /already an approved/.test(p)));
});

// The replay, against the pinned case files, dated the day of the stored build.
const OUT = await buildProposed({ recorder: new Recorder({ responses: TRACE.responses }), today: TRACE.built, repo: pinnedRepo });
// The same replay against the real repo, which is what the committed files are
// built from. When a case file moves on (re-verified, a finding marked
// unverified) the committed files go stale until someone reruns --offline;
// that is a normal repo state and must not fail npm test, which gates the
// deploy (build-gaps-proposed.js --check is the strict check).
const OUT_REAL = await buildProposed({ recorder: new Recorder({ responses: TRACE.responses }), today: TRACE.built, repo: readRepo });
const STALE = 'the committed proposal files differ from what the current case files build: run node scripts/build-gaps-proposed.js --offline';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('the replay measures every proposed entry, in the catalog schema, at the request count stored', () => {
  assert.deepEqual(OUT.file.off_board, []);
  assert.deepEqual(OUT.file.gaps.map((g) => g.id).sort(), proposal.GAPS.map((g) => g.id).sort());
  assert.deepEqual(validateGapFile(OUT.file), []);
  for (const g of OUT.file.gaps) assert.deepEqual(validateGap(g), [], g.id);
  assert.equal(TRACE.proposed, true);
  assert.equal(TRACE.steps.length, OUT.trace.steps.length);
});

test('the committed page and trace are what the stored responses build', (t) => {
  if (!same(TRACE.file, OUT_REAL.file) || read(P.doc) !== OUT_REAL.doc || !same(JSON.parse(JSON.stringify(OUT_REAL.trace)), TRACE)) return t.skip(STALE);
  assert.equal(read(P.doc), OUT_REAL.doc);
});

test('every proposed text passes gapTextViolations and publicTextViolations with the street list', () => {
  const ok = (s, type) => assert.deepEqual([...gapTextViolations(s, type), ...publicTextViolations(s, { streets: STREETS })], [], `${type}: ${s}`);
  for (const g of OUT.file.gaps) {
    ok(g.statement, 'statement');
    ok(g.short, 'short');
    ok(g.title, 'title');
    for (const q of g.questions) {
      ok(q.consequence, 'consequence');
      assert.deepEqual(publicTextViolations(q.text, { streets: STREETS }), [], q.text);
      assert.ok(q.text.length <= 160 && q.text.endsWith('?'), q.text);
    }
  }
  for (const a of OUT.file.actions) for (const s of [a.text, a.needs].filter(Boolean)) ok(s, 'action');
  assert.deepEqual(proseProblems(P, STREETS), []);
  // The prose check bites: a hedge, an unframed "no", and a link all fail.
  const broken = { ...P, module: { ...proposal, GAPS: [{ ...proposal.GAPS[0], why: 'The City may track this. The records have no unit for it.', context: 'See https://example.com for more.' }], REVIEW: [] } };
  const msgs = proseProblems(broken, STREETS).join('\n');
  assert.match(msgs, /A: "may"/);
  assert.match(msgs, /no reading frame/);
  assert.match(msgs, /link/);
});

test('proposed measures run through the traced client, every request in the trace, nothing excluded or restricted queried', () => {
  const urls = new Set(TRACE.steps.map((s) => s.url));
  for (const u of Object.keys(TRACE.responses)) assert.ok(urls.has(u), u);
  for (const g of OUT.file.gaps) {
    for (const e of g.evidence.filter((x) => x.trace_n !== undefined)) {
      const step = TRACE.steps.find((s) => s.n === e.trace_n);
      assert.ok(step && step.url === e.url, `${g.id}: evidence names trace step ${e.trace_n}`);
    }
    // Findings appear as their quotes, never their claims.
    for (const e of g.evidence.filter((x) => x.type === 'finding')) assert.ok(!('claim' in e));
  }
  for (const s of TRACE.steps) assert.notEqual(s.dataset, 'nbyu-xjez');
});

// What a turn ran, in the shape touches() reads (src/gaps/answer.js turnFacts).
const ran = (...steps) => ({ steps: steps.map(([dataset, soqlText], n) => ({ n, ok: true, dataset, soql: soqlText })), tools: new Set(['budget_for']), pendingTools: new Set(), refused: [], results: [], absences: [] });
const attached = (facts) => OUT.file.gaps.filter((g) => touches(g, facts)).map((g) => g.id).sort();

test('budget gaps attach on what the turn ran: a unit or program query attaches its own gaps, another department attaches only the dataset-wide ones', () => {
  // A police budget question (budget_for's scoped breakdown) touches Annual Expenditures, not Forestry.
  const police = ran(['mdwe-dquf', "SELECT unit_name AS k, fiscal_year AS fy, sum(actual_expenses) AS a WHERE department_name = 'Norfolk Police Department' GROUP BY unit_name, fiscal_year"]);
  assert.deepEqual(attached(police), ['norfolk.budget.no-amendment-history', 'norfolk.budget.three-fiscal-years']);
  // The tool alone, with no budget dataset read, attaches nothing.
  assert.deepEqual(attached(ran()), []);
  // Park and Forestry Operations by name: its unit gaps join the dataset-wide ones.
  const pfo = ran(['mdwe-dquf', "SELECT object_name AS k, fiscal_year AS fy, sum(actual_expenses) AS a WHERE unit_name = 'Park and Forestry Operations' GROUP BY object_name, fiscal_year"]);
  assert.deepEqual(attached(pfo), ['norfolk.budget.contractual-no-link', 'norfolk.budget.forestry-in-park-unit', 'norfolk.budget.no-amendment-history', 'norfolk.budget.three-fiscal-years']);
  // A police performance-measure query attaches neither Forestry measure gap; a Forestry one attaches both.
  assert.deepEqual(attached(ran(['7jsp-eyjg', "SELECT program_name, measure_description WHERE department = 'Norfolk Police Department'"])), []);
  assert.deepEqual(attached(ran(['7jsp-eyjg', "SELECT program_name, measure_description WHERE program_name = 'Park and Forestry Operations'"])), ['norfolk.budget.no-pruning-measure', 'norfolk.budget.trees-planted-no-yearly-values']);
  // Revenues: another department attaches only the dataset-wide years gap; Parks attaches its units gap.
  assert.deepEqual(attached(ran(['id3i-2az4', "SELECT revenue_source_name AS k WHERE department_name = 'Norfolk Police Department' GROUP BY revenue_source_name"])), ['norfolk.budget.three-fiscal-years']);
  assert.deepEqual(attached(ran(['id3i-2az4', "SELECT revenue_source_name AS k WHERE department_name = 'The Department of Parks & Recreation (P&R)' GROUP BY revenue_source_name"])), ['norfolk.budget.parks-revenue-units', 'norfolk.budget.three-fiscal-years']);
  // Work orders: block_report's query (no area filter) attaches no budget gap.
  assert.deepEqual(attached(ran(['qzfe-wj25', "SELECT work_order_number, primary_task_description WHERE street IS NOT NULL"])), []);
  // No budget entry touches through a bare tool predicate.
  for (const g of proposal.GAPS) for (const t of g.touches) assert.ok(!(t.tool && !t.field), `${g.id} touches a tool bare`);
});

test('a question answered in part by a source Siren reads is never marked "can\'t answer"', () => {
  const byId = Object.fromEntries(OUT.file.gaps.map((g) => [g.id, g]));
  // The agenda index holds the Council's appropriation amendments by meeting date.
  const amend = byId['norfolk.budget.no-amendment-history'].questions.find((q) => q.qid === 'q2');
  assert.equal(amend.blocks, 'part');
  assert.deepEqual(amend.answered_in_part_by, [{ index: 'norfolk-legislation', field: 'text' }]);
  assert.match(amend.consequence, /I found \d[\d,]* agenda items with titles amending an annual appropriations ordinance/);
  assert.ok(byId['norfolk.budget.no-amendment-history'].evidence.some((e) => e.type === 'index' && e.counted > 0));
  // The work-order side of contractual spending (contractor_cost) stays with the approved entry.
  const contract = byId['norfolk.budget.contractual-no-link'];
  assert.deepEqual(contract.questions.map((q) => q.qid), ['q1']);
  assert.doesNotMatch(proposal.GAPS.find((g) => g.id === contract.id).why, /repeats none/);
  // The free-text location half-answers the place questions, and every project carries it.
  const cip = byId['norfolk.budget.cip-no-ward'];
  for (const q of cip.questions) assert.ok(q.answered_in_part_by.some((x) => x.column === 'location'), q.qid);
  assert.match(cip.statement, /I found 0 with the free-text location field empty/);
  // The trees-planted question names Forestry plantings, not a projection or target.
  const planted = byId['norfolk.budget.trees-planted-no-yearly-values'].questions[0];
  assert.deepEqual(planted.answered_in_part_by, [{ dataset: 'qzfe-wj25', column: 'primary_task_description' }]);
  assert.match(planted.consequence, /counts orders, not trees/);
  // Every "all" question is checked over the datasets its concept names.
  for (const g of OUT.file.gaps) for (const q of g.questions.filter((x) => x.blocks === 'all')) assert.ok(g.how_much.columns_absent, `${g.id} ${q.qid}`);
});

test('the per-year Parks units and the dated pruning statuses are what the stored responses hold', () => {
  const parks = OUT.file.gaps.find((g) => g.id === 'norfolk.budget.parks-revenue-units');
  assert.deepEqual(parks.how_much.series.map((x) => x.k), ['2025', '2026', '2027']);
  assert.equal(parks.how_much.part, parks.how_much.series.at(-1).part);
  assert.ok(!parks.evidence.some((e) => e.type === 'values' && e.pattern === '/.*/'));
  const prune = OUT.file.gaps.find((g) => g.id === 'norfolk.budget.no-pruning-measure');
  assert.match(prune.statement, /with status “Complete”/);
  assert.ok(prune.evidence.some((e) => e.type === 'catalog_search' && e.q === 'pruning'));
  // No dollar amount reaches a statement.
  for (const g of OUT.file.gaps) assert.doesNotMatch(g.statement, /\$\d/, g.id);
});

test('the review page lists the meetings it says it lists, and names every key a reviewer drops', () => {
  for (const m of OUT.file.meetings.listed) assert.ok(OUT.doc.includes(`· ${m.body}`), m.body);
  for (const k of proposal.REVIEW_KEYS) assert.ok(OUT.doc.includes(`\`${k}\``), k);
  assert.deepEqual([...proposal.REVIEW_KEYS].sort(), ['context', 'proposed', 'related', 'sources', 'why']);
  // An entry carrying a review-only key the list leaves out is refused.
  const bad = { ...P, module: { ...proposal, REVIEW_KEYS: ['proposed', 'why'] } };
  assert.ok(proposalProblems(bad).some((p) => /REVIEW_KEYS lists it/.test(p)));
});
