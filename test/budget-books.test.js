// Budget books: the Department Budgets part of Norfolk's adopted budget,
// split by department and subheading from the City's PDF, and served by
// budget_book_lookup with fiscal year, department, section and page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { budgetPage, budgetPageLabels, splitSections, pageAt, findDepartment } from '../src/documents.js';
import { buildDocument } from '../scripts/ingest-document.js';
import { checkPlugin, checkPluginFile } from './conformance.js';
import { getCity } from '../src/cities/index.js';
import budget, { BUDGET_BOOKS } from '../plugins/budget-books.js';
import siren from '../deployments/siren.config.js';

// Real pdftotext -layout pages, some lines cut; the first line of each file describes it.
const fixture = (name) => {
  const pages = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\f').slice(1);
  if (!pages.at(-1).trim()) pages.pop();
  return pages;
};
const fy27 = fixture('budget-fy2027-pages.txt');
const fy24 = fixture('budget-fy2024-pages.txt');

test('a budget page: footer gives the department and printed page; dividers and blanks are told apart', () => {
  assert.deepEqual(budgetPage(fy27[0]), { kind: 'divider', label: '125', department: 'Legislative', area: 'Legislative' });
  assert.equal(budgetPage(fy27[1]).kind, 'blank');
  assert.deepEqual(budgetPage(fy24[0]), { kind: 'divider', label: null, department: null, area: 'Legislative' });
  assert.equal(budgetPage(fy24[1]).kind, 'blank');
  const body = budgetPage(fy27[3]);
  assert.equal(body.kind, 'body');
  assert.equal(body.department, 'City Auditor');
  assert.equal(body.label, '128');
  assert.doesNotMatch(body.lines.join('\n'), /^City Auditor$|128 - City Auditor/m, 'running header and footer are off');
  assert.equal(budgetPage(fy24[2]).label, '554');
  assert.equal(budgetPage(fy24[3]).department, 'Fire-Rescue');
  assert.deepEqual(budgetPageLabels(fy27), ['125', '126', '127', '128', '129', '381', '382']);
});

test('FY 2027 layout: a section per department and subheading, with service area, pages and the table year row', () => {
  const s = splitSections(fy27, { preset: 'budget' });
  assert.deepEqual(
    s.map((x) => `${x.number} ${x.title}`),
    [
      '1 City Auditor',
      '1.1 Department Overview',
      '1.2 Trends, Issues, and Initiatives',
      '1.3 Department Budget Summary',
      '1.4 Adopted FY 2027 Budget Actions',
      '1.5 Permanent Full Time Equivalent (FTE) Summary',
      '2 Central and Outside Agency Appropriations',
      '2.1 CENTRAL APPROPRIATIONS',
    ]
  );
  const auditor = s[0];
  assert.equal(auditor.area, 'Legislative');
  assert.deepEqual(auditor.pages, [3, 5]);
  const summary = s.find((x) => x.number === '1.3');
  assert.equal(summary.department, 'City Auditor');
  assert.deepEqual(summary.pages, [4, 4]);
  assert.match(summary.text, /^FY 2024 {2}FY 2025 {2}FY 2026 {2}FY 2027\nDepartment Budget Summary {2}Actual/, 'the year row above the heading comes along');
  assert.match(s.find((x) => x.number === '1.2').text, /citywide expenditures/);
  assert.doesNotMatch(s.find((x) => x.number === '1.2').text, /FY 2024/, 'the next table\'s year row left the section before it');
  const actions = s.find((x) => x.number === '1.4');
  assert.match(actions.text, /^Base Budget Adjustments\nFY 2027  FTE\n• Update base program costs  5,448  0\.0[\s\S]*Total  9,398  0\.0$/);
  const central = s.find((x) => x.number === '2.1');
  assert.deepEqual(central.pages, [6, 7]);
  assert.equal((central.text.match(/CENTRAL APPROPRIATIONS/g) || []).length, 0, 'the title repeated atop the next page is dropped');
  assert.equal(pageAt(central, central.text.indexOf('Line of Duty Act')), 7);
  assert.doesNotMatch(s.map((x) => x.text).join('\n'), /City Auditor - 12\d|\d+ - Central and Outside/, 'no footers in the text');
});

