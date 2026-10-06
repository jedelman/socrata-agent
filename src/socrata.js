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

// Give every query a LIMIT, and cap it, so one question can't pull a whole
// dataset through the model. Operators who want everything get the CSV link.
export function clampLimit(soql) {
  const m = soql.match(/\blimit\s+(\d+)\s*(offset\s+\d+\s*)?$/i);
  if (!m) return `${soql.trim()} LIMIT ${DEFAULT_LIMIT}`;
  const n = Number(m[1]);
  if (n <= MAX_LIMIT) return soql.trim();
  return soql.trim().replace(/\blimit\s+\d+/i, `LIMIT ${MAX_LIMIT}`);
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

  // Name-pattern exclusions need the dataset's name; look it up once if the
  // caller didn't supply it, so querying by bare id can't skip the check.
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

  // Run a SoQL query. `name` is optional and only used for the resources list.
  async query(id, soql, { tool = 'query', name } = {}) {
    checkId(id);
    if (this.isExcluded(id, name)) throw new Error(this.excludedReason(id));
    if (this.isExcluded(id, await this.datasetName(id, name))) throw new Error(this.excludedReason(id));
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
