// Watches over upcoming agendas (Jason, 2026-11-16: "I'd like for people to
// be able to ask something like 'let me know if planning commission or City
// Council take up any items affecting short term rentals' and get an email";
// then "Let's shift from per street to per neighborhood league"). A watch is
// topic terms, a civic league, or both, over the bodies it names. These are
// the pure parts: checking a watch, withholding applicants' names, matching
// items. The Worker stores watches, builds the agenda snapshot, sends the
// mail and serves the civic-league feeds (worker/watches.js).
//
// No people-finding: a term must be ordinary words, ones Norfolk's Zoning
// Ordinance and adopted budget books use in lower case (worker/telemetry.js
// ordinaryWords), plus a short reviewed list; that keeps out names that are
// only names (Harris, Thomas) and proper-noun streets (Granby), though not
// names that are also words (Park, Foster). It must pass the public-text
// checks, and can't be a street with its suffix, a house number or a civic
// league's name. Items are matched on their title with private people's
// names already withheld (withholdNames), so a name can't match even when
// it is also a word, and only withheld titles reach a feed or an email.

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
export const NAME_WITHHELD = '[name withheld]';

// Words allowed in a term beyond the ordinary-word vocabulary: short words,
// and topics the City's documents only ever capitalize (a use-table entry
// like "Kennel"). Reviewed by hand; none is a surname.
const ALLOWED = new Set(['bed', 'gym', 'oil', 'and', 'of', 'the', 'for', 'use', 'adu', 'bar', 'inn', 'spa', 'pub', 'art', 'day', 'car', 'lot', 'tax', 'new', 'bay', 'sea', 'kennel', 'brewery', 'hookah', 'mural', 'seawall']);
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
// A trust or estate named for a person is the person.
const PERSONAL = /\b(?:revocable|irrevocable|living|family)\s+trust\b|\btrustees?\b|\bestate\s+of\b/i;
// Government parties, by their full form: "Virginia" alone can be a person's first name.
const GOV = /^(?:the\s+)?(?:city\s+of|city\s+manager|city\s+treasurer|norfolk\s+(?:city|redevelopment|public|airport|department)|commonwealth|virginia\s+(?:department|port|employment|housing|state|board|commission|division|marine|resources)|united\s+states|u\.\s?s\.|federal|county\s+of|state\s+of)\b/i;
// Organization words beyond iqm2's ORG, for parties only.
const ORG_EXTRA = /\b(?:conference|coalition|corps|army|navy|alliance|network|federation|cooperative|league|centers|ministry|ministries|council)\b/i;
/** A party that is plainly an organization: every one of its "and"-joined parts is. */
export function isOrganization(party) {
  const p = String(party ?? '').trim();
  if (!p) return false;
  if (GOV.test(p)) return true;
  return p.split(/\s+(?:and|&)\s+/i).every((part) => !PERSONAL.test(part) && (ORG.test(part) || ORG_EXTRA.test(part) || GOV.test(part)));
}

