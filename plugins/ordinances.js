// ordinance_lookup: Norfolk's ordinances as the City publishes them, split
// into numbered sections, so Siren can find the rule and quote it with its
// section and page. Each document in data/documents/ is built from the
// City's PDF by scripts/ingest-document.js, and records where the PDF came
// from, its DASL CID, and the date its text is current through.

import { definePlugin } from '../src/plugins.js';
import { readCited, searchCited } from './document-lookup.js';
import zoning from '../data/documents/norfolk-zoning-ordinance.json' with { type: 'json' };

export const DOCUMENTS = { [zoning.id]: zoning };

const about = (doc) => ({
  title: doc.title,
  enacted: doc.enacted,
  current_through: doc.current_through,
  official_pdf: doc.source.url,
  cid: doc.source.cid,
  retrieved: doc.source.retrieved,
});

const HOW =
  'Quote the section number and title, and link the page. This is text extracted from the City\'s PDF, current through the date given: amendments after it are not here, and the PDF at the link is the authority. An excerpt is part of a section; read the section before saying what it requires. If nothing here addresses the question, say the document doesn\'t appear to, and name the document you searched.';

export default definePlugin({
  name: 'ordinance_lookup',
  cities: ['norfolk'],
  description: `Search or read Norfolk's ordinances, by section, as the City publishes them: ${Object.values(DOCUMENTS)
    .map((d) => `"${d.id}" (${d.title}, ${d.current_through})`)
    .join('; ')}. Give query to find the sections that address something (section numbers, titles, the page, an excerpt), or section to read one with its subsections (for example "5.6", tree preservation). Use for what the rules require, allow or prohibit, and who reviews what. The City Code is not here yet, including its Chapter 45 tree requirements, which the Zoning Ordinance's §5.6 supplements; the Zoning Ordinance covers trees and landscaping on land being developed.`,
  parameters: {
    type: 'object',
    properties: {
      document: { type: 'string', enum: Object.keys(DOCUMENTS), description: 'Which ordinance.' },
      query: { type: 'string', description: 'What to look for, in plain words ("tree removal during development", "fence height").' },
      section: { type: 'string', description: 'A section number to read, such as "5.6" or "5.6.4".' },
      offset: { type: 'integer', description: 'When reading a long section, continue from this character (the next_offset you were given).' },
    },
    required: ['document'],
    additionalProperties: false,
  },
  async run(ctx, { document, query, section, offset }) {
    const doc = Object.hasOwn(DOCUMENTS, String(document)) ? DOCUMENTS[document] : null;
    if (!doc) return { error: `No document "${document}". Known: ${Object.keys(DOCUMENTS).join(', ')}.` };
    if (section) {
      const s = await readCited(ctx, doc, section, {
        offset,
        tool: `read ${doc.title} §${section}`,
        note: `text of the City's PDF, ${doc.current_through}; CID ${doc.source.cid}`,
        record: (x) => `${doc.title} §${x.number}, ${x.title} (PDF page ${x.pages[0]})`,
      });
      if (!s) return { document: about(doc), error: `No section ${section} in the ${doc.title}. Search with query to find section numbers.` };
      const { link, ...rest } = s;
      return { document: about(doc), section: `§${s.number}`, ...rest, link, how_to_use: HOW };
    }
    if (!query || !String(query).trim()) return { error: 'Give query (what to look for) or section (a number to read).' };
    const found = await searchCited(ctx, doc, query, {
      limit: 5,
      tool: `search the ${doc.title}`,
      note: `"${String(query).slice(0, 120)}" in the text of the City's PDF, ${doc.current_through}; CID ${doc.source.cid}`,
    });
    const results = found.map((r) => ({ section: `§${r.number}`, title: r.title, page: r.page, link: r.link, excerpt: r.excerpt }));
    ctx.resources.addRecord({ title: `${doc.title} (City of Norfolk PDF, ${doc.current_through})`, url: doc.source.url, kind: 'source' });
    return { document: about(doc), query, results, how_to_use: HOW };
  },
});
