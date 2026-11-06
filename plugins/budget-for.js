// budget_for: what the City budgeted and spent, and what it budgeted and
// collected, for one department, one unit within it, or the whole City, by
// fiscal year, from the City's own financial system. Sources checked live on
// data.norfolk.gov on 2026-11-06 (ids and row counts are in the city
// profile's `budget` block):
//   - Annual Expenditures (mdwe-dquf): one line per fiscal year, department,
//     fund, unit and object, with actual_expenses ("Sum of fiscal year-to-date
//     expenditures") and current_expense_budget. Held FY2025-FY2027.
//   - Annual Revenues (id3i-2az4): total_collected and total_budgeted per
//     revenue source. Held FY2025-FY2027.
//   - Performance Measures (7jsp-eyjg): each department's measures, fy_2022
//     to fy_2027_target. Its department names differ from the budget's
//     ("Parks and Recreation" there, "The Department of Parks & Recreation
//     (P&R)" here), so each dataset is matched against its own names.
//
// The model supplies names and years only. A name is used in SoQL only after
// it matched a name the dataset itself returned (by a traced query), and then
// only that official spelling is quoted into a fixed template. A miss returns
// the closest names and runs nothing. Caveats are either quoted from the live
// metadata (checked against it on every run) or computed from the queries.

import { definePlugin } from '../src/plugins.js';
import { soqlString } from '../src/socrata.js';

export const TOP = 15;
// Tool results reach the model cut at 16,000 characters; stay well under.
export const MAX_CHARS = 12000;
const NONE = '(none recorded)';
const MAX_NAME = 120;

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const usd = (x) => Math.round(num(x));
const pct = (a, b) => (num(b) ? Math.round((num(a) / num(b)) * 1000) / 10 : null);
const settle = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: String(err?.message || err) };
  }
};

// ---------- names ----------

/** A spelling-insensitive key: case, "&" vs "and", punctuation, a parenthetical, a leading "The Department of". */
export function nameKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/^\s*(the\s+)?(department|dept\.?|office)\s+of\s+/, ' ')
    .replace(/^\s*the\s+/, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const words = (s) => new Set(String(s).toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'department', 'office'].includes(w)));

/** How alike two names are, 0 to 1: the better of edit similarity and shared words. */
export function similarity(a, b) {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return 0;
  const edit = 1 - editDistance(ka, kb) / Math.max(ka.length, kb.length);
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const overlap = wa.size && wb.size ? shared / Math.min(wa.size, wb.size) : 0;
  return Math.max(edit, overlap * 0.9);
}

export function closest(input, names, n = 5) {
  return [...new Set(names)]
    .map((name) => ({ name, s: similarity(input, name) }))
    .sort((x, y) => y.s - x.s || x.name.localeCompare(y.name))
    .slice(0, n)
    .map((x) => x.name);
}

/**
 * Match what the model typed against the names a dataset returned. Exact
 * (case-insensitive) first, then the spelling-insensitive key if it picks out
 * exactly one name. Returns { name } (the dataset's own spelling) or
 * { miss, closest }. Nothing the model typed is ever returned as `name`.
 */
export function matchName(input, names) {
  const want = String(input ?? '').trim();
  const list = [...new Set(names.filter((x) => typeof x === 'string' && x))];
  if (!want) return { miss: true, closest: [] };
  const exact = list.filter((x) => x.toLowerCase() === want.toLowerCase());
  if (exact.length === 1) return { name: exact[0] };
  const k = nameKey(want);
  const keyed = k ? list.filter((x) => nameKey(x) === k) : [];
  if (keyed.length === 1) return { name: keyed[0] };
  return { miss: true, closest: keyed.length > 1 ? keyed : closest(want, list) };
}

