// Checks on text that could be shown in public: residents' questions and
// source-request notes, steward notes, general questions, action text and
// bot text (docs/gaps.md §6.3). They keep places finer than the city, contact
// details and people out. Text checks catch mistakes, not malice; residents'
// words still go through the steward.
//
// publicTextViolations blocks; publicTextFlags only hints to the steward.
// Neither ever echoes the text back: refusals say what to change.

import { ruleA } from './gaps/kinds.js';

// The street checks work on words and Set lookups, never on a regex built
// from the street list: compiling one from ~2,000 names cost hundreds of ms
// of CPU on a cold Worker, over the Free plan's 10 ms.
const SUFFIXES = new Set('st street ave avenue rd road blvd boulevard dr drive ln lane ct court cir circle pl place ter terrace way pkwy parkway hwy highway cres crescent sq square trl trail row walk mews plz plaza pike run xing crossing ext landing loop pt point arch key quay bend grn green'.split(' '));
const DIRECTIONS = new Set('n s e w ne nw se sw north south east west'.split(' '));
// Words that can sit between a count and a suffix-like word without making an
// address: "683 of 2,770 work orders", "I found 60 with no street".
const STOP = new Set(
  'of the a an and or to for from with without no not on in at by is are was were has have had this that these those my your their his her its our trees tree work orders order removals removal records record items item agenda datasets dataset columns column data city forestry status complete days day times time years year people questions question requests request with each per all any one two three'.split(' ')
);

/** Normalize before checking: NFKC, straight quotes, no format characters or soft hyphens. */
export function normalizePublic(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[­\p{Cf}]/gu, '');
}

// Single-word street names that are also ordinary English words, tree
// species or landscape words. After a house number, a species counts as a
// street only with a suffix ("200 cherry trees" passes, "200 Cherry St"
// doesn't), and an ordinary word only where the phrase ends ("1500 Church").
// At a corner, at least one side must be something else.
const SPECIES = new Set(
  // Tree species and plants (the inventory's common names among them).
  'cherry dogwood birch poplar myrtle crape crapemyrtle cypress sycamore hickory hemlock spruce juniper locust catalpa mulberry walnut chestnut almond alder ash beech linden tulip redbud sweetgum gum magnolias oaks maples elms pines palmetto palm mimosa azalea camellia lilac jasmine wisteria honeysuckle thistle primrose poppy daisy orchid buttercup barberry bayberry blueberry dewberry boxwood redwood cedarwood peachtree appletree melon calla vine filbert'.split(' ')
);
const COMMON = new Set([
  ...SPECIES,
  ...(
    'park church main city hall water tree trees forest wood woods river bay lake shore beach ocean view hill hills spring summer winter fall field fields garden gardens grove meadow mill pine oak elm maple cedar willow holly magnolia laurel ivy rose lee virginia college school court ward union market bank bridge station harbor port point state county national liberty freedom hope grace faith may june west east north south center central first second third fourth fifth sixth seventh eighth ninth tenth high low long short wide broad little big old new end way ridge cove creek glen dale haven brook knoll terrace place square plaza row green white black brown gray red blue orange gold silver king queen prince princess duke lord general admiral federal ' +
    // Ordinary words that are also Norfolk street names.
    'light branch early front cross core bond clay ford gates abbey apex arbor ball bell bill blow bower bridle buck cap carriage cavern chapel circle citadel commander commercial commodore commonwealth congress console corporate cottage covenant crescent croft dare dean dell diesel dominion draper dune eagle earl easy eden enterprise esquire executive factory fawn finch flicker forge glade government granite gym hale halter hammock hardwood hardy harmony head heron highland hillside hunt hunter hunters inlet international jay jubilee lagoon lakeside lance land landing lead lens light lighthouse limestone link lion loam mace magazine maiden majestic major mallard marathon marina mariner mariners marsh mason melon memorial meridian middle midland military mission monarch monitor mooring noble orchard pace paddock painter parish patent patrician pearl pebble perch pike pilot pleasant plume pope portal presidential priory production progress quail queens quill ransom ray rebel reel regent reservoir resilience rich royale rush sandy security skyline smith standard sterling strand summit sunny sunset sunshine swan sylvan teal terminal tidal tides trinity typo valley victory villa village vista wake walker wall warehouse while widgeon wise worth york'
  ).split(' '),
]);
// Nouns a count is usually of: "200 cherry trees", "300 Granby residents"
// aren't addresses.
const COUNTED = new Set(
  'trees tree work orders order removals removal records record items item agenda datasets dataset columns column data days day times time years year people questions question requests request poles pole stumps stump permits permit complaints complaint calls dollars percent species cases hours weeks months feet foot ft inches miles acres homes houses residents plantings planting prunings pruning rows findings meetings votes members crews branches limbs lights blocks properties parcels lots units'.split(' ')
);
const CONNECTORS = new Set(['and', '&', 'at']);

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Compile a street list (bare names, e.g. "OCEAN VIEW") into the lookup the
 * checks use: a Set of lowercased names of 1 to 4 words. Building it is
 * linear in the list and needs no regex, so a cold check stays well inside a
 * Worker's CPU limit.
 */
