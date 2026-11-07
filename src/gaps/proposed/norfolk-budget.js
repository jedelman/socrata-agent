// PROPOSED budget gaps for Norfolk. NOT part of the catalog.
//
// Catalog entries go public when merged, and each new one needs Jason's
// approval (docs/gaps.md §4). These are drafts for that review, in the
// catalog's exact entry shape so that, once approved, an entry moves into
// src/gaps/norfolk.js unchanged apart from dropping `proposed`. Nothing under
// src/ or worker/ imports this file, and scripts/build-gaps.js never reads it
// (test/gaps-proposed.test.js holds both). It is measured only by
// scripts/build-gaps-proposed.js, which writes
// data/gaps/proposed-norfolk-budget.trace.json and docs/gaps-budget-proposed.md.
//
// Every number comes from `measure`, run through the fixed menu in
// src/gaps/measures.js at GENERIC access through the traced client. Columns
// and values below were checked against data.norfolk.gov on 2026-11-06
// (America/New_York, the builder's calendar; 2026-11-07 UTC):
// mdwe-dquf Annual Expenditures (8 columns), id3i-2az4 Annual Revenues (8),
// 7jsp-eyjg Performance Measures (15), 6tqj-4az3 CIP Projects - FY 2027 (11).
//
// Besides the catalog's keys, each entry carries `proposed: true`, `why` (why
// it is a gap and not a finding or a complaint), `context` (what a reviewer
// should know that is not evidence on the board) and, where it applies,
// `related` (approved catalog ids it links to rather than repeats) and
// `sources` (documents a reviewer can open: URL, page, the day opened). The
// builder drops these keys; the proposal page renders them. Their text passes
// the same checks as a statement.

import { fmt, pct, sourceName, T } from '../kinds.js';
import { soql, num, MeasureChange } from '../measures.js';

export const PROPOSED = true;
export const CITY = 'norfolk';
export const CATALOG_NAME = 'proposed budget gaps';
export const SET = 'norfolk-budget';
export const TOPICS = Object.freeze({});
export const RETIRED = Object.freeze([]);
export const NOT_A_GAP = Object.freeze([]);

// --- Sources -------------------------------------------------------------------
const EXP = Object.freeze({ id: 'mdwe-dquf', name: 'Annual Expenditures', phrase: "the City's Annual Expenditures records" });
const REV = Object.freeze({ id: 'id3i-2az4', name: 'Annual Revenues', phrase: "the City's Annual Revenues records" });
const PM = Object.freeze({ id: '7jsp-eyjg', name: 'Performance Measures', phrase: "the City's Performance Measures records" });
const CIP = Object.freeze({ id: '6tqj-4az3', name: 'Capital Improvement Plan (CIP) Projects - FY 2027', phrase: "the City's adopted Capital Improvement Plan projects", pronoun: 'them' });
const WO = Object.freeze({ id: 'qzfe-wj25', name: 'Work Orders', phrase: "the City's Work Orders records" });

// Constants every where clause is built from (checked live 2026-11-06).
const FORESTRY_UNIT = "upper(unit_name) like '%FOREST%'";
const PARKS_DEPT = 'The Department of Parks & Recreation (P&R)';
const PARKS = `department_name = '${PARKS_DEPT}'`;
const CONTRACTUAL = "object_name = 'Other Contractual Services'";
const PFO = 'Park and Forestry Operations';
const PM_PFO = `program_name = '${PFO}'`;
const PLANTED = 'Number of trees planted';
// The measure's actual-value columns; fy_2026_projection, fy_2027_adopted and
// fy_2027_target are projections and goals, not values for a year.
const PM_ACTUALS = ['fy_2022', 'fy_2023', 'fy_2024', 'fy_2025'];

// The City's FY2027 budget book, department budgets: opened 2026-11-06
// (America/New_York; about 03:25Z on 2026-11-07). Cited
// as reviewer context only (`sources`), never as evidence on the board.
const BOOK = 'https://www.norfolk.gov/DocumentCenter/View/114013/09-Department-Budgets';

