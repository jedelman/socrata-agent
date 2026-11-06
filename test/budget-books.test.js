// Budget books: the Department Budgets part of Norfolk's adopted budget,
// split by department and subheading from the City's PDF, and served by
// budget_book_lookup with fiscal year, department, section and page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { budgetPage, budgetPageLabels, splitSections, pageAt, findDepartment, alignCells, buildSearchIndex } from '../src/documents.js';
import { buildDocument, reindexDocument } from '../scripts/ingest-document.js';
import { checkPlugin, checkPluginFile } from './conformance.js';
import { getCity } from '../src/cities/index.js';
import budget, { BUDGET_BOOKS } from '../plugins/budget-books.js';
import ordinances, { DOCUMENTS } from '../plugins/ordinances.js';
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
  assert.match(doc.note, /Adopted are the City's plan, not spending/);
  assert.match(doc.note, /Actual are prior-year figures as the City printed them/);
  assert.deepEqual(doc.search_index, buildSearchIndex(doc.sections), 'the search index is built at ingest');
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
  assert.match(r.how_to_use, /Adopted are the City's plan: call them the adopted plan, never spending/);
  assert.match(r.how_to_use, /Actual are prior-year figures as the City printed them in that book/);
  assert.match(r.how_to_use, /garbled/);
  assert.match(r.how_to_use, /link the page/);
  assert.ok(out.resources.records.every((x) => x.url.startsWith('https://www.norfolk.gov/DocumentCenter/View/')));
  assert.deepEqual([...new Set(r.results.map((x) => x.fiscal_year))], [2027, 2026, 2025, 2024], 'every year is represented, newest first');
  assert.ok(JSON.stringify(r).length < 16000);
});

test('budget_book_lookup narrows a search to one year and one department, and the trace counts what it found', async () => {
  const out = await checkPlugin(budget, { city, args: { query: 'overtime', fiscal_year: 2027, department: 'Fire-Rescue' }, respond });
  assert.equal(out.trace.length, 1);
  assert.ok(out.result.results.length > 0);
  assert.ok(out.result.results.every((x) => x.fiscal_year === 2027 && x.department === 'Fire-Rescue'));
  assert.match(out.result.results[0].excerpt, /overtime/i);
  assert.equal(out.trace[0].rows, out.result.results.length, 'rows are the department\'s results, not the whole book\'s');
  assert.match(out.trace[0].soql, /"overtime" in Fire-Rescue/);

  const police = await checkPlugin(budget, { city, args: { query: 'overtime', department: 'Police' }, respond });
  for (const step of police.trace) {
    const y = Number(/FY (\d{4})/.exec(step.tool)[1]);
    assert.equal(step.rows, police.result.results.filter((x) => x.fiscal_year === y).length, `FY ${y} rows`);
  }
});

test('a search for a department missing from a year cites the lookup and offers that year\'s departments', async () => {
  const none = await checkPlugin(budget, { city, args: { query: 'trees', department: 'Nonexistent Dept' }, respond });
  assert.deepEqual(none.trace.map((s) => s.tool), [2027, 2026, 2025, 2024].map((y) => `list departments in FY ${y} Department Budgets`));
  assert.deepEqual(none.result.department_not_found_in, [2027, 2026, 2025, 2024]);
  assert.ok(none.result.departments_by_year[2024].includes('Police'));
  assert.equal(none.trace[0].rows, none.result.departments_by_year[2027].length);
  assert.equal(none.resources.records.length, 4, 'every book searched is in the hand-off');
  assert.ok(JSON.stringify(none.result).length < 16000);

  // New in FY 2026: the years without it offer their departments, the others search.
  const renamed = await checkPlugin(budget, { city, args: { query: 'veterans', department: 'Military and Community Affairs' }, respond });
  assert.deepEqual(renamed.result.department_not_found_in, [2025, 2024]);
  assert.deepEqual(Object.keys(renamed.result.departments_by_year), ['2024', '2025']);
  assert.ok(renamed.result.departments_by_year[2024].length > 1);
  assert.deepEqual(renamed.trace.map((s) => s.tool.split(' Department')[0]), ['search FY 2027', 'search FY 2026', 'list departments in FY 2025', 'list departments in FY 2024']);
});

