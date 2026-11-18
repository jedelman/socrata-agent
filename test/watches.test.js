// Watches over upcoming agendas (src/watches.js, worker/watches.js): Jason,
// 2026-11-16, "let me know if planning commission or City Council take up
// any items affecting short term rentals" by email, and civic-league feeds
// ("Let's shift from per street to per neighborhood league"). Siren never
// repeats an agenda title (titles can name private people); it describes
// each item from fixed labels and the property's address, and watches follow
// topics from a reviewed list. The names in these fixtures are invented; the
// addresses are on real streets with made-up numbers, in a small address
// list (BOOK) standing in for the City's; the properties over every real
// title and street name use the City's own (data/norfolk-addresses.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf } from './fake-pdf.js';
import { topicsOf, itemKind, itemNumber, describeItem, cityAddresses, titleAddresses, titlePlaces, compileAddresses, streetKey, streetsIn, checkWatch, checkPhrases, matchesWatch, termPattern, offerWatch, sameWatch, watchLabel, withoutApplicant, phrasesIn, MAX_TOPICS } from '../src/watches.js';
import { ordinaryWords } from '../worker/telemetry.js';
import streetsFile from '../data/gaps/norfolk-streets.json' with { type: 'json' };
import addressesFile from '../data/norfolk-addresses.json' with { type: 'json' };
import commonNames from '../data/common-names.json' with { type: 'json' };
import { extractAddresses } from '../src/adapters/iqm2.js';
import { toolsFor } from '../src/tools.js';
import { definePlugin } from '../src/plugins.js';
import { systemPrompt, WATCH_LINE } from '../src/prompt.js';
import { getCity } from '../src/cities/index.js';
import { buildSnapshot, runWatchJob, readSnapshot, sealEmail, openEmail, stopToken, digest, atomFeed, leagueSlug, meetingTime, jobDue, watchableCity, handleWatches } from '../worker/watches.js';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import { readyEnv, SECRET } from './fake-atproto.js';

const norfolk = getCity('norfolk');
const TOPICS = norfolk.meetings.watchTopics;
const BODIES = ['City Council', 'Planning Commission'];
const LEAGUES = ['Ghent', 'Ocean View', 'Willoughby'];
// A stand-in for the City's address list: real streets, made-up numbers.
const BOOK = compileAddresses({
  leagues: LEAGUES,
  streets: {
    'COLLEY AVENUE': '100:0 4200:0', 'CHURCH STREET': '508 885:0', 'E MAIN STREET': '226', 'E VIRGINIA BEACH BOULEVARD': '6513',
    'GRANBY STREET': '1210:2', 'HAMPTON BOULEVARD': '4100:0', 'SAINT PAULS BOULEVARD': '300 698', 'SHORE DRIVE': '8400:1',
    'TIDEWATER DRIVE': '5660', 'W OCEAN VIEW AVENUE': '241:1', '35TH STREET': '628:0',
  },
});
const CITY_BOOK = compileAddresses(addressesFile);
const names = { surnames: new Set(commonNames.surnames), given: new Set(commonNames.given) };
const textCheck = (t) => !/\d|@/.test(t);
const opts = { topics: TOPICS, leagues: LEAGUES, bodies: BODIES, names, ordinary: ordinaryWords(), textCheck, book: BOOK };
const describe = (title, book = BOOK) => describeItem({ kind: itemKind(title), topics: topicsOf(title, TOPICS), addresses: titleAddresses(title, book) }, TOPICS);

test('items are described from fixed labels and the address, never the title: buyers, tenants and applicants stay out', () => {
  const cases = [
    ['JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental) at 1210 Granby Street (Ward 5/Superward 6)', 'Conditional Use Permit: Short-term rentals, at 1210 Granby Street'],
    ['SEASIDE RENTALS, LLC, for a Conditional Use Permit (Renewal) to operate a Short-Term Rental (Vacation Rental) at 8400 Shore Drive', 'Conditional Use Permit renewal: Short-term rentals, at 8400 Shore Drive'],
    // The shapes the reviews found leaking from an earlier, name-withholding design.
    ['Ordinance No. 50501 : An Ordinance Authorizing the Sale and Conveyance to Will Price of That Certain Parcel of Property Located at 885 Church Street', 'Sale of City property, at 885 Church Street'],
    ['An Ordinance Granting Hope Wells Permission to Encroach Into the Right-of-Way at 508 Church Street', 'Encroachment into a right-of-way, at 508 Church Street'],
    ['A Lease Agreement Between the City of Norfolk, as Landlord, and Bill Long, as Tenant, for Premises Located at 226 E. Main Street', 'Lease: Sales and leases of City property, at 226 E. Main Street'],
    ['An Ordinance Approving an Easement From Robert Price Over the Property Located at 100 Colley Avenue', 'Easement, at 100 Colley Avenue'],
    ['John Smith, for a Conditional Use Permit to operate a Tattoo Parlor at 5660 Tidewater Drive', 'Conditional Use Permit: Tattoo parlors, at 5660 Tidewater Drive'],
    ['Accepting a Gift From The Library Foundation Via Randi Example For Norfolk Public Libraries', 'Agenda item: Libraries'],
  ];
  for (const [title, want] of cases) assert.equal(describe(title), want, title);
  assert.equal(itemNumber('Ordinance No. 50,501 : An Ordinance …'), 'Ordinance No. 50501');
  assert.equal(itemNumber('Resolution No. 1987 : A Resolution …'), 'Resolution No. 1987');
  assert.equal(itemNumber('JANE DOE, for …'), null);
});