export function compileStreets(streets = []) {
  const names = new Set();
  for (const raw of streets || []) {
    // The build writes names trimmed, upper case and single-spaced; this
    // stays cheap for that and still tidies anything else.
    let n = String(raw).trim().toLowerCase();
    if (n.includes('  ') || n.includes('\t') || n.includes('\n')) n = norm(n);
    if (n.length < 2) continue;
    names.add(n);
    // "GRANBY STREET" also counts as "granby".
    const sp = n.lastIndexOf(' ');
    if (sp > 0 && SUFFIXES.has(n.slice(sp + 1).replace(/\.$/, ''))) names.add(n.slice(0, sp));
  }
  return names.size ? { names } : null;
}
const compiled = new WeakMap();
function streetLookup(streets) {
  if (!streets) return null;
  if (typeof streets === 'object' && !Array.isArray(streets) && streets.names instanceof Set) return streets;
  if (!compiled.has(streets)) compiled.set(streets, compileStreets(streets));
  return compiled.get(streets);
}

/**
 * Words, with where each starts and ends, and "&" as a word. Digit groups
 * joined by thousands separators become one number marked `grouped`
 * ("2,770"); a number written right after another number and a ".", ":",
 * "/" or "-" is marked `part` (decimals, times, dates).
 */
function tokens(t) {
  const out = [];
  for (const m of t.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}]+)?|&/gu)) {
    const tok = { w: m[0].toLowerCase(), raw: m[0], start: m.index, end: m.index + m[0].length };
    const prev = out.at(-1);
    if (prev && /^\d+$/.test(prev.w) && /^\d{3}$/.test(tok.w) && t.slice(prev.end, tok.start) === ',' && (prev.grouped || /^\d{1,3}$/.test(prev.w))) {
      prev.w += tok.w;
      prev.raw = t.slice(prev.start, tok.end);
      prev.end = tok.end;
      prev.grouped = true;
      continue;
    }
    if (prev && /^\d/.test(tok.w) && /^\d+$/.test(prev.w) && /^[.:/-]$/.test(t.slice(prev.end, tok.start))) tok.part = true;
    out.push(tok);
  }
  return out;
}
// Two words belong to one phrase when only spaces, or a period and spaces, sit between them.
const joined = (t, a, b) => /^\.?\s+$/.test(t.slice(a.end, b.start));
const ORDINAL = /^\d+(?:st|nd|rd|th)$/;

/**
 * The street that starts at token i, if any: { end, strong, name }. Strong
 * means it carries a suffix or has more than one word. Case doesn't matter:
 * residents and drafts write "1500 bolling" too.
 */
function streetAt(t, toks, i, names) {
  for (let n = Math.min(4, toks.length - i); n >= 1; n--) {
    const span = toks.slice(i, i + n);
    if (span.some((x, k) => k && !joined(t, span[k - 1], x))) continue;
    const name = span.map((x) => x.w).join(' ');
    if (!names.has(name)) continue;
    const next = toks[i + n];
    // "street trees" and "street lights" are things, not a suffix.
    const suffix = next && SUFFIXES.has(next.w) && joined(t, span.at(-1), next) && !nounStreet(toks, i + n);
    if (suffix) return { end: i + n + 1, strong: true, name };
    if (n > 1) return { end: i + n, strong: true, name };
    if (/^\d/.test(name) && !ORDINAL.test(name)) return null;
    return { end: i + 1, strong: false, name };
  }
  return null;
}
/** The same, allowing a direction word first ("W 21st St"). */
function streetFrom(t, toks, i, names) {
  const plain = streetAt(t, toks, i, names);
  if (plain) return plain;
  const d = toks[i];
  if (d && DIRECTIONS.has(d.w) && toks[i + 1] && joined(t, d, toks[i + 1])) {
    const m = streetAt(t, toks, i + 1, names);
    // "W 21st" is a street; a direction makes a bare name stronger only for ordinals.
    if (m) return m;
  }
  return null;
}
/** A street that ends just before token i (its suffix, if any, included). */
function streetEndingAt(t, toks, i, names) {
  let best = null;
  for (let s = Math.max(0, i - 5); s < i; s++) {
    const m = streetFrom(t, toks, s, names);
    if (m && m.end === i && (!best || m.strong)) best = m;
  }
  return best;
}
/** "street" or "streets" before "tree(s)" or "light(s)": a noun, not a suffix. */
function nounStreet(toks, j) {
  return (toks[j]?.w === 'street' || toks[j]?.w === 'streets') && /^(?:trees?|lights?|lighting)$/.test(toks[j + 1]?.w || '');
}