function checkText(v, field) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${field} must be text.`);
  if (v.length > MAX_NAME) throw new Error(`${field} is longer than ${MAX_NAME} characters; give the name as the City writes it.`);
  return v.trim() || null;
}

/** Fiscal years as integers the dataset holds. Throws, before any data query, on anything else. */
export function checkYears(input, held) {
  if (input == null) return [...held];
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) return [...held];
  for (const y of list) {
    if (!Number.isInteger(y)) throw new Error(`Fiscal years must be whole numbers like ${held.at(-1)}; got ${JSON.stringify(y)}.`);
    if (!held.includes(y)) throw new Error(`FY${y} is not in the dataset, which holds ${held.map((h) => `FY${h}`).join(', ')} today.`);
  }
  return [...new Set(list)].sort((a, b) => a - b);
}

// ---------- the calendar ----------

/** The fiscal year a date falls in, on a July 1 - June 30 year named for the June it ends in. */
export function fiscalYearOf(date = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date)
    .split('-')
    .map(Number);
  const fy = m >= 7 ? y + 1 : y;
  const start = Date.UTC(fy - 1, 6, 1);
  const end = Date.UTC(fy, 6, 1);
  const elapsed = Math.round(((Date.UTC(y, m - 1, d) - start) / (end - start)) * 1000) / 10;
  return { fiscal_year: fy, elapsed_pct: elapsed, today: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

// ---------- caveats from the live metadata ----------

const flat = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/** Quote the live description, or say it no longer says this. */
export function fromDescription(meta, quote, checked = '2026-11-06') {
  if (flat(meta?.description).includes(flat(quote))) return `The dataset's description says: "${quote}"`;
  return `On ${checked} the dataset's description said "${quote}"; today's description no longer does. Read the current one on the dataset page.`;
}

function fromColumn(meta, field, quote, checked = '2026-11-06') {
  const col = (meta?.columns || []).find((c) => c.field === field);
  if (col && flat(col.about).includes(flat(quote))) return `The column description for ${field} says: "${quote}"`;
  return `On ${checked} the column description for ${field} said "${quote}"; today's no longer does.`;
}

// Column descriptions arrive cut at 160 characters; quote only whole sentences.
function firstSentences(s) {
  const t = String(s || '').trim();
  const end = t.lastIndexOf('. ');
  return end > 0 ? t.slice(0, end + 1) : /\.$/.test(t) ? t : '';
}

function aboutDataset(meta) {
  return {
    name: meta.name,
    published_by: meta.department,
    rows_last_updated: meta.updated?.slice(0, 10) || null,
    update_frequency: meta.update_frequency,
  };
}

// ---------- shaping rows ----------

/** Pivot grouped rows ({k, c?, fy, actual, budget, lines}) into one row per name with a key per fiscal year. */
export function pivot(rows, years, { a = 'actual_usd', b = 'budget_usd', top = TOP, noun = 'rows', category = false } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    const fy = Number(r.fy);
    if (!years.includes(fy)) continue;
    const key = JSON.stringify([r.k ?? null, r.c ?? null]);
    // Socrata leaves null fields out of a row, so a missing k or c is a null.
    if (!byKey.has(key)) byKey.set(key, { name: r.k ?? NONE, ...(category ? { category: r.c ?? NONE } : {}), y: {} });
    byKey.get(key).y[fy] = { a: num(r.actual), b: num(r.budget) };
  }
  const last = years.at(-1);
  const all = [...byKey.values()].sort((p, q) => (q.y[last]?.b ?? 0) - (p.y[last]?.b ?? 0) || (q.y[last]?.a ?? 0) - (p.y[last]?.a ?? 0) || p.name.localeCompare(q.name));
  const shape = (x) => {
    const out = { name: x.name, ...(x.category !== undefined ? { category: x.category } : {}) };
    for (const fy of years) if (x.y[fy]) out[`FY${fy}`] = { [a]: usd(x.y[fy].a), [b]: usd(x.y[fy].b) };
    return out;
  };
  const shown = all.slice(0, top).map(shape);
  const rest = all.slice(top);
  const result = { total_rows: all.length, rows: shown };
  if (rest.length) {
    const more = { and_more: `and ${rest.length} more ${noun}` };
    for (const fy of years) {
      const s = rest.reduce((acc, x) => ({ a: acc.a + (x.y[fy]?.a || 0), b: acc.b + (x.y[fy]?.b || 0) }), { a: 0, b: 0 });
      more[`FY${fy}`] = { [a]: usd(s.a), [b]: usd(s.b) };
    }
    result.rest = more;
  }
  return result;
}

