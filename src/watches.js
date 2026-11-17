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
// - Addresses and civic leagues come from the City's address list
//   (compileAddresses; Jason, 2026-11-16: "A trie whitelist built from the
//   address db"): an address reaches a description only when its house
//   number is on that street there, and a street's name in a watch matches
//   items by their listed address, never a title's words.
// - A watch follows topics from the city profile's reviewed list
//   (meetings.watchTopics), and, since a watch belongs to one signed-in
//   member and mails only them (Jason, 2026-11-16: "Free text for signed in
//   and private conversations feels like the right shape"), phrases they
//   write, checked by checkPhrases. That's a guard, not a wall: a rare
//   surname alone ("zelinski") gets through, and works as a search of
//   upcoming titles plus alerts, as find_legislation searches titles in a
//   private conversation.

import { extractAddresses, normalizeAddress } from './adapters/iqm2.js';

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

/** The address list's own word for an address in no civic league (checked 2026-11-16). */
export const NO_LEAGUE = /^no civic league$/i;

/**
 * A street as the address list is matched: upper case, abbreviations
 * expanded (ST is STREET, E is EAST), apostrophes dropped, and a leading
 * "St." read as SAINT ("698 St. Paul's Boulevard" is on the list as SAINT
 * PAULS BOULEVARD).
 */
