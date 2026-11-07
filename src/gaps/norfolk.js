// Norfolk's gap catalog, v1 (docs/gaps.md §4.1). Jason approved all 13
// entries on 2026-11-06 (J1). Titles, labels and questions are the spec's
// drafts (J24); the line-clearance actions are City-only (J17 default).
//
// Each entry is reviewed by PR and checked live (checked_live). Every number
// it shows comes from `measure`, which runs the fixed menu in
// src/gaps/measures.js at GENERIC access through the traced client; nothing
// here holds a typed number. Every where clause, pattern and flag is a
// constant below. A gap has a shape and consequences: no field holds a cause.
//
// Columns and status codes below were checked against data.norfolk.gov on
// 2026-11-06 (qzfe-wj25: 32 columns; cmvv-agyb: 13 data columns; jz6u-9g3c
// and u85v-sad9 read with them).

import { T, fmt, pct, quoteStatuses } from './kinds.js';
import { soql, num, MeasureChange, addDays, daysSince } from './measures.js';

export const CITY = 'norfolk';
export const CATALOG_NAME = 'gap catalog';

// --- Sources and scopes ---------------------------------------------------------
const WO = Object.freeze({ id: 'qzfe-wj25', name: 'Work Orders', phrase: "the City's Work Orders records" });
const INV = Object.freeze({ id: 'cmvv-agyb', name: 'City Tree Inventory', phrase: 'the City Tree Inventory', pronoun: 'it' });
const INDEX = Object.freeze({ id: 'norfolk-legislation', name: "Siren's agenda index", phrase: "Siren's agenda index" });

// Forestry removal work orders (W), and those the City records as “Complete” (C).
const W = "area = 'Forestry' AND primary_task_description = 'Removal'";
const COMPLETE = { field: 'status_code', values: [999], as_recorded: ['Complete'] };
const C = `${W} AND status_code = 999`;
const OPEN = { field: 'status_code', values: [2, 4], as_recorded: ['New Work Order', 'On-Going'] };
const W_OPEN = `${W} AND status_code in (2, 4)`;
const FORESTRY = "area = 'Forestry'";
// 364 inventory rows are labeled "PRIVATE TREES" (plugins/trees-on-my-block.js).
const CITY_TREE = "(common_name IS NULL OR common_name != 'PRIVATE TREES')";
const SCOPE = 'Forestry removal work orders';

/** Topics: the datasets a topic-wide check reads, and the catalog hits a reviewer placed outside it. */
export const TOPICS = Object.freeze({
  trees: {
    name: 'trees',
    datasets: ['cmvv-agyb', 'qzfe-wj25', 'jz6u-9g3c', 'u85v-sad9'],
    search: 'tree',
    // Each placement outside the topic quotes the dataset's description; the
    // builder reads it live and drops the topic's gaps if a sentence is gone.
    not_in_topic: [
      {
        id: 'mrv3-rcpc',
        quote: [
          "STORM, an acronym for System to Track, Organize, Record and Map, captures data collected by residents and city staff during and after inclement weather events.",
          'The app captures incidents such as flooded streets, damaged trees, disabled vehicles, downed cable lines, etc.',
        ],
        reason:
          'STORM records incidents reported during and after weather events, damaged trees among them. Those reports are not the City Tree Inventory’s records or Forestry work orders, so the topic-wide column checks leave STORM out.',
        placed: 'Placed outside the tree topic in the Inc 4 catalog PR; Jason approved the catalog, entries and placements, on 2026-11-06 (A16).',
      },
    ],
    checked_live: '2026-11-06',
  },
});
const TREE_DATASETS = TOPICS.trees.datasets;

// Who a finding's quote belongs to, as statements name it.
const SAYS = { 'contract-removal': "The City's FY2024 adopted budget", dominion: "Dominion Energy's page", 'no-citywide-assessment': "The Green Infrastructure Center's report" };

// --- Shared measures -------------------------------------------------------------

/** The status breakdown of Forestry removal work orders (docs/gaps.md §1.3). */
async function statusBreakdown(h) {
  const r = await h.run.query(WO.id, soql.breakdown(W, ['status_code', 'status_description'], { no_street: 'street IS NULL', cc: 'contractor_cost > 0', has_end: 'end_date IS NOT NULL' }), 'Forestry removals by status');
  const row = (code) => r.rows.find((x) => Number(x.status_code) === code);
  const check = (s) => {
    const rows = s.values.map(row);
    rows.forEach((x, i) => {
      if (!x || x.status_description !== s.as_recorded[i]) throw new MeasureChange(`Status ${s.values[i]} is no longer recorded as “${s.as_recorded[i]}”.`);
    });
    return rows;
  };
  const [c] = check(COMPLETE);
  const open = check(OPEN);
  const sum = (rows, k) => rows.reduce((t, x) => t + num(x, k), 0);
  return { r, c, open, openWhole: sum(open, 'whole'), openNoStreet: sum(open, 'no_street') };
}

