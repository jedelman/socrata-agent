// budget_for: what the City budgeted and spent, and what it budgeted and
// collected, for one department, one unit within it, up to four departments
// side by side, or the whole City, by fiscal year, from the City's own
// financial system. Sources checked live on data.norfolk.gov on 2026-11-06
// (ids and row counts are in the city profile's `budget` block):
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
//
// Subrequests: Workers Free allows 50 external subrequests per invocation,
// and a whole chat turn (model calls included) is one invocation. So the name
// and year lists and the three describes are fetched once per call and shared
// by every department in it, and the per-year totals are summed from the
// category breakdown instead of a query of their own. A department with
// performance measures costs 12 requests; each further department in
// `departments` costs 4.

import { definePlugin } from '../src/plugins.js';
import { soqlString } from '../src/socrata.js';

export const TOP = 15;
// Tool results reach the model cut at 16,000 characters; stay well under.
export const MAX_CHARS = 12000;
export const MAX_DEPARTMENTS = 4;
const NONE = '(none recorded)';
// The longest department or unit name on 2026-11-06 was 58 characters.
const MAX_NAME = 80;
// Edit distance compares at most this much of each name's key, which keeps a
// miss to about 2 ms of CPU (Node, 2026-11-06) against the 351 live names.
const KEY_CAP = 32;
// core's describe() hands plugins the first 1,200 characters of a dataset's
// description and the first 160 of each column's (src/socrata.js).
const DESCRIPTION_CUT = 1200;
const COLUMN_CUT = 160;
// How alike a name must be (0 to 1) to be offered as a possible earlier or
// later name for a unit or department.
const SIMILAR = 0.8;

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const usd = (x) => Math.round(num(x));
const pct = (a, b) => (num(b) ? Math.round((num(a) / num(b)) * 1000) / 10 : null);
const money = (x) => `$${(num(x) / 1e6).toFixed(1)}M`;
const fyList = (ys) => ys.map((y) => `FY${y}`).join(', ');
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
  const prev = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      const sub = diag + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = up + 1;
      const ins = prev[j - 1] + 1;
      prev[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
      diag = up;
    }
  }
  return prev[b.length];
}

const words = (s) => new Set(String(s).toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'department', 'office'].includes(w)));

const prepare = (s) => (typeof s === 'object' && s ? s : { key: nameKey(s).slice(0, KEY_CAP), words: words(s) });

/** How alike two names are, 0 to 1: the better of edit similarity (on the first KEY_CAP characters of each key) and shared words. */
export function similarity(a, b) {
  const pa = prepare(a);
  const pb = prepare(b);
  if (!pa.key || !pb.key) return 0;
  if (pa.key === pb.key) return 1;
  const shared = [...pa.words].filter((w) => pb.words.has(w)).length;
  const overlap = pa.words.size && pb.words.size ? (shared / Math.min(pa.words.size, pb.words.size)) * 0.9 : 0;
  return Math.max(1 - editDistance(pa.key, pb.key) / Math.max(pa.key.length, pb.key.length), overlap);
}