// --- Helpers ----------------------------------------------------------------------
const plural = (k, one, many) => `${fmt(k)} ${k === 1 ? one : many}`;
const quoted = (xs) => {
  const q = xs.map((x) => `“${x}”`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} and ${q.at(-1)}`;
};
const fy = (y) => `FY${y}`;
const money = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Every distinct value of one field (with counts), refused at the 200-value cap. */
async function distinct(h, dataset, where, field, label) {
  const r = await h.run.query(dataset, soql.values(where, field), label);
  if (r.rows.length >= 200) throw new MeasureChange(`${dataset}.${field} has 200 or more values under ${where}; the values query reads at most 200.`);
  return { ...r, field, values: r.rows.map((x) => x.v).filter((v) => v != null).map(String) };
}
/** Values evidence for a distinct-values read: `matched` is what the pattern found. */
const valuesEv = (v, pattern, matched) => ({ type: 'values', dataset: v.dataset, field: v.field, values: v.values, pattern: String(pattern), matched, url: v.url, read: v.read, trace_n: v.trace_n });
/** A description of a dataset, quoted whole. */
/** A quotation, closed with a period when it doesn't end a sentence itself. */
const endQuote = (q) => `“${q}”${/[.?!]$/.test(q) ? '' : '.'}`;
const descriptionSays = ({ name, id, read, quote }) => `The ${name} description (${id}), as I read it on ${read}, says: ${endQuote(quote)}`;
const fieldSays = ({ field, quote, owner = 'Its' }) => `${owner} description of ${field}, in its words: ${endQuote(quote)}`;
/** The catalog line: counts per search, with the names Siren may open. */
function catalogLine(searches, read) {
  const part = (s, i) => {
    const open = s.results.filter((r) => r.open_to_siren);
    const lead = i === 0 ? `${plural(s.result_set_size, 'dataset', 'datasets')} in Norfolk's open data catalog for the search` : `${plural(s.result_set_size, 'dataset', 'datasets')} for`;
    const names = s.result_set_size && open.length ? `, ${open.length === s.result_set_size ? (s.result_set_size === 1 ? '' : 'all ') : `${fmt(open.length)} `}open to Siren: ${open.map((r) => r.name).join(', ')}` : '';
    return `${i === 0 ? '' : i === searches.length - 1 ? ', and ' : ', '}${lead} “${s.q}”${names}`;
  };
  return `I found ${searches.map(part).join('')} (searched ${read}).`;
}
function metadataEv(h, ids) {
  return ids.map((id) => {
    const d = h.run.describes.get(id);
    return h.ev.metadata(d, { columns: d.columns.length });
  });
}

// --- The proposed entries ----------------------------------------------------------

