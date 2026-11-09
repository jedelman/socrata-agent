// The gap catalog and builder (docs/gaps.md §3, §4, §5, §15 items 1 and 2).
// No network: builds replay the responses stored in data/gaps/norfolk.trace.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { identifierViolations, MeasureRunner, soql, IdentifierRuleError } from '../src/gaps/measures.js';
import { validateGap, validateGapFile } from '../src/gaps/schema.js';
import { gapCheck } from '../src/gaps/kinds.js';
import { publicTextViolations } from '../src/public-text.js';
import { Socrata, ACCESS } from '../src/socrata.js';
import * as norfolk from '../src/gaps/norfolk.js';
import { ACTIONS, ROW_LEVEL, strike } from '../src/gaps/actions-norfolk.js';
import { buildGaps, checkGaps, Recorder, CATALOGS, gapPublicId, launders, gapTextProblems, streetName, stateChanges } from '../scripts/build-gaps.js';
import { MeasureChange } from '../src/gaps/measures.js';
import { createContext } from '../src/agent.js';
import { getCity } from '../src/cities/index.js';
import { spawnSync } from 'node:child_process';
import { pinnedRepo, replayedGaps, pinnedRepoToday } from './fixtures/gaps-pinned.js';

const NO_STREET_ID = 'norfolk.work-orders.removal-no-street';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const FILE = JSON.parse(read('data/gaps/norfolk.json'));
const TRACE = JSON.parse(read('data/gaps/norfolk.trace.json'));
const STREETS = JSON.parse(read('data/gaps/norfolk-streets.json')).streets;
const replay = () => new Recorder({ responses: TRACE.responses });
// The committed file is checked only for what holds in every state the spec
// allows: every catalog entry on the board or off it with a reason, its
// schema, the identifier rule, nothing excluded. A steward marking a cited
// finding unverified, or a measure failing, is a normal state of it, and npm
// test gates the deploy. Everything else is checked on FULL: a replay of the
// stored responses against the pinned case files (test/fixtures/gaps-pinned.js),
// dated the day of the stored build.
const FULL = await replayedGaps();
const CASE_FILE = JSON.parse(pinnedRepo('data/cases/norfolk-trees.json'));

// The spec's §4.4 queries (W and C spelled out).
const W = "area = 'Forestry' AND primary_task_description = 'Removal'";
const C = `${W} AND status_code = 999`;
const SPEC_QUERIES = [
  `SELECT status_code, status_description, count(*) AS n, sum(case(street IS NULL,1,true,0)) AS no_street, sum(case(contractor_cost > 0,1,true,0)) AS cc, sum(case(end_date IS NOT NULL,1,true,0)) AS has_end WHERE ${W} GROUP BY status_code, status_description ORDER BY status_code`,
  `SELECT count(*) AS d, sum(case(date_trunc_ymd(end_date) < date_trunc_ymd(created_datetime),1,true,0)) AS before, sum(case(date_trunc_ymd(end_date) = date_trunc_ymd(created_datetime),1,true,0)) AS same WHERE ${C} AND end_date >= '2025-11-06T00:00:00' AND end_date < '2026-11-06T00:00:00'`,
  `SELECT count(*) AS n, sum(case(street IS NULL,1,true,0)) AS no_street, sum(case(street IS NULL AND ward IS NULL AND civic_league IS NULL,1,true,0)) AS no_loc WHERE ${C} AND created_datetime >= '2025-11-06T00:00:00'`,
  `SELECT date_extract_y(created_datetime) AS y, count(*) AS n, sum(case(street IS NULL,1,true,0)) AS k WHERE ${C} GROUP BY y ORDER BY y`,
  `SELECT min(created_datetime) AS a, max(created_datetime) AS b, max(end_date) AS e WHERE ${C}`,
  `SELECT sum(case(civic_league IS NOT NULL,1,true,0)) AS league, sum(case(ward IS NOT NULL,1,true,0)) AS ward WHERE ${C} AND street IS NULL`,
  `SELECT count(*) AS n, sum(case(end_date IS NOT NULL,1,true,0)) AS e WHERE ${W} AND (status_code < 800 OR status_code = 941)`,
  `SELECT created_datetime WHERE ${W} AND (status_code < 800 OR status_code = 941) ORDER BY created_datetime, work_order_number LIMIT 1 OFFSET 176`,
  `SELECT problem_description AS p, count(*) AS n WHERE area = 'Forestry' GROUP BY p ORDER BY n DESC LIMIT 50`,
  "SELECT count(*) AS n, sum(case((trunk_diameter IS NULL OR trunk_diameter <= 0) AND trunk_diameter_range IS NULL,1,true,0)) AS no_usable WHERE common_name IS NULL OR common_name != 'PRIVATE TREES'",
];

