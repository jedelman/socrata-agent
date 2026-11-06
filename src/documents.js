// Documents: a city's ordinances (zoning, City Code), read from the PDF the
// city publishes and split into numbered sections, so Siren can find and
// quote the rule itself. Pure functions; they run unchanged in Node and in
// Workers. scripts/ingest-document.js builds data/documents/*.json from a PDF
// with these, and plugins/ordinances.js serves them.
//
// A document records where its bytes came from (official URL, when, by whom,
// their DASL CID) and how current the text is ("current through"), so every
// answer can say which version of the law it read.

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
    for (const line of page.lines) {
      if (!line.trim()) {
        cur.lines.push({ line, page: p + 1 });
        continue;
      }
      const prog = PROGRAM.exec(line.trim());
      const heading = !prog && budgetHeading(line, { firstOnPage });
      firstOnPage = false;
      if (prog) {
        if (dept.program && nameKey(prog[1]) === nameKey(dept.program.name)) continue; // repeated atop the page
        const number = `${dept.section.number}.${++dept.n}`;
        dept.program = { name: prog[1].replace(/\s+/g, ' '), number, n: 0 };
        open({ number, title: `Program: ${dept.program.name}`, department: dept.section.department, ...(area ? { area } : {}), program: dept.program.name, pages: [p + 1, p + 1] });
        continue;
      }
      if (heading) {
        if (heading.caps && cur.title === heading.title) continue; // the same table page title, repeated
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

const INDEX = new WeakMap();
function indexOf(doc) {
  let ix = INDEX.get(doc);
  if (ix) return ix;
  const passages = doc.sections.flatMap(passagesOf).map((p) => {
    const tf = new Map();
    const words = terms(p.text);
    for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
    return { ...p, tf, len: words.length, title: new Set(terms(p.section.title)) };
  });
  const df = new Map();
  for (const p of passages) for (const w of new Set([...p.tf.keys(), ...p.title])) df.set(w, (df.get(w) || 0) + 1);
  const avg = passages.reduce((n, p) => n + p.len, 0) / Math.max(1, passages.length);
  ix = { passages, df, avg };
  INDEX.set(doc, ix);
  return ix;
}

/**
 * Passages ranked for a query, best first, one per section: BM25 over
 * passages, a query word in the section's title counting extra, and a bonus
 * when the whole phrase appears. Returns
 * [{ number, title, page, pages, excerpt, score }]; `page` is where the
 * excerpt is.
 */
export function searchSections(doc, query, { limit = 5 } = {}) {
  const words = [...new Set(terms(query))];
  if (!words.length) return [];
  const { passages, df, avg } = indexOf(doc);
  const n = passages.length;
  const phrase = String(query).toLowerCase().replace(/\s+/g, ' ').trim();
  const k = 1.2;
  const b = 0.75;
  const best = new Map();
  for (const p of passages) {
    let score = 0;
    for (const w of words) {
      const d = df.get(w) || 0;
      if (!d) continue;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      const f = p.tf.get(w) || 0;
      score += idf * ((f * (k + 1)) / (f + k * (1 - b + (b * p.len) / avg)) + (p.title.has(w) ? 1 : 0));
    }
    if (!score) continue;
    if (phrase.includes(' ') && p.text.toLowerCase().replace(/\s+/g, ' ').includes(phrase)) score *= 1.5;
    const cur = best.get(p.section.number);
    if (!cur || score > cur.score) best.set(p.section.number, { p, score });
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

/**
 * A section with its subsections (reading 5.6 gives 5.6, 5.6.1, 5.6.2, ...),
 * each under its own number and title, windowed to `max` characters.
 */
export function readSection(doc, number, { offset = 0, max = 12000 } = {}) {
  const n = String(number).trim().replace(/^§\s*/, '').replace(/\.$/, '');
  const parts = doc.sections.filter((x) => x.number === n || x.number.startsWith(`${n}.`));
  if (!parts.length || parts[0].number !== n) return null;
  const whole = parts.map((x) => `${x.number} ${x.title}\n${x.text}`).join('\n\n');
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