test('FY 2024 layout: departments split into programs, the repeated program line dropped', () => {
  const s = splitSections(fy24, { preset: 'budget' });
  assert.deepEqual(
    s.map((x) => `${x.number} ${x.title}`),
    [
      '1 Fire-Rescue',
      '1.1 Program: Office of Fire-Rescue Chief',
      '1.1.1 Adjustments to Baseline Service Level Cost',
      '1.1.2 Adopted Service Level Changes',
      '1.1.3 Requested but Not Funded Service Level Changes',
      '1.1.4 Expenditure Summary',
      '1.2 Program: Community Risk Reduction',
      '1.2.1 Performance Measures',
    ]
  );
  const unfunded = s.find((x) => x.number === '1.1.3');
  assert.equal(unfunded.program, 'Office of Fire-Rescue Chief');
  assert.deepEqual(unfunded.pages, [4, 4]);
  assert.match(unfunded.text, /^FY 2024 {2}FTE\nProvide funds for PulsePoint {2}8,000 {2}0\.0/);
  assert.deepEqual(s.find((x) => x.number === '1.1').pages, [3, 4]);
  assert.match(s.find((x) => x.number === '1.2').text, /^The Community Risk Reduction program consists of inspections/);
  assert.doesNotMatch(s.map((x) => x.text).join('\n'), /^Program:|^FIRE-RESCUE$/m);
});

test('the ingest records a budget book: fiscal year, status, which part, how it was identified, printed pages', () => {
  const tags = {
    kind: 'budget-book',
    id: 'demo-budget-fy2027',
    title: 'Department Budgets',
    'fiscal-year': '2027',
    status: 'adopted',
    book: 'Adopted FY 2027 Budget Document',
    part: '09 Department Budgets',
    'identified-by': 'listed on the demo page',
    'listed-on': 'https://example.gov/budget',
    url: 'https://example.gov/b.pdf',
  };
  const text = fy27.join('\f') + '\f';
  const doc = buildDocument({ bytes: Buffer.from('hello'), text, tags, extractor: 'pdftotext -layout', retrieved: '2026-11-06T00:00:00Z', retrievedBy: 'test' });
  assert.equal(doc.kind, 'budget-book');
  assert.equal(doc.fiscal_year, 2027);
  assert.equal(doc.status, 'adopted');
  assert.equal(doc.extracted.sections, 'budget');
  assert.equal(doc.enacted, undefined);
  assert.deepEqual(doc.page_labels, ['125', '126', '127', '128', '129', '381', '382']);
  assert.match(doc.note, /not a record of spending/);
  assert.throws(() => buildDocument({ bytes: Buffer.from('x'), text, tags: { ...tags, 'fiscal-year': undefined } }), /--fiscal-year is required/);
  assert.throws(() => buildDocument({ bytes: Buffer.from('x'), text, tags: { ...tags, 'fiscal-year': 'next' } }), /--fiscal-year must be a year/);
  assert.throws(() => buildDocument({ bytes: Buffer.from('x'), text, tags: { ...tags, status: 'draft' } }), /--status must be adopted or proposed/);
  assert.throws(() => buildDocument({ bytes: Buffer.from('x'), text, tags: { ...tags, kind: 'memo' } }), /Unknown --kind/);
});

test('each committed budget book says what it is and where its bytes came from', () => {
  assert.deepEqual(Object.keys(BUDGET_BOOKS).map(Number).sort(), [2024, 2025, 2026, 2027]);
  for (const [year, doc] of Object.entries(BUDGET_BOOKS)) {
    assert.equal(doc.kind, 'budget-book');
    assert.equal(doc.fiscal_year, Number(year));
    assert.equal(doc.status, 'adopted');
    assert.match(doc.source.url, /^https:\/\/www\.norfolk\.gov\/DocumentCenter\/View\/\d+\/\d\d-Department-Budgets$/);
    assert.match(doc.listed_on, /^https:\/\/www\.norfolk\.gov\/\d+\/\d{4}-Budget-Document$/);
    assert.match(doc.source.cid, /^bafkrei[a-z2-7]{52}$/);
    assert.match(doc.identified_by, new RegExp(`FY ${year}`));
    assert.equal(doc.page_labels.length, doc.source.pages);
    assert.ok(doc.sections.length > 200);
    for (const s of doc.sections) {
      assert.ok(s.department, `${year} ${s.number} names its department`);
      assert.ok(s.pages[0] >= 1 && s.pages[0] <= s.pages[1] && s.pages[1] <= doc.source.pages, `${year} ${s.number} pages`);
    }
  }
});

test('departments are found by name, forgiving word forms, or offered as choices', () => {
  const doc = BUDGET_BOOKS[2027];
  assert.equal(findDepartment(doc, 'fire').match.department, 'Fire-Rescue');
  assert.equal(findDepartment(doc, 'Library').match.department, 'Libraries');
  assert.equal(findDepartment(doc, 'communications and marketing').match.department, 'Communications & Marketing');
  assert.deepEqual(findDepartment(doc, 'Parks').candidates, ['Parks and Recreation', 'Zoological Park']);
});

const city = getCity('norfolk');
const respond = () => {
  throw new Error('no network');
};

