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
// and laws (the Mary D. Pretlow library, the Marcus-David Peters Act).

import { definePlugin } from '../src/plugins.js';
import { findDepartment } from '../src/documents.js';
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
  "These are the City's adopted budget plans and the narratives it wrote for them: what it said it would fund and why, by department. They are not records of spending. Quote figures exactly as printed, with the fiscal year, department, section and page link. Tables were extracted from the PDF with their column spacing flattened: when a table's text is garbled or you can't tell which column a number belongs to, say so and link the page instead of reading numbers out of it. A \"Requested but Not Funded\" section lists requests the adopted budget did not fund. An excerpt is part of a section; read the section before saying what the City planned. If nothing here addresses the question, say the budget books don't appear to, and name the fiscal years you searched.";

const book = (doc) => `FY ${doc.fiscal_year} ${doc.title}`;
const printed = (doc, page) => doc.page_labels?.[page - 1] || null;
const where = (s) => [s.department, s.program !== s.department && s.program].filter(Boolean).join(' › ');

export default definePlugin({
  name: 'budget_book_lookup',
  cities: ['norfolk'],
  description: `Search or read the Department Budgets part of Norfolk's adopted budget books (fiscal years ${YEARS.join(', ')}), as the City publishes them: each department's mission or overview, its budget actions (what was added, cut or moved, and why), expenditure and position summaries, and performance measures. Give query to find passages (fiscal year, department, section number and title, page link, excerpt), across every year or within fiscal_year, and add department to search only that department. Give fiscal_year with department to read that department's section, or with section to read one section by its number. Use for what the City planned to fund and the reasons it gave, not for what it actually spent.`,
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
    if (fiscal_year != null && !BUDGET_BOOKS[fiscal_year]) return { error: `No budget book for fiscal year ${fiscal_year}. Known: ${YEARS.join(', ')}.` };
    const hasQuery = query && String(query).trim();
    if (section || (department && !hasQuery)) {
      if (fiscal_year == null) return { error: `Give fiscal_year (${YEARS.join(', ')}) to read a department or section.` };
      const doc = BUDGET_BOOKS[fiscal_year];
      let number = section && String(section).trim();
      if (!number) {
        const found = findDepartment(doc, department);
        if (!found.match) {
          await ctx.cite({ tool: `list departments in ${book(doc)}`, url: doc.source.url, rows: found.candidates.length, note: `no single match for "${String(department).slice(0, 80)}"; CID ${doc.source.cid}` });
          return { budget: about(doc), error: `No single department matches "${department}" in the FY ${fiscal_year} book. Departments to choose from:`, departments: found.candidates };
        }
        number = found.match.number;
      }
      const s = await readCited(ctx, doc, number, {
        offset,
        // Leaves room in a 16,000-character tool result for a long list of subsections.
        max: 9000,
        tool: `read ${book(doc)} section ${number}`,
        note: `text of the City's PDF (${doc.book}, ${doc.part}); CID ${doc.source.cid}`,
        record: (x) => `${book(doc)}: ${where(doc.sections.find((y) => y.number === x.number))}, ${x.title} (PDF page ${x.pages[0]})`,
      });
      if (!s) return { budget: about(doc), error: `No section ${number} in the FY ${fiscal_year} book. Search with query, or give department, to find section numbers.` };
      const sec = doc.sections.find((x) => x.number === s.number);
      // The text goes last: if a long result is cut, the citation and the paging survive.
      return {
        budget: about(doc),
        fiscal_year: doc.fiscal_year,
        department: sec.department,
        ...(sec.program ? { program: sec.program } : {}),
        ...(sec.area ? { service_area: sec.area } : {}),
        section: s.number,
        title: s.title,
        pages: s.pages,
        printed_pages: [printed(doc, s.pages[0]), printed(doc, s.pages[1])],
        link: s.link,
        ...(s.continues ? { continues: true, next_offset: s.next_offset } : {}),
        how_to_use: HOW,
        subsections: s.subsections,
        text: s.text,
      };
    }
    if (!hasQuery) return { error: 'Give query (what to look for), or fiscal_year with department or section (to read).' };
    const docs = fiscal_year != null ? [BUDGET_BOOKS[fiscal_year]] : YEARS.map((y) => BUDGET_BOOKS[y]);
    const all = [];
    const missing = [];
    for (const doc of docs) {
      let only = null;
      if (department) {
        const found = findDepartment(doc, department);
        if (!found.match) {
          missing.push(doc.fiscal_year);
          continue;
        }
        only = found.match.department;
      }
      const found = await searchCited(ctx, doc, query, {
        // Ranked over the whole book, then narrowed to the department.
        limit: only ? 1000 : 6,
        tool: `search ${book(doc)}`,
        note: `"${String(query).slice(0, 120)}"${only ? ` in ${only}` : ''}, in the text of the City's PDF (${doc.book}, ${doc.part}); CID ${doc.source.cid}`,
      });
      for (const r of found) if (!only || r.department === only) all.push({ doc, r });
    }
    const results = all
      .sort((a, b) => b.r.score - a.r.score)
      .slice(0, 8)
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
    for (const doc of docs) {
      if (results.some((r) => r.fiscal_year === doc.fiscal_year)) {
        ctx.resources.addRecord({ title: `${doc.book}: ${doc.title} (City of Norfolk PDF)`, url: doc.source.url, kind: 'source' });
      }
    }
    return {
      searched: docs.map((d) => about(d)),
      query,
      ...(department ? { department } : {}),
      ...(missing.length ? { department_not_found_in: missing } : {}),
      how_to_use: HOW,
      results,
    };
  },
});
