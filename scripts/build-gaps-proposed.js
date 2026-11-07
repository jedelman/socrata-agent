#!/usr/bin/env node
// Measure PROPOSED gap entries live, for Jason's review (docs/gaps.md §4:
// catalog entries go public when merged, and each new one needs his
// approval). Read-only against the portal. Never touches the catalog's own
// files: data/gaps/norfolk.json, its trace, the street list or
// docs/gaps-norfolk.md.
//
//   node scripts/build-gaps-proposed.js [--set norfolk-budget]   measure live, then write
//   node scripts/build-gaps-proposed.js --offline                replay the stored responses,
//                                                                recompute the parts that come
//                                                                from repo files (the agenda
//                                                                index, case-file findings)
//                                                                dated today, and write
//   node scripts/build-gaps-proposed.js --check                  replay the stored responses
//                                                                against the current repo files
//                                                                and fail on any difference
//                                                                (no network)
//
// --check reads the repo files as they stand, so a case-file or agenda-index
// change makes it fail until --offline (or a live build) rewrites the page;
// npm test replays against the pinned case files and isn't moved by that.
//
// Writes, for the set norfolk-budget:
//   data/gaps/proposed-norfolk-budget.trace.json   every request and response, plus the
//                                                  built records in the catalog's schema
//                                                  (`file`). Not bundled, not served.
//   docs/gaps-budget-proposed.md                   the proposals as a page
//
// It runs the catalog's own builder (scripts/build-gaps.js buildGaps) on the
// proposed module, so every measure goes through the fixed menu at GENERIC
// access through the traced client, under the positional identifier rule,
// and every gap string takes the builder's text checks with the live street
// list. The proposal's own prose (why each is a gap, reviewer context, the
// review of each candidate) takes the same checks as a statement.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import siren from '../deployments/siren.config.js';
import { buildGaps, Recorder, dateOf } from './build-gaps.js';
import { buildDate } from '../src/gaps/measures.js';
import { gapCheck, fmt, KINDS } from '../src/gaps/kinds.js';
import { publicTextViolations, compileStreets } from '../src/public-text.js';
import { validateGap, validateGapFile } from '../src/gaps/schema.js';
import * as norfolkCatalog from '../src/gaps/norfolk.js';
import { ACTIONS as NORFOLK_ACTIONS } from '../src/gaps/actions-norfolk.js';
import * as norfolkBudget from '../src/gaps/proposed/norfolk-budget.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PROPOSALS = Object.freeze({
  'norfolk-budget': {
    module: norfolkBudget,
    city: 'norfolk',
    approved: { catalog: norfolkCatalog, actions: NORFOLK_ACTIONS },
    config: siren,
    title: 'Proposed budget gaps: Norfolk',
    trace: 'data/gaps/proposed-norfolk-budget.trace.json',
    doc: 'docs/gaps-budget-proposed.md',
    module_path: 'src/gaps/proposed/norfolk-budget.js',
  },
});

const stringify = (x) => `${JSON.stringify(x, null, 2)}\n`;

/** Problems with a proposal module before anything is measured ([] if none). */
export function proposalProblems(p) {
  const m = p.module;
  const out = [];
  if (m.PROPOSED !== true) out.push(`${p.module_path} must export PROPOSED = true.`);
  const approvedIds = new Set([...p.approved.catalog.GAPS.map((g) => g.id), ...p.approved.catalog.RETIRED]);
  const approvedActions = new Set(p.approved.actions.map((a) => a.id));
  const ids = new Set();
  for (const g of m.GAPS) {
    if (g.proposed !== true) out.push(`${g.id}: every proposed entry carries proposed: true.`);
    if (approvedIds.has(g.id)) out.push(`${g.id}: already an approved or retired catalog id.`);
    if (ids.has(g.id)) out.push(`${g.id}: duplicate id.`);
    ids.add(g.id);
    for (const r of g.related || []) if (!p.approved.catalog.GAPS.some((x) => x.id === r)) out.push(`${g.id}: related id ${r} is not in the approved catalog.`);
    if (!g.why) out.push(`${g.id}: says why it is a gap (why).`);
    if (g.sources?.length && !g.context) out.push(`${g.id}: a cited source comes with reviewer context.`);
    for (const k of ['proposed', 'why', 'context', 'related', 'sources']) if (k in g && !(m.REVIEW_KEYS || []).includes(k)) out.push(`${g.id}: ${k} is a review-only key, so REVIEW_KEYS lists it.`);
    for (const a of g.actions) if (!m.ACTIONS.some((x) => x.id === a)) out.push(`${g.id}: names action ${a}, which the proposal doesn't define.`);
  }
  for (const a of m.ACTIONS) if (approvedActions.has(a.id)) out.push(`${a.id}: already an approved action id.`);
  return out;
}