export function streetKey(street) {
  const w = normalizeAddress(String(street ?? '').replace(/['’]/g, '')).split(' ').filter(Boolean);
  if (w.length >= 2 && w[0] === 'STREET') w[0] = 'SAINT';
  return w.join(' ');
}

/** One row of the City's address list ("1000 E BAYVIEW BOULEVARD") as { num, street }, the street as the list spells it; null without a house number ("NO ADDRESS"). */
export function cityAddressParts(full) {
  const w = String(full ?? '').toUpperCase().replace(/\s+/g, ' ').trim().split(' ');
  if (w.length < 2 || !/^[1-9]\d*[A-Z]?$/.test(w[0])) return null;
  return { num: w[0], street: w.slice(1).join(' ') };
}

const DIRECTIONS = new Set(['NORTH', 'SOUTH', 'EAST', 'WEST']);
// The street types the address list ends a street with (read 2026-11-16).
const STREET_TYPES = new Set('AVENUE STREET ROAD DRIVE BOULEVARD COURT CIRCLE CRESCENT PLACE LANE TERRACE WAY PARKWAY ARCH HIGHWAY GARDENS LOOP PARK SQUARE MEWS TRAIL POINT RUN QUARTER LANDING QUAY CHASE TURN COVE LAIR OVERLOOK TUNNEL END CROSS'.split(' '));

/**
 * The ways a member might name a street of the list, as streetKey keys
 * them: in full ("EAST VIRGINIA BEACH BOULEVARD"), without its type ("EAST
 * VIRGINIA BEACH"), without its direction ("VIRGINIA BEACH BOULEVARD"), or
 * without both ("VIRGINIA BEACH"). Never fewer than one word: "WEST AVENUE"
 * is never "AVENUE".
 */
export function streetForms(street) {
  const full = streetKey(street).split(' ').filter(Boolean);
  const forms = new Set();
  const add = (w) => {
    forms.add(w.join(' '));
    if (w.length > 1 && STREET_TYPES.has(w.at(-1))) forms.add(w.slice(0, -1).join(' '));
  };
  add(full);
  let w = full;
  if (w.length > 2 && DIRECTIONS.has(w[0])) w = w.slice(1);
  if (w.length > 2 && DIRECTIONS.has(w.at(-1))) w = w.slice(0, -1);
  add(w);
  return [...forms];
}

/**
 * The city's address list (data/<city>-addresses.json, built by
 * scripts/build-addresses.js) compiled for lookups, or null. Jason,
 * 2026-11-16: "A trie whitelist built from the address db". Street, then
 * house number: each street's numbers are parsed the first time it's asked
 * about.
 * - find(num, street): the address's { street (as the list spells it),
 *   leagues } when that number is on that street, else null. Exact but for
 *   a direction: one the title adds when the list has no street of that
 *   direction, or one it leaves out when only one direction of that street
 *   has that number. Never a near miss in the name or the number.
 * - street(phrase): the street form a phrase is (streetForms), or null.
 * - leagues: the civic leagues the list names.
 */
export function compileAddresses(file) {
  if (!file?.streets || typeof file.streets !== 'object' || !Array.isArray(file.leagues)) return null;
  const byKey = new Map();
  const forms = new Set();
  for (const s of Object.keys(file.streets)) {
    const k = streetKey(s);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s);
    for (const f of streetForms(s)) forms.add(f);
  }
  const parsed = new Map();
  const numbers = (s) => {
    if (!parsed.has(s)) {
      const m = new Map();
      for (const tok of String(file.streets[s]).split(' ')) {
        if (!tok) continue;
        const [n, ls = ''] = tok.split(':');
        m.set(n, ls ? ls.split(',').map((i) => file.leagues[Number(i)]).filter(Boolean) : []);
      }
      parsed.set(s, m);
    }
    return parsed.get(s);
  };
  return Object.freeze({
    leagues: Object.freeze([...file.leagues]),
    built: file.built || null,
    find(num, street) {
      const n = String(num ?? '').toUpperCase();
      if (!/^[1-9]\d*[A-Z]?$/.test(n)) return null;
      const on = (key) => (byKey.get(key) || []).flatMap((s) => (numbers(s).has(n) ? [{ street: s, leagues: [...numbers(s).get(n)] }] : []));
      const key = streetKey(street);
      const exact = on(key);
      if (exact.length) return exact[0];
      const w = key.split(' ');
      // A direction the list doesn't give ("628 West 35th Street" is 628 35TH STREET on it).
      // Only when the list has no street of that direction: "102 North Blake Road" isn't 102 BLAKE ROAD,
      // since NORTH BLAKE ROAD is a street of its own (review of #62).
      if (w.length > 2 && DIRECTIONS.has(w[0])) return byKey.has(key) ? null : on(w.slice(1).join(' '))[0] || null;
      // A direction the title leaves out ("482 Main Street" is 482 E MAIN STREET), only when one direction has that number.
      const one = [...DIRECTIONS].flatMap((d) => on(`${d} ${key}`));
      return one.length === 1 ? one[0] : null;
    },
    street(phrase) {
      const k = streetKey(phrase);
      return k && forms.has(k) ? k : null;
    },
  });
}

// "4211 Colley Avenue" as { num, street }; null without a house number first.
function splitAddress(a) {
  const m = /^\s*(\d+[A-Za-z]?)\s+(.+)$/.exec(String(a ?? ''));
  return m ? { num: m[1], street: m[2] } : null;
}

/**
 * The addresses (as written) whose house number is on that street in the
 * City's address list (`book`, compileAddresses). A title's "$5,000 From
 * Mary Lane" or "5 Years With Robert Street" isn't one (reviews of #62), so
 * only a City address can reach a description. No list, no addresses.
 */
export function cityAddresses(addresses = [], book = null) {
  if (!book?.find) return [];
  return addresses.filter((a) => {
    const p = splitAddress(a);
    return Boolean(p && book.find(p.num, p.street));
  });
}

/**
 * The places a title names, each checked against the City's address list:
 * { addresses (as the title writes them), streets (as the list spells
 * them), leagues }, from the first `max` listed addresses. Money comes out
 * first: "$5,000 Betty Lane Scholarship" names no address (fourth review of
 * #62).
 */
export function titlePlaces(title, book = null, { max = Infinity } = {}) {
  const out = { addresses: [], streets: [], leagues: [] };
  if (!book?.find) return out;
  const text = String(title ?? '').replace(/\$\s?[\d,]+(?:\.\d+)?/g, ' ').replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, ' ');
  for (const a of extractAddresses(text)) {
    if (out.addresses.length >= max) break;
    const p = splitAddress(a);
    const hit = p && book.find(p.num, p.street);
    if (!hit) continue;
    out.addresses.push(a);
    if (!out.streets.includes(hit.street)) out.streets.push(hit.street);
    for (const l of hit.leagues) if (!out.leagues.includes(l)) out.leagues.push(l);
  }
  return out;
}

/** A title's City addresses, as written (titlePlaces). */
export function titleAddresses(title, book = null) {
  return titlePlaces(title, book).addresses;
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

/** A street phrase as a label: "21st street" reads 21st Street. */
export const streetLabel = (phrase) => String(phrase ?? '').replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase());

/**
 * A member's free-text phrases, checked: { phrases, streets, refused: [{
 * phrase, reason }] }. Refused, a phrase that:
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
 *
 * Many streets are named for people (Jason, 2026-11-16: "How do we know
 * we're not getting false positives on names"), so a phrase refused only for
 * reading as a name or holding a number, that is a street of the City's
 * address list (`book`, compileAddresses: "hampton", "21st street"), is kept
 * in `streets`. A street phrase matches only items whose address is on the
 * list and on that street, never a title's words, so it can't follow a
 * person of that name. A phrase that passes stays a phrase, matched in
 * titles ("granby" catches "Granby Street streetscape"), and, when it names
 * a street with its type ("hampton boulevard"), by listed address too.
 */
export function checkPhrases(raw, { names = null, ordinary = null, leagues = [], textCheck = null, book = null } = {}) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : [];
  const leagueKeys = new Set(leagues.map(leagueKey));
  const phrases = [];
  const streets = [];
  const refused = [];
  const isName = (w) => [w, w.replace(/s$/, ''), w.replace(/es$/, '')].some((x) => x.length > 1 && (names.surnames.has(x) || names.given.has(x)));
  const NAME = "that reads as a person's name; watches follow topics and words, not people";
  for (const r of list.slice(0, 20).map((x) => String(x ?? '').slice(0, 200))) {
    const phrase = normalizeText(r);
    if (!phrase || phrases.includes(phrase) || streets.includes(phrase)) continue;
    const words = phrase.split(' ');
    let reason = null;
    let street = false;
    if (phrase.length < 3 || phrase.length > PHRASE_CHARS) reason = `a phrase is 3 to ${PHRASE_CHARS} characters`;
    else if (words.length > PHRASE_WORDS) reason = `a phrase is at most ${PHRASE_WORDS} words`;
    else if (!names || !ordinary || typeof textCheck !== 'function') reason = "phrases aren't available here";
    else if (leagueKeys.has(phrase)) reason = 'that is a civic league: watch it as the civic league instead';
    else {
      if (/\d/.test(phrase)) reason = 'a phrase has no numbers (no house numbers or addresses)';
      else if (words.every(isName)) reason = NAME;
      else if (words.some(isName) && words.some((w) => !isName(w) && (PERSON_WORDS.has(w) || w.length < 2 || !ordinary.has(w)))) reason = NAME;
      // Only a name or a number: a street's name is watched as that street.
      street = Boolean(reason && book?.street?.(phrase));
      if (!reason && !textCheck(String(r))) reason = 'a phrase names no address, person or contact';
    }
    if (street) streets.push(phrase);
    else if (reason) refused.push({ phrase: String(r).trim().slice(0, PHRASE_CHARS + 20), reason });
    else phrases.push(phrase);
  }
  return { phrases, streets, refused };
}

