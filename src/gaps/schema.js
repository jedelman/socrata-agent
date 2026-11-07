// The built gap file's schema (docs/gaps.md §3.2). Unknown keys fail
// everywhere, so a `why` or `cause` field can never be added quietly: a gap
// has a shape and consequences, never a cause.

const t = {
  str: { type: 'string' },
  num: { type: 'number' },
  int: { type: 'integer' },
  bool: { type: 'boolean' },
  day: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ },
  iso: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/ },
  any: { type: 'any' },
};
const obj = (props, optional = []) => ({ type: 'object', props, optional: new Set(optional) });
const arr = (items) => ({ type: 'array', items });
const oneOf = (...alts) => ({ type: 'oneOf', alts });
const en = (...values) => ({ type: 'enum', values });
const map = (values) => ({ type: 'map', values });

const ID12 = { type: 'string', pattern: /^[0-9a-f]{12}$/ };
const DATASET = { type: 'string', pattern: /^[a-z0-9]{4}-[a-z0-9]{4}$/ };

const source = oneOf(
  obj({ type: en('dataset'), id: DATASET, name: t.str }),
  obj({ type: en('catalog'), id: t.str }),
  obj({ type: en('index'), id: t.str, name: t.str })
);
const columns = obj(
  {
    pattern: t.str,
    datasets: map(t.int),
    siblings_cleared: arr(obj({ dataset: DATASET, column: t.str, reason: t.str, by: t.str, date: t.day })),
    siblings: arr(obj({ dataset: DATASET, column: t.str })),
    read: t.iso,
  }
);
const pw = obj({ part: t.int, whole: t.int }, []);

const howMuch = obj(
  {
    part: t.int,
    whole: t.int,
    read: t.iso,
    series: arr(obj({ k: t.str, part: t.int, whole: t.int })),
    window: obj({ from: t.day, part: t.int, whole: t.int, also: map(t.int) }, ['also']),
    by_status: arr(obj({ as_recorded: arr(t.str), part: t.int, whole: t.int })),
    all_time: obj({ part: t.int, whole: t.int, read: t.iso }),
    columns_absent: columns,
    siblings: columns,
    backlog: obj({ as_recorded: arr(t.str), whole: t.int, with_end: t.int, median_created: t.day, median_days: t.int, read: t.iso }),
    quote: obj({ dataset: DATASET, text: t.str, read: t.iso }),
    published: obj({ rows_updated: t.str, read: t.iso }),
    problem_codes: obj({ codes: arr(obj({ value: t.str, n: t.int })), read: t.iso }),
    catalog: arr(obj({ q: t.str, result_set_size: t.int, open_to_siren: arr(obj({ id: DATASET, name: t.str })), read: t.iso })),
    values: obj({ dataset: DATASET, field: t.str, count: t.int, matched: arr(t.str), read: t.iso }),
    policy: obj({ dataset: DATASET, file: t.str, line: t.int }),
    no_range: t.int,
    no_diameter: t.int,
  },
  ['part', 'whole', 'read', 'series', 'window', 'by_status', 'all_time', 'columns_absent', 'siblings', 'backlog', 'quote', 'published', 'problem_codes', 'catalog', 'values', 'policy', 'no_range', 'no_diameter']
);
void pw;

const evidence = oneOf(
  obj({ type: en('query'), dataset: DATASET, soql: t.str, url: t.str, result: t.any, read: t.iso, trace_n: t.int }),
  obj({ type: en('metadata'), dataset: DATASET, field: t.str, quote: t.str, columns: t.int, url: t.str, read: t.iso, trace_n: t.int }, ['field', 'quote', 'columns']),
  obj({ type: en('finding'), case: t.str, id: t.str, url: t.str, quote: t.str, selector: t.any, checked: t.day, reverified: oneOf(t.day, en(null)) }, ['selector']),
  obj({ type: en('catalog_search'), q: t.str, result_set_size: t.int, excluded: t.int, open_to_siren: arr(obj({ id: DATASET, name: t.str })), url: t.str, read: t.iso, trace_n: t.int }),
  obj({ type: en('values'), dataset: DATASET, field: t.str, values: arr(t.str), pattern: t.str, matched: arr(t.str), url: t.str, read: t.iso, trace_n: t.int }),
  obj({ type: en('policy'), dataset: DATASET, reason: t.str, file: t.str, line: t.int }),
  obj({ type: en('index'), file: t.str, built: t.str, counted: t.int, of: t.int })
);

const partBy = oneOf(obj({ dataset: DATASET, column: t.str }), obj({ dataset: DATASET, metadata: t.str }), obj({ index: t.str, field: t.str }));
const question = obj(
  { qid: t.str, public_id: ID12, text: t.str, blocks: en('part', 'all'), answered_in_part_by: arr(partBy), consequence: t.str },
  ['answered_in_part_by']
);
const predicate = oneOf(
  obj({ dataset: DATASET, where_includes: arr(t.str) }, ['where_includes']),
  obj({ tool: t.str, field: t.str, ok: t.bool }, ['field', 'ok']),
  obj({ case: t.str }),
  obj({ refused: DATASET }),
  obj({ absence: en(true) })
);