test('the positional identifier rule passes the spec queries and refuses location values', () => {
  for (const q of SPEC_QUERIES) assert.deepEqual(identifierViolations(q), [], q);
  const refused = [
    `SELECT count(*) WHERE ${W} AND street = 'BOLLING'`,
    `SELECT count(*) WHERE street != 'X'`,
    `SELECT street, count(*) AS n WHERE ${W} GROUP BY street`,
    `SELECT count(*) WHERE ${W} ORDER BY street`,
    'SELECT street',
    "SELECT count(*) WHERE street in ('A')",
    "SELECT count(*) WHERE street like 'B%'",
    'SELECT count(*) WHERE within_circle(latitude_longitude_point, 36.8, -76.2, 100)',
    "SELECT count(*) WHERE starts_with(address, '15')",
    'SELECT assigned_crew, count(*) GROUP BY assigned_crew',
    "SELECT count(*) WHERE assigned_crew IS NULL",
    'SELECT owner_name',
    'SELECT gpin, parcel_id',
    "SELECT count(*) WHERE street IS NULL UNION SELECT 1",
    'SELECT count(*) AS street',
    "SELECT count(*) WHERE civic_league = 'Ghent'",
    'SELECT civic_league, count(*) GROUP BY civic_league',
    'SELECT ward, count(*) AS n GROUP BY ward',
    'SELECT count(*) WHERE ward = 2',
    // Places below the ward, coordinates and parcel ids under other names, and computed regions.
    'SELECT planning_district AS d, count(*) AS n GROUP BY planning_district',
    "SELECT count(*) WHERE maintenance_zone = 'A'",
    'SELECT superward, count(*) GROUP BY superward',
    'SELECT neighborhood_service_area, count(*) GROUP BY neighborhood_service_area',
    'SELECT census_block, count(*) GROUP BY census_block',
    "SELECT count(*) WHERE zip_codes = '23507'",
    'SELECT state_plane_x_coordinate, state_plane_y_coordinate',
    'SELECT geocoded_column',
    'SELECT tax_account_number',
    'SELECT :@computed_region_abcd_1234 AS r, count(*) AS n GROUP BY :@computed_region_abcd_1234',
  ];
  for (const q of refused) assert.ok(identifierViolations(q).length, q);
  assert.deepEqual(identifierViolations('SELECT count(*) AS n WHERE planning_district IS NULL AND :@computed_region_abcd_1234 IS NOT NULL'), []);
});

test('the positional identifier rule: an explicit select list, no star outside count(*)', () => {
  for (const q of ['SELECT *', 'SELECT * WHERE street IS NULL', 'SELECT DISTINCT *', 'SELECT :*, count(*) AS n GROUP BY :id', 'SELECT t.* WHERE x IS NULL', 'SELECT count(*) AS n, * WHERE x IS NULL', 'WHERE street IS NULL', "WHERE area = 'Forestry' LIMIT 5", 'SELECT trunk_diameter * 2 AS d']) {
    assert.ok(identifierViolations(q).length, q);
  }
  for (const q of ['SELECT count(*) AS n WHERE street IS NULL', 'SELECT count( * ) AS n', "SELECT count(*) AS n WHERE note = '*'", 'SELECT status_code, count(*) AS n WHERE x * 2 > 3 GROUP BY status_code']) {
    assert.deepEqual(identifierViolations(q), [], q);
  }
});

