// Checks on text that could be shown in public: residents' questions and
// source-request notes, steward notes, general questions, action text and
// bot text (docs/gaps.md §6.3). They keep places finer than the city, contact
// details and people out. Text checks catch mistakes, not malice; residents'
// words still go through the steward.
//
// publicTextViolations blocks; publicTextFlags only hints to the steward.
// Neither ever echoes the text back: refusals say what to change.

import { ruleA } from './gaps/kinds.js';

const SUFFIX = '(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|cir|circle|pl|place|ter|terrace|way|pkwy|parkway|hwy|highway|cres|crescent|sq|square|trl|trail|row|walk|mews|plz|plaza|pike|run|xing|crossing|ext|landing|loop|pt|point|arch|key|quay|bend|grn|green)';
const DIRECTION = '(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)';
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

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Single-word street names that are also ordinary English words count as a
// street only with a suffix after them ("Park Ave", not "park").
const COMMON = new Set(
  'park church main city hall water tree trees forest wood woods river bay lake shore beach ocean view hill hills spring summer winter fall field fields garden gardens grove meadow mill pine oak elm maple cedar willow holly magnolia laurel ivy rose lee virginia college school court ward union market bank bridge station harbor port point state county national liberty freedom hope grace faith may june west east north south center central first second third fourth fifth sixth seventh eighth ninth tenth high low long short wide broad little big old new end way ridge cove creek glen dale haven brook knoll terrace place square plaza row green white black brown gray red blue orange gold silver king queen prince princess duke lord general admiral federal'.split(' ')
);

/** Compile a street list (bare names, e.g. "OCEAN VIEW") into the patterns the checks use. */
export function compileStreets(streets = []) {
  const names = [...new Set((streets || []).map((s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ')).filter((s) => s.length >= 2))];
  if (!names.length) return null;
  names.sort((a, b) => b.length - a.length);
  const bare = names.filter((n) => n.includes(' ') || !COMMON.has(n));
  const withSuffix = names;
  const alt = (xs) => xs.map((n) => esc(n).replace(/ /g, '\\s+')).join('|');
  const street = `(?:(?:${alt(withSuffix)})\\s+${SUFFIX}\\b\\.?${bare.length ? `|(?:${alt(bare)})\\b` : ''})`;
  return {
    numberStreet: new RegExp(`\\b\\d{1,6}\\s+(?:${DIRECTION}\\.?\\s+)?${street}`, 'i'),
    intersection: new RegExp(`\\b${street}\\s+(?:and|&|at)\\s+(?:${DIRECTION}\\.?\\s+)?${street}`, 'i'),
  };
}
const compiled = new WeakMap();
function streetPatterns(streets) {
  if (!streets) return null;
  if (typeof streets === 'object' && !Array.isArray(streets) && streets.numberStreet) return streets;
  if (!compiled.has(streets)) compiled.set(streets, compileStreets(streets));
  return compiled.get(streets);
}

function houseNumber(t) {
  const re = new RegExp(`\\b(\\d{1,6})\\s+(?:${DIRECTION}\\.?\\s+)?((?:[a-z][a-z'.-]*\\s+){0,3})${SUFFIX}\\b`, 'gi');
  for (const m of t.matchAll(re)) {
    const words = (m[2] || '').trim().split(/\s+/).filter(Boolean);
    if (words.some((w) => STOP.has(w.toLowerCase()))) continue;
    return true;
  }
  return false;
}

const ROLE_NOUNS = 'forester|manager|director|council ?member|councilman|councilwoman|councillor|mayor|clerk|chair(?:man|woman|person)?|inspector|supervisor|superintendent|commissioner|operator|crew|worker|employee|arborist';
const PEOPLE = new RegExp(
  `\\b(?:neighbou?rs?|residents?|owners?|tenants?|renters?|landlords?|homeowners?|households?|family|families|occupants?|applicants?|requesters?|requestors?|complainants?|callers?|people|folks|someone|somebody|anyone|anybody|whoever|he|she|him|his|her|hers|${ROLE_NOUNS})\\b`,
  'gi'
);

const BLOCKS = [
  ['block_of', (t) => /\bblock of\b/i.test(t)],
  ['unit', (t) => /\b(?:apt|apartment|unit|suite|ste)\.?\s*#?\s*\d+|#\s*\d+/i.test(t)],
  ['email', (t) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t)],
  ['phone', (t) => /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}\b/.test(t)],
  ['mention', (t) => /(?:^|[\s(])@[a-z0-9_][a-z0-9_.-]{1,}/i.test(t)],
  ['link', (t) => /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|gov|edu|io|us|info|me|co|ly|app|social)\b/i.test(t)],
  ['long_number', (t) => /\b\d{7,}\b/.test(t.replace(/,/g, '')) || [...t.matchAll(/\b\d+(?:-\d+)+\b/g)].some((m) => !/^\d{4}-\d{2}-\d{2}$/.test(m[0]) && !/^(?:19|20)\d{2}-(?:19|20)?\d{2}$/.test(m[0]))],
  ['coordinates', (t) => /-?\b\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/.test(t)],
  ['parcel_grain', (t) => /\b(?:my|your|their|his|her|this|that)\s+(?:house|home|parcel|property|lot|yard|driveway|address|apartment)\b/i.test(t)],
  ['person_pointing', (t) => /\bwho\s+(?:lives|lived|owns|owned|called|complained|reported|filed|asked|applied|requested|put in)\b|\bwhose\b|\bwhich\s+(?:neighbou?r|resident|household|family)/i.test(t)],
  ['named_person', (t) => /\b(?:Mr|Mrs|Ms|Mx|Dr|Miss)\.?\s+[A-Z][a-z]/.test(t)],
  ['role_blame', (t) => new RegExp(`\\bwhy did (?:the )?(?:${ROLE_NOUNS})\\b`, 'i').test(t)],
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
  if (houseNumber(t)) out.push('house_number');
  const sp = streetPatterns(streets);
  if (sp) {
    if (sp.numberStreet.test(t)) out.push('number_street');
    if (sp.intersection.test(t)) out.push('intersection');
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