test('budget_book_lookup searches every year, cites each book, and links the page', async () => {
  const out = await checkPlugin(budget, { city, args: { query: 'fire code inspections' }, respond });
  assert.equal(out.requests.length, 0);
  assert.deepEqual(out.trace.map((s) => s.tool), ['search FY 2027 Department Budgets', 'search FY 2026 Department Budgets', 'search FY 2025 Department Budgets', 'search FY 2024 Department Budgets']);
  const r = out.result;
  assert.deepEqual(r.searched.map((d) => d.fiscal_year), [2027, 2026, 2025, 2024]);
  assert.ok(r.results.length > 0 && r.results.length <= 8);
  for (const x of r.results) {
    assert.ok(BUDGET_BOOKS[x.fiscal_year]);
    assert.ok(x.department && x.section && x.title && x.excerpt);
    assert.equal(x.link, `${BUDGET_BOOKS[x.fiscal_year].source.url}#page=${x.page}`);
    assert.equal(x.printed_page, BUDGET_BOOKS[x.fiscal_year].page_labels[x.page - 1]);
  }
  assert.ok(r.results.some((x) => x.department === 'Fire-Rescue'));
  assert.match(r.how_to_use, /not records of spending/);
  assert.match(r.how_to_use, /garbled/);
  assert.match(r.how_to_use, /link the page/);
  assert.ok(out.resources.records.every((x) => x.url.startsWith('https://www.norfolk.gov/DocumentCenter/View/')));
  assert.ok(JSON.stringify(r).length < 16000);
});

test('budget_book_lookup narrows a search to one year and one department', async () => {
  const out = await checkPlugin(budget, { city, args: { query: 'overtime', fiscal_year: 2027, department: 'Fire-Rescue' }, respond });
  assert.equal(out.trace.length, 1);
  assert.ok(out.result.results.length > 0);
  assert.ok(out.result.results.every((x) => x.fiscal_year === 2027 && x.department === 'Fire-Rescue'));
  assert.match(out.result.results[0].excerpt, /overtime/i);
});

test('budget_book_lookup reads a department or a section, windowed, with the citation ahead of the text', async () => {
  const dept = await checkPlugin(budget, { city, args: { fiscal_year: 2024, department: 'Police' }, respond });
  const d = dept.result;
  assert.equal(d.department, 'Police');
  assert.equal(d.service_area, 'Public Safety');
  assert.ok(d.subsections.some((x) => / Program: /.test(x)));
  assert.equal(d.continues, true);
  assert.ok(JSON.stringify(d).length < 16000, 'fits a tool result');
  const keys = Object.keys(d);
  assert.ok(keys.indexOf('link') < keys.indexOf('text') && keys.indexOf('next_offset') < keys.indexOf('text'));
  assert.deepEqual(dept.trace.map((s) => s.tool), [`read FY 2024 Department Budgets section ${d.section}`]);
  assert.ok(dept.resources.records.some((r) => r.url.endsWith(`#page=${d.pages[0]}`) && /Police/.test(r.title)));
  const next = await checkPlugin(budget, { city, args: { fiscal_year: 2024, department: 'Police', offset: d.next_offset }, respond });
  assert.notEqual(next.result.text, d.text);

  const fire = BUDGET_BOOKS[2027].sections.find((s) => s.department === 'Fire-Rescue' && /Budget Actions/.test(s.title));
  const sec = await checkPlugin(budget, { city, args: { fiscal_year: 2027, section: fire.number }, respond });
  assert.equal(sec.result.title, 'Adopted FY 2027 Budget Actions');
  assert.equal(sec.result.department, 'Fire-Rescue');
  assert.equal(sec.result.link, `${BUDGET_BOOKS[2027].source.url}#page=${fire.pages[0]}`);
  assert.equal(sec.result.printed_pages[0], BUDGET_BOOKS[2027].page_labels[fire.pages[0] - 1]);
});

test('budget_book_lookup says what it needs, and offers departments when a name is ambiguous', async () => {
  const run = async (args) => (await checkPlugin(budget, { city, args, respond })).result;
  assert.match((await run({ department: 'Police' })).error, /Give fiscal_year/);
  assert.match((await run({ fiscal_year: 2019, query: 'x' })).error, /No budget book for fiscal year 2019/);
  assert.match((await run({})).error, /Give query/);
  assert.match((await run({ fiscal_year: 2027, section: '999.1' })).error, /No section 999\.1/);
  const parks = await checkPlugin(budget, { city, args: { fiscal_year: 2027, department: 'Parks' }, respond });
  assert.deepEqual(parks.result.departments, ['Parks and Recreation', 'Zoological Park']);
  assert.equal(parks.trace.length, 1, 'the lookup is still in the trace');
});

test('the budget plugin and its shared reader pass the source checks, and Siren carries the tool', () => {
  checkPluginFile(new URL('../plugins/budget-books.js', import.meta.url));
  checkPluginFile(new URL('../plugins/document-lookup.js', import.meta.url));
  assert.ok(siren.plugins.some((p) => p.name === 'budget_book_lookup'));
  assert.match(siren.prompt, /budget_book_lookup/);
});