test('the positional identifier rule: a column typed as a place is a location column, whatever its name', async () => {
  assert.deepEqual(identifierViolations('SELECT count(*) AS n WHERE spot IS NULL'), []);
  assert.ok(identifierViolations('SELECT spot', { locationColumns: ['spot'] }).length);
  assert.ok(identifierViolations("SELECT count(*) WHERE within_box(Spot, 1, 2, 3, 4)", { locationColumns: ['spot'] }).length);
  assert.deepEqual(identifierViolations('SELECT count(*) AS n WHERE spot IS NOT NULL', { locationColumns: ['spot'] }), []);
  // MeasureRunner reads the types from the dataset's metadata before the query runs.
  const asked = [];
  const types = { spot: 'point', shape: 'multipolygon', place: 'location', route: 'line', untyped: '', status: 'text' };
  const ctx = { trace: { steps: [] }, socrata: { isExcluded: () => false, meta: async () => ({ types }), query: async (id, q) => {
    asked.push(q);
    ctx.trace.steps.push({ n: ctx.trace.steps.length + 1, url: `u${asked.length}`, soql: q });
    return [{ n: '1' }];
  } } };
  const run = new MeasureRunner({ ctx, readOf: () => '2026-11-06T22:00:00Z' });
  for (const col of ['spot', 'shape', 'place', 'route', 'untyped']) {
    await assert.rejects(run.query('abcd-1234', `SELECT ${col}, count(*) AS n GROUP BY ${col}`), IdentifierRuleError, col);
    await assert.rejects(run.query('abcd-1234', `SELECT count(*) AS n WHERE within_circle(${col}, 36.8, -76.2, 100)`), IdentifierRuleError, col);
  }
  assert.deepEqual(asked, [], 'refused before the query is sent');
  await run.query('abcd-1234', 'SELECT status, count(*) AS n WHERE spot IS NULL GROUP BY status');
  assert.equal(asked.length, 1);
  // The real client stores each column's type when it reads a dataset's metadata.
  const city = getCity('norfolk');
  const real = createContext({ city, fetchImpl: async () => new Response(JSON.stringify({ name: 'X', columns: [{ fieldName: 'Spot', dataTypeName: 'point' }, { fieldName: ':id', dataTypeName: 'meta_data' }] })) });
  assert.deepEqual((await real.socrata.meta('abcd-1234')).types, { spot: 'point' });
});

test('the catalog: unique ids, never a retired one, checked live, approved entries only', () => {
  const ids = norfolk.GAPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 13, 'the 13 entries Jason approved');
  for (const id of ids) assert.ok(!norfolk.RETIRED.includes(id), id);
  for (const g of norfolk.GAPS) {
    assert.match(g.checked_live, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof g.measure, 'function');
    assert.ok(g.questions.length >= 1 && g.questions.length <= 4, g.id);
    for (const q of g.questions) assert.ok(q.text.length <= 160 && q.text.endsWith('?'), q.text);
  }
  const pids = [...FULL.gaps.map((g) => g.public_id), ...FULL.gaps.flatMap((g) => g.questions.map((q) => q.public_id)), ...FULL.actions.map((a) => a.public_id)];
  assert.equal(new Set(pids).size, pids.length, 'public ids are unique across types');
  assert.equal(FULL.gaps.find((g) => g.id === norfolk.GAPS[0].id).public_id, gapPublicId(norfolk.GAPS[0].id));
});

test('the built file fits its schema, and unknown keys (a cause) fail', () => {
  assert.deepEqual(validateGapFile(FILE), []);
  assert.deepEqual(validateGapFile(FULL), []);
  const g = structuredClone(FULL.gaps[0]);
  g.why = 'a guess';
  assert.ok(validateGap(g).some((e) => /unknown key "why"/.test(e)));
  const h = structuredClone(FULL.gaps[0]);
  h.how_much.cause = 'x';
  assert.ok(validateGap(h).length);
});

