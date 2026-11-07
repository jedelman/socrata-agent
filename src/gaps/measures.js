// The fixed measure menu for gaps (docs/gaps.md §5.2). Every measure runs at
// GENERIC access through the traced Socrata client, so the dataset policy
// applies to the gap builder exactly as it does to the open-ended tools, and
// every request lands in the trace. Nothing here passes access: 'core'.
//
// Each measure is a constant spec in the catalog (src/gaps/<city>.js); dates
// come only from the build date. A measure's result is a pure function of
// what the queries returned, so `build-gaps --check` can replay the stored
// responses and get the same output.

import { ACCESS, stripLiterals, checkSingleDataset, isPersonColumn } from '../socrata.js';
import { normalize } from './text-utils.js';

// --- The positional identifier rule ----------------------------------------
// A location column may appear only as `<col> IS [NOT] NULL`: never compared,
// grouped, ordered or selected, so a measure can count rows with no street but
// can never name one. assigned_crew and every person-named column are refused
// in every position. (`identifiers()` in socrata.js returns a flat set, which
// can't say where a name appears.)
const LOCATION = [
  /^street$/, /^address$/, /^street_number$/, /^gpin$/, /^parcel/, /^lat/, /^lon/, /^location$/, /_point$/, /^the_geom$/, /^census_tract/,
  // Stricter than the spec's list, so a near-name can't slip past it.
  /_address$/, /street_name$/, /^house_number$/,
  // Places below the ward (I17): civic leagues, neighborhoods, precincts,
  // superwards, planning districts, maintenance zones, census blocks, zip codes.
  /^civic_league/, /^neighborhood/, /^precinct/, /^super_?ward(?!_district$)/, /^planning_district/, /^maintenance_zone/, /^census_block/, /^zip/,
  // Coordinates and parcel ids under other names.
  /_coordinate$/, /^geocoded/, /^tax_account/,
];
// Ward-level counts need I17's small-count rule (at least 5, with a
// complement of at least 5), which no check enforces yet. Until one does, a
// ward column may only be tested for null, or name a count (`AS ward`).
const WARD = /^(?:ward|ward_district|super_ward_district)$/;
export const isLocationColumn = (name) => LOCATION.some((re) => re.test(String(name).toLowerCase()));
const NEVER = new Set(['assigned_crew']);

/** Violations of the positional identifier rule in one SoQL query ([] if none). */
export function identifierViolations(soql) {
  let code;
  try {
    code = stripLiterals(soql);
    checkSingleDataset(soql);
  } catch (err) {
    return [String(err.message)];
  }
  const out = [];
  for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = m[0].toLowerCase();
    const before = code[m.index - 1];
    // Socrata's computed regions (`:@computed_region_abcd_1234`: census
    // tracts, zip codes and the like) are places below the ward.
    const region = before === '@' && code[m.index - 2] === ':' && name.startsWith('computed_region');
    if (!region && before && /[A-Za-z0-9_.:@]/.test(before)) continue;
    if (NEVER.has(name) || isPersonColumn(name)) {
      out.push(`${m[0]} may not appear in a gap measure in any position.`);
      continue;
    }
    const after = code.slice(m.index + m[0].length);
    const nullTest = /^\s+is\s+(?:not\s+)?null\b/i.test(after);
    if (region || isLocationColumn(name)) {
      if (!nullTest) out.push(`${m[0]} is a location column: a gap measure may use it only as "${m[0]} IS NULL" or "IS NOT NULL".`);
    } else if (WARD.test(name) && !nullTest && !/\bas\s+$/i.test(code.slice(0, m.index))) {
      out.push(`${m[0]}: ward-level counts wait on the small-count check (I17); a gap measure may use it only as "${m[0]} IS NULL" or "IS NOT NULL".`);
    }
  }
  return out;
}

export function checkMeasureSoql(soql) {
  const v = identifierViolations(soql);
  if (v.length) throw new IdentifierRuleError(`${v.join(' ')} Query: ${soql}`);
}
export class IdentifierRuleError extends Error {}

// --- SoQL builders: the menu ------------------------------------------------
const flag = (cond) => `sum(case(${cond},1,true,0))`;