/** Problem codes on Forestry work orders. */
const forestryProblems = (h) => h.run.query(WO.id, soql.values(FORESTRY, 'problem_description'), 'Forestry problem codes');

function columnsEvidence(h, cols, datasets) {
  return datasets.map((id) => {
    const d = h.run.describes.get(id);
    return h.ev.metadata(d, { columns: d.columns.length });
  });
}

// --- The entries ---------------------------------------------------------------------

export const GAPS = [
  {
    id: 'norfolk.work-orders.removal-no-street',
    kind: 'missing_field',
    title: 'Forestry removals with no street (Work Orders)',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [WO], scope: SCOPE, status: COMPLETE, area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'Was a city tree removed on my street?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'street' }] },
      { qid: 'q2', text: 'Is a tree removal logged for my street?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'street' }] },
      { qid: 'q3', text: 'Which streets had city tree removals last year?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'street' }] },
    ],
    actions: ['a-meeting-street', 'a-proposal-street', 'a-watch-street'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }, { case: 'norfolk-trees' }],
    bites_when: [{ tool: 'trees_on_my_block', field: 'on_your_street', ok: true }, { dataset: WO.id, where_includes: ["area = 'Forestry'", 'street ='] }, { absence: true }],
    closed_when: { share_at_most: 0.01, over: 'window' },
    async measure(h) {
      const sb = await statusBreakdown(h);
      const since = addDays(h.today, -365);
      const span = await h.run.query(WO.id, soql.span(C, ['created_datetime']), 'Complete removals: dates covered');
      const series = await h.run.query(WO.id, soql.series(C, 'created_datetime', { part: 'street IS NULL' }), 'Complete removals with no street, by year');
      const win = await h.run.query(WO.id, soql.window(C, 'created_datetime', since, null, { part: 'street IS NULL', no_loc: 'street IS NULL AND ward IS NULL AND civic_league IS NULL' }), 'Complete removals since a year ago');
      const part = num(sb.c, 'no_street');
      const whole = num(sb.c, 'whole');
      const w = win.rows[0];
      const from = String(span.rows[0].min_created_datetime).slice(0, 10);
      const through = String(span.rows[0].max_created_datetime).slice(0, 10);
      const read = h.dateOf(sb.r.read);
      const statement = [
        T.share({ part, whole, scope: SCOPE, status: COMPLETE.as_recorded, absent: 'with no street', source: WO, span: { from, through }, read }),
        T.windowLine({ whole: num(w, 'whole'), part: num(w, 'part'), status: COMPLETE.as_recorded, since, absent: 'no street', also: { part: num(w, 'no_loc'), absent: 'no ward or civic league' }, read: h.dateOf(win.read) }),
        T.statusLine({ whole: sb.openWhole, part: sb.openNoStreet, status: OPEN.as_recorded, absent: 'no street', read }),
      ].join(' ');
      const found = `I found ${fmt(part)} of ${fmt(whole)} ${SCOPE} with status ${quoteStatuses(COMPLETE.as_recorded)} (${pct(part, whole)}%) with no street`;
      const consequence = T.consequencePart({ source: WO, finding: found, measured: read, tail: "so a street search can't find them" });
      return {
        span: { field: 'created_datetime', from, through },
        how_much: {
          part,
          whole,
          read: sb.r.read,
          series: series.rows.map((x) => ({ k: String(x.y), part: num(x, 'part'), whole: num(x, 'whole') })),
          window: { from: since, part: num(w, 'part'), whole: num(w, 'whole'), also: { no_ward_or_league: num(w, 'no_loc') } },
          by_status: [{ as_recorded: OPEN.as_recorded, part: sb.openNoStreet, whole: sb.openWhole }],
        },
        evidence: [h.ev.query(sb.r), h.ev.query(span), h.ev.query(series), h.ev.query(win)],
        statement,
        short: `${found}, measured ${read}.`,
        consequences: { q1: consequence, q2: consequence, q3: consequence },
        closing: num(w, 'whole') > 0 && num(w, 'part') / num(w, 'whole') <= 0.01,
      };
    },
  },

  {
    id: 'norfolk.work-orders.created-on-or-after-end',
    kind: 'created_on_or_after_end',
    title: 'Removal orders created on or after their end date',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [WO], scope: SCOPE, status: COMPLETE, area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'Can I find out before a street tree near me is removed?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'created_datetime' }, { dataset: WO.id, column: 'end_date' }] },
    ],
    actions: ['a-meeting-notice', 'a-watch-street'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }, { case: 'norfolk-trees' }],
    bites_when: [{ tool: 'trees_on_my_block', field: 'on_your_street', ok: true }],
    closed_when: { share_at_most: 0.05, over: 'window' },
    async measure(h) {
      const from = addDays(h.today, -365);
      const through = addDays(h.today, -1);
      const cmp = { before: 'date_trunc_ymd(end_date) < date_trunc_ymd(created_datetime)', same: 'date_trunc_ymd(end_date) = date_trunc_ymd(created_datetime)' };
      const win = await h.run.query(WO.id, soql.window(C, 'end_date', from, h.today, cmp), 'Complete removals ending in the last year: end date vs created');
      const all = await h.run.query(WO.id, soql.share(`${C} AND end_date IS NOT NULL`, cmp), 'Complete removals, all time: end date vs created');
      const w = win.rows[0];
      const whole = num(w, 'whole');
      const before = num(w, 'before');
      const same = num(w, 'same');
      const part = before + same;
      const read = h.dateOf(win.read);
      const a = all.rows[0];
      return {
        span: { field: 'end_date', from, through },
        how_much: {
          part,
          whole,
          read: win.read,
          window: { from, part, whole, also: { before, same } },
          all_time: { part: num(a, 'before') + num(a, 'same'), whole: num(a, 'whole'), read: all.read },
        },
        evidence: [h.ev.query(win), h.ev.query(all)],
        statement: T.createdOnOrAfterEnd({ whole, scope: SCOPE, status: COMPLETE.as_recorded, from, through, part, before, same, source: WO, read }),
        short: `I found ${fmt(part)} of ${fmt(whole)} ${SCOPE} with status ${quoteStatuses(COMPLETE.as_recorded)} ending ${from} through ${through} (${pct(part, whole)}%) created on or after their end date, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({
            source: WO,
            finding: `I found ${fmt(part)} of ${fmt(whole)} ${SCOPE} with status ${quoteStatuses(COMPLETE.as_recorded)} and an end date from ${from} through ${through} (${pct(part, whole)}%) created on or after the day of their end date`,
            measured: read,
            tail: 'so a search of these records made before their end date finds no order for them',
          }),
        },
        closing: whole > 0 && part / whole <= 0.05,
      };
    },
  },

  {
    id: 'norfolk.work-orders.no-planned-date',
    kind: 'missing_field',
    title: 'No field for a planned date (Work Orders)',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [WO], scope: SCOPE, area: 'citywide' },
    questions: [{ qid: 'q1', text: 'When is a logged tree removal on my street planned to happen?', blocks: 'all', concept: 'planned' }],
    actions: ['a-meeting-planned', 'a-foia-planned'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }],
    bites_when: [{ tool: 'trees_on_my_block', field: 'on_your_street', ok: true }],
    closed_when: { column_present: '/(^|_)(plan|planned|sched|scheduled|due|target)(_|$)/', null_share_at_most: 0.05 },
    concepts: { planned: { pattern: /(^|_)(plan|planned|sched|scheduled|due|target)(_|$)/i, datasets: TREE_DATASETS } },
    async measure(h) {
      const cols = await h.run.columnsAbsent({ datasets: TREE_DATASETS, pattern: this.concepts.planned.pattern });
      const sd = await h.run.fieldDescription(WO.id, 'start_date');
      const sb = await statusBreakdown(h);
      const backlog = await h.run.query(WO.id, soql.share(W_OPEN, { with_end: 'end_date IS NOT NULL' }), 'Removals with status New Work Order or On-Going');
      const n = num(backlog.rows[0], 'whole');
      if (n !== sb.openWhole) throw new MeasureChange('The backlog count and the status breakdown disagree.');
      const med = await h.run.medianDate({ dataset: WO.id, where: W_OPEN, field: 'created_datetime', tiebreak: 'work_order_number', n });
      const days = daysSince(med.value, h.today);
      const read = h.dateOf(cols.read);
      const bread = h.dateOf(backlog.read);
      const withEnd = num(backlog.rows[0], 'with_end');
      return {
        how_much: { columns_absent: cols, backlog: { as_recorded: OPEN.as_recorded, whole: n, with_end: withEnd, median_created: String(med.value).slice(0, 10), median_days: days, read: backlog.read } },
        evidence: [...columnsEvidence(h, cols, TREE_DATASETS), h.ev.field(sd), h.ev.query(backlog), ...med.rows.map(h.ev.query)],
        statement: [
          T.columnsAbsent({ concept: 'for a planned or scheduled date', count: cols.datasets[WO.id], source: WO, read }),
          T.fieldQuote({ field: 'start_date', quote: sd.quote }),
          T.backlog({ whole: n, scope: SCOPE, status: OPEN.as_recorded, with_end: withEnd, median_days: days, read: bread }),
        ].join(' '),
        short: `I found no column for a planned or scheduled date in any of the ${TREE_DATASETS.length} tree datasets I read, measured ${read}.`,
        consequences: { q1: T.consequenceAll({ concept: 'for a planned or scheduled date', datasets: TREE_DATASETS, topic: 'tree', measured: read }) },
      };
    },
  },

  {
    id: 'norfolk.work-orders.no-notice-field',
    kind: 'missing_field',
    title: 'No field for notice to residents',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: TREE_DATASETS.map((id) => ({ id })), scope: 'tree datasets', area: 'citywide' },
    questions: [{ qid: 'q1', text: 'How much notice does the City give before removing a street tree?', blocks: 'all', concept: 'notice' }],
    actions: ['a-meeting-notice'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }],
    bites_when: [],
    closed_when: { column_present: '/(^|_)(notice|notif\w*|post|posted|posting)(_|$)/', null_share_at_most: 0.05 },
    concepts: { notice: { pattern: /(^|_)(notice|notif\w*|post|posted|posting)(_|$)/i, datasets: TREE_DATASETS } },
    async measure(h) {
      const cols = await h.run.columnsAbsent({ datasets: TREE_DATASETS, pattern: this.concepts.notice.pattern });
      const read = h.dateOf(cols.read);
      return {
        how_much: { columns_absent: cols },
        evidence: columnsEvidence(h, cols, TREE_DATASETS),
        statement: T.columnsAbsentTopic({ concept: 'for notice to residents', datasets: TREE_DATASETS, topic: 'tree', read }),
        short: `I found no column for notice to residents in any of the ${TREE_DATASETS.length} tree datasets I read, measured ${read}.`,
        consequences: { q1: T.consequenceAll({ concept: 'for notice to residents', datasets: TREE_DATASETS, topic: 'tree', measured: read }) },
      };
    },
  },

  {
    id: 'norfolk.work-orders.no-contract-link',
    kind: 'missing_field',
    title: 'No field linking a work order to a contract',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [WO], scope: SCOPE, status: COMPLETE, area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'Does every contracted tree removal have a work order in these records?', blocks: 'all', concept: 'contract' },
      { qid: 'q2', text: 'How many trees did City contractors remove last year?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'contractor_cost' }] },
    ],
    actions: ['a-foia-contracts', 'a-proposal-crew'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }, { case: 'norfolk-trees' }],
    bites_when: [],
    closed_when: { column_present: '/contract|invoice/', null_share_at_most: 0.05 },
    concepts: {
      contract: {
        pattern: /contract|invoice/i,
        datasets: TREE_DATASETS,
        cleared: [
          {
            dataset: WO.id,
            column: 'contractor_cost',
            reason: 'A cost, not a link to a contract or invoice. Its description, in its words: “Cost of contractor labor and materials in completing the work order.”',
            by: 'Inc 4 catalog PR, for review',
            date: '2026-11-06',
          },
        ],
      },
    },
    async measure(h) {
      const k = this.concepts.contract;
      const cols = await h.run.columnsAbsent({ datasets: k.datasets, pattern: k.pattern, cleared: k.cleared });
      const sb = await statusBreakdown(h);
      const f = h.finding('norfolk-trees', 'contract-removal');
      const read = h.dateOf(cols.read);
      const part = num(sb.c, 'cc');
      const whole = num(sb.c, 'whole');
      const sread = h.dateOf(sb.r.read);
      return {
        how_much: { columns_absent: cols, part, whole, read: sb.r.read },
        evidence: [...columnsEvidence(h, cols, k.datasets), h.ev.query(sb.r), h.ev.finding(f)],
        statement: [
          T.columnsAbsent({ concept: 'linking a work order to a contract or invoice', count: cols.datasets[WO.id], source: WO, read }),
          T.partOf({ what: 'a contractor cost above zero', part, whole, scope: `of its ${SCOPE}`, status: COMPLETE.as_recorded, read: sread }),
          T.findingQuote({ who: SAYS['contract-removal'], quote: f.quote, checked: f.checked }),
        ].join(' '),
        short: `I found no column linking a work order to a contract or invoice among the ${cols.datasets[WO.id]} columns of the City's Work Orders records, measured ${read}.`,
        consequences: {
          q1: T.consequenceAll({ concept: 'linking a work order to a contract or invoice', datasets: k.datasets, topic: 'tree', measured: read }),
          q2: T.consequencePart({
            source: WO,
            finding: `I found a contractor cost above zero on ${fmt(part)} of ${fmt(whole)} ${SCOPE} with status ${quoteStatuses(COMPLETE.as_recorded)} (${pct(part, whole)}%)`,
            measured: sread,
            tail: 'which counts orders, not trees',
          }),
        },
      };
    },
  },

  {
    id: 'norfolk.work-orders.no-trees-per-order',
    kind: 'missing_field',
    title: 'No field for trees per work order',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [WO], scope: 'Work Orders columns', area: 'citywide' },
    questions: [{ qid: 'q1', text: 'How many street trees did the City remove last year?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'work_order_number' }] }],
    actions: ['a-foia-trees-per-order'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }, { case: 'norfolk-trees' }],
    bites_when: [],
    closed_when: { column_present: '/(^|_)(trees?|count|qty|quantity)(_|$)/', null_share_at_most: 0.05 },
    async measure(h) {
      const cols = await h.run.columnsAbsent({ datasets: [WO.id], pattern: /(^|_)(trees?|count|qty|quantity)(_|$)/i });
      const read = h.dateOf(cols.read);
      const n = cols.datasets[WO.id];
      return {
        how_much: { columns_absent: cols },
        evidence: columnsEvidence(h, cols, [WO.id]),
        statement: T.columnsAbsent({ concept: 'for the number of trees on a work order', count: n, source: WO, read }),
        short: `I found no column for the number of trees on a work order among the ${n} columns of the City's Work Orders records, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({ source: WO, finding: `I found no column for the number of trees on a work order among its ${n} columns`, measured: read, tail: 'so I can count removal orders, not trees' }),
        },
      };
    },
  },

  {
    id: 'norfolk.work-orders.no-approver',
    kind: 'no_decision_record',
    title: 'No field naming a requester or approver (Work Orders)',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [WO], scope: 'Work Orders columns', area: 'citywide' },
    questions: [
      {
        qid: 'q1',
        text: 'Which City office approves street-tree removals, and on what criteria?',
        blocks: 'part',
        answered_in_part_by: [{ dataset: WO.id, column: 'department' }, { dataset: WO.id, column: 'priority' }, { dataset: WO.id, column: 'problem_description' }],
      },
    ],
    actions: ['a-meeting-approver', 'a-foia-approver'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }],
    bites_when: [],
    closed_when: { column_present: '/(^|_)(request\w*|approv\w*|authori\w*|decid\w*|decision)(_|$)/', null_share_at_most: 0.05 },
    async measure(h) {
      const cols = await h.run.columnsAbsent({ datasets: [WO.id], pattern: /(^|_)(request\w*|approv\w*|authori\w*|decid\w*|decision)(_|$)/i });
      const read = h.dateOf(cols.read);
      const n = cols.datasets[WO.id];
      return {
        how_much: { columns_absent: cols },
        evidence: columnsEvidence(h, cols, [WO.id]),
        statement: T.columnsAbsent({ concept: 'naming a requester or approver of a work order', count: n, source: WO, read }),
        short: `I found no column naming a requester or approver of a work order among the ${n} columns of the City's Work Orders records, measured ${read}.`,
        consequences: {
          q1: T.consequencePart({ source: WO, finding: `I found no column naming a requester or approver of a work order among its ${n} columns`, measured: read, tail: 'so I can name only the department, priority and problem code the records hold' }),
        },
      };
    },
  },

  {
    id: 'norfolk.tree-inventory.survey-date',
    kind: 'stale',
    title: 'Survey date stated by the City Tree Inventory',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [INV], scope: 'city-managed trees', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'How many street trees does Norfolk have now?', blocks: 'part', answered_in_part_by: [{ dataset: INV.id, column: 'tree_id' }] },
      { qid: 'q2', text: "How current is the City's record of the trees on my block?", blocks: 'part', answered_in_part_by: [{ dataset: INV.id, metadata: 'rowsUpdatedAt' }] },
    ],
    actions: ['a-meeting-reinventory'],
    touches: [{ dataset: INV.id }, { tool: 'trees_on_my_block' }, { case: 'norfolk-trees' }],
    bites_when: [{ tool: 'trees_on_my_block', field: 'near_you', ok: true }],
    closed_when: { finding: true },
    quote: [
      'The original inventory of these trees was conducted in the late 1990s/early 2000s by the Norfolk Master Gardeners.',
      'No official re-inventory has been conducted since then by City officials or ISA Certified Arborists, however, tree records in this dataset have been and are being updated over time by City Staff.',
    ],
    async measure(h) {
      const q = await h.run.descriptionQuote(INV.id, this.quote);
      const cols = await h.run.columnsAbsent({ datasets: [INV.id], pattern: /(^|_)(date|survey\w*|updated|modified|inspect\w*|year)(_|$)/i });
      const f = h.finding('norfolk-trees', 'no-citywide-assessment');
      const read = h.dateOf(q.read);
      const n = cols.datasets[INV.id];
      const noDate = `I found no column dating when each tree's record was surveyed or updated among its ${n} data columns`;
      const consequence = T.consequencePart({ source: INV, finding: noDate, measured: read, tail: 'so I can count its records but not date them' });
      return {
        how_much: { quote: { dataset: INV.id, text: q.quote, read: q.read }, published: { rows_updated: q.updated, read: q.read }, columns_absent: cols },
        evidence: [h.ev.metadata(q, { quote: q.quote }), ...columnsEvidence(h, cols, [INV.id]), h.ev.finding(f)],
        statement: `${T.stale({ owner: "The City Tree Inventory's", source: INV, read, quote: q.quote })} ${noDate}, as I read them on ${h.dateOf(cols.read)}.`,
        short: `The City Tree Inventory's own description says its original inventory was conducted in the “late 1990s/early 2000s”, as I read it on ${read}.`,
        consequences: { q1: consequence, q2: consequence },
      };
    },
  },

  {
    id: 'norfolk.tree-inventory.no-condition',
    kind: 'missing_field',
    title: 'No field for tree condition (City Tree Inventory)',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [INV, WO], scope: 'city-managed trees', area: 'citywide' },
    questions: [
      { qid: 'q1', text: 'What condition are the street trees on my block in?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'problem_description' }] },
      { qid: 'q2', text: 'Which street trees are at risk of failing?', blocks: 'part', answered_in_part_by: [{ dataset: WO.id, column: 'problem_description' }] },
    ],
    actions: ['a-proposal-condition', 'a-meeting-condition'],
    touches: [{ dataset: INV.id }, { tool: 'trees_on_my_block' }, { case: 'norfolk-trees' }],
    bites_when: [{ tool: 'trees_on_my_block', field: 'near_you', ok: true }],
    closed_when: { column_present: '/(^|_)(condition|health|risk|hazard|defect)\w*/', null_share_at_most: 0.05 },
    codes: ['Dead Tree', 'Diseased', 'Damaged Tree'],
    async measure(h) {
      const cols = await h.run.columnsAbsent({ datasets: TREE_DATASETS, pattern: /(^|_)(condition|health|risk|hazard|defect)\w*/i });
      const v = await forestryProblems(h);
      const count = (code) => {
        const row = v.rows.find((x) => x.v === code);
        if (!row) throw new MeasureChange(`Problem code “${code}” is no longer recorded.`);
        return num(row, 'n');
      };
      const [dead, diseased, damaged] = this.codes.map(count);
      const read = h.dateOf(cols.read);
      const vread = h.dateOf(v.read);
      const codesLine = `problem codes such as “Dead Tree” on ${fmt(dead)}, “Diseased” on ${fmt(diseased)} and “Damaged Tree” on ${fmt(damaged)} Forestry work orders`;
      const consequence = T.consequencePart({ source: WO, finding: `I found ${codesLine}`, measured: vread, tail: `and I found no column for condition in ${sourceName(INV)}` });
      return {
        how_much: { columns_absent: cols, problem_codes: { codes: this.codes.map((c, i) => ({ value: c, n: [dead, diseased, damaged][i] })), read: v.read } },
        evidence: [...columnsEvidence(h, cols, TREE_DATASETS), h.ev.query(v)],
        statement: `${T.columnsAbsentTopic({ concept: 'for tree condition, health or risk', datasets: TREE_DATASETS, topic: 'tree', read })} I found the ${codesLine} in ${sourceName(WO)}, as I read them on ${vread}.`,
        short: `I found no column for tree condition, health or risk in any of the ${TREE_DATASETS.length} tree datasets I read, measured ${read}.`,
        consequences: { q1: consequence, q2: consequence },
      };
    },
  },

  {
    id: 'norfolk.tree-inventory.no-usable-size',
    kind: 'missing_field',
    title: 'City trees with no usable trunk size',
    checked_live: '2026-11-06',
    optional: true,
    topic: 'trees',
    where: { sources: [INV], scope: 'city trees', area: 'citywide' },
    questions: [{ qid: 'q1', text: 'How big are the trees on my block?', blocks: 'part', answered_in_part_by: [{ dataset: INV.id, column: 'trunk_diameter' }, { dataset: INV.id, column: 'trunk_diameter_range' }] }],
    actions: ['a-proposal-size'],
    touches: [{ dataset: INV.id }, { tool: 'trees_on_my_block' }],
    bites_when: [{ tool: 'trees_on_my_block', field: 'near_you', ok: true }],
    closed_when: { share_at_most: 0.01, over: 'whole' },
    siblings: {
      pattern: /trunk|diameter|dbh|(^|_)size(_|$)/i,
      cleared: [
        { dataset: INV.id, column: 'trunk_diameter', reason: 'Read by this measure.', by: 'Inc 4 catalog PR, for review', date: '2026-11-06' },
        { dataset: INV.id, column: 'trunk_diameter_range', reason: 'Read by this measure.', by: 'Inc 4 catalog PR, for review', date: '2026-11-06' },
        {
          dataset: 'jz6u-9g3c',
          column: 'diameter_dbh',
          reason: 'Significant Trees is a separate dataset of nominated trees (its description: “Volunteers with the Norfolk Master Gardeners gather this data about significant trees in Norfolk.”), not the inventory’s records.',
          by: 'Inc 4 catalog PR, for review',
          date: '2026-11-06',
        },
      ],
    },
    async measure(h) {
      const sib = await h.run.columnsAbsent({ datasets: TREE_DATASETS, pattern: this.siblings.pattern, cleared: this.siblings.cleared });
      const r = await h.run.query(
        INV.id,
        soql.share(CITY_TREE, {
          no_range: 'trunk_diameter_range IS NULL',
          no_dia: 'trunk_diameter IS NULL',
          no_usable: '(trunk_diameter IS NULL OR trunk_diameter <= 0) AND trunk_diameter_range IS NULL',
        }),
        'city trees with no usable trunk size'
      );
      const fd = await h.run.fieldDescription(INV.id, 'trunk_diameter');
      const row = r.rows[0];
      const part = num(row, 'no_usable');
      const whole = num(row, 'whole');
      const read = h.dateOf(r.read);
      const found = `I found ${fmt(part)} of ${fmt(whole)} city trees (${pct(part, whole)}%) with neither a trunk-size range nor a trunk diameter above zero`;
      return {
        how_much: { part, whole, read: r.read, no_range: num(row, 'no_range'), no_diameter: num(row, 'no_dia'), siblings: sib },
        evidence: [h.ev.query(r), h.ev.field(fd), ...columnsEvidence(h, sib, TREE_DATASETS)],
        statement: `${found} in ${sourceName(INV)}, leaving out rows labeled “PRIVATE TREES”, as I read it on ${read}. ${T.fieldQuote({ field: 'trunk_diameter', quote: fd.quote })}`,
        short: `${found} in the City Tree Inventory, measured ${read}.`,
        consequences: { q1: T.consequencePart({ source: INV, finding: found, measured: read, tail: "so I can't give their size" }) },
        closing: whole > 0 && part / whole <= 0.01,
      };
    },
  },

  {
    id: 'norfolk.utility.line-clearance',
    kind: 'no_records',
    title: 'Utility line clearance in the sources checked',
    checked_live: '2026-11-06',
    topic: 'trees',
    where: { sources: [{ type: 'catalog', id: 'data.norfolk.gov' }, WO], scope: 'tree work near utility lines', area: 'citywide' },
    questions: [{ qid: 'q1', text: 'Which tree work near me was utility line clearance?', blocks: 'all', concept: 'line' }],
    actions: ['a-meeting-line'],
    touches: [{ dataset: WO.id, where_includes: ["area = 'Forestry'"] }, { tool: 'trees_on_my_block' }, { case: 'norfolk-trees' }],
    bites_when: [],
    closed_when: { finding: true },
    concepts: { line: { pattern: /(^|_)(utilit\w*|power_?lines?|clearance|dominion)(_|$)/i, datasets: TREE_DATASETS } },
    searches: ['line clearance', 'Dominion'],
    terms: ['utility', 'power line', 'line clearance', 'Dominion'],
    async measure(h) {
      const cols = await h.run.columnsAbsent({ datasets: TREE_DATASETS, pattern: this.concepts.line.pattern });
      const searches = [];
      for (const q of this.searches) searches.push(await h.run.catalogSearch(q));
      if (searches[0].result_set_size !== 0) throw new MeasureChange(`The catalog search “${searches[0].q}” now returns ${searches[0].result_set_size}; a reviewer looks before this gap is shown again.`);
      const v = await h.run.valuesAbsent({ dataset: WO.id, field: 'problem_description', where: FORESTRY, pattern: /utilit|power ?line|line clearance|dominion/i });
      if (v.matched.length) throw new MeasureChange(`A Forestry problem code now matches: ${v.matched.join(', ')}.`);
      const f = h.finding('norfolk-trees', 'dominion');
      const sread = h.dateOf(searches[0].read);
      const read = h.dateOf(cols.read);
      return {
        how_much: {
          columns_absent: cols,
          catalog: searches.map((s) => ({ q: s.q, result_set_size: s.result_set_size, open_to_siren: s.results.filter((r) => r.open_to_siren).map((r) => ({ id: r.id, name: r.name })), read: s.read })),
          values: { dataset: WO.id, field: 'problem_description', count: v.values.length, matched: [], read: v.read },
        },
        evidence: [...searches.map(h.ev.catalog), h.ev.values(v), ...columnsEvidence(h, cols, TREE_DATASETS), h.ev.finding(f)],
        statement: [
          T.catalogSearch({
            portal: "Norfolk's open data",
            searches: searches.map((s) => {
              const open = s.results.filter((r) => r.open_to_siren);
              return { q: s.q, result_set_size: s.result_set_size, open: open.length, names: open.map((r) => r.name) };
            }),
            read: sread,
          }),
          T.valuesAbsent({ count: v.values.length, what: 'problem descriptions on Forestry work orders', source: WO, terms: this.terms, read: h.dateOf(v.read) }),
          T.findingQuote({ who: SAYS.dominion, quote: f.quote, checked: f.checked }),
        ].join(' '),
        short: `I found no dataset in Norfolk's catalog for the search “line clearance” and no Forestry problem code naming utility lines, searched ${sread}.`,
        consequences: { q1: T.consequenceAll({ concept: 'for utility line clearance', datasets: TREE_DATASETS, topic: 'tree', measured: read }) },
      };
    },
  },

  {
    id: 'norfolk.311.restricted',
    kind: 'restricted',
    title: 'MyNorfolk 311 requests: out of Siren’s reach by rule',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [{ id: 'nbyu-xjez', name: 'MyNorfolk 311 requests' }], scope: 'MyNorfolk 311 requests', area: 'citywide' },
    questions: [{ qid: 'q1', text: 'How many tree requests reached MyNorfolk 311 in my ward last year?', blocks: 'all', concept: 'policy' }],
    actions: ['a-source-311'],
    // Only a refusal: a reviewed plugin that reads 311 (a-source-311) would
    // make this statement wrong for its answers.
    touches: [{ refused: 'nbyu-xjez' }],
    bites_when: [{ refused: 'nbyu-xjez' }],
    closed_when: { finding: true },
    async measure(h) {
      const p = h.policy('nbyu-xjez');
      return {
        how_much: { policy: { dataset: 'nbyu-xjez', file: p.file, line: p.line } },
        evidence: [{ type: 'policy', dataset: 'nbyu-xjez', reason: p.reason, file: p.file, line: p.line }],
        // The rule comes from a repo file, so it's dated when it was read from it.
        measured: h.repoToday,
        statement: T.restricted({ name: 'MyNorfolk 311 requests', id: 'nbyu-xjez', read: h.repoToday, reason: p.reason }),
        short: `I don't query MyNorfolk 311 requests for open-ended questions, by Siren's rule as read on ${h.repoToday}.`,
        consequences: { q1: T.consequenceRestricted({ name: 'MyNorfolk 311 requests', read: h.repoToday }) },
      };
    },
  },

  {
    id: 'norfolk.legislation.no-address',
    kind: 'partial_coverage',
    title: 'Agenda items with no street address in their titles',
    checked_live: '2026-11-06',
    topic: null,
    where: { sources: [{ type: 'index', id: INDEX.id, name: INDEX.name }], scope: 'agenda items in public meetings', area: 'citywide' },
    questions: [{ qid: 'q1', text: 'Did the Council act on anything that affects my block?', blocks: 'part', answered_in_part_by: [{ index: INDEX.id, field: 'addresses' }] }],
    actions: ['a-source-legislation'],
    touches: [{ tool: 'block_report' }, { tool: 'find_legislation' }],
    bites_when: [{ tool: 'block_report', field: 'legislation', ok: true }],
    closed_when: { share_at_most: 0.05, over: 'whole' },
    async measure(h) {
      const idx = h.index(INDEX.id);
      const items = idx.items || [];
      const part = items.filter((i) => !i.addresses || !i.addresses.length).length;
      const whole = items.length;
      const dates = items.flatMap((i) => (i.meetings || []).map((m) => m.date)).filter(Boolean).sort();
      const built = String(idx.built).slice(0, 10);
      const span = { from: dates[0], through: dates.at(-1) };
      return {
        // Counted from a repo file, so dated when it was counted.
        measured: h.repoToday,
        span: { field: 'meetings.date', ...span },
        how_much: { part, whole, read: idx.built },
        evidence: [{ type: 'index', file: `data/${INDEX.id}.json`, built: idx.built, counted: part, of: whole }],
        statement: T.index({ part, whole, what: 'agenda items', absent: 'no street address', index: INDEX.phrase, built, ...span, consequence: "I can't match them to a block" }),
        short: `I found no street address in the titles of ${fmt(part)} of ${fmt(whole)} agenda items (${pct(part, whole)}%) in Siren's agenda index, built ${built}.`,
        consequences: {
          q1: T.consequencePart({ source: INDEX, finding: `I found no street address in the titles of ${fmt(part)} of ${fmt(whole)} agenda items (${pct(part, whole)}%) in the index built ${built}`, measured: h.repoToday, tail: "so I can't match them to a block" }),
        },
        closing: whole > 0 && part / whole <= 0.05,
      };
    },
  },
];