/**
 * Where the street after a house number starts, when token i is one: 1 to 6
 * digits, maybe with a unit letter ("1500B", "1500-B"). Not a number written
 * with thousands separators or after another number. A number that could be
 * a year (1900 to 2099) is still a house number here, whatever word comes
 * before it: "from 1950 Granby St" is an address. Whether it's a year is
 * decided only from what follows (numberStreet, houseNumber).
 */
function houseNumberAt(t, toks, i) {
  const tok = toks[i];
  if (tok.grouped || tok.part || !/^\d{1,6}[a-z]?$/.test(tok.w)) return -1;
  let k = i + 1;
  if (/^\d+$/.test(tok.w) && toks[k] && /^[a-z]$/.test(toks[k].w) && t.slice(tok.end, toks[k].start) === '-') k++;
  return toks[k] && joined(t, toks[k - 1], toks[k]) ? k : -1;
}
const YEAR = /^(?:19|20)\d{2}$/;
// City and region names that are also Norfolk street names. After a year
// ("The 2025 Norfolk budget") they're read like ordinary words.
const CITY_WORDS = new Set(['norfolk', 'virginia', 'chesapeake', 'portsmouth', 'hampton']);
// What ends a phrase after a street name: the end of the text, or . ? ! ; : ) "
function endsPhrase(t, tok, next) {
  const gap = t.slice(tok.end, next ? next.start : t.length);
  return next ? /^\s*[.?!;:)"]/.test(gap) : true;
}

function numberStreet(t, toks, names) {
  for (let i = 0; i < toks.length - 1; i++) {
    const k = houseNumberAt(t, toks, i);
    if (k < 0) continue;
    const m = streetFrom(t, toks, k, names);
    if (!m) continue;
    // A suffix or a name of more than one word after any number, a year
    // included, is an address: "from 1950 Granby St", "the 2024 Ocean View".
    if (m.strong) return true;
    // A bare one-word name after a number.
    const next = toks[m.end];
    const last = toks[m.end - 1];
    if (SPECIES.has(m.name)) continue;
    // After a year-like number, an ordinary word or a city or region name
    // reads as an address only where one would sit: after "at", or ending the
    // phrase. "The 2025 Norfolk budget" and "In 2020 Norfolk planted" pass.
    // Any other name is a street as after any number: "near 1950 Granby,
    // Norfolk" and "the 1900 Granby block" are addresses.
    if (YEAR.test(toks[i].w) && (COMMON.has(m.name) || CITY_WORDS.has(m.name))) {
      if ((i > 0 && toks[i - 1].w === 'at') || endsPhrase(t, last, next)) return true;
      continue;
    }
    if (COMMON.has(m.name)) {
      if (endsPhrase(t, last, next)) return true;
      continue;
    }
    if (next && joined(t, last, next) && COUNTED.has(next.w)) continue;
    return true;
  }
  return false;
}

/**
 * A corner: street names on both sides of "and", "&" or "at". Case doesn't
 * matter, but at least one side must carry a suffix, have more than one
 * word, or be a name that isn't an ordinary word, a species or an ordinal,
 * so "cherry and dogwood", "park and main" and "21st and 22nd" aren't corners.
 */
function intersection(t, toks, names) {
  const distinctive = (m) => m.strong || (!COMMON.has(m.name) && !ORDINAL.test(m.name));
  for (let i = 1; i < toks.length - 1; i++) {
    if (!CONNECTORS.has(toks[i].w) || !joined(t, toks[i - 1], toks[i]) || !joined(t, toks[i], toks[i + 1])) continue;
    const left = streetEndingAt(t, toks, i, names);
    if (!left) continue;
    const right = streetFrom(t, toks, i + 1, names);
    if (right && (distinctive(left) || distinctive(right))) return true;
  }
  return false;
}