/**
 * Check a watch as asked: { topics, phrases, civic_league | league, bodies }.
 * Returns { ok: true, watch: { topics, phrases, streets, league, bodies } }
 * or { ok: false, error, refused }. `topics` (the option) is the city's
 * reviewed list; `leagues` the civic leagues of its address list; `bodies`
 * the bodies a watch may name; `book` the address list, for street phrases.
 */
export function checkWatch(input = {}, { topics = [], leagues = [], bodies: allowed = [], names = null, ordinary = null, textCheck = null, book = null } = {}) {
  const ids = new Set(topics.map((t) => t.id));
  const asked = Array.isArray(input.topics) ? input.topics.map((x) => String(x).trim()).filter(Boolean) : [];
  const refused = asked.filter((x) => !ids.has(x)).slice(0, 10).map((x) => x.slice(0, 60));
  const chosen = topics.filter((t) => asked.includes(t.id)).map((t) => t.id);
  if (chosen.length > MAX_TOPICS) return { ok: false, error: `A watch has at most ${MAX_TOPICS} topics.`, refused };
  const { phrases, streets, refused: refusedPhrases } = checkPhrases(input.phrases, { names, ordinary, leagues, textCheck, book });
  if (phrases.length + streets.length > MAX_PHRASES) return { ok: false, error: `A watch has at most ${MAX_PHRASES} phrases and streets.`, refused, refusedPhrases };
  const askedLeague = String(input.civic_league ?? input.league ?? '').trim();
  let league = null;
  if (askedLeague) {
    league = new Map(leagues.map((l) => [leagueKey(l), l])).get(leagueKey(askedLeague)) || null;
    if (!league) return { ok: false, error: `I don't know a civic league called "${askedLeague.slice(0, 80)}". Use its name as the City's address list gives it.`, refused };
  }
  const askedBodies = Array.isArray(input.bodies) && input.bodies.length ? input.bodies : allowed;
  const bodies = allowed.filter((b) => askedBodies.some((x) => String(x).toLowerCase() === b.toLowerCase()));
  if (!bodies.length) return { ok: false, error: `A watch covers ${allowed.join(' or ')}.`, refused, refusedPhrases };
  if (!chosen.length && !phrases.length && !streets.length && !league) {
    const error = refusedPhrases.length ? 'None of those phrases can be watched.' : refused.length ? "Those aren't topics a watch can follow yet." : 'A watch needs a topic, a phrase, a street, a civic league, or a mix.';
    return { ok: false, error, refused, refusedPhrases };
  }
  return { ok: true, watch: { topics: chosen, phrases, streets, league, bodies }, refused, refusedPhrases };
}

