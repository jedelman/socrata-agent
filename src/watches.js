// Watches over upcoming agendas (Jason, 2026-11-16: "I'd like for people to
// be able to ask something like 'let me know if planning commission or City
// Council take up any items affecting short term rentals' and get an email";
// then "Let's shift from per street to per neighborhood league"). A watch is
// topic terms, a civic league, or both, over the bodies it names. These are
// the pure parts: checking a watch, withholding applicants' names, matching
// items. The Worker stores watches, builds the agenda snapshot, sends the
// mail and serves the civic-league feeds (worker/watches.js).
//
// No people-finding: a term must be words from Norfolk's Zoning Ordinance and
// adopted budget books (the vocabulary telemetry uses, which holds no common
// surname) and pass the public-text checks; it can't be a street (watch the
// civic league instead) or a house number. And items are matched on their
// title with a private applicant's name already withheld, so a name can't
// match even if it slipped through as a word.

import { ORG } from './adapters/iqm2.js';
import { publicTextViolations } from './public-text.js';

export const MAX_TERMS = 8;
export const TERM_CHARS = 40;
export const TERM_WORDS = 4;
/** How long a watch runs before it has to be renewed. */
export const WATCH_DAYS = 365;
/** Agenda items a watch remembers having sent, newest kept. */
export const SEEN_MAX = 400;
export const WITHHELD = "[applicant's name withheld]";

// Words under four letters aren't in the vocabulary; these are allowed in a term.
const SHORT = new Set(['bed', 'gym', 'oil', 'and', 'of', 'the', 'for', 'use', 'adu', 'bar', 'inn', 'spa', 'pub', 'art', 'day', 'car', 'lot', 'tax', 'new', 'bay', 'sea']);
const SUFFIX = /\s(?:street|st|avenue|ave|av|boulevard|blvd|road|rd|drive|dr|lane|ln|court|ct|circle|cir|place|pl|way|terrace|ter|parkway|pkwy|highway|hwy|crescent|square|trail|arch|landing|point|quay|run|walk)$/;