test('a search that finds nothing still hands off every book it searched', async () => {
  const out = await checkPlugin(budget, { city, args: { query: 'zzqx nonexistentterm' }, respond });
  assert.deepEqual(out.result.results, []);
  assert.deepEqual(out.trace.map((s) => s.rows), [0, 0, 0, 0]);
  assert.deepEqual(out.resources.records.map((r) => r.url).sort(), Object.values(BUDGET_BOOKS).map((d) => d.source.url).sort());
});

test('search leaves out sections with no text of their own, and a passage repeated across programs counts once', async () => {
  for (const query of ['magistrate', 'zoological park', 'library hours']) {
    const { result } = await checkPlugin(budget, { city, args: { query }, respond });
    assert.ok(result.results.length > 0, query);
    assert.ok(result.results.every((x) => x.excerpt), `${query}: no empty excerpts`);
    const keys = result.results.map((x) => `${x.fiscal_year}|${x.department}|${x.title}|${x.excerpt}`);
    assert.equal(new Set(keys).size, keys.length, `${query}: no duplicates`);
  }
  const { result } = await checkPlugin(budget, { city, args: { query: 'library hours' }, respond });
  assert.ok(result.results.some((x) => x.fiscal_year === 2027), 'the newest book is not crowded out');
});

test('budget_book_lookup reads a department or a section, windowed, with the citation ahead of the text', async () => {
  const dept = await checkPlugin(budget, { city, args: { fiscal_year: 2024, department: 'Police' }, respond });
  const d = dept.result;
  assert.equal(d.department, 'Police');
  assert.equal(d.service_area, 'Public Safety');
  assert.ok(d.subsections.some((x) => /^Program: /.test(x.title)));
  assert.equal(d.continues, true);
  assert.ok(JSON.stringify(d).length < 16000, 'fits a tool result');
  const keys = Object.keys(d);
  assert.ok(keys.indexOf('link') < keys.indexOf('text') && keys.indexOf('next_offset') < keys.indexOf('text'));
  assert.equal(keys.at(-1), 'text');
  assert.deepEqual(dept.trace.map((s) => s.tool), [`read FY 2024 Department Budgets section ${d.section}`]);
  assert.deepEqual(dept.resources.records.map((r) => r.title), [`FY 2024 Department Budgets: Police (PDF page ${d.pages[0]})`], 'the department is named once');
  const next = await checkPlugin(budget, { city, args: { fiscal_year: 2024, department: 'Police', offset: d.next_offset }, respond });
  assert.notEqual(next.result.text, d.text);

  const fire = BUDGET_BOOKS[2027].sections.find((s) => s.department === 'Fire-Rescue' && /Budget Actions/.test(s.title));
  const sec = await checkPlugin(budget, { city, args: { fiscal_year: 2027, section: fire.number }, respond });
  assert.equal(sec.result.title, 'Adopted FY 2027 Budget Actions');
  assert.equal(sec.result.department, 'Fire-Rescue');
  assert.equal(sec.result.link, `${BUDGET_BOOKS[2027].source.url}#page=${fire.pages[0]}`);
  assert.equal(sec.result.printed_pages[0], BUDGET_BOOKS[2027].page_labels[fire.pages[0] - 1]);

  const program = BUDGET_BOOKS[2024].sections.find((s) => s.department === 'Police' && /^Program: /.test(s.title));
  const prog = await checkPlugin(budget, { city, args: { fiscal_year: 2024, section: program.number }, respond });
  assert.deepEqual(prog.resources.records.map((r) => r.title), [`FY 2024 Department Budgets: Police › ${program.program} (PDF page ${program.pages[0]})`], 'the program is named once');
});

test('a read gives each subsection its page and link, and marks each page in the text', async () => {
  const doc = BUDGET_BOOKS[2027];
  const { result } = await checkPlugin(budget, { city, args: { fiscal_year: 2027, department: 'Police' }, respond });
  const fte = result.subsections.find((x) => x.title === 'Permanent Full Time Equivalent (FTE) Summary');
  assert.equal(fte.link, `${doc.source.url}#page=${fte.page}`);
  assert.equal(fte.printed_page, doc.page_labels[fte.page - 1]);
  assert.ok(result.subsections.every((x) => x.number.split('.').length === 2), 'one level down');
  assert.match(result.text, new RegExp(`^\\[PDF page ${result.pages[0]}, printed ${result.printed_pages[0]}\\]$`, 'm'));

  // The FTE table runs over two pages; its Total is on the second, and the text says so.
  const read = await checkPlugin(budget, { city, args: { fiscal_year: 2027, section: fte.number }, respond });
  const text = read.result.text;
  const total = text.indexOf('Total  840.0  11.0  851.0');
  assert.ok(total > 0, 'one section holds the whole table, Total included');
  const marks = [...text.slice(0, total).matchAll(/^\[PDF page (\d+), printed (\d+)\]$/gm)];
  assert.deepEqual(marks.at(-1).slice(1), ['236', '360']);
  assert.equal(read.result.pages[1], 236);
});