function byYear(rows, years, current, { a = 'actual_usd', b = 'budget_usd', ratio = 'actual_pct_of_budget' } = {}) {
  return years.map((fy) => {
    const r = rows.find((x) => Number(x.fy) === fy);
    if (!r || !num(r.lines)) return { fiscal_year: fy, lines: 0, note: `I found no lines for FY${fy} in this scope.` };
    const out = { fiscal_year: fy, [a]: usd(r?.actual), [b]: usd(r?.budget), [ratio]: pct(r?.actual, r?.budget), lines: num(r?.lines) };
    if (fy === current.fiscal_year) out.year_to_date = `FY${fy} is in progress: about ${current.elapsed_pct}% of it had elapsed on ${current.today}`;
    return out;
  });
}

/** Shrink the breakdowns until the result fits well under the model's cut. */
export function fit(rebuild) {
  for (const top of [TOP, 10, 6, 3]) {
    const r = rebuild(top);
    if (JSON.stringify(r).length <= MAX_CHARS) return top === TOP ? r : { ...r, rows_shown_per_breakdown: top };
  }
  return { ...rebuild(3), rows_shown_per_breakdown: 3 };
}

/** Groups in a result whose actual (or collected) amount is negative, as "name FYnnnn". */
export function negativeGroups(out) {
  const found = [];
  const scan = (section) => {
    for (const [key, v] of Object.entries(section || {})) {
      if (!key.startsWith('by_') || !v?.rows) continue;
      for (const r of [...v.rows, ...(v.rest ? [{ ...v.rest, name: v.rest.and_more }] : [])])
        for (const [fy, amt] of Object.entries(r)) if (/^FY\d{4}$/.test(fy) && ((amt.actual_usd ?? amt.collected_usd) < 0)) found.push(`${r.name} ${fy}`);
    }
  };
  scan(out.spending);
  scan(out.revenue);
  return found;
}

// ---------- SoQL templates ----------

const EXP_SUMS = 'count(*) AS lines, sum(actual_expenses) AS actual, sum(current_expense_budget) AS budget';
const REV_SUMS = 'count(*) AS lines, sum(total_collected) AS actual, sum(total_budgeted) AS budget';
const where = (parts) => (parts.length ? ` WHERE ${parts.join(' AND ')}` : '');
const yearsIn = (years) => `fiscal_year in (${years.map((y) => Number(y)).join(', ')})`;

export const SOQL = {
  expYears: `SELECT fiscal_year AS fy, ${EXP_SUMS} GROUP BY fiscal_year ORDER BY fiscal_year LIMIT 50`,
  expNames: 'SELECT department_name AS d, unit_name AS u, count(*) AS n GROUP BY department_name, unit_name ORDER BY department_name, unit_name LIMIT 500',
  revYears: `SELECT fiscal_year AS fy, ${REV_SUMS} GROUP BY fiscal_year ORDER BY fiscal_year LIMIT 50`,
  revNames: 'SELECT department_name AS d, unit_name AS u, count(*) AS n GROUP BY department_name, unit_name ORDER BY department_name, unit_name LIMIT 500',
  perfNames: 'SELECT department AS d, program_name AS p, count(*) AS n GROUP BY department, program_name ORDER BY department, program_name LIMIT 500',
  scope: (s, f = { d: 'department_name', u: 'unit_name' }) => [...(s.department ? [`${f.d} = ${soqlString(s.department)}`] : []), ...(s.unit ? [`${f.u} = ${soqlString(s.unit)}`] : [])],
  expByYear: (s, years) => `SELECT fiscal_year AS fy, ${EXP_SUMS}${where([...SOQL.scope(s), yearsIn(years)])} GROUP BY fiscal_year ORDER BY fiscal_year LIMIT 50`,
  expBreakdown: (s, years, dim) => {
    const cols = { department: 'department_name', unit: 'unit_name', category: 'expenditure_category', fund: 'fund_name' };
    if (dim === 'object') return `SELECT object_name AS k, expenditure_category AS c, fiscal_year AS fy, ${EXP_SUMS}${where([...SOQL.scope(s), yearsIn(years)])} GROUP BY object_name, expenditure_category, fiscal_year ORDER BY object_name, fiscal_year LIMIT 500`;
    const col = cols[dim];
    if (!col) throw new Error(`Unknown breakdown ${dim}.`);
    return `SELECT ${col} AS k, fiscal_year AS fy, ${EXP_SUMS}${where([...SOQL.scope(s), yearsIn(years)])} GROUP BY ${col}, fiscal_year ORDER BY ${col}, fiscal_year LIMIT 500`;
  },
  revByYear: (s, years) => `SELECT fiscal_year AS fy, ${REV_SUMS}${where([...SOQL.scope(s), yearsIn(years)])} GROUP BY fiscal_year ORDER BY fiscal_year LIMIT 50`,
  revBreakdown: (s, years) => {
    // Citywide, the revenue categories (14); within a department, its sources.
    const col = s.department ? 'revenue_source_name' : 'revenue_name';
    return `SELECT ${col} AS k, fiscal_year AS fy, ${REV_SUMS}${where([...SOQL.scope(s), yearsIn(years)])} GROUP BY ${col}, fiscal_year ORDER BY ${col}, fiscal_year LIMIT 500`;
  },
  perfMeasures: (department, program, fyCols) =>
    `SELECT program_name, measure_description, demand_level, ${fyCols.join(', ')}${where([`department = ${soqlString(department)}`, ...(program ? [`program_name = ${soqlString(program)}`] : [])])} ORDER BY program_name, measure_id LIMIT 100`,
};

