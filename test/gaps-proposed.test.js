// Proposed gap entries (src/gaps/proposed/): drafts for Jason's review, never
// part of the catalog. Catalog entries go public when merged and each new one
// needs his approval (docs/gaps.md §4), so nothing that ships may import a
// proposal, and the catalog builder must never read one. No network: the
// proposal replays its stored responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGap, validateGapFile } from '../src/gaps/schema.js';
import { gapTextViolations } from '../src/gaps/kinds.js';
import { publicTextViolations, compileStreets } from '../src/public-text.js';
import * as proposal from '../src/gaps/proposed/norfolk-budget.js';
import * as norfolk from '../src/gaps/norfolk.js';
import { CATALOGS, Recorder } from '../scripts/build-gaps.js';
import { PROPOSALS, buildProposed, proposalProblems, proseProblems } from '../scripts/build-gaps-proposed.js';
import { pinnedRepo } from './fixtures/gaps-pinned.js';

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
const IMPORTS_PROPOSED = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\bproposed\//;

test('nothing under src/ or worker/ (or bin/, plugins/, deployments/) imports a proposal', () => {
  const shipped = ['src', 'worker', 'bin', 'plugins', 'deployments'].flatMap(files).filter((f) => /\.(m?js|html|json)$/.test(f) && !f.startsWith(join('src', 'gaps', 'proposed')));
  assert.ok(shipped.length > 20);
  for (const f of shipped) assert.doesNotMatch(read(f), IMPORTS_PROPOSED, `${f} imports a proposal`);
  // The pattern itself catches each form of import.
  for (const s of ["import x from './proposed/norfolk-budget.js'", "await import('../gaps/proposed/a.js')", "import * as p from '../src/gaps/proposed/norfolk-budget.js'"]) assert.match(s, IMPORTS_PROPOSED);
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

test('the replay measures every proposed entry, in the catalog schema, at the request count stored', () => {
  assert.deepEqual(OUT.file.off_board, []);
  assert.deepEqual(OUT.file.gaps.map((g) => g.id).sort(), proposal.GAPS.map((g) => g.id).sort());
  assert.deepEqual(validateGapFile(OUT.file), []);
  for (const g of OUT.file.gaps) assert.deepEqual(validateGap(g), [], g.id);
  assert.deepEqual(TRACE.file, OUT.file);
  assert.equal(TRACE.proposed, true);
  assert.equal(TRACE.steps.length, OUT.trace.steps.length);
});

test('the committed page and trace are what the stored responses build', () => {
  assert.equal(read(P.doc), OUT.doc, `run node scripts/build-gaps-proposed.js and commit ${P.doc}`);
  assert.deepEqual(JSON.parse(JSON.stringify(OUT.trace)), TRACE);
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