export function closest(input, names, n = 5) {
  const pi = prepare(input);
  return [...new Set(names)]
    .map((name) => ({ name, s: similarity(pi, name) }))
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
    if (!held.includes(y)) throw new Error(`FY${y} is not in the dataset, which holds ${fyList(held)} today.`);
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

/** Quote the live description, or say it no longer says this (or that the line may sit past the part Siren reads). */
export function fromDescription(meta, quote, checked = '2026-11-06') {
  const d = String(meta?.description ?? '');
  if (flat(d).includes(flat(quote))) return `The dataset's description says: "${quote}"`;
  if (d.length >= DESCRIPTION_CUT) return `On ${checked} the dataset's description said "${quote}". I couldn't find this line in the first ${DESCRIPTION_CUT} characters of today's description, which is all I read; the full description is on the dataset page.`;
  return `On ${checked} the dataset's description said "${quote}"; today's description no longer does. Read the current one on the dataset page.`;
}

/** Quote a live column description in full (marked where core cut it), or say it no longer says this. */
export function fromColumn(meta, field, quote, checked = '2026-11-06') {
  const raw = String((meta?.columns || []).find((c) => c.field === field)?.about ?? '');
  const about = raw.trim();
  const cut = raw.length >= COLUMN_CUT;
  if (about && flat(about).includes(flat(quote))) {
    if (!cut) return `The column description for ${field} says: "${about}"`;
    return `The column description for ${field} says, in part: "${flat(about).startsWith(flat(quote)) ? '' : '… '}${quote} …"`;
  }
  if (cut) return `On ${checked} the column description for ${field} said "${quote}". I couldn't find this in the first ${COLUMN_CUT} characters of today's, which is all I read.`;
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

/** Per-year totals ({fy, lines, actual, budget}) summed from a breakdown that holds every line of the scope. */
export function sumByYear(rows) {
  const m = new Map();
  for (const r of rows) {
    const fy = Number(r.fy);
    const t = m.get(fy) || { fy, lines: 0, actual: 0, budget: 0 };
    t.lines += num(r.lines);
    t.actual += num(r.actual);
    t.budget += num(r.budget);
    m.set(fy, t);
  }
  return [...m.values()].sort((p, q) => p.fy - q.fy);
}

function byYear(rows, years, current, { a = 'actual_usd', b = 'budget_usd', ratio = 'actual_pct_of_budget', brief = false } = {}) {
  return years.map((fy) => {
    const r = rows.find((x) => Number(x.fy) === fy);
    if (!r || !num(r.lines)) return { fiscal_year: fy, lines: 0, note: `I found no lines for FY${fy} in this scope.` };
    const out = { fiscal_year: fy, [a]: usd(r.actual), [b]: usd(r.budget), [ratio]: pct(r.actual, r.budget), lines: num(r.lines) };
    if (fy === current.fiscal_year) out.year_to_date = brief ? true : `FY${fy} is in progress: about ${current.elapsed_pct}% of it had elapsed on ${current.today}`;
    return out;
  });
}

/** Shrink the breakdowns until the result fits well under the model's cut. */
export function fit(rebuild, tops = [TOP, 10, 6, 3]) {
  for (const top of tops) {
    const r = rebuild(top);
    if (JSON.stringify(r).length <= MAX_CHARS) return top === TOP ? r : { ...r, rows_shown_per_breakdown: top };
  }
  const top = tops.at(-1);
  return { ...rebuild(top), rows_shown_per_breakdown: top };
}

/** Groups whose actual (or collected) amount is negative in a year, over every row of a breakdown, before any are folded into "and N more". */
export function negativeGroups(rows, years) {
  return rows.filter((r) => years.includes(Number(r.fy)) && num(r.actual) < 0).map((r) => ({ name: r.k ?? NONE, fy: Number(r.fy) }));
}

/**
 * For each fiscal year before the current one, the few groups that make up
 * most of the citywide gap between budget and actual (or collected).
 */
export function gapNotes(rows, totals, years, currentFy, { budget, actual, group }) {
  const out = [];
  for (const fy of years.filter((y) => y < currentFy)) {
    const t = totals.find((r) => Number(r.fy) === fy);
    const gap = t ? num(t.budget) - num(t.actual) : 0;
    if (gap <= 0) continue;
    const groups = rows
      .filter((r) => Number(r.fy) === fy)
      .map((r) => ({ name: r.k ?? NONE, gap: num(r.budget) - num(r.actual), lines: num(r.lines) }))
      .filter((g) => g.gap > 0)
      .sort((p, q) => q.gap - p.gap);
    // Name up to three groups, largest first, until they make up half the gap; each must hold a tenth of it.
    const named = [];
    let sum = 0;
    for (const g of groups) {
      if (named.length >= 3 || sum >= gap / 2 || g.gap < gap / 10) break;
      named.push(g);
      sum += g.gap;
    }
    const parts = named.map((g) => `${g.name} (${g.lines} line${g.lines === 1 ? '' : 's'}) is ${money(g.gap)} below its budget (${Math.round((g.gap / gap) * 100)}% of the net gap)`);
    out.push(`Citywide, FY${fy} ${budget} exceeds ${actual} by ${money(gap)}, net. ${parts.length ? `By ${group}, ${parts.join('; ')}.` : `I found no single ${group} below its budget by a tenth of that.`} The dataset doesn't explain the gap.`);
  }
  return out;
}

/**
 * Names that come and go between fiscal years, computed from the (department,
 * unit) list with its per-year line counts. For the scope, and for each unit
 * of a department, it lists the years with lines when that isn't every year
 * asked, and for each missing year the similar names that do have lines then
 * (and are missing in a year the scope has lines). It never asserts a
 * transfer; the dataset doesn't record one.
 */
export function reorgNotes(pairs, scope, years, maxUnits = 5) {
  if (!scope.department || years.length < 2) return [];
  const yearsOf = (p) => years.filter((y) => num(p[`n${y}`]) > 0);
  const similarIn = (name, self, present, y) => {
    const target = prepare(name);
    const found = [];
    for (const p of pairs) {
      if (self(p) || !num(p[`n${y}`])) continue;
      if (!present.some((py) => !num(p[`n${py}`]))) continue;
      if (similarity(target, p.d) >= SIMILAR || (p.u && similarity(target, p.u) >= SIMILAR)) found.push(`${p.d} / ${p.u ?? NONE}`);
    }
    return found;
  };
  const describe = (label, target, self, present) => {
    const missing = years.filter((y) => !present.includes(y));
    const hints = missing
      .map((y) => {
        const s = similarIn(target, self, present, y);
        if (!s.length) return '';
        // A name many departments share (e.g. a citywide reorganization of units) is counted, not listed.
        return s.length > 3 ? `in FY${y} I found ${s.length} similar names elsewhere in the dataset, e.g. ${s[0]} (department / unit)` : `in FY${y} I found similar names elsewhere in the dataset (department / unit): ${s.join('; ')}`;
      })
      .filter(Boolean);
    return `${label} has lines in ${fyList(present)} only${hints.length ? `; ${hints.join('; ')}` : ''}.`;
  };
  const out = [];
  const inScope = pairs.filter((p) => p.d === scope.department && (!scope.unit || p.u === scope.unit));
  const present = years.filter((y) => inScope.some((p) => num(p[`n${y}`]) > 0));
  if (present.length && present.length < years.length) {
    out.push(describe(scope.unit ? `The unit ${scope.unit}` : scope.department, scope.unit || scope.department, (p) => p.d === scope.department && (!scope.unit || p.u === scope.unit), present));
  }
  if (!scope.unit) {
    const partial = inScope.filter((p) => {
      const ys = yearsOf(p);
      return ys.length && ys.length < present.length;
    });
    for (const p of partial.slice(0, maxUnits)) out.push(describe(`The unit ${p.u ?? NONE}`, p.u ?? '', (x) => x === p, yearsOf(p)));
    if (partial.length > maxUnits) out.push(`${partial.length - maxUnits} more units of ${scope.department} have lines in only some of these years.`);
  }
  if (out.length) out.push("The dataset doesn't say whether a unit or department was renamed, moved or closed, so compare these years with that in mind.");
  return out;
}

// ---------- SoQL templates ----------

const EXP_SUMS = 'count(*) AS lines, sum(actual_expenses) AS actual, sum(current_expense_budget) AS budget';
const REV_SUMS = 'count(*) AS lines, sum(total_collected) AS actual, sum(total_budgeted) AS budget';
const where = (parts) => (parts.length ? ` WHERE ${parts.join(' AND ')}` : '');
const yearsIn = (years) => `fiscal_year in (${years.map((y) => Number(y)).join(', ')})`;

export const SOQL = {
  expYears: `SELECT fiscal_year AS fy, ${EXP_SUMS} GROUP BY fiscal_year ORDER BY fiscal_year LIMIT 50`,
  // One row per (department, unit) with its line count in each held year; the years come from the dataset itself.
  expNames: (held) =>
    `SELECT department_name AS d, unit_name AS u, ${held.map((y) => `sum(case(fiscal_year = ${Number(y)}, 1, true, 0)) AS n${Number(y)}`).join(', ')} GROUP BY department_name, unit_name ORDER BY department_name, unit_name LIMIT 500`,
  revYears: `SELECT fiscal_year AS fy, ${REV_SUMS} GROUP BY fiscal_year ORDER BY fiscal_year LIMIT 50`,
  revNames: 'SELECT department_name AS d, unit_name AS u, count(*) AS n GROUP BY department_name, unit_name ORDER BY department_name, unit_name LIMIT 500',
  perfNames: 'SELECT department AS d, program_name AS p, count(*) AS n GROUP BY department, program_name ORDER BY department, program_name LIMIT 500',
  scope: (s, f = { d: 'department_name', u: 'unit_name' }) => [...(s.department ? [`${f.d} = ${soqlString(s.department)}`] : []), ...(s.unit ? [`${f.u} = ${soqlString(s.unit)}`] : [])],
  expBreakdown: (s, years, dim) => {
    const cols = { department: 'department_name', unit: 'unit_name', category: 'expenditure_category', fund: 'fund_name' };
    if (dim === 'object') return `SELECT object_name AS k, expenditure_category AS c, fiscal_year AS fy, ${EXP_SUMS}${where([...SOQL.scope(s), yearsIn(years)])} GROUP BY object_name, expenditure_category, fiscal_year ORDER BY object_name, fiscal_year LIMIT 500`;
    const col = cols[dim];
    if (!col) throw new Error(`Unknown breakdown ${dim}.`);
    return `SELECT ${col} AS k, fiscal_year AS fy, ${EXP_SUMS}${where([...SOQL.scope(s), yearsIn(years)])} GROUP BY ${col}, fiscal_year ORDER BY ${col}, fiscal_year LIMIT 500`;
  },
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
    if (m.miss) {
      // The name may be a unit's (e.g. "forestry"); offer those from the same list.
      const units = closest(department, pairs.map((p) => p.u).filter(Boolean), 3).map((u) => ({ unit: u, departments: [...new Set(pairs.filter((p) => p.u === u).map((p) => p.d))] }));
      return { error: `I found no department matching "${department}" in ${label}.`, closest_departments: m.closest, closest_units: units, hint: 'Ask again with one of these department names, or ask for one of the closest units as unit.' };
    }
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

const opts = (ds) => (tool) => ({ tool, name: ds.name });

/** What every scope in a call shares: the metadata, the years held, and the (department, unit) list with per-year counts. */
async function spendingShared(ctx, ds, askedYears) {
  const o = opts(ds);
  const meta = await ctx.socrata.describe(ds.id);
  const yearRows = await ctx.socrata.query(ds.id, SOQL.expYears, o('expenditures: fiscal years held'));
  const held = heldYears(yearRows);
  if (!held.length) throw new Error(`I found no fiscal years in ${ds.name}.`);
  const years = checkYears(askedYears, held);
  const pairs = await ctx.socrata.query(ds.id, SOQL.expNames(held), o('expenditures: department and unit names by fiscal year'));
  return { meta, yearRows, held, years, pairs };
}

async function spendingFor(ctx, ds, shared, scope, compare) {
  const o = opts(ds);
  const { years } = shared;
  const dims = scope.unit ? ['category', 'object'] : scope.department ? (compare ? ['unit', 'category'] : ['unit', 'category', 'fund']) : ['department', 'category', 'fund'];
  const parts = await Promise.all(dims.map((d) => ctx.socrata.query(ds.id, SOQL.expBreakdown(scope, years, d), o(`expenditures by ${d}`))));
  const byCategory = parts[dims.indexOf('category')];
  return {
    dims,
    parts,
    // Every line of the scope is in exactly one expense category (or none), so its per-year sums are the scope's totals.
    totals: scope.department ? sumByYear(byCategory) : shared.yearRows,
    truncated: parts.some((p) => p.length >= 500),
    uncategorized: byCategory.filter((r) => r.k == null).reduce((s, r) => s + num(r.lines), 0),
  };
}

async function revenueShared(ctx, ds, scoped) {
  const o = opts(ds);
  const meta = await ctx.socrata.describe(ds.id);
  if (scoped) return { meta, pairs: await ctx.socrata.query(ds.id, SOQL.revNames, o('revenues: department and unit names')) };
  const yearRows = await ctx.socrata.query(ds.id, SOQL.revYears, o('revenues: fiscal years held'));
  return { meta, yearRows, held: heldYears(yearRows) };
}

async function revenueFor(ctx, ds, shared, scope, scopeYears) {
  const rs = {};
  if (scope.department) {
    // Match the budget's spelling against the revenue dataset's own names.
    const m = matchName(scope.department, [...new Set(shared.pairs.map((p) => p.d))]);
    if (m.miss) return { note: `I found no revenue lines under ${scope.department} in ${ds.name}.` };
    rs.department = m.name;
  }
  if (scope.unit) {
    const units = shared.pairs.filter((p) => p.d === rs.department).map((p) => p.u);
    const m = matchName(scope.unit, units);
    if (m.miss) return { note: `I found no revenue unit named ${scope.unit} under ${rs.department} in ${ds.name}. Its revenue units: ${units.join('; ') || 'none'}.` };
    rs.unit = m.name;
  }
  const years = shared.held ? scopeYears.filter((y) => shared.held.includes(y)) : scopeYears;
  if (!years.length) return { note: `${ds.name} holds none of the fiscal years asked for.` };
  const parts = await ctx.socrata.query(ds.id, SOQL.revBreakdown(rs, years), opts(ds)(rs.department ? 'revenues by source' : 'revenues by category'));
  return { years, scope: rs, totals: rs.department ? sumByYear(parts) : shared.yearRows, parts, truncated: parts.length >= 500 };
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

async function performanceShared(ctx, ds) {
  const meta = await ctx.socrata.describe(ds.id);
  const pairs = await ctx.socrata.query(ds.id, SOQL.perfNames, opts(ds)('performance measures: departments and programs'));
  const fyCols = (meta.columns || []).map((c) => c.field).filter((f) => /^fy_\d{4}(_[a-z]+)?$/.test(f));
  return { meta, pairs, fyCols };
}

async function performanceFor(ctx, ds, shared, asked, matched) {
  const depts = [...new Set(shared.pairs.map((p) => p.d).filter(Boolean))];
  let m = matched.department ? matchName(matched.department, depts) : { miss: true, closest: [] };
  if (m.miss && asked.department) m = matchName(asked.department, depts);
  if (m.miss) return { error: `I found no department in ${ds.name} matching "${asked.department || matched.department}".`, closest_departments: closest(asked.department || matched.department || '', depts), hint: 'Ask again with performance_department set to one of these names.' };
  const programs = shared.pairs.filter((p) => p.d === m.name).map((p) => p.p);
  const prog = matched.unit ? matchName(matched.unit, programs) : null;
  if (!shared.fyCols.length) return { error: `I found no fiscal-year columns in ${ds.name}.` };
  const rows = await ctx.socrata.query(ds.id, SOQL.perfMeasures(m.name, prog?.name, shared.fyCols), opts(ds)('performance measures'));
  const shape = (r) => {
    const values = {};
    for (const f of shared.fyCols) {
      const v = perfValue(r[f]);
      if (v != null) values[fyLabel(f)] = v;
    }
    return { program: r.program_name, measure: r.measure_description, demand_level: r.demand_level || NONE, values };
  };
  return {
    department_matched: m.name,
    ...(prog?.name ? { program_matched: prog.name } : matched.unit ? { note: `I found no program named ${matched.unit} in ${m.name}'s measures, so these are all of its measures.` } : {}),
    measures: rows.map(shape),
  };
}

function parseArgs(args) {
  const a = {
    department: checkText(args.department, 'department'),
    unit: checkText(args.unit, 'unit'),
    fiscal_years: args.fiscal_years == null ? null : Array.isArray(args.fiscal_years) ? args.fiscal_years : [args.fiscal_years],
    performance_department: checkText(args.performance_department, 'performance_department'),
    departments: null,
  };
  if (args.departments != null) {
    if (!Array.isArray(args.departments)) throw new Error('departments must be a list of department names.');
    if (args.departments.length > MAX_DEPARTMENTS) throw new Error(`departments takes at most ${MAX_DEPARTMENTS} names; ask about the rest in another call.`);
    const list = args.departments.map((d, i) => checkText(d, `departments[${i}]`)).filter(Boolean);
    if (list.length) a.departments = list;
  }
  if (a.departments && (a.department || a.unit)) throw new Error('Give either department (and unit) or departments, not both.');
  if (a.departments && a.departments.length > 1 && a.performance_department) throw new Error('performance_department works with one department; with departments, each name is matched against Performance Measures on its own.');
  return a;
}

export default definePlugin({
  name: 'budget_for',
  cities: ['norfolk'],
  description:
    "What Norfolk budgeted and actually spent, and budgeted and collected in revenue, from the City's own financial system (Annual Expenditures and Annual Revenues), for one department, one unit within a department, up to four departments side by side, or the whole City, by fiscal year. Gives budget vs actual per fiscal year, the units within a department (or departments citywide), expense categories, funds, the objects (line items such as Other Contractual Services) within a unit, revenue by source, and on request the department's performance measures (past values, projection, adopted and target). Names are matched against the City's own lists; on a miss it returns the closest names. Use for questions like what the City spends on forestry, policing or parks, whether a department spent what it budgeted, or where its money comes from; to compare departments, pass them together in departments. For capital projects use capital_projects.",
  parameters: {
    type: 'object',
    properties: {
      department: { type: 'string', description: 'A department as the City names it, e.g. "Public Works" or "Parks and Recreation". Leave out (and unit and departments too) for the whole City.' },
      unit: { type: 'string', description: 'A unit/division within a department, e.g. "Park and Forestry Operations". The department is found from it if it is unique.' },
      departments: { type: 'array', items: { type: 'string' }, maxItems: MAX_DEPARTMENTS, description: 'To compare departments in one call, up to four department names. Use instead of department.' },
      fiscal_years: { type: 'array', items: { type: 'integer' }, maxItems: 6, description: 'Fiscal years, e.g. [2026]. Leave out for every year the data holds.' },
      include_revenue: { type: 'boolean', description: 'Include revenue (default true).' },
      include_performance: { type: 'boolean', description: "Include each department's performance measures (default false)." },
      performance_department: { type: 'string', description: 'The department as Performance Measures names it, only if the first try returned closest_departments for performance.' },
    },
    additionalProperties: false,
  },

  async run(ctx, args = {}) {
    let a;
    try {
      a = parseArgs(args);
    } catch (err) {
      return { error: err.message };
    }
    const reg = ctx.city.budget;
    const current = fiscalYearOf(new Date());
    const asks = a.departments ? a.departments.map((department) => ({ department })) : [{ department: a.department, unit: a.unit }];

    let shared;
    try {
      shared = await spendingShared(ctx, reg.expenditures, a.fiscal_years);
    } catch (err) {
      return { error: String(err?.message || err) };
    }
    const { years } = shared;
    const resolved = asks.map((ask) => resolveScope(shared.pairs, ask, reg.expenditures.name));
    const miss = resolved.find((s) => s.error);
    if (miss) return { ...miss, fiscal_years_held: shared.held };
    // Two names that resolve to the same department are asked about once.
    const seen = new Set();
    const items = resolved
      .map((scope, i) => ({ scope, ask: asks[i] }))
      .filter(({ scope }) => {
        const k = JSON.stringify([scope.department ?? null, scope.unit ?? null]);
        return seen.has(k) ? false : seen.add(k);
      });
    const compare = items.length > 1;
    const scoped = Boolean(items[0].scope.department);

    const wantRevenue = args.include_revenue !== false;
    const wantPerf = Boolean(args.include_performance);
    let exp, revS, perfS;
    try {
      [exp, revS, perfS] = await Promise.all([
        Promise.all(items.map(({ scope }) => spendingFor(ctx, reg.expenditures, shared, scope, compare))),
        wantRevenue ? settle(() => revenueShared(ctx, reg.revenues, scoped)) : null,
        wantPerf && scoped ? settle(() => performanceShared(ctx, reg.performance)) : null,
      ]);
    } catch (err) {
      return { error: String(err?.message || err) };
    }
    const extras = await Promise.all(
      items.map(({ scope, ask }) =>
        Promise.all([
          !wantRevenue ? null : revS.error ? revS : settle(() => revenueFor(ctx, reg.revenues, revS, scope, years)),
          !wantPerf
            ? null
            : !scoped
              ? { error: 'Performance measures are kept per department; name a department to see them.' }
              : perfS.error
                ? perfS
                : settle(() => performanceFor(ctx, reg.performance, perfS, { department: a.performance_department || ask.department }, a.performance_department ? { department: a.performance_department } : scope)),
        ])
      )
    );

    const nouns = { department: 'departments', unit: 'units', category: 'expense categories', fund: 'funds', object: 'objects' };
    const scopeOut = (scope) => (scope.unit ? { department: scope.department, unit: scope.unit } : scope.department ? { department: scope.department } : { whole_city: true });
    const matchedFrom = (ask, scope) =>
      ask.department && ask.department !== scope.department ? { matched_from: { department: ask.department, ...(ask.unit ? { unit: ask.unit } : {}) } } : ask.unit && ask.unit !== scope.unit ? { matched_from: { unit: ask.unit } } : {};

    const section = (i, top) => {
      const { scope } = items[i];
      const e = exp[i];
      const [rev, perf] = extras[i];
      // top 0 (a comparison's last resort to fit) keeps the per-year totals and leaves the breakdowns out.
      const sec = { spending: { by_fiscal_year: byYear(e.totals, years, current, { brief: compare }) } };
      if (top > 0)
        e.dims.forEach((d, j) => {
          sec.spending[`by_${d}`] = pivot(e.parts[j], years, { top, noun: nouns[d], category: d === 'object' });
        });
      if (rev) {
        if (rev.error || rev.note) sec.revenue = rev.error ? { error: rev.error } : { note: rev.note };
        else
          sec.revenue = {
            ...(rev.scope.department && rev.scope.department !== scope.department ? { department_matched: rev.scope.department } : {}),
            by_fiscal_year: byYear(rev.totals, rev.years, current, { a: 'collected_usd', b: 'budgeted_usd', ratio: 'collected_pct_of_budget', brief: compare }),
            ...(top > 0 ? { [rev.scope.department ? 'by_source' : 'by_category']: pivot(rev.parts, rev.years, { a: 'collected_usd', b: 'budgeted_usd', top, noun: rev.scope.department ? 'revenue sources' : 'revenue categories' }) } : {}),
          };
      }
      if (perf) {
        if (perf.error) sec.performance = { error: perf.error, ...(perf.closest_departments ? { closest_departments: perf.closest_departments, hint: perf.hint } : {}) };
        else {
          const shown = perf.measures.slice(0, compare ? top : Math.max(top, 6));
          sec.performance = {
            department_matched: perf.department_matched,
            ...(perf.program_matched ? { program_matched: perf.program_matched } : {}),
            ...(perf.note ? { note: perf.note } : {}),
            measures: shown,
            ...(perf.measures.length > shown.length ? { and_more: `and ${perf.measures.length - shown.length} more measures` } : {}),
          };
        }
      }
      return sec;
    };

    // Caveats computed for one scope, from rows already fetched.
    const scopeNotes = (i, sec) => {
      const { scope } = items[i];
      const e = exp[i];
      const [rev] = extras[i];
      const n = [];
      const neg = new Map();
      const folded = new Set();
      const collect = (rows, ys, shownSection) => {
        const shownNames = new Set((shownSection?.rows || []).map((r) => r.name));
        for (const g of negativeGroups(rows, ys)) {
          const k = `${g.name} FY${g.fy}`;
          neg.set(k, true);
          if (!shownNames.has(g.name)) folded.add(k);
        }
      };
      e.dims.forEach((d, j) => collect(e.parts[j], years, sec.spending[`by_${d}`]));
      if (rev?.parts) collect(rev.parts, rev.years, sec.revenue?.by_source || sec.revenue?.by_category);
      if (neg.size) {
        const list = [...neg.keys()];
        n.push(
          `I found negative actual or collected amounts in ${list.length} group${list.length === 1 ? '' : 's'} (${list.slice(0, 3).join('; ')}${list.length > 3 ? '; ...' : ''})${folded.size ? `; ${folded.size} of them are folded into an "and N more" row` : ''}. The dataset doesn't say what a negative line records.`
        );
      }
      if (e.uncategorized && !compare) n.push(`${e.uncategorized} of the lines in this answer have no expense category; they are listed as "${NONE}".`);
      n.push(...reorgNotes(shared.pairs, scope, years, compare ? 2 : 5));
      if (!scope.department) {
        n.push(...gapNotes(e.parts[e.dims.indexOf('department')], e.totals, years, current.fiscal_year, { budget: 'budgeted spending', actual: 'actual spending', group: 'department' }));
        if (rev?.parts) n.push(...gapNotes(rev.parts, rev.totals, rev.years, current.fiscal_year, { budget: 'budgeted revenue', actual: 'revenue collected', group: 'revenue category' }));
      }
      return compare ? n.map((x) => `${scope.department}: ${x}`) : n;
    };

    const notes = (secs) => {
      const n = [
        ...EXP_QUOTES.map((q) => fromDescription(shared.meta, q)),
        fromColumn(shared.meta, 'fiscal_year', 'For example, FY 2020 began on July 1, 2019'),
        fromColumn(shared.meta, 'actual_expenses', 'Sum of fiscal year-to-date expenditures'),
        `${reg.expenditures.name} holds ${fyList(shared.held)} today, so nothing earlier can be compared from it.`,
        `Today (${current.today}, America/New_York) falls in FY${current.fiscal_year} on that July 1 - June 30 year, so FY${current.fiscal_year} figures are year to date, not a full year.`,
        "The dataset doesn't say whether FY" + (current.fiscal_year - 1) + "'s accounting period has been closed, whether any year's figures are audited, or whether money moved between the City's funds is counted once or in each fund it passes through; read citywide totals across all funds with that in mind.",
        'All amounts are rounded to whole dollars. A fiscal year missing from a row means I found no lines for it that year.',
      ];
      if (compare) n.push(`year_to_date marks FY${current.fiscal_year}, in progress: about ${current.elapsed_pct}% of it had elapsed on ${current.today}.`);
      secs.forEach((sec, i) => n.push(...scopeNotes(i, sec)));
      if (compare && exp.some((e) => e.uncategorized))
        n.push(`Lines with no expense category, listed as "${NONE}": ${items.map(({ scope }, i) => `${scope.department} ${exp[i].uncategorized}`).join('; ')}.`);
      const revs = extras.map((x) => x[0]).filter((r) => r && !r.error);
      if (shared.pairs.length >= 500 || exp.some((e) => e.truncated) || revs.some((r) => r.truncated)) n.push('A breakdown reached the 500-group query limit, so it may be incomplete; the CSV links in the hand-off have every line.');
      if (revS && !revS.error) {
        n.push(...REV_QUOTES.map((q) => fromDescription(revS.meta, q)));
        n.push(fromColumn(revS.meta, 'total_collected', 'Amount of revenue collected fiscal year-to-date (YTD)'));
        n.push("The dataset doesn't say how the revenue recorded under a department or unit relates to the money that pays for its spending.");
        if (revS.yearRows) {
          const same = years.filter((fy) => {
            const e = shared.yearRows.find((r) => Number(r.fy) === fy);
            const r = revS.yearRows.find((x) => Number(x.fy) === fy);
            return e && r && Math.abs(num(e.budget) - num(r.budget)) < 0.005;
          });
          if (same.length) n.push(`Citywide, budgeted revenue equals budgeted spending to the cent in ${fyList(same)}, so the revenue budget may also include amendments; its description says adopted.`);
        }
      }
      const perfs = extras.map((x) => x[1]).filter((p) => p?.measures);
      if (perfs.length) {
        const meta = perfS.meta;
        n.push(fromColumn(meta, 'demand_level', 'Details whether a program has the resources necessary to meet the established standard for each service.'));
        const proj = perfS.fyCols.find((f) => /projection/.test(f));
        const about = firstSentences(meta.columns.find((c) => c.field === proj)?.about);
        if (proj && about) n.push(`The column description for ${proj} says: "${about}"`);
        n.push('Performance values of 99999 and 99998 are shown as Yes and No, as the column descriptions define them.');
        n.push(`Performance Measures rows were last updated ${meta.updated?.slice(0, 10) || 'on a date its metadata does not give'}; ${meta.update_frequency ? `its metadata gives the update frequency as "${meta.update_frequency}"` : 'its metadata gives no update frequency'}.`);
      }
      return n;
    };

    const build = (top) => {
      const secs = items.map((_, i) => section(i, top));
      if (!compare) {
        const { scope, ask } = items[0];
        const sec = secs[0];
        const withSource = (part, meta) => (part && !part.error && !part.note && meta ? { source: aboutDataset(meta), ...part } : part);
        const out = {
          scope: scopeOut(scope),
          ...matchedFrom(ask, scope),
          current_fiscal_year: current,
          spending: { source: aboutDataset(shared.meta), ...sec.spending },
          ...(sec.revenue ? { revenue: withSource(sec.revenue, revS?.meta) } : {}),
          ...(sec.performance ? { performance: withSource(sec.performance, perfS?.meta) } : {}),
        };
        out.about_the_data = notes(secs);
        return out;
      }
      const out = {
        compared: items.map(({ scope }) => scope.department),
        current_fiscal_year: current,
        sources: {
          spending: aboutDataset(shared.meta),
          ...(revS && !revS.error ? { revenue: aboutDataset(revS.meta) } : {}),
          ...(perfS && !perfS.error ? { performance: aboutDataset(perfS.meta) } : {}),
        },
        departments: items.map(({ scope, ask }, i) => ({ scope: scopeOut(scope), ...matchedFrom(ask, scope), ...secs[i] })),
        ...(top === 0 ? { breakdowns_left_out: 'To fit, this comparison gives per-year totals and performance measure counts only; ask about one department for its breakdowns.' } : {}),
      };
      out.about_the_data = notes(secs);
      return out;
    };
    return fit(build, compare ? [6, 3, 2, 1, 0] : undefined);
  },
});
