#!/usr/bin/env node
// Build a city's gap file: what the records Siren reads can't show, measured
// by code and dated (docs/gaps.md §5). Read-only against the portal.
//
//   node scripts/build-gaps.js [--city norfolk]            --live (default): measure
//                                                          against the portal, then write
//   node scripts/build-gaps.js --offline                   replay the stored responses,
//                                                          recompute the parts that come
//                                                          from repo files (dated today),
//                                                          and write
//   node scripts/build-gaps.js --check                     replay and recompute, and fail
//                                                          on any difference (no network)
//   node scripts/build-gaps.js --same-states <earlier.json>
//                                                          exit 1, listing them, when the
//                                                          committed gap ids or states
//                                                          differ from the earlier file's
//
// Writes:
//   data/gaps/<city>.json          the gaps, bundled by the Worker and the CLI
//   data/gaps/<city>.trace.json    every request: the trace steps, and each response
//                                  (trimmed to the fields the build reads) with the
//                                  time it was read. Not bundled.
//   data/gaps/<city>-streets.json  street names from the City's address list (never
//                                  house numbers), used only by the public-text checks
//                                  to refuse addresses; never rendered
//   docs/gaps-<city>.md            the gaps as a page
//   data/gaps/inventory.json       the running inventory of every gap Siren knows of,
//   docs/gaps-inventory.md         rebuilt from the committed gap files after the write
//                                  (scripts/gaps-inventory.js); --check checks it too
//
// Every query runs at GENERIC access through the traced Socrata client, under
// the positional identifier rule (src/gaps/measures.js). A gap whose measure
// or text fails is isolated: it keeps its last good measurement, marked, or
// stays off the board. Schema errors and identifier-rule violations abort.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createContext } from '../src/agent.js';
import { applyConfig } from '../src/plugins.js';
import { getCity } from '../src/cities/index.js';
import { ACCESS, datasetLinks } from '../src/socrata.js';
import { KINDS, T, gapCheck, fmt } from '../src/gaps/kinds.js';
import { MeasureRunner, IdentifierRuleError, MeasureChange, buildDate, daysSince } from '../src/gaps/measures.js';
import { validateGap, validateGapFile } from '../src/gaps/schema.js';
import { publicTextViolations, compileStreets } from '../src/public-text.js';
import { STALE_DAYS } from './verify-cases.js';
import siren from '../deployments/siren.config.js';
import * as norfolkCatalog from '../src/gaps/norfolk.js';
import { ACTIONS as NORFOLK_ACTIONS, FOIA_LINES, strike, ROW_LEVEL } from '../src/gaps/actions-norfolk.js';
import { writeInventory, checkInventory, inventorySummary } from './gaps-inventory.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOGS = { norfolk: { catalog: norfolkCatalog, actions: NORFOLK_ACTIONS, config: siren } };

export const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
export const gapPublicId = (id) => sha12(`gap\n${id}`);
export const questionPublicId = (gapPublicId_, qid) => sha12(`q\n${gapPublicId_}\nc:${qid}`);
export const actionPublicId = (id) => sha12(`act\n${id}`);

/** America/New_York calendar date of an ISO time. */
export const dateOf = (iso) => buildDate(new Date(iso));

// --- Recording and replaying responses -------------------------------------------------

// Keep only what the build reads, so the trace file stays small and a replay
// sees exactly what the live build saw.
function trimView(v) {
  return {
    id: v.id,
    name: v.name,
    description: v.description ?? null,
    attribution: v.attribution ?? null,
    rowsUpdatedAt: v.rowsUpdatedAt ?? null,
    modifyingViewUid: v.modifyingViewUid ?? null,
    metadata: v.metadata?.custom_fields?.Updates ? { custom_fields: { Updates: v.metadata.custom_fields.Updates } } : {},
    columns: (v.columns || []).map((c) => ({ fieldName: c.fieldName, dataTypeName: c.dataTypeName, ...(c.description ? { description: c.description } : {}) })),
  };
}
function trimCatalog(c) {
  return { resultSetSize: c.resultSetSize, results: (c.results || []).map((r) => ({ resource: { id: r.resource.id, name: r.resource.name } })) };
}
export function trimBody(url, body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && !body.error) {
    if (/\/api\/views\/[a-z0-9]{4}-[a-z0-9]{4}\.json/.test(url)) return trimView(body);
    if (/\/api\/catalog\/v1\?/.test(url)) return trimCatalog(body);
  }
  return body;
}

