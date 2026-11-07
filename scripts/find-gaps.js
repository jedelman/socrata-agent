#!/usr/bin/env node
// Find candidate gaps: a read-only profile of the datasets the city profile
// and plugins use (docs/gaps.md §5.5). It never registers a gap. A steward
// promotes a candidate by PR, with its catalog entry, questions and actions.
//
//   node scripts/find-gaps.js [--city norfolk]
//
// Writes data/gaps/<city>.candidates.json with the trace. That path is
// gitignored: candidates are never committed, bundled or served.
//
// Every query runs at GENERIC access under the positional identifier rule
// (src/gaps/measures.js): location columns appear only as IS NULL, and
// person columns and assigned_crew never appear.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createContext } from '../src/agent.js';
import { applyConfig } from '../src/plugins.js';
import { getCity } from '../src/cities/index.js';
import { MeasureRunner, isLocationColumn, buildDate, daysSince, num } from '../src/gaps/measures.js';
import { sentences } from '../src/gaps/kinds.js';
import { Recorder, CATALOGS } from './build-gaps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Datasets plugins read (each plugin's file names its ids; checked 2026-11-06).
const PLUGIN_DATASETS = { norfolk: ['cmvv-agyb', 'qzfe-wj25', 'fq5y-c2yn', 'iz5u-2wb3', 'mgyn-4sni', 'nbz2-dgus', 'uvc6-r75u', 'suf7-r643'] };
const SELF_LIMITING = /\b(no official|not been|estimate[sd]?|pilot|sample[sd]?|in the process of|approximate|may not|partial|incomplete|not all)\b/i;
const FREQUENCY_DAYS = { daily: 1, weekly: 7, monthly: 31, quarterly: 92, annually: 366, yearly: 366 };
const CREATED = /^(created|created_date|created_datetime|date_created|application_date|requested_date|complaint_created_date)$/;
const ENDED = /^(end_date|closed_date|completed_date|finaled_date|corrected_date|date_closed|completed)$/;
const STOP = new Set('with from that this have their what which when where whether each every from since all any and the for per now data records record city city\'s about other into than them they were been being under over plan plans version final'.split(' '));

/** Words from the case files' records_to_request and what_would_help, to check against column names. */
function concepts(root) {
  const words = new Set();
  for (const f of readdirSync(join(root, 'data/cases')).filter((x) => x.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(root, 'data/cases', f), 'utf8'));
    const texts = [...(doc.records_to_request || []), ...(doc.what_would_help || []).map((h) => h.text)];
    for (const t of texts) for (const w of String(t).toLowerCase().match(/[a-z]{5,}/g) || []) if (!STOP.has(w)) words.add(w.replace(/s$/, ''));
  }
  return [...words].sort();
}

