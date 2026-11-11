// Tool definitions (OpenAI/OpenRouter function-calling format) and their
// executors. Which tools a city gets depends on what its profile supports.

import { blockReport, lookupAddress, searchLegislation } from './block.js';
import { soqlString, ACCESS } from './socrata.js';
import { pluginToolDefs, pluginsFor, pluginContext } from './plugins.js';
import { NOTE_UNANSWERED_TOOL, noteUnanswered } from './gaps/answer.js';
import { offerFollowup, FOLLOWUP_LABEL, MAX_FOLLOWUPS, FOLLOWUP_QUESTION_CHARS } from './followups.js';
import { priorResearch, RESEARCH_SCOPES } from './prior-research.js';

const T = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

// Core tool names no plugin may take, declared or not.
const RESERVED = new Set(['prior_research']);
const SCOPE_TEXT = { account: "this person's own earlier conversations", public: 'public answers on this site', shared: 'sources people shared from their answers' };

// opts.gaps (a built gap file) adds note_unanswered after suggest_data_source;
// offer_followup comes after both. opts.priorResearch ({ scopes }, set by the
// Worker; src/prior-research.js) adds prior_research last among the core tools.
export function toolsFor(city, plugins = [], opts = {}) {
  const tools = [
    T('search_datasets', `Search ${city.name}'s open data catalog by keyword. Returns dataset ids, names and descriptions.`, {
      query: { type: 'string', description: 'Keywords, e.g. "trees", "building permits".' },
    }, ['query']),
    T('describe_dataset', 'Get a dataset\'s columns, description, owning department and update frequency. Call before querying an unfamiliar dataset.', {
      dataset_id: { type: 'string', description: 'Socrata 4x4 id, e.g. "qzfe-wj25".' },
    }, ['dataset_id']),
    T('query_dataset', 'Run a SoQL query on one dataset. Use SELECT/WHERE/GROUP BY/ORDER BY/LIMIT, with single-quoted text; no FROM, joins, unions, |> chains or comments. Columns that identify private people are withheld. Results are capped at 500 rows.', {
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
  tools.push(
    T('suggest_data_source', "When the records you can reach can't answer the question (or only part of it), name the source that would: a specific ordinance, plan, report, dataset or agency record. The person sees a button to ask for it to be added. Call it at most once per question, and only for a source you have reason to think exists; give a url only if you saw it in a tool result.", {
      need: { type: 'string', description: 'What the person wanted to know, in a short sentence, without their address or name.' },
      source: { type: 'string', description: 'The source by name, e.g. "Norfolk City Code, Chapter 45 (Trees)".' },
      url: { type: 'string', description: 'Optional: a link to it, only if a tool result showed one.' },
      why: { type: 'string', description: 'One sentence: what this source would let you answer.' },
    }, ['need', 'source', 'why'])
  );
  if (opts.gaps) tools.push(NOTE_UNANSWERED_TOOL(opts.gaps));
  tools.push(
    T('offer_followup', `When your answer mentions a source you haven't read but your tools returned (a record, legislation or meeting page, a document section, a dataset page, a web page your search found), offer to read it: the person sees a button under your answer reading "${FOLLOWUP_LABEL}" that asks your question for them. Only for a source a tool result in this conversation showed; for one your tools can't reach, call suggest_data_source instead. At most ${MAX_FOLLOWUPS} per answer.`, {
      question: { type: 'string', description: `The question the button asks, as the person would ask it, under ${FOLLOWUP_QUESTION_CHARS} characters, e.g. "What does the Planning Commission staff report on this rezoning say?" No address, names, contact details or links.` },
      source_title: { type: 'string', description: 'The source by name, as the tool result showed it.' },
      url: { type: 'string', description: "The source's url, exactly as a tool result in this conversation showed it." },
    }, ['question', 'source_title', 'url'])
  );
  const scopes = RESEARCH_SCOPES.filter((x) => (opts.priorResearch?.scopes || []).includes(x));
  if (scopes.length) {
    tools.push(
      T('prior_research', `Search earlier research for where to look: ${scopes.map((x) => SCOPE_TEXT[x]).join(', ')}. For each match it returns the day, the question when it can be shown, and the sources that answer read (title, link, kind, the day read), never what an earlier answer concluded. Call it first, once, when earlier research may cover the question (a place, project, plan or topic), then re-read what you rely on.`, {
        query: { type: 'string', description: 'A few keywords naming the place, project or topic, e.g. "MacArthur Center redevelopment". No address, names or contact details.' },
      }, ['query'])
    );
  }
  const core = new Set([...tools.map((t) => t.function.name), ...RESERVED]);
  for (const def of pluginToolDefs(plugins, city)) {
    if (core.has(def.function.name)) throw new Error(`Plugin "${def.function.name}" would replace a core tool.`);
    tools.push(def);
  }
  return tools;
}

const ROW_CAP = 60;

function capRows(rows) {
  if (!Array.isArray(rows) || rows.length <= ROW_CAP) return rows;
  return { first_rows: rows.slice(0, ROW_CAP), note: `${rows.length} rows returned; showing ${ROW_CAP}. The "these rows as CSV" link in the resources list has all ${rows.length}.` };
}

export async function runTool(ctx, name, args) {
  const { socrata, iqm2, indexes, city, resources } = ctx;
  switch (name) {
    case 'suggest_data_source': {
      if (ctx.suggestions.length >= 2) return { noted: false, note: 'Two sources are already suggested for this question.' };
      const clip = (s, n) => String(s ?? '').trim().slice(0, n);
      const url = clip(args.url, 500);
      ctx.suggestions.push({ need: clip(args.need, 300), source: clip(args.source, 200), why: clip(args.why, 300), ...(/^https:\/\//i.test(url) ? { url } : {}) });
      return { noted: true, note: 'The person will see this suggestion with a button to request it. In your answer, say plainly what you could not find and that they can ask for this source to be added.' };
    }
    case 'offer_followup':
      return offerFollowup(ctx, args);
    case 'prior_research':
      // Gated in code: without the Worker's search this is an unknown tool, whatever the model emits.
      return priorResearch(ctx, args);
    case 'note_unanswered':
      // Gated in code: with gaps off this is an unknown tool, whatever the model emits.
      if (!ctx.gaps) throw new Error(`Unknown tool ${name}`);
      return noteUnanswered(ctx, args);
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
        { access: ACCESS.CORE, tool: 'upcoming meetings', name: 'Public Meeting Notices' }
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
