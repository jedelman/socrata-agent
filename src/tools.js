// Tool definitions (OpenAI/OpenRouter function-calling format) and their
// executors. Which tools a city gets depends on what its profile supports.

import { blockReport, lookupAddress, searchLegislation } from './block.js';
import { soqlString } from './socrata.js';
import { pluginToolDefs, pluginsFor, pluginContext } from './plugins.js';

const T = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export function toolsFor(city, plugins = []) {
  const tools = [
    T('search_datasets', `Search ${city.name}'s open data catalog by keyword. Returns dataset ids, names and descriptions.`, {
      query: { type: 'string', description: 'Keywords, e.g. "trees", "building permits".' },
    }, ['query']),
    T('describe_dataset', 'Get a dataset\'s columns, description, owning department and update frequency. Call before querying an unfamiliar dataset.', {
      dataset_id: { type: 'string', description: 'Socrata 4x4 id, e.g. "qzfe-wj25".' },
    }, ['dataset_id']),
    T('query_dataset', 'Run a SoQL query on one dataset. Use SELECT/WHERE/GROUP BY/ORDER BY/LIMIT; no FROM clause and no joins. Results are capped at 500 rows.', {
      dataset_id: { type: 'string' },
      soql: { type: 'string', description: 'e.g. "SELECT status, count(*) AS n WHERE ward = 2 GROUP BY status ORDER BY n DESC"' },
    }, ['dataset_id', 'soql']),
  ];
  if (city.address) {
    tools.push(
      T('lookup_address', 'Resolve a street address to its parcel id, districts, civic league, and elected representatives with contact details.', {
        address: { type: 'string', description: 'House number and street, e.g. "111 Pennsylvania Ave".' },
      }, ['address']),
      T('block_report', 'Everything on file for an address and its block in one call: permits, plan reviews, complaints, violations, code enforcement, inspections, nearby work orders and right-of-way permits, contacts, and agenda items that name the address or its hundred block. Start here for "what\'s on my block".', {
        address: { type: 'string' },
      }, ['address'])
    );
  }
  if (city.meetings?.kind === 'iqm2') {
    tools.push(
      T('get_legislation', 'Read one legislative record (ordinance, resolution, permit): status, department, category, and every body that voted on it with the result and names of ayes, nays, abstentions and absences. Use for "who decided that".', {
        legislation_id: { type: 'string', description: 'The id from block_report or find_legislation.' },
      }, ['legislation_id']),
      T('find_legislation', 'Search agenda item titles from every listed public meeting by keywords (a street name, a business name, "short term rental").', {
        text: { type: 'string' },
      }, ['text']),
      T('upcoming_meetings', 'List public meetings (City Council, Planning Commission, boards) in the coming days, with agenda links.', {
        days: { type: 'integer', description: 'How many days ahead, default 30.' },
        body: { type: 'string', description: 'Optional: part of the body\'s name, e.g. "Planning".' },
      })
    );
  }
  const core = new Set(tools.map((t) => t.function.name));
  for (const def of pluginToolDefs(plugins, city)) {
    if (core.has(def.function.name)) throw new Error(`Plugin "${def.function.name}" would replace a core tool.`);
    tools.push(def);
  }
  return tools;
}

const ROW_CAP = 60;

function capRows(rows) {
  if (!Array.isArray(rows) || rows.length <= ROW_CAP) return rows;
  return { first_rows: rows.slice(0, ROW_CAP), note: `${rows.length} rows returned; showing ${ROW_CAP}. The operator can download all of them from the resources list.` };
}

export async function runTool(ctx, name, args) {
  const { socrata, iqm2, indexes, city, resources } = ctx;
  switch (name) {
    case 'search_datasets':
      return socrata.searchCatalog(args.query);
    case 'describe_dataset':
      return socrata.describe(args.dataset_id);
    case 'query_dataset':
      return capRows(await socrata.query(args.dataset_id, args.soql));
    case 'lookup_address':
      return lookupAddress(ctx, args.address);
    case 'block_report':
      return blockReport(ctx, args.address);
    case 'get_legislation': {
      if (!/^\d+$/.test(String(args.legislation_id))) throw new Error('legislation_id must be the numeric id');
      return iqm2.legislation(args.legislation_id);
    }
    case 'find_legislation': {
      const idx = indexes?.[city.meetings.index];
      if (!idx) return { error: 'The legislation index is not loaded.' };
      const hits = searchLegislation(idx, args.text);
      for (const h of hits) resources.addRecord({ kind: 'legislation', title: h.title.slice(0, 160), url: iqm2.legiUrl(h.id) });
      return { index_built: idx.built, matches: hits };
    }
    case 'upcoming_meetings': {
      const days = Math.min(Math.max(Number(args.days) || 30, 1), 120);
      const now = new Date();
      const end = new Date(now.getTime() + days * 864e5);
      const iso = (d) => d.toISOString().slice(0, 19);
      let where = `date_and_time >= ${soqlString(iso(now))} AND date_and_time <= ${soqlString(iso(end))}`;
      if (args.body) where += ` AND upper(organization) like ${soqlString(`%${String(args.body).toUpperCase()}%`)}`;
      const rows = await socrata.query(
        city.meetings.noticesDataset,
        `SELECT date_and_time, organization, type, location, meeting_link, agenda_link WHERE ${where} ORDER BY date_and_time LIMIT 50`,
        { tool: 'upcoming meetings', name: 'Public Meeting Notices' }
      );
      return rows.map((r) => ({
        when: r.date_and_time,
        body: r.organization,
        type: r.type,
        location: r.location,
        details: r.meeting_link?.url?.replace('.com//', '.com/'),
        agenda: r.agenda_link?.url,
      }));
    }
    default: {
      const plugin = pluginsFor(ctx.plugins, city).find((p) => p.name === name);
      if (!plugin) throw new Error(`Unknown tool ${name}`);
      return plugin.run(pluginContext(ctx), args);
    }
  }
}