export async function findGaps({ cityId = 'norfolk', recorder = new Recorder(), today = buildDate(), root = ROOT, appToken } = {}) {
  const { catalog, config } = CATALOGS[cityId];
  const city = applyConfig(getCity(cityId), config);
  const ctx = createContext({ city, appToken, fetchImpl: recorder.fetch });
  const run = new MeasureRunner({ ctx, readOf: (u) => recorder.readOf(u), bodyOf: (u) => recorder.bodyOf(u), catalogName: 'find-gaps' });
  const ids = [...new Set([city.address?.dataset, ...(city.parcelDatasets || []).map((d) => d.id), ...(city.streetDatasets || []).map((d) => d.id), city.meetings?.noticesDataset, ...(PLUGIN_DATASETS[cityId] || [])].filter(Boolean))].sort();
  const words = concepts(root);
  const candidates = [];
  const skipped = [];
  for (const id of ids) {
    if (ctx.socrata.restricted(id)) {
      skipped.push({ dataset: id, reason: 'restricted: out of reach at GENERIC access; a restricted gap is policy evidence only' });
      continue;
    }
    let d;
    try {
      d = await run.describe(id);
    } catch (err) {
      skipped.push({ dataset: id, reason: String(err.message).slice(0, 200) });
      continue;
    }
    const cols = d.columns.filter((c) => !c.withheld).map((c) => c.field);
    const out = { dataset: id, name: d.name, read: d.read };
    try {
      const loc = cols.filter(isLocationColumn);
      if (loc.length) {
        const r = await run.query(id, `SELECT count(*) AS whole${loc.map((c, i) => `, sum(case(${c} IS NULL,1,true,0)) AS n${i}`).join('')}`, 'location null shares');
        const whole = num(r.rows[0], 'whole');
        out.location_nulls = loc.map((c, i) => ({ column: c, null: num(r.rows[0], `n${i}`), of: whole }));
      }
      const created = cols.find((c) => CREATED.test(c));
      const ended = cols.find((c) => ENDED.test(c));
      if (created && ended) {
        const r = await run.query(id, `SELECT count(*) AS whole, sum(case(date_trunc_ymd(${ended}) < date_trunc_ymd(${created}),1,true,0)) AS before, sum(case(date_trunc_ymd(${ended}) = date_trunc_ymd(${created}),1,true,0)) AS same, max(${ended}) AS last_end WHERE ${ended} IS NOT NULL`, 'end vs created');
        const row = r.rows[0] || {};
        out.created_vs_end = { created, ended, whole: num(row, 'whole'), before: num(row, 'before'), same: num(row, 'same'), last_end: row.last_end || null, after_read_date: row.last_end ? String(row.last_end).slice(0, 10) > today : false };
      }
      if (d.updated) {
        const freq = String(d.update_frequency || '').toLowerCase();
        const every = Object.entries(FREQUENCY_DAYS).find(([k]) => freq.includes(k))?.[1] || null;
        const age = daysSince(d.updated, today);
        out.publishing = { rows_updated: d.updated.slice(0, 10), age_days: age, stated_frequency: d.update_frequency || null, overdue: every ? age > 2 * every : null };
      }
      const limiting = sentences(d.full_description || '').filter((s) => SELF_LIMITING.test(s));
      if (limiting.length) out.self_limiting_sentences = limiting;
      out.concepts_with_no_column = words.filter((w) => !cols.some((c) => c.includes(w)));
    } catch (err) {
      out.error = String(err.message).slice(0, 300);
    }
    candidates.push(out);
  }
  const topics = [];
  for (const topic of Object.values(catalog.TOPICS)) {
    const s = await run.catalogSearch(topic.search);
    const known = new Set([...topic.datasets, ...topic.not_in_topic.map((x) => x.id)]);
    topics.push({ topic: topic.name, search: topic.search, result_set_size: s.result_set_size, not_placed: s.results.filter((r) => !known.has(r.id)) });
  }
  return {
    city: cityId,
    run: today,
    note: 'Candidates only, never gaps. Never commit, bundle or serve this file. A steward promotes a candidate by PR.',
    candidates,
    skipped,
    topics,
    trace: ctx.trace.steps.map((s) => ({ n: s.n, tool: s.tool, dataset: s.dataset, url: s.url, soql: s.soql, ok: s.ok, rows: s.rows })),
  };
}

async function main() {
  const { values } = parseArgs({ options: { city: { type: 'string', default: 'norfolk' } } });
  if (!CATALOGS[values.city]) throw new Error(`No gap catalog for ${values.city}.`);
  const out = await findGaps({ cityId: values.city, appToken: process.env.SOCRATA_APP_TOKEN });
  mkdirSync(join(ROOT, 'data/gaps'), { recursive: true });
  const path = `data/gaps/${values.city}.candidates.json`;
  writeFileSync(join(ROOT, path), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${out.candidates.length} datasets profiled, ${out.skipped.length} skipped, ${out.trace.length} requests. Wrote ${path} (gitignored).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