// The property that makes the design safe, over every real title: each word
// of a description is a word of a fixed kind or topic label, a connector, or
// a word of an address the title names. Nothing else can get through.
test('over all 1,452 indexed titles, every address shown is on the City\'s address list, and every word of every description is a label word, a number, or a word of that address', () => {
  const idx = JSON.parse(readFileSync(new URL('../data/norfolk-legislation.json', import.meta.url), 'utf8'));
  const kinds = ['Conditional Use Permit renewal', 'Rezoning', 'Development Certificate', 'Zoning Ordinance amendment', 'Encroachment into a right-of-way', 'Sale of City property', 'Lease', 'Easement', 'Right of entry', 'Street or alley closure', 'Certificate of Appropriateness', 'Appeal of a zoning decision', 'Special exception', 'Variance', 'Budget or appropriation', 'Design review', 'Resolution', 'Ordinance', 'Agenda item'];
  const words = (s) => String(s).toLowerCase().replace(/['’]/g, '').match(/[a-z0-9]+/g) || [];
  // An address's words, as the title writes them, must be its number and the
  // words of the street it was found on, abbreviated or not (streetKey);
  // never another word of the title (reviews of #62).
  const allowed = new Set([...kinds, ...TOPICS.map((t) => t.label), 'at and more'].flatMap(words));
  let n = 0;
  let shown = 0;
  for (const item of idx.items) {
    const places = titlePlaces(item.text, CITY_BOOK);
    const addressWords = new Set();
    for (const a of places.addresses) {
      const [num, ...rest] = a.split(/\s+/);
      const hit = CITY_BOOK.find(num, rest.join(' '));
      assert.ok(hit, `${a} is on the list`);
      const listed = new Set(words(streetKey(hit.street)));
      const stray = words(streetKey(rest.join(' '))).filter((x) => !listed.has(x) && !['north', 'south', 'east', 'west'].includes(x));
      assert.deepEqual(stray, [], `${a}: not words of ${hit.street}`);
      for (const w of [num, ...rest].flatMap(words)) addressWords.add(w);
      shown++;
    }
    // Leagues come from the list, for listed addresses only.
    for (const l of places.leagues) assert.ok(CITY_BOOK.leagues.includes(l), l);
    if (!places.addresses.length) assert.deepEqual(places.leagues, []);
    const desc = describe(item.text, CITY_BOOK);
    // Numbers: the house numbers, and the code-written count of "and 2 more".
    const stray = words(desc).filter((w) => !allowed.has(w) && !addressWords.has(w) && !/^\d+$/.test(w));
    assert.deepEqual(stray, [], `${desc} ← ${item.text.slice(0, 120)}`);
    n++;
  }
  assert.ok(n > 1400);
  // Measured 2026-11-16: 860 of the 883 addresses titles name are on the list. The 23 that
  // aren't: typos ("Berkeley"), streets outside the city, numbers the list doesn't carry.
  assert.ok(shown > 840, `${shown} addresses shown`);
});

test('an "address" that isn\'t a number on one of the City\'s streets never reaches a description', () => {
  // The third review's probes: numbers followed by a name and a street-like word.
  const probes = [
    ['An Ordinance to Accept a Donation in the Sum Of $5,000 From Mary Lane For The Norfolk Public Library', 'Ordinance: Libraries'],
    ['An Ordinance Approving a Settlement of $25,000 With Jane Way', 'Ordinance'],
    ['An Ordinance Approving a Lease for 5 Years With Robert Street for Premises', 'Lease: Sales and leases of City property'],
    ['JANE DOE, for a Conditional Use Permit at 1210 Granby Street, Unit 2 Mary Smith Walk', 'Conditional Use Permit, at 1210 Granby Street'],
    // The fourth review's: money right before a name that is also a City street.
    ['A Resolution Approving a $5,000 Betty Lane Scholarship for the Norfolk Public Library', 'Resolution: Libraries'],
    ['An Ordinance Approving a Settlement Agreement of $12,500 Albert Lane', 'Ordinance'],
    ['An Ordinance Accepting a Gift of 12,500 Albert Lane', 'Ordinance'],
  ];
  for (const [title, want] of probes) assert.equal(describe(title), want, title);
  // Against the City's own list too, the probes with no address find none.
  for (const [title] of probes.filter(([, want]) => !want.includes(', at '))) assert.deepEqual(titleAddresses(title, CITY_BOOK), [], title);
  assert.deepEqual(cityAddresses(['241 W. Ocean View Avenue', '5 From Mary Lane', '6513 E. Virginia Beach Boulevard'], BOOK), ['241 W. Ocean View Avenue', '6513 E. Virginia Beach Boulevard']);
  assert.deepEqual(cityAddresses(['241 W. Ocean View Avenue'], null), [], 'no address list, no addresses');
  assert.deepEqual(cityAddresses(['000 Granby Street'], BOOK), [], 'a leading zero is never a house number');
  // Jason's question: a street named for a person is an address only with a house number the list has on it.
  assert.deepEqual(cityAddresses(['1211 Granby Street', '4101 Hampton Boulevard', '1210 Granby Street'], BOOK), ['1210 Granby Street']);
  // A street the list spells without its apostrophe, or with Saint for St.
  assert.deepEqual(titleAddresses('Property Located at 698 Saint Paul\'s Boulevard and 300 St. Paul\'s Boulevard', BOOK), ['698 Saint Paul\'s Boulevard', '300 St. Paul\'s Boulevard']);
  // A direction: one the list doesn't give is let go; one the title leaves out is supplied only when one direction has that number.
  assert.deepEqual(titleAddresses('Property at 628 West 35th Street and 226 Main Street', BOOK), ['628 West 35th Street', '226 Main Street']);
  assert.deepEqual(titlePlaces('Property at 628 West 35th Street', BOOK), { addresses: ['628 West 35th Street'], streets: ['35TH STREET'], leagues: ['Ghent'] });
  const twoWays = compileAddresses({ leagues: [], streets: { 'E MAIN STREET': '226', 'W MAIN STREET': '226' } });
  assert.deepEqual(titleAddresses('Property at 226 Main Street', twoWays), [], 'East or West: not guessed');
  assert.deepEqual(titleAddresses('Property at 226 W. Main Street', twoWays), ['226 W. Main Street']);
  // A title's direction is let go only when the list has no street of that direction (fifth review):
  // "102 North Blake Road" is not 102 BLAKE ROAD while NORTH BLAKE ROAD is a street of its own.
  const blake = compileAddresses({ leagues: [], streets: { 'BLAKE ROAD': '102', 'N BLAKE ROAD': '200' } });
  assert.equal(blake.find('102', 'North Blake Road'), null);
  assert.deepEqual(blake.find('200', 'N. Blake Road'), { street: 'N BLAKE ROAD', leagues: [] });
  assert.equal(CITY_BOOK.find('102', 'North Blake Road'), null);
  assert.equal(CITY_BOOK.find('2910', 'South Cape Henry Avenue'), null);
  // The first `max` listed addresses, and only their streets and leagues.
  assert.deepEqual(titlePlaces('Property at 4200 Colley Avenue and 1210 Granby Street', BOOK, { max: 1 }), { addresses: ['4200 Colley Avenue'], streets: ['COLLEY AVENUE'], leagues: ['Ghent'] });
  // A caller can't change the list through what find returns.
  BOOK.find('4200', 'Colley Avenue').leagues.push('Atlantis');
  assert.deepEqual(BOOK.find('4200', 'Colley Avenue').leagues, ['Ghent']);
});

test('topics: reviewed phrases matched as words, plurals and hyphens included; the list carries no free word', () => {
  assert.deepEqual(topicsOf('a Short-Term Rental Unit (Vacation Rental)', TOPICS), ['short_term_rentals']);
  assert.deepEqual(topicsOf('Short-Term Rentals', TOPICS), ['short_term_rentals']);
  assert.ok(topicsOf('a Blade Sign', TOPICS).includes('signs'));
  assert.ok(!topicsOf('Design review of a building', TOPICS).includes('signs'), '"sign" is a word, not part of "design"');
  assert.ok(!topicsOf('a Release of Easement', TOPICS).includes('city_property'), '"lease" is not part of "release"');
  for (const t of TOPICS) {
    assert.match(t.id, /^[a-z_]+$/);
    assert.ok(t.label && t.phrases.length, t.id);
    // No phrase may be made only of common first names or surnames ("ADU" and "flood" were dropped for this).
    for (const ph of t.phrases) {
      const w = ph.toLowerCase().split(/[^a-z]+/).filter(Boolean);
      assert.ok(!w.every((x) => names.surnames.has(x) || names.given.has(x)), `${t.id}: "${ph}" reads as a name`);
    }
  }
  assert.equal(termPattern('bed and breakfast').test('a bed and breakfasts permit'), true);
});

test('checking a watch: topics from the list only; leagues by the City\'s spelling; bodies default to all', () => {
  assert.deepEqual(checkWatch({ topics: ['short_term_rentals', 'harris', 'Jane Doe'] }, opts), { ok: true, watch: { topics: ['short_term_rentals'], phrases: [], streets: [], league: null, bodies: BODIES }, refused: ['harris', 'Jane Doe'], refusedPhrases: [], notes: [] });
  assert.match(checkWatch({ topics: ['price'] }, opts).error, /aren't topics a watch can follow yet/);
  assert.deepEqual(checkWatch({ civic_league: 'ocean view' }, opts).watch, { topics: [], phrases: [], streets: [], league: 'Ocean View', bodies: BODIES });
  assert.match(checkWatch({ civic_league: 'Atlantis' }, opts).error, /don't know a civic league called "Atlantis"/);
  assert.deepEqual(checkWatch({ topics: ['tattoo'], bodies: ['planning commission'] }, opts).watch.bodies, ['Planning Commission']);
  assert.match(checkWatch({ topics: ['tattoo'], bodies: ['Board of Zoning Appeals'] }, opts).error, /covers City Council or Planning Commission/);
  assert.match(checkWatch({}, opts).error, /needs a topic, a phrase, a street, a civic league, or a mix/);
  assert.match(checkWatch({ topics: TOPICS.slice(0, MAX_TOPICS + 1).map((t) => t.id) }, opts).error, /at most 8 topics/);
});

test('phrases (a signed-in member\'s own words): plain words kept; names, addresses, numbers and leagues refused', () => {
  const guard = { names, ordinary: ordinaryWords(), leagues: LEAGUES, textCheck };
  const out = checkPhrases(['dog park', 'Food Truck', 'John Smith', 'price', 'will price', 'hope wells', '810 Union St', 'Ghent', 'a', 'food truck', 'community garden'], guard);
  assert.deepEqual(out.phrases, ['dog park', 'food truck', 'community garden']);
  const why = Object.fromEntries(out.refused.map((r) => [r.phrase, r.reason]));
  for (const n of ['John Smith', 'price', 'will price', 'hope wells']) assert.match(why[n], /reads as a person's name/, n);
  // The fourth review's: a common name beside anything but ordinary words, or beside a title or entity word.
  for (const n of ['john zelinski', 'jason edelman', 'mr smith', 'dr patel', 'j smith', 'john q smith', 'smith jr', 'smith llc', 'smith trust', 'estate of smith', 'smith family', 'smith et al', 'smiths']) {
    assert.equal(checkPhrases([n], guard).phrases.length, 0, n);
  }
  // What still passes, by design and in the docs: a rare surname alone.
  assert.deepEqual(checkPhrases(['zelinski'], guard).phrases, ['zelinski']);
  // Without its guards, no phrase is accepted.
  assert.match(checkPhrases(['dog park'], { ...guard, names: null }).refused[0].reason, /aren't available here/);
  assert.match(checkPhrases(['dog park'], { ...guard, textCheck: null }).refused[0].reason, /aren't available here/);
  assert.match(checkPhrases(['dog park'], { ...guard, ordinary: null }).refused[0].reason, /aren't available here/);
  assert.match(why['810 Union St'], /no numbers/);
  // A civic league's name is the league to watch, not a phrase (Jason, 2026-11-18: "a pretty common ask").
  assert.deepEqual(out.leagues, ['Ghent']);
  assert.equal(checkWatch({ phrases: ['ghent', 'dog park'] }, opts).watch.league, 'Ghent');
  assert.match(checkWatch({ phrases: ['ghent', 'ocean view'] }, opts).error, /one civic league \(Ghent, Ocean View\)/);
  assert.match(checkWatch({ phrases: ['ghent'], civic_league: 'Willoughby' }, opts).error, /one civic league/);
  assert.equal(checkWatch({ phrases: ['Ghent'], civic_league: 'ghent' }, opts).watch.league, 'Ghent', 'the same league twice is one');
  assert.match(why.a, /3 to 40 characters/);
  // A phrase is matched against the title the snapshot keeps (never shown).
  const w = { topics: [], phrases: ['dog park'], league: null, bodies: BODIES };
  assert.ok(matchesWatch(w, { body: 'City Council', topics: [], title: 'An Ordinance to Build a Dog Park at Lafayette Park', leagues: [] }));
  assert.ok(!matchesWatch(w, { body: 'City Council', topics: [], title: 'An Ordinance About a Park', leagues: [] }));
  assert.equal(checkWatch({ phrases: ['John Smith'] }, opts).error, 'None of those phrases can be watched.');
  assert.equal(watchLabel({ topics: ['tattoo'], phrases: ['dog park'], bodies: BODIES }, TOPICS), 'Tattoo parlors, "dog park", at City Council or Planning Commission');
});

test("a civic league typed as a phrase: taken whatever its length, without the name lists, and the narrowing said", () => {
  const leagues = [...LEAGUES, 'Lindenwood and Barraud Park and Cottage Heights', 'Bayview'];
  const o = { ...opts, leagues };
  // Longer than a phrase may be, and more words: still the league (10 of the City's 118 are).
  assert.equal(checkWatch({ phrases: ['Lindenwood and Barraud Park and Cottage Heights'] }, o).watch.league, 'Lindenwood and Barraud Park and Cottage Heights');
  // Without the name lists phrases aren't accepted, but a league is on the City's own list.
  assert.equal(checkWatch({ phrases: ['ghent'] }, { ...o, names: null }).watch.league, 'Ghent');
  // Alone, it's every item in the league; with other words, it narrows them, and the note says so.
  assert.deepEqual(checkWatch({ phrases: ['ghent'] }, o).notes, [{ phrase: 'ghent', note: 'taken as the civic league Ghent: every item in Ghent will come' }]);
  assert.deepEqual(checkWatch({ phrases: ['ghent', 'dog park'] }, o).notes, [{ phrase: 'ghent', note: 'taken as the civic league Ghent: only matches in Ghent will come' }]);
  // A league that is also a street's name says how to follow the street.
  const book = { street: (p) => (p === 'bayview' ? 'bayview' : null) };
  assert.match(checkWatch({ phrases: ['bayview'] }, { ...o, book }).notes[0].note, /write it with its type/);
  assert.deepEqual(checkWatch({ topics: ['tattoo'] }, o).notes, []);
  // The model is told, to say so.
  const ctx = { watches: { check: (a) => checkWatch(a, o), topics: TOPICS } };
  assert.match(offerWatch(ctx, { phrases: ['ghent', 'dog park'] }).note, /"ghent" is taken as the civic league Ghent: only matches in Ghent will come\. Say so\./);
});

test("a phrase never matches the applicant's name that leads a BZA entry or a land-use title (review 6)", () => {
  assert.equal(withoutApplicant('LEILA EXAMPLE-LABRADOR - for a variance from minimum lot area'), 'for a variance from minimum lot area');
  assert.equal(withoutApplicant('MADELINE EXAMPLE – for a variance from the front façade'), 'for a variance from the front façade');
  assert.equal(withoutApplicant('TERRIE EXAMPLE, for a Conditional Use Permit'), 'for a Conditional Use Permit');
  assert.equal(withoutApplicant('An Ordinance to Build a Dog Park, for the City'), 'An Ordinance to Build a Dog Park, for the City', 'only a leading name in capitals');
  const item = { body: 'Board of Zoning Appeals', topics: [], title: 'ZELINSKI HOLDINGS – for a variance on property located at 2612 Munson St', summary: 'ZELINSKI HOLDINGS – for a variance on property located at 2612 Munson St', leagues: [] };
  assert.deepEqual(phrasesIn({ phrases: ['zelinski'] }, item), []);
  assert.deepEqual(phrasesIn({ phrases: ['variance'] }, item), ['variance']);
});

test('streets named for people (Jason, 2026-11-16): every street of the City\'s list can be watched, by its listed addresses, never by a title\'s words', () => {
  const guard = { names, ordinary: ordinaryWords(), leagues: CITY_BOOK.leagues, textCheck };
  // Without the address list the name guard refuses a street like Hampton; with it, it's watched as a street.
  assert.match(checkPhrases(['hampton'], guard).refused[0].reason, /reads as a person's name/);
  const out = checkPhrases(['hampton', '21st street', 'dog park', 'john smith'], { ...guard, book: CITY_BOOK });
  assert.deepEqual(out.streets, ['hampton', '21st street']);
  assert.deepEqual(out.phrases, ['dog park']);
  assert.deepEqual(out.refused.map((r) => r.phrase), ['john smith'], 'a name that is no street stays refused');
  // Every street name on the City's list is a phrase, a street, or (a civic league's name) the league.
  let watched = 0;
  for (const st of streetsFile.streets) {
    const r = checkPhrases([st.toLowerCase()], { ...guard, book: CITY_BOOK });
    if (r.streets.length) watched++;
    assert.ok(r.phrases.length || r.streets.length || r.leagues.length, `${st}: ${r.refused[0]?.reason}`);
  }
  // Measured 2026-11-16: without the list, 576 of the 1,941 street names were refused as names; with it, 553 are streets,
  // and the 23 that are also civic leagues' names ("bayview") are the league (2026-11-18).
  assert.ok(watched > 500, `${watched} street names watched as streets`);
  // A street watch matches by the street an item's listed address is on, never by its title.
  const w = { topics: [], phrases: [], streets: ['hampton'], league: null, bodies: BODIES };
  assert.ok(matchesWatch(w, { body: 'City Council', topics: [], title: 'An Ordinance for 4100 Hampton Boulevard', streets: ['HAMPTON BOULEVARD'], leagues: [] }));
  assert.ok(!matchesWatch(w, { body: 'City Council', topics: [], title: 'An Ordinance Approving a Lease With John Hampton', streets: [], leagues: [] }), 'a person named Hampton is never matched');
  assert.ok(!matchesWatch(w, { body: 'City Council', topics: [], title: 'Hampton', streets: ['NORTHAMPTON BOULEVARD'], leagues: [] }), 'a street, not a substring');
  assert.deepEqual(streetsIn({ streets: ['virginia beach', '21st street', 'granby'] }, { streets: ['E VIRGINIA BEACH BOULEVARD', 'W 21ST STREET'] }), ['virginia beach', '21st street']);
  // A phrase that names a street with its type stays a phrase, and matches by listed address too
  // ("Hampton Boulevard" against a title's "Hampton Blvd."; fifth review). One without a type doesn't:
  // "granby" never matches an item just for being on Granby Street.
  const full = checkWatch({ phrases: ['Hampton Boulevard', 'granby'] }, { ...opts, book: CITY_BOOK });
  assert.deepEqual([full.watch.phrases, full.watch.streets], [['hampton boulevard', 'granby'], []]);
  const blvd = { body: 'City Council', topics: [], title: 'A Conditional Use Permit at 1209 Hampton Blvd.', streets: ['HAMPTON BOULEVARD'], leagues: [] };
  assert.ok(matchesWatch(full.watch, blvd));
  assert.deepEqual(streetsIn(full.watch, blvd), ['hampton boulevard']);
  assert.ok(!matchesWatch({ ...full.watch, phrases: ['granby'] }, { body: 'City Council', topics: [], title: 'A Sign Permit Downtown', streets: ['GRANBY STREET'], leagues: [] }));
  // A word that is both a common surname and a street ("church", "park") was refused before the list; now it watches that street.
  assert.deepEqual(checkPhrases(['church'], { ...guard, book: CITY_BOOK }).streets, ['church']);
  assert.equal(watchLabel({ topics: [], phrases: ['dog park'], streets: ['21st street'], bodies: BODIES }, TOPICS), '"dog park", 21st Street (street), at City Council or Planning Commission');
  assert.ok(!sameWatch({ streets: ['hampton'], bodies: BODIES }, { phrases: ['hampton'], bodies: BODIES }));
  assert.match(checkWatch({ phrases: ['hampton', '21st street', '38th', 'dog park', 'food truck', 'bus stop'] }, { ...opts, book: CITY_BOOK }).error, /at most 5 phrases and streets/);
});

test('matching: the topics, the body and the league', () => {
  const item = { body: 'Planning Commission', topics: ['short_term_rentals'], leagues: ['Ocean View'] };
  const w = { topics: ['short_term_rentals'], league: null, bodies: BODIES };
  assert.ok(matchesWatch(w, item));
  assert.ok(!matchesWatch({ ...w, topics: ['tattoo'] }, item));
  assert.ok(!matchesWatch({ ...w, bodies: ['City Council'] }, item));
  assert.ok(matchesWatch({ topics: [], league: 'Ocean View', bodies: BODIES }, item));
  assert.ok(!matchesWatch({ topics: [], league: 'Ghent', bodies: BODIES }, item));
  assert.ok(!matchesWatch({ topics: ['short_term_rentals'], league: 'Ghent', bodies: BODIES }, item));
  assert.ok(sameWatch({ topics: ['b', 'a'], league: null, bodies: BODIES }, { topics: ['a', 'b'], league: null, bodies: [...BODIES].reverse() }));
  assert.equal(watchLabel({ topics: [], league: 'Ghent', bodies: BODIES }, TOPICS), 'everything in Ghent, at City Council or Planning Commission');
  assert.equal(watchLabel({ topics: ['short_term_rentals'], league: null, bodies: BODIES }, TOPICS), 'Short-term rentals, at City Council or Planning Commission');
});

test('the offer: one per answer, only with the Worker\'s checker; a request off the list is told to say so', () => {
  const ctx = { watches: { check: (a) => checkWatch(a, opts), topics: TOPICS } };
  const first = offerWatch(ctx, { topics: ['short_term_rentals'] });
  assert.equal(first.offered, true);
  assert.deepEqual(ctx.watchOffer.labels, ['Short-term rentals']);
  assert.match(first.note, /Never say it is already set up/);
  assert.equal(offerWatch(ctx, { topics: ['tattoo'] }).note, 'A watch is already offered for this answer.');
  assert.match(offerWatch({ watches: ctx.watches }, { topics: ['ghosts'] }).note, /a few plain words agenda titles would use; never a person's name/);
  assert.equal(offerWatch({}, { topics: ['tattoo'] }).offered, false);
});

test('without watches, the tools and the prompt are as before; with them, offer_watch takes topic ids only', () => {
  const plain = toolsFor(norfolk);
  assert.ok(!plain.some((t) => t.function.name === 'offer_watch'));
  assert.deepEqual(toolsFor(norfolk, [], {}), plain);
  const withWatch = toolsFor(norfolk, [], { watches: { bodies: BODIES, topics: TOPICS } });
  const names = withWatch.map((t) => t.function.name);
  assert.equal(names.indexOf('offer_watch'), names.indexOf('offer_followup') + 1);
  const params = withWatch.find((t) => t.function.name === 'offer_watch').function.parameters.properties;
  assert.deepEqual(params.topics.items.enum, TOPICS.map((t) => t.id));
  assert.deepEqual(params.bodies.items.enum, BODIES);
  assert.equal(params.phrases.items.type, 'string', 'phrases, for a member\'s own words');
  assert.ok(!systemPrompt(norfolk, '2026-11-16').includes(WATCH_LINE));
  assert.ok(systemPrompt(norfolk, '2026-11-16', { watches: true }).includes(WATCH_LINE));
  assert.ok(watchableCity(norfolk));
  // A plugin can't take the name.
  assert.throws(() => toolsFor(norfolk, [definePlugin({ name: 'offer_watch', description: 'x', run: () => null })]), /would replace a core tool/);
});

// ---- the snapshot, the job, the mail and the feeds, with the City faked ----

const MEETING_HTML = `<span id="ContentPlaceholder1_lblMeetingGroup">Planning Commission</span>
<span id="ContentPlaceholder1_lblMeetingType">Public Hearing</span>
<span id="ContentPlaceholder1_lblMeetingDate">11/19/2026 2:30 PM</span>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6085&CssClass='>JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental) at 1210 Granby Street (Ward 5/Superward 6)</a>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6084&CssClass='>SEASIDE RENTALS, LLC, for a Conditional Use Permit (Renewal) to operate a Short-Term Rental (Vacation Rental) at 8400 Shore Drive</a>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6014&CssClass='>HAPPY TAILS, for a Conditional Use Permit to operate a Kennel at 4200 Colley Avenue</a>`;
// Names in the fixtures' titles: shown in emails and feeds as the City posted them since 2026-11-18
// (Jason: "allow names through in content - titles and descriptions"); a watch still can't follow one.
const NAMES = /JANE DOE|SEASIDE RENTALS|HAPPY TAILS|WILL PRICE/i;

// The BZA posts its agenda as a file, and iqm2 answers If-Modified-Since with a 304 (checked 2026-11-18).
const FILE_DATE = 'Wed, 14 Oct 2026 19:41:26 GMT';
function cityFetch({ extraItem = null, meetingDown = false, itemPages = {}, bza = null, bzaDown = false, council = false } = {}) {
  const calls = [];
  const conditional = [];
  const fetchImpl = async (input, init) => {
    const url = String(input?.url || input);
    calls.push(url);
    if (url.includes('/resource/dszu-h9cf.json')) {
      return Response.json([
        { date_and_time: '2026-11-19T14:30:00.000', organization: 'Planning Commission', type: 'Public Hearing', location: '11th floor Council Chamber', meeting_link: { url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=4674' } },
        ...(bza ? [{ date_and_time: '2026-11-19T10:00:00.000', organization: 'Board of Zoning Appeals', type: 'Public Hearing', location: '11th floor Council Chamber', meeting_link: { url: 'https://norfolkcityva.iqm2.com//Citizens/Detail_Meeting.aspx?ID=4560' } }] : []),
        // A task force the notices list under City Council, whose agenda is only a slide deck (review 6: meeting 4293).
        ...(council ? [{ date_and_time: '2026-11-20T15:00:00.000', organization: 'City Council', type: 'Task Force', location: 'Room 1001', meeting_link: { url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=4293' } }] : []),
      ]);
    }
    if (council && url.includes('Detail_Meeting.aspx?ID=4293')) {
      return new Response(`<span id="ContentPlaceholder1_lblMeetingGroup">City Council</span><a href="FileOpen.aspx?Type=14&amp;ID=3448&amp;Inline=True" target="_blank">Agenda</a>`);
    }
    if (bza && url.includes('Detail_Meeting.aspx?ID=4560')) {
      return new Response(`<span id="ContentPlaceholder1_lblMeetingGroup">Board of Zoning Appeals</span><a href="FileOpen.aspx?Type=14&amp;ID=3431&amp;Inline=True" target="_blank">Agenda</a><a href="FileOpen.aspx?Type=1&amp;ID=3431&amp;Inline=True">Agenda Packet</a>`);
    }
    if (bza && url.includes('FileOpen.aspx?Type=14&ID=3431')) {
      if (bzaDown) return new Response('', { status: 503 });
      const since = init?.headers?.['If-Modified-Since'];
      if (since) conditional.push(since);
      if (since === FILE_DATE) return new Response(null, { status: 304, headers: { 'Last-Modified': FILE_DATE } });
      return new Response(bza, { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'public', 'Last-Modified': FILE_DATE, 'Content-Length': String(bza.length) } });
    }
    const page = /Detail_LegiFile\.aspx\?ID=(\d+)/.exec(url);
    if (page && itemPages[page[1]]) return new Response(`<span id="ContentPlaceholder1_lblLegiFileTitle">x</span>${itemPages[page[1]]}`, { headers: { 'Cache-Control': 'no-cache, no-store' } });
    if (url.includes('Detail_Meeting.aspx?ID=4674')) {
      if (meetingDown) return new Response('', { status: 503 });
      const more = extraItem ? `\n<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6200&CssClass='>${extraItem}</a>` : '';
      return new Response(MEETING_HTML + more, { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response('not faked', { status: 404 });
  };
  return { fetchImpl, calls, conditional };
}

test('the snapshot: described items, no titles kept, tagged by civic league, first-seen kept, an unreadable meeting carried', async () => {
  const kv = readyEnv().LIMITS;
  const { fetchImpl, calls } = cityFetch();
  const now = Date.parse('2026-11-16T12:00:00Z');
  const snap = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl, now, book: BOOK });
  assert.equal(snap.meetings.length, 1);
  assert.deepEqual(snap.items.map((i) => [i.id, i.kind, i.topics, i.leagues]), [
    ['6085', 'Conditional Use Permit', ['short_term_rentals'], ['Willoughby']],
    ['6084', 'Conditional Use Permit renewal', ['short_term_rentals'], ['Ocean View']],
    ['6014', 'Conditional Use Permit', ['animals'], ['Ghent']],
  ]);
  // The title is kept for matching phrases, and only in the title field.
  assert.ok(snap.items.every((i) => typeof i.title === 'string'));
  assert.doesNotMatch(JSON.stringify(snap.items.map(({ title, ...rest }) => rest)), NAMES, 'no title text outside the title field');
  assert.deepEqual(snap.leagues, LEAGUES);
  assert.deepEqual(snap.items.map((i) => i.streets), [['GRANBY STREET'], ['SHORE DRIVE'], ['COLLEY AVENUE']]);
  assert.ok(calls.some((u) => /organization%20in%20\('City%20Council'%2C%20'Planning%20Commission'%2C%20'Board%20of%20Zoning%20Appeals'%2C%20'Architectural%20Review%20Board'\)/.test(u)));
  // Each item's page is read (Jason, 2026-11-18: "read the full agenda"); here they aren't faked, so each item keeps its title alone.
  assert.equal(snap.pages.read, 3);
  assert.equal(snap.pages.failed, 3);
  assert.deepEqual(snap.items[0].source, { publisher: 'City of Norfolk', record: 'public', document: 'agenda item page', url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=6085', read: '2026-11-16' });
  // Addresses and leagues come from the address list: the portal is asked nothing per address.
  assert.ok(!calls.some((u) => u.includes('ere7-kake')), 'no address lookups');
  const again = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl, now: now + 864e5, book: BOOK });
  assert.equal(again.items[0].first_seen, snap.items[0].first_seen);
  assert.deepEqual(await readSnapshot(kv, 'norfolk'), again);
  const down = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch({ meetingDown: true }).fetchImpl, now: now + 2 * 864e5, book: BOOK });
  assert.equal(down.failed, 1);
  assert.equal(down.items.length, 3, "yesterday's items carried");
  assert.deepEqual(down.items.map((i) => i.leagues), [['Willoughby'], ['Ocean View'], ['Ghent']], 'carried items placed again against the list');
  // With no address list, no item gets an address or a league.
  const bare = await buildSnapshot({ kv: readyEnv().LIMITS, city: norfolk, cityId: 'norfolk', fetchImpl, now });
  assert.ok(bare.items.every((i) => !i.addresses.length && !i.leagues.length && !i.streets.length));
  assert.deepEqual(bare.leagues, []);
});

// A cover letter in the City's numbered format (src/adapters/iqm2.js parseTransmittal).
const LETTER = (description) => `<h4>Council Transmittal Letter</h4><div>I. Recommendation: Adopt. II. Applicant: Jane Roe, 100 Colley Avenue III. Description: ${description} IV. Analysis: The use is consistent with the plan.</div><h4>History</h4>`;

test('each item\'s own page: the City\'s description adds topics, places and phrase matches its title lacks, and is quoted beside the title', async () => {
  const kv = readyEnv().LIMITS;
  const now = Date.parse('2026-11-16T12:00:00Z');
  // The page lists attachments, a letter among them: watches never open one (correspondence is readable in chat, never alertable).
  const attachments = `<h4>Attachments</h4><ol><li><a href='https://NorfolkCityVA.iqm2.com/Citizens/FileOpen.aspx?Type=4&ID=77'>Letter of Opposition from Jane Example</a></li></ol>`;
  const { fetchImpl, calls } = cityFetch({ itemPages: { 6014: attachments + LETTER('This request would allow outdoor dog runs at a kennel in a historic district at 4200 Colley Avenue.') } });
  const snap = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl, now, book: BOOK });
  assert.ok(!calls.some((u) => /FileOpen\.aspx\?Type=4/.test(u)), 'no attachment is ever read for a watch');
  assert.doesNotMatch(JSON.stringify(snap), /Jane Example|Opposition/, 'nor its title kept');
  const kennel = snap.items.find((i) => i.id === '6014');
  assert.deepEqual([...kennel.topics].sort(), ['animals', 'design_historic']);
  // The description is in the summary (quoted); details holds the rest kept (the analysis), for phrases only.
  assert.match(kennel.summary, /outdoor dog runs/);
  assert.equal(kennel.details, 'The use is consistent with the plan.');
  assert.doesNotMatch(JSON.stringify(kennel), /Jane Roe/, 'the applicant section is never kept');
  assert.ok(matchesWatch({ topics: [], phrases: ['dog runs'], bodies: BODIES }, kennel), 'a phrase found in the description');
  assert.ok(!matchesWatch({ topics: [], phrases: ['dog runs'], bodies: BODIES }, snap.items.find((i) => i.id === '6085')));
  // Quoted as the City posted it: the title, and the description (request and description; the analysis stays out).
  const feed = atomFeed({ snapshot: snap, slug: 'all', origin: 'https://ask-siren.jason-edelman.org', appName: 'Siren', topics: TOPICS });
  assert.match(feed, /<title>HAPPY TAILS, for a Conditional Use Permit to operate a Kennel at 4200 Colley Avenue<\/title>/);
  assert.match(feed, /This request would allow outdoor dog runs at a kennel/);
  assert.doesNotMatch(feed, /consistent with the plan|Jane Roe/, 'the analysis and the applicant section stay out');
  assert.equal(snap.pages.failed, 2, 'the two pages not faked');
});

test('a board that posts its agenda as a file (the BZA): items read from the PDF, described, then revalidated with If-Modified-Since', async () => {
  const kv = readyEnv().LIMITS;
  const now = Date.parse('2026-11-16T12:00:00Z');
  const pdf = await makePdf([[
    'PUBLIC HEARING AGENDA FOR THE CITY OF NORFOLK',
    'BOARD OF ZONING APPEALS',
    'REGULAR AGENDA',
    '1. JANE EXAMPLE - for a variance from minimum lot area of Table 3.2.9.B of the Norfolk',
    'Zoning Ordinance on property located at 1210 Granby Street, zoned MF-NS (Multi-Family –',
    'Neighborhood-Scale) & Park Place NRO (Neighborhood Resilience Overlay)',
    'Information concerning the above proposal may be seen at the office of the Department of City Planning.',
  ]]);
  const city = cityFetch({ bza: pdf });
  const snap = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: city.fetchImpl, now, book: BOOK });
  const bza = snap.items.filter((i) => i.body === 'Board of Zoning Appeals');
  // Topics come from what it asks, not its zoning district ("Multi-Family", "Resilience") or the ordinance it cites.
  assert.deepEqual(bza.map((i) => [i.kind, i.topics, i.addresses, i.leagues]), [['Variance', [], ['1210 Granby Street'], ['Willoughby']]]);
  assert.equal(bza[0].source.document, 'agenda file');
  assert.equal(bza[0].url, 'https://norfolkcityva.iqm2.com/Citizens/FileOpen.aspx?Type=14&ID=3431&Inline=True');
  assert.ok(!city.calls.some((u) => /Type=1&/.test(u)), 'never the packet');
  assert.match(bza[0].title, /^JANE EXAMPLE - for a variance/);
  assert.equal(snap.meetings.find((m) => m.id === '4560').items, 1);
  const again = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: city.fetchImpl, now: now + 864e5, book: BOOK });
  assert.deepEqual(city.conditional, [FILE_DATE], 'the second read asked If-Modified-Since and got a 304');
  assert.deepEqual(again.items.filter((i) => i.body === 'Board of Zoning Appeals').map((i) => [i.key, i.first_seen]), bza.map((i) => [i.key, i.first_seen]));
  assert.match(atomFeed({ snapshot: again, slug: 'willoughby', origin: 'https://ask-siren.jason-edelman.org', appName: 'Siren', topics: TOPICS }), /<title>JANE EXAMPLE - for a variance from minimum lot area of Table 3\.2\.9\.B of the Norfolk Zoning Ordinance on property located at 1210 Granby Street, zoned MF-NS \(Multi-Family – Neighborhood-Scale\) &amp; Park Place NRO \(Neighborhood Resilience Overlay\)<\/title>[\s\S]*Variance, at 1210 Granby Street\.[\s\S]*Source: City of Norfolk, posted agenda \(public record\)/);
});

test("files: only the boards that post them (never a Council task force's slide deck); a file that can't be read keeps yesterday's items", async () => {
  const kv = readyEnv().LIMITS;
  const now = Date.parse('2026-11-16T12:00:00Z');
  const pdf = await makePdf([['BOARD OF ZONING APPEALS', 'I. Public Hearing', '1. JANE EXAMPLE – for a variance on property located at 1210 Granby Street, zoned R-8 (Single-Family).']]);
  const city = cityFetch({ bza: pdf, council: true });
  const snap = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: city.fetchImpl, now, book: BOOK });
  assert.ok(!city.calls.some((u) => /ID=3448/.test(u)), 'the task force file is never read');
  assert.equal(snap.meetings.find((m) => m.id === '4293').items, 0);
  const bza = snap.items.filter((i) => i.body === 'Board of Zoning Appeals');
  assert.equal(bza.length, 1);
  const down = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch({ bza: pdf, bzaDown: true }).fetchImpl, now: now + 864e5, book: BOOK });
  assert.equal(down.files_failed, 1);
  const carried = down.items.filter((i) => i.body === 'Board of Zoning Appeals');
  assert.deepEqual(carried.map((i) => [i.key, i.first_seen, i.addresses, i.leagues]), bza.map((i) => [i.key, i.first_seen, i.addresses, i.leagues]), "yesterday's items, placed again");
  assert.equal(down.meetings.find((m) => m.id === '4560').items, 1);
});

test("places come from the title and the letter's request, never another property its description mentions (review 6, item 5961)", async () => {
  const kv = readyEnv().LIMITS;
  const now = Date.parse('2026-11-16T12:00:00Z');
  const letter = `<h4>Council Transmittal Letter</h4><div>I. Recommendation: Adopt. II. Request: To operate a kennel at 4200 Colley Avenue. III. Description: The applicant also operates a shop located at 1210 Granby Street. IV. Analysis: Fine.</div><h4>History</h4>`;
  const snap = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch({ itemPages: { 6014: letter } }).fetchImpl, now, book: BOOK });
  const kennel = snap.items.find((i) => i.id === '6014');
  assert.deepEqual(kennel.addresses, ['4200 Colley Avenue']);
  assert.deepEqual(kennel.leagues, ['Ghent']);
  assert.match(kennel.summary, /1210 Granby Street/, 'still quoted as the City wrote it');
});

const USER = 'member@example.org';
async function member(env) {
  const uid = await userId(SECRET, USER);
  await env.LIMITS.put(`member:${uid}`, JSON.stringify({ invite: 'x' }));
  return { uid, cookie: `${userCookieName('')}=${await signUser(SECRET, uid)}` };
}
const watchEnv = (over = {}) => readyEnv({ WATCHES: 'true', RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>', INVITE_REQUIRED: 'true', BLUESKY_LOGIN: undefined, ...over });
const deps = { cityIds: ['norfolk'], cities: { norfolk }, names: () => names, ordinary: ordinaryWords, textCheck: () => textCheck, book: () => BOOK };
async function api(env, cookie, path, body, headers = {}) {
  const req = new Request(`https://ask-siren.jason-edelman.org${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', Origin: 'https://ask-siren.jason-edelman.org' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await handleWatches(req, env, path, deps);
  return { status: res.status, body: await res.json() };
}
const built = (env) => buildSnapshot({ kv: env.LIMITS, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch().fetchImpl, now: Date.parse('2026-11-16T12:00:00Z'), book: BOOK });

// KV as Cloudflare runs it in one respect: a second write (put or delete) to
// the same key within a second is refused with a 429 (Workers KV docs). A
// test's job run finishes well inside a second, so every key may be written
// once per run. (Review of #62: the day's mail counter was written per send.)
function strictKV(kv) {
  let written = new Set();
  const once = (key) => {
    if (written.has(key)) throw new Error(`KV 429: ${key} written twice within a second`);
    written.add(key);
  };
  return {
    get: (...a) => kv.get(...a),
    list: (...a) => kv.list(...a),
    // The job never writes a watch, only its sent key (a stale copy written back would undo a stop; review of #62).
    put: async (key, ...a) => { if (/^watch:/.test(key)) throw new Error(`the job wrote ${key}`); once(key); return kv.put(key, ...a); },
    delete: async (key) => { once(key); return kv.delete(key); },
    nextSecond: () => { written = new Set(); },
  };
}

test('starting a watch: only with the email this account signed in with, kept encrypted, never shown back', async () => {
  const env = watchEnv();
  const { cookie, uid } = await member(env);
  await built(env);
  assert.equal((await api(env, '', '/api/watches')).status, 401);
  const wrong = await api(env, cookie, '/api/watches', { topics: ['short_term_rentals'], email: 'someone@example.org' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'email');
  const ok = await api(env, cookie, '/api/watches', { topics: ['short_term_rentals', 'harris'], email: ' Member@Example.org ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.watch.topics, ['short_term_rentals']);
  assert.deepEqual(ok.body.refused, ['harris']);
  // What's already on a posted agenda comes back, described.
  // The City's titles as posted, with Siren's summary beside each.
  assert.deepEqual(ok.body.already.map((i) => i.summary), ['Conditional Use Permit: Short-term rentals, at 1210 Granby Street', 'Conditional Use Permit renewal: Short-term rentals, at 8400 Shore Drive']);
  assert.match(ok.body.already[0].description, /^JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental/);
  const raw = await env.LIMITS.get(`watch:${ok.body.watch.id}`);
  assert.ok(!raw.toLowerCase().includes('member@'), 'the address is never stored in the clear');
  // The key expires a week after the watch ends, so it goes even if the job never runs.
  const put = env.LIMITS.ops.filter((o) => o.op === 'put' && o.key === `watch:${ok.body.watch.id}`).at(-1);
  assert.equal(put.opts.expiration, Math.floor(Date.parse(ok.body.watch.ends) / 1000) + 7 * 86400);
  const stored = JSON.parse(raw);
  assert.equal(stored.u, uid);
  assert.equal(await openEmail(SECRET, stored.id, stored.email), USER);
  await assert.rejects(openEmail(SECRET, 'another-id-000', stored.email));
  const list = await api(env, cookie, '/api/watches');
  assert.equal(list.body.watches.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(USER));
  assert.deepEqual(list.body.options.norfolk.leagues, LEAGUES);
  assert.deepEqual(list.body.options.norfolk.topics.map((t) => t.id), TOPICS.map((t) => t.id));
  assert.equal((await api(env, cookie, '/api/watches', { topics: ['short_term_rentals'], email: USER })).status, 409);
  for (const t of ['animals', 'tattoo', 'signs', 'restaurants']) assert.equal((await api(env, cookie, '/api/watches', { topics: [t], email: USER })).status, 200, t);
  const sixth = await api(env, cookie, '/api/watches', { topics: ['alcohol'], email: USER });
  assert.equal(sixth.status, 409);
  assert.match(sixth.body.error, /5 watches/);
  const other = await signUser(SECRET, await userId(SECRET, 'other@example.org'));
  assert.equal((await api(env, `${userCookieName('')}=${other}`, '/api/watches/delete', { id: ok.body.watch.id })).status, 404);
  assert.equal((await api(env, cookie, '/api/watches/renew', { id: ok.body.watch.id })).status, 200);
  assert.equal((await api(env, cookie, '/api/watches/delete', { id: ok.body.watch.id })).status, 200);
  assert.equal(await env.LIMITS.get(`watch:${ok.body.watch.id}`), null);
  assert.equal((await api(env, cookie, '/api/watches', { topics: ['alcohol'], email: USER }, { Origin: 'https://evil.example' })).status, 403);
});

test('a stop link works without signing in, and only for its own watch', async () => {
  const env = watchEnv();
  const { cookie } = await member(env);
  const made = await api(env, cookie, '/api/watches', { topics: ['animals'], email: USER });
  const id = made.body.watch.id;
  const t = await stopToken(SECRET, id);
  assert.equal((await api(env, '', '/api/watches/stop', { t: `${id}.forged` })).status, 400);
  assert.equal((await api(env, '', '/api/watches/stop', { t })).status, 200);
  assert.equal(await env.LIMITS.get(`watch:${id}`), null);
});

test('the daily job: one digest a day per watch, described items only, never an item twice, each KV key written once', async () => {
  const env = watchEnv();
  const { cookie } = await member(env);
  await built(env);
  const made = await api(env, cookie, '/api/watches', { topics: ['short_term_rentals'], email: USER });
  await api(env, cookie, '/api/watches', { league: 'Ghent', email: USER });
  for (const t of ['animals', 'nightlife', 'city_property']) await api(env, cookie, '/api/watches', { topics: [t], email: USER });
  const strict = strictKV(env.LIMITS);
  const jobEnv = { ...env, LIMITS: strict };
  const sent = [];
  const send = async (_env, msg) => { sent.push(msg); return { id: 'e' }; };
  let at = Date.parse('2026-11-17T11:30:00Z');
  const run = (extraItem) => {
    strict.nextSecond();
    return runWatchJob(jobEnv, { ...deps, appName: 'Siren', fetchImpl: cityFetch({ extraItem }).fetchImpl, send, now: () => at });
  };
  const first = await run();
  assert.equal(first.ran, true);
  assert.equal(sent.length, 3, 'short-term rentals, Ghent and animals have matches');
  assert.equal(await env.LIMITS.get('watch-mail:2026-11-17'), '3', "the day's count, written once");
  // Each item is quoted as the City posted it, then Siren's summary.
  assert.ok(sent.every((m) => NAMES.test(m.text) && /quoted as the City posted it \(a public record\)/.test(m.text)));
  const rentals = sent.find((m) => m.text.includes('watch Short-term rentals'));
  assert.equal(rentals.to, USER);
  assert.match(rentals.subject, /^Siren: 2 agenda items for your watch$/);
  assert.match(rentals.text, /Planning Commission Public Hearing, Thursday, November 19, 2026, 2:30 PM \(11th floor Council Chamber\)/);
  assert.match(rentals.text, /- JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental \(Vacation Rental\) at 1210 Granby Street \(Ward 5\/Superward 6\)\n {2}Conditional Use Permit: Short-term rentals, at 1210 Granby Street · Willoughby\n {2}https:\/\/norfolkcityva\.iqm2\.com\/Citizens\/Detail_LegiFile\.aspx\?ID=6085/);
  assert.match(rentals.text, /Each item is quoted as the City posted it \(a public record\), with Siren's summary under it/);
  assert.match(rentals.text, /You asked Siren to watch Short-term rentals, at City Council, Planning Commission, Board of Zoning Appeals or Architectural Review Board\./);
  const stop = `https://ask-siren.jason-edelman.org/watch/stop?t=${encodeURIComponent(await stopToken(SECRET, made.body.watch.id))}`;
  assert.equal(rentals.headers['List-Unsubscribe'], `<${stop}>`);
  assert.equal(rentals.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent.find((m) => m.text.includes('everything in Ghent')).text, /Conditional Use Permit: Kennels and animals, at 4200 Colley Avenue/);
  assert.equal((await run()).ran, false, 'not due again the same day');
  at += 864e5;
  await run();
  assert.equal(sent.length, 3, 'nothing new, nothing sent');
  at += 864e5;
  const third = await run('Ordinance No. 50501 : An Ordinance Authorizing the Sale and Conveyance to Will Price of That Certain Parcel of Property Located at 885 Church Street');
  assert.equal(third.ran, true);
  const fresh = sent.slice(3);
  assert.deepEqual(fresh.map((m) => m.subject), ['Siren: 1 agenda item for your watch', 'Siren: 1 agenda item for your watch']);
  assert.ok(fresh.every((m) => /\n  Sale of City property, at 885 Church Street/.test(m.text)));
  assert.ok(fresh.every((m) => /- Ordinance No\. 50501 : An Ordinance Authorizing the Sale and Conveyance to Will Price/.test(m.text)), 'quoted as posted, with no number added twice');
});

test('Resend: busy stops the round with no mark; a config refusal stops after three and deletes nothing; zero means zero', async () => {
  const env = watchEnv();
  const { cookie } = await member(env);
  await built(env);
  for (const t of ['short_term_rentals', 'animals']) await api(env, cookie, '/api/watches', { topics: [t], email: USER });
  await api(env, cookie, '/api/watches', { league: 'Willoughby', email: USER });
  await api(env, cookie, '/api/watches', { league: 'Ocean View', email: USER });
  let calls = 0;
  const busy = await runWatchJob(env, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async () => { calls++; throw new Error('Resend 429'); }, now: () => Date.parse('2026-11-17T12:00:00Z') });
  assert.equal(busy.stopped, true);
  assert.equal(calls, 1);
  // A revoked key (401) for five days: the round stops at three each day, and every watch survives.
  for (let d = 0; d < 5; d++) {
    let tries = 0;
    const out = await runWatchJob(env, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async () => { tries++; throw new Error('Resend 401'); }, now: () => Date.parse('2026-11-18T12:00:00Z') + d * 864e5 });
    assert.equal(tries, 3, `day ${d + 1}`);
    assert.equal(out.stopped, true);
  }
  assert.equal((await env.LIMITS.list({ prefix: 'watch:' })).keys.length, 4);
  const paused = [];
  await runWatchJob({ ...env, WATCH_DAILY_EMAILS: '0' }, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async (_e, m) => { paused.push(m); }, now: () => Date.parse('2026-11-24T12:00:00Z') });
  assert.equal(paused.length, 0);
  const req = new Request('https://ask-siren.jason-edelman.org/api/watches', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://ask-siren.jason-edelman.org' }, body: JSON.stringify({ topics: ['tattoo'], email: USER }) });
  assert.equal((await handleWatches(req, { ...env, WATCH_MAX: '0' }, '/api/watches', deps)).status, 503);
});

test('a sent key outlives a renewal; Resend\'s 409 is recorded as sent; a phrase hit is named in the digest', async () => {
  const env = watchEnv();
  const { cookie } = await member(env);
  await built(env);
  const made = await api(env, cookie, '/api/watches', { topics: ['short_term_rentals'], phrases: ['vacation rental'], email: USER });
  const now = Date.parse('2026-11-17T12:00:00Z');
  const sent = [];
  await runWatchJob(env, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async (_e, m) => { sent.push(m); }, now: () => now });
  const put = env.LIMITS.ops.filter((o) => o.op === 'put' && o.key === `watch-sent:${made.body.watch.id}`).at(-1);
  assert.ok(put.opts.expiration >= Math.floor(now / 1000) + 30 * 86400, 'at least a month out, whatever the watch\'s end');
  assert.match(sent[0].text, /with "vacation rental" in the City's words for it/);
  // A rerun the same day that Resend answers 409 (it already has the key): recorded, not counted against anything.
  const env2 = watchEnv();
  const c2 = (await member(env2)).cookie;
  await built(env2);
  const w2 = await api(env2, c2, '/api/watches', { topics: ['short_term_rentals'], email: USER });
  const out = await runWatchJob(env2, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async () => { throw new Error('Resend 409'); }, now: () => now });
  assert.equal(out.failed, 0);
  assert.equal(out.stopped, false);
  assert.equal(JSON.parse(await env2.LIMITS.get(`watch-sent:${w2.body.watch.id}`)).seen.length, 2);
});

test('a stop made while the run is mailing stays stopped', async () => {
  const env = watchEnv();
  const { cookie } = await member(env);
  await built(env);
  const made = await api(env, cookie, '/api/watches', { topics: ['short_term_rentals'], email: USER });
  const t = await stopToken(SECRET, made.body.watch.id);
  const send = async () => {
    // The member presses the stop link while their mail is going out.
    assert.equal((await api(env, '', '/api/watches/stop', { t })).status, 200);
    return { id: 'e' };
  };
  await runWatchJob(env, { ...deps, fetchImpl: cityFetch().fetchImpl, send, now: () => Date.parse('2026-11-17T12:00:00Z') });
  assert.equal(await env.LIMITS.get(`watch:${made.body.watch.id}`), null, 'not written back');
});

test('watches at their end are deleted that day, with their note when the cap allows, even with mail paused or the city gone', async () => {
  const ended = async (env, id, city) => env.LIMITS.put(`watch:${id}`, JSON.stringify({ v: 1, id, u: 'u', city, topics: ['tattoo'], league: null, bodies: BODIES, created: '2025-11-01T00:00:00Z', ends: '2026-11-01T00:00:00Z', email: await sealEmail(SECRET, id, USER), seen: [] }), { metadata: { u: 'u' } });
  const paused = watchEnv({ WATCH_DAILY_EMAILS: '0' });
  await built(paused);
  await ended(paused, 'ended-watch-001', 'norfolk');
  const notes = [];
  const out = await runWatchJob(paused, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async (_e, m) => { notes.push(m); }, now: () => Date.parse('2026-11-17T12:00:00Z') });
  assert.equal(out.ended, 1);
  assert.equal(notes.length, 0, 'no note with mail paused');
  assert.equal(await paused.LIMITS.get('watch:ended-watch-001'), null, 'deleted all the same');
  const env = watchEnv();
  await built(env);
  await ended(env, 'ended-watch-002', 'atlantis');
  const notes2 = [];
  const out2 = await runWatchJob(env, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async (_e, m) => { notes2.push(m); }, now: () => Date.parse('2026-11-17T12:00:00Z') });
  assert.equal(out2.ended, 1);
  assert.match(notes2[0].subject, /has ended/);
  assert.equal(await env.LIMITS.get('watch:ended-watch-002'), null);
});