// ---------- the pieces ----------

const EXP_QUOTES = [
  "The city's fiscal year runs July 1 to June 30.",
  'Current budget reflects budget transfers and amendments during the fiscal year that have transpired since City Council adopted the budget prior to the beginning of the current fiscal year.',
  '*Disclaimer: Expenditures will reflect the previous fiscal year’s activity until final entries have been made and the accounting period has been closed.',
];
const REV_QUOTES = [
  'This data also contains current budget information based on the revenue budget adopted by City Council ahead of each fiscal year.',
  '*Disclaimer: Revenues will reflect the previous fiscal year’s activity until final entries have been made and the accounting period has been closed.',
];

function heldYears(rows) {
  return rows.map((r) => Number(r.fy)).filter(Number.isInteger).sort((a, b) => a - b);
}

/** Resolve department and unit against a dataset's own (department, unit) pairs. */
export function resolveScope(pairs, { department, unit }, label) {
  const depts = [...new Set(pairs.map((p) => p.d).filter(Boolean))];
  const out = {};
  if (department) {
    const m = matchName(department, depts);
    if (m.miss) return { error: `I found no department matching "${department}" in ${label}.`, closest_departments: m.closest, hint: 'Ask again with one of these names.' };
    out.department = m.name;
  }
  if (unit) {
    const pool = pairs.filter((p) => p.u && (!out.department || p.d === out.department));
    const m = matchName(unit, pool.map((p) => p.u));
    if (m.miss) return { error: `I found no unit matching "${unit}"${out.department ? ` in ${out.department}` : ''} in ${label}.`, closest_units: m.closest, hint: 'Ask again with one of these names.' };
    const homes = [...new Set(pool.filter((p) => p.u === m.name).map((p) => p.d))];
    if (homes.length > 1) return { error: `The unit "${m.name}" appears under ${homes.length} departments in ${label}; name the department too.`, departments: homes };
    out.unit = m.name;
    out.department = homes[0];
  }
  return out;
}

async function spending(ctx, ds, args, current) {
  const opts = (tool) => ({ tool, name: ds.name });
  const meta = await ctx.socrata.describe(ds.id);
  const [yearRows, pairs] = await Promise.all([ctx.socrata.query(ds.id, SOQL.expYears, opts('expenditures: fiscal years held')), ctx.socrata.query(ds.id, SOQL.expNames, opts('expenditures: department and unit names'))]);
  const held = heldYears(yearRows);
  const years = checkYears(args.fiscal_years, held);
  const scope = resolveScope(pairs, args, ds.name);
  if (scope.error) return { scope, held, meta };
  const dims = scope.unit ? ['category', 'object'] : scope.department ? ['unit', 'category', 'fund'] : ['department', 'category', 'fund'];
  const [totals, ...parts] = await Promise.all([
    scope.department ? ctx.socrata.query(ds.id, SOQL.expByYear(scope, years), opts('expenditures: budget vs actual by fiscal year')) : Promise.resolve(yearRows),
    ...dims.map((d) => ctx.socrata.query(ds.id, SOQL.expBreakdown(scope, years, d), opts(`expenditures by ${d}`))),
  ]);
  const truncated = pairs.length >= 500 || parts.some((p) => p.length >= 500);
  return { scope, held, years, meta, totals, dims, parts, truncated, uncategorized: num(parts[dims.indexOf('category')]?.filter((r) => r.k == null).reduce((s, r) => s + num(r.lines), 0)) };
}