/** A house number, an optional direction, up to 3 words that aren't stop words, then a suffix: "1500 W Bolling Ave". */
function houseNumber(t, toks) {
  for (let i = 0; i < toks.length - 1; i++) {
    const k0 = houseNumberAt(t, toks, i);
    if (k0 < 0) continue;
    let k = k0;
    if (DIRECTIONS.has(toks[k].w) && toks[k + 1] && joined(t, toks[k], toks[k + 1])) k++;
    for (let j = k; j < toks.length && j <= k + 3; j++) {
      if (!joined(t, toks[j - 1], toks[j])) break;
      if (SUFFIXES.has(toks[j].w) && !nounStreet(toks, j)) return true;
      // Ordinal street names ("710 W 21st St") are words here, not counts.
      if (STOP.has(toks[j].w) || (!/^\p{L}/u.test(toks[j].w) && !ORDINAL.test(toks[j].w))) break;
    }
  }
  return false;
}

const ROLE_NOUNS = 'forester|manager|director|council ?member|councilman|councilwoman|councillor|mayor|clerk|chair(?:man|woman|person)?|inspector|supervisor|superintendent|commissioner|operator|crew|worker|employee|arborist';
const PEOPLE = new RegExp(
  `\\b(?:neighbou?rs?|residents?|owners?|tenants?|renters?|landlords?|homeowners?|households?|family|families|occupants?|applicants?|requesters?|requestors?|complainants?|callers?|people|folks|someone|somebody|anyone|anybody|whoever|he|she|him|his|her|hers|${ROLE_NOUNS})\\b`,
  'gi'
);

// Statute and ordinance citations ("Va. Code § 2.2-3704", "Sec. 42-15",
// "Ordinance No. 48-512") aren't account numbers: a dash group after a
// citation word, or with a dot in it, is left out of long_number when it holds
// at most 6 digits or a dot. A 7-digit-or-longer bare group still counts.
const CITATION = /(?:§+|\b(?:sec(?:tion)?|code|chapter|ch|ordinance|no|art(?:icle)?|title)\.?)\s*(\d+(?:[.-]\d+)+|\d+)/gi;
function withoutCitations(t) {
  return t
    .replace(CITATION, (m, num) => (num.includes('.') || num.replace(/\D/g, '').length <= 6 ? ' ' : m))
    .replace(/\b\d+(?:\.\d+)+(?:-\d+(?:\.\d+)*)+\b/g, (m) => (m.replace(/\D/g, '').length <= 8 ? ' ' : m));
}

const ROLE_BLAME = new RegExp(`\\bwhy did (?:the )?(?:${ROLE_NOUNS})\\b`, 'i');

const BLOCKS = [
  ['block_of', (t) => /\bblock of\b/i.test(t)],
  ['unit', (t) => /\b(?:apt|apartment|unit|suite|ste)\.?\s*#?\s*\d+|#\s*\d+/i.test(t)],
  ['email', (t) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t)],
  ['phone', (t) => /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/.test(t)],
  ['mention', (t) => /(?:^|[\s(])@[a-z0-9_][a-z0-9_.-]{1,}/i.test(t)],
  ['link', (t) => /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|gov|edu|io|us|info|me|co|ly|app|social)\b/i.test(t)],
  ['long_number', (t) => {
    // Amounts written with thousands separators ("$1,250,000") aren't parcel or account numbers.
    const u = withoutCitations(t).replace(/\$?\b\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![,\d])/g, ' ');
    return /\b\d{7,}\b/.test(u.replace(/,/g, '')) || [...u.matchAll(/\b\d+(?:-\d+)+\b/g)].some((m) => !/^\d{4}-\d{2}-\d{2}$/.test(m[0]) && !/^(?:19|20)\d{2}-(?:19|20)?\d{2}$/.test(m[0]));
  }],
  ['coordinates', (t) => /-?\b\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/.test(t)],
  ['parcel_grain', (t) => /\b(?:my|your|their|his|her|this|that)\s+(?:house|home|parcel|property|lot|yard|driveway|address|apartment)\b/i.test(t)],
  ['person_pointing', (t) => /\bwho\s+(?:lives|lived|owns|owned|called|complained|reported|filed|asked|applied|requested|put in)\b|\bwhose\b|\bwhich\s+(?:neighbou?r|resident|household|family)/i.test(t)],
  ['named_person', (t) => /\b(?:Mr|Mrs|Ms|Mx|Dr|Miss)\.?\s+[A-Z][a-z]/.test(t)],
  ['role_blame', (t) => ROLE_BLAME.test(t)],
];

