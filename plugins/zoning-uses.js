// zoning_uses: the Zoning Ordinance's use tables, as a lookup. Jason,
// 2026-11-20: "Can we make that into a tool since it's such a weird custom way
// to do zoning?" Whether a use is allowed in a district is a grid (Tables
// 3.2.12 to 3.9.23: a row per use, a column per district, P / C / P/C or
// blank), and the ordinance's text extraction drops the blank cells, so
// ordinance_lookup can't say which district a mark belongs to. The grid is
// read from the City's PDF by word position (scripts/build-use-tables.js, the
// same edition and CID as the ordinance text) and checked row by row against
// the text extraction; rows the City prints inconsistently carry a note.
//
// What it never does: call a use prohibited because no name matched. The
// tables name uses their own way ("Religious institution", "Personal service
// business"), and whether an activity is a given use is the definition's call
// (Article 4), so an unmatched or unlisted use comes back with where to look,
// and a blank comes back with its definition to check first.

import { definePlugin } from '../src/plugins.js';
import tables from '../data/documents/norfolk-zoning-use-tables.json' with { type: 'json' };

const MAX_MATCHES = 6;
const MAX_LIST = 60;
const PDF = tables.source.url;
const pageUrl = (page) => `${PDF}#page=${page}`;
const OVERLAY_TABLE = '3.9.23';

// Districts: every one Table 3.1.2 establishes, and the table (if any) with its column.
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isSubsequence = (a, b) => {
  let i = 0;
  for (const c of b) if (c === a[i]) i++;
  return i === a.length;
};
const ALL = tables.all_districts;
const TABLE_OF = new Map();
for (const t of tables.tables) for (const d of t.districts) TABLE_OF.set(d, t);
const firstPage = (t) => t.rows[0].page;

/** A district as typed ("cc", "C-C", "Community Commercial", "PCO-21st", "C-C (conditional)"): { code, conditional } or null. */
export function districtOf(input) {
  const raw = String(input ?? '').trim();
  const conditional = /\bconditional\b|\(c\)\s*$/i.test(raw);
  const q = squash(raw.replace(/\(\s*(?:conditional|c)\s*\)|\bconditional\b/gi, ''));
  if (!q) return null;
  const hit =
    ALL.find((d) => squash(d.code) === q) ||
    ALL.find((d) => squash(d.name) === q || squash(`${d.code} ${d.name}`) === q) ||
    (q.length >= 4 ? (() => {
      const loose = ALL.filter((d) => isSubsequence(q, squash(d.code)));
      return loose.length === 1 ? loose[0] : null;
    })() : null);
  return hit ? { code: hit.code, conditional } : null;
}
export const districtCode = (input) => districtOf(input)?.code ?? null;