async function revenue(ctx, ds, scope, scopeYears) {
  const opts = (tool) => ({ tool, name: ds.name });
  const meta = await ctx.socrata.describe(ds.id);
  const [yearRows, pairs] = await Promise.all([ctx.socrata.query(ds.id, SOQL.revYears, opts('revenues: fiscal years held')), ctx.socrata.query(ds.id, SOQL.revNames, opts('revenues: department and unit names'))]);
  const held = heldYears(yearRows);
  // The years were already checked against the expenditures; keep those this dataset holds too.
  const years = (scopeYears || held).filter((y) => held.includes(y));
  const rs = {};
  if (scope.department) {
    // Match the budget's spelling first, then what was asked.
    const depts = [...new Set(pairs.map((p) => p.d))];
    const m = matchName(scope.department, depts);
    if (m.miss) return { meta, note: `I found no revenue lines under ${scope.department} in ${ds.name}.` };
    rs.department = m.name;
  }
  if (scope.unit) {
    const units = pairs.filter((p) => p.d === rs.department).map((p) => p.u);
    const m = matchName(scope.unit, units);
    if (m.miss) return { meta, note: `I found no revenue unit named ${scope.unit} under ${rs.department} in ${ds.name}. Its revenue units: ${units.join('; ') || 'none'}.` };
    rs.unit = m.name;
  }
  if (!years.length) return { meta, note: `${ds.name} holds none of the fiscal years asked for.` };
  const [totals, parts] = await Promise.all([
    rs.department ? ctx.socrata.query(ds.id, SOQL.revByYear(rs, years), opts('revenues: budget vs collected by fiscal year')) : Promise.resolve(yearRows),
    ctx.socrata.query(ds.id, SOQL.revBreakdown(rs, years), opts(rs.department ? 'revenues by source' : 'revenues by category')),
  ]);
  return { meta, held, years, scope: rs, totals, parts, truncated: parts.length >= 500 };
}

export function perfValue(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  // Per the dataset's column descriptions: 99999 = "Yes" and 99998 = "No".
  if (n === 99999) return 'Yes';
  if (n === 99998) return 'No';
  return Number.isFinite(n) ? n : v;
}

const fyLabel = (field) => field.replace(/^fy_(\d{4})_?/, 'FY$1 ').replace(/_/g, ' ').trim();

async function performance(ctx, ds, asked, matched) {
  const opts = (tool) => ({ tool, name: ds.name });
  const meta = await ctx.socrata.describe(ds.id);
  if (!asked.department && !matched.department) return { meta, error: 'Performance measures are kept per department; name a department to see them.' };
  const pairs = await ctx.socrata.query(ds.id, SOQL.perfNames, opts('performance measures: departments and programs'));
  const depts = [...new Set(pairs.map((p) => p.d).filter(Boolean))];
  let m = matched.department ? matchName(matched.department, depts) : { miss: true, closest: [] };
  if (m.miss && asked.department) m = matchName(asked.department, depts);
  if (m.miss) return { meta, error: `I found no department in ${ds.name} matching "${asked.department || matched.department}".`, closest_departments: closest(asked.department || matched.department || '', depts), hint: 'Ask again with performance_department set to one of these names.' };
  const programs = pairs.filter((p) => p.d === m.name).map((p) => p.p);
  const prog = matched.unit ? matchName(matched.unit, programs) : null;
  const fyCols = (meta.columns || []).map((c) => c.field).filter((f) => /^fy_\d{4}(_[a-z]+)?$/.test(f));
  if (!fyCols.length) return { meta, error: `I found no fiscal-year columns in ${ds.name}.` };
  const rows = await ctx.socrata.query(ds.id, SOQL.perfMeasures(m.name, prog?.name, fyCols), opts('performance measures'));
  const shape = (r) => {
    const values = {};
    for (const f of fyCols) {
      const v = perfValue(r[f]);
      if (v != null) values[fyLabel(f)] = v;
    }
    return { program: r.program_name, measure: r.measure_description, demand_level: r.demand_level || NONE, values };
  };
  return {
    meta,
    fyCols,
    department_matched: m.name,
    ...(prog?.name ? { program_matched: prog.name } : matched.unit ? { note: `I found no program named ${matched.unit} in ${m.name}'s measures, so these are all of its measures.` } : {}),
    measures: rows.map(shape),
  };
}

