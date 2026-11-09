// Documents: a city's ordinances (zoning, City Code) and its adopted budget
// books, read from the PDFs the city publishes and split into sections, so
// Siren can find and quote the rule or the plan itself. Ordinances split into
// numbered sections (the `decimal` preset); a budget book's Department
// Budgets split by department and the subheadings each repeats (the `budget`
// preset, with findDepartment to look a department up by name). Pure
// functions; they run unchanged in Node and in Workers.
// scripts/ingest-document.js builds data/documents/*.json from a PDF with
// these, search index included (buildSearchIndex), and plugins/ordinances.js
// and plugins/budget-books.js serve them through plugins/document-lookup.js.
//
// A document records where its bytes came from (official URL, when, by whom,
// their DASL CID) and which version it is ("current through" for a law; fiscal
// year and adopted or proposed for a budget), so every answer can say which
// version it read.

const LEADERS = /\.{4,}/;
// A numbered line: "5.6 TREE PRESERVATION" or "      5.6.1.   PURPOSE STATEMENT".
const NUMBERED = /^(\s*)(\d{1,2}(?:\.\d{1,2}){1,3})\.?\s+(\S.*?)\s*$/;
// A table-of-contents entry: number, title, dot leaders, page label ("5-63").
const TOC = /^\s*(\d{1,2}(?:\.\d{1,2}){1,3})\.?\s+(.+?)\s*\.{4,}\s*([0-9A-Z]+-[0-9]+|\d+)\s*$/;

const shape = (line) => line.trim().replace(/\s+/g, ' ').replace(/\d+/g, '#');
const nonblank = (lines) => lines.map((l, i) => [l, i]).filter(([l]) => l.trim());
const upperRatio = (s) => {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;
};

/**
 * Pages with running headers and footers removed. A line in the first or last
 * few lines of a page is running text when its shape (digits ignored) repeats
 * on many pages, or when it is a right-aligned section or article header.
 */
export function stripRunning(pages, { edge = 6, share = 0.1 } = {}) {
  const split = pages.map((p) => p.split('\n'));
  const edges = split.map((lines) => {
    const nb = nonblank(lines);
    return new Set([...nb.slice(0, edge), ...nb.slice(-edge)].map(([, i]) => i));
  });
  const count = new Map();
  split.forEach((lines, p) => {
    const seen = new Set();
    for (const i of edges[p]) seen.add(shape(lines[i]));
    for (const s of seen) count.set(s, (count.get(s) || 0) + 1);
  });
  const min = Math.max(3, Math.floor(pages.length * share));
  const header = (line) => {
    const indent = line.length - line.trimStart().length;
    return indent >= 40 && /^(\d{1,2}(\.\d{1,2})*\s+\S|Article \d+:)/.test(line.trim());
  };
  return split.map((lines, p) =>
    lines.filter((l, i) => !(edges[p].has(i) && l.trim() && (count.get(shape(l)) >= min || header(l)))).join('\n')
  );
}

/**
 * Section numbers and titles from the document's table of contents. A long
 * title wraps, and its dot leaders land on the next line:
 *   5.6.4.  Tree Protection, Preservation, and Replacement
 *           Standards ................................. 5-66
 */
export function tableOfContents(pages) {
  const toc = new Map();
  const add = (num, title, label, p) => {
    if (!toc.has(num)) toc.set(num, { title: title.replace(/\s+/g, ' ').trim(), label, tocPage: p + 1 });
  };
  pages.forEach((page, p) => {
    const lines = page.split('\n');
    lines.forEach((line, i) => {
      const m = TOC.exec(line);
      if (m) return add(m[1], m[2], m[3], p);
      const head = NUMBERED.exec(line);
      if (!head || LEADERS.test(line)) return;
      const next = lines.slice(i + 1).find((l) => l.trim());
      const tail = next && !NUMBERED.test(next) && /^\s*(.+?)\s*\.{4,}\s*([0-9A-Z]+-[0-9]+|\d+)\s*$/.exec(next);
      if (tail) add(head[2], `${head[3]} ${tail[1]}`, tail[2], p);
    });
  });
  return toc;
}