export const GAPS = [
  {
    id: 'norfolk.budget.forestry-in-park-unit',
    proposed: true,
    kind: 'missing_field',
    title: 'No unit or field for Forestry spending alone (Annual Expenditures)',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [EXP], scope: 'spending lines of units with Forestry in their name', area: 'citywide' },
    questions: [
      {
        qid: 'q1',
        text: 'How much does the City spend on street-tree work each year?',
        blocks: 'part',
        answered_in_part_by: [{ dataset: EXP.id, column: 'unit_name' }, { dataset: WO.id, column: 'total_cost' }],
      },
    ],
    actions: ['a-budget-proposal-program', 'a-budget-meeting-forestry'],
    touches: [{ tool: 'budget_for' }, { dataset: EXP.id }],
    bites_when: [],
    closed_when: { column_present: '/program|activit|project|function|forest/', null_share_at_most: 0.05 },
    concepts: { program: { pattern: /program|activit|project|function|forest/i, datasets: [EXP.id] } },
    lines: /forest|\btrees?\b|prun|arbor/i,
    why: [
      'Annual Expenditures holds spending by department, unit and expense line.',
      'I found “Forestry” in one unit name, and that name covers park operations as well, and I found no field or expense line that splits the Forestry part out.',
      'The entry states what the records hold and leave out, and claims nothing about what the City spends on trees.',
    ].join(' '),
    context: [
      'The City’s FY2027 budget book, which I opened and checked on 2026-11-06, describes the program on PDF page 176 (printed page 300), in its words: “The Parks and Forestry Operations program maintains the beautification of the city by providing mowing, landscape maintenance, litter control, turf installation, emptying refuse receptacles, applying fertilizer and herbicide, and maintaining/repairing irrigation.”',
      'The same page, in its words: “The program maintains all trees on City property including street trees through pruning, removal, and planting services”.',
      'The book is not evidence on the board: it enters only as a case-file finding, checked by verify-cases, through a case-file PR.',
    ].join(' '),
    sources: [{ title: "The City's FY2027 budget book, department budgets", url: BOOK, pages: 'PDF page 176 (printed page 300)', opened: '2026-11-06' }],
    async measure(h) {
      const units = await distinct(h, EXP.id, FORESTRY_UNIT, 'unit_name', 'units with Forestry in their name');
      if (units.values.length !== 1) throw new MeasureChange(`${plural(units.values.length, 'unit', 'units')} now carry “Forestry” in the name; a reviewer looks before this gap is shown again.`);
      const unit = units.values[0];
      const lines = await distinct(h, EXP.id, FORESTRY_UNIT, 'object_name', 'expense lines under the Forestry unit');
      const matched = lines.values.filter((v) => this.lines.test(v));
      if (matched.length) throw new MeasureChange(`An expense line under ${unit} now names forestry or trees: ${matched.join(', ')}.`);
      const k = this.concepts.program;
      const cols = await h.run.columnsAbsent({ datasets: k.datasets, pattern: k.pattern });
      const read = h.dateOf(units.read);
      const lread = h.dateOf(lines.read);
      const cread = h.dateOf(cols.read);
      const n = lines.values.length;
      return {
        how_much: { values: { dataset: EXP.id, field: 'object_name', count: n, matched: [], read: lines.read }, columns_absent: cols },
        evidence: [valuesEv(units, /forest/i, [unit]), valuesEv(lines, this.lines, []), ...metadataEv(h, k.datasets)],
        statement: [
          `I found 1 unit with “Forestry” in its name in ${sourceName(EXP)}, “${unit}”, as I read them on ${read}.`,
          `I found none of the ${fmt(n)} expense line names under it naming forestry, trees or pruning, as I read them on ${lread}.`,
          T.columnsAbsent({ concept: 'for a program or activity', count: cols.datasets[EXP.id], source: EXP, read: cread }),
        ].join(' '),
        short: `I found “Forestry” in one unit name in the City's Annual Expenditures, “${unit}”, and no expense line under it naming trees, measured ${lread}.`,
        consequences: {
          q1: T.consequencePart({
            source: EXP,
            finding: `I found “Forestry” in the name of one unit, “${unit}”, and none of its ${fmt(n)} expense line names mentions forestry, trees or pruning`,
            measured: lread,
            tail: `so I can give that unit's spending but not the part spent on trees; Forestry work orders in ${sourceName(WO)} carry a total_cost column`,
          }),
        },
      };
    },
  },

  {
    id: 'norfolk.budget.three-fiscal-years',
    proposed: true,
    kind: 'partial_coverage',
    title: 'Fiscal years held in the open spending and revenue records',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [EXP, REV], scope: 'fiscal years in the open spending and revenue records', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'How has Parks and Recreation spending changed over the last ten years?', blocks: 'part', answered_in_part_by: [{ dataset: EXP.id, column: 'fiscal_year' }] },
      { qid: 'q2', text: "How has the City's revenue from fees and taxes changed over the last ten years?", blocks: 'part', answered_in_part_by: [{ dataset: REV.id, column: 'fiscal_year' }] },
    ],
    actions: ['a-budget-proposal-years', 'a-budget-meeting-years'],
    touches: [{ tool: 'budget_for' }, { dataset: EXP.id }, { dataset: REV.id }],
    bites_when: [],
    closed_when: { finding: true },
    quotes: {
      [EXP.id]: [
        'This dataset summarizes the city’s cash outlays and accruals for the cost of goods received or services rendered, by department, department unit/division, and expenditure type, for three years; the current fiscal year and two previous fiscal years.',
      ],
      [REV.id]: ['The data set includes the current fiscal year and two previous fiscal years.'],
    },
    why: [
      'Both datasets describe themselves as holding the current fiscal year and two before it, and I found three fiscal years in each.',
      'A question about a longer trend is answered from them only in part.',
      'The entry reports the years the open records hold, and says nothing about records kept elsewhere.',
    ].join(' '),
    context: [
      'The City’s FY2027 budget book, which I opened and checked on 2026-11-06, carries a column headed “FY 2024 Actual” in the Parks and Recreation summaries on PDF page 173 (printed page 297).',
      'That column sits outside the open records, and the book is not evidence on the board.',
    ].join(' '),
    sources: [{ title: "The City's FY2027 budget book, department budgets", url: BOOK, pages: 'PDF page 173 (printed page 297)', opened: '2026-11-06' }],
    async measure(h) {
      const exp = await distinct(h, EXP.id, 'fiscal_year IS NOT NULL', 'fiscal_year', 'fiscal years in Annual Expenditures');
      const rev = await distinct(h, REV.id, 'fiscal_year IS NOT NULL', 'fiscal_year', 'fiscal years in Annual Revenues');
      const qe = await h.run.descriptionQuote(EXP.id, this.quotes[EXP.id]);
      const qr = await h.run.descriptionQuote(REV.id, this.quotes[REV.id]);
      const fd = await h.run.fieldDescription(EXP.id, 'actual_expenses');
      const years = (v) => [...v.values].sort();
      const ey = years(exp);
      const ry = years(rev);
      if (!ey.length || !ry.length) throw new MeasureChange('No fiscal year read.');
      const read = h.dateOf(exp.read);
      const yearsText = (ys) => (ys.length <= 1 ? fy(ys[0]) : `${ys.slice(0, -1).map(fy).join(', ')} and ${fy(ys.at(-1))}`);
      const same = ey.join() === ry.join();
      return {
        how_much: { values: { dataset: EXP.id, field: 'fiscal_year', count: ey.length, matched: ey, read: exp.read }, quote: { dataset: EXP.id, text: qe.quote, read: qe.read }, published: { rows_updated: qe.updated, read: qe.read } },
        evidence: [valuesEv(exp, /^\d{4}$/, ey), valuesEv(rev, /^\d{4}$/, ry), h.ev.metadata(qe, { quote: qe.quote }), h.ev.metadata(qr, { quote: qr.quote }), h.ev.field(fd)],
        statement: [
          `I found fiscal years ${yearsText(ey)} in ${sourceName(EXP)}, and ${same ? 'the same years' : `fiscal years ${yearsText(ry)}`} in ${sourceName(REV)}, as I read them on ${read}.`,
          descriptionSays({ name: 'Annual Expenditures', id: EXP.id, read: h.dateOf(qe.read), quote: qe.quote }),
          descriptionSays({ name: 'Annual Revenues', id: REV.id, read: h.dateOf(qr.read), quote: qr.quote }),
          fieldSays({ owner: 'The Annual Expenditures', field: 'actual_expenses', quote: fd.quote }),
        ].join(' '),
        short: `I found fiscal years ${fy(ey[0])} through ${fy(ey.at(-1))} in the City's Annual Expenditures, and ${fy(ry[0])} through ${fy(ry.at(-1))} in its Annual Revenues, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({ source: EXP, finding: `I found ${fmt(ey.length)} fiscal years in them, ${fy(ey[0])} through ${fy(ey.at(-1))}`, measured: read, tail: `so I can show those years only, with ${fy(ey.at(-1))} spending to date` }),
          q2: T.consequencePart({ source: REV, finding: `I found ${fmt(ry.length)} fiscal years in them, ${fy(ry[0])} through ${fy(ry.at(-1))}`, measured: read, tail: `so I can show those years only, with ${fy(ry.at(-1))} collections to date` }),
        },
      };
    },
  },

  {
    id: 'norfolk.budget.contractual-no-link',
    proposed: true,
    kind: 'missing_field',
    title: 'No field linking spending lines to a contract or work order (Annual Expenditures)',
    checked_live: '2026-11-06',
    topic: null,
    related: ['norfolk.work-orders.no-contract-link'],
    where: { sources: [EXP, { type: 'catalog', id: 'data.norfolk.gov' }], scope: 'spending lines', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'Which contracts did the City pay from the Park and Forestry Operations contractual services line last year?', blocks: 'all', concept: 'link' },
      { qid: 'q2', text: "Which tree work did the City's contractual spending on park and forestry operations pay for?", blocks: 'all', concept: 'link' },
    ],
    actions: ['a-budget-proposal-contract-number', 'a-budget-meeting-contracts', 'a-budget-foia-contracts'],
    touches: [{ tool: 'budget_for' }, { dataset: EXP.id }],
    bites_when: [],
    closed_when: { column_present: '/vendor|payee|supplier|contract|invoice|purchase|work_?order|(^|_)po(_|$)/', null_share_at_most: 0.05 },
    concepts: { link: { pattern: /vendor|payee|supplier|contract|invoice|purchase|work_?order|(^|_)po(_|$)/i, datasets: [EXP.id] } },
    // A whole fiscal year: the line read for its amounts.
    year: 2026,
    searches: ['checkbook', 'vendor'],
    // A catalog hit with a name like these may be the missing link: a reviewer looks.
    linkNames: /vendor|payment|contract|checkbook|purchas|invoice|spend/i,
    why: [
      'The line “Other Contractual Services” records an amount and a budget for a unit and a year.',
      'I found no column in Annual Expenditures that ties a line to a contract, a purchase order or a work order, so the work an amount paid for stays out of these records.',
      'The entry describes that missing link, and claims nothing about whether any payment was right.',
      'The work-order side is an approved catalog entry, linked from this one, and this entry repeats none of it.',
    ].join(' '),
    context: 'I checked the request’s figures for this line against the live read on 2026-11-06: the statement reads the FY2026 actual and budget from the one line they come from, with a check that the line is a single row.',
    async measure(h) {
      const k = this.concepts.link;
      const cols = await h.run.columnsAbsent({ datasets: k.datasets, pattern: k.pattern });
      const where = `unit_name = '${PFO}' AND ${CONTRACTUAL} AND fiscal_year = ${this.year}`;
      const one = await h.run.query(EXP.id, soql.share(where, {}), `${PFO}: contractual services lines, FY${this.year}`);
      if (num(one.rows[0], 'whole') !== 1) throw new MeasureChange(`${num(one.rows[0], 'whole')} lines match ${where}; the amounts are read only from a single line.`);
      // span over a one-row scope: its first and last value is the line's value.
      const amt = await h.run.query(EXP.id, soql.span(where, ['actual_expenses', 'current_expense_budget']), `${PFO}: contractual services amounts, FY${this.year}`);
      const a = amt.rows[0];
      if (a.min_actual_expenses !== a.max_actual_expenses || a.min_current_expense_budget !== a.max_current_expense_budget) throw new MeasureChange('The one-row read gave two values.');
      const searches = [];
      for (const q of this.searches) searches.push(await h.run.catalogSearch(q));
      const named = searches.flatMap((s) => s.results).filter((r) => this.linkNames.test(r.name));
      if (named.length) throw new MeasureChange(`The catalog now names ${named.map((r) => r.name).join(', ')}; a reviewer looks before this gap is shown again.`);
      const read = h.dateOf(cols.read);
      const aread = h.dateOf(amt.read);
      const sread = h.dateOf(searches[0].read);
      const n = cols.datasets[EXP.id];
      const concept = 'naming a vendor, contract, invoice, purchase order or work order';
      const consequence = `I found no column ${concept} among the ${fmt(n)} columns of ${sourceName(EXP)}, measured ${read}, so I can't answer this from them.`;
      return {
        how_much: {
          columns_absent: cols,
          catalog: searches.map((s) => ({ q: s.q, result_set_size: s.result_set_size, open_to_siren: s.results.filter((r) => r.open_to_siren).map((r) => ({ id: r.id, name: r.name })), read: s.read })),
        },
        evidence: [...metadataEv(h, k.datasets), h.ev.query(one), h.ev.query(amt), ...searches.map(h.ev.catalog)],
        statement: [
          T.columnsAbsent({ concept, count: n, source: EXP, read }),
          // The amounts end the sentence: public-text's long_number check reads
          // an amount followed by a comma ("$1,200,643,") as a 7-digit number.
          `Under “${PFO}”, as I read them on ${aread}, I found the line “Other Contractual Services” for ${fy(this.year)} with actual expenses of ${money(a.min_actual_expenses)} and a current expense budget of ${money(a.min_current_expense_budget)}.`,
          catalogLine(searches, sread),
        ].join(' '),
        short: `I found no column in the City's Annual Expenditures tying a spending line to a vendor, contract, purchase order or work order, measured ${read}.`,
        consequences: { q1: consequence, q2: consequence },
      };
    },
  },

  {
    id: 'norfolk.budget.no-pruning-measure',
    proposed: true,
    kind: 'no_records',
    title: 'Street-tree pruning in the performance measures checked',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [PM, WO], scope: 'performance measures', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'What share of street-tree pruning requests does the City fulfill each year?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'primary_task_description' }] },
      { qid: 'q2', text: 'How many street trees did the City plant in each of the last four fiscal years?', blocks: 'part', answered_in_part_by: [{ dataset: PM.id, column: 'fy_2026_projection' }, { dataset: PM.id, column: 'fy_2027_target' }] },
    ],
    actions: ['a-budget-proposal-pruning-measure', 'a-budget-meeting-pruning-measure'],
    touches: [{ tool: 'budget_for' }, { dataset: PM.id }, { case: 'norfolk-trees' }],
    bites_when: [],
    closed_when: { finding: true },
    prune: /prun/i,
    why: [
      'The City’s FY2024 adopted budget names a measure for street-tree pruning requests fulfilled, by the quote the case file checked.',
      'I found no pruning measure in the open Performance Measures records, and I found no yearly value for the one Forestry measure about trees, so the question stays open in these records.',
      'The entry reports what the dataset holds, and claims nothing about the City’s pruning work or about why a measure is published or left out.',
    ].join(' '),
    context: [
      'The request cited the FY2024 book’s pruning percentages and target from the case file.',
      'That finding’s checked quote holds only the measure’s name, “Percent of street tree pruning requests fulfilled”, so only the name enters this entry, and the percentages and the target stay out.',
      'The case file’s measure-dropped finding is unverified, so it is not cited.',
    ].join(' '),
    async measure(h) {
      const all = await h.run.query(PM.id, soql.share('measure_id IS NOT NULL', { prune: "upper(measure_description) like '%PRUN%'" }), 'performance measures naming pruning');
      const whole = num(all.rows[0], 'whole');
      const prune = num(all.rows[0], 'prune');
      if (prune) throw new MeasureChange(`${plural(prune, 'measure now names', 'measures now name')} pruning; the gap may be closing, and a reviewer looks.`);
      const pfo = await h.run.valuesAbsent({ dataset: PM.id, field: 'measure_description', where: PM_PFO, pattern: this.prune });
      if (pfo.matched.length) throw new MeasureChange(`A ${PFO} measure now names pruning: ${pfo.matched.join(', ')}.`);
      if (!pfo.values.includes(PLANTED)) throw new MeasureChange(`“${PLANTED}” is no longer a ${PFO} measure.`);
      const planted = await h.run.query(PM.id, soql.share(`${PM_PFO} AND measure_description = '${PLANTED}'`, { no_actual: PM_ACTUALS.map((c) => `${c} IS NULL`).join(' AND ') }), 'trees planted: values by year');
      if (num(planted.rows[0], 'whole') !== 1) throw new MeasureChange(`“${PLANTED}” is ${num(planted.rows[0], 'whole')} rows, not 1.`);
      if (num(planted.rows[0], 'no_actual') !== 1) throw new MeasureChange(`“${PLANTED}” now holds a value for a year.`);
      const tasks = await h.run.query(WO.id, soql.values("area = 'Forestry'", 'primary_task_description'), 'Forestry tasks');
      const pruning = tasks.rows.find((x) => x.v === 'Pruning');
      if (!pruning) throw new MeasureChange('The Forestry task “Pruning” is no longer recorded.');
      const f = h.finding('norfolk-trees', 'pruning-requests-fulfilled');
      const read = h.dateOf(all.read);
      const pread = h.dateOf(pfo.read);
      const tread = h.dateOf(tasks.read);
      const npr = num(pruning, 'n');
      const years = `${fy(PM_ACTUALS[0].slice(3))} through ${fy(PM_ACTUALS.at(-1).slice(3))}`;
      return {
        how_much: { part: prune, whole, read: all.read, values: { dataset: PM.id, field: 'measure_description', count: pfo.values.length, matched: [], read: pfo.read } },
        evidence: [h.ev.query(all), h.ev.values(pfo), h.ev.query(planted), h.ev.query(tasks), h.ev.finding(f)],
        statement: [
          `Of ${fmt(whole)} measures in ${sourceName(PM)}, I found none with a description naming pruning, as I read them on ${read}.`,
          `Under the program “${PFO}” I found ${plural(pfo.values.length, 'measure', 'measures')}, ${quoted(pfo.values)}, and no value for “${PLANTED}” in ${years}, as I read them on ${pread}.`,
          T.findingQuote({ who: "The City's FY2024 adopted budget", quote: f.quote, checked: f.checked }),
          `I found the task “Pruning” on ${fmt(npr)} Forestry work orders in ${sourceName(WO)}, as I read them on ${tread}.`,
        ].join(' '),
        short: `Of ${fmt(whole)} measures in the City's Performance Measures, I found none naming pruning, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({ source: WO, finding: `I found the task “Pruning” on ${fmt(npr)} Forestry work orders`, measured: tread, tail: 'which counts orders, not requests received or fulfilled, and I found no pruning measure in the Performance Measures records' }),
          q2: T.consequencePart({ source: PM, finding: `I found no value for “${PLANTED}” in ${years}`, measured: pread, tail: 'so I can give only its projection and target' }),
        },
      };
    },
  },

  {
    id: 'norfolk.budget.cip-no-ward',
    proposed: true,
    kind: 'missing_field',
    title: 'Capital projects with no ward or coordinates (adopted capital plan)',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [CIP], scope: 'projects in the adopted capital plan', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'Which capital projects in the adopted plan are in my ward?', blocks: 'part', answered_in_part_by: [{ dataset: CIP.id, column: 'ward' }] },
      { qid: 'q2', text: 'Which planned capital projects are near me?', blocks: 'part', answered_in_part_by: [{ dataset: CIP.id, column: 'latitude' }, { dataset: CIP.id, column: 'longitude' }] },
    ],
    actions: ['a-budget-proposal-cip-place', 'a-budget-meeting-cip-place'],
    touches: [{ tool: 'capital_projects' }, { dataset: CIP.id }],
    bites_when: [],
    closed_when: { share_at_most: 0.05, over: 'whole' },
    why: [
      'I found capital projects with no ward and no coordinates in these records, and a search by ward or by distance leaves them out.',
      'The entry counts those rows, and claims nothing about whether a project has a site.',
      'A project with no ward can be citywide work, and I found no field in these records that marks it so.',
    ].join(' '),
    context: 'The request gave a count of projects with no ward from a read on 2026-11-06, and I found the same count when I measured it again.',
    async measure(h) {
      const r = await h.run.query(
        CIP.id,
        soql.share('project_id IS NOT NULL', { no_ward: 'ward IS NULL', no_coord: 'latitude IS NULL OR longitude IS NULL', neither: 'ward IS NULL AND (latitude IS NULL OR longitude IS NULL)' }),
        'capital projects with no ward or coordinates'
      );
      const fl = await h.run.fieldDescription(CIP.id, 'location');
      const row = r.rows[0];
      const whole = num(row, 'whole');
      const part = num(row, 'no_ward');
      const coord = num(row, 'no_coord');
      const neither = num(row, 'neither');
      const read = h.dateOf(r.read);
      return {
        how_much: { part, whole, read: r.read },
        evidence: [h.ev.query(r), h.ev.field(fl)],
        statement: [
          T.share({ part, whole, scope: 'projects', absent: 'with no ward', source: CIP, read }),
          `Of the same ${fmt(whole)}, I found ${fmt(coord)} with no latitude or longitude, ${fmt(neither)} of them with no ward either, as I read them on ${read}.`,
          fieldSays({ field: 'location', quote: fl.quote }),
        ].join(' '),
        short: `I found ${fmt(part)} of ${fmt(whole)} projects (${pct(part, whole)}%) with no ward in the City's adopted Capital Improvement Plan data, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({ source: CIP, finding: `I found ${fmt(part)} of ${fmt(whole)} projects (${pct(part, whole)}%) with no ward`, measured: read, tail: "so a search by ward can't find them" }),
          q2: T.consequencePart({ source: CIP, finding: `I found ${fmt(coord)} of ${fmt(whole)} projects (${pct(coord, whole)}%) with no latitude or longitude`, measured: read, tail: "so a search by distance can't find them" }),
        },
        closing: whole > 0 && part / whole <= 0.05,
      };
    },
  },

  {
    id: 'norfolk.budget.parks-revenue-units',
    proposed: true,
    kind: 'partial_coverage',
    title: 'Parks and Recreation revenue units with no spending unit of the same name',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [REV, EXP], scope: `units under ${PARKS_DEPT}`, area: 'citywide' },
    questions: [
      {
        qid: 'q1',
        text: "How much of a Parks and Recreation program's cost do its own fees and charges cover?",
        blocks: 'part',
        answered_in_part_by: [{ dataset: REV.id, column: 'unit_name' }, { dataset: EXP.id, column: 'unit_name' }],
      },
    ],
    actions: ['a-budget-proposal-crosswalk', 'a-budget-meeting-crosswalk'],
    touches: [{ tool: 'budget_for' }, { dataset: REV.id }],
    bites_when: [],
    closed_when: { share_at_most: 0, over: 'whole' },
    why: [
      'Setting a program’s revenue against its cost from these records takes the same unit in both datasets.',
      'I found every department name shared between them, and under Parks and Recreation I found a revenue unit with a name that matches no spending unit, so that revenue has no cost to sit beside in these records.',
      'The entry reports the names as recorded, and claims nothing about how the City budgets the program.',
    ].join(' '),
    context: [
      'The request was citywide: revenue and spending units that differ.',
      'I found the department names all matching, so the entry narrows to the unit names under Parks and Recreation.',
      'A citywide comparison of unit names passes the values measure’s 200-value cap in Annual Expenditures (an exploratory read I checked on 2026-11-06, outside the trace, counted 321 unit names), so the menu can’t measure it whole.',
    ].join(' '),
    async measure(h) {
      const ed = await distinct(h, EXP.id, 'department_name IS NOT NULL', 'department_name', 'department names in Annual Expenditures');
      const rd = await distinct(h, REV.id, 'department_name IS NOT NULL', 'department_name', 'department names in Annual Revenues');
      const ru = await distinct(h, REV.id, PARKS, 'unit_name', 'Parks and Recreation revenue units');
      const eu = await distinct(h, EXP.id, PARKS, 'unit_name', 'Parks and Recreation spending units');
      if (!ru.values.length || !eu.values.length) throw new MeasureChange(`No units under ${PARKS_DEPT}.`);
      const edSet = new Set(ed.values);
      const shared = rd.values.filter((d) => edSet.has(d)).length;
      const euSet = new Set(eu.values);
      const unmatched = [...ru.values].sort().filter((u) => !euSet.has(u));
      const part = unmatched.length;
      const whole = ru.values.length;
      const read = h.dateOf(ru.read);
      const dread = h.dateOf(rd.read);
      const deptLine =
        shared === rd.values.length
          ? `I found all ${fmt(rd.values.length)} department names in ${sourceName(REV)} also in ${sourceName(EXP)}, as I read them on ${dread}.`
          : `Of ${fmt(rd.values.length)} department names in ${sourceName(REV)}, I found ${fmt(shared)} also in ${sourceName(EXP)}, as I read them on ${dread}.`;
      return {
        how_much: { part, whole, read: ru.read, values: { dataset: REV.id, field: 'unit_name', count: whole, matched: unmatched, read: ru.read } },
        evidence: [valuesEv(ed, /.*/, ed.values), valuesEv(rd, /.*/, rd.values), valuesEv(ru, /.*/, ru.values), valuesEv(eu, /.*/, eu.values)],
        statement: [
          deptLine,
          `Under “${PARKS_DEPT}”, I found ${plural(whole, 'revenue unit', 'revenue units')} in Annual Revenues and ${plural(eu.values.length, 'spending unit', 'spending units')} in Annual Expenditures, as I read them on ${read}.`,
          part
            ? `Of the ${fmt(whole)} revenue units, I found ${fmt(part)} with no spending unit of the same name, ${quoted(unmatched)}, as I read them on ${read}.`
            : `I found a spending unit of the same name for each of the ${fmt(whole)} revenue units, as I read them on ${read}.`,
        ].join(' '),
        short: `Under Parks and Recreation, I found ${fmt(part)} of ${fmt(whole)} revenue units with no spending unit of the same name in the City's budget records, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({
            source: REV,
            finding: `I found ${fmt(part)} of ${fmt(whole)} Parks and Recreation revenue units${part ? `, ${quoted(unmatched)},` : ''} with no spending unit of the same name in Annual Expenditures`,
            measured: read,
            tail: "so I can't set that revenue against a cost",
          }),
        },
        closing: part === 0,
      };
    },
  },

  {
    id: 'norfolk.budget.no-amendment-history',
    proposed: true,
    kind: 'missing_field',
    title: 'No adopted amount or amendment date beside the current budget (Annual Expenditures)',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [EXP], scope: 'spending lines', area: 'citywide' },
    questions: [
      { qid: 'q1', text: "What did the City Council adopt for a department's budget before any amendments this year?", blocks: 'all', concept: 'amend' },
      { qid: 'q2', text: "When during the year was a department's budget changed, and by how much?", blocks: 'all', concept: 'amend' },
    ],
    actions: ['a-budget-proposal-amendments', 'a-budget-meeting-amendments'],
    touches: [{ tool: 'budget_for' }, { dataset: EXP.id }],
    bites_when: [],
    closed_when: { column_present: '/adopt|original|amend|transfer|revis|prior|(^|_)date|modif|effective/', null_share_at_most: 0.05 },
    concepts: { amend: { pattern: /adopt|original|amend|transfer|revis|prior|(^|_)date|modif|effective/i, datasets: [EXP.id] } },
    quote: [
      'The data also contains current budget information.',
      'Current budget reflects budget transfers and amendments during the fiscal year that have transpired since City Council adopted the budget prior to the beginning of the current fiscal year.',
    ],
    why: [
      'The dataset’s own description says its budget figure reflects transfers and amendments made since adoption.',
      'I found one budget column and no column for the adopted amount, an amendment or its date, so how a budget changed during the year stays out of these records.',
      'The entry reports the columns, and claims nothing about whether or how often an amendment happened.',
    ].join(' '),
    context: 'Annual Revenues describes its budget as the one adopted by City Council ahead of each fiscal year, so this entry covers the spending side only.',
    async measure(h) {
      const q = await h.run.descriptionQuote(EXP.id, this.quote);
      const fd = await h.run.fieldDescription(EXP.id, 'current_expense_budget');
      const k = this.concepts.amend;
      const cols = await h.run.columnsAbsent({ datasets: k.datasets, pattern: k.pattern });
      const read = h.dateOf(cols.read);
      const n = cols.datasets[EXP.id];
      const concept = 'for an adopted amount, an amendment or transfer, or a date it took effect';
      const consequence = `I found no column ${concept} among the ${fmt(n)} columns of ${sourceName(EXP)}, measured ${read}, so I can't answer this from them.`;
      return {
        how_much: { columns_absent: cols, quote: { dataset: EXP.id, text: q.quote, read: q.read }, published: { rows_updated: q.updated, read: q.read } },
        evidence: [h.ev.metadata(q, { quote: q.quote }), h.ev.field(fd), ...metadataEv(h, k.datasets)],
        statement: [
          descriptionSays({ name: 'Annual Expenditures', id: EXP.id, read: h.dateOf(q.read), quote: q.quote }),
          fieldSays({ field: 'current_expense_budget', quote: fd.quote }),
          T.columnsAbsent({ concept, count: n, source: EXP, read }),
        ].join(' '),
        short: `I found no column for an adopted amount or an amendment date among the ${fmt(n)} columns of the City's Annual Expenditures, measured ${read}.`,
        consequences: { q1: consequence, q2: consequence },
      };
    },
  },
];

