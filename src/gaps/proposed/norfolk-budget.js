// PROPOSED budget gaps for Norfolk. NOT part of the catalog.
//
// Catalog entries go public when merged, and each new one needs Jason's
// approval (docs/gaps.md §4). These are drafts for that review, in the
// catalog's exact entry shape. To approve one, move it into
// src/gaps/norfolk.js, dropping the review-only keys `proposed`, `why`,
// `context`, `related` and `sources` (REVIEW_KEYS below; the builder's page
// says the same), and copy with it the source constants (EXP, REV, PM, CIP,
// WO, INDEX) and helpers it calls (distinct, valuesEv, descriptionSays,
// fieldSays, catalogLine, metadataEv, quoted, plural, fy, budgetCleared and
// the where-clause constants), which norfolk.js doesn't have; the budget
// topic itself is already there. Its actions move into
// src/gaps/actions-norfolk.js. Nothing under src/ or worker/ imports this
// file, and scripts/build-gaps.js never reads it
// (test/gaps-proposed.test.js holds both). It is measured only by
// scripts/build-gaps-proposed.js, which writes
// data/gaps/proposed-norfolk-budget.trace.json and docs/gaps-budget-proposed.md.
//
// Every number comes from `measure`, run through the fixed menu in
// src/gaps/measures.js at GENERIC access through the traced client. Columns
// and values below were checked against data.norfolk.gov on 2026-11-06
// (America/New_York, the builder's calendar; 2026-11-07 UTC), and checked
// again when the review fixes were measured the same evening:
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
//
// `touches` predicates name what a turn ran (docs/gaps.md §8.1): an entry
// about one unit or program carries a where_includes that a query of that
// unit or program holds, so a budget question about another department
// doesn't attach it. Only the entries about a whole dataset touch it bare.

import { fmt, pct, sourceName, T } from '../kinds.js';
import { soql, num, MeasureChange } from '../measures.js';
import { TOPICS as APPROVED_TOPICS } from '../norfolk.js';

export const PROPOSED = true;
export const CITY = 'norfolk';
export const CATALOG_NAME = 'proposed budget gaps';
export const SET = 'norfolk-budget';
// The budget topic is the approved catalog's (src/gaps/norfolk.js; Jason,
// 2026-11-09), so an entry approved into the catalog keeps the topic it was
// measured under. Every entry here names it: the builder checks the topic's
// catalog hits and placements live, and a 'blocks: all' question needs
// columns_absent over every one of its datasets.
export const TOPICS = Object.freeze({ budget: APPROVED_TOPICS.budget });
export const RETIRED = Object.freeze([]);
export const NOT_A_GAP = Object.freeze([]);
/** Keys only a proposal carries; dropped when an entry moves into the catalog. */
export const REVIEW_KEYS = Object.freeze(['proposed', 'why', 'context', 'related', 'sources']);