// A page that is itself a table of contents (each article opens with one):
// mostly numbered lines in title case, no dot leaders needed.
const isContentsPage = (page) => {
  const nb = nonblank(page.split('\n')).map(([l]) => l);
  if (nb.length < 6) return false;
  const listed = nb.filter((l) => LEADERS.test(l) || (NUMBERED.test(l) && upperRatio(NUMBERED.exec(l)[3]) < 0.6)).length;
  return listed / nb.length >= 0.5;
};

// Lines (each with its page) as text: trimmed, wide gaps narrowed, at most
// one blank line in a row. `breaks` records where each page starts in the
// text, as [offset, page] pairs, so a passage can name its page.
function tidy(entries) {
  let text = '';
  let blank = false;
  let page = null;
  const breaks = [];
  for (const { line, page: p } of entries) {
    const t = line.trim().replace(/ {3,}/g, '  ');
    if (!t) {
      if (text) blank = true;
      continue;
    }
    if (text) text += blank ? '\n\n' : '\n';
    blank = false;
    if (p !== page) {
      breaks.push([text.length, p]);
      page = p;
    }
    text += t;
  }
  return { text, breaks };
}

/** The page a character offset of a section's text is on. */
export function pageAt(section, offset) {
  let page = section.pages[0];
  for (const [at, p] of section.breaks || []) if (at <= offset) page = p;
  return page;
}

// Budget books: the "Department Budgets" part of Norfolk's adopted budget
// document (FY 2024 on). Each page carries the department in its footer, with
// the printed page number ("City Auditor - 127", "128 - City Auditor"; FY 2024
// drops the dash), and its name again as the first line. Divider pages name a
// service area ("Legislative", "Public Safety"). Inside a department the same
// subheadings recur; FY 2024 also splits departments into programs
// ("Program:  Office of Fire-Rescue Chief", repeated atop each page).
const FOOTER = /^(?:(\d{1,4})\s+(?:-\s+)?([A-Za-z].*?)|([A-Za-z].*?)\s+(?:-\s+)?(\d{1,4}))$/;
const PROGRAM = /^Program:\s+(\S.*?)\s*$/;
// Subheadings that are a whole line by themselves.
const BUDGET_HEADINGS = [
  /^Mission( Statement)?:?$/,
  /^(Department )?Overview$/,
  /^Trends, Issues, and Initiatives$/,
  /^Top Initiatives for Fiscal Year:?$/,
  /^Adopted FY \d{4} Budget Actions$/,
  /^Department Programs:$/,
  /^Performance Measures:?$/,
  /^Special Project Positions:$/,
  /^Cost Recovery Summary:?$/,
  /^Adjustments to Baseline Service Level Cost:$/,
  /^Adopted Service Level Changes:$/,
  /^Requested but Not Funded Service Level Changes:$/,
];
// Subheadings that open a table and may carry its column labels on the same line.
const BUDGET_TABLES = [
  /^Expenditure Summary:?$/,
  /^(Department|Program) Budget Summary$/,
  /^Funding Source Summary$/,
  /^FTE Summary by Program$/,
  /^(Permanent |Temporary )?Full Time Equivalent \(FTE\) Summary:?$/,
];
const YEARS_ROW = /^\s*(FY \d{4}\s*)+$/;
const nameKey = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

/**
 * One page of a budget book: its printed label and department (from the
 * footer), and its kind: `blank`, `divider` (a service-area title page, with
 * `area`), or `body`, whose `lines` have the footer and the department's
 * running header taken off.
 */
export function budgetPage(raw) {
  const lines = raw.split('\n');
  const nb = nonblank(lines);
  if (!nb.length) return { kind: 'blank' };
  let label = null;
  let department = null;
  let end = lines.length;
  const foot = FOOTER.exec(nb.at(-1)[0].trim());
  if (foot) {
    label = foot[1] || foot[4];
    department = (foot[2] || foot[3]).replace(/\s+/g, ' ').trim();
    end = nb.at(-1)[1];
  }
  const rest = nonblank(lines.slice(0, end));
  const text = rest.map(([l]) => l.trim()).join(' ').replace(/\s+/g, ' ');
  if (!rest.length || /^This page intentionally left blank$/i.test(text)) return { kind: 'blank', label, department };
  if (rest.length <= 2 && text.length <= 60 && !/\d/.test(text) && (!department || nameKey(text) === nameKey(department))) {
    return { kind: 'divider', label, department, area: text };
  }
  let start = 0;
  const [first, at] = rest[0];
  if (department && nameKey(first) === nameKey(department)) start = at + 1;
  return { kind: 'body', label, department, lines: lines.slice(start, end) };
}

