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
//                     or full-text SEARCH by these; SELECT * skips them.
//                     Columns named like a person (PERSON_COLUMNS) are added
//                     for every dataset, reviewed or not
//   suppressedRows    a predicate whose rows no level ever sees (Siren's own
//                     first pipeline stage drops them; see suppressFirst)
// Filtered views of a dataset are refused below core: query the parent.
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

// Read SoQL the way Socrata's lexer does, so every check below sees the
// same tokens Socrata will. Returns the query with string literals blanked
// ('limit 1', 'from the river' are text, not SoQL). Anything that could hide
// text from a check is refused outright: double-quoted strings (Socrata reads
// them as literals too), -- and /* */ comments, a backtick identifier holding
// anything but a plain name, and an unterminated literal. No query Siren or a
// model needs uses any of them. (A backslash is not an escape in SoQL;
// checked live 2026-11-02.)
export function stripLiterals(soql) {
  const s = String(soql);
  let code = '';
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) throw new Error('This query has an unterminated string literal.');
        if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") break;
        else j++;
      }
      code += `'${' '.repeat(j - i - 1)}'`;
      i = j + 1;
    } else if (ch === '"') {
      throw new Error("Use single quotes for text in SoQL ('like this'); double quotes aren't accepted.");
    } else if ((ch === '-' && s[i + 1] === '-') || (ch === '/' && s[i + 1] === '*')) {
      throw new Error("Comments (-- or /* */) aren't accepted in queries.");
    } else if (ch === '`') {
      const m = s.slice(i).match(/^`[A-Za-z0-9_:@]*`/);
      if (!m) throw new Error('A `quoted` column name may hold only letters, digits and underscores.');
      code += m[0];
      i += m[0].length;
    } else {
      code += ch;
      i++;
    }
  }
  return code;
}

