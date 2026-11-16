// Watches over upcoming agendas (Jason, 2026-11-16: "I'd like for people to
// be able to ask something like 'let me know if planning commission or City
// Council take up any items affecting short term rentals' and get an email";
// then "Let's shift from per street to per neighborhood league"). A watch is
// topics from the city's reviewed list, a civic league, or both, over the
// bodies it names. These are the pure parts; the Worker stores watches,
// builds the agenda snapshot, sends the mail and serves the civic-league
// feeds (worker/watches.js).
//
// No people-finding, by construction rather than by guessing at names:
// - Agenda titles can name private people (a buyer of a City lot, a tenant,
//   an applicant). Siren never repeats a title. It describes each item from
//   parts code extracts: the kind of action, the topics it matches, the
//   property's address, its civic league and its ordinance number, and
//   links to the City's own page for the rest. Two independent reviews of
//   an earlier version that withheld names from titles found it leaking
//   in shape after shape; describing is the design that can't.
// - A watch picks topics from the city profile's reviewed list
//   (meetings.watchTopics), never free words, so no watch can be keyed to a
//   person's name. A new topic is a reviewed change to that list.

export const WATCH_DAYS = 365;
/** Agenda items a watch remembers having sent, newest kept. */
export const SEEN_MAX = 400;
export const MAX_TOPICS = 8;
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

/**
 * Check a watch as asked: { topics, civic_league | league, bodies }. Returns
 * { ok: true, watch: { topics, league, bodies } } or { ok: false, error,
 * refused }. `topics` (the option) is the city's reviewed list; `leagues` the
 * civic leagues items are tagged with; `bodies` the bodies a watch may name.
 */
export function checkWatch(input = {}, { topics = [], leagues = [], bodies: allowed = [] } = {}) {
  const ids = new Set(topics.map((t) => t.id));
  const asked = Array.isArray(input.topics) ? input.topics.map((x) => String(x).trim()).filter(Boolean) : [];
  const refused = asked.filter((x) => !ids.has(x)).slice(0, 10).map((x) => x.slice(0, 60));
  const chosen = topics.filter((t) => asked.includes(t.id)).map((t) => t.id);
  if (chosen.length > MAX_TOPICS) return { ok: false, error: `A watch has at most ${MAX_TOPICS} topics.`, refused };
  const askedLeague = String(input.civic_league ?? input.league ?? '').trim();
  let league = null;
  if (askedLeague) {
    league = new Map(leagues.map((l) => [leagueKey(l), l])).get(leagueKey(askedLeague)) || null;
    if (!league) return { ok: false, error: `I don't know a civic league called "${askedLeague.slice(0, 80)}". Use its name as the City's address list gives it.`, refused };
  }
  const askedBodies = Array.isArray(input.bodies) && input.bodies.length ? input.bodies : allowed;
  const bodies = allowed.filter((b) => askedBodies.some((x) => String(x).toLowerCase() === b.toLowerCase()));
  if (!bodies.length) return { ok: false, error: `A watch covers ${allowed.join(' or ')}.`, refused };
  if (!chosen.length && !league) {
    return { ok: false, error: refused.length ? "Those aren't topics a watch can follow yet." : 'A watch needs a topic, a civic league, or both.', refused };
  }
  return { ok: true, watch: { topics: chosen, league, bodies }, refused };
}

/** A watch's one-line description, for the card, the page and the mail. */
export function watchLabel({ topics: ids = [], league = null, bodies = [] } = {}, topics = []) {
  const labels = ids.map((id) => topics.find((t) => t.id === id)?.label || id);
  return `${labels.length ? labels.join(', ') : 'everything'}${league ? ` in ${league}` : ''}, at ${bodies.join(' or ')}`;
}

/**
 * Whether an agenda item matches a watch. `item` is a snapshot item ({ body,
 * topics, leagues }). A watch with topics needs one of them; one with a league
 * needs the item tagged with it; both, when it has both.
 */
export function matchesWatch(watch, item) {
  if (!watch || !item) return false;
  if (!(watch.bodies || []).includes(item.body)) return false;
  if (watch.league && !(item.leagues || []).includes(watch.league)) return false;
  if (!(watch.topics || []).length) return Boolean(watch.league);
  return watch.topics.some((t) => (item.topics || []).includes(t));
}

/** A key for one item on one meeting's agenda. */
export const itemKey = (meetingId, itemId) => `${meetingId}:${itemId}`;

/** The same watch twice (topics in any order, the same league and bodies). */
export function sameWatch(a, b) {
  const k = (w) => JSON.stringify([[...(w.topics || [])].sort(), w.league || null, [...(w.bodies || [])].sort()]);
  return k(a) === k(b);
}

/** What the model is told when it offers a watch. */
export const OFFERED_WATCH_NOTE = 'The person will see a card under your answer to start this watch: they can change the topics, and they confirm it with the email they signed in with. In your answer, say what the watch would follow and that they can start it on the card. Never say it is already set up.';

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
    return { offered: false, note: `${out.error}${out.refused?.length ? ` Not topics: ${out.refused.join(', ')}.` : ''} If nothing on the list fits, say a watch can't follow that yet.` };
  }
  const topics = ctx.watches.topics || [];
  ctx.watchOffer = { ...out.watch, labels: out.watch.topics.map((id) => topics.find((t) => t.id === id)?.label || id), label: watchLabel(out.watch, topics) };
  return { offered: true, watch: ctx.watchOffer, note: OFFERED_WATCH_NOTE };
}