// The places a party is named in Council titles (read from the legislation
// index, 2026-11-16): a sale or conveyance to, an encroachment granted to, a
// lease, license, easement or agreement with, a tenant, a refund, a bidder,
// a conveyance from someone to the City. P is the party.
const P = "([A-Z0-9][^;:()]{0,118}?)";
const PARTY_SLOTS = [
  new RegExp(`\\bConveyance\\s+(?:of\\s+[^;:()]{0,80}?\\s+)?to\\s+${P},?\\s+(?=(?:of|for)\\b)`, 'gi'),
  new RegExp(`\\bGranting\\s+${P}\\s+(?=Permission\\b)`, 'gi'),
  new RegExp(`\\b(?:Permitting|Allowing|Authorizing)\\s+${P}\\s+(?=to\\s+(?:Encroach|Use|Go|Install|Construct|Maintain|Place|Erect)\\b)`, 'gi'),
  new RegExp(`\\b(?:Agreement|Lease|License|Easement|Contract|Sublease|Deed)\\b[^.;]{0,100}?\\bwith\\s+${P},?\\s+(?=(?:as|for|over|to|of|regarding|concerning|d\\/b\\/a|and\\s+authoriz|and\\s+approv)\\b)`, 'gi'),
  new RegExp(`\\b(?:Easement|Lease|License|Deed)\\s+to\\s+${P},?\\s+(?=(?:over|for|as|and)\\b)`, 'gi'),
  new RegExp(`\\bas\\s+(?:Landlord|Lessor|Licensor|Grantor|Seller|Sublandlord),?\\s+and\\s+${P},?\\s+as\\s+(?=(?:Tenant|Lessee|Licensee|Purchaser|Buyer|Grantee|Owner|Subtenant)\\b)`, 'gi'),
  new RegExp(`\\brefund\\s+to\\s+${P}\\s+(?=(?:upon|for|in)\\b)`, 'gi'),
  new RegExp(`\\b(?:Submitted|Offered|Made)\\s+by\\s+${P},?\\s+(?=(?:and|for|to)\\b)`, 'gi'),
  new RegExp(`\\bfrom\\s+${P}\\s+(?=to\\s+the\\s+City\\b)`, 'gi'),
];
const NAME_SUFFIX = /^,?\s+(?:Jr|Sr|II|III|IV)\b\.?/;
const STREET_SUFFIX = new Set(['street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'road', 'rd', 'drive', 'dr', 'lane', 'ln', 'court', 'ct', 'circle', 'cir', 'place', 'pl', 'way', 'terrace', 'ter', 'parkway', 'pkwy', 'highway', 'hwy', 'crescent', 'square', 'trail', 'arch', 'landing', 'point', 'quay', 'run', 'walk']);
const GAZETTEER = new Set(['norfolk', 'virginia', 'hampton', 'roads', 'chesapeake', 'portsmouth', 'suffolk', 'newport', 'williamsburg', 'richmond', 'tidewater', 'elizabeth', 'america', 'american', 'united', 'states', 'commonwealth', 'amtrak', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'fy', 'no', 'jr', 'sr']);
const ORG_WORD = (w) => ORG.test(w);
// A run right before one of these names a place, an institution or a program ("Harrison Opera House", "Edward Byrne Memorial", "Chesterfield Precinct").
const INSTITUTION = new Set(['precinct', 'park', 'parks', 'school', 'library', 'elementary', 'academy', 'theater', 'theatre', 'opera', 'house', 'hall', 'museum', 'stadium', 'arena', 'field', 'building', 'plaza', 'garden', 'gardens', 'village', 'apartments', 'commons', 'district', 'campus', 'marina', 'pier', 'beach', 'cemetery', 'memorial', 'grant', 'program', 'fund', 'award', 'scholarship', 'festival', 'fest', 'parkway', 'bridge', 'tunnel', 'creek', 'river', 'lake', 'point', 'station', 'terminal', 'airport', 'harbor', 'harbour', 'tower', 'towers', 'court', 'manor', 'estates', 'heights', 'shores']);
// The word before a person's name in a title: a party, a recognition, a contact.
const NAME_BEFORE = new Set(['to', 'and', 'by', 'with', 'from', '&', 'authorizing', 'permitting', 'allowing', 'granting', 'honoring', 'recognizing', 'commending', 'congratulating', 'remembering', 'appointing', 'reappointing', 'designating', 'contact', 'contact:']);
const ORG_BEFORE = /\b(?:council|department|bureau|office|university|college|bank|board|authority|commission|association|society|church|school|city|county|commonwealth|state|league|club|chamber|friends)\s+of\s+(?:the\s+)?$/i;

/**
 * Words in a party or a run that make it a person's name rather than a
 * phrase: a capitalized word that isn't ordinary (in `ordinary`, the
 * lower-case vocabulary), isn't a place and isn't an organization word.
 */
function properNoun(word, { ordinary, places }) {
  const w = word.replace(/[’']s$/i, '').replace(/\.$/, '');
  if (!/^[A-Z]/.test(w) || w.length < 2) return false;
  const lw = w.toLowerCase();
  return !ordinary.has(lw) && !places.has(lw) && !GAZETTEER.has(lw) && !ORG_WORD(lw);
}

/**
 * An agenda title with private people's names withheld. Three layers, each
 * conservative (an organization's name can be withheld too; a person's must
 * never show):
 * 1. Planning Commission titles open with the applicant ("JANE DOE, for a
 *    Conditional Use Permit …"): withheld unless plainly an organization, the
 *    rule get_legislation's cover letter follows (src/adapters/iqm2.js).
 * 2. The places Council titles name a party (PARTY_SLOTS): withheld unless
 *    plainly an organization (every "and"-joined part; a personal trust or an
 *    estate is a person), when the party holds a proper noun.
 * 3. Anywhere, a person-shaped run: two or more capitalized words that are
 *    proper nouns (not ordinary words, places or organization words), or a
 *    middle initial and the word after it ("Glen L. East"), with "Jr." and
 *    the like; kept only when an organization word follows in its clause
 *    ("Louise W. Eggleston Center, Inc."). And a name after a courtesy title.
 * `ordinary` is the lower-case vocabulary (worker/telemetry.js ordinaryWords);
 * `places` holds street-name, civic-league and place words, lower case;
 * `streets` (compiled) marks a street's words only before a street suffix.
 * Without `ordinary`, layers 2 and 3 withhold every party and run they find.
 */
export function withholdNames(text, { ordinary = null, places = new Set(), multiword = new Map() } = {}) {
  const ctx = { ordinary: ordinary || new Set(), places };
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  // A Planning Commission title's staff contact (a City employee, with an email built from the name) adds nothing here.
  t = t.replace(/\s*\(?\bStaff\s+Contact:.*$/i, '').trim();
  // 1. The Planning Commission's applicant, at the start.
  const lead = /^([^a-z]{2,160}?),\s+(?:for|to)\s+/.exec(t);
  if (lead && /[A-Z]{2}/.test(lead[1]) && !isOrganization(lead[1])) t = `${WITHHELD}, ${t.slice(lead[1].length).replace(/^,\s+/, '')}`;
  // 2. Council titles' party slots.
  for (const re of PARTY_SLOTS) {
    t = t.replace(re, (all, party) => {
      // A party with a number is a place or a clause, not a name; a plain organization stays.
      if (/\d/.test(party) || isOrganization(party)) return all;
      const words = party.split(/[\s,]+/).filter(Boolean);
      if (ordinary && !words.some((w) => properNoun(w, ctx) || /^[A-Z]\.$/.test(w))) return all;
      return all.replace(party, NAME_WITHHELD);
    });
  }
  // 3. Person-shaped runs.
  t = withholdRuns(t, ctx, multiword);
  return t.replace(COURTESY, `${NAME_WITHHELD} `).replace(/\s+/g, ' ').trim();
}

/** Layer 3 of withholdNames. */
function withholdRuns(t, ctx, multiword) {
  const tokens = [...t.matchAll(/[A-Za-z][A-Za-z'’.-]*/g)].map((m) => ({ w: m[0], at: m.index, end: m.index + m[0].length }));
  // Words of a multi-word place (a street or civic league named in the
  // text, "Princess Anne", "Lamberts Point") are places wherever they stand.
  const placeAt = new Set();
  for (let i = 0; i < tokens.length; i++) {
    for (const words of multiword.get(tokens[i].w.replace(/\.$/, '').toLowerCase()) || []) {
      if (i + words.length > tokens.length) continue;
      if (words.every((w, k) => tokens[i + k].w.replace(/\.$/, '').toLowerCase() === w)) for (let k = 0; k < words.length; k++) placeAt.add(i + k);
    }
  }
  // Quoted names are an establishment's, an event's or a project's ("Dutch Bros Coffee", "F.U.S.E. Fest").
  const quoted = [];
  for (const q of t.matchAll(/["“][^"”]{1,120}["”]/g)) quoted.push([q.index, q.index + q[0].length]);
  const inQuotes = (at) => quoted.some(([a, b]) => at >= a && at < b);
  const adjacent = (a, b) => /^\s$/.test(t.slice(a.end, b.at));
  const lower = (i) => (tokens[i] ? tokens[i].w.replace(/\.$/, '').toLowerCase() : '');
  // N., S., E. or W. before a street (a suffix within four words, or a multi-word place next) is a direction.
  const direction = (i) => /^[NSEW]\.$/.test(tokens[i].w) && (placeAt.has(i + 1) || [1, 2, 3, 4].some((k) => STREET_SUFFIX.has(lower(i + k))) || /\d\s*$/.test(t.slice(0, tokens[i].at)));
  const initial = (w, i) => /^[A-Z]\.$/.test(w) && !direction(i);
  const candidate = (i) => {
    if (placeAt.has(i) || inQuotes(tokens[i].at) || NAME_BEFORE.has(lower(i))) return false;
    const tok = tokens[i];
    // A street name's word right before its suffix is the street.
    const next = tokens[i + 1];
    if (next && adjacent(tok, next) && STREET_SUFFIX.has(next.w.replace(/\.$/, '').toLowerCase())) return false;
    return properNoun(tok.w, ctx);
  };
  const spans = [];
  for (let i = 0; i < tokens.length; i++) {
    if (inQuotes(tokens[i].at) || !(candidate(i) || initial(tokens[i].w, i))) continue;
    let j = i;
    let proper = candidate(i) ? 1 : 0;
    let initials = initial(tokens[i].w, i) ? 1 : 0;
    while (j + 1 < tokens.length && adjacent(tokens[j], tokens[j + 1])) {
      const n = tokens[j + 1].w;
      if (candidate(j + 1)) proper++;
      else if (initial(n, j + 1)) initials++;
      // A middle initial takes the word after it, ordinary or not ("Glen L. East").
      else if (initial(tokens[j].w, j) && /^[A-Z]/.test(n) && !ORG_WORD(n.toLowerCase()) && !STREET_SUFFIX.has(n.replace(/\.$/, '').toLowerCase())) proper++;
      else break;
      j++;
    }
    let end = tokens[j].end;
    const suffix = NAME_SUFFIX.exec(t.slice(end));
    if (suffix) end += suffix[0].length;
    const after = t.slice(end);
    const before = t.slice(0, tokens[i].at);
    const prev = (before.match(/([A-Za-z&:]+)\s*$/) || [])[1]?.toLowerCase() || '';
    const nextWord = (after.match(/^[\s,]*([A-Za-z]+)/) || [])[1]?.toLowerCase() || '';
    // The rest of its clause: an organization word there makes it an organization's name.
    const clause = after.slice(0, 60).split(/\s(?:of|for|as|to|over|upon|in|at|on)\s|[;(]/)[0];
    const org = ORG.test(clause) || ORG_EXTRA.test(clause) || ORG.test(t.slice(tokens[i].at, end)) || ORG_EXTRA.test(t.slice(tokens[i].at, end)) || ORG_BEFORE.test(before) || INSTITUTION.has(nextWord) || INSTITUTION.has(lower(j));
    // A middle initial is a person's name; two proper nouns are one only where
    // a title names a party, and not before a number ("Reordain Chapter 34.2").
    const withInitial = proper >= 1 && initials >= 1;
    const atParty = proper >= 2 && NAME_BEFORE.has(prev) && !/^\s*[\d§]/.test(after);
    if ((withInitial || atParty) && !org) spans.push([tokens[i].at, end]);
    i = j;
  }
  for (const [a, b] of spans.reverse()) t = `${t.slice(0, a)}${NAME_WITHHELD}${t.slice(b)}`;
  return t;
}

/**
 * The places withholdNames treats as places: single-word civic leagues, and
 * multi-word street names and civic leagues as word sequences (indexed by
 * their first word). `streets` is the compiled list (src/public-text.js
 * compileStreets) or raw names; `leagues` the civic leagues' names.
 */
export function namePlaces({ streets = null, leagues = [] } = {}) {
  const places = new Set();
  const multiword = new Map();
  const add = (name) => {
    const words = normalizeText(name).split(' ').filter(Boolean);
    if (!words.length) return;
    if (words.length === 1) {
      places.add(words[0]);
      return;
    }
    if (!multiword.has(words[0])) multiword.set(words[0], []);
    multiword.get(words[0]).push(words);
  };
  for (const l of leagues) add(l);
  const names = streets?.names instanceof Set ? streets.names : Array.isArray(streets?.streets) ? streets.streets : Array.isArray(streets) ? streets : [];
  for (const n of names) if (String(n).trim().includes(' ')) add(n);
  return { places, multiword };
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
    else if (words.some((w) => !(ALLOWED.has(w) || (w.length >= 3 && vocab?.has(w))))) reason = "a term is ordinary words, as the City's Zoning Ordinance and budget books use them, never a name or a street";
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