export const soql = Object.freeze({
  /** count · share: one row gives the whole and each named part. */
  share: (where, parts) =>
    `SELECT count(*) AS whole${Object.entries(parts).map(([k, c]) => `, ${flag(c)} AS ${k}`).join('')} WHERE ${where}`,
  /** series: GROUP BY year, citywide only. */
  series: (where, field, parts) =>
    `SELECT date_extract_y(${field}) AS y, count(*) AS whole${Object.entries(parts).map(([k, c]) => `, ${flag(c)} AS ${k}`).join('')} WHERE ${where} GROUP BY y ORDER BY y`,
  /** window: rows whose date falls in [from, to). */
  window: (where, field, from, to, parts) =>
    `SELECT count(*) AS whole${Object.entries(parts).map(([k, c]) => `, ${flag(c)} AS ${k}`).join('')} WHERE ${where} AND ${field} >= '${from}T00:00:00'${to ? ` AND ${field} < '${to}T00:00:00'` : ''}`,
  /** span: first and last date in scope. */
  span: (where, fields) => `SELECT ${fields.map((f) => `min(${f}) AS min_${f}, max(${f}) AS max_${f}`).join(', ')} WHERE ${where}`,
  /** A breakdown by a categorical field (never a location column). */
  breakdown: (where, fields, parts) =>
    `SELECT ${fields.join(', ')}, count(*) AS whole${Object.entries(parts).map(([k, c]) => `, ${flag(c)} AS ${k}`).join('')} WHERE ${where} GROUP BY ${fields.join(', ')} ORDER BY ${fields.join(', ')}`,
  /** values_absent: the distinct values of one categorical field, with counts. */
  values: (where, field) => `SELECT ${field} AS v, count(*) AS n WHERE ${where} GROUP BY ${field} ORDER BY n DESC, ${field} LIMIT 200`,
  /** median_age: the row at a given offset, in date order with a row-id tiebreak. */
  nth: (where, field, tiebreak, offset) => `SELECT ${field} WHERE ${where} ORDER BY ${field}, ${tiebreak} LIMIT 1 OFFSET ${offset}`,
});

// --- Dates --------------------------------------------------------------------