/** The printed page label of each PDF page (index 0 is PDF page 1), or null. */
export const budgetPageLabels = (rawPages) => rawPages.map((p) => budgetPage(p).label || null);

function budgetHeading(line, { firstOnPage }) {
  if (!line || /^\s/.test(line)) return null;
  const whole = line.trim().replace(/\s+/g, ' ');
  if (BUDGET_HEADINGS.some((re) => re.test(whole))) return { title: whole.replace(/:$/, ''), keep: false };
  const head = line.trim().split(/\s{2,}/)[0];
  if (BUDGET_TABLES.some((re) => re.test(head))) return { title: head.replace(/:$/, ''), keep: head !== line.trim() };
  // A table page's own title in capitals ("CENTRAL APPROPRIATIONS").
  if (firstOnPage && upperRatio(whole) === 1 && whole.replace(/[^A-Z]/g, '').length >= 6 && !/\d/.test(whole)) return { title: whole, keep: false, caps: true };
  return null;
}

// A table cell: a figure ("1,234", "(25,000)", "0.0", "12%", "$5"), or a
// word a table prints in a cell.
const CELL = /^(?:\(?-?\$?\d[\d,]*(?:\.\d+)?%?\)?|N\/A|Yes|No|TBD|-|—)$/;
const BLANK_CELL = '—';
// Tables of figures by year, where a blank cell moves a figure into the wrong
// year. (Position tables are left alone: their Total row has no pay grade or
// salary range, which reads plainly.)
const FIGURE_TABLES = /^(Expenditure Summary|(Department|Program) Budget Summary|Funding Source Summary|FTE Summary by Program|Performance Measures|Cost Recovery Summary)$/;
const UNALIGNED = '[a cell is blank here; which column each figure is in is unclear, see the page]';

