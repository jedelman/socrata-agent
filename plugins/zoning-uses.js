// zoning_uses: the Zoning Ordinance's use tables, as a lookup. Jason,
// 2026-11-20: "Can we make that into a tool since it's such a weird custom way
// to do zoning?" Whether a use is allowed in a district is a grid (Tables
// 3.2.12 to 3.9.23: a row per use, a column per district, P / C / P/C or
// blank), and the ordinance's text extraction drops the blank cells, so
// ordinance_lookup can't say which district a mark belongs to. The grid is
// read from the City's PDF by word position (scripts/build-use-tables.js, the
// same edition and CID as the ordinance text) and checked row by row against
// the text extraction; rows the City prints inconsistently carry a note.

import { definePlugin } from '../src/plugins.js';
import tables from '../data/documents/norfolk-zoning-use-tables.json' with { type: 'json' };

const MAX_MATCHES = 6;
const MAX_LIST = 60;
const PDF = tables.source.url;
const pageUrl = (page) => `${PDF}#page=${page}`;

// District codes and names, and how a person might type them ("cc", "c-c", "Community Commercial").
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const DISTRICTS = tables.districts;
const TABLE_OF = new Map();
for (const t of tables.tables) for (const d of t.districts) TABLE_OF.set(d, t);
// Districts the ordinance establishes that have no column in any use table.
const NO_TABLE = {
  PD: 'Planned Development districts follow their own approved PD master plan and terms and conditions (Section 3.8), not a use table.',
  'STRL-O': 'The Short-Term Rental Limitation Overlay adds standards for short-term rentals (Section 3.9.22) on top of the base district\'s use table.',
};
export function districtCode(input) {
  const q = squash(input);
  if (!q) return null;
  const byCode = DISTRICTS.find((d) => squash(d.code) === q);
  if (byCode) return byCode.code;
  const byName = DISTRICTS.filter((d) => squash(d.name) === q || squash(`${d.code} ${d.name}`) === q);
  if (byName.length === 1) return byName[0].code;
  if (NO_TABLE[String(input).trim().toUpperCase()]) return String(input).trim().toUpperCase();
  return null;
}

// Words people use for uses the tables name otherwise. Only where the table's own name is plain.
const SAYINGS = [
  [/\b(?:airbnb|vrbo|vacation rentals?|short[- ]term rentals?|str)\b/i, 'short-term rental unit'],
  [/\b(?:adu|granny flat|in-law (?:suite|apartment)|backyard cottage|accessory apartment)\b/i, 'accessory dwelling unit'],
  [/\b(?:duplex)\b/i, 'dwelling, two-family'],
  [/\b(?:daycare|day care|child care|childcare)\b/i, 'day care center'],
  [/\b(?:brewpub|taproom|craft brewery|microbrewery)\b/i, 'production of craft beverages'],
  [/\b(?:bar|tavern|pub)\b/i, 'sale of alcoholic beverages, on-premises'],
  [/\b(?:liquor store|package store|abc store)\b/i, 'sale of alcoholic beverages, off-premises'],
  [/\b(?:apartments?|apartment building)\b/i, 'dwelling, multi-family'],
  [/\b(?:food trucks?)\b/i, 'vendor park, food'],
];
const STOP = new Set(['a', 'an', 'the', 'of', 'or', 'and', 'for', 'in', 'to', 'as', 'use', 'uses', 'is', 'are', 'can', 'i', 'my', 'allowed', 'permitted', 'open', 'run', 'have', 'build', 'put', 'zone', 'zoned', 'zoning', 'district']);
const stem = (w) => (w.length > 4 ? w.replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '') : w);
const wordsOf = (s) => String(s ?? '').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g)?.flatMap((w) => [w, ...w.split('-')]).map(stem) ?? [];

/** The distinct uses (by name) whose names hold the query's words; the best first. */
export function matchUses(query) {
  let q = String(query ?? '');
  for (const [re, name] of SAYINGS) if (re.test(q)) q = `${q} ${name}`;
  const want = [...new Set(wordsOf(q).filter((w) => !STOP.has(w) && w.length > 1))];
  if (!want.length) return [];
  const names = new Map();
  for (const t of tables.tables) for (const r of t.rows) for (const n of [r.use, r.also].filter(Boolean)) if (!names.has(n)) names.set(n, new Set(wordsOf(n)));
  const scored = [];
  for (const [name, have] of names) {
    const hits = want.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w) && w.length >= 4));
    if (!hits.length) continue;
    scored.push({ name, score: hits.length / want.length, extra: have.size - hits.length });
  }
  const best = Math.max(0, ...scored.map((s) => s.score));
  return scored
    .filter((s) => s.score === best || (s.score >= 0.5 && s.score > best - 0.25))
    .sort((a, b) => b.score - a.score || a.extra - b.extra || a.name.localeCompare(b.name))
    .slice(0, MAX_MATCHES)
    .map((s) => s.name);
}

const MEANING = {
  P: 'permitted by right',
  C: 'allowed only with a Conditional Use Permit',
  'P/C': 'allowed, but a Conditional Use Permit may be required as the performance standards determine',
  prohibited: 'prohibited (blank in the table)',
};

/** Every table row for a use name (or its printed alias), with the district marks spelled out. */
function rowsFor(name, district = null) {
  const out = [];
  for (const t of tables.tables) {
    for (const r of t.rows) {
      if (r.use !== name && r.also !== name) continue;
      const base = {
        table: `Table ${t.section}`,
        table_title: t.title.replace(/^Uses for the /, ''),
        use: r.use,
        page: r.page,
        link: pageUrl(r.page),
        standards: r.standards,
        category_standards: r.category_standards,
        ...(r.note ? { note: r.note } : {}),
      };
      if (district) {
        if (!t.districts.includes(district)) continue;
        const mark = r.cells[district] || 'prohibited';
        out.push({ ...base, district, mark, means: MEANING[mark] });
      } else {
        out.push({ ...base, allowed: Object.fromEntries(t.districts.filter((d) => r.cells[d]).map((d) => [d, r.cells[d]])), prohibited_in: t.districts.filter((d) => !r.cells[d]) });
      }
    }
  }
  return out;
}

