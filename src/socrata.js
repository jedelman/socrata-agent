// A thin Socrata (SODA) client. Every request goes through the Trace, and
// every dataset touched is registered in Resources with its download links.
//
// Access levels, so people-finding is blocked in code, not by the prompt:
//   generic  the open-ended query tools the model drives (the default)
//   plugin   reviewed plugin tools (pluginContext sets this; plugins can't)
//   core     Siren's own code paths: the block report, contacts, builders
// The city profile's policy then applies per dataset:
//   excluded          refused at every level
//   restricted        plugin and core only; no full-table CSV in the hand-off
//   deniedColumns     generic and plugin may not select, filter, group, order
//                     or full-text SEARCH by these; SELECT * skips them
//   suppressedRows    a predicate whose rows no level ever sees
export const ACCESS = Object.freeze({ GENERIC: 'generic', PLUGIN: 'plugin', CORE: 'core' });

const MAX_LIMIT = 500;
const DATASET_ID = /^[a-z0-9]{4}-[a-z0-9]{4}$/;

function checkId(id) {
  if (!DATASET_ID.test(String(id))) throw new Error(`"${id}" is not a Socrata dataset id (expected four letters/digits, a dash, four more).`);
}
const DEFAULT_LIMIT = 100;

export function datasetLinks(city, id) {
  return {
    page: `${city.portal}/d/${id}`,
    docs: `https://dev.socrata.com/foundry/${city.domain}/${id}`,
    csv: `https://${city.domain}/api/views/${id}/rows.csv?accessType=DOWNLOAD`,
  };
}

// Blank out string literals so keyword checks and LIMIT handling only see
// SoQL, never user text ('limit 1', 'from the river').
export function stripLiterals(soql) {
  return soql.replace(/'(?:[^']|'')*'/g, (m) => `'${' '.repeat(m.length - 2)}'`);
}

// One query reads one dataset. SoQL can reach others with
// `UNION ... FROM @abcd-1234`, which would skip the exclusion check and
// leave the second dataset out of the trace and the resources list.
export function checkSingleDataset(soql) {
  const code = stripLiterals(soql);
  if (/@[a-z0-9]{4}-[a-z0-9]{4}/i.test(code) || /\b(union|from|join)\b/i.test(code)) {
    throw new Error('A query can read only its own dataset: no FROM, UNION, JOIN or @dataset references. Query each dataset separately.');
  }
}

// Give every query a LIMIT, and cap it, so one question can't pull a whole
// dataset through the model. Operators who want everything get the CSV link.
// Only the trailing LIMIT counts, and it's rewritten in place.
export function clampLimit(soql) {
  const q = soql.trim();
  const m = stripLiterals(q).match(/\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i);
  if (!m) return `${q} LIMIT ${DEFAULT_LIMIT}`;
  if (Number(m[1]) <= MAX_LIMIT) return q;
  return `${q.slice(0, m.index)}LIMIT ${MAX_LIMIT}${m[2] || ''}`;
}

// Top-level clause boundaries in a SoQL $query, outside literals and parentheses.
const CLAUSES = /\b(select|where|group\s+by|having|order\s+by|limit|offset|search)\b/gi;
function topLevelClauses(soql) {
  const code = stripLiterals(soql);
  const depthAt = [];
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '(') d++;
    depthAt[i] = d;
    if (code[i] === ')') d = Math.max(0, d - 1);
  }
  const out = [];
  for (const m of code.matchAll(CLAUSES)) {
    if (depthAt[m.index] === 0) out.push({ kw: m[1].toLowerCase().replace(/\s+/g, ' '), start: m.index, bodyStart: m.index + m[0].length });
  }
  return out.map((c, i) => ({ ...c, end: i + 1 < out.length ? out[i + 1].start : soql.length }));
}

