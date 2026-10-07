// A thin Socrata (SODA) client. Every request goes through the Trace, and
// every dataset touched is registered in Resources with its download links.

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
    const v = await this.getJSON(`https://${this.city.domain}/api/views/${id}.json`, { tool: 'check dataset name', dataset: id });
    this.names.set(id, v.name || '');
    return v.name || '';
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
      .filter((r) => !this.isExcluded(r.id, r.name))
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

  async describe(id) {
    checkId(id);
    const url = `https://${this.city.domain}/api/views/${id}.json`;
    const v = await this.getJSON(url, { tool: 'describe dataset', dataset: id });
    this.names.set(id, v.name || '');
    if (this.isExcluded(id, v.name)) throw new Error(this.excludedReason(id));
    const links = datasetLinks(this.city, id);
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
        .map((c) => ({ field: c.fieldName, type: c.dataTypeName, ...(c.description ? { about: c.description.slice(0, 160) } : {}) })),
      ...links,
    };
  }

  // Run a SoQL query. `name` (trusted core callers only) is the dataset's real
  // name, used for the exclusion check and the resources list. `label` is
  // display-only and never trusted.
  async query(id, soql, { tool = 'query', name, label } = {}) {
    checkId(id);
    checkSingleDataset(soql);
    if (this.isExcluded(id, name)) throw new Error(this.excludedReason(id));
    const realName = await this.datasetName(id, name);
    if (this.isExcluded(id, realName)) throw new Error(this.excludedReason(id));
    name = name || realName || label;
    const q = clampLimit(soql);
    const json = `https://${this.city.domain}/resource/${id}.json?$query=${encodeURIComponent(q)}`;
    const csv = `https://${this.city.domain}/resource/${id}.csv?$query=${encodeURIComponent(q)}`;
    const rows = await this.getJSON(json, { tool, dataset: id, soql: q });
    this.resources.addDataset({ id, ...(name ? { name } : {}), ...datasetLinks(this.city, id) });
    if (!/\bcount\(/i.test(q) || /\bgroup by\b/i.test(q)) this.resources.addQuery(id, csv);
    return rows;
  }
}

// Quote a value for a SoQL string literal.
export function soqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