// The cells at the end of a table row, with where each ends on the line, and
// where the row's label ends. A cell is set off from the label by at least two
// spaces ("Pension Principal & Interest2      7,829,389"); a figure one space
// after a word is part of the label ("FY 2025").
function rowCells(line) {
  if (/\bFY \d{4}\b/.test(line)) return null; // a heading row
  const tokens = [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  let i = tokens.length;
  while (i > 0 && CELL.test(tokens[i - 1].text)) i--;
  while (i > 0 && i < tokens.length && tokens[i].start - tokens[i - 1].end < 2) i++;
  const cells = tokens.slice(i);
  // A row has a label; a figure alone on a line is a footnote mark.
  if (!cells.length || i === 0) return null;
  return { cells, labelEnd: tokens[i - 1].end };
}

/**
 * Table rows with a blank cell, made explicit. pdftotext -layout keeps a
 * table's columns as spacing, which the text loses when it narrows wide gaps;
 * a row with an empty cell would then read as if its figures belonged to the
 * columns on the left. Within a block of rows (one page, no blank line or
 * year row between), the columns are where the full rows' cells end; a row
 * with fewer cells gets "—" in each column it leaves empty. A row that can't
 * be lined up is marked instead, so it is never read as complete.
 */
export function alignCells(entries) {
  const out = entries.slice();
  let block = [];
  const flush = () => {
    const rows = block.map((i) => ({ i, ...rowCells(out[i].line) })).filter((r) => r.cells);
    block = [];
    const K = Math.max(0, ...rows.map((r) => r.cells.length));
    const full = rows.filter((r) => r.cells.length === K);
    if (K < 2 || !full.length) return;
    const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const cols = Array.from({ length: K }, (_, c) => median(full.map((r) => r.cells[c].end)));
    const gap = Math.min(...cols.slice(1).map((x, c) => x - cols[c]));
    for (const r of rows) {
      if (r.cells.length === K) continue;
      const line = out[r.i].line;
      const at = r.cells.map((cell) => {
        const dist = cols.map((x) => Math.abs(x - cell.end));
        const c = dist.indexOf(Math.min(...dist));
        return dist[c] < gap / 2 ? c : -1;
      });
      const ok = gap > 0 && at.every((c, j) => c >= 0 && (j === 0 || c > at[j - 1]));
      const cells = ok ? cols.map((_, c) => r.cells[at.indexOf(c)]?.text || BLANK_CELL) : [...r.cells.map((x) => x.text), UNALIGNED];
      out[r.i] = { ...out[r.i], line: `${line.slice(0, r.labelEnd)}   ${cells.join('   ')}` };
    }
  };
  entries.forEach(({ line, page }, i) => {
    if (block.length && (out[block[0]].page !== page || !line.trim() || /\bFY \d{4}\b/.test(line))) flush();
    if (line.trim()) block.push(i);
  });
  flush();
  return out;
}

function splitBudget(rawPages) {
  const sections = [];
  let area = null;
  let dept = null; // { section, n, program }
  let cur = null;
  const open = (s) => {
    cur = { ...s, lines: [] };
    sections.push(cur);
    return cur;
  };
  rawPages.forEach((raw, p) => {
    const page = budgetPage(raw);
    if (page.kind === 'divider') area = page.area;
    if (page.kind !== 'body') return;
    const name = page.department || dept?.section.department || 'Department Budgets';
    if (!dept || nameKey(name) !== nameKey(dept.section.department)) {
      const number = String(sections.filter((s) => !s.number.includes('.')).length + 1);
      dept = { n: 0, program: null, section: open({ number, title: name, department: name, ...(area ? { area } : {}), pages: [p + 1, p + 1] }) };
    }
    let firstOnPage = true;
    let before = 0; // lines on this page so far, other than a table's year row
    for (const line of page.lines) {
      if (!line.trim()) {
        cur.lines.push({ line, page: p + 1 });
        continue;
      }
      const prog = PROGRAM.exec(line.trim());
      const heading = !prog && budgetHeading(line, { firstOnPage });
      firstOnPage = false;
      const leading = before === 0;
      if (!YEARS_ROW.test(line) && !prog) before++;
      if (prog) {
        if (dept.program && nameKey(prog[1]) === nameKey(dept.program.name)) continue; // repeated atop the page
        const number = `${dept.section.number}.${++dept.n}`;
        dept.program = { name: prog[1].replace(/\s+/g, ' '), number, n: 0 };
        open({ number, title: `Program: ${dept.program.name}`, department: dept.section.department, ...(area ? { area } : {}), program: dept.program.name, pages: [p + 1, p + 1] });
        continue;
      }
      if (heading) {
        if (heading.caps && cur.title === heading.title) continue; // the same table page title, repeated
        // A table that runs onto the next page repeats its heading there: the
        // table goes on in the same section.
        if (leading && !heading.caps && cur !== dept.section && cur.title === heading.title && cur.pages[0] < p + 1) {
          if (heading.keep) cur.lines.push({ line, page: p + 1 });
          continue;
        }
        const parent = dept.program || dept;
        const number = `${parent.number || dept.section.number}.${++parent.n}`;
        // A table's year row sits just above its heading ("FY 2024  FY 2025 ..."): bring it along.
        const carried = [];
        while (cur.lines.length && !cur.lines.at(-1).line.trim()) cur.lines.pop();
        if (heading.keep && cur.lines.length && YEARS_ROW.test(cur.lines.at(-1).line)) carried.push(cur.lines.pop());
        open({
          number,
          title: heading.title,
          department: dept.section.department,
          ...(area ? { area } : {}),
          ...(dept.program ? { program: dept.program.name } : {}),
          pages: [carried[0]?.page || p + 1, p + 1],
        });
        cur.lines.push(...carried);
        if (heading.keep) cur.lines.push({ line, page: p + 1 });
        continue;
      }
      cur.lines.push({ line, page: p + 1 });
      cur.pages[1] = p + 1;
    }
  });
  for (const s of sections) if (FIGURE_TABLES.test(s.title)) s.lines = alignCells(s.lines);
  // A section's last page is the last page it has text on; a department's
  // spans all of its subsections.
  for (const s of sections) {
    const last = s.lines.filter((l) => l.line.trim()).at(-1);
    s.pages[1] = last ? last.page : s.pages[0];
  }
  for (const s of sections) {
    const subs = sections.filter((x) => x.number.startsWith(`${s.number}.`));
    if (subs.length) s.pages[1] = Math.max(s.pages[1], ...subs.map((x) => x.pages[1]));
  }
  return sections;
}

/**
 * Split a document into sections. `decimal` (the Norfolk Zoning Ordinance):
 * a section starts at a line whose number is in the table of contents and
 * whose title is in capitals ("5.6 TREE PRESERVATION, ..."); its title comes
 * from the table of contents, which the PDF spells cleanly. Text before the
 * first section (cover, contents) is left out, and so are the contents pages
 * inside the body. `pages`: one chunk per page, for any document.
 * `budget`: a budget book's Department Budgets, one section per department
 * (numbered "1", "2", ... in book order), with its subheadings and, in
 * FY 2024, its programs below it ("7.2", "7.2.1"); each carries its
 * department, service area and program.
 * Pages are numbered from 1, as a PDF viewer counts them (#page=N).
 */
export function splitSections(rawPages, { preset = 'decimal' } = {}) {
  if (preset === 'budget') return splitBudget(rawPages).map(finish);
  const pages = stripRunning(rawPages);
  if (preset === 'pages') {
    return pages
      .map((t, i) => ({ number: String(i + 1), title: `Page ${i + 1}`, pages: [i + 1, i + 1], text: tidy(t.split('\n').map((line) => ({ line, page: i + 1 }))).text }))
      .filter((s) => s.text);
  }
  if (preset !== 'decimal') throw new Error(`Unknown section preset "${preset}". Known: decimal, pages, budget.`);
  const toc = tableOfContents(rawPages);
  if (!toc.size) throw new Error('No table of contents found; use --sections pages.');
  const sections = [];
  const seen = new Set();
  let cur = null;
  pages.forEach((page, p) => {
    if (isContentsPage(page)) return;
    for (const line of page.split('\n')) {
      const m = NUMBERED.exec(line);
      const heading =
        m && m[1].length <= 30 && !LEADERS.test(line) && toc.has(m[2]) && !seen.has(m[2]) && upperRatio(m[3]) >= 0.8;
      if (heading) {
        seen.add(m[2]);
        cur = { number: m[2], title: toc.get(m[2]).title, pages: [p + 1, p + 1], lines: [] };
        // The contents can disagree with the body (a stale entry). Keep the
        // contents' clean spelling, but mark a title whose letters don't match
        // the heading's, so the ingest can say so.
        const key = (x) => x.replace(/[^A-Za-z]/g, '').toUpperCase();
        const want = key(cur.title).slice(0, 12);
        if (!key(m[3]).startsWith(want) && !want.startsWith(key(m[3]))) cur.heading = m[3].replace(/\s+/g, ' ');
        sections.push(cur);
      } else if (cur) {
        cur.lines.push({ line, page: p + 1 });
        if (line.trim()) cur.pages[1] = p + 1;
      }
    }
  });
  return sections.map(finish);
}

// A section's lines as text, with the pages it crosses. The first page is
// already in `pages`; `breaks` keeps only the later page starts.
function finish({ lines, ...s }) {
  const { text, breaks } = tidy(lines);
  return { ...s, text, breaks: breaks.filter(([, p]) => p !== s.pages[0]) };
}

const STOP = new Set('a an and are as at be by for from has have in is it its of on or shall that the this to was what when where which who with any all may must not no'.split(' '));
const stem = (w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const terms = (s) =>
  String(s || '')
    .toLowerCase()
    .match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/g)
    ?.filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem) || [];

