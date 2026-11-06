// budget_book_lookup: the Department Budgets part of Norfolk's adopted budget
// books, split by department and its recurring subheadings, so Siren can say
// what the City planned to fund and why, citing fiscal year, department,
// section and page. Each book in data/documents/ is built from the City's PDF
// by scripts/ingest-document.js (--kind budget-book), and records where the
// PDF came from, its DASL CID, and how it was identified as the adopted book.
// Sources checked live on norfolk.gov 2026-11-06: each PDF is listed on that
// year's Budget Document page (the file's listed_on) as a section of the
// Adopted budget document. The books name positions by title, not staff by
// name; the only personal names in them are in the names of places, funds
// and laws (for example the Mary D. Pretlow and Barron F. Black branch
// libraries, the Slover, the Attucks Theatre, the Marcus-David Peters Act).
// test/budget-books.test.js fails on an honorific or a role and a name.
//
// Each book carries its search index (built at ingest), so a search only
// scores: across all four books it costs about 1 to 2 ms of CPU in Node,
// measured 2026-11-06 (the Workers Free plan allows 10 ms per request).

import { definePlugin } from '../src/plugins.js';
import { findDepartment, pageLink } from '../src/documents.js';
import { readCited, searchCited } from './document-lookup.js';
import fy2027 from '../data/documents/norfolk-budget-fy2027-departments.json' with { type: 'json' };
import fy2026 from '../data/documents/norfolk-budget-fy2026-departments.json' with { type: 'json' };
import fy2025 from '../data/documents/norfolk-budget-fy2025-departments.json' with { type: 'json' };
import fy2024 from '../data/documents/norfolk-budget-fy2024-departments.json' with { type: 'json' };

// Newest first: a search across years lists the latest book first on a tie.
export const BUDGET_BOOKS = Object.fromEntries([fy2027, fy2026, fy2025, fy2024].map((d) => [d.fiscal_year, d]));
const YEARS = Object.keys(BUDGET_BOOKS).map(Number).sort((a, b) => b - a);

const about = (doc) => ({
  title: `${doc.book}: ${doc.title}`,
  fiscal_year: doc.fiscal_year,
  status: doc.status,
  part: doc.part,
  official_pdf: doc.source.url,
  ...(doc.listed_on ? { listed_on: doc.listed_on } : {}),
  cid: doc.source.cid,
  retrieved: doc.source.retrieved,
});

const HOW =
  "These are the City's adopted budget books: what it planned to fund and why, by department, in the narratives and tables it wrote. Figures in columns headed Adopted are the City's plan: call them the adopted plan, never spending. Figures in columns headed Actual are prior-year figures as the City printed them in that book: quote them as \"reported as actual in the FY N budget book\". Quote every figure exactly as printed, with the fiscal year, department, section and the link to the page it is printed on. In a section's text, [PDF page N, printed P] marks where each page starts: link a figure to the page it falls under, as official_pdf#page=N (each subsection also gives its first page and link). In a table of figures by year, \u2014 marks a cell the PDF leaves blank. A row marked unclear, or text that looks garbled, can't be read for figures: say so and link the page instead. A \"Requested but Not Funded\" section lists requests the adopted budget did not fund. An excerpt is part of a section; read the section a search found before saying what the City planned. If nothing here addresses the question, say the budget books don't appear to, and name the fiscal years you searched.";

const book = (doc) => `FY ${doc.fiscal_year} ${doc.title}`;
const printed = (doc, page) => doc.page_labels?.[page - 1] || null;
const where = (s) => [s.department, s.program !== s.department && s.program].filter(Boolean).join(' › ');
// A hand-off title names a section once: "Police", not "Police, Police".
const named = (doc, s) => {
  const place = where(s);
  const own = s.title === s.department || (s.program && s.title === `Program: ${s.program}`) ? '' : `, ${s.title}`;
  return `${book(doc)}: ${place}${own}`;
};
const marker = (doc) => (page) => `[PDF page ${page}${printed(doc, page) ? `, printed ${printed(doc, page)}` : ''}]`;
// A tool result reaches the model cut at 16,000 characters; stay under it.
const LIMIT = 15500;
const size = (x) => JSON.stringify(x).length;
const norm = (n) => String(n).trim().replace(/^§\s*/, '').replace(/\.$/, '');