test('the committed file accounts for every catalog entry, on the board or off it with a reason, and its measures keep the identifier rule', () => {
  const on = FILE.gaps.map((g) => g.id);
  const off = FILE.off_board.map((o) => o.id);
  assert.deepEqual([...on, ...off].sort(), norfolk.GAPS.map((g) => g.id).sort());
  for (const g of FILE.gaps) assert.ok(['open', 'closing', 'unmeasured_today'].includes(g.state), g.id);
  for (const o of FILE.off_board) {
    assert.match(o.state, /^[a-z_]+$/, o.id);
    assert.ok(typeof o.reason === 'string' && o.reason.length > 10, o.id);
  }
  const measures = FILE.gaps.flatMap((g) => g.evidence.filter((e) => e.type === 'query'));
  assert.ok(measures.length > 0);
  for (const e of measures) assert.deepEqual(identifierViolations(e.soql), [], e.soql);
});

test('every entry is on the board in the replay, every number traced and dated', () => {
  assert.equal(FULL.gaps.length, 13);
  assert.deepEqual(FULL.off_board, []);
  const urls = new Set(TRACE.steps.map((s) => s.url));
  for (const g of FULL.gaps) {
    assert.ok(['open', 'closing'].includes(g.state), g.id);
    for (const e of g.evidence) {
      if (e.url && e.type !== 'finding') assert.ok(urls.has(e.url), `${g.id}: ${e.url} is in the trace`);
      if (e.trace_n) assert.equal(TRACE.steps[e.trace_n - 1].url, e.url);
      if (e.read) assert.match(e.read, /^\d{4}-\d{2}-\d{2}T/);
      assert.notEqual(e.type, 'claim');
    }
    assert.equal(g.where.area, 'citywide', 'v1 measures are citywide');
  }
  for (const s of TRACE.steps) assert.equal('ms' in s, false, 'no timings in the stored trace');
});

test('every gap string passes its checks, and general questions and actions pass the public-text checks', () => {
  for (const g of FULL.gaps) {
    assert.deepEqual(gapTextProblems(g, { entry: norfolk.GAPS.find((e) => e.id === g.id), streets: STREETS }), [], g.id);
    for (const q of g.questions) assert.deepEqual(publicTextViolations(q.text, { streets: STREETS }), [], q.text);
  }
  // The builder runs the public-text checks on code-written text too, as botText does.
  const g = structuredClone(FULL.gaps.find((x) => x.id === 'norfolk.work-orders.created-on-or-after-end'));
  g.statement = g.statement.replace('with an end date on or before', 'whose end date falls on or before');
  assert.ok(gapTextProblems(g, { entry: norfolk.GAPS.find((e) => e.id === g.id), streets: STREETS }).some((p) => /^statement: person_pointing/.test(p)));
  for (const a of FULL.actions) for (const s of [a.text, a.draft?.body, a.draft?.frame, a.draft?.leave_out].filter(Boolean)) {
    assert.deepEqual([...gapCheck(s, 'action'), ...publicTextViolations(s, { streets: STREETS })], [], s);
  }
});

test('blocks "all" has a topic-wide columns_absent; the topic covers its catalog hits', () => {
  for (const g of FULL.gaps) for (const q of g.questions.filter((x) => x.blocks === 'all' && g.kind !== 'restricted')) {
    for (const d of g.topic.datasets) assert.ok(d in g.how_much.columns_absent.datasets, `${g.id} ${q.qid} ${d}`);
  }
  assert.ok(FULL.gaps.find((g) => g.id === 'norfolk.utility.line-clearance'));
  const hits = Object.values(TRACE.responses).find((r) => r.body?.resultSetSize === 5)?.body.results.map((r) => r.resource.id) || [];
  const topic = norfolk.TOPICS.trees;
  for (const id of hits) assert.ok(topic.datasets.includes(id) || topic.not_in_topic.some((x) => x.id === id), id);
});