export default definePlugin({
  name: 'budget_for',
  cities: ['norfolk'],
  description:
    "What Norfolk budgeted and actually spent, and budgeted and collected in revenue, from the City's own financial system (Annual Expenditures and Annual Revenues, Department of Budget and Strategic Planning), for one department, one unit within a department, or the whole City, by fiscal year. Gives budget vs actual per fiscal year, the units within a department (or departments citywide), expense categories, funds, the objects (line items such as Other Contractual Services) within a unit, revenue by source, and on request the department's performance measures (past values, projection, adopted and target). Names are matched against the City's own lists; on a miss it returns the closest names. Use for questions like what the City spends on forestry, policing or parks, whether a department spent what it budgeted, or where its money comes from. For capital projects use capital_projects.",
  parameters: {
    type: 'object',
    properties: {
      department: { type: 'string', description: 'A department as the City names it, e.g. "Public Works" or "Parks and Recreation". Leave out (and unit too) for the whole City.' },
      unit: { type: 'string', description: 'A unit/division within a department, e.g. "Park and Forestry Operations". The department is found from it if it is unique.' },
      fiscal_years: { type: 'array', items: { type: 'integer' }, maxItems: 6, description: 'Fiscal years, e.g. [2026]. Leave out for every year the data holds.' },
      include_revenue: { type: 'boolean', description: 'Include revenue (default true).' },
      include_performance: { type: 'boolean', description: "Include the department's performance measures (default false)." },
      performance_department: { type: 'string', description: 'The department as Performance Measures names it, only if the first try returned closest_departments for performance.' },
    },
    additionalProperties: false,
  },

  async run(ctx, args = {}) {
    let a;
    try {
      a = {
        department: checkText(args.department, 'department'),
        unit: checkText(args.unit, 'unit'),
        fiscal_years: args.fiscal_years == null ? null : Array.isArray(args.fiscal_years) ? args.fiscal_years : [args.fiscal_years],
        performance_department: checkText(args.performance_department, 'performance_department'),
      };
    } catch (err) {
      return { error: err.message };
    }
    const reg = ctx.city.budget;
    const current = fiscalYearOf(new Date());

    let exp;
    try {
      exp = await spending(ctx, reg.expenditures, a, current);
    } catch (err) {
      return { error: String(err?.message || err) };
    }
    if (exp.scope.error) return { ...exp.scope, fiscal_years_held: exp.held };
    const { scope, years } = exp;

    const wantRevenue = args.include_revenue !== false;
    const [rev, perf] = await Promise.all([
      wantRevenue ? settle(() => revenue(ctx, reg.revenues, scope, a.fiscal_years ? years : null)) : null,
      args.include_performance ? settle(() => performance(ctx, reg.performance, { department: a.performance_department || a.department }, a.performance_department ? { department: a.performance_department } : scope)) : null,
    ]);

    const nouns = { department: 'departments', unit: 'units', category: 'expense categories', fund: 'funds', object: 'objects' };
    const notes = (out_) => {
      const n = [
        ...EXP_QUOTES.map((q) => fromDescription(exp.meta, q)),
        fromColumn(exp.meta, 'actual_expenses', 'Sum of fiscal year-to-date expenditures'),
        `${reg.expenditures.name} holds ${exp.held.map((y) => `FY${y}`).join(', ')} today, so nothing earlier can be compared from it.`,
        `Today (${current.today}, America/New_York) falls in FY${current.fiscal_year} on that July 1 - June 30 year, so FY${current.fiscal_year} figures are year to date, not a full year.`,
        "The dataset doesn't say whether FY" + (current.fiscal_year - 1) + "'s accounting period has been closed, whether any year's figures are audited, or whether money moved between the City's funds is counted once or in each fund it passes through; read citywide totals across all funds with that in mind.",
        'All amounts are rounded to whole dollars. A fiscal year missing from a row means I found no lines for it that year.',
      ];
      const negatives = negativeGroups(out_);
      if (negatives.length) n.push(`I found negative actual amounts in ${negatives.length} of the groups above (${negatives.slice(0, 3).join('; ')}${negatives.length > 3 ? '; ...' : ''}). The dataset doesn't say what a negative line records.`);
      if (exp.uncategorized) n.push(`${exp.uncategorized} of the lines in this answer have no expense category; they are listed as "${NONE}".`);
      if (exp.truncated || rev?.truncated) n.push('A breakdown reached the 500-group query limit, so it may be incomplete; the CSV links in the hand-off have every line.');
      if (rev && !rev.error) {
        n.push(...REV_QUOTES.map((q) => fromDescription(rev.meta, q)));
        n.push(fromColumn(rev.meta, 'total_collected', 'Amount of revenue collected fiscal year-to-date (YTD)'));
        n.push("The dataset doesn't say how the revenue recorded under a department or unit relates to the money that pays for its spending.");
      }
      if (perf?.measures) {
        n.push(fromColumn(perf.meta, 'demand_level', 'Details whether a program has the resources necessary to meet the established standard for each service.'));
        const proj = perf.fyCols.find((f) => /projection/.test(f));
        const about = firstSentences(perf.meta.columns.find((c) => c.field === proj)?.about);
        if (proj && about) n.push(`The column description for ${proj} says: "${about}"`);
        n.push('Performance values of 99999 and 99998 are shown as Yes and No, as the column descriptions define them.');
        n.push(`Performance Measures rows were last updated ${perf.meta.updated?.slice(0, 10) || 'on a date its metadata does not give'}; its metadata gives no update frequency.`);
      }
      return n;
    };

    const build = (top) => {
      const out = {
        scope: scope.unit ? { department: scope.department, unit: scope.unit } : scope.department ? { department: scope.department } : { whole_city: true },
        ...(a.department && a.department !== scope.department ? { matched_from: { department: a.department, ...(a.unit ? { unit: a.unit } : {}) } } : a.unit && a.unit !== scope.unit ? { matched_from: { unit: a.unit } } : {}),
        current_fiscal_year: current,
        spending: {
          source: aboutDataset(exp.meta),
          by_fiscal_year: byYear(exp.totals, years, current),
        },
      };
      exp.dims.forEach((d, i) => {
        out.spending[`by_${d}`] = pivot(exp.parts[i], years, { top, noun: nouns[d], category: d === 'object' });
      });
      if (rev) {
        if (rev.error || rev.note) out.revenue = { ...(rev.error ? { error: rev.error } : { note: rev.note }) };
        else {
          out.revenue = {
            source: aboutDataset(rev.meta),
            ...(rev.scope.department && rev.scope.department !== scope.department ? { department_matched: rev.scope.department } : {}),
            by_fiscal_year: byYear(rev.totals, rev.years, current, { a: 'collected_usd', b: 'budgeted_usd', ratio: 'collected_pct_of_budget' }),
            [rev.scope.department ? 'by_source' : 'by_category']: pivot(rev.parts, rev.years, { a: 'collected_usd', b: 'budgeted_usd', top, noun: rev.scope.department ? 'revenue sources' : 'revenue categories' }),
          };
        }
      }
      if (perf) {
        if (perf.error) out.performance = { error: perf.error, ...(perf.closest_departments ? { closest_departments: perf.closest_departments, hint: perf.hint } : {}) };
        else {
          const shown = perf.measures.slice(0, Math.max(top, 6));
          out.performance = {
            source: aboutDataset(perf.meta),
            department_matched: perf.department_matched,
            ...(perf.program_matched ? { program_matched: perf.program_matched } : {}),
            ...(perf.note ? { note: perf.note } : {}),
            measures: shown,
            ...(perf.measures.length > shown.length ? { and_more: `and ${perf.measures.length - shown.length} more measures` } : {}),
          };
        }
      }
      out.about_the_data = notes(out);
      return out;
    };
    return fit(build);
  },
});