export default definePlugin({
  name: 'budget_book_lookup',
  cities: ['norfolk'],
  description: `Search or read the Department Budgets part of Norfolk's adopted budget books (fiscal years ${YEARS.join(', ')}), as the City publishes them: each department's mission or overview, its budget actions (what was added, cut or moved, and why), expenditure and position summaries, and performance measures. Give query to find passages (fiscal year, department, section number and title, page link, excerpt), across every year or within fiscal_year, and add department to search only that department. Give fiscal_year with department to read that department's section, or with section to read one section by its number. Use for what the City planned to fund and the reasons it gave; its figures headed Adopted are plans, not spending.`,
  parameters: {
    type: 'object',
    properties: {
      fiscal_year: { type: 'integer', enum: YEARS, description: 'Which adopted budget. Leave out to search every year; needed to read a section.' },
      query: { type: 'string', description: 'What to look for, in plain words ("street tree maintenance", "overtime", "new positions").' },
      department: { type: 'string', description: 'A department, such as "Fire-Rescue" or "Parks and Recreation". With query, limits the search to it; with fiscal_year alone, reads its section.' },
      section: { type: 'string', description: 'A section number from a result or a department\'s subsections, such as "42.3".' },
      offset: { type: 'integer', description: 'When reading a long section, continue from this character (the next_offset you were given).' },
    },
    additionalProperties: false,
  },
  async run(ctx, { fiscal_year, query, department, section, offset }) {
    // Arguments aren't checked against the schema before they get here.
    const year = fiscal_year == null ? null : Number(fiscal_year);
    if (year != null && !YEARS.includes(year)) return { error: `No budget book for fiscal year ${String(fiscal_year).slice(0, 20)}. Known: ${YEARS.join(', ')}.` };
    const hasQuery = query && String(query).trim();
    if (section || (department && !hasQuery)) {
      if (year == null) return { error: `Give fiscal_year (${YEARS.join(', ')}) to read a department or section.` };
      const doc = BUDGET_BOOKS[year];
      let number = section && norm(section);
      if (!number) {
        const found = findDepartment(doc, department);
        if (!found.match) {
          await ctx.cite({ tool: `list departments in ${book(doc)}`, url: doc.source.url, rows: found.candidates.length, note: `no single match for "${String(department).slice(0, 80)}"; CID ${doc.source.cid}` });
          return { budget: about(doc), error: `No single department matches "${String(department).slice(0, 80)}" in the FY ${year} book. Departments to choose from:`, departments: found.candidates };
        }
        number = found.match.number;
      }
      const sec = doc.sections.find((x) => x.number === number);
      // The section's own parts, one level down, each with its first page.
      const subsections = sec
        ? doc.sections
            .filter((x) => x.number.startsWith(`${number}.`) && !x.number.slice(number.length + 1).includes('.'))
            .map((x) => ({ number: x.number, title: x.title, page: x.pages[0], printed_page: printed(doc, x.pages[0]), link: pageLink(doc, x.pages[0]) }))
        : [];
      // Everything but the text, so the text window can take what is left.
      const head = (s) => ({
        budget: about(doc),
        fiscal_year: doc.fiscal_year,
        department: sec.department,
        ...(sec.program ? { program: sec.program } : {}),
        ...(sec.area ? { service_area: sec.area } : {}),
        section: number,
        title: sec.title,
        pages: s.pages,
        printed_pages: [printed(doc, s.pages[0]), printed(doc, s.pages[1])],
        link: s.link,
        continues: true,
        next_offset: s.next_offset ?? 0,
        how_to_use: HOW,
        subsections,
        ...(s.more ? { more_subsections: s.more } : {}),
      });
      let more = 0;
      if (sec) while (subsections.length && size(head({ pages: sec.pages, link: pageLink(doc, sec.pages[0]), next_offset: 1e7 })) > LIMIT - 4000) (subsections.pop(), more++);
      const room = sec ? LIMIT - size(head({ pages: sec.pages, link: pageLink(doc, sec.pages[0]), next_offset: 1e7, more })) - 20 : 0;
      const s = await readCited(ctx, doc, number, {
        offset,
        max: Math.max(2000, Math.min(9000, room)),
        marker: marker(doc),
        tool: `read ${book(doc)} section ${number}`,
        note: `text of the City's PDF (${doc.book}, ${doc.part}); CID ${doc.source.cid}`,
        record: (x) => `${named(doc, doc.sections.find((y) => y.number === x.number))} (PDF page ${x.pages[0]})`,
      });
      if (!s) return { budget: about(doc), error: `No section ${String(section ?? number).slice(0, 40)} in the FY ${year} book. Search with query, or give department, to find section numbers.` };
      // The text goes last: if a long result is cut, the citation and the paging survive.
      const start = Math.max(0, Math.trunc(Number(offset) || 0));
      let text = s.text;
      let continues = !!s.continues;
      const build = () => {
        const o = { ...head({ ...s, more }), text };
        if (continues) {
          o.next_offset = start + text.length;
        } else {
          delete o.continues;
          delete o.next_offset;
        }
        return o;
      };
      let out = build();
      // JSON escaping can still push it over: trim the text and page on from there.
      while (size(out) > LIMIT) {
        text = text.slice(0, Math.max(0, text.length - (size(out) - LIMIT) - 50));
        continues = true;
        out = build();
      }
      return out;
    }
    if (!hasQuery) return { error: 'Give query (what to look for), or fiscal_year with department or section (to read).' };
    const docs = year != null ? [BUDGET_BOOKS[year]] : YEARS.map((y) => BUDGET_BOOKS[y]);
    const perYear = [];
    const missing = {};
    for (const doc of docs) {
      let only = null;
      if (department) {
        const found = findDepartment(doc, department);
        if (!found.match) {
          await ctx.cite({ tool: `list departments in ${book(doc)}`, url: doc.source.url, rows: found.candidates.length, note: `no single match for "${String(department).slice(0, 80)}"; CID ${doc.source.cid}` });
          missing[doc.fiscal_year] = found.candidates;
          continue;
        }
        only = found.match.department;
      }
      const found = await searchCited(ctx, doc, query, {
        limit: 12,
        // Sections with no text of their own match on their title alone; leave them out.
        filter: (s) => s.text.trim() !== '' && (!only || s.department === only),
        tool: `search ${book(doc)}`,
        note: `"${String(query).slice(0, 120)}"${only ? ` in ${only}` : ''}, in the text of the City's PDF (${doc.book}, ${doc.part}); CID ${doc.source.cid}`,
      });
      // The same passage repeated under several programs counts once.
      const seen = new Set();
      perYear.push(found.filter((r) => {
        const key = `${r.department}|${r.title}|${r.excerpt}`;
        return !seen.has(key) && seen.add(key);
      }).map((r) => ({ doc, r })));
    }
    // Scores from different books don't compare: take each year's best two,
    // then fill by score, and list newest year first.
    const picked = new Set(perYear.flatMap((list) => list.slice(0, 2)));
    for (const x of perYear.flat().sort((a, b) => b.r.score - a.r.score)) {
      if (picked.size >= 8) break;
      picked.add(x);
    }
    const results = [...picked]
      .sort((a, b) => b.doc.fiscal_year - a.doc.fiscal_year || b.r.score - a.r.score)
      .map(({ doc, r }) => ({
        fiscal_year: doc.fiscal_year,
        department: r.department,
        ...(r.program && r.program !== r.department ? { program: r.program } : {}),
        section: r.number,
        title: r.title,
        page: r.page,
        printed_page: printed(doc, r.page),
        link: r.link,
        excerpt: r.excerpt,
      }));
    // Every book searched is in the hand-off, found or not, so "the books don't appear to" can be checked.
    for (const doc of docs) ctx.resources.addRecord({ title: `${doc.book}: ${doc.title} (City of Norfolk PDF)`, url: doc.source.url, kind: 'source' });
    const out = {
      searched: docs.map((d) => about(d)),
      query,
      ...(department ? { department } : {}),
      ...(Object.keys(missing).length ? { department_not_found_in: Object.keys(missing).map(Number).sort((a, b) => b - a), departments_by_year: missing } : {}),
      how_to_use: HOW,
      results,
    };
    while (size(out) > LIMIT && out.results.length > 1) out.results.pop();
    return out;
  },
});