// Everyday words for uses the tables name their own way. Each adds the table's
// name(s) as another way to read the question; the definitions still decide.
const SAYINGS = [
  [/\b(?:airbnb|vrbo|vacation rentals?|short[- ]term rentals?|str)\b/i, ['short-term rental unit']],
  [/\b(?:adu|granny flat|in-law (?:suite|apartment|unit)|backyard cottage|garage apartment|accessory apartment)\b/i, ['accessory dwelling unit']],
  [/\bduplex(?:es)?\b/i, ['dwelling two-family']],
  [/\b(?:triplex|fourplex|quadplex|apartments?|apartment building|multi-?family)\b/i, ['dwelling multi-family']],
  [/\b(?:townhouses?|townhomes?|rowhouses?|row houses?)\b/i, ['dwelling townhouse']],
  [/\b(?:single[- ]family (?:home|house)|detached house)\b/i, ['dwelling single-family detached']],
  [/\b(?:daycare|day care|child ?care|preschool)\b/i, ['day care center']],
  [/\b(?:brewery|breweries|brewpub|taproom|microbrewery|distillery|winery|cidery|craft beer)\b/i, ['production of craft beverages', 'brewery cidery distillery winery']],
  [/\b(?:bar|bars|tavern|pub|lounge)\b/i, ['sale of alcoholic beverages on-premises', 'nightclub']],
  [/\b(?:liquor store|package store|abc store|beer and wine store|wine shop)\b/i, ['sale of alcoholic beverages off-premises']],
  [/\bfood trucks?\b/i, ['vendor park food']],
  [/\b(?:church(?:es)?|temple|mosque|synagogue|chapel|place of worship)\b/i, ['religious institution']],
  [/\b(?:salon|barber(?:shop)?|barbershop|nail salon|hair|beauty|tanning)\b/i, ['personal service business']],
  [/\b(?:massage|spa)\b/i, ['therapeutic massage facility', 'personal service business']],
  [/\b(?:gym|fitness|crossfit|yoga studio)\b/i, ['health and fitness facility']],
  [/\b(?:cafe|café|coffee ?shop|coffeehouse|diner|eatery|bakery cafe)\b/i, ['restaurant']],
  [/\b(?:vet|veterinarian|animal hospital)\b/i, ['veterinary hospital or clinic']],
  [/\b(?:ev charg\w*|electric (?:car|vehicle) charg\w*|car charger)\b/i, ['electric vehicle charging station']],
  [/\b(?:car dealership|car lot|used cars?|auto dealer\w*)\b/i, ['automobile sales']],
  [/\b(?:dentist|doctor'?s? office|medical office|clinic)\b/i, ['office medical or dental']],
  [/\b(?:storage units?|self[- ]storage|mini[- ]storage)\b/i, ['self-service storage units']],
  [/\b(?:outdoor dining|patio dining|sidewalk cafe)\b/i, ['outdoor seating']],
  [/\b(?:shop|store|boutique|retail)\b/i, ['retail goods establishment']],
];
const STOP = new Set(['a', 'an', 'the', 'of', 'or', 'and', 'for', 'in', 'to', 'as', 'use', 'uses', 'is', 'are', 'can', 'i', 'my', 'allowed', 'permitted', 'open', 'run', 'have', 'build', 'put', 'zone', 'zoned', 'zoning', 'district', 'here', 'there', 'other', 'all', 'any', 'kind', 'type']);
const stem = (w) => (w.length > 4 ? w.replace(/ies$/, 'y').replace(/(?:es|s)$/, '') : w);
const wordsOf = (s) => (String(s ?? '').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []).flatMap((w) => [w, ...w.split('-')]).map(stem);
const meaningful = (s) => [...new Set(wordsOf(s).filter((w) => !STOP.has(w) && w.length > 1))];

// Names to match: each row's use, or for a row the City prints inconsistently, the name it means.
const NAMES = new Map();
for (const t of tables.tables) for (const r of t.rows) {
  const n = r.also || r.use;
  if (!NAMES.has(n)) NAMES.set(n, new Set(wordsOf(n)));
}

/** The uses whose names best hold the question's words, read plainly or through SAYINGS: { names, partial }. */
export function matchUses(query) {
  const q = String(query ?? '');
  const readings = [meaningful(q), ...SAYINGS.filter(([re]) => re.test(q)).flatMap(([, names]) => names.map(meaningful))].filter((w) => w.length);
  if (!readings.length) return { names: [], partial: false };
  const scored = [];
  const own = meaningful(q);
  const fit = (want, have) => want.filter((w) => have.has(w) || (w.length >= 4 && [...have].some((h) => h.startsWith(w)))).length / want.length;
  for (const [name, have] of NAMES) {
    const score = Math.max(...readings.map((want) => fit(want, have)));
    // The person's own words rank a name above one reached only through SAYINGS.
    if (score > 0) scored.push({ name, score, plain: own.length ? fit(own, have) : 0, size: have.size });
  }
  const best = Math.max(0, ...scored.map((s) => s.score));
  const names = scored
    .filter((s) => s.score === best || (s.score >= 0.5 && s.score > best - 0.25))
    .sort((a, b) => b.score - a.score || b.plain - a.plain || a.size - b.size || a.name.localeCompare(b.name))
    .slice(0, MAX_MATCHES)
    .map((s) => s.name);
  return { names, partial: best < 1 };
}

const BASE_MEANING = {
  P: 'permitted by right, subject to the cited performance standards',
  C: 'allowed only with a Conditional Use Permit, subject to the cited performance standards',
  'P/C': 'allowed, but a Conditional Use Permit may be required as the cited performance standards determine',
  blank: 'prohibited as this use (blank in the table): read its definition first, since a smaller or private version of an activity may not be this use at all',
};
const OVERLAY_MEANING = {
  P: 'permitted in the overlay whatever the base district allows, subject to the cited performance standards',
  C: 'allowed in the overlay only with a Conditional Use Permit',
  'P/C': 'allowed in the overlay, but a Conditional Use Permit may be required as the cited performance standards determine',
  blank: 'prohibited in the overlay whatever the base district allows (blank in the overlay table): read its definition first',
};

/** Every table row for a use name, with its marks spelled out (for one district, or all). */
function rowsFor(name, district = null) {
  const out = [];
  for (const t of tables.tables) {
    for (const r of t.rows) {
      if ((r.also || r.use) !== name) continue;
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
        const mark = r.cells[district] || 'blank';
        out.push({ ...base, district, mark: mark === 'blank' ? 'blank (prohibited)' : mark, means: (t.section === OVERLAY_TABLE ? OVERLAY_MEANING : BASE_MEANING)[mark] });
      } else {
        out.push({ ...base, ...(t.section === OVERLAY_TABLE ? { overlay: true } : {}), marked: Object.fromEntries(t.districts.filter((d) => r.cells[d]).map((d) => [d, r.cells[d]])), blank_in: t.districts.filter((d) => !r.cells[d]) });
      }
    }
  }
  return out;
}
const standardsOf = (name) => {
  for (const t of tables.tables) for (const r of t.rows) if ((r.also || r.use) === name) return r.standards;
  return null;
};

const HOW =
  'Say the district, the table and its page (link it), and what the mark means in plain words. The tables name uses their own way, and the use\'s definition in Article 4 (its standards reference, read with ordinance_lookup section) decides whether an activity is that use: read it before saying a use is prohibited, and before saying which of several matching uses applies. P/C means a Conditional Use Permit may be required: the cited performance standards decide when, so read them before saying whether one is needed. An overlay (PCO, IMU-O, STRL-O and others) can permit, prohibit or add standards on top of the base district: the PCO columns govern only the uses Table 3.9.23 lists, the base district\'s table governs the rest, and other overlays set out their changes in their own sections. Conditional zoning (proffered conditions in the rezoning ordinance) and Planned Development terms can narrow these uses. Give a row\'s note if it has one: the City\'s tables print that row inconsistently. These tables are read from the City\'s PDF, current through the date given; the PDF is the authority, and a Zoning Determination from the Department of City Planning is the binding answer for a property.';

export default definePlugin({
  name: 'zoning_uses',
  cities: ['norfolk'],
  description: `Norfolk's zoning use tables (Zoning Ordinance Tables 3.2.12 to 3.9.23, ${tables.current_through}): whether a use is permitted by right (P), needs a Conditional Use Permit (C), may need one depending on its performance standards (P/C), or is blank (prohibited as that use), in each zoning district. Give use, in plain words ("short-term rental", "live-work", "brewery", "day care", "church"), and/or district, a zoning district code (for example "C-C", "MF-NS", "SF-6", "PCO-Colley"; get an address's district and overlays from the address or parcel lookup first). Both: that use in that district. Use only: every district. District only: the uses it marks, by mark (filter with mark). Use it for "is X allowed here?" questions, then read the cited definition and performance standards with ordinance_lookup before saying a use is prohibited or whether a P/C needs a permit.`,
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
    const handOff = (section, page) => ctx.resources.addRecord({ kind: 'document', title: `Norfolk Zoning Ordinance, Table ${section} (p. ${page})`, url: pageUrl(page) });
    const districtIn = String(args.district ?? '').trim().slice(0, 60);
    const found = districtIn ? districtOf(districtIn) : null;
    if (districtIn && !found) return { error: `"${districtIn}" isn't a zoning district in Table 3.1.2.`, districts: ALL.map((d) => `${d.code}: ${d.name}`), how: HOW, ...about };
    const district = found?.code ?? null;
    const conditional = found?.conditional ? { conditional_zoning: 'Conditional zoning: the rezoning ordinance\'s proffered conditions can narrow or add to what this table allows. Find it with find_legislation.' } : {};
    // A district with no column: say what governs it instead.
    if (district && !TABLE_OF.has(district)) {
      const d = ALL.find((x) => x.code === district);
      const overlay = /^3\.9\./.test(d.section || '');
      return {
        district,
        name: d.name,
        no_use_table: true,
        ...(d.section ? { section: d.section } : {}),
        note: district === 'PD'
          ? 'Planned Development districts follow their own approved PD master plan and terms and conditions (Section 2.4.5 and 3.8), not a use table.'
          : overlay
            ? `An overlay with no column in the use tables: the base district's table governs, and this overlay's own section (${d.section}) sets out what it changes. Read it with ordinance_lookup, and call again with the base district.`
            : `No column in the use tables for this district; its own section (${d.section}) sets out its uses. Read it with ordinance_lookup.`,
        ...conditional,
        how: HOW,
        ...about,
      };
    }
    const useIn = String(args.use ?? '').trim().slice(0, 120);
    if (useIn) {
      const { names, partial } = matchUses(useIn);
      if (!names.length) {
        return {
          use: useIn,
          ...(district ? { district } : {}),
          matches: [],
          note: 'No use in the tables is named with those words. The tables name uses their own way (a church is a "Religious institution", a salon a "Personal service business"): call again with the district alone to see its uses, or search the definitions in Article 4 with ordinance_lookup. Don\'t call the use prohibited until you know which use it is.',
          ...conditional,
          how: HOW,
          ...about,
        };
      }
      const all = names.map((n) => ({ name: n, rows: rowsFor(n, district) }));
      const matches = all.filter((m) => m.rows.length);
      for (const m of matches) for (const r of m.rows) handOff(r.table.replace('Table ', ''), r.page);
      const t = district ? TABLE_OF.get(district) : null;
      const unlisted = district ? all.filter((m) => !m.rows.length).map((m) => ({ use: m.name, standards: standardsOf(m.name) })) : [];
      if (t && unlisted.length) handOff(t.section, firstPage(t));
      const notListed = !unlisted.length
        ? {}
        : t.section === OVERLAY_TABLE
          ? { not_listed: { uses: unlisted, table: `Table ${t.section}`, link: pageUrl(firstPage(t)), means: `Table ${t.section} doesn't list these, so the ${district} overlay doesn't change them: the base district's table governs. Call again with the base district.` } }
          : { not_listed: { uses: unlisted, table: `Table ${t.section}`, link: pageUrl(firstPage(t)), means: `Not listed in the table for ${district}. A use a district's table doesn't list is prohibited there (Section 3.1.4), but first read the use's definition (its standards reference): the activity may fall under another use that is listed, or not be this use at all.` } };
      return {
        use: useIn,
        ...(district ? { district } : {}),
        matches,
        ...notListed,
        ...(partial ? { partial: 'No use name holds all of those words; these hold some of them. Check whether any of them is what the person means (read the definitions) before answering from them.' } : names.length > 1 ? { note: 'Several uses match: read their definitions to say which applies, or ask what the person means.' } : {}),
        ...conditional,
        how: HOW,
        ...about,
      };
    }
    if (district) {
      const t = TABLE_OF.get(district);
      const by = { P: [], C: [], 'P/C': [] };
      for (const r of t.rows) if (r.cells[district]) by[r.cells[district]].push(r.use);
      const marks = args.mark ? [args.mark] : ['P', 'P/C', 'C'];
      const cut = marks.filter((m) => by[m].length > MAX_LIST);
      handOff(t.section, firstPage(t));
      return {
        district,
        name: ALL.find((d) => d.code === district)?.name,
        table: `Table ${t.section}`,
        pages: [firstPage(t), t.rows.at(-1).page],
        link: pageUrl(firstPage(t)),
        ...(t.section === OVERLAY_TABLE ? { overlay: 'An overlay: these marks govern only the uses Table 3.9.23 lists; the base district\'s table governs the rest.' } : {}),
        counts: Object.fromEntries(Object.entries(by).map(([m, l]) => [m, l.length])),
        uses: Object.fromEntries(marks.map((m) => [m, by[m].slice(0, MAX_LIST)])),
        ...(cut.length ? { note: `Lists cut at ${MAX_LIST}: give use, or mark, to narrow.` } : {}),
        ...conditional,
        how: HOW,
        ...about,
      };
    }
    return { error: 'Give use, district, or both.' };
  },
});