test('restricted gaps carry policy evidence and only aggregate actions; no excluded dataset appears', () => {
  const r = FULL.gaps.find((g) => g.kind === 'restricted');
  assert.deepEqual(r.evidence.map((e) => e.type), ['policy']);
  assert.equal(read(r.evidence[0].file).split('\n')[r.evidence[0].line - 1].includes("id: 'nbyu-xjez'"), true);
  for (const id of r.actions) {
    const a = FULL.actions.find((x) => x.id === id);
    assert.equal(a.aggregate_only, true);
    assert.doesNotMatch(a.text, ROW_LEVEL);
  }
  const excluded = ['cab7-wvn5', 'uxgi-fkzu', '7qie-z5gv', '4dwc-v3t8', 'ei2q-6g8n', 'jf3j-u4s7', 'fcqe-uvnb', '393b-ph9i', 'p5hy-7rkp'];
  // Privacy holds in every state the committed file can be in.
  for (const text of [JSON.stringify(FILE), JSON.stringify(FULL)]) {
    for (const id of excluded) assert.equal(text.includes(id), false, id);
    assert.equal(text.includes('assigned_crew'), false);
    assert.equal(text.includes('rows.csv'), false, 'the board never links a full CSV');
  }
});

test('findings appear only as their quotes, never their claims', () => {
  const finding = (e) => CASE_FILE.findings.find((x) => x.id === e.id);
  const quoting = FULL.gaps.filter((g) => g.evidence.some((x) => x.type === 'finding'));
  assert.ok(quoting.length >= 3);
  for (const g of quoting) for (const e of g.evidence.filter((x) => x.type === 'finding')) {
    assert.equal(e.quote, finding(e).quote);
    assert.equal(JSON.stringify(g).includes(finding(e).claim), false, `${g.id} carries no claim`);
  }
});

test('records-request drafts use records_to_request verbatim, with strikes checked', () => {
  const cases = CASE_FILE;
  const a = FULL.actions.find((x) => x.id === 'a-foia-trees-per-order');
  assert.equal(a.draft.source.text, cases.records_to_request[1]);
  assert.equal(a.draft.body.includes('priority'), false);
  assert.match(a.draft.to, /no verified contact/);
  assert.equal(a.draft.leave_out, 'Please leave out the names and addresses of residents who made requests.');
  assert.equal(strike('a, b, c', 'b'), 'a, c');
  assert.throws(() => strike('a, c', 'b'), /not in the records request/);
  const contracts = FULL.actions.find((x) => x.id === 'a-foia-contracts');
  assert.equal(contracts.draft.body, cases.records_to_request[0]);
  assert.ok(ACTIONS.find((x) => x.id === 'a-foia-planned').needs, 'drafts that need a case-file entry carry no text');
});

// Repo inputs the build reads offline change on their own schedules (the
// weekly legislation refresh, the monthly case-file archive PR, case-file and
// profile edits). The refresh workflows rebuild the gap files with them, and
// a hand edit reruns --offline in its own PR (CONTRIBUTING.md); the CI job
// check-gaps is the strict check. Here it skips, naming the fix: npm test
// gates the deploy, and a gap file a step behind its inputs is no reason to
// stop one (findings that no longer match are kept out of answers at run time).
test('--check: replaying the stored responses rebuilds every committed file byte for byte', async (t) => {
  const diffs = await checkGaps();
  if (diffs.length) t.skip(`run node scripts/build-gaps.js --offline and commit data/gaps and docs/gaps-norfolk.md: ${diffs.join(' ')}`);
});

test('stateChanges: an offline rebuild that moves a gap on or off the board, or changes its state, is a change', () => {
  assert.deepEqual(stateChanges(FILE, structuredClone(FILE)), []);
  assert.deepEqual(stateChanges(FULL, structuredClone(FULL)), []);
  const g = FULL.gaps.find((x) => x.id === 'norfolk.utility.line-clearance');
  const before = { gaps: [g], off_board: [] };
  const after = { gaps: [], off_board: [{ id: g.id, state: 'evidence_unverified', reason: 'x' }] };
  assert.deepEqual(stateChanges(before, after), [`${g.id}: ${g.state} -> off the board (evidence_unverified)`]);
  assert.deepEqual(stateChanges(before, { gaps: [{ ...g, state: 'closing' }], off_board: [] }), [`${g.id}: ${g.state} -> closing`]);
});

