// The running inventory of gaps (Jason, 2026-11-09: "I think we should have
// a running inventory of gaps"): one place listing every gap Siren knows of
// and its state, kept current by code, never by hand.
//
// It is built only from committed files: each approved catalog's built gap
// file (data/gaps/<city>.json) with its catalog module, and each proposal
// set's built trace (data/gaps/proposed-<set>.trace.json, which carries the
// built records and each entry's title, questions and actions). It never
// imports a proposal module, and nothing in it moves a proposal into a
// catalog: a proposed entry stays "proposed" until Jason approves it and it
// is moved into src/gaps/<city>.js by PR.
//
// scripts/build-gaps.js and scripts/build-gaps-proposed.js both rewrite it
// after every live or offline build, and both check it under --check.
//
// Writes:
//   data/gaps/inventory.json   schema-checked (src/gaps/schema.js INVENTORY_FILE)
//   docs/gaps-inventory.md     the same as a page
//
// What changed: the inventory keeps the states of the build before the last
// one that changed any state (`previous`), so "what changed" survives a
// rebuild that changes nothing, and --check recomputes it from the file
// itself.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { KINDS, gapCheck, fmt, pct } from '../src/gaps/kinds.js';
import { validateInventory } from '../src/gaps/schema.js';
import { publicTextViolations, compileStreets } from '../src/public-text.js';

export const INVENTORY_PATHS = Object.freeze({ file: 'data/gaps/inventory.json', doc: 'docs/gaps-inventory.md' });
const SET_FILE = /^proposed-([a-z0-9-]+)\.trace\.json$/;
const ON_BOARD = new Set(['open', 'closing', 'unmeasured_today']);

const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const gapPublicId = (id) => sha12(`gap\n${id}`);
const stringify = (x) => `${JSON.stringify(x, null, 2)}\n`;

export const STAYS_CURRENT = [
  'Built by code from the committed gap files, never edited by hand.',
  'scripts/build-gaps.js and scripts/build-gaps-proposed.js rewrite it after every live or offline build, and their --check fails when it differs from what those files build.',
  'Until Jason decides on automation, run node scripts/build-gaps.js --offline and node scripts/build-gaps-proposed.js --offline by hand after the agenda index or a case file changes, and a live build after a catalog or proposal change.',
  'Proposed automation, not added: a step after the weekly legislation refresh and the monthly case-file archive job that runs both --offline builds and opens a pull request when a state changes.',
].join(' ');

const CANDIDATES = Object.freeze({
  recorded: false,
  note: 'scripts/find-gaps.js writes its candidates to a gitignored file and records no count in a committed file, so the inventory carries no candidate count.',
});