function sourceName(s) {
  return `${s.phrase} (${s.id})`;
}

/** Rev 1 ids: retired, listed forever, never reused. */
export const RETIRED = Object.freeze([
  'norfolk.work-orders.removal-recorded-late',
  'norfolk.work-orders.removal-no-future-date',
  'norfolk.work-orders.contract-work',
  'norfolk.work-orders.trees-per-order',
  'norfolk.work-orders.removal-no-approver',
  'norfolk.tree-inventory.survey-age',
  'norfolk.tree-inventory.no-trunk-size',
]);

/** Siren's own bugs, which are not gaps in the records (§4.2). */
export const NOT_A_GAP = Object.freeze([
  { id: 'trunk-size', note: 'trees_on_my_block reads only trunk_diameter_range; the fix that also reads trunk_diameter (Inc 5) is on branch ccr-159a72f4-joafbc-trees, not yet merged.' },
  { id: 'siren-config-survey-claim', note: 'deployments/siren.config.js states a survey date as fact; being replaced on branch ccr-159a72f4-joafbc-trees (J25), not yet merged.' },
  { id: 'trees-plugin-contract-hypothesis', note: 'trees_on_my_block states a hypothesis about contract work; being replaced on branch ccr-159a72f4-joafbc-trees (J25), not yet merged.' },
]);