// One query reads one dataset, in one stage. SoQL can reach others with
// `UNION ... FROM @abcd-1234`, which would skip the exclusion check and
// leave the second dataset out of the trace and the resources list. A
// pipeline (`|>`) lets a later stage rename columns after the checks below,
// and Siren writes its own first stage for suppressed rows, so user pipes
// are refused too.
export function checkSingleDataset(soql) {
  const code = stripLiterals(soql);
  if (/@[a-z0-9]{4}-[a-z0-9]{4}/i.test(code) || /\b(union|intersect|minus|except|from|join)\b/i.test(code)) {
    throw new Error('A query can read only its own dataset: no FROM, UNION, INTERSECT, MINUS, EXCEPT, JOIN or @dataset references. Query each dataset separately.');
  }
  if (code.includes('|>')) throw new Error("Chained (|>) queries aren't accepted; write one SELECT.");
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

// A SELECT body split into its DISTINCT prefix and its items.
function selectItems(q, sel) {
  const body = q.slice(sel.bodyStart, sel.end);
  const d = stripLiterals(body).match(/^\s*distinct\s+/i);
  return { distinct: Boolean(d), items: splitTopLevel(d ? body.slice(d[0].length) : body).map((x) => x.trim()) };
}

// An item that is only a star (`*`, `t.*`), not count(*) or a product.
const BARE_STAR = /^[A-Za-z0-9_.`]*\*$/;

/** Replace `SELECT *` (or `SELECT DISTINCT *`, or no SELECT) with the allowed columns. */
export function expandSelect(soql, allowed) {
  const q = soql.trim();
  const sel = topLevelClauses(q).find((c) => c.kw === 'select');
  const cols = allowed.join(', ');
  if (!sel) return `SELECT ${cols} ${q}`.trim();
  const { distinct, items } = selectItems(q, sel);
  const next = items.flatMap((x) => (BARE_STAR.test(x) && x !== ':*' ? [cols] : [x])).join(', ');
  return `${q.slice(0, sel.bodyStart)} ${distinct ? 'DISTINCT ' : ''}${next} ${q.slice(sel.end)}`.replace(/\s+$/, '');
}

/**
 * Siren's own first stage for a dataset with suppressed rows. The predicate
 * runs against the real columns before any alias in the caller's query
 * exists (SoQL lets WHERE see SELECT aliases, so `'x' AS subtype` would
 * otherwise defeat it), and coalesce keeps rows where the predicate is NULL
 * (a NULL subtype isn't a suppressed one). Checked live 2026-11-02.
 */
export function suppressFirst(soql, predicate) {
  const q = soql.trim();
  const hasSelect = topLevelClauses(q).some((c) => c.kw === 'select');
  return `SELECT * WHERE NOT coalesce((${predicate}), false) |> ${hasSelect ? q : `SELECT * ${q}`}`;
}

// Column names that identify a private person in any city's data, so a
// dataset no profile has reviewed still can't be searched by them. The
// open-ended tools and plugins treat a match like a deniedColumns entry.
// Siren's own code (core) is unaffected.
export const PERSON_COLUMNS = [
  /^(.*_)?owner(_?name|_?\d+)?$/,
  /^(.*_)?(first|last|middle|full)_?name$/,
  /^(.*_)?(applicant|contractor|complainant|reporter|requester|requestor|caller|driver|grantor|grantee|contact|tenant|occupant|victim|suspect|defendant|offender)(_?name)?$/,
  /(^|_)(e_?mail|phone|telephone|cell|mobile|contact_number)(_|$)/,
  /(^|_)(mailing|home)_address(_|$)/,
  /(^|_)((license|vehicle)_)?plate(_?(number|no))?(_|$)/,
  /(^|_)vin(_?(number|no))?(_|$)/,
  /(^|_)(ssn|dob|date_of_birth|birth_?date)(_|$)/,
];
export const isPersonColumn = (field) => PERSON_COLUMNS.some((re) => re.test(String(field).toLowerCase()));

// A private copy of the city's policy, taken once. Nothing that holds the
// city object later (a plugin, a config) can loosen it for this context.
function snapshotPolicy(city) {
  const deniedColumns = new Map(Object.entries(city.deniedColumns || {}).map(([id, cols]) => [id, Object.freeze([...cols])]));
  return Object.freeze({
    excluded: Object.freeze((city.excluded || []).map((e) => Object.freeze({ ...e }))),
    patterns: Object.freeze([...(city.excludedNamePatterns || [])]),
    restricted: Object.freeze((city.restricted || []).map((r) => Object.freeze({ ...r }))),
    deniedColumns,
    suppressedRows: new Map(Object.entries(city.suppressedRows || {})),
  });
}

export class Socrata {
  constructor({ city, trace, resources, appToken, fetchImpl }) {
    this.city = city;
    this.domain = city.domain;
    this.policy = snapshotPolicy(city);
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
    if (!this.policy.patterns.length) return '';
    return (await this.meta(id)).name;
  }

  // A dataset's name, columns and parent view, fetched once per conversation.
  async meta(id) {
    if (!this.metaCache) this.metaCache = new Map();
    if (!this.metaCache.has(id)) {
      const v = await this.getJSON(`https://${this.domain}/api/views/${id}.json`, { tool: 'check dataset name', dataset: id });
      this.remember(id, v);
    }
    return this.metaCache.get(id);
  }

  remember(id, v) {
    if (!this.metaCache) this.metaCache = new Map();
    const columns = (v.columns || []).map((c) => c.fieldName).filter((f) => f && !f.startsWith(':'));
    this.metaCache.set(id, { name: v.name || '', columns, parent: v.modifyingViewUid || null });
    this.names.set(id, v.name || '');
  }

  // A filtered view (one with a parent) has its own id, so the parent's
  // policy wouldn't apply to it. The open-ended tools and plugins are sent to
  // the parent instead, where its rules do.
  checkRoot(id, m) {
    if (m.parent) throw new Error(`${id} is a filtered view of dataset ${m.parent}. Query ${m.parent} directly; its own rules apply.`);
  }

  restricted(id) {
    return this.policy.restricted.find((r) => r.id === id) || null;
  }

  deniedColumns(id) {
    return this.policy.deniedColumns.get(id) || [];
  }

  // What the open-ended tools and plugins may not touch in this dataset: the
  // profile's list plus any column whose name marks a person.
  withheld(id, columns = []) {
    return [...new Set([...this.deniedColumns(id), ...columns.filter(isPersonColumn)])];
  }

  suppressedRows(id) {
    return this.policy.suppressedRows.get(id) || null;
  }

  isExcluded(id, name = '') {
    if (this.policy.excluded.some((e) => e.id === id)) return true;
    return this.policy.patterns.some((re) => re.test(name));
  }

  excludedReason(id) {
    const e = this.policy.excluded.find((x) => x.id === id);
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
    const params = new URLSearchParams({ domains: this.domain, only: 'dataset', limit: String(limit) });
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
    const url = `https://${this.domain}/api/views/${id}.json`;
    const v = await this.getJSON(url, { tool: 'describe dataset', dataset: id });
    this.remember(id, v);
    if (this.isExcluded(id, v.name)) throw new Error(this.excludedReason(id));
    const m = this.metaCache.get(id);
    if (access !== ACCESS.CORE) this.checkRoot(id, m);
    const denied = access === ACCESS.CORE ? [] : this.withheld(id, m.columns);
    const links = this.handoffLinks(id, denied);
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

  // The hand-off. A dataset with any policy (restricted, withheld columns,
  // suppressed rows) gets its page, docs and the exact-query CSV, never the
  // full-table CSV: that file would hold everything the policy holds back.
  handoffLinks(id, withheld = []) {
    const links = datasetLinks(this.city, id);
    if (this.restricted(id) || this.deniedColumns(id).length || withheld.length || this.suppressedRows(id)) delete links.csv;
    return links;
  }

  // Run a SoQL query. `name` (trusted core callers only) is the dataset's real
  // name, used for the exclusion check and the resources list. `label` is
  // display-only and never trusted. `access` defaults to the strictest level.
  async query(id, soql, { tool = 'query', name, label, access = ACCESS.GENERIC } = {}) {
    checkId(id);
    if (!Object.values(ACCESS).includes(access)) throw new Error(`Unknown access level "${access}".`);
    checkSingleDataset(soql);
    const core = access === ACCESS.CORE;
    if (this.isExcluded(id, name)) throw new Error(this.excludedReason(id));
    // Everything but core reads the dataset's metadata: its real name, its
    // columns (for the person-column check) and whether it is a view.
    const m = core ? null : await this.meta(id);
    const realName = m ? m.name : await this.datasetName(id, name);
    if (this.isExcluded(id, realName)) throw new Error(this.excludedReason(id));
    if (m) this.checkRoot(id, m);
    if (access === ACCESS.GENERIC && this.restricted(id)) throw new Error(this.restricted(id).reason);
    name = name || realName || label;
    let q = soql.trim();
    const denied = core ? [] : this.withheld(id, m.columns);
    if (denied.length) {
      if (/\bsearch\b/i.test(stripLiterals(q))) {
        throw new Error(`Full-text SEARCH isn't allowed on ${name || id}: it holds fields that identify private people. Filter on specific columns instead.`);
      }
      const used = identifiers(q);
      const hit = denied.find((c) => used.has(c.toLowerCase()));
      if (hit) throw new Error(`The column ${hit} in ${name || id} is withheld: it identifies private people, so Siren doesn't select, filter, group or sort by it.`);
      const sel = topLevelClauses(q).find((c) => c.kw === 'select');
      const star = !sel || selectItems(q, sel).items.some((x) => BARE_STAR.test(x));
      if (star) q = expandSelect(q, m.columns.filter((c) => !denied.includes(c)));
    }
    q = clampLimit(q);
    const hidden = this.suppressedRows(id);
    if (hidden) q = suppressFirst(q, hidden);
    const json = `https://${this.domain}/resource/${id}.json?$query=${encodeURIComponent(q)}`;
    const csv = `https://${this.domain}/resource/${id}.csv?$query=${encodeURIComponent(q)}`;
    const rows = await this.getJSON(json, { tool, dataset: id, soql: q });
    // Backstop: if a withheld column came back anyway, through some form of
    // query the checks above didn't foresee, nothing from it is returned.
    if (denied.length && Array.isArray(rows)) {
      const bad = new Set(denied.map((c) => c.toLowerCase()));
      const leaked = rows.flatMap((r) => Object.keys(r || {})).find((k) => bad.has(k.toLowerCase()));
      if (leaked) throw new Error(`Siren refused this result: it included the withheld column ${leaked}. Select specific columns instead.`);
    }
    this.resources.addDataset({ id, ...(name ? { name } : {}), ...this.handoffLinks(id, denied) });
    if (!/\bcount\(/i.test(q) || /\bgroup by\b/i.test(q)) this.resources.addQuery(id, csv);
    return rows;
  }
}

// Quote a value for a SoQL string literal.
export function soqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