// --- Sources -------------------------------------------------------------------
const EXP = Object.freeze({ id: 'mdwe-dquf', name: 'Annual Expenditures', phrase: "the City's Annual Expenditures records" });
const REV = Object.freeze({ id: 'id3i-2az4', name: 'Annual Revenues', phrase: "the City's Annual Revenues records" });
const PM = Object.freeze({ id: '7jsp-eyjg', name: 'Performance Measures', phrase: "the City's Performance Measures records" });
const CIP = Object.freeze({ id: '6tqj-4az3', name: 'Capital Improvement Plan (CIP) Projects - FY 2027', phrase: "the City's adopted Capital Improvement Plan projects", pronoun: 'them' });
const WO = Object.freeze({ id: 'qzfe-wj25', name: 'Work Orders', phrase: "the City's Work Orders records" });
const INDEX = Object.freeze({ id: 'norfolk-legislation', name: "Siren's agenda index", phrase: "Siren's agenda index" });

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
// Forestry work orders by task (Work Orders), and the City's code for “Complete”.
const WO_FORESTRY = "area = 'Forestry'";
const WO_PRUNING = `${WO_FORESTRY} AND primary_task_description = 'Pruning'`;
const COMPLETE = { code: 999, as_recorded: 'Complete' };
// Agenda-item titles that amend an annual appropriations ordinance or an annual
// budget (checked against data/norfolk-legislation.json, built 2026-11-02, on
// 2026-11-06, America/New_York). Capital Improvement Plan budget ordinances
// are left out: they amend the capital plan, not the operating budget.
const AMEND_TITLE = /\bamend(?:ing|s)?\b[^.;:]{0,80}?\bG?FY ?\d{2,4} annual (?:appropriations? ordinance|budget)/i;

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
const BUDGET = APPROVED_TOPICS.budget;
/** The topic's clearances a topic-wide check with this pattern passes: those whose column it matches. */
const budgetCleared = (pattern) => (BUDGET.cleared || []).filter((c) => pattern.test(c.column)).map((c) => ({ ...c }));
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
    topic: 'budget',
    where: { sources: [EXP], scope: 'spending lines of units with Forestry in their name', area: 'citywide' },
    questions: [
      {
        qid: 'q1',
        text: 'How much does the City spend on street-tree work each year?',
        blocks: 'part',
        answered_in_part_by: [{ dataset: EXP.id, column: 'unit_name' }, { dataset: WO.id, column: 'total_cost' }],
      },
    ],
    actions: ['a-budget-proposal-activity', 'a-budget-meeting-forestry'],
    // A query of the Park and Forestry Operations unit by name, or of units
    // with Forestry in their name (this entry's own where clause).
    touches: [{ dataset: EXP.id, where_includes: [PFO] }, { dataset: EXP.id, where_includes: ['FOREST'] }],
    bites_when: [],
    // The City's book calls Park and Forestry Operations itself a program, so
    // the missing breakdown is an activity or service below the unit.
    closed_when: { column_present: '/activit|service|task|forest|tree/', null_share_at_most: 0.05 },
    concepts: { activity: { pattern: /activit|service|task|forest|tree/i, datasets: [EXP.id] } },
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
      const k = this.concepts.activity;
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
          T.columnsAbsent({ concept: 'for an activity or service within a unit', count: cols.datasets[EXP.id], source: EXP, read: cread }),
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
    topic: 'budget',
    where: { sources: [EXP, REV, { type: 'catalog', id: 'data.norfolk.gov' }], scope: 'fiscal years in the open spending and revenue records', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'How has Parks and Recreation spending changed over the last ten years?', blocks: 'part', answered_in_part_by: [{ dataset: EXP.id, column: 'fiscal_year' }] },
      { qid: 'q2', text: "How has the City's revenue from fees and taxes changed over the last ten years?", blocks: 'part', answered_in_part_by: [{ dataset: REV.id, column: 'fiscal_year' }] },
    ],
    actions: ['a-budget-proposal-years', 'a-budget-meeting-years'],
    // Any read of either dataset: every budget answer stands on these years.
    touches: [{ dataset: EXP.id }, { dataset: REV.id }],
    bites_when: [],
    // A re-measure closes it: the share is the fiscal years of the last ten
    // (ending with the latest held) that either dataset leaves out.
    closed_when: { share_at_most: 0, over: 'whole' },
    // The span the questions ask about.
    span: 10,
    search: 'budget',
    // A catalog hit named like these may hold earlier years: a reviewer looks.
    earlierNames: /expenditure|revenue|spending/i,
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
      'I found capital plans for earlier years beside the current one in the catalog search “budget” (the evidence names them), searched 2026-11-06; they hold capital projects, not spending lines or revenue, so the entry leaves them out of its years.',
      'The spec’s kinds table asks a partial_coverage entry for a share over a bundled index or a verified finding, and this one carries a share over the years read from the two datasets: a difference for Jason to rule on.',
    ].join(' '),
    sources: [{ title: "The City's FY2027 budget book, department budgets", url: BOOK, pages: 'PDF page 173 (printed page 297)', opened: '2026-11-06' }],
    async measure(h) {
      const exp = await distinct(h, EXP.id, 'fiscal_year IS NOT NULL', 'fiscal_year', 'fiscal years in Annual Expenditures');
      const rev = await distinct(h, REV.id, 'fiscal_year IS NOT NULL', 'fiscal_year', 'fiscal years in Annual Revenues');
      const qe = await h.run.descriptionQuote(EXP.id, this.quotes[EXP.id]);
      const qr = await h.run.descriptionQuote(REV.id, this.quotes[REV.id]);
      const fd = await h.run.fieldDescription(EXP.id, 'actual_expenses');
      const cat = await h.run.catalogSearch(this.search);
      const years = (v) => [...v.values].sort();
      const ey = years(exp);
      const ry = years(rev);
      if (!ey.length || !ry.length) throw new MeasureChange('No fiscal year read.');
      if ([...ey, ...ry].some((y) => !/^\d{4}$/.test(y))) throw new MeasureChange('A fiscal year reads as something other than a year.');
      const earlier = cat.results.filter((r) => r.id !== EXP.id && r.id !== REV.id && this.earlierNames.test(r.name));
      if (earlier.length) throw new MeasureChange(`The catalog search “${this.search}” now names ${earlier.map((r) => r.name).join(', ')}; a reviewer looks before this gap is shown again.`);
      const read = h.dateOf(exp.read);
      const yearsText = (ys) => (ys.length <= 1 ? fy(ys[0]) : `${ys.slice(0, -1).map(fy).join(', ')} and ${fy(ys.at(-1))}`);
      const same = ey.join() === ry.join();
      // The last ten fiscal years, ending with the latest either dataset holds.
      const hi = Math.max(Number(ey.at(-1)), Number(ry.at(-1)));
      const lo = hi - this.span + 1;
      const inSpan = (ys) => new Set(ys.map(Number).filter((y) => y >= lo && y <= hi));
      const es = inSpan(ey);
      const both = [...inSpan(ry)].filter((y) => es.has(y)).length;
      const part = this.span - both;
      const sread = h.dateOf(cat.read);
      return {
        how_much: {
          part,
          whole: this.span,
          read: exp.read > rev.read ? exp.read : rev.read,
          values: { dataset: EXP.id, field: 'fiscal_year', count: ey.length, matched: ey, read: exp.read },
          quote: { dataset: EXP.id, text: qe.quote, read: qe.read },
          published: { rows_updated: qe.updated, read: qe.read },
          catalog: [{ q: cat.q, result_set_size: cat.result_set_size, open_to_siren: cat.results.filter((r) => r.open_to_siren).map((r) => ({ id: r.id, name: r.name })), read: cat.read }],
        },
        evidence: [valuesEv(exp, /^\d{4}$/, ey), valuesEv(rev, /^\d{4}$/, ry), h.ev.metadata(qe, { quote: qe.quote }), h.ev.metadata(qr, { quote: qr.quote }), h.ev.field(fd), h.ev.catalog(cat)],
        statement: [
          `I found fiscal years ${yearsText(ey)} in ${sourceName(EXP)}, and ${same ? 'the same years' : `fiscal years ${yearsText(ry)}`} in ${sourceName(REV)}, as I read them on ${read}.`,
          `Of the ${fmt(this.span)} fiscal years ${fy(lo)} through ${fy(hi)}, I found ${fmt(both)} in both datasets, as I read them on ${read}.`,
          descriptionSays({ name: 'Annual Expenditures', id: EXP.id, read: h.dateOf(qe.read), quote: qe.quote }),
          descriptionSays({ name: 'Annual Revenues', id: REV.id, read: h.dateOf(qr.read), quote: qr.quote }),
          fieldSays({ owner: 'The Annual Expenditures', field: 'actual_expenses', quote: fd.quote }),
          `I found ${plural(cat.result_set_size, 'dataset', 'datasets')} in Norfolk's open data catalog for the search “${cat.q}”, and none besides these two named for expenditures, revenues or spending (searched ${sread}).`,
        ].join(' '),
        short: `I found fiscal years ${fy(ey[0])} through ${fy(ey.at(-1))} in the City's Annual Expenditures, and ${fy(ry[0])} through ${fy(ry.at(-1))} in its Annual Revenues, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({ source: EXP, finding: `I found ${fmt(ey.length)} fiscal years in them, ${fy(ey[0])} through ${fy(ey.at(-1))}`, measured: read, tail: `so I can show those years only, with ${fy(ey.at(-1))} spending to date` }),
          q2: T.consequencePart({ source: REV, finding: `I found ${fmt(ry.length)} fiscal years in them, ${fy(ry[0])} through ${fy(ry.at(-1))}`, measured: read, tail: `so I can show those years only, with ${fy(ry.at(-1))} collections to date` }),
        },
        closing: part === 0,
      };
    },
  },

  {
    id: 'norfolk.budget.contractual-no-link',
    proposed: true,
    kind: 'missing_field',
    title: 'No field linking spending lines to a contract or work order (Annual Expenditures)',
    checked_live: '2026-11-06',
    topic: 'budget',
    related: ['norfolk.work-orders.no-contract-link'],
    where: { sources: [EXP, { type: 'catalog', id: 'data.norfolk.gov' }], scope: 'spending lines', area: 'citywide' },
    // Which tree work the line paid for is the work-order side, half-answered
    // there by contractor_cost: the linked approved entry carries it.
    questions: [{ qid: 'q1', text: 'Which contracts did the City pay from the Park and Forestry Operations contractual services line last year?', blocks: 'all', concept: 'link' }],
    actions: ['a-budget-proposal-contract-number', 'a-budget-meeting-contracts', 'a-budget-foia-contracts'],
    touches: [{ dataset: EXP.id, where_includes: [PFO] }],
    bites_when: [],
    closed_when: { column_present: '/vendor|payee|supplier|contract|invoice|purchase|work_?order|(^|_)po(_|$)/', null_share_at_most: 0.05 },
    // Checked over every budget dataset: the question can't be answered from any of them.
    concepts: { link: { pattern: /vendor|payee|supplier|contract|invoice|purchase|work_?order|(^|_)po(_|$)/i, datasets: BUDGET.datasets } },
    // The line the question names, for the last whole fiscal year.
    year: 2026,
    searches: ['checkbook', 'vendor', 'contract', 'purchase order'],
    // A catalog hit with a name like these may be the missing link: a reviewer looks.
    linkNames: /vendor|payment|contract|checkbook|purchas|invoice|spend/i,
    why: [
      'The line “Other Contractual Services” records an amount and a budget for a unit and a year.',
      'I found no column in Annual Expenditures, or in any other dataset of the budget topic, that ties a line to a contract, a purchase order or a work order, so the work an amount paid for stays out of these records.',
      'The entry describes that missing link, and claims nothing about whether any payment was right.',
      'The work-order side, with its contractor cost, is an approved catalog entry, linked from this one, and this entry measures only the budget topic’s datasets and the catalog.',
    ].join(' '),
    context: [
      'The request gave this line’s actual expenses and budget for FY2026, and the statement leaves both out.',
      'I found no amount measure in the measure menu, checked 2026-11-06, and the shape of the gap is the missing column, which needs no amount.',
      'The dataset’s description, as I read it on 2026-11-06, says: “Expenditures will reflect the previous fiscal year’s activity until final entries have been made and the accounting period has been closed.”',
    ].join(' '),
    async measure(h) {
      const k = this.concepts.link;
      const cols = await h.run.columnsAbsent({ datasets: k.datasets, pattern: k.pattern, cleared: budgetCleared(k.pattern) });
      const where = `unit_name = '${PFO}' AND ${CONTRACTUAL} AND fiscal_year = ${this.year}`;
      const one = await h.run.query(EXP.id, soql.share(where, {}), `${PFO}: contractual services lines, FY${this.year}`);
      const lines = num(one.rows[0], 'whole');
      if (!lines) throw new MeasureChange(`No line matches ${where}.`);
      const searches = [];
      for (const q of this.searches) searches.push(await h.run.catalogSearch(q));
      const named = searches.flatMap((s) => s.results).filter((r) => this.linkNames.test(r.name));
      if (named.length) throw new MeasureChange(`The catalog now names ${named.map((r) => r.name).join(', ')}; a reviewer looks before this gap is shown again.`);
      const read = h.dateOf(cols.read);
      const lread = h.dateOf(one.read);
      const sread = h.dateOf(searches[0].read);
      const concept = 'naming a vendor, contract, invoice, purchase order or work order';
      return {
        how_much: {
          columns_absent: cols,
          catalog: searches.map((s) => ({ q: s.q, result_set_size: s.result_set_size, open_to_siren: s.results.filter((r) => r.open_to_siren).map((r) => ({ id: r.id, name: r.name })), read: s.read })),
        },
        evidence: [...metadataEv(h, k.datasets), h.ev.query(one), ...searches.map(h.ev.catalog)],
        statement: [
          T.columnsAbsentTopic({ concept, datasets: k.datasets, topic: 'budget', read }),
          `Under “${PFO}”, I found ${plural(lines, 'line', 'lines')} named “Other Contractual Services” for ${fy(this.year)}, as I read them on ${lread}.`,
          catalogLine(searches, sread),
        ].join(' '),
        short: `I found no column tying a spending line to a vendor, contract, purchase order or work order in any of the ${fmt(k.datasets.length)} budget datasets I read, measured ${read}.`,
        consequences: { q1: T.consequenceAll({ concept, datasets: k.datasets, topic: 'budget', measured: read }) },
      };
    },
  },

  {
    id: 'norfolk.budget.no-pruning-measure',
    proposed: true,
    kind: 'no_records',
    title: 'Street-tree pruning in the performance measures checked',
    checked_live: '2026-11-06',
    topic: 'budget',
    where: { sources: [PM, WO, { type: 'catalog', id: 'data.norfolk.gov' }], scope: 'performance measures', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'What share of street-tree pruning requests does the City fulfill each year?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'primary_task_description' }, { dataset: WO.id, column: 'status_description' }] },
    ],
    actions: ['a-budget-proposal-pruning-measure', 'a-budget-meeting-pruning-measure'],
    // A Forestry query of the performance measures or of the pruning work
    // orders; and a cite of the trees case file, which holds the finding this
    // entry quotes (the cite also feeds the builder's laundering check its
    // not-yet-verified claims).
    touches: [{ dataset: PM.id, where_includes: ['Forestry'] }, { dataset: WO.id, where_includes: [WO_FORESTRY, "'Pruning'"] }, { case: 'norfolk-trees' }],
    bites_when: [],
    closed_when: { finding: true },
    prune: /prun|trim/i,
    searches: ['pruning', 'performance'],
    why: [
      'The City’s FY2024 adopted budget names a measure for street-tree pruning requests fulfilled, by the quote the case file checked.',
      'I found no pruning or trimming measure in the open Performance Measures records, and the catalog searches I ran name no other measures dataset, so the question stays open in these records.',
      'The entry reports what the dataset holds, and claims nothing about the City’s pruning work or about why a measure is published or left out.',
    ].join(' '),
    context: [
      'The request cited the FY2024 book’s pruning percentages and target from the case file.',
      'That finding’s checked quote holds only the measure’s name, “Percent of street tree pruning requests fulfilled”, so only the name enters this entry, and the percentages and the target stay out.',
      'The case file’s measure-dropped finding is unverified, so it is not cited.',
      'The trees-planted measure, with its empty year columns, is its own proposed entry.',
    ].join(' '),
    async measure(h) {
      const all = await h.run.query(PM.id, soql.share('measure_id IS NOT NULL', { prune: "upper(measure_description) like '%PRUN%'", trim: "upper(measure_description) like '%TRIM%'" }), 'performance measures naming pruning or trimming');
      const whole = num(all.rows[0], 'whole');
      const prune = num(all.rows[0], 'prune');
      const trim = num(all.rows[0], 'trim');
      if (prune || trim) throw new MeasureChange(`${plural(prune + trim, 'measure now names', 'measures now name')} pruning or trimming; the gap may be closing, and a reviewer looks.`);
      const pfo = await h.run.valuesAbsent({ dataset: PM.id, field: 'measure_description', where: PM_PFO, pattern: this.prune });
      if (pfo.matched.length) throw new MeasureChange(`A ${PFO} measure now names pruning: ${pfo.matched.join(', ')}.`);
      const searches = [];
      for (const q of this.searches) searches.push(await h.run.catalogSearch(q));
      const other = searches.flatMap((s) => s.results).filter((r) => r.id !== PM.id && /measure|performance|metric/i.test(r.name));
      if (other.length) throw new MeasureChange(`The catalog now names ${other.map((r) => r.name).join(', ')}; a reviewer looks before this gap is shown again.`);
      const sb = await h.run.query(WO.id, soql.breakdown(WO_PRUNING, ['status_code', 'status_description'], {}), 'Forestry pruning work orders by status');
      const done = sb.rows.find((x) => Number(x.status_code) === COMPLETE.code);
      if (!done || done.status_description !== COMPLETE.as_recorded) throw new MeasureChange(`Status ${COMPLETE.code} is no longer recorded as “${COMPLETE.as_recorded}” on Forestry pruning work orders.`);
      const npr = sb.rows.reduce((t, x) => t + num(x, 'whole'), 0);
      const ndone = num(done, 'whole');
      const f = h.finding('norfolk-trees', 'pruning-requests-fulfilled');
      const read = h.dateOf(all.read);
      const pread = h.dateOf(pfo.read);
      const tread = h.dateOf(sb.read);
      const sread = h.dateOf(searches[0].read);
      return {
        how_much: {
          part: prune + trim,
          whole,
          read: all.read,
          values: { dataset: PM.id, field: 'measure_description', count: pfo.values.length, matched: [], read: pfo.read },
          catalog: searches.map((s) => ({ q: s.q, result_set_size: s.result_set_size, open_to_siren: s.results.filter((r) => r.open_to_siren).map((r) => ({ id: r.id, name: r.name })), read: s.read })),
        },
        evidence: [h.ev.query(all), h.ev.values(pfo), ...searches.map(h.ev.catalog), h.ev.query(sb), h.ev.finding(f)],
        statement: [
          `Of ${fmt(whole)} measures in ${sourceName(PM)}, I found none with a description naming pruning or trimming, as I read them on ${read}.`,
          `Under the program “${PFO}” I found ${plural(pfo.values.length, 'measure', 'measures')}, ${quoted(pfo.values)}, as I read them on ${pread}.`,
          catalogLine(searches, sread),
          T.findingQuote({ who: "The City's FY2024 adopted budget", quote: f.quote, checked: f.checked }),
          `I found the task “Pruning” on ${fmt(npr)} Forestry work orders in ${sourceName(WO)}, ${fmt(ndone)} of them with status “${COMPLETE.as_recorded}”, as I read them on ${tread}.`,
        ].join(' '),
        short: `Of ${fmt(whole)} measures in the City's Performance Measures, I found none naming pruning or trimming, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({
            source: WO,
            finding: `I found the task “Pruning” on ${fmt(npr)} Forestry work orders, ${fmt(ndone)} of them with status “${COMPLETE.as_recorded}”`,
            measured: tread,
            tail: 'which counts work orders and their status as the City records it, not requests, and I found no pruning measure in the Performance Measures records',
          }),
        },
      };
    },
  },

  {
    id: 'norfolk.budget.trees-planted-no-yearly-values',
    proposed: true,
    kind: 'missing_field',
    title: 'Trees-planted measure with empty year columns (Performance Measures)',
    checked_live: '2026-11-06',
    topic: 'budget',
    where: { sources: [PM, WO], scope: `the measure “${PLANTED}” under the program “${PFO}”`, area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'How many trees did the City plant in each of the last four fiscal years?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'primary_task_description' }] },
    ],
    actions: ['a-budget-proposal-planted-values', 'a-budget-meeting-planted-values'],
    touches: [{ dataset: PM.id, where_includes: ['Forestry'] }, { dataset: WO.id, where_includes: [WO_FORESTRY, "'Plantings'"] }],
    bites_when: [],
    // A re-measure closes it: every year column on the measure holds a value.
    closed_when: { share_at_most: 0, over: 'whole' },
    why: [
      'The Performance Measures records carry a measure for trees planted, with a column for each fiscal year.',
      'I found each of its year columns empty, so how many trees were planted in a year stays out of these records.',
      'The entry reports the empty columns, and claims nothing about how many trees the City planted.',
    ].join(' '),
    context: 'The measure’s projection and target columns hold values, but they are a forecast and a goal, not a count for a year gone by, so the entry names neither as a half-answer.',
    async measure(h) {
      const pfo = await distinct(h, PM.id, PM_PFO, 'measure_description', `${PFO} measures`);
      if (!pfo.values.includes(PLANTED)) throw new MeasureChange(`“${PLANTED}” is no longer a ${PFO} measure.`);
      const flags = Object.fromEntries(PM_ACTUALS.map((c) => [`no_${c}`, `${c} IS NULL`]));
      const planted = await h.run.query(PM.id, soql.share(`${PM_PFO} AND measure_description = '${PLANTED}'`, flags), 'trees planted: empty year columns');
      const row = planted.rows[0];
      if (num(row, 'whole') !== 1) throw new MeasureChange(`“${PLANTED}” is ${num(row, 'whole')} rows, not 1.`);
      const empty = PM_ACTUALS.filter((c) => num(row, `no_${c}`) === 1);
      const tasks = await h.run.query(WO.id, soql.values(WO_FORESTRY, 'primary_task_description'), 'Forestry tasks');
      const plantings = tasks.rows.find((x) => x.v === 'Plantings');
      if (!plantings) throw new MeasureChange('The Forestry task “Plantings” is no longer recorded.');
      const nplant = num(plantings, 'n');
      const pread = h.dateOf(planted.read);
      const tread = h.dateOf(tasks.read);
      const yearOf = (c) => fy(c.slice(3));
      const years = `${yearOf(PM_ACTUALS[0])} through ${yearOf(PM_ACTUALS.at(-1))}`;
      const emptyText = empty.length === PM_ACTUALS.length ? `all ${fmt(empty.length)}` : empty.length ? `${fmt(empty.length)} (${empty.map(yearOf).join(', ')})` : 'none';
      return {
        how_much: { part: empty.length, whole: PM_ACTUALS.length, read: planted.read },
        evidence: [valuesEv(pfo, `/^${PLANTED}$/`, [PLANTED]), h.ev.query(planted), h.ev.query(tasks)],
        statement: [
          `Under the program “${PFO}” in ${sourceName(PM)}, I found the measure “${PLANTED}”, and of its ${fmt(PM_ACTUALS.length)} fiscal-year value columns, ${years}, I found ${emptyText} empty, as I read them on ${pread}.`,
          `I found the task “Plantings” on ${fmt(nplant)} Forestry work orders in ${sourceName(WO)}, as I read them on ${tread}.`,
        ].join(' '),
        short: `I found ${fmt(empty.length)} of ${fmt(PM_ACTUALS.length)} year columns empty on the trees-planted measure in the City's Performance Measures, measured ${pread}.`,
        consequences: {
          q1: T.consequencePart({
            source: WO,
            finding: `I found the task “Plantings” on ${fmt(nplant)} Forestry work orders`,
            measured: tread,
            tail: `which counts orders, not trees, and I found ${fmt(empty.length)} of the ${fmt(PM_ACTUALS.length)} year columns for “${PLANTED}” empty in the Performance Measures records, measured ${pread}`,
          }),
        },
        closing: empty.length === 0,
      };
    },
  },

  {
    id: 'norfolk.budget.cip-no-ward',
    proposed: true,
    kind: 'missing_field',
    title: 'Capital projects with no ward or coordinates (adopted capital plan)',
    checked_live: '2026-11-06',
    topic: 'budget',
    where: { sources: [CIP], scope: 'projects in the adopted capital plan', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'Which capital projects in the adopted plan are in my ward?', blocks: 'part', answered_in_part_by: [{ dataset: CIP.id, column: 'ward' }, { dataset: CIP.id, column: 'location' }] },
      { qid: 'q2', text: 'Which planned capital projects are near me?', blocks: 'part', answered_in_part_by: [{ dataset: CIP.id, column: 'latitude' }, { dataset: CIP.id, column: 'longitude' }, { dataset: CIP.id, column: 'location' }] },
    ],
    actions: ['a-budget-proposal-cip-place', 'a-budget-meeting-cip-place'],
    // Any read of the plan: the ward and coordinates are dataset-wide.
    touches: [{ dataset: CIP.id }],
    bites_when: [],
    closed_when: { share_at_most: 0.05, over: 'whole' },
    why: [
      'I found capital projects with no ward and no coordinates in these records, and a search by ward or by distance leaves them out.',
      'The entry counts those rows, and claims nothing about whether a project has a site.',
      'The location column is free text, and the identifier rule keeps a measure from reading it, so I can’t count from code how many of these name a site, several places or the whole city.',
    ].join(' '),
    context: [
      'The request gave a count of projects with no ward from a read on 2026-11-06, and I found the same count when I measured it again.',
      'In a reviewer read outside the trace, as I read them on 2026-11-06, I found “Citywide” in the location text of several projects with no ward, and in others text naming facilities across the city, several wards, or sites outside the city.',
      'That read is context for Jason, not evidence on the board.',
    ].join(' '),
    async measure(h) {
      const r = await h.run.query(
        CIP.id,
        soql.share('project_id IS NOT NULL', {
          no_ward: 'ward IS NULL',
          no_coord: 'latitude IS NULL OR longitude IS NULL',
          neither: 'ward IS NULL AND (latitude IS NULL OR longitude IS NULL)',
          no_loc: 'location IS NULL',
          no_ward_no_loc: 'ward IS NULL AND location IS NULL',
          no_coord_no_loc: '(latitude IS NULL OR longitude IS NULL) AND location IS NULL',
        }),
        'capital projects with no ward or coordinates'
      );
      const fl = await h.run.fieldDescription(CIP.id, 'location');
      const row = r.rows[0];
      const whole = num(row, 'whole');
      const part = num(row, 'no_ward');
      const coord = num(row, 'no_coord');
      const neither = num(row, 'neither');
      const noLoc = num(row, 'no_loc');
      const wardLoc = part - num(row, 'no_ward_no_loc');
      const coordLoc = coord - num(row, 'no_coord_no_loc');
      const read = h.dateOf(r.read);
      return {
        how_much: { part, whole, read: r.read },
        evidence: [h.ev.query(r), h.ev.field(fl)],
        statement: [
          T.share({ part, whole, scope: 'projects', absent: 'with no ward', source: CIP, read }),
          `Of the same ${fmt(whole)}, I found ${fmt(coord)} with no latitude or longitude, ${fmt(neither)} of them with no ward either, as I read them on ${read}.`,
          `Of the same ${fmt(whole)}, I found ${fmt(noLoc)} with the free-text location field empty, as I read them on ${read}.`,
          fieldSays({ field: 'location', quote: fl.quote }),
        ].join(' '),
        short: `I found ${fmt(part)} of ${fmt(whole)} projects (${pct(part, whole)}%) with no ward in the City's adopted Capital Improvement Plan data, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({ source: CIP, finding: `I found ${fmt(part)} of ${fmt(whole)} projects (${pct(part, whole)}%) with no ward`, measured: read, tail: `so a search by ward can't find them, and I found the free-text location field filled on ${fmt(wardLoc)} of those ${fmt(part)}, which I can read but can't search by ward` }),
          q2: T.consequencePart({ source: CIP, finding: `I found ${fmt(coord)} of ${fmt(whole)} projects (${pct(coord, whole)}%) with no latitude or longitude`, measured: read, tail: `so a search by distance can't find them, and I found the free-text location field filled on ${fmt(coordLoc)} of those ${fmt(coord)}, which I can read but can't search by distance` }),
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
    topic: 'budget',
    where: { sources: [REV, EXP], scope: `units under ${PARKS_DEPT}, by fiscal year`, area: 'citywide' },
    questions: [
      {
        qid: 'q1',
        text: "How much of a Parks and Recreation program's cost do its own fees and charges cover?",
        blocks: 'part',
        answered_in_part_by: [{ dataset: REV.id, column: 'unit_name' }, { dataset: EXP.id, column: 'unit_name' }],
      },
    ],
    actions: ['a-budget-proposal-crosswalk', 'a-budget-meeting-crosswalk'],
    // A revenue query scoped to the department (its name holds this phrase).
    touches: [{ dataset: REV.id, where_includes: ['Parks & Recreation'] }],
    bites_when: [],
    closed_when: { share_at_most: 0, over: 'whole' },
    why: [
      'Setting a program’s revenue against its cost from these records takes the same unit in both datasets, in the same fiscal year.',
      'I found every department name shared between them, and under Parks and Recreation I found revenue units with names that match no spending unit of the same year, so that revenue has no cost to sit beside in these records.',
      'The entry reports the names as recorded, and claims nothing about how the City budgets the program.',
    ].join(' '),
    context: [
      'The request was citywide: revenue and spending units that differ.',
      'I found the department names all matching, so the entry narrows to the unit names under Parks and Recreation, compared year by year, since the units differ from one fiscal year to the next.',
      'I can’t measure a citywide comparison of unit names with the menu: the unit names in Annual Expenditures pass the values measure’s cap, by an exploratory read outside the trace on 2026-11-06.',
      'The spec’s kinds table asks a partial_coverage entry for a share over a bundled index or a verified finding, and this one carries a share over the units read from the two datasets: a difference for Jason to rule on.',
    ].join(' '),
    async measure(h) {
      const ed = await distinct(h, EXP.id, 'department_name IS NOT NULL', 'department_name', 'department names in Annual Expenditures');
      const rd = await distinct(h, REV.id, 'department_name IS NOT NULL', 'department_name', 'department names in Annual Revenues');
      const ru = await h.run.query(REV.id, soql.breakdown(PARKS, ['fiscal_year', 'unit_name'], {}), 'Parks and Recreation revenue units by fiscal year');
      const eu = await h.run.query(EXP.id, soql.breakdown(PARKS, ['fiscal_year', 'unit_name'], {}), 'Parks and Recreation spending units by fiscal year');
      const byYear = (r) => {
        const m = new Map();
        for (const x of r.rows) if (x.fiscal_year != null && x.unit_name != null) m.set(String(x.fiscal_year), [...(m.get(String(x.fiscal_year)) || []), String(x.unit_name)]);
        return m;
      };
      const ry = byYear(ru);
      const ey = byYear(eu);
      if (!ry.size || !ey.size) throw new MeasureChange(`No units under ${PARKS_DEPT}.`);
      const years = [...ry.keys()].sort();
      const series = years.map((y) => {
        const spend = new Set(ey.get(y) || []);
        const units = [...ry.get(y)].sort();
        const unmatched = units.filter((u) => !spend.has(u));
        return { k: y, part: unmatched.length, whole: units.length, unmatched, spending: spend.size };
      });
      const latest = series.at(-1);
      const edSet = new Set(ed.values);
      const shared = rd.values.filter((d) => edSet.has(d)).length;
      const read = h.dateOf(ru.read > eu.read ? ru.read : eu.read);
      const dread = h.dateOf(rd.read);
      const deptLine =
        shared === rd.values.length
          ? `I found all ${fmt(rd.values.length)} department names in ${sourceName(REV)} also in ${sourceName(EXP)}, as I read them on ${dread}.`
          : `Of ${fmt(rd.values.length)} department names in ${sourceName(REV)}, I found ${fmt(shared)} also in ${sourceName(EXP)}, as I read them on ${dread}.`;
      const yearLine = (x) =>
        `For ${fy(x.k)}, under “${PARKS_DEPT}”, I found ${plural(x.whole, 'revenue unit', 'revenue units')} and ${plural(x.spending, 'spending unit', 'spending units')}, ${x.part ? `with ${fmt(x.part)} of the revenue units matching no spending unit of the same name, ${quoted(x.unmatched)}` : 'with every revenue unit matching a spending unit of the same name'}, as I read them on ${read}.`;
      return {
        how_much: { part: latest.part, whole: latest.whole, read: ru.read, series: series.map(({ k, part, whole }) => ({ k, part, whole })) },
        evidence: [h.ev.query(ed), h.ev.query(rd), h.ev.query(ru), h.ev.query(eu)],
        statement: [
          deptLine,
          ...series.map(yearLine),
        ].join(' '),
        short: `Under Parks and Recreation, for ${fy(latest.k)}, I found ${fmt(latest.part)} of ${fmt(latest.whole)} revenue units with no spending unit of the same name in the City's budget records, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({
            source: REV,
            finding: `for ${fy(latest.k)}, I found ${fmt(latest.part)} of ${fmt(latest.whole)} Parks and Recreation revenue units${latest.part ? `, ${quoted(latest.unmatched)},` : ''} with no spending unit of the same name in Annual Expenditures`,
            measured: read,
            tail: "so I can't set that revenue against a cost",
          }),
        },
        closing: latest.part === 0,
      };
    },
  },

  {
    id: 'norfolk.budget.no-amendment-history',
    proposed: true,
    kind: 'missing_field',
    title: 'No adopted amount or amendment date beside the current budget (Annual Expenditures)',
    checked_live: '2026-11-06',
    topic: 'budget',
    where: { sources: [EXP, { type: 'index', id: INDEX.id, name: INDEX.name }], scope: 'spending lines', area: 'citywide' },
    questions: [
      { qid: 'q1', text: "What operating budget did the City Council adopt for a department, before any amendments this year?", blocks: 'all', concept: 'amend' },
      { qid: 'q2', text: "When during the year was a department's budget changed, and by how much?", blocks: 'part', answered_in_part_by: [{ index: INDEX.id, field: 'text' }] },
    ],
    actions: ['a-budget-proposal-amendments', 'a-budget-meeting-amendments'],
    // Any read of the spending records: the missing columns are dataset-wide.
    touches: [{ dataset: EXP.id }],
    bites_when: [],
    closed_when: { column_present: '/adopt|original|amend|transfer|revis|prior|(^|_)date|modif|effective/', null_share_at_most: 0.05 },
    // Checked over every budget dataset; the topic's clearances set aside the
    // capital plans' adopted amounts and a projected measure value.
    concepts: { amend: { pattern: /adopt|original|amend|transfer|revis|prior|(^|_)date|modif|effective/i, datasets: BUDGET.datasets } },
    quote: [
      'The data also contains current budget information.',
      'Current budget reflects budget transfers and amendments during the fiscal year that have transpired since City Council adopted the budget prior to the beginning of the current fiscal year.',
    ],
    amendTitle: AMEND_TITLE,
    why: [
      'The dataset’s own description says its budget figure reflects transfers and amendments made since adoption.',
      'I found one budget column and no column for the adopted amount, an amendment or its date, and none in the other datasets of the budget topic apart from columns a reviewer cleared as capital plan amounts or a projected measure value, so how an operating budget changed during the year stays out of these records.',
      'Siren’s agenda index holds the titles of the Council ordinances that amend the annual appropriations, by meeting date, so the question of when a budget changed is answered there in part, ordinance by ordinance, and not line by line.',
      'The entry reports the columns and the titles, and claims nothing about whether or how often an amendment happened outside them.',
    ].join(' '),
    context: [
      'Annual Revenues describes its budget as the one adopted by City Council ahead of each fiscal year, so this entry covers the spending side only.',
      'The adopted capital plan (6tqj-4az3) carries adopted amounts for capital projects by department, so the first question asks about the operating budget, which among the datasets read only Annual Expenditures holds.',
      'I found no amount for a department in the titles of the adopting ordinances in the agenda index, as I read them on 2026-11-06.',
    ].join(' '),
    async measure(h) {
      const q = await h.run.descriptionQuote(EXP.id, this.quote);
      const fd = await h.run.fieldDescription(EXP.id, 'current_expense_budget');
      const k = this.concepts.amend;
      const cols = await h.run.columnsAbsent({ datasets: k.datasets, pattern: k.pattern, cleared: budgetCleared(k.pattern) });
      const idx = h.index(INDEX.id);
      const items = idx.items || [];
      const amending = items.filter((i) => this.amendTitle.test(String(i.text || '')));
      if (!amending.length) throw new MeasureChange(`No agenda item in ${INDEX.id} matches ${this.amendTitle}.`);
      const dates = amending.flatMap((i) => (i.meetings || []).map((m) => m.date)).filter(Boolean).sort();
      const built = String(idx.built).slice(0, 10);
      const read = h.dateOf(cols.read);
      const n = cols.datasets[EXP.id];
      const concept = 'for an adopted operating budget amount, an amendment or transfer, or a date it took effect';
      const cl = cols.siblings_cleared;
      const clearedLine = cl.length
        ? `I found ${plural(cl.length, 'more column', 'more columns')} matching it that a reviewer cleared as holding something else (${cl.map((c) => `${c.dataset} ${c.column}`).join(', ')}), each with its reason in the record, as I read them on ${read}.`
        : '';
      const indexLine = `I found ${fmt(amending.length)} of ${fmt(items.length)} agenda items in ${INDEX.phrase} (built ${built}) with titles amending an annual appropriations ordinance or annual budget, at meetings ${dates[0]} through ${dates.at(-1)}, counted ${h.repoToday}.`;
      return {
        how_much: { columns_absent: cols, quote: { dataset: EXP.id, text: q.quote, read: q.read }, published: { rows_updated: q.updated, read: q.read } },
        evidence: [h.ev.metadata(q, { quote: q.quote }), h.ev.field(fd), ...metadataEv(h, k.datasets), { type: 'index', file: `data/${INDEX.id}.json`, built: idx.built, counted: amending.length, of: items.length }],
        statement: [
          descriptionSays({ name: 'Annual Expenditures', id: EXP.id, read: h.dateOf(q.read), quote: q.quote }),
          fieldSays({ field: 'current_expense_budget', quote: fd.quote }),
          T.columnsAbsentTopic({ concept, datasets: k.datasets, topic: 'budget', read }),
          clearedLine,
          indexLine,
        ]
          .filter(Boolean)
          .join(' '),
        short: `I found no column for an adopted operating budget amount or an amendment date in any of the ${fmt(k.datasets.length)} budget datasets I read, measured ${read}.`,
        consequences: {
          q1: T.consequenceAll({ concept, datasets: k.datasets, topic: 'budget', measured: read }),
          q2: T.consequencePart({
            source: INDEX,
            finding: `I found ${fmt(amending.length)} agenda items with titles amending an annual appropriations ordinance or annual budget, at meetings ${dates[0]} through ${dates.at(-1)}, in the index built ${built}`,
            measured: h.repoToday,
            tail: `which gives each ordinance's meeting date, not each budget line's change, and I found no column for an amendment or its date among the ${fmt(n)} columns of ${sourceName(EXP)}, measured ${read}`,
          }),
        },
      };
    },
  },
];