/** The proposal's own prose: why, context and the candidate review, each checked as a statement. */
export function proseProblems(p, streets) {
  const out = [];
  const check = (where, s) => {
    for (const v of [...gapCheck(s, 'statement'), ...publicTextViolations(s, { streets })]) out.push(`${where}: ${v}`);
  };
  for (const g of p.module.GAPS) {
    check(`${g.id} why`, g.why);
    if (g.context) check(`${g.id} context`, g.context);
  }
  for (const r of p.module.REVIEW) {
    check(`review ${r.candidate}`, r.reason);
    // Labels: rule A and the public-text checks (ids hold the word "no").
    for (const s of [r.candidate, r.outcome]) for (const v of [...gapCheck(s, 'action'), ...publicTextViolations(s, { streets })]) out.push(`review label ${s}: ${v}`);
  }
  for (const g of p.module.GAPS) for (const src of g.sources || []) {
    if (!/^https:\/\//.test(src.url) || !/^\d{4}-\d{2}-\d{2}$/.test(src.opened) || !src.pages) out.push(`${g.id}: a source needs an https URL, the pages and the day it was opened.`);
  }
  return out;
}

/**
 * Build one proposal set: the catalog's builder on the proposed module.
 * Returns { file, trace, doc, prose } where prose lists problems in the
 * proposal's own text (the build fails on any).
 */
export async function buildProposed({ set = 'norfolk-budget', recorder, today, repoToday = today, repo, appToken } = {}) {
  const p = PROPOSALS[set];
  if (!p) throw new Error(`No proposal set ${set}.`);
  const problems = proposalProblems(p);
  if (problems.length) throw new Error(problems.join('\n'));
  const out = await buildGaps({
    cityId: p.city,
    recorder,
    today,
    repoToday,
    ...(repo ? { repo } : {}),
    appToken,
    catalogs: { [p.city]: { catalog: p.module, actions: p.module.ACTIONS, config: p.config } },
  });
  for (const g of out.file.gaps) {
    const errs = validateGap(g);
    if (errs.length) throw new Error(`Schema errors in ${g.id}:\n${errs.join('\n')}`);
  }
  const errs = validateGapFile(out.file);
  if (errs.length) throw new Error(`Schema errors in the proposed file:\n${errs.join('\n')}`);
  const streets = compileStreets(out.streets.streets);
  const prose = proseProblems(p, streets);
  if (prose.length) throw new Error(`The proposal's own text fails a check:\n${prose.join('\n')}`);
  const trace = {
    proposed: true,
    set,
    city: p.city,
    built: out.trace.built,
    ...(out.trace.rebuilt ? { rebuilt: out.trace.rebuilt } : {}),
    note: `PROPOSED gap entries from ${p.module_path}, not in the catalog and never bundled or served. Built by scripts/build-gaps-proposed.js with the catalog's own builder: every request in order, each response as read, and the built records in the catalog's schema (file). --check replays these.`,
    file: out.file,
    steps: out.trace.steps,
    responses: out.trace.responses,
  };
  return { file: out.file, trace, streets: out.streets, doc: renderProposalDoc(p, out.file) };
}

// --- The page ----------------------------------------------------------------------------

function shapeLines(g) {
  const h = g.how_much;
  const lines = [];
  if (h.part !== undefined && h.whole !== undefined) lines.push(`part ${fmt(h.part)} of ${fmt(h.whole)} (${h.whole ? Math.round((h.part / h.whole) * 100) : 0}%), read ${h.read}`);
  if (h.series) lines.push(`series: ${h.series.map((x) => `${x.k} ${fmt(x.part)} of ${fmt(x.whole)}`).join(' · ')}`);
  if (h.columns_absent) lines.push(`columns_absent ${h.columns_absent.pattern} over ${Object.entries(h.columns_absent.datasets).map(([id, n]) => `${id} (${n} columns)`).join(', ')}, read ${h.columns_absent.read}`);
  if (h.values) lines.push(`values of ${h.values.dataset}.${h.values.field}: ${fmt(h.values.count)}${h.values.matched.length ? `; matched: ${h.values.matched.map((x) => `“${x}”`).join(', ')}` : '; none matched'}, read ${h.values.read}`);
  if (h.catalog) for (const c of h.catalog) lines.push(`catalog search “${c.q}”: ${fmt(c.result_set_size)}${c.open_to_siren.length ? ` (${c.open_to_siren.map((x) => `${x.name}, ${x.id}`).join('; ')})` : ''}, read ${c.read}`);
  if (h.quote) lines.push(`description quote from ${h.quote.dataset}, read ${h.quote.read}`);
  if (h.published) lines.push(`rows last updated ${h.published.rows_updated}`);
  return lines;
}

function evidenceLine(e) {
  switch (e.type) {
    case 'query':
      return `query on ${e.dataset}, read ${e.read} (trace step ${e.trace_n}): \`${e.soql}\` → \`${JSON.stringify(e.result)}\` ([run it](${e.url}))`;
    case 'metadata':
      return `metadata of ${e.dataset}, read ${e.read} (trace step ${e.trace_n})${e.field ? `: ${e.field}, “${e.quote}”` : e.quote ? `: “${e.quote}”` : `: ${e.columns} columns`}`;
    case 'values':
      return `values of ${e.dataset}.${e.field}, read ${e.read} (trace step ${e.trace_n}), pattern ${e.pattern}: ${e.values.length > 12 ? `${e.values.length} values` : e.values.map((v) => `“${v}”`).join(', ')}; matched ${e.matched.length > 12 ? `${e.matched.length} values` : e.matched.length ? e.matched.map((v) => `“${v}”`).join(', ') : 'none'}`;
    case 'catalog_search':
      return `catalog search “${e.q}”, read ${e.read} (trace step ${e.trace_n}): ${e.result_set_size} (${e.excluded} excluded)${e.open_to_siren.length ? `, open to Siren: ${e.open_to_siren.map((x) => `${x.name} (${x.id})`).join(', ')}` : ''}`;
    case 'index':
      return `count over ${e.file}, built ${e.built}: ${fmt(e.counted)} of ${fmt(e.of)} items`;
    case 'finding':
      return `finding ${e.case}#${e.id}, quote “${e.quote}”, checked ${e.checked} ([source](${e.url}))`;
    default:
      return `${e.type}: ${JSON.stringify(e)}`;
  }
}

export function renderProposalDoc(p, file) {
  const m = p.module;
  const L = [
    `# ${p.title}`,
    '',
    `**PROPOSED, not in the catalog.** Built ${file.built} by \`scripts/build-gaps-proposed.js\` from \`${p.module_path}\`. Generated: edit the proposal module, not this page.`,
    '',
    `Catalog entries go public when merged, and every new one needs Jason’s approval (docs/gaps.md §4). These entries are drafts for that review. Nothing under \`src/\` or \`worker/\` imports the proposal module, \`scripts/build-gaps.js\` never reads it, and no gap here reaches Siren’s answers, the board or the bundled gap file. To approve one, move its entry and actions into \`src/gaps/norfolk.js\` and \`src/gaps/actions-norfolk.js\`, dropping the review-only keys (${(m.REVIEW_KEYS || []).map((k) => `\`${k}\``).join(', ')}), copy with it the source constants and helpers it calls from the proposal module, and rebuild the catalog.`,
    '',
    'Dates are America/New_York calendar dates, as the catalog builder writes them (docs/gaps.md §5.3); read times are UTC.',
    '',
    `Each entry was measured live against data.norfolk.gov through the catalog’s own builder: the fixed measure menu at GENERIC access, through the traced client, under the positional identifier rule. Every statement, short line, title, question, consequence line and action passed \`gapTextViolations\` and \`publicTextViolations\` with the City’s street list, and so did the prose below. Every request and response is in \`${p.trace}\`, with the built records in the catalog’s schema under \`file\`.`,
    '',
    '## Candidates tested',
    '',
    '| Candidate | Outcome | Why |',
    '|---|---|---|',
    ...m.REVIEW.map((r) => `| ${r.candidate} | ${r.outcome} | ${r.reason} |`),
    '',
  ];
  for (const entry of m.GAPS) {
    const g = file.gaps.find((x) => x.id === entry.id);
    L.push(`## ${entry.title}`, '');
    if (!g) {
      const off = file.off_board.find((x) => x.id === entry.id);
      L.push(`\`${entry.id}\` · proposed · not measured today${off ? ` (${off.state}): ${off.reason}` : ''}`, '');
      continue;
    }
    L.push(`\`${g.id}\` · proposed · kind \`${g.kind}\` (${KINDS[g.kind]}) · state if approved: ${g.state} · measured ${g.measured}`, '');
    L.push('**Statement**', '', g.statement, '');
    L.push(`**Short:** ${g.short}`, '');
    L.push('**Shape**', '');
    L.push(`- where: ${g.where.scope}; ${g.where.sources.map((s) => (s.type === 'dataset' ? `${s.name} (${s.id})` : s.name || s.id)).join(', ')}; ${g.where.area}${g.where.span ? `; ${g.where.span.field} ${g.where.span.from} through ${g.where.span.through}` : ''}`);
    for (const s of shapeLines(g)) L.push(`- ${s}`);
    L.push('', '**Questions it leaves unanswered, with consequence lines**', '');
    for (const q of g.questions) L.push(`- ${q.text} (${q.blocks === 'all' ? 'can’t answer' : 'only in part'}${q.answered_in_part_by ? `; half-answered by ${q.answered_in_part_by.map((x) => (x.column ? `${x.dataset}.${x.column}` : x.metadata ? `${x.dataset} ${x.metadata}` : `${x.index}.${x.field}`)).join(', ')}` : ''})  `, `  ${q.consequence}`);
    L.push('', '**Proposed actions**', '');
    for (const id of g.actions) {
      const a = file.actions.find((x) => x.id === id);
      if (!a) continue;
      L.push(`- \`${a.id}\` ${a.kind.replace(/_/g, ' ')}: ${a.text || (a.needs ? `records-request draft: waits for ${a.needs}.` : '')}${a.contact ? ` (ask: ${a.contact.role})` : ''}`);
    }
    L.push('', '**Why it is a gap, not a finding or a complaint**', '', entry.why, '');
    if (entry.related?.length) L.push(`**Linked, not repeated:** ${entry.related.map((r) => `\`${r}\``).join(', ')} (approved catalog).`, '');
    if (entry.context) L.push(`**Reviewer context (not evidence on the board):** ${entry.context}`, '');
    for (const s of entry.sources || []) L.push(`- Source opened ${s.opened}: [${s.title}](${s.url}), ${s.pages}.`);
    if (entry.sources?.length) L.push('');
    L.push('<details><summary>Evidence</summary>', '');
    for (const e of g.evidence) L.push(`- ${evidenceLine(e)}`);
    L.push('', '</details>', '');
  }
  if (file.off_board.length) {
    L.push('## Not measured today', '');
    for (const o of file.off_board) L.push(`- \`${o.id}\` (${o.state}): ${o.reason}`);
    L.push('');
  }
  if (file.meetings) {
    L.push('## Upcoming meetings, for the meeting questions', '', `${file.meetings.note} Read ${dateOf(file.meetings.read)}; calendar: ${file.meetings.calendar}.`, '');
    for (const x of file.meetings.listed) L.push(`- ${x.when.slice(0, 16).replace('T', ' ')} · ${x.body}${x.type ? ` (${x.type})` : ''}`);
    if (file.meetings.listed.length) L.push('');
  }
  return L.join('\n');
}

