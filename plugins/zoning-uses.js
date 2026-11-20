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

const MAX_MATCHES = 8;
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

/**
 * A district as typed ("cc", "C-C", "Community Commercial", "PCO-21st", "PCO
 * Colley Ave", "C-C (conditional)"): { code, conditional }, { ambiguous:
 * [codes], conditional } when a name is shared (the three Ghent HC districts),
 * or null.
 */
export function districtOf(input) {
  const raw = String(input ?? '').trim();
  const conditional = /\bconditional\b|\(c\)\s*$/i.test(raw);
  const bare = raw.replace(/\(\s*(?:conditional|c)\s*\)|\bconditional\b/gi, '');
  const q = squash(bare);
  if (!q) return null;
  // Names as the parcel lookup gives them ("Colley Avenue Pedestrian Commercial Overlay"): the same words in any order.
  const tokens = (x) => [...new Set(String(x).toLowerCase().match(/[a-z0-9]+/g) || [])].filter((w) => !['overlay', 'district', 'the', 'and', 'of'].includes(w)).sort().join(' ');
  const t = tokens(bare);
  const one = (list) => (list.length === 1 ? { code: list[0].code, conditional } : list.length > 1 ? { ambiguous: list.map((d) => d.code), conditional } : null);
  const exact = ALL.find((d) => squash(d.code) === q);
  if (exact) return { code: exact.code, conditional };
  const named = one(ALL.filter((d) => squash(d.name) === q || squash(`${d.code} ${d.name}`) === q)) || (t.split(' ').length >= 2 ? one(ALL.filter((d) => tokens(d.name) === t)) : null);
  if (named) return named;
  // A code and a word after it: "SF-6 district", or a street word after a longer code ("PCO Colley Ave").
  const prefixed = ALL.filter((d) => {
    const c = squash(d.code);
    const rest = q.slice(c.length);
    return q.length > c.length && q.startsWith(c) && (/^(?:district|zone|zoned|zoning|overlay)+$/.test(rest) || (c.length >= 4 && /^(?:ave|avenue|st|street|rd|road|blvd|boulevard|overlay|district|corridor)+$/.test(rest)));
  }).sort((a, b) => squash(b.code).length - squash(a.code).length);
  if (prefixed.length) return { code: prefixed[0].code, conditional };
  // Shorthand for one code ("PCO-21st", "pco colley"): only when it starts as the code does, so a
  // neighborhood's name ("Riverview", "Lafayette") or a stray word never becomes an overlay.
  if (q.length >= 4) {
    const loose = ALL.filter((d) => {
      const lead = squash(d.code.split('-')[0]);
      return lead.length >= 2 && q.startsWith(lead) && isSubsequence(q, squash(d.code));
    });
    if (loose.length === 1) return { code: loose[0].code, conditional };
  }
  return null;
}
export const districtCode = (input) => districtOf(input)?.code ?? null;