// What would close each proposed gap: drafts like the catalog's actions
// (docs/gaps.md §9). Siren drafts; people ask and propose. A records request
// waits for a case-file records_to_request entry, as the catalog's do.
export const ACTIONS = [
  { id: 'a-budget-proposal-activity', kind: 'dataset_proposal', text: 'Publish an activity or service field below the unit in Annual Expenditures, so spending on street trees can be read apart from the rest of its unit.' },
  { id: 'a-budget-meeting-forestry', kind: 'meeting_question', text: 'How much of the Park and Forestry Operations budget goes to street-tree work each year, and where is that recorded?' },
  { id: 'a-budget-proposal-years', kind: 'dataset_proposal', text: 'Publish earlier fiscal years of Annual Expenditures and Annual Revenues beside the current three.' },
  { id: 'a-budget-meeting-years', kind: 'meeting_question', text: 'Does the City plan to publish earlier fiscal years of its spending and revenue data, and where can residents read them now?' },
  { id: 'a-budget-proposal-contract-number', kind: 'dataset_proposal', text: 'Publish a contract or purchase order number on each Annual Expenditures line, so contractual spending can be tied to the work it paid for.' },
  { id: 'a-budget-meeting-contracts', kind: 'meeting_question', text: 'Which contracts does the Park and Forestry Operations line for other contractual services pay for, and where are they recorded?' },
  { id: 'a-budget-foia-contracts', kind: 'foia_draft', needs: 'a records_to_request entry for the contracts paid from the Park and Forestry Operations contractual services line, added to a case file by case-file PR' },
  { id: 'a-budget-proposal-pruning-measure', kind: 'dataset_proposal', text: 'Add street-tree pruning requests received and fulfilled to the Performance Measures dataset, with a value for each year.' },
  { id: 'a-budget-meeting-pruning-measure', kind: 'meeting_question', text: 'Does the City track the share of street-tree pruning requests it fulfills each year, and where can residents read it?' },
  { id: 'a-budget-proposal-planted-values', kind: 'dataset_proposal', text: 'Fill the yearly values of the trees-planted measure in the Performance Measures dataset.' },
  { id: 'a-budget-meeting-planted-values', kind: 'meeting_question', text: 'How many trees did the City plant in each fiscal year, and where can residents read the yearly counts?' },
  { id: 'a-budget-proposal-cip-place', kind: 'dataset_proposal', text: 'Give every project in the Capital Improvement Plan data a ward, or a citywide value in the ward field, and coordinates where it has a site.' },
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
  { candidate: '2. Three fiscal years in the open data', outcome: 'kept as norfolk.budget.three-fiscal-years', reason: 'The part about earlier years living only in the budget books is left out: the catalog search “budget” lists capital plans for earlier years, though none for spending lines or revenue, and the entry states only what the open records hold, with that search in its evidence.' },
  { candidate: '3. Contractual spending not tied to work', outcome: 'kept as norfolk.budget.contractual-no-link, spending side only', reason: 'The work-order side, where contractor cost half-answers which tree work was paid for, is an approved catalog entry, linked from this one; this entry keeps the contracts question only, and leaves the line’s amounts out of the statement.' },
  { candidate: '4. Pruning in the performance measures', outcome: 'split into norfolk.budget.no-pruning-measure and norfolk.budget.trees-planted-no-yearly-values', reason: 'The checked quote holds only the measure’s name, so the FY2021 through FY2023 percentages and the target stay out; the empty year columns of the trees-planted measure are a different gap, so they are their own entry.' },
  { candidate: '5. Capital projects with no ward', outcome: 'kept as norfolk.budget.cip-no-ward', reason: 'Measured live with coordinates and the location field too, and the count matches the one in the request; the free-text location half-answers both questions.' },
  { candidate: '6. Revenue and spending units', outcome: 'reshaped as norfolk.budget.parks-revenue-units', reason: 'I found every department name in Annual Revenues also in Annual Expenditures, so the mismatch is narrowed to unit names under Parks and Recreation, compared within each fiscal year, where I found it.' },
  { candidate: '7. Only the amended budget published', outcome: 'kept as norfolk.budget.no-amendment-history', reason: 'Scoped to Annual Expenditures, since its description says its budget reflects amendments, and Annual Revenues describes its budget as the adopted one; Siren’s agenda index holds the titles of the ordinances amending the annual appropriations, so the question of when a budget changed is answered there in part.' },
]);
