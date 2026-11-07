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
// species or landscape words count as a street only with a suffix after them
// ("Cherry St", not "cherry" or "Cherry").
const COMMON = new Set(
  (
    'park church main city hall water tree trees forest wood woods river bay lake shore beach ocean view hill hills spring summer winter fall field fields garden gardens grove meadow mill pine oak elm maple cedar willow holly magnolia laurel ivy rose lee virginia college school court ward union market bank bridge station harbor port point state county national liberty freedom hope grace faith may june west east north south center central first second third fourth fifth sixth seventh eighth ninth tenth high low long short wide broad little big old new end way ridge cove creek glen dale haven brook knoll terrace place square plaza row green white black brown gray red blue orange gold silver king queen prince princess duke lord general admiral federal ' +
    // Tree species and plants (the inventory's common names among them).
    'cherry dogwood birch poplar myrtle crape crapemyrtle cypress sycamore hickory hemlock spruce juniper locust catalpa mulberry walnut chestnut almond alder ash beech linden tulip redbud sweetgum gum magnolias oaks maples elms pines palmetto palm mimosa azalea camellia lilac jasmine wisteria honeysuckle thistle primrose poppy daisy orchid buttercup barberry bayberry blueberry dewberry boxwood redwood cedarwood peachtree appletree melon calla vine filbert ' +
    // Ordinary words that are also Norfolk street names.
    'light branch early front cross core bond clay ford gates abbey apex arbor ball bell bill blow bower bridle buck cap carriage cavern chapel circle citadel commander commercial commodore commonwealth congress console corporate cottage covenant crescent croft dare dean dell diesel dominion draper dune eagle earl easy eden enterprise esquire executive factory fawn finch flicker forge glade government granite gym hale halter hammock hardwood hardy harmony head heron highland hillside hunt hunter hunters inlet international jay jubilee lagoon lakeside lance land landing lead lens light lighthouse limestone link lion loam mace magazine maiden majestic major mallard marathon marina mariner mariners marsh mason melon memorial meridian middle midland military mission monarch monitor mooring noble orchard pace paddock painter parish patent patrician pearl pebble perch pike pilot pleasant plume pope portal presidential priory production progress quail queens quill ransom ray rebel reel regent reservoir resilience rich royale rush sandy security skyline smith standard sterling strand summit sunny sunset sunshine swan sylvan teal terminal tidal tides trinity typo valley victory villa village vista wake walker wall warehouse while widgeon wise worth york'
  ).split(' ')
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

/** Words, with where each starts and ends, and "&" as a word. */
function tokens(t) {
  return [...t.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}]+)?|&/gu)].map((m) => ({ w: m[0].toLowerCase(), raw: m[0], start: m.index, end: m.index + m[0].length }));
}
// Two words belong to one phrase when only spaces, or a period and spaces, sit between them.
const joined = (t, a, b) => /^\.?\s+$/.test(t.slice(a.end, b.start));
const capitalized = (raw) => /^\p{Lu}/u.test(raw);

/**
 * The street that starts at token i, if any: { end, strong }. Strong means it
 * carries a suffix or has more than one word; a bare one-word name counts only
 * when it is capitalized and not an ordinary word.
 */
function streetAt(t, toks, i, names) {
  for (let n = Math.min(4, toks.length - i); n >= 1; n--) {
    const span = toks.slice(i, i + n);
    if (span.some((x, k) => k && !joined(t, span[k - 1], x))) continue;
    const name = span.map((x) => x.w).join(' ');
    if (!names.has(name)) continue;
    const next = toks[i + n];
    if (next && SUFFIXES.has(next.w) && joined(t, span.at(-1), next)) return { end: i + n + 1, strong: true };
    if (n > 1) return { end: i + n, strong: true };
    if (capitalized(span[0].raw) && !COMMON.has(name) && !/^\d/.test(name)) return { end: i + 1, strong: false };
  }
  return null;
}
/** The same, allowing a direction word first ("W 21st St"). */
function streetFrom(t, toks, i, names) {
  const plain = streetAt(t, toks, i, names);
  if (plain) return plain;
  const d = toks[i];
  if (d && DIRECTIONS.has(d.w) && toks[i + 1] && joined(t, d, toks[i + 1])) return streetAt(t, toks, i + 1, names);
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

function numberStreet(t, toks, names) {
  for (let i = 0; i < toks.length - 1; i++) {
    if (!/^\d{1,6}$/.test(toks[i].w) || !joined(t, toks[i], toks[i + 1])) continue;
    if (streetFrom(t, toks, i + 1, names)) return true;
  }
  return false;
}

function intersection(t, toks, names) {
  for (let i = 1; i < toks.length - 1; i++) {
    if (!CONNECTORS.has(toks[i].w) || !joined(t, toks[i - 1], toks[i]) || !joined(t, toks[i], toks[i + 1])) continue;
    const left = streetEndingAt(t, toks, i, names);
    if (!left) continue;
    // A bare one-word name counts only capitalized and not an ordinary word
    // or species, so "cherry and dogwood" or "Birch and Poplar" isn't a corner.
    if (streetFrom(t, toks, i + 1, names)) return true;
  }
  return false;
}

/** A 1-6 digit number, an optional direction, up to 3 words that aren't stop words, then a suffix: "1500 W Bolling Ave". */
function houseNumber(t, toks) {
  for (let i = 0; i < toks.length - 1; i++) {
    if (!/^\d{1,6}$/.test(toks[i].w)) continue;
    let k = i + 1;
    if (DIRECTIONS.has(toks[k].w) && toks[k + 1] && joined(t, toks[k], toks[k + 1])) k++;
    for (let j = k; j < toks.length && j <= k + 3; j++) {
      if (!joined(t, toks[j - 1], toks[j])) break;
      if (SUFFIXES.has(toks[j].w)) return true;
      if (STOP.has(toks[j].w) || !/^\p{L}/u.test(toks[j].w)) break;
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
    const u = withoutCitations(t);
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
  const toks = tokens(t);
  if (houseNumber(t, toks)) out.push('house_number');
  const sl = streetLookup(streets);
  if (sl) {
    if (numberStreet(t, toks, sl.names)) out.push('number_street');
    if (intersection(t, toks, sl.names)) out.push('intersection');
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