// Split on top-level commas (outside parentheses and literals).
function splitTopLevel(text) {
  const code = stripLiterals(text);
  const parts = [];
  let d = 0;
  let last = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '(') d++;
    else if (code[i] === ')') d--;
    else if (code[i] === ',' && d === 0) {
      parts.push(text.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

/** Identifiers a query mentions (lowercased), ignoring string literals. */
export function identifiers(soql) {
  return new Set((stripLiterals(soql).toLowerCase().match(/[a-z_][a-z0-9_]*/g) || []));
}

/** Replace `SELECT *` (or no SELECT at all) with the allowed columns. */
export function expandSelect(soql, allowed) {
  const q = soql.trim();
  const sel = topLevelClauses(q).find((c) => c.kw === 'select');
  const cols = allowed.join(', ');
  if (!sel) return `SELECT ${cols} ${q}`.trim();
  const items = splitTopLevel(q.slice(sel.bodyStart, sel.end)).map((s) => s.trim());
  const next = items.flatMap((s) => (s === '*' ? [cols] : [s])).join(', ');
  return `${q.slice(0, sel.bodyStart)} ${next} ${q.slice(sel.end)}`.replace(/\s+$/, '');
}

/** AND a predicate into the WHERE clause, or add one, at the top level. */
export function injectWhere(soql, predicate) {
  const q = soql.trim();
  const clauses = topLevelClauses(q);
  const where = clauses.find((c) => c.kw === 'where');
  if (where) return `${q.slice(0, where.bodyStart)} (${predicate}) AND (${q.slice(where.bodyStart, where.end).trim()}) ${q.slice(where.end)}`.trim();
  const after = clauses.find((c) => ['group by', 'having', 'order by', 'limit', 'offset'].includes(c.kw));
  if (after) return `${q.slice(0, after.start)}WHERE ${predicate} ${q.slice(after.start)}`.trim();
  return `${q} WHERE ${predicate}`.trim();
}

export class Socrata {
  constructor({ city, trace, resources, appToken, fetchImpl }) {
    this.city = city;
    this.trace = trace;
    this.resources = resources;
    this.appToken = appToken;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.names = new Map();
  }

  // Name-pattern exclusions need the dataset's name. Core callers pass the
  // name they already know; plugins never can (pluginContext drops it), so a
  // plugin can't label an excluded dataset as something harmless.
  async datasetName(id, name) {
    if (name) return name;
    if (this.names.has(id)) return this.names.get(id);
    if (!(this.city.excludedNamePatterns || []).length) return '';
    return (await this.meta(id)).name;
  }

  // A dataset's name and column list, fetched once per conversation.
  async meta(id) {
    if (!this.metaCache) this.metaCache = new Map();
    if (!this.metaCache.has(id)) {
      const v = await this.getJSON(`https://${this.city.domain}/api/views/${id}.json`, { tool: 'check dataset name', dataset: id });
      const columns = (v.columns || []).map((c) => c.fieldName).filter((f) => f && !f.startsWith(':'));
      this.metaCache.set(id, { name: v.name || '', columns });
      this.names.set(id, v.name || '');
    }
    return this.metaCache.get(id);
  }

  restricted(id) {
    return (this.city.restricted || []).find((r) => r.id === id) || null;
  }

  deniedColumns(id) {
    return (this.city.deniedColumns || {})[id] || [];
  }

  suppressedRows(id) {
    return (this.city.suppressedRows || {})[id] || null;
  }

  isExcluded(id, name = '') {
    const c = this.city;
    if ((c.excluded || []).some((e) => e.id === id)) return true;
    return (c.excludedNamePatterns || []).some((re) => re.test(name));
  }

  excludedReason(id) {
    const e = (this.city.excluded || []).find((x) => x.id === id);
    return e ? e.reason : 'This dataset is excluded because it is searchable by personal name.';
  }

  async getJSON(url, info) {
    return this.trace.record({ ...info, url }, async () => {
      const headers = { Accept: 'application/json' };
      if (this.appToken) headers['X-App-Token'] = this.appToken;
      const res = await this.fetch(url, { headers });
      const body = await res.text();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      if (!res.ok || data?.error) throw new Error(`HTTP ${res.status}: ${data?.message || body.slice(0, 200)}`);
      return { result: data, rows: Array.isArray(data) ? data.length : data?.results?.length };
    });
  }

  async searchCatalog(q, limit = 10) {
    const params = new URLSearchParams({ domains: this.city.domain, only: 'dataset', limit: String(limit) });
    if (q) params.set('q', q);
    const url = `https://api.us.socrata.com/api/catalog/v1?${params}`;
    const data = await this.getJSON(url, { tool: 'search datasets', soql: q ? `q=${q}` : 'all' });
    return data.results
      .map((r) => r.resource)
      .filter((r) => !this.isExcluded(r.id, r.name) && !this.restricted(r.id))
      .map((r) => {
        const links = datasetLinks(this.city, r.id);
        return {
          id: r.id,
          name: r.name,
          description: (r.description || '').slice(0, 300),
          updated: r.data_updated_at,
          page: links.page,
        };
      });
  }

  async describe(id, { access = ACCESS.GENERIC } = {}) {
    checkId(id);
    if (access === ACCESS.GENERIC && this.restricted(id)) throw new Error(this.restricted(id).reason);
    const url = `https://${this.city.domain}/api/views/${id}.json`;
    const v = await this.getJSON(url, { tool: 'describe dataset', dataset: id });
    this.names.set(id, v.name || '');
    if (this.isExcluded(id, v.name)) throw new Error(this.excludedReason(id));
    const links = this.handoffLinks(id);
    const denied = access === ACCESS.CORE ? [] : this.deniedColumns(id);
    this.resources.addDataset({ id, name: v.name, department: v.attribution || undefined, ...links });
    return {
      id,
      name: v.name,
      description: (v.description || '').slice(0, 1200),
      department: v.attribution || null,
      updated: v.rowsUpdatedAt ? new Date(v.rowsUpdatedAt * 1000).toISOString() : null,
      update_frequency: v.metadata?.custom_fields?.Updates?.['Update Frequency'] || null,
      columns: (v.columns || [])
        .filter((c) => !c.fieldName.startsWith(':'))
        .map((c) =>
          denied.includes(c.fieldName)
            ? { field: c.fieldName, withheld: 'identifies private people; Siren does not query it' }
            : { field: c.fieldName, type: c.dataTypeName, ...(c.description ? { about: c.description.slice(0, 160) } : {}) }
        ),
      ...links,
    };
  }

  // The hand-off: a restricted dataset gets its page and docs, never the
  // full-table CSV (that would undo the aggregation its plugin applies).
  handoffLinks(id) {
    const links = datasetLinks(this.city, id);
    if (this.restricted(id)) delete links.csv;
    return links;
  }

  // Run a SoQL query. `name` (trusted core callers only) is the dataset's real
  // name, used for the exclusion check and the resources list. `label` is
  // display-only and never trusted. `access` defaults to the strictest level.
  async query(id, soql, { tool = 'query', name, label, access = ACCESS.GENERIC } = {}) {
    checkId(id);
    checkSingleDataset(soql);
    if (!Object.values(ACCESS).includes(access)) throw new Error(`Unknown access level "${access}".`);
    if (this.isExcluded(id, name)) throw new Error(this.excludedReason(id));
    const realName = await this.datasetName(id, name);
    if (this.isExcluded(id, realName)) throw new Error(this.excludedReason(id));
    if (access === ACCESS.GENERIC && this.restricted(id)) throw new Error(this.restricted(id).reason);
    name = name || realName || label;
    let q = soql;
    const denied = access === ACCESS.CORE ? [] : this.deniedColumns(id);
    if (denied.length) {
      if (/\bsearch\b/i.test(stripLiterals(q))) {
        throw new Error(`Full-text SEARCH isn't allowed on ${name || id}: it holds fields that identify private people. Filter on specific columns instead.`);
      }
      const used = identifiers(q);
      const hit = denied.find((c) => used.has(c.toLowerCase()));
      if (hit) throw new Error(`The column ${hit} in ${name || id} is withheld: it identifies private people, so Siren doesn't select, filter, group or sort by it.`);
      const sel = topLevelClauses(q).find((c) => c.kw === 'select');
      const star = !sel || splitTopLevel(q.slice(sel.bodyStart, sel.end)).some((s) => s.trim() === '*');
      if (star) q = expandSelect(q, (await this.meta(id)).columns.filter((c) => !denied.includes(c)));
    }
    const hidden = this.suppressedRows(id);
    if (hidden) q = injectWhere(q, `NOT (${hidden})`);
    q = clampLimit(q);
    const json = `https://${this.city.domain}/resource/${id}.json?$query=${encodeURIComponent(q)}`;
    const csv = `https://${this.city.domain}/resource/${id}.csv?$query=${encodeURIComponent(q)}`;
    const rows = await this.getJSON(json, { tool, dataset: id, soql: q });
    this.resources.addDataset({ id, ...(name ? { name } : {}), ...this.handoffLinks(id) });
    if (!/\bcount\(/i.test(q) || /\bgroup by\b/i.test(q)) this.resources.addQuery(id, csv);
    return rows;
  }
}

// Quote a value for a SoQL string literal.
export function soqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