// Everyday words for uses the tables name their own way. Each adds the table's
// name(s) as another way to read the question, in the order given (the likelier
// first); the definitions still decide. The words a saying matched, and the
// words of a name it reached, count as explained.
const SAYINGS = [
  [/\b(?:airbnbs?|vrbos?|vacation rentals?|short[- ]term rentals?|str)\b/, ['short-term rental unit']],
  [/\b(?:apartments? (?:in|over|above|behind|under) (?:my|our|the|a) (?:house|home|garage)|basement apartments?|adus?|granny flats?|in-law (?:suites?|apartments?|units?)|backyard cottages?|garage apartments?|accessory apartments?)\b/, ['accessory dwelling unit']],
  [/\bduplex(?:es)?\b/, ['dwelling two-family']],
  [/\b(?:triplex(?:es)?|fourplex(?:es)?|quadplex(?:es)?|apartments?|apartment buildings?|multi-?family)\b/, ['dwelling multi-family']],
  [/\b(?:townhouses?|townhomes?|rowhouses?|row houses?)\b/, ['dwelling townhouse']],
  [/\b(?:single[- ]family (?:homes?|houses?)|detached houses?)\b/, ['Dwelling, single-family detached']],
  [/\b(?:boarding ?houses?|rooming ?houses?|single[- ]room occupancy)\b/, ['rooming house']],
  [/\b(?:home daycares?|in-home daycares?|in-home day cares?|home day cares?|family daycares?|family day cares?)\b/, ['family day home']],
  [/\b(?:daycares?|day cares?|child ?care|preschools?)\b/, ['day care center child', 'family day home']],
  [/\b(?:brewery|breweries|brewpubs?|taprooms?|microbrewer(?:y|ies)|distiller(?:y|ies)|winer(?:y|ies)|ciderys?|cideries|craft beer)\b/, ['production of craft beverages', 'brewery cidery distillery winery']],
  [/\b(?:liquor stores?|package stores?|abc stores?|beer and wine stores?|beer (?:stores?|shops?)|wine (?:stores?|shops?)|bottle shops?)\b/, ['establishment for the sale of distilled spirits for off-premises consumption', 'sale of alcoholic beverages off-premises']],
  [/\b(?:pawn ?shops?|pawnbrokers?)\b/, ['pawnshop']],
  [/\b(?:thrift (?:stores?|shops?)|secondhand|second-hand|used goods|resale shops?|used (?:clothing|clothes)|vintage (?:clothing|clothes|stores?|shops?))\b/, ['used merchandise sales', 'consignment shop']],
  [/\b(?:used (?:book ?stores?|book ?shops?|books|records|cds|dvds|media))\b/, ['used books media']],
  [/\b(?:book ?stores?|book ?shops?)\b/, ['retail goods establishment', 'used books media']],
  [/\bfood trucks?\b/, ['vendor park food']],
  [/\b(?:art galler(?:y|ies)|galler(?:y|ies)|art studios?|artist studios?)\b/, ['artist studio school gallery']],
  [/\b(?:baker(?:y|ies))\b/, ['retail goods establishment', 'restaurant', 'artisanal production']],
  [/\b(?:wine bars?|cocktail bars?|sports bars?|beer gardens?|beer halls?|brew ?pubs?)\b/, ['sale of alcoholic beverages on-premises', 'restaurant']],
  [/\b(?:church(?:es)?|temples?|mosques?|synagogues?|chapels?|places? of worship)\b/, ['religious institution']],
  [/\b(?:salons?|barber(?:shop)?s?|barbershops?|nail salons?|hair|beauty|tanning|laundromats?|tailors?|clothing alterations|shoe repair)\b/, ['personal service business']],
  [/\b(?:dry clean(?:ers?|ing))\b/, ['personal service business', 'laundry and dry cleaning plant']],
  [/\bmassages?\b/, ['therapeutic massage facility']],
  [/\bspas?\b/, ['personal service business', 'therapeutic massage facility']],
  [/\b(?:gyms?|fitness|crossfit|yoga studios?)\b/, ['health and fitness facility']],
  [/\b(?:cafes?|coffee ?shops?|coffee ?houses?|coffeehouses?|diners?|eater(?:y|ies)|juice bars?|smoothies?|bakery cafes?)\b/, ['restaurant']],
  [/\b(?:vets?|veterinarians?|animal hospitals?)\b/, ['veterinary hospital or clinic']],
  [/\b(?:ev charg\w*|electric (?:car|vehicle) charg\w*|car chargers?)\b/, ['electric vehicle charging station']],
  [/\b(?:used car lots?|car dealerships?|car lots?|used cars?|auto dealer\w*|(?:auto|car|vehicle|automobile) sales)\b/, ['automobile sales']],
  [/\b(?:vehicle repair|vehicle maintenance)\b/, ['automobile repair and maintenance', 'commercial vehicle repair and maintenance']],
  [/\b(?:car|vehicle|auto) storage\b/, ['automobile storage']],
  [/\bretail (?:sales|stores?|shops?|space|business(?:es)?)\b/, ['retail goods establishment']],
  [/\b(?:auto (?:repair|mechanics?|body)|car repair|mechanics?|body shops?|collision (?:repair|centers?))\b/, ['automobile repair and maintenance']],
  [/\b(?:dentists?|doctor'?s? offices?|medical offices?|clinics?)\b/, ['office medical or dental']],
  [/\b(?:storage units?|self[- ]storage|mini[- ]storage)\b/, ['self-service storage units']],
  [/\b(?:outdoor (?:dining|seating)|patio (?:dining|seating)|sidewalk (?:cafes?|dining|seating))\b/, ['outdoor seating']],
  [/\b(?:home[- ](?:based|bakery|bakeries|kitchen|salon|studio|gym|offices?|business(?:es)?)|work from home|(?:in|at|out of|from) (?:my|our|the|a) (?:home|house)|cottage food)\b/, ['home occupation']],
  [/\b(?:(?:cannabis|marijuana|weed|pot) (?:shops?|stores?|dispensar(?:y|ies))|dispensar(?:y|ies))\b/, ['cannabis dispensing facility']],
  [/\b(?:cannabis|marijuana)\b/, ['cannabis dispensing facility', 'cannabis cultivation or manufacturing facility']],
  [/\b(?:sex shops?|adult (?:stores?|shops?|book ?stores?|theat(?:er|re)s?|novelty|video stores?))\b/, ['novelty store or theater adult']],
  [/\b(?:smoke shops?|vape (?:shops?|stores?)|head shops?|tobacco (?:shops?|stores?)|tobacconists?|cigar (?:shops?|stores?))\b/, ['smoke or vape shop', 'sale of smoking or vaping products']],
  [/\b(?:vapes?|vaping|tobacco|cigarettes?|cigars?|hookah)\b/, ['sale of smoking or vaping products', 'smoke or vape shop']],
  [/\b(?:tattoo(?:s|ing)?(?: (?:shops?|studios?|parlou?rs?|artists?))?|piercing (?:shops?|studios?))\b/, ['tattoo parlor']],
  [/\b(?:live music|concerts?|live (?:bands?|shows?|performances?)|music venues?|comedy clubs?)\b/, ['live entertainment']],
  [/\b(?:dance clubs?|night ?clubs?|discos?)\b/, ['nightclub']],
  [/\b(?:movie theat(?:er|re)s?|movie houses?|cinemas?|movies)\b/, ['cinema or theater']],
  [/\b(?:event (?:venues?|spaces?|halls?)|wedding venues?|reception halls?)\b/, ['banquet hall']],
];
// Words that name a kind of place, not a use. Shop, store and the like count as
// explained beside an explained word ("tattoo shop"); a drink or club word adds
// its own names beside one ("restaurant and bar" is also on-premises sales).
// Alone, either reads only through its generic names.
const GENERIC = [
  [/\b(?:bars?|taverns?|pubs?|lounges?)\b/, ['sale of alcoholic beverages on-premises', 'restaurant', 'nightclub']],
  [/\b(?:shops?|stores?|boutiques?|retail)\b/, ['retail goods establishment']],
  [/\bclubs?\b/, ['nightclub', 'membership organization']],
];
const ABSORB = new Set(['shop', 'store', 'boutique', 'retail', 'business', 'place', 'spot', 'venue', 'building', 'property', 'space']);
const ADDING = new Set(['bar', 'pub', 'tavern', 'lounge', 'club']);
// Names that list alternatives ("Hotel or motel"): each phrase here names the
// use by itself, so asking "museum" is asking for "Cultural facility, museum,
// or library". Any other name is the use asked for only when every word of it
// was asked (FILLER words aside).
const ALTERNATIVES = new Map(Object.entries({
  'Arboretum or botanical garden': ['arboretum', 'botanical garden'],
  'Arena, stadium, or amphitheater': ['arena', 'stadium', 'amphitheater'],
  'Artist studio/school/gallery': ['artist studio', 'art studio', 'artist school', 'art school', 'art gallery', 'gallery'],
  'Automobile salvage yard, indoor or outdoor': ['automobile salvage yard', 'auto salvage yard', 'salvage yard'],
  'Bank or other financial institution': ['bank', 'financial institution', 'credit union'],
  'Boat sales, rental, service, or repair': ['boat sale', 'boat rental', 'boat service', 'boat repair'],
  'Brewery, cidery, distillery, or winery': ['brewery', 'cidery', 'distillery', 'winery'],
  'Cannabis cultivation or manufacturing facility': ['cannabis cultivation', 'cannabis manufacturing'],
  'Catering establishment/commercial kitchen': ['catering', 'commercial kitchen'],
  'Check cashing, auto title, or payday loan businesses': ['check cashing', 'title loan', 'payday loan'],
  'Cinema or theater': ['cinema', 'theater'],
  'College or university': ['college', 'university'],
  'Conference or training center': ['conference center', 'training center'],
  'Construction-related office/yard': ['construction office', 'construction yard'],
  'Cultural facility, museum, or library': ['cultural facility', 'museum', 'library'],
  'Fraternity or sorority house': ['fraternity', 'sorority'],
  'Fuel oil or bottled gas distribution': ['fuel oil distribution', 'bottled gas distribution'],
  'Funeral home or mortuary': ['funeral home', 'mortuary'],
  'Garage or yard sale': ['garage sale', 'yard sale'],
  'Hazardous materials manufacturing or storage': ['hazardous materials manufacturing', 'hazardous materials storage'],
  'Hotel or motel': ['hotel', 'motel'],
  'Manufacturing, assembly or fabrication, heavy': ['heavy manufacturing', 'heavy assembly', 'heavy fabrication'],
  'Manufacturing, assembly or fabrication, light': ['light manufacturing', 'light assembly', 'light fabrication'],
  'Music, dance, or martial arts studio/school': ['music studio', 'music school', 'dance studio', 'dance school', 'martial arts studio', 'martial arts school'],
  'Novelty store or theater, adult': ['adult novelty store', 'adult theater'],
  'Office, medical or dental': ['medical office', 'dental office'],
  'Smoke or vape shop': ['smoke shop', 'vape shop'],
  'Taxi or limousine service facilities': ['taxi service', 'limousine service'],
  'Used books/media': ['used books', 'used media'],
  'Vendor or produce stand': ['vendor stand', 'produce stand'],
  'Veterinary hospital or clinic': ['veterinary hospital', 'veterinary clinic'],
}));
// Words a name carries for its category: "multi-family" names "Dwelling, multi-family".
const FILLER = new Set(['facility', 'establishment', 'use', 'business', 'dwelling']);
const STOP = new Set(['a', 'an', 'the', 'of', 'or', 'and', 'for', 'in', 'to', 'as', 'at', 'on', 'by', 'with', 'near', 'into', 'from', 'about', 'use', 'uses', 'is', 'are', 'be', 'can', 'could', 'would', 'should', 'do', 'does', 'i', 'we', 'me', 'my', 'our', 'you', 'your', 'it', 'this', 'that', 'what', 'where', 'how', 'allowed', 'permitted', 'open', 'opening', 'run', 'running', 'operate', 'operating', 'start', 'starting', 'have', 'build', 'put', 'want', 'like', 'new', 'sell', 'sells', 'selling', 'zone', 'zoned', 'zoning', 'district', 'here', 'there', 'other', 'all', 'any', 'kind', 'type', 'some']);
const plain = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const stem = (w) => {
  if (w.length <= 3 || /(?:ss|us|is)$/.test(w)) return w;
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(?:sh|ch|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith('s') ? w.slice(0, -1) : w;
};
const wordsOf = (s) => (plain(s).match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []).flatMap((w) => [w, ...(w.includes('-') ? w.split('-') : [])]).map(stem);
const meaningful = (s) => [...new Set(wordsOf(s).filter((w) => !STOP.has(w) && w.length > 1))];
// Without hyphenated compounds, whose parts stand on their own ("single-family": single, family).
const core = (words) => [...words].filter((w) => !w.includes('-'));

// Names to match: each row's use, or for a row the City prints inconsistently, the name it means.
const NAMES = new Map();
for (const t of tables.tables) for (const r of t.rows) {
  const n = r.also || r.use;
  if (!NAMES.has(n)) NAMES.set(n, new Set(meaningful(n)));
}

// How common each word is among use names, so "tattoo" outweighs "shop".
const DF = new Map();
for (const have of NAMES.values()) for (const w of have) DF.set(w, (DF.get(w) || 0) + 1);
// A word matches a name's word whole, or as its start when five letters or more ("cannab" never, "brewer" for "brewery").
const hit = (w, have) => have.has(w) || (w.length >= 5 && [...have].some((h) => h.startsWith(w)));
const coveredBy = (w, asked) => asked.some((a) => a === w || (a.length >= 5 && w.startsWith(a)));
const weight = (w) => {
  let df = DF.get(w) || 0;
  if (!df && w.length >= 5) for (const [h, n] of DF) if (h.startsWith(w)) df += n;
  return 1 / Math.max(1, df);
};
const full = (want, have) => want.length > 0 && want.every((w) => hit(w, have));
const weighted = (want, have) => {
  const total = want.reduce((n, w) => n + weight(w), 0);
  return total ? want.filter((w) => hit(w, have)).reduce((n, w) => n + weight(w), 0) / total : 0;
};
/** Whether the words asked name this use: every word of it asked (FILLER aside), or every word of one of its alternatives. */
function named(name, asked) {
  const need = (words) => {
    const w = core(words).filter((x) => !FILLER.has(x));
    return w.length > 0 && w.every((x) => coveredBy(x, asked));
  };
  return need(NAMES.get(name)) || (ALTERNATIVES.get(name) || []).some((alt) => need(meaningful(alt)));
}

/**
 * The uses the question names: { names, related, partial, via, unexplained, more }.
 * A name is a match when the words asked name it (named(): all its words, or
 * one of its alternatives), or a specific everyday word reaches it (SAYINGS;
 * listed in via, since the definition decides). A name that holds every word
 * asked but has more of its own ("auto sales" in "Auto supply sales and
 * rental") isn't the use asked for: it comes back in related, with no marks.
 * The question's exact table name returns that use alone. Every word asked
 * must be explained by a match; if any isn't, the match is partial
 * (unexplained: the words no candidate holds) and the candidates come back to
 * be confirmed, never with marks.
 */
export function matchUses(query) {
  const q = plain(query);
  const own = meaningful(q);
  const asked = core(own);
  const ownSet = new Set(asked);
  // The table's own name, asked exactly: that use alone.
  const exact = [...NAMES].filter(([, have]) => { const w = core(have); return w.length === ownSet.size && w.every((x) => ownSet.has(x)); }).map(([name]) => name);
  if (exact.length) return { names: exact, related: [], partial: false, via: [], unexplained: [], more: 0 };
  const explained = new Set();
  const spanned = new Set();
  const chosen = new Map();
  const choose = (name, x) => {
    const was = chosen.get(name);
    if (!was || x.cover > was.cover || (x.cover === was.cover && x.rank < was.rank)) chosen.set(name, x);
  };
  // A saying whose every match lies inside a longer saying's ("apartment" in
  // "apartment in my house") gives way to it.
  const found = SAYINGS.map(([re]) => [...q.matchAll(new RegExp(re.source, 'g'))].map((m) => [m.index, m.index + m[0].length]));
  const inside = ([a, b], [c, d]) => c <= a && b <= d && d - c > b - a;
  const sayingTargets = new Set();
  SAYINGS.forEach(([re, targets], i) => {
    const spans = [...q.matchAll(new RegExp(re.source, 'g'))];
    if (!spans.length) return;
    if (found[i].every((sp) => found.some((other, k) => k !== i && other.some((o) => inside(sp, o))))) return;
    const words = new Set(spans.flatMap((m) => core(meaningful(m[0]))));
    for (const w of words) { explained.add(w); spanned.add(w); }
    targets.forEach((target, j) => {
      // A target spelled as the table spells a name reaches that name alone.
      const want = meaningful(target);
      for (const [name, have] of NAMES) {
        if (NAMES.has(target) ? name !== target : !full(want, have)) continue;
        // The words of a name a saying reached count too ("daycare center").
        for (const w of asked) if (hit(w, have)) explained.add(w);
        sayingTargets.add(name);
        choose(name, { name, own: false, cover: words.size, rank: 1 + i * 0.01 + j * 0.0001, score: weighted(own, have), size: have.size });
      }
    });
  });
  const weakOnly = asked.length > 0 && asked.every((w) => ABSORB.has(w) || ADDING.has(w));
  const related = [];
  for (const [name, have] of weakOnly ? [] : NAMES) {
    if (named(name, asked)) {
      const hits = asked.filter((w) => hit(w, have));
      // A name whose words all fall inside an everyday phrase that reads otherwise ("office" in "home office") is related, not the use asked.
      if (hits.every((w) => spanned.has(w)) && !sayingTargets.has(name)) {
        related.push(name);
        continue;
      }
      for (const w of hits) explained.add(w);
      choose(name, { name, own: true, cover: hits.length, rank: 0, score: weighted(own, have), size: have.size });
    } else if (full(asked, have)) related.push(name);
  }
  // Generic words: alone, through their generic names; a drink or club word beside an explained one adds its names.
  const genericNames = (pick) => GENERIC.forEach(([re, targets], i) => {
    if (!pick(re)) return;
    targets.forEach((target, j) => {
      const want = meaningful(target);
      for (const [name, have] of NAMES) if (full(want, have)) choose(name, { name, own: false, cover: 1, rank: 2 + i * 0.01 + j * 0.0001, score: 0, size: have.size });
    });
  });
  if (weakOnly && !chosen.size) {
    genericNames((re) => re.test(q));
    if (chosen.size) for (const w of asked) explained.add(w);
  } else if (asked.some((w) => explained.has(w) && !ABSORB.has(w) && !ADDING.has(w))) {
    for (const w of asked) if (ABSORB.has(w)) explained.add(w);
    const adding = asked.filter((w) => ADDING.has(w) && !spanned.has(w));
    if (adding.length) {
      genericNames((re) => adding.some((w) => re.test(w)));
      for (const w of adding) explained.add(w);
    }
  }
  const unexplained = asked.filter((w) => !explained.has(w));
  const partial = unexplained.length > 0 || !chosen.size;
  if (partial) {
    // Candidates by the rarity of the words they share, beside anything already chosen.
    for (const name of related) choose(name, { name, own: false, cover: 0, rank: 3, score: weighted(own, NAMES.get(name)), size: NAMES.get(name).size });
    const scored = [...NAMES].map(([name, have]) => ({ name, own: false, cover: 0, rank: 3, score: weighted(own, have), size: have.size })).filter((x) => x.score > 0);
    const best = Math.max(0, ...scored.map((x) => x.score));
    if (best >= 0.34) for (const x of scored) if (x.score > best - 0.2) choose(x.name, x);
  }
  const sorted = [...chosen.values()].sort((a, b) => b.cover - a.cover || a.rank - b.rank || b.score - a.score || a.size - b.size || a.name.localeCompare(b.name));
  const names = sorted.slice(0, MAX_MATCHES);
  const unheld = partial ? unexplained.filter((w) => !names.some((x) => hit(w, NAMES.get(x.name)))) : [];
  return {
    names: names.map((x) => x.name),
    related: partial ? [] : related.filter((n) => !chosen.has(n)).slice(0, MAX_MATCHES),
    partial: partial && names.length > 0,
    via: partial ? [] : names.filter((x) => !x.own).map((x) => x.name),
    unexplained: unheld,
    more: Math.max(0, sorted.length - MAX_MATCHES),
  };
}

const BASE_MEANING = {
  P: 'permitted by right, subject to the cited performance standards',
  C: 'allowed only with a Conditional Use Permit, subject to the cited performance standards',
  'P/C': 'allowed, but a Conditional Use Permit may be required as the cited performance standards determine',
  blank: 'prohibited as this use (blank in the table). Whether the activity asked about is this use is its definition\'s call (Article 4): read it before answering',
};
const OVERLAY_MEANING = {
  P: 'permitted in the overlay whatever the base district allows, subject to the cited performance standards',
  C: 'allowed in the overlay only with a Conditional Use Permit',
  'P/C': 'allowed in the overlay, but a Conditional Use Permit may be required as the cited performance standards determine',
  blank: 'prohibited in the overlay whatever the base district allows (blank in the overlay table; Section 3.9.3: the overlay controls). Whether the activity is this use is its definition\'s call',
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
        classification: r.classification,
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
        out.push({ ...base, ...(t.section === OVERLAY_TABLE ? { overlay: 'PCO overlay columns: they control over the base district (Section 3.9.3); blank means prohibited in the overlay' } : {}), marked: Object.fromEntries(t.districts.filter((d) => r.cells[d]).map((d) => [d, r.cells[d]])), blank_in: t.districts.filter((d) => !r.cells[d]) });
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
  'Say the district, the table and its page (link it), and what the mark means in plain words. The tables name uses their own way, and the use\'s definition in Article 4 (its standards reference, read with ordinance_lookup section) decides whether an activity is that use: read it before saying a use is prohibited, and before saying which of several matching uses applies. P/C means a Conditional Use Permit may be required: the cited performance standards decide when, so read them before saying whether one is needed. An overlay (PCO, IMU-O, STRL-O and others) can permit, prohibit or add standards on top of the base district, and the overlay controls where they conflict (Section 3.9.3). For a parcel in a PCO overlay, its PCO column decides, and a use Table 3.9.23 doesn\'t list is prohibited there (the table marks every other use not permitted), so check the parcel\'s overlays and call again with its PCO district. Other overlays set out their changes in their own sections. Conditional zoning (proffered conditions in the rezoning ordinance) and Planned Development terms can narrow these uses. A partial result has candidates and no marks: confirm which use is meant (the definition, or the person) and call again with its name before answering. A row\'s classification says whether it is the principal use or an accessory one. Give a row\'s note if it has one: the City\'s tables print that row inconsistently. These tables are read from the City\'s PDF, current through the date given; the PDF is the authority, and a Zoning Determination from the Department of City Planning is the binding answer for a property.';

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
    if (found?.ambiguous) return { error: `"${districtIn}" names more than one district (${found.ambiguous.join(', ')}). Call again with the parcel's code.`, districts: found.ambiguous.map((c) => `${c}: ${ALL.find((d) => d.code === c).name}`), how: HOW, ...about };
    const district = found?.code ?? null;
    const conditional = found?.conditional ? { conditional_zoning: 'Conditional zoning: the rezoning ordinance\'s proffered conditions can narrow or add to what this table allows. Find it with find_legislation.' } : {};
    // A district with no column: say what governs it instead.
    if (district && !TABLE_OF.has(district)) {
      const d = ALL.find((x) => x.code === district);
      const overlay = /^3\.9\./.test(d.section || '');
      const parts = ALL.filter((x) => x.code.startsWith(`${district}-`) && TABLE_OF.has(x.code)).map((x) => x.code);
      return {
        district,
        name: d.name,
        no_use_table: true,
        ...(d.section ? { section: d.section } : {}),
        ...(parts.length ? { columns: parts } : {}),
        note: parts.length
          ? `${district} is set out in Section ${d.section}; its districts have their own columns (${parts.join(', ')}). Call again with the one the parcel is in.`
          : district === 'PD'
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
      const { names, related, partial, via, unexplained, more } = matchUses(useIn);
      const cut = more ? { more: `${more} more use${more === 1 ? '' : 's'} hold these words: narrow the words to see them.` } : {};
      // Words no use name or everyday word accounts for: candidates to confirm, never marks.
      if (partial) {
        return {
          use: useIn,
          ...(district ? { district } : {}),
          matches: [],
          candidates: names.map((n) => ({ use: n, standards: standardsOf(n), in_tables: tables.tables.filter((x) => x.rows.some((r) => (r.also || r.use) === n)).map((x) => `Table ${x.section}`) })),
          unexplained,
          ...cut,
          partial: `${unexplained.length ? `None of these uses holds "${unexplained.join('", "')}".` : 'No one use accounts for every word asked.'} These are candidates only, with no marks: read their definitions (the standards reference, with ordinance_lookup) or ask the person which one they mean, then call again with that use's name. Don't answer from a candidate, and don't call anything allowed or prohibited from this.`,
          ...conditional,
          how: HOW,
          ...about,
        };
      }
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
            ? { not_listed: { uses: unlisted, table: `Table ${t.section}`, link: pageUrl(firstPage(t)), means: `Not listed in Table ${t.section}, which marks every use it doesn't list not permitted ("All other uses, not permitted", or a whole category "Not permitted"), so prohibited in the ${district} overlay whatever the base district allows (Section 3.9.3: the overlay controls). Whether the activity is this use is its definition's call.` } }
            : { not_listed: { uses: unlisted, table: `Table ${t.section}`, link: pageUrl(firstPage(t)), means: `Not listed in the table for ${district}. A use a district's table doesn't list is prohibited there (Section 3.1.4), but first read the use's definition (its standards reference): the activity may fall under another use that is listed, or not be this use at all.` } };
      // Use only: the tables that don't list the use at all.
      const absent = !district ? all.filter((m) => m.rows.length).map((m) => ({ use: m.name, not_in: tables.tables.filter((x) => !m.rows.some((r) => r.table === `Table ${x.section}`)).map((x) => `Table ${x.section}`) })).filter((x) => x.not_in.length) : [];
      return {
        use: useIn,
        ...(district ? { district } : {}),
        matches,
        ...notListed,
        ...(absent.length ? { not_in_tables: { uses: absent, means: 'Not listed in these tables, so not allowed as this use in their districts (a PCO overlay marks unlisted uses not permitted); whether an activity is this use is its definition\'s call.' } } : {}),
        ...(names.length > 1 ? { note: 'Several uses match: read their definitions to say which applies, or ask what the person means.' } : {}),
        ...(related.length ? { related: { uses: related, note: 'These names hold the words asked but name a narrower or different use, so they aren\'t answered here. If the person means one, call again with its name.' } } : {}),
        ...cut,
        ...(via.length ? { via: { uses: via, note: 'Matched through an everyday word, not the table\'s own name: read the definition to confirm the activity is this use (a vendor park is a site for several food vendors, for example).' } } : {}),
        ...conditional,
        how: HOW,
        ...about,
      };
    }
    if (district) {
      const t = TABLE_OF.get(district);
      const by = { P: [], C: [], 'P/C': [] };
      for (const r of t.rows) if (r.cells[district]) by[r.cells[district]].push(r.use);
      if (args.mark && !(args.mark in by)) return { error: 'mark is one of P, C or P/C.' };
      const marks = args.mark ? [args.mark] : ['P', 'P/C', 'C'];
      const cut = marks.filter((m) => by[m].length > MAX_LIST);
      handOff(t.section, firstPage(t));
      return {
        district,
        name: ALL.find((d) => d.code === district)?.name,
        table: `Table ${t.section}`,
        pages: [firstPage(t), t.rows.at(-1).page],
        link: pageUrl(firstPage(t)),
        ...(t.section === OVERLAY_TABLE ? { overlay: 'A PCO overlay: its column controls over the base district (Section 3.9.3), and a use Table 3.9.23 doesn\'t list is not permitted in it.' } : {}),
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
