#!/usr/bin/env node
// Builds data/documents/norfolk-zoning-use-tables.json: the Zoning
// Ordinance's use tables (which uses are allowed in which district, and how),
// read from the City's PDF by word position. Jason, 2026-11-20: "Can we make
// that into a tool since it's such a weird custom way to do zoning?" The
// ordinance's text extraction (data/documents/norfolk-zoning-ordinance.json)
// keeps each row's P and C marks but drops the blank cells, so it can't say
// which district a mark belongs to. Here each mark is placed under its
// district's column header by x position.
//
//   node scripts/build-use-tables.js <path to the Zoning Ordinance PDF> [--write]
//
// The PDF must be the edition the ordinance text was built from (the same
// DASL CID as norfolk-zoning-ordinance.json), so the tables and the text never
// disagree. Needs poppler's pdftotext (as scripts/verify-cases.js does). Every
// column header must be a district in the ordinance's own Table 3.1.2, every
// mark must sit under a column, every row must carry its performance-standards
// reference, and each category-level reference (printed sideways in the
// standards column) must match its rows; otherwise the build fails.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { rawCid } from './verify-cases.js';

const ROOT = new URL('../', import.meta.url);
const ORDINANCE = JSON.parse(readFileSync(new URL('data/documents/norfolk-zoning-ordinance.json', ROOT), 'utf8'));
export const OUT = new URL('data/documents/norfolk-zoning-use-tables.json', ROOT);

const CELL = /^(?:P|C|P\/C)$/;
const REF = /^\d+\.\d+\.\d+(?:\.[A-Z](?:\(\w+\))*)?$/;
const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const mid = (w) => (w.x0 + w.x1) / 2;
const midY = (w) => (w.y0 + w.y1) / 2;

/** The districts Table 3.1.2 establishes: [{ code, name }]. */
export function districtsOf(ordinance = ORDINANCE) {
  const s = ordinance.sections.find((x) => x.number === '3.1.2');
  const out = [];
  for (const line of s.text.split('\n')) {
    const m = /^([A-Z][A-Za-z0-9&/ -]*?):\s+(\S.*)$/.exec(line.trim());
    if (m && !/^TABLE/.test(m[1])) out.push({ code: m[1].trim(), name: m[2].trim() });
  }
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const isSubsequence = (a, b) => {
  let i = 0;
  for (const c of b) if (c === a[i]) i++;
  return i === a.length;
};
/** A header's label, matched to a district code: exactly, or (4+ characters) as the only code it's a subsequence of ("PCO-21 Street" is "PCO-21st Street"; a superscript "st" read as its own word is dropped). */
export function districtFor(label, districts) {
  const plain = label.replace(/(^|\s)[a-z]{1,2}(?=\s|$)/g, ' ').trim();
  if (plain !== label) return districtFor(plain, districts);
  const n = norm(label);
  const exact = districts.find((d) => norm(d.code) === n);
  if (exact) return exact.code;
  if (n.length < 4) return null;
  const loose = districts.filter((d) => isSubsequence(n, norm(d.code)));
  return loose.length === 1 ? loose[0].code : null;
}

/** pdftotext -bbox words of one page. */
export function wordsOf(pdf, page) {
  const html = execFileSync('pdftotext', ['-bbox', '-f', String(page), '-l', String(page), pdf, '-'], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], t: dec(m[5]) }));
}

const isClassification = (line) => line.cells.length === 0 && line.refs.length === 0 && line.words.length >= 2 && line.words.every((w) => /^[A-Z,&/-]+$/.test(w.t)) && /\b(?:USES|STRUCTURES)$/.test(line.words.map((w) => w.t).join(' '));

/**
 * One page of a use table: { columns: [{ code, x }], rows: [{ classification,
 * use, cells, standards, page }], categoryRefs, classification } or null when
 * the page holds no table. Throws when a header or mark can't be placed.
 */