/** Text for matching: NFKC, lower case, apostrophes dropped, anything else not a letter or digit a single space. */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const COURTESY = /\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+(?:[A-Z][A-Za-z'-]+\s?){1,3}/g;

/**
 * An agenda title with a private applicant's name withheld, by the rule
 * get_legislation's cover letter follows (src/adapters/iqm2.js): an applicant
 * that isn't plainly an organization is withheld, and so is a name after a
 * courtesy title. Planning Commission titles open with the applicant
 * ("JANE DOE, for a Conditional Use Permit …"); Council ordinances name the
 * property instead.
 */
export function withholdApplicant(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.{2,160}?),\s+for\s+(?=(?:a|an|the|following|conditional|rezoning|change|text|amendment|design)\b)/i.exec(t);
  if (m && !ORG.test(m[1])) t = `${WITHHELD}, for ${t.slice(m[0].length)}`;
  return t.replace(COURTESY, `${WITHHELD} `).replace(/\s+/g, ' ').trim();
}

/** One term's pattern on normalized text: its words in order, the last one optionally plural. */
export function termPattern(term) {
  const words = normalizeText(term).split(' ').filter(Boolean);
  if (!words.length) return null;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^| )${words.map(esc).join(' ')}(?:s|es)?(?= |$)`);
}

const leagueKey = (s) => normalizeText(s);

/**
 * Check a watch as asked: { terms, civic_league | league, bodies }. Returns
 * { ok: true, watch: { terms, league, bodies } } or { ok: false, error,
 * refused: [{ term, reason }] }. `vocab` is a Set of lower-case words;
 * `streets` the city's street names (data/gaps/<city>-streets.json); `leagues`
 * the civic leagues items are tagged with; `bodies` the bodies a watch may name.
 */
export function checkWatch(input = {}, { vocab, streets, leagues = [], bodies: allowed = [] } = {}) {
  const raw = Array.isArray(input.terms) ? input.terms : typeof input.terms === 'string' ? input.terms.split(/[,;\n]/) : [];
  const refused = [];
  const terms = [];
  // The compiled list the Worker keeps (src/public-text.js compileStreets: lower case, with and without a suffix), or raw names.
  const streetNames = streets?.names instanceof Set
    ? streets.names
    : new Set((Array.isArray(streets?.streets) ? streets.streets : Array.isArray(streets) ? streets : []).map((s) => normalizeText(s)));
  const leagueByKey = new Map(leagues.map((l) => [leagueKey(l), l]));
  for (const r of raw.slice(0, 20)) {
    const term = normalizeText(r);
    if (!term) continue;
    if (terms.includes(term)) continue;
    const words = term.split(' ');
    let reason = null;
    if (term.length < 3 || term.length > TERM_CHARS) reason = `a term is 3 to ${TERM_CHARS} characters`;
    else if (words.length > TERM_WORDS) reason = `a term is at most ${TERM_WORDS} words`;
    else if (/\d/.test(term)) reason = 'a term has no numbers (no house numbers or addresses)';
    else if (leagueByKey.has(term)) reason = 'that is a civic league: watch it as the civic league instead';
    else if (SUFFIX.test(term) && streetNames.has(term.replace(SUFFIX, ''))) reason = 'that is a street: watch its civic league instead';
    else if (words.some((w) => !(w.length >= 4 ? vocab?.has(w) : SHORT.has(w)))) reason = "a term is words the City's Zoning Ordinance or budget books use, never a name";
    else if (publicTextViolations(r, { streets }).length) reason = 'a term names no address, person or contact';
    if (reason) refused.push({ term: String(r).trim().slice(0, TERM_CHARS + 20), reason });
    else terms.push(term);
  }
  if (terms.length > MAX_TERMS) return { ok: false, error: `A watch has at most ${MAX_TERMS} terms.`, refused };
  const askedLeague = String(input.civic_league ?? input.league ?? '').trim();
  let league = null;
  if (askedLeague) {
    league = leagueByKey.get(leagueKey(askedLeague)) || null;
    if (!league) return { ok: false, error: `I don't know a civic league called "${askedLeague.slice(0, 80)}". Use its name as the City's address list gives it.`, refused };
  }
  const askedBodies = Array.isArray(input.bodies) && input.bodies.length ? input.bodies : allowed;
  const bodies = allowed.filter((b) => askedBodies.some((x) => String(x).toLowerCase() === b.toLowerCase()));
  if (!bodies.length) return { ok: false, error: `A watch covers ${allowed.join(' or ')}.`, refused };
  if (!terms.length && !league) {
    return { ok: false, error: refused.length ? 'None of those terms can be watched.' : 'A watch needs a topic term, a civic league, or both.', refused };
  }
  return { ok: true, watch: { terms, league, bodies }, refused };
}

/** A watch's one-line description, for the card, the page and the mail. */
export function watchLabel({ terms = [], league = null, bodies = [] } = {}) {
  const what = terms.length ? terms.map((t) => `"${t}"`).join(', ') : 'anything';
  return `${what}${league ? ` in ${league}` : ''}, at ${bodies.join(' or ')}`;
}

/**
 * Whether an agenda item matches a watch. `item` is { body, text (already
 * withheld), leagues }. A watch with terms needs one of them in the text; one
 * with a league needs the item tagged with it; both, when it has both.
 */
export function matchesWatch(watch, item) {
  if (!watch || !item) return false;
  if (!(watch.bodies || []).includes(item.body)) return false;
  if (watch.league && !(item.leagues || []).includes(watch.league)) return false;
  if (!(watch.terms || []).length) return Boolean(watch.league);
  const text = normalizeText(item.text);
  return watch.terms.some((t) => termPattern(t)?.test(text));
}

/** A key for one item on one meeting's agenda. */
export const itemKey = (meetingId, itemId) => `${meetingId}:${itemId}`;

/** The same watch twice (terms in any order, the same league and bodies). */
export function sameWatch(a, b) {
  const k = (w) => JSON.stringify([[...(w.terms || [])].sort(), w.league || null, [...(w.bodies || [])].sort()]);
  return k(a) === k(b);
}

/** The offer card's limits, and what the model is told. */
export const OFFERED_WATCH_NOTE = 'The person will see a card under your answer to start this watch: they can change the terms, and they confirm it with the email they signed in with. In your answer, say what the watch would look for and that they can start it on the card. Never say it is already set up.';

/**
 * offer_watch's executor. `ctx.watches.check(args)` is the Worker's checker
 * (checkWatch with this city's vocabulary, streets and civic leagues). One
 * offer an answer; the watch itself is made only by the person's click.
 */
export function offerWatch(ctx, args = {}) {
  if (!ctx.watches?.check) return { offered: false, note: 'Watches are not available here.' };
  if (ctx.watchOffer) return { offered: true, note: 'A watch is already offered for this answer.' };
  const out = ctx.watches.check(args);
  if (!out.ok) {
    const refused = (out.refused || []).map((r) => `"${r.term}": ${r.reason}`).join('; ');
    return { offered: false, note: `${out.error}${refused ? ` Refused: ${refused}.` : ''}` };
  }
  ctx.watchOffer = { ...out.watch, label: watchLabel(out.watch) };
  const refused = (out.refused || []).map((r) => `"${r.term}" (${r.reason})`).join(', ');
  return { offered: true, watch: ctx.watchOffer, note: `${OFFERED_WATCH_NOTE}${refused ? ` Left out: ${refused}.` : ''}` };
}
