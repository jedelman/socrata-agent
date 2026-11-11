// budget_for and capital_projects, against a fake network. The metadata
// fixture is the live /api/views metadata of 2026-11-06, trimmed; the row
// fixtures reuse that day's live figures for Park and Forestry Operations
// (and the FY2027 CIP's Maury High School row) so the cross-check numbers
// in the task are what the tests assert. The PFO category rows are split so
// their per-year sums are that day's unit totals (budget_for sums its
// by_fiscal_year from them), and the Cemeteries pairs are the live FY2025 to
// FY2026 move of that unit. No test touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPlugin, checkPluginFile } from './conformance.js';
import { getCity } from '../src/cities/index.js';
import { toolsFor } from '../src/tools.js';
import { applyConfig } from '../src/plugins.js';
import budgetFor, { matchName, nameKey, closest, checkYears, fiscalYearOf, perfValue, fromDescription, fromColumn, pivot, sumByYear, negativeGroups, reorgNotes, SOQL, MAX_CHARS } from '../plugins/budget-for.js';
import capitalProjects, { SOQL as CIP_SOQL, shorten, matchProjects } from '../plugins/capital-projects.js';
import siren from '../deployments/siren.config.js';

const norfolk = getCity('norfolk');
const views = JSON.parse(readFileSync(new URL('./fixtures/norfolk-budget-views.json', import.meta.url), 'utf8'));
const PR = 'The Department of Parks & Recreation (P&R)';
const PFO = 'Park and Forestry Operations';

const HELD = [2025, 2026, 2027];
const pair = (d, u, [a, b, c]) => ({ d, u, n2025: String(a), n2026: String(b), n2027: String(c) });
const pairs = [
  pair('Cemeteries', 'Cemetery', [52, 0, 0]),
  pair('Fire-Rescue', 'Operations', [7, 7, 6]),
  pair('Parking Facilities Fund', 'Operations', [3, 3, 3]),
  pair('Public Health', 'Public Health', [28, 29, 28]),
  pair('Public Works', 'Streets And Bridges', [20, 20, 20]),
  pair('Public Works', 'Bureau Of Design', [13, 14, 13]),
  pair(PR, 'Cemeteries', [0, 53, 52]),
  pair(PR, PFO, [37, 40, 39]),
  pair(PR, 'Recreation Centers', [31, 32, 31]),
  pair('Zoological Park', 'Operations', [4, 4, 4]),
];
const year = (fy, actual, budget, lines) => ({ fy: String(fy), actual: String(actual), budget: String(budget), lines: String(lines) });

function rowsFor(id, q) {
  if (id === 'mdwe-dquf') {
    if (q.includes('GROUP BY department_name, unit_name')) return pairs;
    if (q.includes('GROUP BY object_name'))
      return [
        { k: 'Other Contractual Services', c: 'Contractual Services', ...year(2025, 682683.08, 1650043, 1) },
        { k: 'Other Contractual Services', c: 'Contractual Services', ...year(2026, 1341543.97, 1200643, 1) },
        { k: 'Other Contractual Services', c: 'Contractual Services', ...year(2027, 342784.87, 1205743, 1) },
        { k: 'Allocations, Departmental', ...year(2026, 2518, 0, 1) },
      ];
    if (q.includes('GROUP BY expenditure_category') && q.includes(`unit_name = '${PFO}'`))
      return [
        { k: 'Personnel Services', ...year(2025, 11536917, 11728050, 37) },
        { k: 'Contractual Services', ...year(2026, 12167340.89, 12661811, 39) },
        year(2026, 2518, 0, 1),
        { k: 'Contractual Services', ...year(2027, 4020158.69, 13139514, 39) },
      ];
    if (q.includes('GROUP BY expenditure_category')) return [{ k: 'Contractual Services', ...year(2026, 2244650, 2045616, 9) }, year(2026, 2518, 0, 1)];
    if (q.includes('GROUP BY unit_name')) return [{ k: PFO, ...year(2026, 12169858.89, 12661811, 40) }, { k: 'Cemeteries', ...year(2026, 2400000, 2500000, 53) }];
    if (q.includes('GROUP BY department_name')) return [{ k: 'Norfolk Public Schools', ...year(2025, 188114125, 459184115, 1) }, { k: PR, ...year(2025, 22823047, 23500000, 190) }, { k: PR, ...year(2026, 25412616, 26939667, 200) }];
    if (q.includes('GROUP BY fund_name')) return [{ k: 'General Fund', ...year(2026, -5, 10, 3) }];
    if (q.includes('GROUP BY fiscal_year')) return [year(2025, 1049072528.51, 1551366330, 4376), year(2026, 1125906792.91, 1580172233.46, 4636), year(2027, 377428006.82, 1636732443, 4323)];
  }
  if (id === 'id3i-2az4') {
    if (q.includes('GROUP BY department_name, unit_name')) return [{ d: PR, u: 'Recreation Parks Open Space', n: '6' }, { d: PR, u: PFO, n: '1' }, { d: 'Public Works', u: 'Streets And Bridges', n: '9' }];
    if (q.includes('GROUP BY revenue_source_name')) return [{ k: 'Revenue-Other Miscellaneous', ...year(2027, 1937.16, 0, 1) }];
    if (q.includes('GROUP BY revenue_name')) return [{ k: 'General Property Taxes', ...year(2026, 1, 2, 1) }];
    if (q.includes('GROUP BY fiscal_year')) return [year(2025, 1286583448.09, 1551366330, 506), year(2026, 1314041757.47, 1580172233.46, 493), year(2027, 364423740.02, 1636746651, 478)];
  }
  if (id === '7jsp-eyjg') {
    if (q.includes('GROUP BY department, program_name')) return [{ d: 'Parks and Recreation', p: PFO, n: '2' }, { d: 'Parks and Recreation', p: 'Aquatics', n: '1' }, { d: 'Public Works', p: 'Streets', n: '1' }];
    return [
      { program_name: PFO, measure_description: 'Number of trees planted', demand_level: 'Does Not Meet Demand', fy_2026_projection: '700', fy_2027_adopted: '700', fy_2027_target: '1000' },
      { program_name: PFO, measure_description: 'A yes-or-no measure (test row)', fy_2025: '99999', fy_2026_projection: '99998' },
    ];
  }
  if (id === '6tqj-4az3' || id === 'jbfz-2t3g') {
    if (q.includes('GROUP BY department, ward')) return [{ d: 'Norfolk Public Schools', w: '2', n: '3' }, { d: 'Parks and Recreation', w: '4', n: '5' }, { d: 'Public Works', n: '7' }];
    if (q.includes('GROUP BY department')) return [{ k: 'Norfolk Public Schools', n: '1', p: '1', total: '158500000', first: '65500000' }];
    if (q.includes('GROUP BY ward')) return [{ k: '2', n: '1', p: '1', total: '158500000', first: '65500000' }, { n: '7', p: '5', total: '10', first: '5' }];
    if (q.includes('no_coords')) return [{ n: '25', p: '20', total: '395186000', first: '181451000', no_coords: '0', no_ward: '0' }];
    return [
      { project_id: '3039', department: 'Norfolk Public Schools', project_name: 'Construct Maury High School', master_project_name: 'Maury', subproject_name: 'Phase 1', description: 'This project supports the design and construction of a new Maury High School. '.repeat(6), location: '20th Street and Llewellyn Avenue', ward: '2', latitude: '36.8658', longitude: '-76.2901', amount: '158500000', amount_fy_27: '65500000' },
    ];
  }
  throw new Error(`unexpected query on ${id}: ${q}`);
}