// What would close each proposed gap: drafts like the catalog's actions
// (docs/gaps.md §9). Siren drafts; people ask and propose. A records request
// waits for a case-file records_to_request entry, as the catalog's do.
export const ACTIONS = [
  { id: 'a-budget-proposal-program', kind: 'dataset_proposal', text: 'Publish a program or activity field in Annual Expenditures, so spending on street trees can be read apart from the rest of its unit.' },
  { id: 'a-budget-meeting-forestry', kind: 'meeting_question', text: 'How much of the Park and Forestry Operations budget goes to street-tree work each year, and where is that recorded?' },
  { id: 'a-budget-proposal-years', kind: 'dataset_proposal', text: 'Publish earlier fiscal years of Annual Expenditures and Annual Revenues beside the current three.' },
  { id: 'a-budget-meeting-years', kind: 'meeting_question', text: 'Does the City plan to publish earlier fiscal years of its spending and revenue data, and where can residents read them now?' },
  { id: 'a-budget-proposal-contract-number', kind: 'dataset_proposal', text: 'Publish a contract or purchase order number on each Annual Expenditures line, so contractual spending can be tied to the work it paid for.' },
  { id: 'a-budget-meeting-contracts', kind: 'meeting_question', text: 'Which contracts does the Park and Forestry Operations line for other contractual services pay for, and where are they recorded?' },
  { id: 'a-budget-foia-contracts', kind: 'foia_draft', needs: 'a records_to_request entry for the contracts paid from the Park and Forestry Operations contractual services line, added to a case file by case-file PR' },
  { id: 'a-budget-proposal-pruning-measure', kind: 'dataset_proposal', text: 'Add street-tree pruning requests received and fulfilled to the Performance Measures dataset, with a value for each year.' },
  { id: 'a-budget-meeting-pruning-measure', kind: 'meeting_question', text: 'Does the City track the share of street-tree pruning requests it fulfills each year, and where can residents read it?' },
  { id: 'a-budget-proposal-cip-place', kind: 'dataset_proposal', text: 'Give every project in the Capital Improvement Plan data a ward, or mark it citywide, and coordinates where it has a site.' },
  { id: 'a-budget-meeting-cip-place', kind: 'meeting_question', text: 'How can residents find which capital projects with no ward in the plan data affect their part of the city?' },
  { id: 'a-budget-proposal-crosswalk', kind: 'dataset_proposal', text: 'Use the same unit names for a program in Annual Revenues and Annual Expenditures, or publish a crosswalk between them.' },
  { id: 'a-budget-meeting-crosswalk', kind: 'meeting_question', text: 'Which Parks and Recreation spending units do its revenue units support, where their names differ?' },
  { id: 'a-budget-proposal-amendments', kind: 'dataset_proposal', text: 'Publish the adopted amount beside the current budget on each Annual Expenditures line, and a dated list of budget transfers and amendments.' },
  { id: 'a-budget-meeting-amendments', kind: 'meeting_question', text: 'Where can residents read each budget transfer and amendment the City makes during the fiscal year, with its date?' },
];