function firstHit(text, words) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = lower.search(new RegExp(`\\b${w.replace(/[^a-z0-9]/g, '')}`));
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  return at;
}

function excerpt(text, at, width = 600) {
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(width / 3));
  const out = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${out}${start + width < text.length ? '…' : ''}`;
}

// Passages of about this many characters, cut at blank lines, are what search
// scores: a 150,000-character section would otherwise match every query.
const PASSAGE = 1500;

function passagesOf(section) {
  const out = [];
  let start = 0;
  while (start < section.text.length) {
    let end = Math.min(section.text.length, start + PASSAGE);
    if (end < section.text.length) {
      const cut = section.text.lastIndexOf('\n\n', end);
      if (cut > start + PASSAGE / 3) end = cut;
    }
    out.push({ section, start, text: section.text.slice(start, end) });
    start = end;
  }
  if (!out.length) out.push({ section, start: 0, text: '' });
  return out;
}

/**
 * The search index: built once, when a document is ingested, and stored with
 * it as `search_index`, so a request only scores the passages that hold the
 * query's words. `passages` is flat, four numbers per passage: section index,
 * start and end in that section's text, and its word count. `postings` maps
 * each word to the passages that hold it, as "gap.value" pairs in base 36,
 * space-separated: gap from the previous passage's index, and value = 2 × the
 * word's count in the passage, plus 1 when the word is in the section's title.
 * Built from `sections` alone, so it can be rebuilt and checked at any time.
 */
export function buildSearchIndex(sections) {
  const passages = [];
  const lists = new Map();
  let words = 0;
  sections.forEach((section, si) => {
    const title = new Set(terms(section.title));
    for (const p of passagesOf(section)) {
      const pi = passages.length / 4;
      const ws = terms(p.text);
      passages.push(si, p.start, p.start + p.text.length, ws.length);
      words += ws.length;
      const tf = new Map();
      for (const w of ws) tf.set(w, (tf.get(w) || 0) + 1);
      for (const w of title) if (!tf.has(w)) tf.set(w, 0);
      for (const [w, f] of tf) {
        if (!lists.has(w)) lists.set(w, []);
        lists.get(w).push(pi, 2 * f + (title.has(w) ? 1 : 0));
      }
    }
  });
  const postings = {};
  for (const w of [...lists.keys()].sort()) {
    const l = lists.get(w);
    const out = [];
    for (let i = 0, prev = 0; i < l.length; i += 2) {
      out.push(`${(l[i] - prev).toString(36)}.${l[i + 1].toString(36)}`);
      prev = l[i];
    }
    postings[w] = out.join(' ');
  }
  const count = passages.length / 4;
  return { version: 1, passages, avg: words / Math.max(1, count), postings };
}

// A document without a stored index (a test fixture) gets one built once.
const BUILT = new WeakMap();
function indexOf(doc) {
  if (doc.search_index) return doc.search_index;
  if (!BUILT.has(doc)) BUILT.set(doc, buildSearchIndex(doc.sections));
  return BUILT.get(doc);
}

// The passages holding a word, as [passage index, value, ...].
function postingsOf(ix, w) {
  if (!Object.hasOwn(ix.postings, w)) return [];
  const out = [];
  let at = 0;
  for (const pair of ix.postings[w].split(' ')) {
    const dot = pair.indexOf('.');
    at += parseInt(pair.slice(0, dot), 36);
    out.push(at, parseInt(pair.slice(dot + 1), 36));
  }
  return out;
}

/**
 * Passages ranked for a query, best first, one per section: BM25 over
 * passages, a query word in the section's title counting extra, and a bonus
 * when the whole phrase appears. `filter(section)`, when given, keeps only
 * the sections it accepts, before ranking and the limit. Returns
 * [{ number, title, page, pages, excerpt, score }]; `page` is where the
 * excerpt is.
 */
export function searchSections(doc, query, { limit = 5, filter } = {}) {
  const words = [...new Set(terms(query))];
  if (!words.length) return [];
  const ix = indexOf(doc);
  const P = ix.passages;
  const n = P.length / 4;
  // The whole query as typed, any run of spaces matching any whitespace.
  const phrase = String(query).trim().split(/\s+/);
  const phraseRe = phrase.length > 1 && new RegExp(phrase.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
  const k = 1.2;
  const b = 0.75;
  const scores = new Float64Array(n);
  const hits = new Uint8Array(n);
  const allowed = new Map();
  const ok = (si) => {
    if (!filter) return true;
    if (!allowed.has(si)) allowed.set(si, !!filter(doc.sections[si]));
    return allowed.get(si);
  };
  for (const w of words) {
    const list = postingsOf(ix, w);
    const d = list.length / 2;
    if (!d) continue;
    const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
    for (let i = 0; i < list.length; i += 2) {
      const pi = list[i];
      if (!ok(P[4 * pi])) continue;
      const f = list[i + 1] >> 1;
      scores[pi] += idf * ((f * (k + 1)) / (f + k * (1 - b + (b * P[4 * pi + 3]) / ix.avg)) + (list[i + 1] & 1));
      hits[pi]++;
    }
  }
  const best = new Map();
  for (let pi = 0; pi < n; pi++) {
    let score = scores[pi];
    if (!score) continue;
    const section = doc.sections[P[4 * pi]];
    const text = section.text.slice(P[4 * pi + 1], P[4 * pi + 2]);
    // The phrase can only be in a passage that holds all of its words.
    if (phraseRe && hits[pi] === words.length && phraseRe.test(text)) score *= 1.5;
    const cur = best.get(section.number);
    if (!cur || score > cur.score) best.set(section.number, { p: { section, start: P[4 * pi + 1], text }, score });
  }
  return [...best.values()]
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ p, score }) => {
      const at = firstHit(p.text, words);
      return {
        number: p.section.number,
        title: p.section.title,
        // Budget books say whose section it is.
        ...(p.section.department ? { department: p.section.department } : {}),
        ...(p.section.program ? { program: p.section.program } : {}),
        page: pageAt(p.section, p.start + Math.max(0, at)),
        pages: p.section.pages,
        excerpt: excerpt(p.text, at),
        score: Math.round(score * 100) / 100,
      };
    });
}

// A section's text with `marker(page)` on its own line where each page starts.
function marked(section, marker) {
  if (!section.text) return '';
  const starts = [[0, section.pages[0]], ...(section.breaks || [])];
  let out = '';
  starts.forEach(([at, page], i) => {
    out += `${marker(page)}\n${section.text.slice(at, starts[i + 1]?.[0] ?? section.text.length)}`;
  });
  return out;
}

/**
 * A section with its subsections (reading 5.6 gives 5.6, 5.6.1, 5.6.2, ...),
 * each under its own number and title, windowed to `max` characters.
 * `marker(page)`, when given, is put on its own line where each page starts,
 * so a figure read from the text can be cited to its page.
 */
export function readSection(doc, number, { offset = 0, max = 12000, marker } = {}) {
  const n = String(number).trim().replace(/^§\s*/, '').replace(/\.$/, '');
  const parts = doc.sections.filter((x) => x.number === n || x.number.startsWith(`${n}.`));
  if (!parts.length || parts[0].number !== n) return null;
  const whole = parts.map((x) => `${x.number} ${x.title}\n${marker ? marked(x, marker) : x.text}`).join('\n\n');
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const text = whole.slice(start, start + max);
  const more = start + max < whole.length;
  return {
    number: n,
    title: parts[0].title,
    pages: [parts[0].pages[0], Math.max(...parts.map((x) => x.pages[1]))],
    subsections: parts.slice(1).map((x) => `${x.number} ${x.title}`),
    text,
    ...(more ? { continues: true, next_offset: start + max } : {}),
  };
}

/**
 * A budget book's department by name, forgiving case, punctuation and "&":
 * { match } with its section, or { candidates } (the departments whose names
 * contain the words given, or every department when none do).
 */
export function findDepartment(doc, name) {
  const depts = doc.sections.filter((s) => s.department && !s.number.includes('.'));
  // Word forms count as the same ("Library" finds "Libraries").
  const key = (x) => terms(String(x).replace(/&/g, ' and ')).join('').replace(/[^a-z0-9]/g, '');
  const want = key(name);
  const exact = want && depts.find((s) => key(s.department) === want);
  if (exact) return { match: exact };
  const near = want ? depts.filter((s) => key(s.department).includes(want) || want.includes(key(s.department))) : [];
  if (near.length === 1) return { match: near[0] };
  return { candidates: (near.length ? near : depts).map((s) => s.department) };
}

/** The page link a reader can open: the official PDF at that page. */
export const pageLink = (doc, page) => `${doc.source.url}#page=${page}`;
