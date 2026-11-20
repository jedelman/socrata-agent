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
  const conditional = /\bconditional\b|\(\s*c\s*\)/i.test(raw);
  // "the C-C district", "zoned C-C", "(C) C-C": the code with its framing words off.
  const bare = raw.replace(/\(\s*(?:conditional|c)\s*\)|\bconditional\b/gi, '').replace(/^\s*(?:the|zoned|zone|zoning)\s+/i, '').replace(/\s+(?:district|zone|zoning)\s*$/i, '');
  const q = squash(bare);
  if (!q) return null;
  // Names as the parcel lookup gives them ("Colley Avenue Pedestrian Commercial Overlay"): the same words in any order.
  const tokens = (x) => [...new Set(String(x).toLowerCase().match(/[a-z0-9]+/g) || [])].filter((w) => !['overlay', 'district', 'the', 'and', 'of'].includes(w)).sort().join(' ');
  const t = tokens(bare);
  const one = (list) => (list.length === 1 ? { code: list[0].code, conditional } : list.length > 1 ? { ambiguous: list.map((d) => d.code), conditional } : null);
  const exact = ALL.find((d) => squash(d.code) === q);
  if (exact) return { code: exact.code, conditional };
  // Its name's words, all of them in any order, or (three words or more) enough of them for one district ("Lafayette Pedestrian Commercial Overlay").
  const nameWords = (d) => new Set(tokens(d.name).split(' '));
  const named = one(ALL.filter((d) => squash(d.name) === q || squash(`${d.code} ${d.name}`) === q)) || (t.split(' ').length >= 2 ? one(ALL.filter((d) => tokens(d.name) === t)) : null) || (t.split(' ').length >= 3 ? one(ALL.filter((d) => t.split(' ').every((w) => nameWords(d).has(w)))) : null);
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
      // Numbers whole: "PCO-3" is no district, not PCO-35th Street.
      const nums = squash(d.code).match(/\d+/g) || [];
      return lead.length >= 2 && q.startsWith(lead) && isSubsequence(q, squash(d.code)) && (q.match(/\d+/g) || []).every((n) => nums.includes(n));
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
  [/\b(?:(?:apartments?|units?|cottages?|suites?|studios?) (?:in|over|above|behind|under|on|to) (?:my|our|the|a) (?:house|home|garage|basement|back ?yard|yard|property|lot)|basement apartments?|adus?|granny flats?|in-law (?:suites?|apartments?|units?)|backyard cottages?|garage apartments?|accessory apartments?)\b/, ['accessory dwelling unit']],
  [/\bduplex(?:es)?\b/, ['dwelling two-family']],
  [/\b(?:triplex(?:es)?|fourplex(?:es)?|quadplex(?:es)?|apartments?|apartment buildings?|multi-?family)\b/, ['dwelling multi-family']],
  [/\b(?:townhouses?|townhomes?|rowhouses?|row houses?)\b/, ['dwelling townhouse']],
  [/\b(?:single[- ]family (?:homes?|houses?)|detached houses?)\b/, ['Dwelling, single-family detached']],
  [/\b(?:boarding ?houses?|rooming ?houses?|single[- ]room occupancy)\b/, ['rooming house']],
  [/\b(?:home daycares?|in-home daycares?|in-home day cares?|home day cares?|family daycares?|family day cares?)\b/, ['family day home']],
  [/\b(?:daycares?|day cares?|child ?care|preschools?)\b/, ['day care center child', 'family day home']],
  [/\b(?:brewery|breweries|brewpubs?|taprooms?|microbrewer(?:y|ies)|distiller(?:y|ies)|winer(?:y|ies)|ciderys?|cideries|craft beer)\b/, ['production of craft beverages', 'brewery cidery distillery winery']],
  [/\b(?:liquor stores?|package stores?|abc stores?)\b/, ['establishment for the sale of distilled spirits for off-premises consumption', 'sale of alcoholic beverages off-premises']],
  [/\b(?:beer and wine (?:stores?|shops?)|beer (?:stores?|shops?)|wine (?:stores?|shops?)|bottle shops?)\b/, ['sale of alcoholic beverages off-premises']],
  [/\b(?:pawn ?shops?|pawnbrokers?)\b/, ['pawnshop']],
  [/\b(?:thrift (?:stores?|shops?)|secondhand|second-hand|used goods|resale shops?|used (?:clothing|clothes)|vintage (?:clothing|clothes|stores?|shops?))\b/, ['used merchandise sales', 'consignment shop']],
  [/\b(?:used (?:book ?stores?|book ?shops?|books|records|cds|dvds|media))\b/, ['used books media']],
  [/\b(?:book ?stores?|book ?shops?)\b/, ['retail goods establishment', 'used books media']],
  [/\bfood trucks?\b/, ['vendor park food']],
  // Section 4.2.3 names art galleries under retail goods and cultural facilities too.
  [/\b(?:art galler(?:y|ies)|galler(?:y|ies))\b/, ['artist studio school gallery', 'retail goods establishment', 'cultural facility museum library']],
  [/\b(?:art studios?|artist studios?)\b/, ['artist studio school gallery']],
  [/\b(?:(?:beauty|barber(?:ing)?|cosmetology|massage|nail|tattoo|culinary|cooking|bartending|welding|hvac|truck driving|trade|vocational|technical)\s+(?:schools?|colleges?|academ(?:y|ies)|institutes?))\b/, ['School, vocational or trade']],
  [/\b(?:construction (?:trailers?|site (?:offices?|trailers?|storage))|job ?site (?:trailers?|offices?))\b/, ['Construction-related office/yard']],
  [/\b(?:(?<!used |vintage |second-?hand |thrift )(?:antique|bike|bicycle|gun|clothing|clothes|jewelry|furniture|hardware|gift|flower|record|mattress|appliance|shoe|toy|sporting goods)\s+(?:stores?|shops?|boutiques?)|pharmac(?:y|ies)|drug ?stores?|florists?|garden centers?)\b/, ['retail goods establishment']],
  // Recreation by the use types Section 4.2.3 lists for each.
  [/\b(?:bowling(?: alleys?| centers?)?|(?:ice |roller )?skating (?:rinks?|facilit(?:y|ies))|ice rinks?)\b/, ['recreation facility indoor']],
  [/\b(?:mini(?:ature)? golf(?: courses?)?|athletic fields?)\b/, ['recreation facility outdoor']],
  [/\b(?:(?:shooting|gun|archery) ranges?|swimming pools?|batting cages?|recreation courts?)\b/, ['recreation facility indoor', 'recreation facility outdoor']],
  [/\b(?:arcades?|video game (?:arcades?|rooms?))\b/, ['commercial recreation center', 'amusement device']],
  [/\bfast[- ]food(?: restaurants?| places?)?\b/, ['restaurant']],
  [/\b(?:baker(?:y|ies))\b/, ['retail goods establishment', 'restaurant', 'artisanal production']],
  [/\b(?:wine bars?|cocktail bars?|sports bars?|dive bars?|beer gardens?|beer halls?|brew ?pubs?|bar and grill|bar & grill)\b/, ['sale of alcoholic beverages on-premises', 'restaurant']],
  [/\b(?:grills?|pizz(?:a|eria)s?|pizza (?:places?|shops?)|bistros?|taquerias?|delis?|delicatessens?|sandwich (?:shops?|places?)|bagel (?:shops?|places?)|ice cream (?:shops?|parlou?rs?|places?)|food halls?)\b/, ['restaurant']],
  [/\b(?:pet (?:stores?|shops?|supply stores?))\b/, ['retail goods establishment']],
  [/\b(?:auto parts|car parts)(?: (?:stores?|shops?))?\b/, ['auto supply sales and rental']],
  [/\b(?:warehouse (?:stores?|clubs?)|wholesale clubs?|big[- ]box (?:stores?|retail))\b/, ['retail goods establishment', 'wholesale establishment']],
  [/\b(?:(?:mobile|manufactured) home (?:parks?|communit(?:y|ies))|trailer parks?)\b/, ['manufactured home park']],
  [/\bhomestays?\b/, ['Short-term rental unit (homestay)']],
  [/\badult day ?cares?\b/, ['day care center adult']],
  [/\b(?:(?:child(?:ren'?s)?|kids?'?|infant|toddler) (?:daycares?|day cares?|care))\b/, ['day care center child', 'family day home']],
  [/\b(?:(?:(?:child(?:ren'?s)?|kids?'?|infant|toddler) )?(?:child ?care|daycare|day care|care) centers?)\b/, ['day care center child']],
  [/\b(?:(?:daycares?|day cares?|child ?care|babysitting) (?:in|at|out of|from) (?:my|our|the|a) (?:home|house))\b/, ['family day home']],
  [/\b(?:church(?:es)?|temples?|mosques?|synagogues?|chapels?|places? of worship)\b/, ['religious institution']],
  [/\b(?:salons?|barber(?:shop)?s?|barbershops?|nail salons?|hair|beauty|tanning|laundromats?|tailors?|clothing alterations|shoe repair)\b/, ['personal service business']],
  [/\b(?:dry clean(?:ers?|ing))\b/, ['personal service business', 'laundry and dry cleaning plant']],
  [/\bmassages?\b/, ['therapeutic massage facility']],
  [/\bspas?\b/, ['personal service business', 'therapeutic massage facility']],
  [/\b(?:gyms?|fitness|crossfit|yoga studios?)\b/, ['health and fitness facility']],
  [/\b(?:smoothie bars?|salad bars?|coffee bars?|espresso bars?|cafes?|coffee ?shops?|coffee ?houses?|coffeehouses?|diners?|eater(?:y|ies)|juice bars?|smoothies?|bakery cafes?)\b/, ['restaurant']],
  [/\b(?:(?:vet|veterinary|animal) (?:clinics?|hospitals?|offices?)|vets?|veterinarians?)\b/, ['veterinary hospital or clinic']],
  [/\b(?:ev charg\w*|electric (?:car|vehicle) charg\w*|car chargers?)\b/, ['electric vehicle charging station']],
  [/\b(?:used car lots?|car dealerships?|car lots?|used cars?|auto dealer\w*|(?:auto|car|vehicle|automobile) sales)\b/, ['automobile sales']],
  [/\b(?:vehicle repair|vehicle maintenance)\b/, ['automobile repair and maintenance', 'commercial vehicle repair and maintenance']],
  [/\b(?:car|vehicle|auto) storage\b/, ['automobile storage']],
  [/\bretail (?:sales|stores?|shops?|space|business(?:es)?)\b/, ['retail goods establishment']],
  [/\b(?:auto (?:repair|mechanics?|body)|car repair|mechanics?|body shops?|collision (?:repair|centers?))\b/, ['automobile repair and maintenance']],
  [/\b(?:dentists?|doctor'?s? offices?|medical offices?|clinics?)\b/, ['office medical or dental']],
  [/\b(?:storage units?|self[- ]storage|mini[- ]storage)\b/, ['self-service storage units']],
  [/\b(?:outdoor (?:dining|seating)|patio (?:dining|seating)|sidewalk (?:cafes?|dining|seating))\b/, ['outdoor seating']],
  // At home, the use itself (4.3.3 bars these as home occupations).
  [/\b(?:home[- ](?:salons?|barber(?:shop)?s?|nail salons?|hair salons?|beauty salons?)|(?:salons?|barber(?:shop)?s?) (?:in|at|out of|from) (?:my|our|the|a) (?:home|house))\b/, ['personal service business']],
  [/\b(?:home[- ]massages?|massages? (?:in|at|out of|from) (?:my|our|the|a) (?:home|house))\b/, ['therapeutic massage facility']],
  [/\b(?:home[- ]tattoo(?:s|ing)?(?: (?:shops?|studios?|parlou?rs?))?|tattoo(?:s|ing)?(?: (?:shops?|studios?|parlou?rs?))? (?:in|at|out of|from) (?:my|our|the|a) (?:home|house))\b/, ['tattoo parlor']],
  [/\b(?:home[- ](?:based|bakery|bakeries|kitchen|offices?|business(?:es)?)|work from home|(?:in|at|out of|from) (?:my|our) (?:home|house|apartment|condo|townhouse)|cottage food)\b/, ['home occupation']],
  [/\b(?:(?:cannabis|marijuana|weed|pot) (?:shops?|stores?|dispensar(?:y|ies))|dispensar(?:y|ies))\b/, ['cannabis dispensing facility']],
  [/\b(?:cannabis|marijuana)\b/, ['cannabis dispensing facility', 'cannabis cultivation or manufacturing facility']],
  [/\b(?:sex shops?|adult (?:stores?|shops?|book ?stores?|theat(?:er|re)s?|novelty|video stores?))\b/, ['novelty store or theater adult']],
  [/\b(?:smoke shops?|vape (?:shops?|stores?)|head shops?|tobacco (?:shops?|stores?)|tobacconists?|cigar (?:shops?|stores?))\b/, ['smoke or vape shop', 'sale of smoking or vaping products']],
  [/\b(?:vapes?|vaping|tobacco|cigarettes?|cigars?|hookah)\b/, ['sale of smoking or vaping products', 'smoke or vape shop']],
  [/\b(?:tattoo(?:s|ing)?(?: (?:shops?|studios?|parlou?rs?|artists?))?|piercing (?:shops?|studios?))\b/, ['tattoo parlor']],
  [/\b(?:live music|concerts?|live (?:bands?|shows?|performances?)|comedy clubs?)\b/, ['live entertainment']],
  [/\b(?:concert venues?|concert halls?)\b/, ['live entertainment', 'cinema or theater', 'arena stadium amphitheater']],
  [/\bmusic venues?\b/, ['live entertainment', 'cinema or theater', 'nightclub']],
  [/\b(?:dance clubs?|night ?clubs?|discos?)\b/, ['nightclub']],
  [/\b(?:movie theat(?:er|re)s?|movie houses?|cinemas?|movies)\b/, ['cinema or theater']],
  [/\b(?:event (?:venues?|spaces?|halls?)|wedding venues?|reception halls?)\b/, ['banquet hall']],
];
const HOME_SAYING = SAYINGS.findIndex(([, targets]) => targets.length === 1 && targets[0] === 'home occupation');
// Words that name a kind of place, not a use. Shop, store and the like count as
// explained beside an explained word ("tattoo shop"); a drink or club word adds
// its own names beside one ("restaurant and bar" is also on-premises sales).
// Alone, either reads only through its generic names.
const GENERIC = [
  [/\b(?:bars?|taverns?|pubs?|lounges?)\b/, ['sale of alcoholic beverages on-premises', 'restaurant', 'nightclub']],
  [/\b(?:shops?|stores?|boutiques?|retail)\b/, ['retail goods establishment']],
  [/\bclubs?\b/, ['nightclub', 'membership organization']],
];
// A place word counts only after the use it names ("tattoo shop", "office space"), never before one ("business park").
const ABSORB = new Set(['shop', 'store', 'boutique', 'retail', 'business', 'place', 'spot', 'venue', 'building', 'property', 'space', 'club', 'complex']);
const ADDING = new Set(['bar', 'pub', 'tavern', 'lounge']);
// A bar word adds on-premises sales beside these; beside any other use it stays unexplained ("college bar", "beauty bar").
const DRINK_HOSTS = /^(?:Restaurant|Live entertainment|Nightclub|Brewery|Production of craft beverages|Banquet hall|Arena|Cinema|Commercial recreation|Recreation facility|Hotel|Sale of alcoholic)/;
// Service uses: "store" after one isn't that use ("beauty store" is a shop, not a salon).
const SERVICE = new Set(['Personal service business', 'Health and fitness facility', 'Therapeutic massage facility', 'Tattoo parlor']);
// Words that describe a use without naming another, before the use they describe ("mexican restaurant", "boutique hotel").
const MODIFIERS = new Set(['mexican', 'italian', 'chinese', 'japanese', 'thai', 'indian', 'vietnamese', 'korean', 'greek', 'sushi', 'vegan', 'vegetarian', 'family', 'small', 'little', 'local', 'independent', 'boutique', 'luxury', 'upscale', 'casual', 'studio', 'tiny']);
// Places made of many uses: never one use's marks.
const DEVELOPMENT = /\b(?:(?:office|business|industrial|research|technology|tech|corporate|commerce|retail|shopping) (?:parks?|centers?|plazas?|complex(?:es)?|campus(?:es)?)|strip malls?|shopping malls?|mixed[- ]use (?:buildings?|developments?|projects?))\b/;
// Home occupation (Section 4.3.3), quoted from the ordinance's text.
const HOME_OCCUPATION_RULES = {
  section: '4.3.3',
  excluded: 'The following uses are specifically prohibited as home occupations: (A) Personal service businesses; (B) Nursing homes or hospices; (C) Tattoo parlors; (D) Therapeutic massage facilities; (E) Contractor\u2019s offices with outdoor storage; and (F) Vehicle sales and service uses.',
  customers: 'On-site service to or consultation with customers or clients is prohibited.',
  sales: 'On-site sales of merchandise to the general public is prohibited.',
  exception: 'Except in the HC-G1, HC-G2, HC-G3, and HC-EF districts, a Conditional Use Permit may allow a use that does not conform with subsections (vi) or (vii), below.',
};
// Uses 4.3.3 bars as home occupations, and uses with their own rows: asked "in my house", these answer, not Home occupation.
const HOME_EXCLUDED = new Set(['Personal service business', 'Nursing home', 'Hospice', 'Tattoo parlor', 'Therapeutic massage facility', 'Office, contractor', 'Automobile sales', 'Automobile repair and maintenance, major', 'Automobile repair and maintenance, minor', 'Commercial vehicle repair and maintenance', 'Commercial vehicle sales and rental', 'Recreational vehicle sale, rental, and maintenance', 'Tire sales and repair', 'Small engine repair shop', 'Boat sales, rental, service, or repair', 'Car wash', 'Automatic car wash', 'Gas station']);
const HOME_OWN_ROWS = /^(?:Short-term rental unit|Family day home|Day care center|Accessory dwelling unit|Bed and breakfast|Rooming house)/;
// Names that list alternatives ("Hotel or motel"): each phrase here names the
// use by itself, so asking "museum" is asking for "Cultural facility, museum,
// or library". Any other name is the use asked for only when every word of it
// was asked (FILLER words aside).
const ALTERNATIVES = new Map(Object.entries({
  'Arboretum or botanical garden': ['arboretum', 'botanical garden'],
  'Arena, stadium, or amphitheater': ['arena', 'stadium', 'amphitheater'],
  'Artist studio/school/gallery': ['artist studio', 'art studio', 'artist school', 'art school'],
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
const STOP = new Set(['a', 'an', 'the', 'of', 'or', 'and', 'for', 'in', 'to', 'as', 'at', 'on', 'by', 'with', 'near', 'into', 'from', 'out', 'about', 'use', 'uses', 'is', 'are', 'be', 'can', 'could', 'would', 'should', 'do', 'does', 'i', 'we', 'me', 'my', 'our', 'you', 'your', 'it', 'this', 'that', 'what', 'where', 'how', 'allowed', 'permitted', 'open', 'opening', 'run', 'running', 'operate', 'operating', 'start', 'starting', 'have', 'build', 'put', 'want', 'like', 'new', 'sell', 'sells', 'selling', 'zone', 'zoned', 'zoning', 'district', 'here', 'there', 'other', 'all', 'any', 'kind', 'type', 'some', 'go', 'get', 'need', 'legal', 'built', 'developer', 'neighborhood', 'convert', 'converting', 'turn', 'turning']);
const plain = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Common spellings, and "at home" as "at my home".
const SPELLINGS = [[/\btheatres?\b/g, 'theater'], [/\bair ?b ?n ?b\b/g, 'airbnb'], [/\bcarwash(?:es)?\b/g, 'car wash'], [/\b(?:resturant|restaraunt|restraunt|resteraunt|restuarant)(s?)\b/g, 'restaurant$1'], [/\blaundry ?mat\b/g, 'laundromat'], [/\bchruch\b/g, 'church'], [/\b(at|from|out of) home\b(?! depot)/g, '$1 my home']];
// Where a use is ("near the airport", "in the park") isn't a second use: cut it off. "In my house" stays: it says the use is at home.
const cutPlace = (q) => q.replace(/\s+(?:near|by|beside|next to|close to|across (?:the street )?from|behind|opposite|around)\b.*$/, '').replace(/\s+(?:in|at|inside|on)\s+(?:the|a|an)\s+(?!(?:home|house|garage|basement|back ?yard|yard|attic|driveway|property|lot)\b).*$/, '');
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

// Rows the tables list as accessory or temporary uses.
const SUBORDINATE = new Set();
for (const t of tables.tables) for (const r of t.rows) if (/^(?:ACCESSORY|TEMPORARY)/.test(r.classification)) SUBORDINATE.add(r.also || r.use);

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
/**
 * Whether the words asked name this use: every word of it asked (FILLER
 * aside), or every word of one of its alternatives. Returns the words asked
 * that name it, or null.
 */
function named(name, asked) {
  const need = (words) => {
    const w = core(words).filter((x) => !FILLER.has(x));
    return w.length > 0 && w.every((x) => coveredBy(x, asked)) ? asked.filter((a) => w.some((x) => a === x || (a.length >= 5 && x.startsWith(a)))) : null;
  };
  const own = need(NAMES.get(name));
  if (own) return own;
  for (const alt of ALTERNATIVES.get(name) || []) {
    const hit = need(meaningful(alt));
    if (hit) return hit;
  }
  return null;
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
  // Everyday phrases are read on the whole question; table names on it with any place phrase cut off.
  const whole = SPELLINGS.reduce((t, [re, to]) => t.replace(re, to), plain(query)).trim();
  const q = cutPlace(whole);
  const own = meaningful(q);
  const asked = core(own);
  const ownSet = new Set(asked);
  // The table's own name, asked exactly: that use alone.
  // Its accessory or temporary twin ("Kennel (as an accessory use)") comes too, as its own row.
  const exact = [...NAMES].filter(([, have]) => { const w = core(have); return w.length === ownSet.size && w.every((x) => ownSet.has(x)); }).map(([name]) => name);
  if (exact.length) {
    const twins = [...NAMES.keys()].filter((n) => !exact.includes(n) && exact.some((x) => n.startsWith(`${x} (as `)));
    return { names: [...exact, ...twins], related: [], partial: false, via: twins, unexplained: [], more: 0 };
  }
  // A place made of many uses ("office park", "shopping center"): candidates only.
  const development = DEVELOPMENT.test(q);
  const explained = new Set();
  const spanned = new Set();
  const chosen = new Map();
  const choose = (name, x) => {
    const was = chosen.get(name);
    if (!was || x.cover > was.cover || (x.cover === was.cover && x.rank < was.rank)) chosen.set(name, x);
  };
  // A saying whose every match lies inside a longer saying's ("apartment" in
  // "apartment in my house") gives way to it.
  // A private pool or batting cage at home isn't a commercial recreation facility (4.2.3): those sayings wait for no residential cue.
  const residential = /\b(?:back ?yard|my (?:house|home|yard|property|lot)|private|residential)\b/.test(whole);
  const skip = (targets) => residential && targets.some((t) => /^recreation facility/.test(t));
  const found = SAYINGS.map(([re, targets]) => (skip(targets) ? [] : [...whole.matchAll(new RegExp(re.source, 'g'))].map((m) => [m.index, m.index + m[0].length])));
  const inside = ([a, b], [c, d]) => c <= a && b <= d && d - c > b - a;
  const sayingTargets = new Set();
  SAYINGS.forEach(([re, targets], i) => {
    const spans = skip(targets) ? [] : [...whole.matchAll(new RegExp(re.source, 'g'))];
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
        const covered = new Set([...words, ...asked.filter((w) => hit(w, have))]);
        choose(name, { name, own: false, covered, cover: covered.size, rank: 1 + i * 0.01 + j * 0.0001, score: weighted(own, have), size: have.size, home: i === HOME_SAYING });
      }
    });
  });
  const weakOnly = asked.length > 0 && asked.every((w) => ABSORB.has(w) || ADDING.has(w));
  const related = [];
  for (const [name, have] of weakOnly ? [] : NAMES) {
    const by = named(name, asked);
    if (by) {
      const hits = [...new Set([...asked.filter((w) => hit(w, have)), ...by])];
      // A name whose words all fall inside an everyday phrase that reads otherwise ("office" in "home office") is related, not the use asked.
      if (hits.length > 0 && hits.every((w) => spanned.has(w)) && !sayingTargets.has(name)) {
        related.push(name);
        continue;
      }
      for (const w of hits) explained.add(w);
      choose(name, { name, own: true, covered: new Set(hits), cover: hits.length, rank: 0, score: weighted(own, have), size: have.size });
    } else if (full(asked, have)) related.push(name);
  }
  // A use's accessory or temporary twin ("Kennel (as an accessory use)") comes with it, as its own row.
  for (const [name, x] of [...chosen]) {
    for (const n of NAMES.keys()) if (n.startsWith(`${name} (as `) && !chosen.has(n)) choose(n, { ...x, name: n, own: false, rank: x.rank + 0.1, size: NAMES.get(n).size });
  }
  // Generic words: alone, through their generic names; a drink or club word beside an explained one adds its names.
  const addNames = (targets, rank, words) => targets.forEach((target, j) => {
    const want = meaningful(target);
    for (const [name, have] of NAMES) if (full(want, have)) choose(name, { name, own: false, covered: new Set(words), cover: words.length, rank: rank + j * 0.0001, score: 0, size: have.size });
  });
  if (weakOnly && !chosen.size) {
    GENERIC.forEach(([re, targets], i) => re.test(q) && addNames(targets, 2 + i * 0.01, asked));
    if (chosen.size) for (const w of asked) explained.add(w);
  } else {
    // A place word after an explained use word; a drink word beside one adds on-premises sales (and Nightclub beside live entertainment).
    const useWord = (x) => explained.has(x) && !ABSORB.has(x) && !ADDING.has(x) && !MODIFIERS.has(x);
    const serviceOnly = chosen.size > 0 && [...chosen.keys()].every((n) => SERVICE.has(n));
    asked.forEach((w, i) => {
      if (ABSORB.has(w) && asked.slice(0, i).some(useWord) && !(serviceOnly && ['store', 'boutique', 'retail'].includes(w))) explained.add(w);
      if (MODIFIERS.has(w) && asked.slice(i + 1).some(useWord)) explained.add(w);
    });
    const adding = asked.filter((w) => ADDING.has(w) && !spanned.has(w));
    if (adding.length && [...chosen.keys()].some((n) => DRINK_HOSTS.test(n))) {
      addNames(['sale of alcoholic beverages on-premises', ...(chosen.has('Live entertainment') ? ['nightclub'] : [])], 2, adding);
      for (const w of adding) explained.add(w);
    }
  }
  // A name whose covered words another chosen name's take in, and more ("Park" in "park and ride", "Office, medical" in "vet clinic"), is related.
  for (const [name, x] of [...chosen]) {
    if ([...chosen.values()].some((y) => y !== x && y.covered.size > x.covered.size && [...x.covered].every((w) => y.covered.has(w)))) {
      chosen.delete(name);
      related.push(name);
    }
  }
  // Asked at home: Home occupation gives way to a use 4.3.3 bars as one (and
  // the answer says so), or to one with its own row (a short-term rental, a
  // day care, an accessory or temporary use). Any other use asked "in my house"
  // is what Home occupation answers ("office in my house"): related.
  const atHome = /\b(?:home|house)\b/.test(q);
  const homeExcluded = atHome && [...chosen.keys()].some((n) => HOME_EXCLUDED.has(n));
  const home = chosen.get('Home occupation');
  if (home && !home.own) {
    const others = [...chosen.keys()].filter((n) => n !== 'Home occupation');
    if (others.some((n) => HOME_EXCLUDED.has(n) || HOME_OWN_ROWS.test(n) || SUBORDINATE.has(n))) chosen.delete('Home occupation');
  }
  const unexplained = asked.filter((w) => !explained.has(w));
  const partial = unexplained.length > 0 || !chosen.size || development;
  if (partial) {
    // Candidates by the rarity of the words they share, beside anything already chosen.
    for (const name of related) choose(name, { name, own: false, cover: 0, rank: 3, score: weighted(own, NAMES.get(name)), size: NAMES.get(name).size });
    const scored = [...NAMES].map(([name, have]) => ({ name, own: false, cover: 0, rank: 3, score: weighted(own, have), size: have.size })).filter((x) => x.score > 0);
    const best = Math.max(0, ...scored.map((x) => x.score));
    if (best >= 0.34) for (const x of scored) if (x.score > best - 0.2) choose(x.name, x);
    // "<anything> store": a retail goods establishment is a candidate.
    if (/\b(?:stores?|shops?|boutiques?|retail)\b/.test(q)) choose('Retail goods establishment', { name: 'Retail goods establishment', own: false, cover: 0, rank: 3, score: 0.5, size: 3 });
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
    ...(homeExcluded && !partial ? { home_occupation: HOME_OCCUPATION_RULES } : {}),
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
        ...(name === 'Home occupation' ? { rules: HOME_OCCUPATION_RULES } : {}),
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
// A use named as the table names it (case, spacing and punctuation aside).
const normName = (x) => plain(x).replace(/[^a-z0-9]+/g, ' ').trim();
const BY_NAME = new Map([...NAMES.keys()].map((n) => [normName(n), n]));
export const exactName = (x) => BY_NAME.get(normName(x)) ?? null;
const classesOf = (name) => [...new Set(tables.tables.flatMap((t) => t.rows.filter((r) => (r.also || r.use) === name).map((r) => r.classification)))];
const tablesOf = (name) => tables.tables.filter((x) => x.rows.some((r) => (r.also || r.use) === name)).map((x) => `Table ${x.section}`);
const standardsOf = (name) => {
  for (const t of tables.tables) for (const r of t.rows) if ((r.also || r.use) === name) return r.standards;
  return null;
};

const HOW =
  'Plain words get candidate use names, never marks: choose the use the person means (its definition decides; ask them when it isn\'t clear), then call again with that exact name. Say the district, the table and its page (link it), and what the mark means in plain words. The tables name uses their own way, and the use\'s definition in Article 4 (its standards reference, read with ordinance_lookup section) decides whether an activity is that use: read it before saying a use is prohibited, and before saying which of several matching uses applies. P/C means a Conditional Use Permit may be required: the cited performance standards decide when, so read them before saying whether one is needed. An overlay (PCO, IMU-O, STRL-O and others) can permit, prohibit or add standards on top of the base district, and the overlay controls where they conflict (Section 3.9.3). For a parcel in a PCO overlay, its PCO column decides, and a use Table 3.9.23 doesn\'t list is prohibited there (the table marks every other use not permitted), so check the parcel\'s overlays and call again with its PCO district. Other overlays set out their changes in their own sections. Conditional zoning (proffered conditions in the rezoning ordinance) and Planned Development terms can narrow these uses. A partial result has candidates and no marks: confirm which use is meant (the definition, or the person) and call again with its name before answering. A row\'s classification says whether it is the principal use or an accessory one. Give a row\'s note if it has one: the City\'s tables print that row inconsistently. These tables are read from the City\'s PDF, current through the date given; the PDF is the authority, and a Zoning Determination from the Department of City Planning is the binding answer for a property.';

export default definePlugin({
  name: 'zoning_uses',
  cities: ['norfolk'],
  description: `Norfolk's zoning use tables (Zoning Ordinance Tables 3.2.12 to 3.9.23, ${tables.current_through}): whether a use is permitted by right (P), needs a Conditional Use Permit (C), may need one depending on its performance standards (P/C), or is blank (prohibited as that use), in each zoning district. Two steps: give use in plain words ("short-term rental", "brewery", "day care", "church") to get candidate use names as the tables name them, with no marks; pick the one the person means (read its definition, or ask), then call again with use set to that exact name, or names for several, to get the marks. district is a zoning district code (for example "C-C", "MF-NS", "SF-6", "PCO-Colley"; get an address's district and overlays from the address or parcel lookup first). With a use name and a district: that use there. A use name alone: every district. District only: the uses it marks, by mark (filter with mark). Read the cited definition and performance standards with ordinance_lookup before saying a use is prohibited or whether a P/C needs a permit.`,
  parameters: {
    type: 'object',
    properties: {
      use: { type: 'string', description: 'A use: in plain words for candidate names, or exactly as the table names it (as a candidate list gives it) for its marks.' },
      names: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'Several uses, each exactly as the table names it, for their marks together.' },
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
    const namesIn = Array.isArray(args.names) ? args.names.slice(0, 6).map((x) => String(x ?? '').trim().slice(0, 120)).filter(Boolean) : [];
    if (useIn || namesIn.length) {
      // Marks only for uses named as the table names them. Plain words get
      // candidates: the tables name uses their own way, and which use an
      // activity is is its definition's call, so Siren confirms the use and
      // asks again by its name.
      const asked = namesIn.length ? namesIn : [useIn];
      const exact = asked.map(exactName);
      if (!exact.every(Boolean)) {
        const unknown = asked.filter((x, i) => !exact[i]);
        const words = namesIn.length ? unknown.join('; ') : useIn;
        const m = matchUses(words);
        const list = [...new Set([...m.names, ...m.related])].slice(0, MAX_MATCHES + 2);
        const likely = new Set(m.partial ? [] : m.names);
        const candidates = list.map((n) => ({ use: n, ...(likely.has(n) ? { likely: true } : {}), classification: classesOf(n), standards: standardsOf(n), in_tables: tablesOf(n) }));
        return {
          ...(namesIn.length ? { error: `Not use names in the tables: ${unknown.join('; ')}. Give each name exactly as a candidate list gives it.` } : { use: useIn }),
          ...(district ? { district } : {}),
          matches: [],
          candidates,
          ...(candidates.length
            ? { choose: 'These are candidate uses, not answers: the tables name uses their own way, and a use\'s definition (Article 4: read its standards reference with ordinance_lookup) decides whether the activity is that use. Pick the one the person means, or several if they asked about several, asking them when it isn\'t clear; then call again with use set to that exact name (or names, for several) to get the marks. Don\'t call anything allowed or prohibited from this list.' }
            : { note: 'No use in the tables is named with those words. The tables name uses their own way (a church is a "Religious institution", a salon a "Personal service business"): call again with the district alone to see its uses, or search the definitions in Article 4 with ordinance_lookup. Don\'t call the use prohibited until you know which use it is.' }),
          ...(m.partial && m.unexplained.length ? { unexplained: m.unexplained } : {}),
          ...(m.more ? { more: `${m.more} more use${m.more === 1 ? '' : 's'} hold these words: narrow the words to see them.` } : {}),
          ...(m.home_occupation ? { home_occupation: { ...m.home_occupation, note: 'Not a home occupation: Section 4.3.3 prohibits these uses as one, so working from home doesn\'t make them allowed.' } } : {}),
          ...(m.related.length ? { related: { uses: m.related, note: 'These names hold the words asked but name a narrower or different use.' } } : {}),
          ...conditional,
          how: HOW,
          ...about,
        };
      }
      // A use asked by its name brings its accessory or temporary twin, as its own row.
      const names = [...new Set(exact.flatMap((n) => [n, ...(namesIn.length ? [] : [...NAMES.keys()].filter((x) => x.startsWith(`${n} (as `)))]))];
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
        ...(namesIn.length ? { names: exact } : { use: useIn }),
        ...(district ? { district } : {}),
        matches,
        ...notListed,
        ...(absent.length ? { not_in_tables: { uses: absent, means: 'Not listed in these tables, so not allowed as this use in their districts (a PCO overlay marks unlisted uses not permitted); whether an activity is this use is its definition\'s call.' } } : {}),

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