/**
 * Candidates tested and dropped or reshaped (by number in the request of
 * 2026-11-06). Each reason passes the same checks as a statement.
 */
export const REVIEW = Object.freeze([
  { candidate: '1. Forestry spending inside park upkeep', outcome: 'kept as norfolk.budget.forestry-in-park-unit', reason: 'The budget book’s description of the program enters as reviewer context only, with its URL and page, because I opened it and found the words; the statement stands on the dataset alone.' },
  { candidate: '2. Three fiscal years in the open data', outcome: 'kept as norfolk.budget.three-fiscal-years', reason: 'The part about earlier years living only in the budget books is left out of the statement: it is about documents outside the records, and the entry states only what the open records hold.' },
  { candidate: '3. Contractual spending not tied to work', outcome: 'kept as norfolk.budget.contractual-no-link, spending side only', reason: 'The work-order side is an approved catalog entry, linked from this one, and this entry measures only Annual Expenditures and the catalog.' },
  { candidate: '4. Pruning in the performance measures', outcome: 'reshaped as norfolk.budget.no-pruning-measure', reason: 'The checked quote holds only the measure’s name, so the FY2021 through FY2023 percentages and the target stay out; the entry adds what the dataset holds for trees planted.' },
  { candidate: '5. Capital projects with no ward', outcome: 'kept as norfolk.budget.cip-no-ward', reason: 'Measured live with coordinates too, and the count matches the one in the request.' },
  { candidate: '6. Revenue and spending units', outcome: 'reshaped as norfolk.budget.parks-revenue-units', reason: 'I found every department name in Annual Revenues also in Annual Expenditures, so the mismatch is narrowed to unit names under Parks and Recreation, where I found it.' },
  { candidate: '7. Only the amended budget published', outcome: 'kept as norfolk.budget.no-amendment-history', reason: 'Scoped to Annual Expenditures, since its description says its budget reflects amendments, and Annual Revenues describes its budget as the adopted one.' },
]);