/** GitHub's heading anchors for a Markdown page, in order (duplicates get -1, -2 ...). */
export function anchors(md) {
  const seen = new Map();
  const out = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[2]
      .toLowerCase()
      .replace(/`/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.push({ text: m[2], anchor: n ? `${base}-${n}` : base });
  }
  return out;
}
function section(doc, md, heading) {
  const a = anchors(md).find((x) => x.text === heading);
  if (!a) throw new Error(`${doc} has no section “${heading}”; rebuild it before the inventory.`);
  return `${doc}#${a.anchor}`;
}

function shapeOf(g) {
  const h = g.how_much || {};
  const s = {};
  if (Number.isInteger(h.part) && Number.isInteger(h.whole)) Object.assign(s, { part: h.part, whole: h.whole, share_pct: pct(h.part, h.whole) });
  if (h.read) s.read = String(h.read);
  if (h.columns_absent) s.columns_absent = { pattern: h.columns_absent.pattern, datasets: { ...h.columns_absent.datasets }, cleared: (h.columns_absent.siblings_cleared || []).length };
  if (h.values) s.values = { dataset: h.values.dataset, field: h.values.field, count: h.values.count, matched: h.values.matched.length };
  if (h.catalog) s.catalog = h.catalog.map((c) => ({ q: c.q, result_set_size: c.result_set_size }));
  if (h.policy) s.policy = { ...h.policy };
  if (h.series?.length) s.series = { from: h.series[0].k, through: h.series.at(-1).k, points: h.series.length };
  return s;
}

function evidenceOf(g) {
  const seen = new Set();
  const out = [];
  for (const e of g.evidence || []) {
    const x = { type: e.type };
    if (e.url) x.url = e.url;
    if (e.file) x.file = e.file;
    if (Number.isInteger(e.line)) x.line = e.line;
    if (e.read) x.read = String(e.read);
    else if (e.checked) x.read = e.checked;
    else if (e.built) x.read = String(e.built);
    const key = JSON.stringify([x.type, x.url, x.file, x.line]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

function actionsOf(ids, actions) {
  return ids.map((id) => {
    const a = actions.find((x) => x.id === id);
    if (!a) return { id, kind: 'watch', needs: 'an action the built file doesn’t hold' };
    return { id, kind: a.kind, ...(a.text ? { text: a.text } : {}), ...(a.needs ? { needs: a.needs } : {}), ...(a.available === false ? { available: false } : {}) };
  });
}

const measuredFields = (g) => ({
  measured: g.measured,
  shape: shapeOf(g),
  short: g.short,
  evidence: evidenceOf(g),
});

/** The inputs, read from committed files. `catalogs` is build-gaps.js's CATALOGS. */
export function readInputs({ root, catalogs }) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const approved = Object.entries(catalogs)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([city]) => existsSync(join(root, `data/gaps/${city}.json`)))
    .map(([city, c]) => ({
      city,
      catalog: c.catalog,
      file: `data/gaps/${city}.json`,
      trace: `data/gaps/${city}.trace.json`,
      doc: `docs/gaps-${city}.md`,
      built: JSON.parse(read(`data/gaps/${city}.json`)),
      docText: read(`docs/gaps-${city}.md`),
    }));
  const proposed = readdirSync(join(root, 'data/gaps'))
    .filter((f) => SET_FILE.test(f))
    .sort()
    .map((f) => {
      const trace = JSON.parse(read(`data/gaps/${f}`));
      return { file: `data/gaps/${f}`, trace, docText: read(trace.doc) };
    });
  const streets = existsSync(join(root, 'data/gaps/norfolk-streets.json')) ? JSON.parse(read('data/gaps/norfolk-streets.json')).streets : [];
  return { approved, proposed, streets };
}

/** Every id's state, as one label: what "what changed" compares. */
export function statesOf(inv) {
  const out = {};
  for (const c of inv.approved) for (const e of c.entries) out[e.id] = e.state;
  for (const p of inv.proposed) for (const e of p.entries) out[e.id] = 'proposed';
  for (const r of inv.retired) out[r.id] = 'retired';
  for (const n of inv.not_a_gap) out[`not-a-gap:${n.city}:${n.id}`] = 'not_a_gap';
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function changesBetween(previous, states) {
  const before = previous?.states || null;
  const ch = { since: previous?.as_of || null, note: '', opened: [], closed: [], dropped_off: [], newly_proposed: [], left_proposals: [], retired: [], other: [] };
  if (!before) {
    ch.note = 'The first inventory: no earlier build to compare.';
    return ch;
  }
  const ids = [...new Set([...Object.keys(before), ...Object.keys(states)])].sort();
  for (const id of ids) {
    const a = before[id];
    const b = states[id];
    if (a === b) continue;
    const gap = !id.startsWith('not-a-gap:');
    if (gap && ON_BOARD.has(b) && !ON_BOARD.has(a)) ch.opened.push(id);
    else if (gap && b === 'closed') ch.closed.push(id);
    else if (gap && b === 'off_board' && ON_BOARD.has(a)) ch.dropped_off.push(id);
    else if (gap && b === 'proposed') ch.newly_proposed.push(id);
    else if (gap && b === 'retired') ch.retired.push(id);
    else ch.other.push({ id, from: a || 'not listed', to: b || 'not listed' });
    // A proposal that left the list (approved into a catalog, or withdrawn) is named too.
    if (gap && a === 'proposed' && b !== 'proposed') ch.left_proposals.push(id);
  }
  const n = ch.opened.length + ch.closed.length + ch.dropped_off.length + ch.newly_proposed.length + ch.retired.length + ch.other.length;
  ch.note = n ? `Against the inventory as of ${previous.as_of}.` : `No state changed since the inventory as of ${previous.as_of}.`;
  return ch;
}

const sameStates = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The inventory from its inputs. `prior` is the committed inventory (or
 * null): its states become `previous` when this build changes any state,
 * and its own `previous` is kept when none changed.
 */
export function buildInventory({ approved, proposed, streets }, prior = null) {
  const streetPatterns = compileStreets(streets);
  const problems = [];
  const typed = (where, s, type) => {
    for (const v of [...gapCheck(s, type), ...publicTextViolations(s, { streets: streetPatterns })]) problems.push(`${where}: ${v}`);
  };
  // Reasons the build wrote (an off-board measure's error, a note): they hold
  // no number a reader is asked to trust, so only the public-text checks
  // apply, and a reason that fails them is withheld, never shown.
  const plain = (s) => (publicTextViolations(s, { streets: streetPatterns }).length ? 'Withheld from the inventory: the text failed the public-text checks. The build output names it.' : s);

  const approvedOut = approved.map((c) => {
    const f = c.built;
    const entries = c.catalog.GAPS.map((entry) => {
      const g = f.gaps.find((x) => x.id === entry.id);
      const off = f.off_board.find((x) => x.id === entry.id);
      const base = {
        id: entry.id,
        public_id: gapPublicId(entry.id),
        title: entry.title,
        kind: entry.kind,
        label: KINDS[entry.kind],
        topic: entry.topic || null,
      };
      if (g) {
        return {
          ...base,
          state: g.state,
          ...(g.last_good ? { last_good: g.last_good } : {}),
          ...(g.notice ? { notice: g.notice } : {}),
          ...measuredFields(g),
          questions: g.questions.map((q) => ({ qid: q.qid, text: q.text, blocks: q.blocks, consequence: q.consequence })),
          actions: actionsOf(entry.actions, f.actions),
          doc: section(c.doc, c.docText, g.title),
          trace: c.trace,
        };
      }
      return {
        ...base,
        state: 'off_board',
        off_board: off ? { state: off.state, reason: plain(off.reason) } : { state: 'unmeasured_today', reason: 'Not in the built gap file: rebuild it.' },
        questions: entry.questions.map((q) => ({ qid: q.qid, text: q.text, blocks: q.blocks })),
        actions: actionsOf(entry.actions, f.actions),
        doc: section(c.doc, c.docText, 'Off the board today'),
        trace: c.trace,
      };
    });
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return { city: c.city, file: c.file, doc: c.doc, built: f.built, ...(f.rebuilt ? { rebuilt: f.rebuilt } : {}), entries };
  });

  const proposedOut = proposed.map((p) => {
    const t = p.trace;
    const entries = t.entries.map((entry) => {
      const g = t.file.gaps.find((x) => x.id === entry.id);
      const off = t.file.off_board.find((x) => x.id === entry.id);
      const base = {
        id: entry.id,
        public_id: gapPublicId(entry.id),
        title: entry.title,
        kind: entry.kind,
        label: KINDS[entry.kind],
        topic: entry.topic || null,
        state: 'proposed',
        awaiting: 'Jason’s approval of the entry',
      };
      if (g) {
        return {
          ...base,
          if_approved: g.state,
          ...measuredFields(g),
          questions: g.questions.map((q) => ({ qid: q.qid, text: q.text, blocks: q.blocks, consequence: q.consequence })),
          actions: actionsOf(entry.actions, t.file.actions),
          doc: section(t.doc, p.docText, entry.title),
          trace: p.file,
        };
      }
      return {
        ...base,
        if_approved: off?.state || 'unmeasured_today',
        not_measured: plain(off?.reason || 'Not in the built records: rebuild the proposal.'),
        questions: entry.questions.map((q) => ({ ...q })),
        actions: actionsOf(entry.actions, t.file.actions),
        doc: section(t.doc, p.docText, entry.title),
        trace: p.file,
      };
    });
    entries.sort((a, b) => a.id.localeCompare(b.id));
    return { set: t.set, city: t.city, file: p.file, module: t.module, doc: t.doc, built: t.built, ...(t.rebuilt ? { rebuilt: t.rebuilt } : {}), entries };
  });

  // Text: what the board would show passes the board's checks.
  for (const e of [...approvedOut, ...proposedOut].flatMap((c) => c.entries)) {
    typed(`${e.id} title`, e.title, 'title');
    if (e.short) typed(`${e.id} short`, e.short, 'short');
    if (e.notice) typed(`${e.id} notice`, e.notice, 'statement');
    for (const q of e.questions) {
      for (const v of publicTextViolations(q.text, { streets: streetPatterns })) problems.push(`${e.id} ${q.qid}: ${v}`);
      if (q.consequence) typed(`${e.id} ${q.qid} consequence`, q.consequence, 'consequence');
    }
    for (const a of e.actions) for (const s of [a.text, a.needs].filter(Boolean)) typed(`${e.id} ${a.id}`, s, 'action');
  }

  const retired = approved.flatMap((c) => c.built.retired.map((id) => ({ id, city: c.city }))).sort((a, b) => a.id.localeCompare(b.id));
  const notAGap = approved.flatMap((c) => c.built.not_a_gap.map((n) => ({ id: n.id, city: c.city, note: plain(n.note) })));

  // Topics: every topic a catalog defines, with the placements as the last
  // build that checked it rendered them (a topic no measured entry names is
  // listed from its definition, unmeasured).
  const records = [...approved.flatMap((c) => c.built.gaps.map((g) => [c.file, g])), ...proposed.flatMap((p) => p.trace.file.gaps.map((g) => [p.file, g]))];
  const allEntries = [...approvedOut.flatMap((c) => c.entries.map((e) => ['approved', e])), ...proposedOut.flatMap((p) => p.entries.map((e) => ['proposed', e]))];
  const topicDefs = new Map();
  for (const c of approved) for (const [name, t] of Object.entries(c.catalog.TOPICS || {})) if (!topicDefs.has(name)) topicDefs.set(name, t);
  const topics = [...topicDefs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) => {
      const hit = records.find(([, g]) => g.topic?.name === name);
      const rendered = hit?.[1].topic;
      const placements = rendered
        ? rendered.not_in_topic.map((x) => ({ id: x.id, name: x.name, by: x.policy ? 'rule' : 'description', reason: x.reason, placed: x.placed }))
        : def.not_in_topic.map((x) => ({ id: x.id, name: x.id, by: x.policy ? 'rule' : 'description', reason: x.reason, placed: x.placed }));
      for (const x of placements) {
        typed(`topic ${name} placement ${x.id}`, x.reason, 'statement');
        x.placed = plain(x.placed);
      }
      const cleared = (def.cleared || []).map((c) => ({ ...c }));
      for (const c of cleared) typed(`topic ${name} clearance ${c.dataset}.${c.column}`, c.reason, 'statement');
      const count = (side) => allEntries.filter(([s, e]) => s === side && e.topic === name).length;
      return {
        name,
        datasets: [...def.datasets],
        search: def.search,
        checked_live: def.checked_live,
        measured_in: hit ? hit[0] : null,
        placements,
        cleared,
        entries: { approved: count('approved'), proposed: count('proposed') },
      };
    });

  if (problems.length) throw new Error(`The inventory's text fails a check:\n${problems.join('\n')}`);

  const tally = (entries, key) => {
    const out = {};
    for (const e of entries) {
      const k = key(e);
      out[k] = (out[k] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const appr = approvedOut.flatMap((c) => c.entries);
  const prop = proposedOut.flatMap((p) => p.entries);
  const inputs = [
    ...approvedOut.map((c) => ({ file: c.file, built: c.built, ...(c.rebuilt ? { rebuilt: c.rebuilt } : {}) })),
    ...proposedOut.map((p) => ({ file: p.file, built: p.built, ...(p.rebuilt ? { rebuilt: p.rebuilt } : {}) })),
  ];
  const asOf = inputs.map((i) => i.rebuilt || i.built).sort().at(-1);

  const inv = {
    note: 'The running inventory of gaps: every gap Siren knows of and its state, built by scripts/gaps-inventory.js from the committed gap files. Generated: edit a catalog or proposal and rebuild, never this file. Approved entries are in the catalog; proposed entries are drafts awaiting Jason’s approval, never on the board.',
    as_of: asOf,
    inputs,
    stays_current: STAYS_CURRENT,
    counts: {
      approved: { total: appr.length, by_state: tally(appr, (e) => e.state), by_topic: tally(appr, (e) => e.topic || 'none') },
      proposed: { total: prop.length, by_state: tally(prop, (e) => `proposed (if approved: ${e.if_approved})`), by_topic: tally(prop, (e) => e.topic || 'none') },
      retired: retired.length,
      not_a_gap: notAGap.length,
      all: {},
    },
    changes: null,
    previous: null,
    topics,
    approved: approvedOut,
    proposed: proposedOut,
    retired,
    not_a_gap: notAGap,
    candidates: { ...CANDIDATES },
  };
  const states = statesOf(inv);
  inv.counts.all = tally(Object.values(states).map((s) => ({ s })), (x) => x.s);
  const priorStates = prior ? statesOf(prior) : null;
  inv.previous = !prior ? null : sameStates(priorStates, states) ? prior.previous : { as_of: prior.as_of, states: priorStates };
  inv.changes = changesBetween(inv.previous, states);
  const errs = validateInventory(inv);
  if (errs.length) throw new Error(`Schema errors in the inventory:\n${errs.join('\n')}`);
  return { inventory: inv, doc: renderInventoryDoc(inv) };
}

// --- The page ----------------------------------------------------------------------------

const STATE_WORDS = {
  open: 'open',
  closing: 'closing (a re-measure met its closing test; a steward confirms)',
  closed: 'closed',
  unmeasured_today: 'on the board with its last measurement (not measured today)',
  off_board: 'off the board',
};

function entryLines(e) {
  const L = [`### ${e.title}`, ''];
  const state = e.state === 'proposed' ? `proposed, awaiting ${e.awaiting} (if approved: ${e.if_approved})` : STATE_WORDS[e.state] || e.state;
  L.push(`\`${e.id}\` · ${e.label} · topic: ${e.topic || 'none'} · state: ${state}${e.measured ? ` · measured ${e.measured}` : ''}`, '');
  if (e.notice) L.push(`> ${e.notice}`, '');
  if (e.off_board) L.push(`Off the board (${e.off_board.state}): ${e.off_board.reason}`, '');
  if (e.not_measured) L.push(`Not measured (${e.if_approved}): ${e.not_measured}`, '');
  if (e.short) L.push(e.short, '');
  if (e.shape) {
    const s = e.shape;
    const bits = [];
    if (s.part !== undefined) bits.push(`${fmt(s.part)} of ${fmt(s.whole)} (${s.share_pct}%)`);
    if (s.columns_absent) bits.push(`no column matching \`${s.columns_absent.pattern}\` in ${Object.keys(s.columns_absent.datasets).length} dataset${Object.keys(s.columns_absent.datasets).length === 1 ? '' : 's'}${s.columns_absent.cleared ? `, ${s.columns_absent.cleared} cleared` : ''}`);
    if (s.values) bits.push(`${fmt(s.values.count)} values of ${s.values.dataset}.${s.values.field}, ${fmt(s.values.matched)} matched`);
    if (s.catalog) bits.push(`catalog searches: ${s.catalog.map((c) => `“${c.q}” ${fmt(c.result_set_size)}`).join(', ')}`);
    if (s.policy) bits.push(`rule at ${s.policy.file}:${s.policy.line}`);
    if (s.series) bits.push(`series ${s.series.from} to ${s.series.through}`);
    if (bits.length) L.push(`Shape: ${bits.join('; ')}.`, '');
  }
  L.push('Questions it leaves unanswered:', '');
  for (const q of e.questions) L.push(`- ${q.text} (${q.blocks === 'all' ? 'can’t answer' : 'only in part'})`);
  L.push('', 'Actions:', '');
  for (const a of e.actions) L.push(`- ${a.kind.replace(/_/g, ' ')}: ${a.text || (a.needs ? `waits for ${a.needs}` : a.id)}${a.available === false ? ' (not offered yet)' : ''}`);
  L.push('', `Section: [${e.doc}](${e.doc.replace(/^docs\//, '')}) · trace: \`${e.trace}\`${e.evidence ? ` · evidence: ${e.evidence.map((x, i) => (x.url ? `[${x.type} ${i + 1}](${x.url})` : `${x.type} ${i + 1} (\`${x.file}${x.line ? `:${x.line}` : ''}\`)`)).join(', ')}` : ''}`, '');
  return L;
}

export function renderInventoryDoc(inv) {
  const c = inv.counts;
  const L = [
    '# Gap inventory',
    '',
    `As of ${inv.as_of}. Generated by \`scripts/gaps-inventory.js\` from ${inv.inputs.map((i) => `\`${i.file}\``).join(', ')}: edit a catalog or proposal and rebuild, never this page. The same data, schema-checked, is in \`data/gaps/inventory.json\`.`,
    '',
    'Every gap Siren knows of and its state. A gap has a shape and consequences: what the records Siren reads hold or leave out, and the questions that leaves unanswered. Approved entries are in the catalog and on the board; proposed entries are drafts awaiting Jason’s approval and are never on the board.',
    '',
    '## How it stays current',
    '',
    inv.stays_current,
    '',
    '## Counts',
    '',
    '| | Total | By state | By topic |',
    '|---|---|---|---|',
    `| Approved catalog | ${c.approved.total} | ${Object.entries(c.approved.by_state).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} | ${Object.entries(c.approved.by_topic).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |`,
    `| Proposed | ${c.proposed.total} | ${Object.entries(c.proposed.by_state).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} | ${Object.entries(c.proposed.by_topic).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} |`,
    `| Retired ids | ${c.retired} | | |`,
    `| Not a gap | ${c.not_a_gap} | | |`,
    '',
    `Candidates: ${inv.candidates.note}`,
    '',
    '## What changed',
    '',
    inv.changes.note,
    '',
  ];
  const ch = inv.changes;
  const list = (label, ids) => ids.length && L.push(`- ${label}: ${ids.map((x) => `\`${x}\``).join(', ')}`);
  list('Opened (came onto the board)', ch.opened);
  list('Closed', ch.closed);
  list('Dropped off the board', ch.dropped_off);
  list('Newly proposed', ch.newly_proposed);
  list('Left the proposals (approved or withdrawn)', ch.left_proposals);
  list('Retired', ch.retired);
  for (const o of ch.other) L.push(`- \`${o.id}\`: ${o.from} to ${o.to}`);
  if (L.at(-1) !== '') L.push('');
  L.push('## Topics', '');
  for (const t of inv.topics) {
    L.push(`### The ${t.name} topic`, '');
    L.push(`Topic-wide checks read ${t.datasets.join(', ')}. The catalog search “${t.search}” is checked for datasets placed neither in nor out; checked live ${t.checked_live}. ${t.measured_in ? `Last checked in the build of \`${t.measured_in}\`.` : 'No measured entry names it yet, so no build has checked it.'} Entries: ${t.entries.approved} approved, ${t.entries.proposed} proposed.`, '');
    for (const x of t.placements) L.push(`- Outside the topic: ${x.name} (${x.id}), by ${x.by === 'rule' ? "Siren's rule" : 'its description'}. ${x.reason} ${x.placed}`);
    for (const x of t.cleared) L.push(`- Cleared for topic-wide checks: ${x.dataset}.${x.column}. ${x.reason} (${x.by}, ${x.date})`);
    L.push('');
  }
  for (const a of inv.approved) {
    L.push(`## Approved catalog: ${a.city}`, '', `From \`${a.file}\`, built ${a.built}${a.rebuilt ? `, rebuilt ${a.rebuilt}` : ''}; the board's page is \`${a.doc}\`.`, '');
    for (const e of a.entries) L.push(...entryLines(e));
  }
  for (const p of inv.proposed) {
    L.push(`## Proposed: ${p.set}`, '', `**Proposals, not in the catalog.** From \`${p.file}\` (module \`${p.module}\`), built ${p.built}${p.rebuilt ? `, rebuilt ${p.rebuilt}` : ''}; the review page is \`${p.doc}\`. Nothing here is on the board until Jason approves an entry and it moves into the catalog.`, '');
    for (const e of p.entries) L.push(...entryLines(e));
  }
  L.push('## Retired ids', '', 'Never reused: ' + (inv.retired.map((r) => `\`${r.id}\``).join(', ') || 'none') + '.', '');
  L.push('## Not a gap', '', "Siren's own bugs, not gaps in the records:", '');
  for (const n of inv.not_a_gap) L.push(`- \`${n.id}\` (${n.city}): ${n.note}`);
  L.push('');
  return L.join('\n');
}

// --- Files ---------------------------------------------------------------------------------

const readPrior = (root) => (existsSync(join(root, INVENTORY_PATHS.file)) ? JSON.parse(readFileSync(join(root, INVENTORY_PATHS.file), 'utf8')) : null);

/** Rebuild the inventory from the committed files and write it. Returns it. */
export function writeInventory({ root, catalogs }) {
  const out = buildInventory(readInputs({ root, catalogs }), readPrior(root));
  writeFileSync(join(root, INVENTORY_PATHS.file), stringify(out.inventory));
  writeFileSync(join(root, INVENTORY_PATHS.doc), out.doc);
  return out.inventory;
}

/** Differences between the committed inventory and what the committed files build ([] if none). */
export function checkInventory({ root, catalogs }) {
  const prior = readPrior(root);
  if (!prior) return [`${INVENTORY_PATHS.file} is missing. Run node scripts/build-gaps.js --offline.`];
  let out;
  try {
    out = buildInventory(readInputs({ root, catalogs }), prior);
  } catch (err) {
    return [`The inventory doesn't build: ${err.message}`];
  }
  const diffs = [];
  if (stringify(prior) !== stringify(out.inventory)) diffs.push(`${INVENTORY_PATHS.file} differs from what the committed gap files build. Run node scripts/build-gaps.js --offline (or node scripts/build-gaps-proposed.js --offline) and review the change.`);
  const doc = join(root, INVENTORY_PATHS.doc);
  if (!existsSync(doc) || readFileSync(doc, 'utf8') !== out.doc) diffs.push(`${INVENTORY_PATHS.doc} differs from what the committed gap files build. Run node scripts/build-gaps.js --offline and review the change.`);
  return diffs;
}

/** One line for the build scripts' output. */
export function inventorySummary(inv) {
  return `Inventory as of ${inv.as_of}: ${inv.counts.approved.total} approved (${Object.entries(inv.counts.approved.by_state).map(([k, v]) => `${k} ${v}`).join(', ')}), ${inv.counts.proposed.total} proposed, ${inv.counts.retired} retired, ${inv.counts.not_a_gap} not a gap. Wrote ${INVENTORY_PATHS.file}, ${INVENTORY_PATHS.doc}.`;
}