/** A watch's one-line description, for the card, the page and the mail. */
export function watchLabel({ topics: ids = [], phrases = [], streets = [], league = null, bodies = [] } = {}, topics = []) {
  const labels = [...ids.map((id) => topics.find((t) => t.id === id)?.label || id), ...(phrases || []).map((p) => `"${p}"`), ...(streets || []).map((s) => `${streetLabel(s)} (street)`)];
  return `${labels.length ? labels.join(', ') : 'everything'}${league ? ` in ${league}` : ''}, at ${bodies.join(' or ')}`;
}

/** The watch's phrases an item's title holds. */
export function phrasesIn(watch, item) {
  const t = normalizeText(item?.title);
  return (watch?.phrases || []).filter((p) => termPattern(p)?.test(t));
}

// A phrase that names a street with its type ("hampton boulevard", "colley ave").
const namesStreet = (phrase) => {
  const w = streetKey(phrase).split(' ');
  return w.length > 1 && STREET_TYPES.has(w.at(-1));
};

/**
 * The watch's streets an item's listed addresses are on (item.streets, as
 * the address list spells them): its street watches, and its phrases that
 * name a street with its type ("hampton boulevard" is matched in titles and
 * by listed address both; review of #62).
 */
export function streetsIn(watch, item) {
  const forms = new Set((item?.streets || []).flatMap(streetForms));
  return [...(watch?.streets || []), ...(watch?.phrases || []).filter(namesStreet)].filter((s) => forms.has(streetKey(s)));
}

/**
 * Whether an agenda item matches a watch. `item` is a snapshot item ({ body,
 * topics, title, streets, leagues }). A watch with topics, phrases or
 * streets needs one of them (a topic in the item's topics, a phrase in its
 * title, a street its listed address is on, which a phrase naming a street
 * with its type also counts as); one with a league needs the item tagged
 * with it; both, when it has both.
 */
export function matchesWatch(watch, item) {
  if (!watch || !item) return false;
  if (!(watch.bodies || []).includes(item.body)) return false;
  if (watch.league && !(item.leagues || []).includes(watch.league)) return false;
  if (!(watch.topics || []).length && !(watch.phrases || []).length && !(watch.streets || []).length) return Boolean(watch.league);
  return (watch.topics || []).some((t) => (item.topics || []).includes(t)) || phrasesIn(watch, item).length > 0 || streetsIn(watch, item).length > 0;
}

/** A key for one item on one meeting's agenda. */
export const itemKey = (meetingId, itemId) => `${meetingId}:${itemId}`;

/** The same watch twice (topics, phrases and streets in any order, the same league and bodies). */
export function sameWatch(a, b) {
  const k = (w) => JSON.stringify([[...(w.topics || [])].sort(), [...(w.phrases || [])].sort(), [...(w.streets || [])].sort(), w.league || null, [...(w.bodies || [])].sort()]);
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