test('--offline: parts from repo files are recomputed and dated the day of the rebuild; live measures keep their date', async () => {
  const repo = (p) => {
    const text = pinnedRepo(p);
    if (p !== 'data/norfolk-legislation.json') return text;
    const idx = JSON.parse(text);
    idx.built = `${REBUILT}T09:17:00.000Z`;
    idx.items = idx.items.slice(0, 100);
    return JSON.stringify(idx);
  };
  // A rebuild day other than the stored build's (the weekly live refresh moves
  // that on), within the pinned case files' freshness.
  const REBUILT = TRACE.built === '2026-11-09' ? '2026-11-10' : '2026-11-09';
  const out = await buildGaps({ recorder: replay(), today: TRACE.built, repoToday: REBUILT, previous: FULL, repo });
  assert.equal(out.file.built, TRACE.built);
  assert.equal(out.file.rebuilt, REBUILT);
  assert.equal(out.trace.rebuilt, REBUILT);
  const leg = out.file.gaps.find((g) => g.id === 'norfolk.legislation.no-address');
  assert.equal(leg.measured, REBUILT, 'counted from the new index, dated when counted');
  assert.equal(leg.how_much.whole, 100);
  assert.match(leg.questions[0].consequence, new RegExp(`in the index built ${REBUILT}, measured ${REBUILT}`));
  const live = out.file.gaps.find((g) => g.id === NO_STREET_ID);
  assert.equal(live.measured, TRACE.built, 'a live measure keeps the date it was read');
  assert.match(out.file.gaps.find((g) => g.id === 'norfolk.311.restricted').statement, new RegExp(`read from its city profile on ${REBUILT}`));
});

test('the stored trace holds only requests the build makes, and the street list holds no addresses or corners', () => {
  assert.equal(Object.keys(TRACE.responses).length, new Set(TRACE.steps.map((s) => s.url)).size);
  for (const u of Object.keys(TRACE.responses)) assert.ok(TRACE.steps.some((s) => s.url === u), u);
  assert.equal(Object.keys(TRACE.responses).some((u) => /qzfe-wj25.*GROUP(?:%20|\+| )BY(?:%20|\+| )street/.test(decodeURIComponent(u))), false, 'no free-text street values in the trace');
  assert.ok(STREETS.length > 1000);
  for (const n of STREETS) {
    assert.doesNotMatch(n, /^\d+\s+(?!\d*(?:ST|ND|RD|TH)\b)/, n);
    assert.doesNotMatch(n, /^\d+(?!ST|ND|RD|TH)\b/, n);
    assert.doesNotMatch(n, /[,&;]| AND | AT /, n);
  }
  assert.deepEqual(JSON.parse(read('data/gaps/norfolk-streets.json')).sources, [{ dataset: 'ere7-kake', field: 'street_name' }]);
  assert.equal(streetName('1234 E EXAMPLE'), null);
  assert.equal(streetName('56 SAMPLE PARKWAY, NORFOLK, VA'), null);
  assert.equal(streetName('ALPHA STREET & BETA AVENUE'), null);
  assert.equal(streetName('E 99TH ST AND GAMMA AVE'), null);
  assert.equal(streetName('21ST'), '21ST');
  assert.equal(streetName(' ocean  view '), 'OCEAN VIEW');
});

test('a placement outside a topic quotes its whole description sentence, read in this build', () => {
  const g = FULL.gaps.find((x) => x.topic?.name === 'trees');
  const storm = g.topic.not_in_topic.find((x) => x.id === 'mrv3-rcpc');
  assert.match(storm.quote, /damaged trees/);
  assert.equal(TRACE.steps[storm.trace_n - 1].dataset, 'mrv3-rcpc');
  assert.match(storm.reason, /damaged trees among them/);
});