export function parsePage(words, { page, districts, classification = null }) {
  const type = words.find((w) => w.t === 'TYPE' && words.some((v) => v.t === 'USE' && Math.abs(v.y0 - w.y0) < 2 && v.x1 < w.x0));
  if (!type) return null;
  const perf = words.find((w) => w.t === 'PERFORMANCE');
  const category = words.find((w) => w.t === 'CATEGORY' && Math.abs(w.y0 - type.y0) < 2);
  const legend = words.find((w) => w.t === 'PROHIBITED');
  const footer = words.find((w) => w.t === 'Adopted' && words.some((v) => v.t === 'January' && Math.abs(v.y0 - w.y0) < 2));
  const bottom = footer ? Math.min(footer.y0, ...words.filter((w) => /^(?:Norfolk,|October|November|December|September)$/.test(w.t) && w.y0 > footer.y0 - 20).map((w) => w.y0)) - 1 : Infinity;
  if (!perf || !category || !legend) throw new Error(`p${page}: the table header is incomplete (PERFORMANCE ${!!perf}, CATEGORY ${!!category}, legend ${!!legend})`);
  const colLeft = Math.max(type.x1, category.x1) + 10;
  const colRight = perf.x0 - 3;
  // Data starts at the first mark, standards reference or classification line below the header.
  const below = words.filter((w) => w.y0 > type.y1 && w.y1 < bottom);
  const firstData = Math.min(
    ...below.filter((w) => (CELL.test(w.t) && mid(w) > colLeft && mid(w) < colRight) || (REF.test(w.t) && w.x0 >= perf.x0 - 12 && w.x1 - w.x0 > 12)).map((w) => w.y0),
    ...below.filter((w) => w.t === 'USES' || w.t === 'STRUCTURES').map((w) => w.y0)
  );
  // Column headers: the words between the legend and the data, over the columns (printed sideways, one or two lines each).
  const onLegendLine = (w) => Math.abs(w.y0 - legend.y0) < 1.5;
  const heads = words
    .filter((w) => w.y1 > legend.y1 + 2 && w.y0 < Math.min(firstData - 1, type.y1 + 8) && mid(w) > colLeft && mid(w) < colRight && !onLegendLine(w))
    .sort((a, b) => mid(a) - mid(b));
  const groups = [];
  for (const w of heads) {
    const g = groups.at(-1);
    if (g && mid(w) - mid(g.at(-1)) < 16) g.push(w);
    else groups.push([w]);
  }
  const columns = groups.map((g) => {
    const label = g.reduce((s, w) => (s && !s.endsWith('-') ? `${s} ${w.t}` : `${s}${w.t}`), '');
    const code = districtFor(label, districts);
    if (!code) throw new Error(`p${page}: the column header "${label}" is not a district in Table 3.1.2`);
    return { code, x: g.reduce((n, w) => n + mid(w), 0) / g.length };
  });
  if (!columns.length) throw new Error(`p${page}: no column headers`);
  const spacing = Math.min(...columns.slice(1).map((c, i) => c.x - columns[i].x));
  const tolerance = Math.min(12, spacing / 2);
  // Lines of the data area, by height.
  // The data area starts below the header row (a wrapped name can begin above the first mark).
  const standards = words.find((w) => w.t === 'STANDARDS' && Math.abs(mid(w) - mid(perf)) < 30 && w.y0 > perf.y0);
  const top = Math.max(type.y1, perf.y1, standards?.y1 ?? 0, ...heads.map((w) => w.y1)) + 0.5;
  const data = below.filter((w) => w.y0 >= Math.min(top, firstData - 1)).sort((a, b) => midY(a) - midY(b) || a.x0 - b.x0);
  const lines = [];
  for (const w of data) {
    const l = lines.at(-1);
    if (l && Math.abs(midY(w) - l.y) < 3) l.all.push(w);
    else lines.push({ y: midY(w), all: [w] });
  }
  const categoryRefs = [];
  for (const l of lines) {
    l.words = l.all.filter((w) => w.x0 >= colLeft - 2 && mid(w) < colLeft + 4 * spacing && !CELL.test(w.t) && !REF.test(w.t));
    l.name = l.all.filter((w) => w.x0 > category.x1 + 5 && w.x1 < columns[0].x - tolerance && !(CELL.test(w.t) && mid(w) > colLeft));
    l.cells = l.all.filter((w) => CELL.test(w.t) && mid(w) > colLeft && mid(w) < colRight);
    const sideways = l.all.filter((w) => REF.test(w.t) && w.y1 - w.y0 > 1.5 * (w.x1 - w.x0));
    categoryRefs.push(...sideways.map((w) => ({ ref: w.t, y0: w.y0, y1: w.y1 })));
    l.refs = l.all.filter((w) => REF.test(w.t) && w.x0 >= perf.x0 - 12 && !sideways.includes(w));
    l.words = l.all.filter((w) => !sideways.includes(w));
  }
  const rows = [];
  const anchors = [];
  let current = classification;
  for (const l of lines) {
    // Notes spanning the row ("All other uses, not permitted", "Not permitted") are not uses.
    if (!l.cells.length && !l.refs.length && /^(?:All other uses, not permitted|Not permitted)$/.test(l.all.filter((w) => w.x0 > category.x1 + 5).map((w) => w.t).join(' '))) {
      l.note = true;
      continue;
    }
    if (isClassification(l)) {
      current = l.words.map((w) => w.t).join(' ');
      continue;
    }
    if (l.cells.length || l.refs.length) {
      const cells = {};
      for (const c of l.cells) {
        const col = columns.reduce((best, k) => (Math.abs(k.x - mid(c)) < Math.abs(best.x - mid(c)) ? k : best));
        if (Math.abs(col.x - mid(c)) > tolerance) throw new Error(`p${page}: a "${c.t}" at x ${mid(c).toFixed(1)} sits under no column`);
        if (cells[col.code]) throw new Error(`p${page}: two marks under ${col.code} on one line`);
        cells[col.code] = c.t;
      }
      const row = { classification: current, name: [...l.name], cells, standards: l.refs.map((w) => w.t), page, y: l.y };
      rows.push(row);
      anchors.push(row);
    }
  }
  // Name-only lines: a use type's name wrapped onto two lines, its marks on one
  // of them or between. A line starting in lower case (or "(") continues the
  // row above; one starting in upper case begins the row below, unless that row
  // already has a name of its own that starts a name.
  const startsName = (words) => /^[A-Z0-9]/.test(words[0]?.t || '');
  for (const l of lines) {
    if (l.note || l.cells.length || l.refs.length || isClassification(l) || !l.name.length) continue;
    const near = anchors.filter((r) => Math.abs(r.y - l.y) <= 16);
    const above = near.filter((r) => r.y <= l.y + 0.5).sort((a, b) => b.y - a.y)[0];
    const below = near.filter((r) => r.y >= l.y - 0.5).sort((a, b) => a.y - b.y)[0];
    let best;
    if (!startsName(l.name)) best = above ?? below;
    else best = below && !(below.name.length && startsName(below.name)) ? below : above ?? below;
    if (!best) continue;
    best.name.push(...l.name.map((w) => ({ ...w, line: l.y })));
  }
  for (const r of rows) {
    r.use = r.name.sort((a, b) => (a.line ?? r.y) - (b.line ?? r.y) || a.x0 - b.x0).map((w) => w.t).join(' ').replace(/\s+/g, ' ').replace(/- (?=[a-z])/g, '-').trim();
    delete r.name;
    delete r.y;
  }
  return { columns: columns.map((c) => c.code), rows, categoryRefs, classification: current };
}

