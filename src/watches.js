// Watches over upcoming agendas (Jason, 2026-11-16: "I'd like for people to
// be able to ask something like 'let me know if planning commission or City
// Council take up any items affecting short term rentals' and get an email";
// then "Let's shift from per street to per neighborhood league"). A watch is
// topics from the city's reviewed list, a civic league, or both, over the
// bodies it names. These are the pure parts; the Worker stores watches,
// builds the agenda snapshot, sends the mail and serves the civic-league
// feeds (worker/watches.js).
//
// No people-finding:
// - Agenda titles can name private people (a buyer of a City lot, a tenant,
//   an applicant). Siren never repeats a title in a feed, an email or a
//   response. It describes each item from parts code extracts: the kind of
//   action, the topics it matches, the property's address, its civic league
//   and its ordinance number, and links to the City's own page for the rest.
//   Two independent reviews of an earlier version that withheld names from
//   titles found it leaking in shape after shape; describing is the design
//   that can't. (The snapshot keeps each title, internally, only to match
//   watch phrases against.)
// - A watch follows topics from the city profile's reviewed list
//   (meetings.watchTopics), and, since a watch belongs to one signed-in
//   member and mails only them (Jason, 2026-11-16: "Free text for signed in
//   and private conversations feels like the right shape"), phrases they
//   write, checked by checkPhrases. That's a guard, not a wall: a rare
//   surname alone ("zelinski") gets through, and works as a search of
//   upcoming titles plus alerts, as find_legislation searches titles in a
//   private conversation.

import { addressKey } from './block.js';
import { extractAddresses } from './adapters/iqm2.js';

export const WATCH_DAYS = 365;
/** Agenda items a watch remembers having sent, newest kept. */
export const SEEN_MAX = 400;
export const MAX_TOPICS = 8;
export const MAX_PHRASES = 5;
export const PHRASE_CHARS = 40;
export const PHRASE_WORDS = 4;
const MAX_ADDRESSES = 3;

/** Text for matching: NFKC, lower case, apostrophes dropped, anything else not a letter or digit a single space. */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** One phrase's pattern on normalized text: its words in order, the last one optionally plural. */
export function termPattern(phrase) {
  const words = normalizeText(phrase).split(' ').filter(Boolean);
  if (!words.length) return null;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${words.map(esc).join(' ')}(?:s|es)?(?= |$)`);
}

const compiled = new WeakMap();
/** The ids of the topics whose phrases occur in an agenda title. */
export function topicsOf(text, topics = []) {
  if (!compiled.has(topics)) compiled.set(topics, topics.map((t) => ({ id: t.id, patterns: t.phrases.map(termPattern).filter(Boolean) })));
  const t = normalizeText(text);
  return compiled.get(topics).filter((x) => x.patterns.some((p) => p.test(t))).map((x) => x.id);
}

// The kind of action an agenda title proposes, first match wins. Fixed labels,
// written here; nothing from the title is carried into them.
const KINDS = [
  [/conditional use permit/i, (t) => (/renewal/i.test(t) ? 'Conditional Use Permit renewal' : 'Conditional Use Permit')],
  [/\brezon|change of zoning|zoning map/i, 'Rezoning'],
  [/development certificate/i, 'Development Certificate'],
  [/text amendment|amend\w*(?:\s+and\s+reordain\w*)?\s+(?:the\s+)?zoning ordinance/i, 'Zoning Ordinance amendment'],
  [/encroach/i, 'Encroachment into a right-of-way'],
  [/sale and conveyance|conveyance to(?!\s+the\s+city)|sale of (?:city|certain)/i, 'Sale of City property'],
  [/\b(?:sub)?lease\b/i, 'Lease'],
  [/easement/i, 'Easement'],
  [/right of entry/i, 'Right of entry'],
  [/clos\w*,?\s+vacat\w*|vacat\w*\s+(?:and\s+discontinu\w*\s+)?(?:a\s+)?(?:portion\s+of\s+)?(?:a\s+)?(?:public\s+)?(?:right.of.way|alley|street)/i, 'Street or alley closure'],
  [/variance/i, 'Variance'],
  [/appropriations? ordinance|annual budget|capital improvement/i, 'Budget or appropriation'],
  [/design review/i, 'Design review'],
  [/\bresolution\b/i, 'Resolution'],
  [/\bordinance\b/i, 'Ordinance'],
];
/** The kind of action, as one of the fixed labels in KINDS, or "Agenda item". */
export function itemKind(text) {
  const t = String(text ?? '');
  for (const [re, label] of KINDS) if (re.test(t)) return typeof label === 'function' ? label(t) : label;
  return 'Agenda item';
}

/** "Ordinance No. 50501" or "Resolution No. 1987", when the title starts with one. */
export function itemNumber(text) {
  const m = /^\s*(Ordinance|Resolution)\s+No\.?\s*([\d,]{1,8})\b/i.exec(String(text ?? ''));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} No. ${m[2].replace(/,/g, '')}` : null;
}