test('the job is due once a day after the hour, or at once when there is no snapshot yet', async () => {
  const kv = readyEnv().LIMITS;
  assert.equal(await jobDue(kv, ['norfolk'], Date.parse('2026-11-17T03:00:00Z')), true, 'no snapshot yet');
  await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch().fetchImpl, now: Date.parse('2026-11-17T03:00:00Z') });
  assert.equal(await jobDue(kv, ['norfolk'], Date.parse('2026-11-17T03:10:00Z')), false, 'before the hour, with a snapshot');
  assert.equal(await jobDue(kv, ['norfolk'], Date.parse('2026-11-17T11:00:00Z')), true);
  await kv.put('watch-run:2026-11-17', 'x');
  assert.equal(await jobDue(kv, ['norfolk'], Date.parse('2026-11-17T15:00:00Z')), false);
});

test('feeds: one per civic league and one for everything, described items, escaped', async () => {
  const kv = readyEnv().LIMITS;
  const snapshot = await buildSnapshot({ kv, book: BOOK, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch({ extraItem: 'JOHN <b>"ROE"</b> &amp; Co, for a Conditional Use Permit to operate a Tattoo Parlor at 4200 Colley Avenue' }).fetchImpl, now: Date.parse('2026-11-16T12:00:00Z') });
  const origin = 'https://ask-siren.jason-edelman.org';
  const ghent = atomFeed({ snapshot, slug: leagueSlug('Ghent'), origin, appName: 'Siren', topics: TOPICS });
  assert.match(ghent, /<title>Ghent: upcoming City Council, Planning Commission, Board of Zoning Appeals and Architectural Review Board agenda items<\/title>/);
  assert.match(ghent, /Source: City of Norfolk, agenda item \(public record\), read 2026-11-16/);
  assert.equal((ghent.match(/<entry>/g) || []).length, 2);
  // Quoted and escaped: the markup in the City's page never reaches the feed as markup.
  assert.match(ghent, /<title>JOHN &quot;ROE&quot; &amp; Co, for a Conditional Use Permit to operate a Tattoo Parlor at 4200 Colley Avenue<\/title>/);
  assert.match(ghent, /<summary>[^<]*Conditional Use Permit: Tattoo parlors, at 4200 Colley Avenue\./);
  assert.doesNotMatch(ghent, /<b>|&lt;b&gt;/);
  const all = atomFeed({ snapshot, slug: 'all', origin, appName: 'Siren', topics: TOPICS });
  assert.equal((all.match(/<entry>/g) || []).length, 4);
  assert.match(all, NAMES);
  assert.equal(atomFeed({ snapshot, slug: 'atlantis', origin, appName: 'Siren', topics: TOPICS }), null);
  assert.equal(leagueSlug('Algonquin Park and North Shore Point'), 'algonquin-park-and-north-shore-point');
  assert.equal(meetingTime('2026-12-01T18:00:00.000'), 'Tuesday, December 1, 2026, 6:00 PM');
});