export const GAP_RECORD = obj(
  {
    id: { type: 'string', pattern: /^[a-z0-9]+(\.[a-z0-9-]+)+$/ },
    public_id: ID12,
    kind: en('no_records', 'missing_field', 'partial_coverage', 'stale', 'created_on_or_after_end', 'restricted', 'not_online', 'no_decision_record'),
    label: t.str,
    title: t.str,
    optional: t.bool,
    where: obj(
      {
        sources: arr(source),
        scope: t.str,
        status: obj({ field: t.str, values: arr(t.int), as_recorded: arr(t.str) }),
        area: en('citywide'),
        span: obj({ field: t.str, from: t.day, through: t.day }),
      },
      ['status', 'span']
    ),
    topic: oneOf(
      en(null),
      obj({ name: t.str, datasets: arr(DATASET), search: t.str, not_in_topic: arr(obj({ id: DATASET, name: t.str, quote: t.str, reason: t.str, placed: t.str, read: t.iso, trace_n: t.int })), checked_live: t.day })
    ),
    checked_live: t.day,
    how_much: howMuch,
    evidence: arr(evidence),
    statement: t.str,
    short: t.str,
    questions: arr(question),
    actions: arr(t.str),
    touches: arr(predicate),
    bites_when: arr(predicate),
    closed_when: oneOf(obj({ share_at_most: t.num, over: en('window', 'whole') }), obj({ finding: en(true) }), obj({ column_present: t.str, null_share_at_most: t.num })),
    state: en('open', 'closing', 'closed', 'unmeasured_today', 'evidence_unverified'),
    measured: t.day,
    last_good: t.day,
    notice: t.str,
    hand_off: arr(obj({ id: DATASET, name: t.str, page: t.str, docs: t.str })),
  },
  ['optional', 'last_good', 'notice']
);

export const ACTION_RECORD = obj(
  {
    id: { type: 'string', pattern: /^a-[a-z0-9-]+$/ },
    public_id: ID12,
    kind: en('source_request', 'foia_draft', 'meeting_question', 'dataset_proposal', 'watch'),
    gaps: arr(t.str),
    text: t.str,
    available: t.bool,
    audience: t.str,
    aggregate_only: t.bool,
    needs: t.str,
    draft: obj({ to: t.str, body: t.str, source: obj({ case: t.str, records_to_request: t.int, text: t.str }), strikes: arr(obj({ phrase: t.str, column: t.str, dataset: DATASET })), leave_out: t.str, frame: t.str }, ['strikes']),
    contact: obj({ role: t.str, phone: t.str, email: t.str, note: t.str }, ['phone', 'email', 'note']),
  },
  ['text', 'available', 'audience', 'aggregate_only', 'needs', 'draft', 'contact']
);

export const GAP_FILE = obj(
  {
    city: t.str,
    built: t.day,
    rebuilt: t.day,
    note: t.str,
    gaps: arr(GAP_RECORD),
    off_board: arr(obj({ id: t.str, state: en('unmeasured_today', 'evidence_unverified'), reason: t.str })),
    retired: arr(t.str),
    not_a_gap: arr(obj({ id: t.str, note: t.str })),
    actions: arr(ACTION_RECORD),
    meetings: obj({ read: t.iso, listed: arr(obj({ when: t.str, body: t.str, type: t.str })), calendar: t.str, note: t.str }),
  },
  ['meetings', 'rebuilt']
);

/** Errors for a value against a schema node ([] when it fits). */
export function validate(value, node, path = '$') {
  const errs = [];
  const fail = (m) => errs.push(`${path}: ${m}`);
  switch (node.type) {
    case 'any':
      break;
    case 'string':
      if (typeof value !== 'string') fail('expected a string');
      else if (node.pattern && !node.pattern.test(value)) fail(`"${value.slice(0, 60)}" does not match ${node.pattern}`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected a number');
      break;
    case 'integer':
      if (!Number.isInteger(value)) fail('expected an integer');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('expected a boolean');
      break;
    case 'enum':
      if (!node.values.includes(value)) fail(`expected one of ${node.values.map(String).join(', ')}`);
      break;
    case 'array':
      if (!Array.isArray(value)) fail('expected an array');
      else value.forEach((v, i) => errs.push(...validate(v, node.items, `${path}[${i}]`)));
      break;
    case 'map':
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
      else for (const [k, v] of Object.entries(value)) errs.push(...validate(v, node.values, `${path}.${k}`));
      break;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('expected an object');
        break;
      }
      for (const k of Object.keys(value)) if (!(k in node.props)) fail(`unknown key "${k}"`);
      for (const [k, sub] of Object.entries(node.props)) {
        if (!(k in value)) {
          if (!node.optional.has(k)) fail(`missing "${k}"`);
          continue;
        }
        errs.push(...validate(value[k], sub, `${path}.${k}`));
      }
      break;
    }
    case 'oneOf': {
      const tries = node.alts.map((a) => validate(value, a, path));
      if (!tries.some((e) => !e.length)) {
        const best = tries.reduce((a, b) => (b.length < a.length ? b : a));
        errs.push(...best);
      }
      break;
    }
    default:
      throw new Error(`schema: unknown node type ${node.type}`);
  }
  return errs;
}

export const validateGapFile = (file) => validate(file, GAP_FILE);
export const validateGap = (g) => validate(g, GAP_RECORD);