/**
 * A street name as the City's list spells it: upper case, apostrophes
 * dropped, and a leading "St." (which address parsing reads as STREET) as
 * SAINT ("698 St. Paul's Boulevard" is SAINT PAULS on the list).
 */
export function streetCore(street) {
  return String(street ?? '').toUpperCase().replace(/['’]/g, '').replace(/\s+/g, ' ').trim().replace(/^(?:STREET|ST)\s+/, 'SAINT ');
}

/**
 * The addresses a title names whose street is one of the City's: a number
 * and a street from the City's address list (`streets`, the compiled list,
 * src/public-text.js compileStreets). A title's "$5,000 From Mary Lane" or
 * "5 Years With Robert Street" isn't one (reviews of #62), so only a number,
 * a direction, a City street name and its suffix can reach a description.
 * A number with a leading zero (the "000" of "$5,000") is never a house.
 */
export function cityAddresses(addresses = [], streets = null) {
  const names = streets?.names instanceof Set ? streets.names : null;
  if (!names) return [];
  return addresses.filter((a) => {
    const k = addressKey(a);
    return k.num && !/^0/.test(k.num) && k.street && names.has(streetCore(k.street).toLowerCase());
  });
}

/**
 * A title's City-street addresses, with money taken out first: "$5,000
 * Betty Lane Scholarship" names no address, though Betty and Lane are both
 * on the City's street list (fourth review of #62).
 */
export function titleAddresses(title, streets = null) {
  const text = String(title ?? '').replace(/\$\s?[\d,]+(?:\.\d+)?/g, ' ').replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, ' ');
  return cityAddresses(extractAddresses(text), streets);
}

/**
 * How an item reads in a feed or an email: its kind, its topics and its
 * addresses, all from fixed labels and extracted addresses. `item` is a
 * snapshot item ({ kind, topics, addresses }).
 */
export function describeItem(item, topics = []) {
  const kind = normalizeText(item.kind || '');
  // A topic the kind already names ("Encroachment" and "Encroachments into streets…") isn't repeated.
  const labels = (item.topics || []).map((id) => topics.find((t) => t.id === id)?.label).filter(Boolean)
    .filter((l) => !kind.includes(normalizeText(l).split(' ')[0].replace(/s$/, '')));
  const addresses = (item.addresses || []).slice(0, MAX_ADDRESSES);
  const more = (item.addresses || []).length - addresses.length;
  return `${item.kind || 'Agenda item'}${labels.length ? `: ${labels.join(', ')}` : ''}${addresses.length ? `, at ${addresses.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : ''}`;
}

const leagueKey = (s) => normalizeText(s);

// Words that, beside a name, make a phrase about a person or their entity.
const PERSON_WORDS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'jr', 'sr', 'ii', 'iii', 'iv', 'esq', 'llc', 'inc', 'lp', 'llp', 'pllc', 'corp', 'co', 'trust', 'trustee', 'trustees', 'estate', 'family', 'et', 'al', 'heirs']);

/**
 * A member's free-text phrases, checked: { phrases, refused: [{ phrase,
 * reason }] }. Refused, a phrase that:
 * - has a number, an address or contact details (`textCheck(text)`, the
 *   public-text check, true when clean), or names a civic league;
 * - is made only of common first names and surnames (`names`, { surnames,
 *   given } Sets from the Census lists; plurals too: "smiths");
 * - has a common name beside anything but ordinary words (`ordinary`, the
 *   words the City's books use in lower case): "john zelinski", "j smith";
 *   or beside a title or an entity word: "mr smith", "smith llc", "estate
 *   of smith".
 * A rare surname alone ("zelinski") still passes: a guard, not a wall.
 * Without `names`, `ordinary` or `textCheck` no phrase is accepted.
 */
export function checkPhrases(raw, { names = null, ordinary = null, leagues = [], textCheck = null } = {}) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : [];
  const leagueKeys = new Set(leagues.map(leagueKey));
  const phrases = [];
  const refused = [];
  const isName = (w) => [w, w.replace(/s$/, ''), w.replace(/es$/, '')].some((x) => x.length > 1 && (names.surnames.has(x) || names.given.has(x)));
  for (const r of list.slice(0, 20).map((x) => String(x ?? '').slice(0, 200))) {
    const phrase = normalizeText(r);
    if (!phrase || phrases.includes(phrase)) continue;
    const words = phrase.split(' ');
    let reason = null;
    if (phrase.length < 3 || phrase.length > PHRASE_CHARS) reason = `a phrase is 3 to ${PHRASE_CHARS} characters`;
    else if (words.length > PHRASE_WORDS) reason = `a phrase is at most ${PHRASE_WORDS} words`;
    else if (/\d/.test(phrase)) reason = 'a phrase has no numbers (no house numbers or addresses)';
    else if (!names || !ordinary || typeof textCheck !== 'function') reason = "phrases aren't available here";
    else if (leagueKeys.has(phrase)) reason = 'that is a civic league: watch it as the civic league instead';
    else if (words.every(isName)) reason = "that reads as a person's name; watches follow topics and words, not people";
    else if (words.some(isName) && words.some((w) => !isName(w) && (PERSON_WORDS.has(w) || w.length < 2 || !ordinary.has(w)))) reason = "that reads as a person's name; watches follow topics and words, not people";
    else if (!textCheck(String(r))) reason = 'a phrase names no address, person or contact';
    if (reason) refused.push({ phrase: String(r).trim().slice(0, PHRASE_CHARS + 20), reason });
    else phrases.push(phrase);
  }
  return { phrases, refused };
}

/**
 * Check a watch as asked: { topics, civic_league | league, bodies }. Returns
 * { ok: true, watch: { topics, league, bodies } } or { ok: false, error,
 * refused }. `topics` (the option) is the city's reviewed list; `leagues` the
 * civic leagues items are tagged with; `bodies` the bodies a watch may name.
 */
export function checkWatch(input = {}, { topics = [], leagues = [], bodies: allowed = [], names = null, ordinary = null, textCheck = null } = {}) {
  const ids = new Set(topics.map((t) => t.id));
  const asked = Array.isArray(input.topics) ? input.topics.map((x) => String(x).trim()).filter(Boolean) : [];
  const refused = asked.filter((x) => !ids.has(x)).slice(0, 10).map((x) => x.slice(0, 60));
  const chosen = topics.filter((t) => asked.includes(t.id)).map((t) => t.id);
  if (chosen.length > MAX_TOPICS) return { ok: false, error: `A watch has at most ${MAX_TOPICS} topics.`, refused };
  const { phrases, refused: refusedPhrases } = checkPhrases(input.phrases, { names, ordinary, leagues, textCheck });
  if (phrases.length > MAX_PHRASES) return { ok: false, error: `A watch has at most ${MAX_PHRASES} phrases.`, refused, refusedPhrases };
  const askedLeague = String(input.civic_league ?? input.league ?? '').trim();
  let league = null;
  if (askedLeague) {
    league = new Map(leagues.map((l) => [leagueKey(l), l])).get(leagueKey(askedLeague)) || null;
    if (!league) return { ok: false, error: `I don't know a civic league called "${askedLeague.slice(0, 80)}". Use its name as the City's address list gives it.`, refused };
  }
  const askedBodies = Array.isArray(input.bodies) && input.bodies.length ? input.bodies : allowed;
  const bodies = allowed.filter((b) => askedBodies.some((x) => String(x).toLowerCase() === b.toLowerCase()));
  if (!bodies.length) return { ok: false, error: `A watch covers ${allowed.join(' or ')}.`, refused, refusedPhrases };
  if (!chosen.length && !phrases.length && !league) {
    const error = refusedPhrases.length ? 'None of those phrases can be watched.' : refused.length ? "Those aren't topics a watch can follow yet." : 'A watch needs a topic, a phrase, a civic league, or a mix.';
    return { ok: false, error, refused, refusedPhrases };
  }
  return { ok: true, watch: { topics: chosen, phrases, league, bodies }, refused, refusedPhrases };
}

/** A watch's one-line description, for the card, the page and the mail. */
export function watchLabel({ topics: ids = [], phrases = [], league = null, bodies = [] } = {}, topics = []) {
  const labels = [...ids.map((id) => topics.find((t) => t.id === id)?.label || id), ...(phrases || []).map((p) => `"${p}"`)];
  return `${labels.length ? labels.join(', ') : 'everything'}${league ? ` in ${league}` : ''}, at ${bodies.join(' or ')}`;
}

/** The watch's phrases an item's title holds. */
export function phrasesIn(watch, item) {
  const t = normalizeText(item?.title);
  return (watch?.phrases || []).filter((p) => termPattern(p)?.test(t));
}

/**
 * Whether an agenda item matches a watch. `item` is a snapshot item ({ body,
 * topics, title, leagues }). A watch with topics or phrases needs one of them
 * (a topic in the item's topics, or a phrase in its title); one with a league
 * needs the item tagged with it; both, when it has both.
 */
export function matchesWatch(watch, item) {
  if (!watch || !item) return false;
  if (!(watch.bodies || []).includes(item.body)) return false;
  if (watch.league && !(item.leagues || []).includes(watch.league)) return false;
  if (!(watch.topics || []).length && !(watch.phrases || []).length) return Boolean(watch.league);
  return (watch.topics || []).some((t) => (item.topics || []).includes(t)) || phrasesIn(watch, item).length > 0;
}

/** A key for one item on one meeting's agenda. */
export const itemKey = (meetingId, itemId) => `${meetingId}:${itemId}`;

/** The same watch twice (topics in any order, the same league and bodies). */
export function sameWatch(a, b) {
  const k = (w) => JSON.stringify([[...(w.topics || [])].sort(), [...(w.phrases || [])].sort(), w.league || null, [...(w.bodies || [])].sort()]);
  return k(a) === k(b);
}

/** What the model is told when it offers a watch. */
export const OFFERED_WATCH_NOTE = 'The person will see a card under your answer to start this watch: they can change the topics and phrases, and they confirm it with the email they signed in with. In your answer, say what the watch would follow and that they can start it on the card. Never say it is already set up.';

/**
 * offer_watch's executor. `ctx.watches.check(args)` is the Worker's checker
 * (checkWatch with this city's topics, civic leagues and bodies) and
 * `ctx.watches.topics` the list. One offer an answer; the watch itself is
 * made only by the person's click.
 */
export function offerWatch(ctx, args = {}) {
  if (!ctx.watches?.check) return { offered: false, note: 'Watches are not available here.' };
  if (ctx.watchOffer) return { offered: true, note: 'A watch is already offered for this answer.' };
  const out = ctx.watches.check(args);
  if (!out.ok) {
    const phrases = (out.refusedPhrases || []).map((r) => `"${r.phrase}": ${r.reason}`).join('; ');
    return { offered: false, note: `${out.error}${out.refused?.length ? ` Not topics: ${out.refused.join(', ')}.` : ''}${phrases ? ` Refused phrases: ${phrases}.` : ''} Use a topic from the list, or a few plain words agenda titles would use; never a person's name.` };
  }
  const topics = ctx.watches.topics || [];
  ctx.watchOffer = { ...out.watch, labels: out.watch.topics.map((id) => topics.find((t) => t.id === id)?.label || id), label: watchLabel(out.watch, topics) };
  return { offered: true, watch: ctx.watchOffer, note: OFFERED_WATCH_NOTE };
}