/**
 * The category-level standards reference a use type's row belongs to, from the
 * ones the table prints sideways: a use at X(2k)(...) belongs to X(2k-1)
 * (4.2.3.D(4)(b) to 4.2.3.D(3)); otherwise the longest printed reference its
 * own begins with (4.3.3.E(1)(a) to 4.3.3; 4.4.3.B(2)(c) to 4.4.3.B(2)).
 */
export function categoryRefOf(ref, printed) {
  if (!ref) return null;
  const m = /^(\d+\.\d+\.\d+\.[A-Z])\((\d+)\)/.exec(ref);
  if (m && Number(m[2]) % 2 === 0) {
    const odd = `${m[1]}(${Number(m[2]) - 1})`;
    if (printed.has(odd)) return odd;
  }
  let best = null;
  for (const p of printed) if (ref.startsWith(p) && /^[.(]?/.test(ref.slice(p.length)) && (!best || p.length > best.length)) best = p;
  return best;
}

// Rows the City's tables print inconsistently with the other tables, kept as
// printed with a note (checked against the page images, 2026-11-20). Any other
// disagreement between tables fails the build.
export const AS_PRINTED = [
  { section: '3.2.12', use: 'All other uses, not permitted', standards: '4.2.3.E(4)(i)', also: 'Utility facility, minor', note: 'The table prints this row\'s use type as "All other uses, not permitted", with P in every district; its reference, 4.2.3.E(4)(i), is "Utility facility, minor" in every other use table.' },
  { section: '3.6.11', use: 'Utility facility, minor', standards: '4.2.3.E(4)(a)', note: 'The table cites 4.2.3.E(4)(a) for this use; every other use table cites 4.2.3.E(4)(i), and 4.2.3.E(4)(a) is Airport.' },
  { section: '3.4.11', use: 'Automobile repair and maintenance, minor', standards: '4.2.3.F(8)(b)', note: 'The table cites 4.2.3.F(8)(b) for this use; every other use table cites 4.2.3.F(8)(c), and 4.2.3.F(8)(b) is "Automobile repair and maintenance, major".' },
  { section: '3.9.23', use: 'Automobile repair and maintenance, minor', standards: '4.2.3.F(8)(b)', note: 'The table cites 4.2.3.F(8)(b) for this use; every other use table cites 4.2.3.F(8)(c), and 4.2.3.F(8)(b) is "Automobile repair and maintenance, major".' },
];
const asPrinted = (section, r) => AS_PRINTED.find((k) => k.section === section && k.use === r.use && k.standards === r.standards);

// The use-table sections of the ordinance, by title.
export const TABLE_SECTIONS = () => ORDINANCE.sections.filter((s) => /^Uses for the /.test(s.title));

export function build(pdf) {
  const bytes = readFileSync(pdf);
  const cid = rawCid(bytes);
  if (cid !== ORDINANCE.source.cid) throw new Error(`This PDF (${cid}) is not the edition the ordinance text was built from (${ORDINANCE.source.cid}). Rebuild both from the same PDF.`);
  const districts = districtsOf();
  const read = [];
  const problems = [];
  for (const s of TABLE_SECTIONS()) {
    let classification = null;
    let columns = null;
    const rows = [];
    const sideways = new Set();
    for (let p = s.pages[0]; p <= s.pages[1]; p++) {
      const got = parsePage(wordsOf(pdf, p), { page: p, districts, classification });
      if (!got) continue;
      if (columns && got.columns.join() !== columns.join()) throw new Error(`§${s.number} p${p}: the columns changed (${got.columns.join(' ')})`);
      columns = got.columns;
      classification = got.classification;
      rows.push(...got.rows);
      for (const c of got.categoryRefs) sideways.add(c.ref);
    }
    if (!rows.length) throw new Error(`§${s.number}: no rows`);
    read.push({ s, columns, rows, sideways });
  }
  // A category reference a table doesn't print on its own pages may be printed in another's.
  const printedAnywhere = new Set(read.flatMap((t) => [...t.sideways]));
  const tables = [];
  const unchecked = [];
  let checked = 0;
  for (const { s, columns, rows, sideways } of read) {
    for (const r of rows) {
      if (r.standards.length !== 1) problems.push(`§${s.number} p${r.page} "${r.use}": ${r.standards.length} standards references`);
      if (!r.use) problems.push(`§${s.number} p${r.page}: a row with no use name`);
      if (!r.classification) problems.push(`§${s.number} p${r.page} "${r.use}": no classification`);
    }
    // Every row belongs to a category reference the table prints, and every printed one has rows.
    for (const r of rows) {
      r.category = categoryRefOf(r.standards[0], sideways) ?? categoryRefOf(r.standards[0], printedAnywhere);
      if (r.standards[0] && !r.category) problems.push(`§${s.number} p${r.page} "${r.use}": no printed category reference for ${r.standards[0]}`);
    }
    for (const c of sideways) if (!rows.some((r) => r.category === c)) problems.push(`§${s.number}: category reference ${c} matches no row`);
    // Cross-check with the ordinance's text extraction, which keeps each row's marks in order without their districts.
    const text = ORDINANCE.sections.find((x) => x.number === s.number)?.text || '';
    for (const r of rows) {
      const ref = r.standards[0];
      if (!ref) continue;
      const line = text.split('\n').find((l) => l.trim().endsWith(ref) && l.trim().split(/\s+/).at(-1) === ref);
      if (!line) {
        unchecked.push(`§${s.number} "${r.use}"`);
        continue;
      }
      // The marks run back from the reference (narrow columns can leave one space between them).
      const tokens = line.trim().split(/\s+/).slice(0, -1);
      const inText = [];
      while (tokens.length && CELL.test(tokens.at(-1))) inText.unshift(tokens.pop());
      const parsed = columns.filter((c) => r.cells[c]).map((c) => r.cells[c]);
      if (inText.join(' ') !== parsed.join(' ')) problems.push(`§${s.number} p${r.page} "${r.use}": the text has ${inText.join(' ') || 'no marks'}, the parse ${parsed.join(' ') || 'no marks'}`);
      else checked++;
    }
    tables.push({
      section: s.number,
      title: s.title,
      pages: s.pages,
      districts: columns,
      rows: rows.map((r) => ({ classification: r.classification, use: r.use, cells: r.cells, standards: r.standards[0] ?? null, category_standards: r.category, page: r.page })),
    });
  }
  // The same use (by its standards reference) carries the same name in every table, and no name starts mid-sentence.
  const names = new Map();
  const used = new Set();
  for (const t of tables) for (const r of t.rows) {
    if (!/^[A-Z0-9]/.test(r.use)) problems.push(`§${t.section} p${r.page}: the use name "${r.use}" starts mid-name`);
    const known = asPrinted(t.section, r);
    if (known) {
      used.add(known);
      r.note = known.note;
      if (known.also) r.also = known.also;
      continue;
    }
    if (!names.has(r.standards)) names.set(r.standards, new Set());
    names.get(r.standards).add(r.use);
  }
  for (const k of AS_PRINTED) if (!used.has(k)) problems.push(`AS_PRINTED lists §${k.section} "${k.use}" (${k.standards}), which the tables no longer print`);
  for (const [ref, set] of names) if (set.size > 1) problems.push(`${ref} is named ${[...set].map((n) => `"${n}"`).join(' and ')}`);
  if (problems.length) throw new Error(`The use tables didn't read cleanly:\n- ${problems.join('\n- ')}`);
  // Rows the text check couldn't find stay few, or the check proves little.
  if (unchecked.length > 0.05 * (checked + unchecked.length)) throw new Error(`Only ${checked} rows matched the text extraction; unchecked: ${unchecked.join('; ')}`);
  const legend = ORDINANCE.sections.find((x) => x.number === '3.1.4');
  return {
    id: 'norfolk-zoning-use-tables',
    title: 'Norfolk Zoning Ordinance: use tables',
    from: ORDINANCE.id,
    current_through: ORDINANCE.current_through,
    source: { ...ORDINANCE.source, read_by: 'pdftotext -bbox (word positions), scripts/build-use-tables.js' },
    legend: {
      section: '3.1.4',
      pages: legend.pages,
      P: 'An allowable use in the district, subject to any referenced performance standards and all other applicable regulations of the Ordinance. Under an overlay column, the use is allowable as a permitted use in the overlay district whether or not the underlying base district prohibits it.',
      C: 'An allowable use in the district only on approval of a Conditional Use Permit (Section 2.4.8), subject to any referenced performance standards and all other applicable regulations.',
      'P/C': 'An allowable use in the district, but a Conditional Use Permit (Section 2.4.8) may be required, as determined by the applicable performance standards.',
      blank: 'Prohibited as a principal or conditional use in the district. Under an overlay column, prohibited whether or not the underlying base district allows it.',
      unlisted: 'Any use that is not listed in a use table is prohibited (Section 3.1.4).',
    },
    districts: districts.filter((d) => tables.some((t) => t.districts.includes(d.code))),
    // Every district Table 3.1.2 establishes, with the section that sets it out, so a
    // district without a column (an overlay such as IMU-O, PD, TOD) can be named and pointed to.
    all_districts: districts.map((d) => {
      const own = (code, name) => ORDINANCE.sections.find((x) => x.title.startsWith(`${code}:`)) || (name && ORDINANCE.sections.find((x) => x.title === name || x.title.replace(/\s+/g, ' ').startsWith(name)));
      // TOD-C sits in TOD's section, HO-Downtown in HO's.
      const sec = own(d.code, d.name) || own(d.code.split('-')[0]);
      return { ...d, ...(sec ? { section: sec.number } : {}), in_use_table: tables.some((t) => t.districts.includes(d.code)) };
    }),
    checked: { against: 'the ordinance text extraction (each row\'s marks, in order)', rows: checked, unchecked: unchecked.length },
    tables,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [pdf, flag] = process.argv.slice(2);
  if (!pdf) {
    console.error('usage: node scripts/build-use-tables.js <Zoning Ordinance PDF> [--write]');
    process.exit(1);
  }
  try {
    const out = build(pdf);
    for (const t of out.tables) console.log(`§${t.section} ${t.title}: ${t.rows.length} uses × ${t.districts.length} districts (${t.districts.join(' ')})`);
    if (flag === '--write') {
      writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
      console.log(`wrote ${OUT.pathname}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
