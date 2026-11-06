// Shared by the document tools (ordinance_lookup, budget_book_lookup): read a
// section of a document or search it, with the read written into the trace
// (ctx.cite) and, for a section, its page link into the hand-off. The
// documents are prebuilt files the plugin holds; nothing here touches the
// network.

import { searchSections, readSection, pageLink } from '../src/documents.js';

/**
 * A section with its subsections, windowed, and the link to its first page.
 * Cites the read whether or not the section exists; returns null if it doesn't.
 * `record(s)` names the hand-off entry for a section that was found.
 */
export async function readCited(ctx, doc, number, { offset, max, marker, tool, note, record }) {
  const s = readSection(doc, number, { offset, ...(max ? { max } : {}), ...(marker ? { marker } : {}) });
  await ctx.cite({ tool, url: doc.source.url, rows: s ? 1 : 0, note });
  if (!s) return null;
  const link = pageLink(doc, s.pages[0]);
  ctx.resources.addRecord({ title: record(s), url: link, kind: 'source' });
  return { ...s, link };
}

/**
 * Ranked passages for a query, each with its page link. Cites the search,
 * with the rows it returned. `filter(section)` narrows the search itself
 * (before ranking and the limit), so the rows cited are the rows found.
 */
export async function searchCited(ctx, doc, query, { limit = 5, filter, tool, note }) {
  const results = searchSections(doc, query, { limit, ...(filter ? { filter } : {}) }).map((r) => ({ ...r, link: pageLink(doc, r.page) }));
  await ctx.cite({ tool, url: doc.source.url, rows: results.length, note });
  return results;
}