export class Recorder {
  /** responses: a stored map to replay (no network), or null to fetch live. */
  constructor({ responses = null, fetchImpl, clock = () => new Date().toISOString() } = {}) {
    this.replay = Boolean(responses);
    this.responses = responses ? { ...responses } : {};
    this.missing = [];
    // A replay writes back only the responses it served, so a request the
    // build no longer makes drops out of the trace file.
    this.used = new Set();
    this.realFetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.clock = clock;
    this.fetch = this.fetch.bind(this);
  }

  async fetch(url, init) {
    url = String(url);
    if (this.replay) {
      const r = this.responses[url];
      if (!r) {
        this.missing.push(url);
        throw new Error(`No stored response for ${url}`);
      }
      this.used.add(url);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    const res = await this.realFetch(url, init);
    const text = await res.text();
    let body;
    try {
      body = trimBody(url, JSON.parse(text));
    } catch {
      body = { error: true, message: text.slice(0, 200) };
    }
    this.responses[url] = { read: this.clock(), status: res.status, body };
    return new Response(JSON.stringify(body), { status: res.status });
  }

  readOf(url) {
    return this.responses[url]?.read;
  }
  bodyOf(url) {
    return this.responses[url]?.body;
  }
  toJSON() {
    const keys = Object.keys(this.responses).filter((k) => !this.replay || this.used.has(k));
    return Object.fromEntries(keys.sort().map((k) => [k, this.responses[k]]));
  }
}

// --- Checks on catalog text --------------------------------------------------------------

const STOPWORDS = new Set('the a an and or of to in on for with from by is are was were be been it its this that these those what which who how many much does do did have has had not no any all every city city\'s norfolk tree trees street streets work order orders record records'.split(' '));
const contentWords = (s) => new Set(String(s).toLowerCase().match(/[a-z][a-z'-]{3,}/g)?.filter((w) => !STOPWORDS.has(w)) || []);

/** A general question shares fewer than 3 content words with every not-yet-verified claim. */
export function launders(question, claims) {
  const q = contentWords(question);
  return claims.some((c) => [...contentWords(c)].filter((w) => q.has(w)).length >= 3);
}

export class EvidenceUnverified extends Error {}

/**
 * A street name as the list keeps it (trimmed, upper case, single-spaced), or
 * null for anything that isn't a bare name: a value that starts with a number
 * other than an ordinal ("21ST"), or holds a comma, "&", ";", " AND " or
 * " AT " (an address or a corner).
 */
export function streetName(raw) {
  const n = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (n.length < 2) return null;
  if (/^\d/.test(n) && !/^\d+(?:ST|ND|RD|TH)\b/.test(n)) return null;
  if (/[,&;]| AND | AT /.test(n)) return null;
  return n;
}

// --- The build ---------------------------------------------------------------------------

/**
 * Build one city's gaps. `recorder` fetches live or replays; `today` is the
 * America/New_York date of the live measures; `repoToday` (default `today`)
 * is the date the parts that come from repo files are computed (the agenda
 * index, case-file findings, the city profile's policy): an --offline
 * rebuild replays live measures from `today` and recomputes those parts as
 * of its own date. `repo(path)` reads a repo file; `previous` is the last
 * built file, for last_good. Returns { file, trace, streets, doc }.
 */
export async function buildGaps({ cityId = 'norfolk', recorder, today, repoToday = today, repo = (p) => readFileSync(join(ROOT, p), 'utf8'), previous = null, appToken, catalogs = CATALOGS }) {
  const { catalog, actions: actionDefs, config } = catalogs[cityId];
  const city = applyConfig(getCity(cityId), config);
  const ctx = createContext({ city, appToken, fetchImpl: recorder.fetch });
  const run = new MeasureRunner({ ctx, readOf: (u) => recorder.readOf(u), bodyOf: (u) => recorder.bodyOf(u), catalogName: catalog.CATALOG_NAME });
  const json = (p) => JSON.parse(repo(p));

  const cases = new Map();
  const caseFile = (id) => {
    if (!cases.has(id)) cases.set(id, json(`data/cases/${id}.json`));
    return cases.get(id);
  };
  const notYetVerified = [...new Set(catalog.GAPS.flatMap((g) => (g.touches || []).filter((t) => t.case).map((t) => t.case)))].flatMap((c) =>
    caseFile(c).findings.filter((f) => f.unverified || !f.checked).map((f) => f.claim)
  );

  const ev = {
    query: (r) => ({ type: 'query', dataset: r.dataset, soql: r.soql, url: r.url, result: r.rows, read: r.read, trace_n: r.trace_n }),
    metadata: (d, extra = {}) => ({ type: 'metadata', dataset: d.dataset || d.id, ...extra, url: d.url, read: d.read, trace_n: d.trace_n }),
    field: (fd) => ({ type: 'metadata', dataset: fd.dataset, field: fd.field, quote: fd.quote, url: fd.url, read: fd.read, trace_n: fd.trace_n }),
    finding: (f) => ({ type: 'finding', case: f.case, id: f.id, url: f.source.url, quote: f.quote, ...(f.selector ? { selector: f.selector } : {}), checked: f.checked, reverified: null }),
    catalog: (s) => ({ type: 'catalog_search', q: s.q, result_set_size: s.result_set_size, excluded: s.excluded, open_to_siren: s.results.filter((r) => r.open_to_siren).map((r) => ({ id: r.id, name: r.name })), url: s.url, read: s.read, trace_n: s.trace_n }),
    values: (v) => ({ type: 'values', dataset: v.dataset, field: v.field, values: v.values, pattern: v.pattern, matched: v.matched, url: v.url, read: v.read, trace_n: v.trace_n }),
  };
  const helpers = {
    run,
    today,
    repoToday,
    dateOf,
    ev,
    finding(caseId, id) {
      const f = caseFile(caseId).findings.find((x) => x.id === id);
      if (!f) throw new EvidenceUnverified(`No finding ${caseId}#${id}.`);
      if (f.unverified || !f.checked || !f.quote) throw new EvidenceUnverified(`Finding ${caseId}#${id} is not verified.`);
      if (daysSince(f.checked, repoToday) > STALE_DAYS) throw new EvidenceUnverified(`Finding ${caseId}#${id} was last checked ${f.checked}, more than ${STALE_DAYS} days ago.`);
      return { ...f, case: caseId };
    },
    index: (id) => json(`data/${id}.json`),
    policy(dataset) {
      const r = ctx.socrata.restricted(dataset);
      if (!r) throw new MeasureChange(`${dataset} is no longer restricted.`);
      const file = `src/cities/${cityId}.js`;
      const line = repo(file).split('\n').findIndex((l) => l.includes(`id: '${dataset}'`)) + 1;
      if (!line) throw new MeasureChange(`${dataset} is not in ${file}.`);
      return { reason: r.reason, file, line };
    },
  };

  // Streets first: the public-text checks below need them. A separate,
  // reviewed step, not a measure: one GROUP BY over the City's address list
  // (its street_name field holds names only, never a house number), paged,
  // used only in refusal checks and never rendered. Free-text street fields
  // (Work Orders' `street`) aren't read: they hold house addresses and
  // corners as typed.
  const streetSources = [{ dataset: city.address.dataset, field: city.address.fields.streetName }];
  const names = new Set();
  for (const s of streetSources) {
    for (let offset = 0; offset < 20000; offset += 500) {
      const rows = await ctx.socrata.query(s.dataset, `SELECT ${s.field} AS s WHERE ${s.field} IS NOT NULL GROUP BY ${s.field} ORDER BY ${s.field} LIMIT 500 OFFSET ${offset}`, {
        tool: 'street list for the public-text checks',
        access: ACCESS.GENERIC,
      });
      for (const r of rows) {
        const n = streetName(r.s);
        if (n) names.add(n);
      }
      if (rows.length < 500) break;
    }
  }
  const streetList = [...names].sort();
  const streets = { city: cityId, built: today, sources: streetSources, note: "Street names from the City's address list, used only to refuse addresses in public text. Never rendered.", streets: streetList };
  const streetPatterns = compileStreets(streetList);

  // Topics: every catalog hit for a topic's search is in the topic or placed
  // outside it by a reviewer. Only the topics this catalog's entries name are
  // checked: a topic no entry names yet is structure, measured by the build
  // whose entries name it, and adds no request here.
  const topicErrors = {};
  const renderedTopics = {};
  const usedTopics = new Set(catalog.GAPS.map((g) => g.topic).filter(Boolean));
  for (const name of usedTopics) if (!catalog.TOPICS[name]) throw new Error(`An entry names topic ${name}, which isn't defined.`);
  for (const [name, topic] of Object.entries(catalog.TOPICS).filter(([n]) => usedTopics.has(n))) {
    let s;
    try {
      s = await run.catalogSearch(topic.search);
    } catch (err) {
      if (!(err instanceof MeasureChange)) throw err;
      topicErrors[name] = err.message;
      continue;
    }
    const known = new Set([...topic.datasets, ...topic.not_in_topic.map((x) => x.id)]);
    const stray = s.results.filter((r) => !known.has(r.id));
    if (stray.length) topicErrors[name] = `Catalog hits for “${topic.search}” not placed in or out of the topic: ${stray.map((r) => r.id).join(', ')}.`;
    // A placement outside the topic quotes the dataset's own description,
    // read in this build: the whole of what the reviewer weighed, so the
    // reason can't stand on half of it. A dataset Siren's rule keeps from
    // open-ended use can't be described at GENERIC access: it is placed by
    // the rule itself (file:line, read from the repo), and if the rule goes,
    // the topic's gaps wait for a reviewer.
    const placed = [];
    for (const x of topic.not_in_topic) {
      try {
        if (x.policy) {
          const p = helpers.policy(x.id);
          const hit = s.results.find((r) => r.id === x.id);
          placed.push({ id: x.id, name: hit?.name || x.id, policy: p, reason: x.reason, placed: x.placed });
          continue;
        }
        const q = await run.descriptionQuote(x.id, x.quote);
        placed.push({ id: x.id, name: run.describes.get(x.id).name, quote: q.quote, reason: x.reason, placed: x.placed, read: q.read, trace_n: q.trace_n });
      } catch (err) {
        if (!(err instanceof MeasureChange)) throw err;
        topicErrors[name] = err.message;
      }
    }
    renderedTopics[name] = { ...topic, not_in_topic: placed, ...(topic.cleared ? { cleared: topic.cleared.map((c) => ({ ...c })) } : {}) };
  }

  const prevById = new Map((previous?.gaps || []).map((g) => [g.id, g]));
  const gaps = [];
  const offBoard = [];
  const fail = (entry, state, reason) => {
    const prev = prevById.get(entry.id);
    if (state === 'unmeasured_today' && prev && ['open', 'closing', 'unmeasured_today'].includes(prev.state)) {
      const last = prev.last_good || prev.measured;
      gaps.push({ ...prev, state: 'unmeasured_today', last_good: last, notice: T.unmeasured({ today, last }) });
    } else {
      offBoard.push({ id: entry.id, state, reason: String(reason).slice(0, 500) });
    }
  };

  for (const entry of catalog.GAPS) {
    if (catalog.RETIRED.includes(entry.id)) throw new Error(`${entry.id} is a retired id.`);
    let m;
    try {
      if (entry.topic && topicErrors[entry.topic]) throw new MeasureChange(topicErrors[entry.topic]);
      m = await entry.measure.call(entry, helpers);
    } catch (err) {
      if (err instanceof IdentifierRuleError) throw err;
      fail(entry, err instanceof EvidenceUnverified ? 'evidence_unverified' : 'unmeasured_today', err.message);
      continue;
    }
    const pid = gapPublicId(entry.id);
    const record = {
      id: entry.id,
      public_id: pid,
      kind: entry.kind,
      label: KINDS[entry.kind],
      title: entry.title,
      ...(entry.optional ? { optional: true } : {}),
      where: {
        sources: entry.where.sources.map((s) =>
          s.type === 'catalog' ? { type: 'catalog', id: s.id } : s.type === 'index' ? { type: 'index', id: s.id, name: s.name } : { type: 'dataset', id: s.id, name: s.name || run.describes.get(s.id)?.name || s.id }
        ),
        scope: entry.where.scope,
        ...(entry.where.status ? { status: entry.where.status } : {}),
        area: entry.where.area,
        ...(m.span ? { span: m.span } : {}),
      },
      topic: entry.topic ? renderedTopics[entry.topic] : null,
      checked_live: entry.checked_live,
      how_much: m.how_much,
      evidence: m.evidence,
      statement: m.statement,
      short: m.short,
      questions: entry.questions.map((q) => ({
        qid: q.qid,
        public_id: questionPublicId(pid, q.qid),
        text: q.text,
        blocks: q.blocks,
        ...(q.answered_in_part_by ? { answered_in_part_by: q.answered_in_part_by } : {}),
        consequence: m.consequences[q.qid],
      })),
      actions: entry.actions,
      touches: entry.touches,
      bites_when: entry.bites_when,
      closed_when: entry.closed_when,
      state: m.closing ? 'closing' : 'open',
      measured: m.measured || today,
      hand_off: entry.where.sources
        .filter((s) => /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(s.id) && !ctx.socrata.restricted(s.id))
        .map((s) => {
          const l = datasetLinks(city, s.id);
          return { id: s.id, name: s.name || run.describes.get(s.id)?.name || s.id, page: l.page, docs: l.docs };
        }),
    };
    const schema = validateGap(record);
    if (schema.length) throw new Error(`Schema errors in ${entry.id}:\n${schema.join('\n')}`);
    const problems = gapTextProblems(record, { entry, streets: streetPatterns, notYetVerified });
    if (problems.length) {
      fail(entry, 'unmeasured_today', `Text checks: ${problems.join(' | ')}`);
      continue;
    }
    gaps.push(record);
  }

  // Actions: only those an entry names, each with the gaps that name it.
  const usedBy = new Map();
  for (const g of catalog.GAPS) for (const a of g.actions) usedBy.set(a, [...(usedBy.get(a) || []), g.id]);
  const clerk = (city.contacts || []).find((c) => /^City Clerk/.test(c.role));
  const actions = [];
  for (const a of actionDefs) {
    if (!usedBy.has(a.id)) continue;
    const gapIds = usedBy.get(a.id);
    const rec = { id: a.id, public_id: actionPublicId(a.id), kind: a.kind, gaps: gapIds };
    for (const k of ['text', 'available', 'audience', 'aggregate_only', 'needs']) if (a[k] !== undefined) rec[k] = a[k];
    if (a.from) {
      const text = caseFile(a.from.case).records_to_request[a.from.records_to_request];
      if (!text) throw new Error(`${a.id}: no records_to_request[${a.from.records_to_request}] in ${a.from.case}.`);
      let body = text;
      for (const s of a.strikes || []) {
        const d = await run.describe(s.dataset);
        if (!d.columns.some((c) => c.field === s.column)) throw new Error(`${a.id}: the strike for "${s.phrase}" needs column ${s.dataset}.${s.column}, which is gone.`);
        body = strike(body, s.phrase);
      }
      rec.draft = { to: FOIA_LINES.to, body, source: { case: a.from.case, records_to_request: a.from.records_to_request, text }, ...(a.strikes ? { strikes: a.strikes } : {}), leave_out: FOIA_LINES.leave_out, frame: FOIA_LINES.frame(repoToday) };
    }
    if (a.kind === 'meeting_question' && clerk) rec.contact = { role: clerk.role, ...(clerk.phone ? { phone: clerk.phone } : {}), ...(clerk.email ? { email: clerk.email } : {}), ...(clerk.note ? { note: clerk.note } : {}) };
    const texts = [rec.text, rec.draft?.body, rec.draft?.frame, rec.draft?.leave_out].filter(Boolean);
    for (const s of texts) {
      const bad = [...gapCheck(s, 'action'), ...publicTextViolations(s, { streets: streetPatterns })];
      if (bad.length) throw new Error(`${a.id}: action text fails a check (${bad.join(', ')}): ${s}`);
    }
    const restrictedGap = gapIds.some((id) => catalog.GAPS.find((g) => g.id === id)?.kind === 'restricted');
    if (restrictedGap && (!a.aggregate_only || texts.some((s) => ROW_LEVEL.test(s)))) throw new Error(`${a.id}: a restricted gap takes only aggregate_only actions that ask for no rows.`);
    actions.push(rec);
  }
  for (const id of usedBy.keys()) if (!actionDefs.some((a) => a.id === id)) throw new Error(`An entry names action ${id}, which isn't defined.`);

  // Upcoming meetings, for meeting questions: as listed on the build date.
  let meetings = null;
  if (city.meetings?.noticesDataset) {
    // A failed listing leaves meeting questions without dates, never the build.
    const r = await run.query(city.meetings.noticesDataset, `SELECT date_and_time, organization, type WHERE date_and_time >= '${today}T00:00:00' ORDER BY date_and_time LIMIT 25`, 'upcoming public meetings').catch(() => null);
    if (r) meetings = {
      read: r.read,
      listed: r.rows.map((x) => ({ when: String(x.date_and_time || ''), body: String(x.organization || ''), type: String(x.type || '') })),
      calendar: `${city.meetings.iqm2}/Citizens/Calendar.aspx`,
      note: `As listed on ${today}; check the City's calendar.`,
    };
  }

  gaps.sort((a, b) => a.id.localeCompare(b.id));
  offBoard.sort((a, b) => a.id.localeCompare(b.id));
  const file = {
    city: cityId,
    built: today,
    ...(repoToday !== today ? { rebuilt: repoToday } : {}),
    note: 'Built by scripts/build-gaps.js. Every number comes from a dated query, metadata or a bundled file; the requests are in the trace file beside this one.',
    gaps,
    off_board: offBoard,
    retired: [...catalog.RETIRED],
    not_a_gap: catalog.NOT_A_GAP.map((x) => ({ ...x })),
    actions,
    ...(meetings ? { meetings } : {}),
  };
  const errs = validateGapFile(file);
  if (errs.length) throw new Error(`Schema errors in the gap file:\n${errs.join('\n')}`);

  const trace = {
    city: cityId,
    built: today,
    ...(repoToday !== today ? { rebuilt: repoToday } : {}),
    note: 'Every request the gap build made, in order, and each response as read (trimmed to the fields the build uses). build-gaps --check replays these.',
    steps: ctx.trace.steps.map((s) => ({ n: s.n, tool: s.tool, ...(s.dataset ? { dataset: s.dataset } : {}), url: s.url, ...(s.soql ? { soql: s.soql } : {}), ok: s.ok, rows: s.rows, ...(s.error ? { error: s.error } : {}) })),
    responses: recorder.toJSON(),
  };
  return { file, trace, streets, doc: renderDoc(file) };
}

/** Every text check a built gap must pass (docs/gaps.md §6.2, §6.3, §7.1). */
export function gapTextProblems(g, { entry = {}, streets, notYetVerified = [] } = {}) {
  const out = [];
  const add = (where, list) => list.forEach((x) => out.push(`${where}: ${x}`));
  // Code-written text takes the public-text checks too (§5.3.4), so the
  // builder and botText agree on what can be shown.
  const pub = (x) => publicTextViolations(x, { streets });
  add('statement', [...gapCheck(g.statement, 'statement'), ...pub(g.statement)]);
  add('short', [...gapCheck(g.short, 'short'), ...pub(g.short)]);
  if (g.short.length > 200) out.push(`short: ${g.short.length} characters; the limit is 200`);
  add('title', [...gapCheck(g.title, 'title'), ...pub(g.title)]);
  add('label', gapCheck(g.label, 'label'));
  if (g.notice) add('notice', gapCheck(g.notice, 'statement'));
  for (const q of g.questions) {
    if (!q.consequence) out.push(`${q.qid}: no consequence line`);
    else add(`${q.qid} consequence`, [...gapCheck(q.consequence, 'consequence'), ...pub(q.consequence)]);
    if (q.text.length > 160 || !q.text.endsWith('?')) out.push(`${q.qid}: a general question is at most 160 characters and ends in "?"`);
    add(`${q.qid} question`, publicTextViolations(q.text, { streets }));
    if (launders(q.text, notYetVerified)) out.push(`${q.qid}: shares 3 or more content words with a not-yet-verified claim`);
    if (q.blocks === 'all') {
      const concept = entry.concepts?.[(entry.questions || []).find((x) => x.qid === q.qid)?.concept];
      const ca = g.how_much.columns_absent;
      const topicSets = g.topic?.datasets || [];
      const policy = (entry.questions || []).find((x) => x.qid === q.qid)?.concept === 'policy' && g.kind === 'restricted';
      if (!policy && (!concept || !ca || topicSets.some((d) => !(d in ca.datasets)))) out.push(`${q.qid}: blocks "all" needs columns_absent over every topic dataset for its concept`);
    } else if (!q.answered_in_part_by?.length) out.push(`${q.qid}: blocks "part" names what half-answers it`);
  }
  return out;
}

// --- The page ----------------------------------------------------------------------------

export function renderDoc(file) {
  const lines = [
    `# Gaps in the records Siren reads: ${file.city === 'norfolk' ? 'Norfolk' : file.city}`,
    '',
    `Built ${file.built} by \`scripts/build-gaps.js\` from \`src/gaps/${file.city}.js\`. Generated: edit the catalog, not this page.`,
    '',
    'Each gap is measured by code against the live portal, at the same access the open-ended tools have, and dated. A gap has a shape and consequences: what the records Siren reads hold or leave out, and the questions that leaves unanswered. It never gives a cause. The spec is `docs/gaps.md`; every request behind these numbers is in `data/gaps/' + file.city + '.trace.json`.',
    '',
  ];
  const topics = new Map(file.gaps.filter((g) => g.topic).map((g) => [g.topic.name, g.topic]));
  for (const t of topics.values()) {
    lines.push(`## The ${t.name} topic`, '', `Topic-wide checks read ${t.datasets.join(', ')}. The catalog search “${t.search}” is checked for datasets placed neither in nor out.`, '');
    for (const x of t.not_in_topic) {
      if (x.policy) lines.push(`- Outside the topic: ${x.name} (${x.id}), by Siren's rule (${x.policy.file}:${x.policy.line}): ${x.policy.reason} ${x.reason} ${x.placed}`);
      else lines.push(`- Outside the topic: ${x.name} (${x.id}). Its description, as read ${dateOf(x.read)}, in its words: “${x.quote}” ${x.reason} ${x.placed}`);
    }
    for (const c of t.cleared || []) lines.push(`- Cleared for topic-wide checks: ${c.dataset}.${c.column}. ${c.reason} (${c.by}, ${c.date})`);
    lines.push('');
  }
  for (const g of file.gaps) {
    lines.push(`## ${g.title}`, '', `\`${g.id}\` · ${g.label} · state: ${g.state} · measured ${g.measured}${g.optional ? ' · optional entry' : ''}`, '');
    if (g.notice) lines.push(`> ${g.notice}`, '');
    lines.push(g.statement, '');
    lines.push(`**Where:** ${g.where.scope}; ${g.where.sources.map((s) => (s.type === 'dataset' ? `${s.name} (${s.id})` : s.name || s.id)).join(', ')}${g.where.status ? `; status as recorded: ${g.where.status.as_recorded.join(', ')}` : ''}; ${g.where.area}${g.where.span ? `; ${g.where.span.field} ${g.where.span.from} through ${g.where.span.through}` : ''}.`, '');
    if (g.how_much.series) {
      lines.push('| Year created | With none | Of |', '|---|---|---|');
      for (const s of g.how_much.series) lines.push(`| ${s.k} | ${fmt(s.part)} | ${fmt(s.whole)} |`);
      lines.push('');
    }
    lines.push(`**${'Questions these records can’t answer, or answer only in part'}**`, '');
    for (const q of g.questions) lines.push(`- ${q.text} (${q.blocks === 'all' ? 'can’t answer' : 'only in part'})  `, `  ${q.consequence}`);
    lines.push('', '**What would close it**', '');
    for (const id of g.actions) {
      const a = file.actions.find((x) => x.id === id);
      if (!a) continue;
      const what = a.text || a.draft?.body || (a.needs ? `Records-request draft: waits for ${a.needs}.` : '');
      lines.push(`- ${a.kind.replace(/_/g, ' ')}: ${what}${a.available === false ? ' (not offered yet)' : ''}${a.audience ? ` (${a.audience})` : ''}`);
    }
    const queries = g.evidence.filter((e) => e.type === 'query');
    if (queries.length) {
      lines.push('', '<details><summary>How this was measured</summary>', '');
      for (const e of queries) lines.push(`- \`${e.soql}\` on ${e.dataset}, read ${e.read} ([run it yourself](${e.url}))`);
      lines.push('', '</details>');
    }
    lines.push('');
  }
  if (file.off_board.length) {
    lines.push('## Off the board today', '');
    for (const o of file.off_board) lines.push(`- \`${o.id}\` (${o.state}): ${o.reason}`);
    lines.push('');
  }
  lines.push('## Retired ids', '', 'Never reused: ' + file.retired.map((r) => `\`${r}\``).join(', ') + '.', '');
  return lines.join('\n');
}

// --- Files ---------------------------------------------------------------------------------

export const paths = (cityId) => ({
  file: `data/gaps/${cityId}.json`,
  trace: `data/gaps/${cityId}.trace.json`,
  streets: `data/gaps/${cityId}-streets.json`,
  doc: `docs/gaps-${cityId}.md`,
});
const stringify = (x) => `${JSON.stringify(x, null, 2)}\n`;

/** Replay the stored trace and compare every output with what's committed. Returns the differences ([] if none). */
export async function checkGaps({ cityId = 'norfolk', root = ROOT } = {}) {
  const p = paths(cityId);
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const stored = JSON.parse(read(p.trace));
  const recorder = new Recorder({ responses: stored.responses });
  const out = await buildGaps({ cityId, recorder, today: stored.built, repoToday: stored.rebuilt || stored.built, previous: JSON.parse(read(p.file)), repo: read });
  const diffs = [];
  if (recorder.missing.length) diffs.push(`Requests not in the stored trace (a query changed): ${recorder.missing.join(', ')}`);
  const pairs = [[p.file, stringify(out.file)], [p.streets, stringify(out.streets)], [p.doc, out.doc]];
  for (const [f, want] of pairs) if (read(f) !== want) diffs.push(`${f} differs from what the stored responses and current repo files build. Run node scripts/build-gaps.js --offline (or a live build) and review the change.`);
  if (stringify(stored) !== stringify(out.trace)) diffs.push(`${p.trace} differs from what the replay writes. Run node scripts/build-gaps.js --offline and review the change.`);
  if (JSON.stringify(stored.steps) !== JSON.stringify(out.trace.steps)) diffs.push(`${p.trace}: the replayed requests differ from the stored steps.`);
  diffs.push(...checkInventory({ root, catalogs: CATALOGS }));
  return diffs;
}

/**
 * What an offline rebuild changed about the board: gaps that came on or went
 * off it, or changed state. [] when the set of ids and states is the same.
 * A change goes to a pull request, never straight to main (docs/gaps.md §5.4).
 */
export function stateChanges(before, after) {
  const states = (f) => new Map([...(f?.gaps || []).map((g) => [g.id, g.state]), ...(f?.off_board || []).map((o) => [o.id, `off the board (${o.state})`])]);
  const a = states(before);
  const b = states(after);
  const out = [];
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (a.get(id) !== b.get(id)) out.push(`${id}: ${a.get(id) || 'not in the file'} -> ${b.get(id) || 'not in the file'}`);
  }
  return out;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { city: { type: 'string', default: 'norfolk' }, live: { type: 'boolean' }, offline: { type: 'boolean' }, check: { type: 'boolean' }, 'same-states': { type: 'boolean' } } });
  const cityId = values.city;
  if (!CATALOGS[cityId]) throw new Error(`No gap catalog for ${cityId}.`);
  const p = paths(cityId);
  if (values['same-states']) {
    // build-gaps --same-states <earlier file>: exits 1, listing the changes,
    // when the committed file's gap ids or states differ from the earlier one.
    if (!positionals[0]) throw new Error('--same-states needs the earlier gap file.');
    const changes = stateChanges(JSON.parse(readFileSync(positionals[0], 'utf8')), JSON.parse(readFileSync(join(ROOT, p.file), 'utf8')));
    if (changes.length) {
      console.error(changes.join('\n'));
      process.exit(1);
    }
    console.log('The gap ids and states are unchanged.');
    return;
  }
  if (values.check) {
    const diffs = await checkGaps({ cityId });
    if (diffs.length) {
      console.error(diffs.join('\n'));
      process.exit(1);
    }
    console.log(`${p.file}: matches its stored responses and current inputs.`);
    return;
  }
  const previous = existsSync(join(ROOT, p.file)) ? JSON.parse(readFileSync(join(ROOT, p.file), 'utf8')) : null;
  let recorder;
  let today;
  let repoToday;
  if (values.offline) {
    // Live measures keep the date they were read; parts from repo files are
    // recomputed, and dated, today.
    const stored = JSON.parse(readFileSync(join(ROOT, p.trace), 'utf8'));
    recorder = new Recorder({ responses: stored.responses });
    today = stored.built;
    repoToday = buildDate();
  } else {
    recorder = new Recorder();
    today = buildDate();
    repoToday = today;
  }
  const out = await buildGaps({ cityId, recorder, today, repoToday, previous, appToken: process.env.SOCRATA_APP_TOKEN });
  if (recorder.missing.length) throw new Error(`Requests not in the stored trace (a query changed; run a live build): ${recorder.missing.join(', ')}`);
  mkdirSync(join(ROOT, 'data/gaps'), { recursive: true });
  writeFileSync(join(ROOT, p.file), stringify(out.file));
  writeFileSync(join(ROOT, p.trace), stringify(out.trace));
  writeFileSync(join(ROOT, p.streets), stringify(out.streets));
  writeFileSync(join(ROOT, p.doc), out.doc);
  console.log(`${out.file.gaps.length} gaps on the board, ${out.file.off_board.length} off it, ${out.trace.steps.length} requests. Wrote ${Object.values(p).join(', ')}.`);
  for (const o of out.file.off_board) console.log(`  off the board: ${o.id} (${o.state}): ${o.reason}`);
  console.log(inventorySummary(writeInventory({ root: ROOT, catalogs: CATALOGS })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