const HOW =
  'Say the district, the table and its page (link it), and what the mark means in plain words. P/C means a Conditional Use Permit may be required: the cited performance standards (Article 4) decide when, so read them with ordinance_lookup (section) before saying whether one is needed. A use not listed in a district\'s table is prohibited there. An overlay (PCO, STRL-O and others) can permit, prohibit or add standards on top of the base district, and Planned Development districts follow their own approved terms, so name the base district you read and say an overlay may change it. Give a row\'s note if it has one: the City\'s tables print that row inconsistently. These tables are read from the City\'s PDF, current through the date given; the PDF is the authority, and a Zoning Determination from the Department of City Planning is the binding answer for a property.';

export default definePlugin({
  name: 'zoning_uses',
  cities: ['norfolk'],
  description: `Norfolk's zoning use tables (Zoning Ordinance Tables 3.2.12 to 3.9.23, ${tables.current_through}): whether a use is permitted by right (P), needs a Conditional Use Permit (C), may need one depending on its performance standards (P/C), or is prohibited, in each zoning district. Give use, in plain words ("short-term rental", "live-work", "brewery", "day care"), and/or district, a zoning district code (for example "C-C", "MF-NS", "SF-6", "PCO-Colley"; get an address's district from the address or parcel lookup first). Both: that use in that district. Use only: every district. District only: the uses allowed there, by mark (filter with mark). Use it for "is X allowed here?" questions, then read the cited performance standards with ordinance_lookup when the mark is P/C or the question turns on conditions.`,
  parameters: {
    type: 'object',
    properties: {
      use: { type: 'string', description: 'The use, in plain words.' },
      district: { type: 'string', description: 'A zoning district code, such as "C-C" or "MF-NS".' },
      mark: { type: 'string', enum: ['P', 'C', 'P/C'], description: 'With district only: list just the uses with this mark.' },
    },
    additionalProperties: false,
  },
  async run(ctx, args = {}) {
    const about = { source: PDF, current_through: tables.current_through, cid: tables.source.cid, legend: tables.legend };
    const districtIn = String(args.district ?? '').trim().slice(0, 60);
    const district = districtIn ? districtCode(districtIn) : null;
    if (districtIn && !district) return { error: `"${districtIn}" isn't a zoning district in the use tables. Codes look like ${['SF-6', 'MF-NS', 'C-C', 'D-MU', 'I-L', 'HC-G2', 'TOD-C', 'PCO-Colley'].join(', ')}.`, districts: DISTRICTS.map((d) => `${d.code}: ${d.name}`) };
    if (district && NO_TABLE[district]) return { district, note: NO_TABLE[district], how: HOW, ...about };
    const handOff = (t, page) => ctx.resources.addRecord({ kind: 'document', title: `Norfolk Zoning Ordinance, Table ${t} (p. ${page})`, url: pageUrl(page) });
    const useIn = String(args.use ?? '').trim().slice(0, 120);
    if (useIn) {
      const names = matchUses(useIn);
      if (!names.length) return { use: useIn, matches: [], note: 'No use in the tables matches those words. A use not listed in a use table is prohibited (Section 3.1.4), but try the City\'s own name for it, or read the definitions in Article 4 with ordinance_lookup.', how: HOW, ...about };
      const all = names.map((n) => ({ name: n, rows: rowsFor(n, district) }));
      const matches = all.filter((m) => m.rows.length);
      for (const m of matches) for (const r of m.rows) handOff(r.table.replace('Table ', ''), r.page);
      // With a district: a matching use its table doesn't list is prohibited there.
      const t = district ? TABLE_OF.get(district) : null;
      const unlisted = district ? all.filter((m) => !m.rows.length).map((m) => m.name) : [];
      if (t && unlisted.length) handOff(t.section, t.pages[0]);
      return {
        use: useIn,
        ...(district ? { district } : {}),
        matches,
        ...(unlisted.length ? { not_listed: { uses: unlisted, table: `Table ${t.section}`, link: pageUrl(t.pages[0]), means: `Not listed in the table for ${district}, so prohibited there (Section 3.1.4: any use not listed in a use table is prohibited).` } } : {}),
        ...(names.length > 1 ? { note: 'Several uses match; say which you read, or ask which the person means.' } : {}),
        how: HOW,
        ...about,
      };
    }
    if (district) {
      const t = TABLE_OF.get(district);
      const by = { P: [], C: [], 'P/C': [] };
      for (const r of t.rows) if (r.cells[district]) by[r.cells[district]].push(r.use);
      const marks = args.mark ? [args.mark] : ['P', 'P/C', 'C'];
      const listed = Object.fromEntries(marks.map((m) => [m, by[m].slice(0, MAX_LIST)]));
      const cut = marks.filter((m) => by[m].length > MAX_LIST);
      handOff(t.section, t.pages[0]);
      return {
        district,
        name: DISTRICTS.find((d) => d.code === district)?.name,
        table: `Table ${t.section}`,
        pages: t.pages,
        link: pageUrl(t.pages[0]),
        counts: Object.fromEntries(Object.entries(by).map(([m, l]) => [m, l.length])),
        uses: listed,
        ...(cut.length ? { note: `Lists cut at ${MAX_LIST}: give use, or mark, to narrow.` } : {}),
        how: HOW,
        ...about,
      };
    }
    return { error: 'Give use, district, or both.' };
  },
});