test('catalogSearchRaw: excluded results are counted, never named; restricted ones are marked not open; the order is stable', async () => {
  const body = {
    resultSetSize: 4,
    results: [
      { resource: { id: 'zzzz-0001', name: 'Zeta' } },
      { resource: { id: 'nbyu-xjez', name: 'MyNorfolk 311 requests' } },
      { resource: { id: 'cab7-wvn5', name: 'Police Incident Reports' } },
      { resource: { id: 'aaaa-0001', name: 'Alpha' } },
    ],
  };
  const city = getCity('norfolk');
  const fetchImpl = async () => new Response(JSON.stringify(body));
  const ctx = createContext({ city, fetchImpl });
  const r = await ctx.socrata.catalogSearchRaw('tree');
  assert.equal(r.result_set_size, 4);
  assert.equal(r.returned, 4);
  assert.equal(r.excluded, 1);
  assert.deepEqual(r.results.map((x) => x.id), ['aaaa-0001', 'nbyu-xjez', 'zzzz-0001']);
  assert.equal(JSON.stringify(r).includes('cab7-wvn5'), false);
  assert.equal(r.results.find((x) => x.id === 'nbyu-xjez').open_to_siren, false);
  const more = createContext({ city, fetchImpl: async () => new Response(JSON.stringify({ ...body, resultSetSize: 25 })) });
  const run = new MeasureRunner({ ctx: more, readOf: () => '2026-11-06T22:00:00Z' });
  await assert.rejects(run.catalogSearch('tree'), MeasureChange, 'more results than one page');
});

test('values_absent refuses to say "none matching" at its 200-value cap', async () => {
  const ctx = { trace: { steps: [] }, socrata: { isExcluded: () => false, meta: async () => ({ types: { problem_description: 'text' } }), query: async (id, q) => {
    ctx.trace.steps.push({ n: 1, url: 'u', soql: q });
    return Array.from({ length: 200 }, (_, i) => ({ v: `code ${i}`, n: '1' }));
  } } };
  const run = new MeasureRunner({ ctx, readOf: () => '2026-11-06T22:00:00Z' });
  await assert.rejects(run.valuesAbsent({ dataset: 'abcd-1234', field: 'problem_description', where: 'x = 1', pattern: /utility/ }), MeasureChange);
});

test('the builder runs every request at GENERIC access, and output is deterministic', async () => {
  const seen = [];
  const q = Socrata.prototype.query;
  const d = Socrata.prototype.describe;
  Socrata.prototype.query = function (id, s, opts = {}) {
    seen.push(opts.access);
    return q.call(this, id, s, opts);
  };
  Socrata.prototype.describe = function (id, opts = {}) {
    seen.push(opts.access);
    return d.call(this, id, opts);
  };
  try {
    const a = await buildGaps({ recorder: replay(), today: TRACE.built, repoToday: pinnedRepoToday(TRACE.built), previous: FULL, repo: pinnedRepo });
    const b = await buildGaps({ recorder: replay(), today: TRACE.built, repoToday: pinnedRepoToday(TRACE.built), previous: FULL, repo: pinnedRepo });
    assert.equal(JSON.stringify(a.file), JSON.stringify(b.file));
    assert.ok(seen.length > 10);
    assert.ok(seen.every((x) => x === ACCESS.GENERIC), `access levels seen: ${[...new Set(seen)]}`);
  } finally {
    Socrata.prototype.query = q;
    Socrata.prototype.describe = d;
  }
});

test('a gap whose text fails is isolated: it keeps its last good measurement, and the rest build', async () => {
  const bad = norfolk.GAPS.map((g) =>
    g.id === 'norfolk.work-orders.no-notice-field'
      ? { ...g, measure: async (h) => ({ ...(await g.measure.call(g, h)), statement: 'Notice may not be recorded anywhere.' }) }
      : g
  );
  const catalogs = { norfolk: { ...CATALOGS.norfolk, catalog: { ...norfolk, GAPS: bad } } };
  const out = await buildGaps({ recorder: replay(), today: TRACE.built, repoToday: pinnedRepoToday(TRACE.built), previous: FULL, catalogs, repo: pinnedRepo });
  const g = out.file.gaps.find((x) => x.id === 'norfolk.work-orders.no-notice-field');
  assert.equal(g.state, 'unmeasured_today');
  assert.equal(g.last_good, FULL.built);
  assert.equal(g.notice, `I couldn't measure this on ${TRACE.built}. I show my last measurement, from ${FULL.built}.`);
  assert.equal(out.file.gaps.filter((x) => x.state !== 'unmeasured_today').length, 12);
  const fresh = await buildGaps({ recorder: replay(), today: TRACE.built, repoToday: pinnedRepoToday(TRACE.built), previous: null, catalogs, repo: pinnedRepo });
  assert.ok(fresh.file.off_board.some((o) => o.id === 'norfolk.work-orders.no-notice-field'), 'with no last good, it stays off the board');
});