test('every window of every section of every book fits a tool result', async () => {
  const ctx = { cite: async () => {}, resources: { addRecord() {} } };
  let reads = 0;
  for (const [year, doc] of Object.entries(BUDGET_BOOKS)) {
    for (const s of doc.sections) {
      let offset = 0;
      for (;;) {
        const r = await budget.run(ctx, { fiscal_year: Number(year), section: s.number, offset });
        reads++;
        const n = JSON.stringify(r).length;
        assert.ok(n < 16000, `FY ${year} ${s.number} at ${offset}: ${n} characters`);
        if (!r.continues) break;
        assert.ok(r.next_offset > offset);
        offset = r.next_offset;
      }
    }
  }
  assert.ok(reads > 2000);
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

test('names from the object prototype are not fiscal years or documents', async () => {
  for (const fiscal_year of ['__proto__', 'constructor', 'toString']) {
    for (const args of [{ fiscal_year, query: 'fire' }, { fiscal_year, department: 'Police' }]) {
      const out = await checkPlugin(budget, { city, args, respond });
      assert.match(out.result.error, /No budget book for fiscal year/, `${fiscal_year} ${Object.keys(args)}`);
    }
  }
  assert.equal((await checkPlugin(budget, { city, args: { fiscal_year: '2027', department: 'Police' }, respond })).result.department, 'Police', 'a year given as text still reads');
  for (const document of ['__proto__', 'constructor', 'toString']) {
    const out = await checkPlugin(ordinances, { city, args: { document, query: 'fence' }, respond });
    assert.match(out.result.error, /No document/);
  }
  // A query word that is a prototype name finds nothing rather than throwing.
  assert.ok(Array.isArray((await checkPlugin(budget, { city, args: { query: 'constructor', fiscal_year: 2027 }, respond })).result.results));
});

test('the budget plugin and its shared reader pass the source checks, and Siren carries the tool', () => {
  checkPluginFile(new URL('../plugins/budget-books.js', import.meta.url));
  checkPluginFile(new URL('../plugins/document-lookup.js', import.meta.url));
  assert.ok(siren.plugins.some((p) => p.name === 'budget_book_lookup'));
  assert.match(siren.prompt, /budget_book_lookup/);
});

test('a blank table cell is shown, so a figure is never read into the wrong year', () => {
  // FY 2025 budget book, PDF page 240 (Debt Service): the Pension row has no FY 2022 figure.
  const rows = [
    '                                                                FY 2022             FY 2023       FY 2024           FY 2025',
    '                                                                 Actual              Actual      Adopted           Adopted',
    'Debt Principal & Interest1                                  71,573,164          78,994,415     87,504,492       90,610,504',
    'Equipment Acquisition Principal & Interest                    2,441,657          1,967,855      3,012,401         3,012,401',
    'Pension Principal & Interest2                                                    7,829,389      9,505,461       13,076,147',
    'Bond Issuance Cost                                              509,398            515,652       500,000          1,000,000',
    'TOTAL                                                       75,414,796          89,994,594    101,365,244      113,380,052',
    '1',
  ].map((line) => ({ line, page: 240 }));
  const out = alignCells(rows).map((x) => x.line.trim().replace(/ {2,}/g, '  '));
  assert.equal(out[4], 'Pension Principal & Interest2  —  7,829,389  9,505,461  13,076,147');
  assert.equal(out[2], rows[2].line.trim().replace(/ {2,}/g, '  '), 'full rows are untouched');
  assert.equal(out[7], '1', 'a footnote mark alone is not a row');
  // A row whose figures can't be lined up is marked, never passed off as whole.
  const odd = alignCells([
    { line: 'A          1        2        3', page: 1 },
    { line: 'B          4        5        6', page: 1 },
    { line: 'C                 7  8', page: 1 },
  ]);
  assert.match(odd[2].line, /^C\s+7\s+8\s+\[a cell is blank here; which column each figure is in is unclear, see the page\]$/);
  // The committed FY 2025 book carries the fix.
  const debt = BUDGET_BOOKS[2025].sections.find((s) => s.department === 'Debt Service' && s.title === 'Expenditure Summary');
  assert.match(debt.text, /^Pension Principal & Interest2  —  7,829,389  9,505,461  13,076,147$/m);
});

test('a table that runs onto the next page stays one section', () => {
  // FY 2027 budget book, PDF pages 235 and 236 (Police), rows cut.
  const pages = [
    ['Police', '', 'Permanent Full Time Equivalent (FTE) Summary:', '                                                     FY 2026    FTE FY 2027', '                                                     Adopted Change Adopted', 'Accountant I                                             1.0     0.0       1.0', 'Police Sergeant                                        102.0     0.0     102.0', '', '                                                                 Police - 359'].join('\n'),
    ['Police', '', 'Permanent Full Time Equivalent (FTE) Summary:', '                                                                FY 2026    FTE FY 2027', '                                                                Adopted Change Adopted', 'Stenographic Reporter                                                  4.0     0.0        4.0', 'Total                                                                840.0    11.0      851.0', '', 'Temporary Full Time Equivalent (FTE) Summary:', '                                                                       FY 2027', '                                                                      Adopted', 'Police Officer                                                            8.5', '', '   360 - Police'].join('\n'),
  ];
  const s = splitSections(pages, { preset: 'budget' });
  assert.deepEqual(s.map((x) => `${x.number} ${x.title}`), ['1 Police', '1.1 Permanent Full Time Equivalent (FTE) Summary', '1.2 Temporary Full Time Equivalent (FTE) Summary']);
  const fte = s[1];
  assert.deepEqual(fte.pages, [1, 2]);
  assert.match(fte.text, /Police Sergeant {2}102\.0[\s\S]*Total {2}840\.0 {2}11\.0 {2}851\.0$/);
  assert.equal(pageAt(fte, fte.text.indexOf('Total')), 2);
  assert.equal((fte.text.match(/Summary/g) || []).length, 0, 'the repeated heading is dropped');
  // None of the committed books has a table split this way.
  for (const [year, doc] of Object.entries(BUDGET_BOOKS)) {
    for (let i = 1; i < doc.sections.length; i++) {
      const [a, b] = [doc.sections[i - 1], doc.sections[i]];
      const parent = (x) => x.number.replace(/\.\d+$/, '');
      if (a.number.includes('.') && parent(a) === parent(b)) assert.notEqual(a.title, b.title, `FY ${year} ${a.number}/${b.number}`);
    }
  }
});

test('every committed document carries the search index its sections give', () => {
  for (const doc of [...Object.values(BUDGET_BOOKS), ...Object.values(DOCUMENTS)]) {
    assert.ok(doc.search_index, `${doc.id} has a search index`);
    assert.deepEqual(doc.search_index, reindexDocument(doc).search_index, `${doc.id}: rebuild with node scripts/ingest-document.js --reindex data/documents/*.json`);
  }
});

test('the budget books name positions, not people', () => {
  // Personal names appear only in the names of places, funds and laws (the
  // Mary D. Pretlow library, the Marcus-David Peters Act). A book with a staff
  // roster, or a line naming who holds a post, fails here.
  const honorific = /\b(?:Mr|Mrs|Ms|Miss|Dr|Hon|Rev)\.?\s+[A-Z][a-z]+/;
  const ROLES = 'Mayor|Councilman|Councilwoman|Councilmember|Council Member|Sheriff|Superintendent|Director|Chief|Manager|Commissioner|Treasurer|Clerk|Judge|Attorney|Auditor|Assessor';
  const roleName = new RegExp(`\\b(?:${ROLES})\\s+(?!of\\b|for\\b|and\\b)([A-Z][a-z]+)\\s+(?:[A-Z]\\.\\s+)?([A-Z][a-z]+)\\b`, 'g');
  // Words of position titles that follow a role ("Chief Deputy City Auditor").
  const TITLE_WORDS = new Set('Deputy City Real Project Manager Security Officer Resilience Clerk Circuit Commissioner Commonwealth Procurement Operating Engineer Information Park Ranger Medical Of Police'.split(' '));
  for (const [year, doc] of Object.entries(BUDGET_BOOKS)) {
    for (const s of doc.sections) {
      assert.doesNotMatch(s.text, honorific, `FY ${year} ${s.number}`);
      for (const m of s.text.matchAll(roleName)) assert.ok(TITLE_WORDS.has(m[1]) && TITLE_WORDS.has(m[2]), `FY ${year} ${s.number}: "${m[0]}"`);
    }
  }
});