/** Replay a proposal's stored trace and compare with the committed files. Returns differences ([] if none). */
export async function checkProposed({ set = 'norfolk-budget', root = ROOT, repo } = {}) {
  const p = PROPOSALS[set];
  const read = (f) => readFileSync(join(root, f), 'utf8');
  const stored = JSON.parse(read(p.trace));
  const recorder = new Recorder({ responses: stored.responses });
  const out = await buildProposed({ set, recorder, today: stored.built, repoToday: stored.rebuilt || stored.built, repo: repo || read });
  const diffs = [];
  if (recorder.missing.length) diffs.push(`Requests not in the stored trace (a query changed): ${recorder.missing.join(', ')}`);
  if (read(p.doc) !== out.doc) diffs.push(`${p.doc} differs from what the stored responses build. Run node scripts/build-gaps-proposed.js and review the change.`);
  if (stringify(stored) !== stringify(out.trace)) diffs.push(`${p.trace} differs from what the replay writes.`);
  return diffs;
}

async function main() {
  const { values } = parseArgs({ options: { set: { type: 'string', default: 'norfolk-budget' }, check: { type: 'boolean' }, offline: { type: 'boolean' } } });
  const p = PROPOSALS[values.set];
  if (!p) throw new Error(`No proposal set ${values.set}.`);
  if (values.check) {
    const diffs = await checkProposed({ set: values.set });
    if (diffs.length) {
      console.error(diffs.join('\n'));
      process.exit(1);
    }
    console.log(`${p.trace}: matches its stored responses.`);
    return;
  }
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
  const out = await buildProposed({ set: values.set, recorder, today, repoToday, appToken: process.env.SOCRATA_APP_TOKEN });
  if (recorder.missing.length) throw new Error(`Requests not in the stored trace (a query changed; run a live build): ${recorder.missing.join(', ')}`);
  mkdirSync(join(ROOT, 'data/gaps'), { recursive: true });
  writeFileSync(join(ROOT, p.trace), stringify(out.trace));
  writeFileSync(join(ROOT, p.doc), out.doc);
  console.log(`${out.file.gaps.length} proposed gaps measured, ${out.file.off_board.length} not measured, ${out.trace.steps.length} requests. Wrote ${p.trace}, ${p.doc}.`);
  for (const o of out.file.off_board) console.log(`  not measured: ${o.id} (${o.state}): ${o.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