/** The build's calendar date in America/New_York (YYYY-MM-DD). */
export function buildDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Whole days from a row's date to the build date. */
export const daysSince = (rowDate, today) => Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(rowDate).slice(0, 10)}T00:00:00Z`)) / 864e5);

// --- Running measures -----------------------------------------------------------

/**
 * Runs measures for one build. Every query and describe goes through
 * ctx.socrata at GENERIC access; results are cached per build so two gaps
 * that share a query share one request. `readOf(url)` gives the time the
 * response was read (the recorder's clock, so replays reproduce it).
 */
export class MeasureRunner {
  constructor({ ctx, readOf, bodyOf, catalogName }) {
    this.ctx = ctx;
    this.readOf = readOf;
    this.bodyOf = bodyOf || (() => null);
    this.catalogName = catalogName || 'gap catalog';
    this.queries = new Map();
    this.describes = new Map();
    this.searches = new Map();
  }

  lastStep() {
    const s = this.ctx.trace.steps.at(-1);
    return { url: s.url, trace_n: s.n, read: this.readOf(s.url) };
  }

  /** A query measure: rows plus where and when they were read. */
  async query(dataset, q, label) {
    checkMeasureSoql(q);
    const key = `${dataset}\n${q}`;
    if (!this.queries.has(key)) {
      const rows = await this.ctx.socrata.query(dataset, q, { tool: `${this.catalogName}: ${label || dataset}`, access: ACCESS.GENERIC });
      const step = this.lastStep();
      this.queries.set(key, { dataset, soql: this.ctx.trace.steps.at(-1).soql, rows, ...step });
    }
    return this.queries.get(key);
  }

  /** Metadata at GENERIC: name, description, rowsUpdatedAt and the data columns. */
  async describe(dataset) {
    if (!this.describes.has(dataset)) {
      const d = await this.ctx.socrata.describe(dataset, { access: ACCESS.GENERIC });
      const step = this.lastStep();
      // describe() trims text for the model; the builder reads the whole
      // response it recorded (same request, same trace step).
      const raw = this.bodyOf(step.url) || {};
      this.describes.set(dataset, {
        ...d,
        full_description: raw.description ?? d.description,
        raw_columns: (raw.columns || []).filter((c) => c.fieldName && !c.fieldName.startsWith(':')),
        ...step,
      });
    }
    return this.describes.get(dataset);
  }

  async catalogSearch(q) {
    if (!this.searches.has(q)) {
      const r = await this.ctx.socrata.catalogSearchRaw(q);
      // One page of results: a measure that counts or names them needs all of them.
      if (r.result_set_size > r.returned) throw new MeasureChange(`The catalog search “${q}” returns ${r.result_set_size} datasets, more than the ${r.returned} on one page.`);
      this.searches.set(q, { ...r, ...this.lastStep() });
    }
    return this.searches.get(q);
  }

  /**
   * columns_absent: no column in any of `datasets` matches `pattern`, apart
   * from columns a reviewer cleared (each with a reason). Siblings (columns
   * matching the broader `siblings` pattern) are listed. Throws when an
   * uncleared column matches: the gap may be closing, and a reviewer decides.
   */
  async columnsAbsent({ datasets, pattern, siblings, cleared = [] }) {
    const counts = {};
    const matched = [];
    const sib = [];
    let read = '';
    for (const id of datasets) {
      const d = await this.describe(id);
      const cols = d.columns.map((c) => c.field);
      counts[id] = cols.length;
      if (d.read > read) read = d.read;
      for (const c of cols) {
        if (pattern.test(c)) matched.push({ dataset: id, column: c });
        else if (siblings && siblings.test(c)) sib.push({ dataset: id, column: c });
      }
    }
    const isCleared = (m) => cleared.find((c) => c.dataset === m.dataset && c.column === m.column);
    const open = matched.filter((m) => !isCleared(m));
    if (open.length) throw new MeasureChange(`A column now matches ${pattern}: ${open.map((m) => `${m.dataset}.${m.column}`).join(', ')}. A reviewer clears it or the gap is closing.`);
    for (const c of cleared) {
      if (!matched.concat(sib).some((m) => m.dataset === c.dataset && m.column === c.column)) throw new MeasureChange(`Cleared column ${c.dataset}.${c.column} is no longer in the dataset.`);
    }
    return { pattern: String(pattern), datasets: counts, siblings_cleared: cleared.map((c) => ({ ...c })), siblings: sib, read };
  }

  /** values_absent: none of a field's distinct values matches the pattern. */
  async valuesAbsent({ dataset, field, where, pattern }) {
    const r = await this.query(dataset, soql.values(where, field), `${field} values`);
    // The query stops at 200 values: at the cap, "none matching" isn't known.
    if (r.rows.length >= 200) throw new MeasureChange(`${dataset}.${field} has 200 or more values; the values_absent query reads at most 200.`);
    const values = r.rows.map((x) => x.v).filter((v) => v != null);
    const matched = values.filter((v) => pattern.test(v));
    return { ...r, values, matched, pattern: String(pattern) };
  }

  /**
   * description_quote: whole sentences of a dataset's own description,
   * normalized as verify-cases does. Throws if any is gone.
   */
  async descriptionQuote(dataset, sentencesWanted) {
    const d = await this.describe(dataset);
    const hay = normalize(d.full_description || '');
    const missing = sentencesWanted.filter((s) => !hay.includes(normalize(s)));
    if (missing.length) throw new MeasureChange(`The description of ${dataset} no longer holds: ${missing.join(' | ')}`);
    return { dataset, quote: sentencesWanted.join(' '), read: d.read, updated: d.updated, trace_n: d.trace_n, url: d.url };
  }

  /** A column's description, quoted whole. */
  async fieldDescription(dataset, field) {
    const d = await this.describe(dataset);
    const col = (d.raw_columns || []).find((c) => c.fieldName === field);
    if (!col || !col.description) throw new MeasureChange(`${dataset}.${field} has no description now.`);
    return { dataset, field, quote: col.description.trim(), read: d.read, trace_n: d.trace_n, url: d.url };
  }

  /** median_age: exact, by count then OFFSET floor((n-1)/2), plus the next row when n is even. */
  async medianDate({ dataset, where, field, tiebreak, n }) {
    const off = Math.floor((n - 1) / 2);
    const a = await this.query(dataset, soql.nth(where, field, tiebreak, off), `median ${field}`);
    const first = a.rows[0]?.[field];
    if (!first) throw new MeasureChange(`No row at offset ${off}.`);
    if (n % 2 === 1) return { value: first, rows: [a] };
    const b = await this.query(dataset, soql.nth(where, field, tiebreak, off + 1), `median ${field} (second row)`);
    const second = b.rows[0]?.[field];
    if (!second) throw new MeasureChange(`No row at offset ${off + 1}.`);
    const mid = floatingMidpoint(first, second);
    return { value: mid, rows: [a, b] };
  }
}
export class MeasureChange extends Error {}

/**
 * The midpoint of two Socrata floating timestamps ("2024-01-01T00:00:00.000",
 * no zone), in the same floating form. Both are read as UTC and written back
 * without the Z, so the result never depends on the machine's time zone.
 */
export function floatingMidpoint(a, b) {
  const ms = (s) => {
    const v = Date.parse(`${String(s).slice(0, 19)}Z`);
    if (!Number.isFinite(v)) throw new MeasureChange(`Not a timestamp: ${s}`);
    return v;
  };
  return new Date((ms(a) + ms(b)) / 2).toISOString().slice(0, 19);
}

/** A count field from one aggregate row, as a number. */
export const num = (row, k) => {
  const v = Number(row?.[k] ?? 0);
  if (!Number.isFinite(v)) throw new MeasureChange(`Not a number: ${k}`);
  return v;
};