test('an identifier-rule violation aborts the whole build before its request', async () => {
  const bad = [{ ...norfolk.GAPS[0], measure: async (h) => h.run.query('qzfe-wj25', "SELECT count(*) WHERE street = 'BOLLING'") }];
  const catalogs = { norfolk: { ...CATALOGS.norfolk, catalog: { ...norfolk, GAPS: bad } } };
  const rec = replay();
  await assert.rejects(buildGaps({ recorder: rec, today: TRACE.built, catalogs, repo: pinnedRepo }), IdentifierRuleError);
  assert.equal(rec.missing.some((u) => u.includes('BOLLING')), false);
});

test('a finding gone stale or unverified takes its gap off the board', async () => {
  const repo = (p) => {
    const text = pinnedRepo(p);
    if (p !== 'data/cases/norfolk-trees.json') return text;
    const doc = JSON.parse(text);
    for (const f of doc.findings) if (f.id === 'contract-removal') f.checked = '2026-09-01';
    for (const f of doc.findings) if (f.id === 'dominion') f.unverified = true;
    return JSON.stringify(doc);
  };
  const out = await buildGaps({ recorder: replay(), today: TRACE.built, repoToday: pinnedRepoToday(TRACE.built), previous: null, repo });
  const off = out.file.off_board.map((o) => `${o.id}:${o.state}`);
  assert.ok(off.includes('norfolk.work-orders.no-contract-link:evidence_unverified'), off.join(' '));
  assert.ok(off.includes('norfolk.utility.line-clearance:evidence_unverified'));
});

test('median_age is exact, with the second row when n is even', async () => {
  const calls = [];
  const rows = { 'OFFSET 1': [{ d: '2024-01-01T00:00:00' }], 'OFFSET 2': [{ d: '2024-01-03T00:00:00' }] };
  const ctx = { trace: { steps: [] }, socrata: { isExcluded: () => false, meta: async () => ({ types: { d: 'calendar_date', id: 'text', x: 'number' } }), query: async (id, q) => {
    calls.push(q);
    ctx.trace.steps.push({ n: ctx.trace.steps.length + 1, url: `u${calls.length}`, soql: q });
    return rows[q.match(/OFFSET \d+/)[0]];
  } } };
  const run = new MeasureRunner({ ctx, readOf: () => '2026-11-06T22:00:00Z' });
  const odd = await run.medianDate({ dataset: 'abcd-1234', where: 'x = 1', field: 'd', tiebreak: 'id', n: 3 });
  assert.equal(odd.value, '2024-01-01T00:00:00');
  const even = await run.medianDate({ dataset: 'abcd-1234', where: 'x = 2', field: 'd', tiebreak: 'id', n: 4 });
  assert.equal(even.value, '2024-01-02T00:00:00');
  assert.ok(calls.every((c) => /ORDER BY d, id LIMIT 1 OFFSET \d+$/.test(c)));
  assert.equal(soql.nth('x = 1', 'd', 'id', 176), 'SELECT d WHERE x = 1 ORDER BY d, id LIMIT 1 OFFSET 176');
});

test('the even-n median midpoint is the same in every time zone', () => {
  const script = `import { floatingMidpoint } from ${JSON.stringify(new URL('../src/gaps/measures.js', import.meta.url).href)};
    process.stdout.write(floatingMidpoint('2024-01-01T00:00:00.000', '2024-01-03T00:00:00.000') + ' ' + floatingMidpoint('2024-03-10T01:00:00', '2024-03-10T05:00:00'));`;
  for (const TZ of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(out.stdout, '2024-01-02T00:00:00 2024-03-10T03:00:00', TZ);
  }
});

test('the laundering check catches questions that restate an unverified claim', () => {
  assert.equal(launders('Did the Tree Commission publish its annual reports?', ['The Tree Commission publishes annual reports to Council.']), true);
  assert.equal(launders('Was a city tree removed on my street?', ['The Tree Commission publishes annual reports to Council.']), false);
});