/**
 * Block codes for text that could go public. `streets` is the city's street
 * list (data/gaps/<city>-streets.json), raw or compiled with compileStreets.
 * `ownPlace(phrase)` (raise time only) returns true for a phrase of 1 to 4
 * words that names the asker's own street, ward or civic league.
 * Returns the codes, [] when the text passes.
 */
export function publicTextViolations(text, { streets, ownPlace } = {}) {
  const t = normalizePublic(text);
  const out = [];
  // Addresses and corners need a digit or a connector; most notes skip the word checks.
  if (/\d/.test(t) || /&|\b(?:and|at)\b/i.test(t)) {
    const toks = tokens(t);
    if (houseNumber(t, toks)) out.push('house_number');
    const sl = streetLookup(streets);
    if (sl) {
      if (numberStreet(t, toks, sl.names)) out.push('number_street');
      if (intersection(t, toks, sl.names)) out.push('intersection');
    }
  }
  for (const [code, test] of BLOCKS) if (test(t)) out.push(code);
  if (typeof ownPlace === 'function') {
    const words = t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    outer: for (let n = 1; n <= 4; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        if (ownPlace(words.slice(i, i + n).join(' '))) {
          out.push('own_place');
          break outer;
        }
      }
    }
  }
  return [...new Set(out)];
}

const MESSAGES = {
  house_number: 'Leave out house numbers and addresses.',
  number_street: 'Leave out house numbers and addresses.',
  intersection: 'Leave out intersections and street corners.',
  block_of: 'Ask about the whole city, not a block.',
  unit: 'Leave out apartment and unit numbers.',
  email: 'Leave out email addresses.',
  phone: 'Leave out phone numbers.',
  mention: 'Leave out @names.',
  link: 'Leave out links.',
  long_number: 'Leave out long numbers such as parcel, account or phone numbers.',
  coordinates: 'Leave out map coordinates.',
  parcel_grain: 'Ask about the records for the whole city, not one home or property.',
  person_pointing: 'Ask about the records, not about who lives somewhere or who asked for something.',
  named_person: "Leave out people's names.",
  role_blame: 'Ask what the records show, not why a person did something.',
  own_place: 'Leave out your own street, ward and civic league: ask about the whole city.',
};

/** What to change, for a list of codes. Never quotes the text. */
export function publicTextMessage(codes) {
  return [...new Set(codes.map((c) => MESSAGES[c] || 'Rephrase this as a question about the records for the whole city.'))].join(' ');
}

/** Words that name the city's departments, datasets and the city: two capitalized words in a row among them aren't flagged. */
export const FLAG_ALLOWLIST = Object.freeze(['City Council', 'Planning Commission', 'Work Orders', 'City Tree Inventory', 'Tree Inventory', 'City Tree', 'Significant Trees', 'Tree Planting', 'Planting Program', 'MyNorfolk', 'Norfolk Cares', 'City Clerk', 'Parks and Recreation', 'Public Works', 'Urban Forestry', 'Norfolk VA', 'Siren']);

/**
 * Hints for the steward; they never block: people and role nouns, two
 * capitalized words in a row outside the allowlist (a name, or a civic
 * league), and `presupposes` when the text uses a rule A word.
 */
export function publicTextFlags(text, { allow = FLAG_ALLOWLIST } = {}) {
  const t = normalizePublic(text);
  const flags = [];
  const people = [...new Set((t.match(PEOPLE) || []).map((w) => w.toLowerCase()))];
  if (people.length) flags.push({ code: 'person', words: people });
  let rest = t;
  for (const a of allow) rest = rest.split(a).join(' ');
  const caps = [...rest.matchAll(/(?<![.?!]\s|^)\b[A-Z][a-z'’]+\s+[A-Z][a-z'’]+\b/g)].map((m) => m[0]);
  if (caps.length) flags.push({ code: 'capitalized_words', words: [...new Set(caps)] });
  if (ruleA(t).length) flags.push({ code: 'presupposes' });
  return flags;
}

// Compile the regexes (and ICU's Unicode property tables) at load, so a
// Worker pays for them at startup rather than inside the first request's CPU
// time. The text exercises every check; the result is thrown away.
publicTextViolations('Warm-up: 1500 W Ab St and Ab, apt 4, a@b.org, 757-664-4253, @x.y https://x.org 1234567 36.85, -76.29 my house, who called, whose, Mr. X, why did the forester', { streets: compileStreets(['AB']) });