test('sealing: the same address seals differently each time and opens only under its own watch id; a Council digest says how to speak', async () => {
  const a = await sealEmail(SECRET, 'watch-aaaaaaaa', USER);
  const b = await sealEmail(SECRET, 'watch-aaaaaaaa', USER);
  assert.notEqual(a.ct, b.ct);
  assert.equal(await openEmail(SECRET, 'watch-aaaaaaaa', a), USER);
  await assert.rejects(openEmail('another-secret-that-is-long-enough', 'watch-aaaaaaaa', a));
  const d = digest({ appName: 'Siren', watch: { topics: ['budget'], league: null, bodies: BODIES, ends: '2027-11-16T00:00:00Z' }, items: [{ meeting: '1', body: 'City Council', when: '2026-12-01T18:00:00.000', kind: 'Budget or appropriation', topics: ['budget'], addresses: [], url: 'https://example.org/1', number: 'Ordinance No. 1' }], meetings: [{ id: '1', body: 'City Council', type: 'Formal Session', when: '2026-12-01T18:00:00.000', location: 'Council Chamber', url: 'https://example.org/m' }], city: norfolk, stopUrl: 'https://s/stop', manageUrl: 'https://s/watches' });
  // The topic the kind already names isn't repeated.
  assert.match(d.text, /- Budget or appropriation \(Ordinance No\. 1\)/);
  // A street watch's hit is named by the street, from the listed address.
  const onStreet = digest({ appName: 'Siren', watch: { topics: [], streets: ['hampton'], league: null, bodies: BODIES, ends: '2027-11-16T00:00:00Z' }, items: [{ meeting: '1', body: 'City Council', when: '2026-12-01T18:00:00.000', kind: 'Encroachment into a right-of-way', topics: [], addresses: ['4100 Hampton Boulevard'], streets: ['HAMPTON BOULEVARD'], url: 'https://example.org/2' }], meetings: [{ id: '1', body: 'City Council', type: 'Formal Session', when: '2026-12-01T18:00:00.000', url: 'https://example.org/m' }], city: norfolk, stopUrl: 'https://s/stop', manageUrl: 'https://s/watches' });
  assert.match(onStreet.text, /You asked Siren to watch Hampton \(street\), at City Council or Planning Commission\./);
  assert.match(onStreet.text, /\n {2}Encroachment into a right-of-way, at 4100 Hampton Boulevard, on Hampton\n/);
  assert.match(d.text, /To speak at City Council: City Clerk, \(757\) 664-4253, ccouncil@norfolk\.gov \(register by 3 p\.m\. the day of the meeting\)\./);
});