function respond(url) {
  const view = url.match(/\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})\.json/);
  if (view) {
    if (!views[view[1]]) throw new Error(`no metadata fixture for ${view[1]}`);
    return views[view[1]];
  }
  const m = url.match(/\/resource\/([a-z0-9]{4}-[a-z0-9]{4})\.json\?\$query=(.*)$/);
  if (m) return rowsFor(m[1], decodeURIComponent(m[2]));
  throw new Error(`unexpected request ${url}`);
}

const queries = (requests) => requests.filter((u) => u.includes('/resource/')).map((u) => decodeURIComponent(u.split('$query=')[1]));
const run = (plugin, args, r = respond) => checkPlugin(plugin, { city: norfolk, args, respond: r });

test('budget plugins pass the source check', () => {
  checkPluginFile(new URL('../plugins/budget-for.js', import.meta.url));
  checkPluginFile(new URL('../plugins/capital-projects.js', import.meta.url));
});

test('budget_for reproduces Park and Forestry Operations from the fixtures, with caveats and hand-off', async () => {
  const { result, trace, resources, requests } = await run(budgetFor, { unit: 'park and forestry operations', include_performance: true });
  assert.deepEqual(result.scope, { department: PR, unit: PFO });
  const fy = Object.fromEntries(result.spending.by_fiscal_year.map((y) => [y.fiscal_year, [y.actual_usd, y.budget_usd]]));
  assert.deepEqual(fy, { 2025: [11536917, 11728050], 2026: [12169859, 12661811], 2027: [4020159, 13139514] });
  const ocs = result.spending.by_object.rows.find((r) => r.name === 'Other Contractual Services');
  assert.deepEqual(ocs.FY2026, { actual_usd: 1341544, budget_usd: 1200643 });
  assert.equal(ocs.category, 'Contractual Services');
  assert.equal(result.spending.by_object.rows.find((r) => r.name === 'Allocations, Departmental').category, '(none recorded)', 'a missing category is a null, not a crash');
  // Every number carries its fiscal year.
  for (const r of result.spending.by_object.rows) for (const k of Object.keys(r).filter((x) => !['name', 'category'].includes(x))) assert.match(k, /^FY\d{4}$/);
  // Revenue: the department's own revenue unit spelling, matched exactly.
  assert.equal(result.revenue.by_source.rows[0].FY2027.collected_usd, 1937);
  assert.ok(result.revenue.by_fiscal_year.find((y) => y.fiscal_year === 2025).note.startsWith('I found no lines'), 'a year with no lines is not reported as $0');
  // Performance measures: matched across the two datasets' spellings.
  assert.equal(result.performance.department_matched, 'Parks and Recreation');
  assert.equal(result.performance.program_matched, PFO);
  assert.deepEqual(result.performance.measures[1].values, { 'FY2025': 'Yes', 'FY2026 projection': 'No' });
  // Caveats: quoted from the live description, or computed.
  const notes = result.about_the_data.join('\n');
  assert.match(notes, /description says: "Current budget reflects budget transfers and amendments/);
  assert.match(notes, /revenue budget adopted by City Council ahead of each fiscal year/);
  assert.match(notes, /holds FY2025, FY2026, FY2027 today/);
  assert.match(notes, /doesn't say whether FY\d{4}'s accounting period has been closed/);
  assert.match(notes, /1 of the lines in this answer have no expense category/);
  assert.match(notes, /99999 and 99998 are shown as Yes and No/);
  // Trace and hand-off: every dataset, with its full CSV (no policy applies).
  for (const id of ['mdwe-dquf', 'id3i-2az4', '7jsp-eyjg']) {
    const d = resources.datasets.find((x) => x.id === id);
    assert.ok(d && d.page && d.docs && d.csv && d.queries.length, `${id} in the hand-off`);
  }
  assert.ok(trace.some((s) => s.tool === 'expenditures by object'));
  assert.ok(!requests.some((u) => /4fsk-z8s8|vv96-9m5c/.test(u)), 'never the employee datasets');
  assert.ok(JSON.stringify(result).length < MAX_CHARS);
});

test('budget_for: only the dataset’s own spelling reaches SoQL', async () => {
  const { result, requests } = await run(budgetFor, { department: 'parks & recreation', fiscal_years: [2026], include_revenue: false });
  assert.equal(result.scope.department, PR);
  assert.equal(result.matched_from.department, 'parks & recreation');
  const qs = queries(requests);
  assert.ok(qs.some((q) => q.includes(`department_name = 'The Department of Parks & Recreation (P&R)'`) && q.includes('fiscal_year in (2026)')));
  assert.ok(!qs.some((q) => q.includes('parks & recreation')));
  assert.deepEqual(result.spending.by_fiscal_year.map((y) => y.fiscal_year), [2026]);
  assert.ok(result.about_the_data.some((n) => /negative actual or collected amounts in 1 group \(General Fund FY2026\)\. /.test(n)), 'a negative actual is flagged');
});

test('budget_for: unmatched or hostile names never reach SoQL', async () => {
  for (const department of ['Pubic Wroks', "Public Works' OR 1=1", "x' |> SELECT *", 'Police"; SELECT', "Public Works') UNION SELECT * FROM @4fsk-z8s8"]) {
    const { result, requests } = await run(budgetFor, { department });
    assert.match(result.error, /I found no department matching/, department);
    assert.ok(Array.isArray(result.closest_departments));
    const qs = queries(requests);
    assert.deepEqual(qs, [SOQL.expYears, SOQL.expNames(HELD)], `${department}: only the name and year lists ran`);
    assert.ok(!requests.some((u) => /4fsk-z8s8/.test(u)));
  }
  const { result } = await run(budgetFor, { department: 'Pubic Wroks' });
  assert.equal(result.closest_departments[0], 'Public Works');
  // Punctuation is ignored when matching, and only the official name is quoted.
  const dashed = await run(budgetFor, { department: 'Public Works -- ', include_revenue: false });
  assert.equal(dashed.result.scope.department, 'Public Works');
  assert.ok(queries(dashed.requests).every((q) => !q.includes('--')));
  const amb = (await run(budgetFor, { unit: 'Operations' })).result;
  assert.match(amb.error, /appears under 3 departments/);
  assert.deepEqual(amb.departments, ['Fire-Rescue', 'Parking Facilities Fund', 'Zoological Park']);
  const unit = (await run(budgetFor, { department: 'Public Works', unit: 'Recreation Centers' })).result;
  assert.match(unit.error, /no unit matching "Recreation Centers" in Public Works/);
  assert.match((await run(budgetFor, { department: 'x'.repeat(200) })).result.error, /longer than/);
  assert.match((await run(budgetFor, { department: 42 })).result.error, /must be text/);
});

test('budget_for: fiscal years are integers the dataset holds, checked before any data query', async () => {
  for (const fiscal_years of [[2019], ['2026'], [2026.5], [2026, 2030]]) {
    const { result, requests } = await run(budgetFor, { department: 'Public Works', fiscal_years });
    assert.ok(result.error, JSON.stringify(fiscal_years));
    assert.deepEqual(queries(requests), [SOQL.expYears], 'only the year list ran');
  }
  assert.deepEqual(checkYears(undefined, [2025, 2026]), [2025, 2026]);
  assert.deepEqual(checkYears([2026, 2025, 2026], [2025, 2026]), [2025, 2026]);
});

test('budget_for SoQL templates', () => {
  assert.equal(SOQL.expYears, 'SELECT fiscal_year AS fy, count(*) AS lines, sum(actual_expenses) AS actual, sum(current_expense_budget) AS budget GROUP BY fiscal_year ORDER BY fiscal_year LIMIT 50');
  assert.equal(
    SOQL.expBreakdown({ department: "O'Brien Dept", unit: 'A & B' }, [2025, 2026], 'object'),
    "SELECT object_name AS k, expenditure_category AS c, fiscal_year AS fy, count(*) AS lines, sum(actual_expenses) AS actual, sum(current_expense_budget) AS budget WHERE department_name = 'O''Brien Dept' AND unit_name = 'A & B' AND fiscal_year in (2025, 2026) GROUP BY object_name, expenditure_category, fiscal_year ORDER BY object_name, fiscal_year LIMIT 500"
  );
  assert.equal(SOQL.revBreakdown({}, [2027]), 'SELECT revenue_name AS k, fiscal_year AS fy, count(*) AS lines, sum(total_collected) AS actual, sum(total_budgeted) AS budget WHERE fiscal_year in (2027) GROUP BY revenue_name, fiscal_year ORDER BY revenue_name, fiscal_year LIMIT 500');
  assert.throws(() => SOQL.expBreakdown({}, [2026], 'owner'), /Unknown breakdown/);
  assert.equal(SOQL.perfMeasures('Public Works', null, ['fy_2025', 'fy_2027_target']), "SELECT program_name, measure_description, demand_level, fy_2025, fy_2027_target WHERE department = 'Public Works' ORDER BY program_name, measure_id LIMIT 100");
});

test('budget_for whole city stays well under the model cut, however many rows', async () => {
  const big = (url) => {
    const q = decodeURIComponent(url.split('$query=')[1] || '');
    if (url.includes('/resource/mdwe-dquf') && /GROUP BY (department_name|expenditure_category|fund_name), fiscal_year/.test(q))
      return Array.from({ length: 167 }, (_, i) => [2025, 2026, 2027].map((fy) => ({ k: `A long department or fund name number ${i} for size testing`, ...year(fy, 1000 * i + 0.4, 2000 * i, 3) }))).flat();
    if (url.includes('/resource/id3i-2az4') && q.includes('GROUP BY revenue_name, fiscal_year'))
      return Array.from({ length: 160 }, (_, i) => [2025, 2026, 2027].map((fy) => ({ k: `Revenue category ${i} with a long name`, ...year(fy, i, i * 2, 1) }))).flat();
    return respond(url);
  };
  const { result } = await run(budgetFor, {}, big);
  const size = JSON.stringify(result).length;
  assert.ok(size <= MAX_CHARS, `${size} characters`);
  assert.ok(result.rows_shown_per_breakdown < 15);
  assert.match(result.spending.by_department.rest.and_more, /^and \d+ more departments$/);
  assert.deepEqual(result.scope, { whole_city: true });
  assert.ok(result.about_the_data.some((n) => /500-group query limit/.test(n)));
});

test('budget_for flags units and departments that come and go between years, without asserting a transfer', async () => {
  const dept = (await run(budgetFor, { department: 'Parks and Recreation', include_revenue: false })).result;
  const notes = dept.about_the_data.join('\n');
  assert.match(notes, /The unit Cemeteries has lines in FY2026, FY2027 only; in FY2025 I found similar names elsewhere in the dataset \(department \/ unit\): Cemeteries \/ Cemetery\./);
  assert.match(notes, /doesn't say whether a unit or department was renamed, moved or closed/);
  assert.doesNotMatch(notes, /Recreation Centers has lines/, 'a unit with lines in every year is not listed');
  const unit = (await run(budgetFor, { unit: 'Cemeteries', include_revenue: false })).result;
  assert.equal(unit.spending.by_fiscal_year.length, 3);
  assert.match(unit.about_the_data.join('\n'), /The unit Cemeteries has lines in FY2026, FY2027 only; in FY2025 I found similar names .*Cemeteries \/ Cemetery/);
  // Pure function: a name in every year is quiet; one year asked is quiet.
  const ps = [{ d: 'A', u: 'X', n2025: '1', n2026: '1' }, { d: 'B', u: 'Y', n2025: '1', n2026: '0' }];
  assert.deepEqual(reorgNotes(ps, { department: 'A' }, [2025, 2026]), []);
  assert.deepEqual(reorgNotes(ps, { department: 'B' }, [2026]), []);
  assert.match(reorgNotes(ps, { department: 'B' }, [2025, 2026])[0], /^B has lines in FY2025 only\.$/, 'no similar name, so none is offered');
});

test('budget_for stays inside the Workers Free subrequest budget', async () => {
  // A department with revenue and performance measures: 3 describes, the year and name lists, 3 breakdowns, revenue by source, measures.
  const one = await run(budgetFor, { department: 'Public Works', include_performance: true });
  assert.ok(one.requests.length <= 12, `${one.requests.length} requests`);
  assert.ok(!queries(one.requests).some((q) => /GROUP BY fiscal_year ORDER/.test(q) && q.includes('WHERE')), 'per-year totals come from the category breakdown');
  const unit = await run(budgetFor, { unit: PFO, include_performance: true });
  assert.ok(unit.requests.length <= 11, `${unit.requests.length} requests`);
  const city = await run(budgetFor, {});
  assert.ok(city.requests.length <= 9, `${city.requests.length} requests`);
  // A comparison shares the describes and lists: about 4 more requests per department, not 12.
  const three = await run(budgetFor, { departments: ['Parks and Recreation', 'Public Works', 'Public Health'], include_performance: true });
  assert.ok(three.requests.length <= 7 + 4 * 3, `${three.requests.length} requests`);
  assert.equal(three.requests.filter((u) => u.includes('/api/views/')).length, 3, 'each dataset described once');
});

test('budget_for compares departments in one call', async () => {
  const { result, requests } = await run(budgetFor, { departments: ['parks & recreation', 'Public Works'], fiscal_years: [2026] });
  assert.deepEqual(result.compared, [PR, 'Public Works']);
  assert.equal(result.departments.length, 2);
  assert.deepEqual(result.departments[0].scope, { department: PR });
  assert.deepEqual(result.departments[0].matched_from, { department: 'parks & recreation' });
  assert.ok(result.departments[0].spending.by_unit && result.departments[0].spending.by_category && result.departments[0].revenue);
  assert.ok(result.sources.spending.name && result.sources.revenue.name);
  assert.ok(!queries(requests).some((q) => q.includes('parks & recreation')));
  assert.ok(result.about_the_data.some((n) => n.startsWith(`${PR}: The unit Cemeteries`)) === false, 'one year asked: no year-to-year caveat');
  // A miss in any name runs no data query and says which.
  const miss = await run(budgetFor, { departments: ['Public Works', 'Pubic Helth'] });
  assert.match(miss.result.error, /no department matching "Pubic Helth"/);
  assert.deepEqual(queries(miss.requests), [SOQL.expYears, SOQL.expNames(HELD)]);
  for (const [args, re] of [
    [{ departments: ['a', 'b', 'c', 'd', 'e'] }, /at most 4/],
    [{ departments: ['Public Works'], department: 'Public Works' }, /not both/],
    [{ departments: 'Public Works' }, /must be a list/],
    [{ departments: ['Public Works', 'Public Health'], performance_department: 'Public Works' }, /works with one department/],
  ]) {
    const r = await run(budgetFor, args);
    assert.match(r.result.error, re);
    assert.equal(r.requests.length, 0);
  }
  // Four departments with many rows still fit under the cut.
  const big = (url) => {
    const q = decodeURIComponent(url.split('$query=')[1] || '');
    if (url.includes('/resource/mdwe-dquf') && /GROUP BY (unit_name|expenditure_category), fiscal_year/.test(q))
      return Array.from({ length: 60 }, (_, i) => HELD.map((fy) => ({ k: `A long unit or category name number ${i} for size testing`, ...year(fy, 1000 * i, 2000 * i, 3) }))).flat();
    if (url.includes('/resource/id3i-2az4') && q.includes('GROUP BY revenue_source_name'))
      return Array.from({ length: 60 }, (_, i) => HELD.map((fy) => ({ k: `Revenue source ${i} with a long name`, ...year(fy, i, i * 2, 1) }))).flat();
    return respond(url);
  };
  const four = (await run(budgetFor, { departments: ['Parks and Recreation', 'Public Works', 'Public Health', 'Zoological Park'], include_performance: true }, big)).result;
  const size = JSON.stringify(four).length;
  assert.ok(size <= MAX_CHARS, `${size} characters`);
  assert.equal(four.departments.length, 4);
  assert.ok(four.departments.every((d) => d.spending.by_fiscal_year.length === 3), 'per-year totals survive any shrinking');
  // Long real names and every unit coming and going: the last resort still fits.
  const churn = (url) => {
    if (url.includes('/resource/mdwe-dquf') && decodeURIComponent(url).includes('GROUP BY department_name, unit_name'))
      return [...pairs, ...['Parks and Recreation', 'Public Works', 'Public Health', 'Zoological Park'].flatMap((d) => Array.from({ length: 8 }, (_, i) => pair(d === 'Parks and Recreation' ? PR : d, `A unit with a long name that moved, number ${i}`, [1, 0, 1])))];
    return big(url);
  };
  const worst = (await run(budgetFor, { departments: ['Parks and Recreation', 'Public Works', 'Public Health', 'Zoological Park'], include_performance: true }, churn)).result;
  assert.ok(JSON.stringify(worst).length <= MAX_CHARS, `${JSON.stringify(worst).length} characters`);
});

test('budget_for: a department miss also offers units, and the guidance names comparisons', async () => {
  const { result } = await run(budgetFor, { department: 'forestry' });
  assert.match(result.error, /no department matching "forestry"/);
  assert.deepEqual(result.closest_units[0], { unit: PFO, departments: [PR] });
  assert.match(result.hint, /as unit/);
  assert.match(siren.prompt, /compare departments/);
});

test('budget_for whole City: where the gap sits, matching budgets, and the fiscal-year naming rule', async () => {
  const { result } = await run(budgetFor, {});
  const notes = result.about_the_data.join('\n');
  assert.match(notes, /Citywide, FY2025 budgeted spending exceeds actual spending by \$502\.3M, net\. By department, Norfolk Public Schools \(1 line\) is \$271\.1M below its budget \(54% of the net gap\)\. The dataset doesn't explain the gap\./);
  assert.match(notes, /FY2026 budgeted spending exceeds actual spending by \$454\.3M, net\. I found no single department below its budget by a tenth of that\./);
  assert.doesNotMatch(notes, /FY2027 budgeted spending exceeds/, 'the current year is year to date, so no gap note');
  assert.match(notes, /budgeted revenue equals budgeted spending to the cent in FY2025, FY2026, so the revenue budget may also include amendments/);
  assert.match(notes, /column description for fiscal_year says, in part: "… For example, FY 2020 began on July 1, 2019 …"/);
  assert.match(notes, /column description for actual_expenses says: "Sum of fiscal year-to-date expenditures for this department\/fund\/unit\/object line"/);
});

test('budget_for: negatives folded into "and N more" are counted, and the update frequency is read live', async () => {
  const neg = (url) => {
    const q = decodeURIComponent(url.split('$query=')[1] || '');
    if (url.includes('/resource/mdwe-dquf') && q.includes('GROUP BY fund_name'))
      return [...Array.from({ length: 20 }, (_, i) => ({ k: `Fund ${String(i).padStart(2, '0')}`, ...year(2026, 100, 1000 - i, 1) })), { k: 'Fund ZZ', ...year(2026, -50, 1, 1) }];
    if (url.includes('/api/views/7jsp-eyjg')) {
      const v = structuredClone(respond(url));
      v.metadata = { ...(v.metadata || {}), custom_fields: { Updates: { 'Update Frequency': 'Annually' } } };
      return v;
    }
    return respond(url);
  };
  const { result } = await run(budgetFor, { department: 'Public Works', fiscal_years: [2026], include_performance: true }, neg);
  const notes = result.about_the_data.join('\n');
  assert.match(notes, /negative actual or collected amounts in 1 group \(Fund ZZ FY2026\); 1 of them are folded into an "and N more" row/);
  assert.match(notes, /its metadata gives the update frequency as "Annually"/);
});

test('budget helpers', () => {
  assert.equal(nameKey(PR), nameKey('Parks and Recreation'));
  assert.equal(matchName('PUBLIC WORKS', ['Public Works', 'Public Health']).name, 'Public Works');
  assert.ok(matchName('Public Work', ['Public Works']).miss, 'no prefix guessing');
  assert.deepEqual(matchName('Operations', ['Operations', 'operations']).closest.length, 2);
  assert.equal(closest('Polise', ['Police', 'Public Works', 'Sheriff'])[0], 'Police');
  assert.deepEqual(fiscalYearOf(new Date('2026-11-06T17:00:00Z')), { fiscal_year: 2027, elapsed_pct: 35.1, today: '2026-11-06' });
  assert.equal(fiscalYearOf(new Date('2026-07-01T03:00:00Z')).fiscal_year, 2026, '11 p.m. June 30 in Norfolk is still FY2026');
  assert.equal(fiscalYearOf(new Date('2026-07-01T05:00:00Z')).fiscal_year, 2027);
  assert.equal(perfValue('99999'), 'Yes');
  assert.equal(perfValue('99998'), 'No');
  assert.equal(perfValue('80.25'), 80.25);
  assert.equal(perfValue(undefined), null);
  assert.match(fromDescription({ description: 'Something else' }, 'The quote.'), /no longer does/);
  // Past core's 1,200-character cut, a missing line is not reported as removed.
  assert.match(fromDescription({ description: 'x'.repeat(1200) }, 'The quote.'), /couldn't find this line in the first 1200 characters/);
  assert.doesNotMatch(fromDescription({ description: 'x'.repeat(1200) }, 'The quote.'), /no longer/);
  const meta = { columns: [{ field: 'a', about: 'Sum of fiscal year-to-date expenditures for this department/fund/unit/object line' }, { field: 'b', about: `${'y'.repeat(155)} and more`.slice(0, 160) }, { field: 'c', about: 'z'.repeat(160) }] };
  assert.equal(fromColumn(meta, 'a', 'Sum of fiscal year-to-date expenditures'), 'The column description for a says: "Sum of fiscal year-to-date expenditures for this department/fund/unit/object line"', 'the whole column description, not a fragment');
  assert.match(fromColumn(meta, 'b', 'quoted past the cut'), /couldn't find this in the first 160 characters/);
  assert.match(fromColumn(meta, 'b', 'yyyy'), /says, in part: "yyyy …"/, 'a cut that ends in a space is still a cut');
  assert.match(fromColumn(meta, 'c', 'zzz'), /says, in part: "zzz …"/);
  assert.match(fromDescription({ description: 'The city’s  fiscal year.' }, "The city's fiscal year."), /^The dataset's description says/);
  const p = pivot([{ k: 'a', ...year(2026, 1, 5, 1) }, { k: 'b', ...year(2026, 2, 9, 1) }, { k: 'c', ...year(2026, 3, 1, 1) }], [2026], { top: 2, noun: 'units' });
  assert.deepEqual(p.rows.map((r) => r.name), ['b', 'a'], 'sorted by the latest year’s budget');
  assert.deepEqual(p.rest, { and_more: 'and 1 more units', FY2026: { actual_usd: 3, budget_usd: 1 } });
  assert.deepEqual(sumByYear([year(2026, 1, 2, 1), { k: 'x', ...year(2026, 3, 4, 2) }, year(2025, 5, 6, 1)]), [{ fy: 2025, lines: 1, actual: 5, budget: 6 }, { fy: 2026, lines: 3, actual: 4, budget: 6 }]);
  assert.deepEqual(negativeGroups([{ k: 'a', ...year(2026, -1, 0, 1) }, { k: 'b', ...year(2025, -1, 0, 1) }], [2026]), [{ name: 'a', fy: 2026 }]);
});

test('capital_projects by ward: validated ward, fixed SoQL, counts what the filter leaves out', async () => {
  const { result, requests, resources } = await run(capitalProjects, { ward: 2 });
  const qs = queries(requests);
  assert.equal(qs[0], CIP_SOQL.names);
  assert.ok(qs.slice(1).every((q) => q.includes('WHERE ward = 2')));
  assert.equal(result.plan.fiscal_year, 2027);
  assert.deepEqual(result.totals, { projects: 25, 'FY2027-FY2031_usd': 395186000, 'FY2027_usd': 181451000 });
  const p = result.largest_projects[0];
  assert.equal(p.location, '20th Street and Llewellyn Avenue');
  assert.deepEqual(p.coordinates, [36.8658, -76.2901]);
  assert.ok(p.description.endsWith('…') && p.description.length < 220);
  const notes = result.about_the_data.join('\n');
  assert.match(notes, /does not guarantee it will be funded in the future/);
  assert.match(notes, /7 of 15 projects have no ward/);
  assert.match(notes, /column description for amount_fy_27 says/);
  const d = resources.datasets.find((x) => x.id === '6tqj-4az3');
  assert.ok(d.csv && d.queries.length);
});

test('capital_projects rejects what it cannot match, before any data query', async () => {
  for (const [args, re] of [
    [{ ward: 7 }, /Ward 7 is not used in the FY2027 plan/],
    [{ ward: '2; DROP' }, /whole number/],
    [{ ward: 2.5 }, /whole number/],
    [{ plan_year: 2023 }, /no adopted Capital Improvement Plan for FY2023/],
    [{ department: "Public Works' OR '1'='1" }, /I found no department matching/],
  ]) {
    const { result, requests } = await run(capitalProjects, args);
    assert.match(result.error, re, JSON.stringify(args));
    assert.ok(queries(requests).every((q) => q === CIP_SOQL.names), JSON.stringify(args));
  }
  const { result } = await run(capitalProjects, { department: 'Parks & Rec' });
  assert.ok(result.closest_departments.includes('Parks and Recreation'));
});

// Jason, 2026-11-11, asking why Siren missed MacArthur: the largest-projects
// list showed only the City Manager line ($57M) of a project the City splits
// across three funds ($72M). A project lookup returns every line.
const CIP_NAMES = ['Redevelop MacArthur Mall Site', 'Renovate & Expand Jean MacArthur Research Center', 'Improve Police Operations Center', 'Conceptualize East Side Recreation Center', 'Improve Cemeteries Infrastructure', 'Improve Cultural Facilities', 'Construct Maury High School', 'Renovate Chrysler Hall'];
const MAC = (department, amount, first) => ({ project_id: department.slice(0, 3), department, project_name: 'Redevelop MacArthur Mall Site', description: 'This project is to redevelop the site of the MacArthur Mall. FY 2027 and FY 2028 funds are planned to support the demolition of the mall.', location: '300 Monticello Ave, Norfolk, VA 23510', ward: '2', amount, amount_fy_27: first });
function cipRespond(url) {
  const m = url.match(/\/resource\/(6tqj-4az3)\.json\?\$query=(.*)$/);
  const q = m && decodeURIComponent(m[2]);
  if (q?.includes('GROUP BY project_name')) return CIP_NAMES.map((p) => ({ p, n: '1' }));
  if (q?.includes('project_name IN (')) return q.includes("'Redevelop MacArthur Mall Site'") ? [MAC('City Manager', '57000000', '6700000'), MAC('Utilities - Water Fund', '10000000', '0'), MAC('Utilities - Wastewater Fund', '5000000', '0')] : [];
  return respond(url);
}

test('matchProjects: every word first, rarer words outrank common ones, generic words never match alone', () => {
  const top = (q) => matchProjects(q, CIP_NAMES).matches.map((x) => x.name);
  assert.deepEqual(top('MacArthur Mall'), ['Redevelop MacArthur Mall Site', 'Renovate & Expand Jean MacArthur Research Center']);
  // "MacArthur Center": the research center has both words; the mall site, with the rarer word, beats every other "... Center".
  assert.deepEqual(top('MacArthur Center').slice(0, 2), ['Renovate & Expand Jean MacArthur Research Center', 'Redevelop MacArthur Mall Site']);
  // "Improve" is in a quarter or more of the names: it matches only where it is all that was asked.
  assert.ok(!top('Improve Chrysler').includes('Improve Cemeteries Infrastructure'));
  assert.deepEqual(top('chrysler hall'), ['Renovate Chrysler Hall']);
  assert.deepEqual(top('the project plan'), []);
  assert.deepEqual(top("zzz' OR '1'='1"), []);
});

test('capital_projects by project: every line across funds, the project total, and only the City\'s spelling in the SoQL', async () => {
  const { result, requests } = await run(capitalProjects, { project: 'macarthur mall' }, cipRespond);
  const qs = queries(requests);
  assert.equal(qs[0], CIP_SOQL.names);
  assert.ok(qs.includes(CIP_SOQL.projectNames({ project: ['project_name'] })));
  const lines = qs.find((q) => q.includes('project_name IN ('));
  assert.match(lines, /project_name IN \('Redevelop MacArthur Mall Site', 'Renovate & Expand Jean MacArthur Research Center'\)/);
  assert.ok(!lines.toLowerCase().includes('macarthur mall\''), 'the words asked never reach the SoQL themselves');
  const mac = result.matches[0];
  assert.equal(mac.name, 'Redevelop MacArthur Mall Site');
  assert.equal(mac.matched_words, 'all');
  assert.deepEqual(mac.total, { 'FY2027-FY2031_usd': 72000000, FY2027_usd: 6700000, lines: 3 });
  assert.deepEqual(mac.lines.map((l) => l.department), ['City Manager', 'Utilities - Water Fund', 'Utilities - Wastewater Fund']);
  assert.match(mac.lines[0].description, /demolition of the mall\.$/);
  assert.match(result.matches[1].matched_words, /^1 of 2: macarthur$/);
  assert.match(result.about_the_data.join('\n'), /adds up its lines/);
  assert.equal(result.largest_projects, undefined);
});

test('capital_projects by project: a miss says so, and bad input is refused before any data query', async () => {
  const miss = await run(capitalProjects, { project: 'qqq zzz' }, cipRespond);
  assert.deepEqual(miss.result.matches, []);
  assert.match(miss.result.note, /I found no project in the FY2027 plan whose name holds "qqq" or "zzz"/);
  assert.ok(!queries(miss.requests).some((q) => q.includes(' IN (')));
  for (const project of [42, 'x'.repeat(121)]) {
    const { result, requests } = await run(capitalProjects, { project }, cipRespond);
    assert.match(result.error, /project must be words/);
    assert.equal(queries(requests).length, 0);
  }
});

test('capital_projects FY2024: its own columns, an amount labelled by its column, and subproject lines', async () => {
  const { result, requests } = await run(capitalProjects, { plan_year: 2024, department: 'parks and recreation' });
  assert.equal(result.filter.department, 'Parks and Recreation');
  const qs = queries(requests);
  assert.ok(qs.some((q) => q.includes('master_project_name, subproject_name') && q.includes("department = 'Parks and Recreation'")));
  assert.ok(!qs.some((q) => /amount_fy/.test(q)));
  assert.ok(qs.some((q) => q.includes('count(distinct project_id) AS p')));
  assert.equal(result.largest_projects[0].name, 'Maury: Phase 1');
  // The dataset doesn't say whether `amount` is one year's or five years', so it is never labelled as a span.
  assert.deepEqual(result.totals, { project_lines: 25, projects: 20, amount_usd: 395186000 });
  assert.equal(result.largest_projects[0].amount_usd, 158500000);
  assert.ok(!JSON.stringify(result).includes('FY2024-FY2028_usd'));
  assert.ok(!result.about_the_data.some((n) => /five-year amount/.test(n)));
  const notes = result.about_the_data.join('\n');
  assert.match(notes, /The column description for amount says: "The adopted funding amount included in the FY2024 to FY2028 Capital Improvement Plan"/);
  assert.match(notes, /doesn't say whether amount is FY2024's appropriation or the five-year total/);
  assert.match(notes, /project_lines counts lines and projects counts distinct project ids/);
  assert.deepEqual(result.by_ward.rows[0], { ward: 2, project_lines: 1, projects: 1, amount_usd: 158500000 });
  assert.equal(shorten('short'), 'short');
  // The other plans keep their five-year and first-year labels and count projects.
  const latest = (await run(capitalProjects, {})).result;
  assert.deepEqual(latest.totals, { projects: 25, 'FY2027-FY2031_usd': 395186000, FY2027_usd: 181451000 });
  assert.ok(!queries((await run(capitalProjects, {})).requests).some((q) => q.includes('distinct')));
});

test('capital_projects stays under the model cut with many departments and long text', async () => {
  const long = (i) => `Location ${i} `.padEnd(400, 'x');
  const big = (url) => {
    const q = decodeURIComponent(url.split('$query=')[1] || '');
    if (url.includes('/resource/6tqj-4az3')) {
      if (q.includes('GROUP BY department, ward')) return Array.from({ length: 100 }, (_, i) => ({ d: `Department number ${i} with a long name`, w: String((i % 5) + 1), n: '1' }));
      if (q.includes('GROUP BY department')) return Array.from({ length: 100 }, (_, i) => ({ k: `Department number ${i} with a long name`, n: '1', total: String(1e6 * (100 - i)), first: '1' }));
      if (q.includes('ORDER BY amount DESC'))
        return Array.from({ length: 15 }, (_, i) => ({ project_id: String(i), department: 'Public Works', project_name: `Project ${i} `.padEnd(120, 'n'), description: long(i), location: long(i), ward: '1', latitude: '36.8', longitude: '-76.2', amount: String(1e6 * (15 - i)), amount_fy_27: '1' }));
    }
    return respond(url);
  };
  const { result } = await run(capitalProjects, {}, big);
  const size = JSON.stringify(result).length;
  assert.ok(size <= MAX_CHARS, `${size} characters`);
  assert.ok(result.rows_shown_per_breakdown < 15);
});

test('Siren offers both budget tools', () => {
  const city = applyConfig(norfolk, siren);
  const names = toolsFor(city, siren.plugins).map((t) => t.function.name);
  assert.ok(names.includes('budget_for') && names.includes('capital_projects'));
  assert.match(siren.prompt, /use budget_for/);
  assert.ok(norfolk.budget.capitalPlans.every((p) => /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(p.id) && (p.total || p.amount) && p.project.length));
});
