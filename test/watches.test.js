// Watches over upcoming agendas (src/watches.js, worker/watches.js): Jason,
// 2026-11-16, "let me know if planning commission or City Council take up
// any items affecting short term rentals" by email, and civic-league feeds
// ("Let's shift from per street to per neighborhood league"). Siren never
// repeats an agenda title (titles can name private people); it describes
// each item from fixed labels and the property's address, and watches follow
// topics from a reviewed list. The names in these fixtures are invented; the
// addresses are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topicsOf, itemKind, itemNumber, describeItem, checkWatch, matchesWatch, termPattern, offerWatch, sameWatch, watchLabel, MAX_TOPICS } from '../src/watches.js';
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
const opts = { topics: TOPICS, leagues: LEAGUES, bodies: BODIES };
const describe = (title) => describeItem({ kind: itemKind(title), topics: topicsOf(title, TOPICS), addresses: extractAddresses(title) }, TOPICS);

test('items are described from fixed labels and the address, never the title: buyers, tenants and applicants stay out', () => {
  const cases = [
    ['JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental) at 1210 Sample Avenue (Ward 5/Superward 6)', 'Conditional Use Permit: Short-term rentals, at 1210 Sample Avenue'],
    ['SEASIDE RENTALS, LLC, for a Conditional Use Permit (Renewal) to operate a Short-Term Rental (Vacation Rental) at 8400 Sample Road', 'Conditional Use Permit renewal: Short-term rentals, at 8400 Sample Road'],
    // The shapes the reviews found leaking from an earlier, name-withholding design.
    ['Ordinance No. 50501 : An Ordinance Authorizing the Sale and Conveyance to Will Price of That Certain Parcel of Property Located at 885 Sample Street', 'Sale of City property, at 885 Sample Street'],
    ['An Ordinance Granting Hope Wells Permission to Encroach Into the Right-of-Way at 508 Sample Street', 'Encroachment into a right-of-way, at 508 Sample Street'],
    ['A Lease Agreement Between the City of Norfolk, as Landlord, and Bill Long, as Tenant, for Premises Located at 226 E. Sample Street', 'Lease: Sales and leases of City property, at 226 E. Sample Street'],
    ['An Ordinance Approving an Easement From Robert Price Over the Property Located at 100 Example Avenue', 'Easement, at 100 Example Avenue'],
    ['John Smith, for a Conditional Use Permit to operate a Tattoo Parlor at 5660 Example Boulevard', 'Conditional Use Permit: Tattoo parlors, at 5660 Example Boulevard'],
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
test('over all 1,452 indexed titles, every word of every description is a label word or an address word', () => {
  const idx = JSON.parse(readFileSync(new URL('../data/norfolk-legislation.json', import.meta.url), 'utf8'));
  const kinds = ['Conditional Use Permit renewal', 'Rezoning', 'Development Certificate', 'Zoning Ordinance amendment', 'Encroachment into a right-of-way', 'Sale of City property', 'Lease', 'Easement', 'Right of entry', 'Street or alley closure', 'Variance', 'Budget or appropriation', 'Design review', 'Resolution', 'Ordinance', 'Agenda item'];
  const words = (s) => String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
  const allowed = new Set([...kinds, ...TOPICS.map((t) => t.label), 'at and more'].flatMap(words));
  let n = 0;
  for (const item of idx.items) {
    const addresses = extractAddresses(item.text);
    const own = new Set([...allowed, ...addresses.flatMap(words)]);
    const desc = describe(item.text);
    const stray = words(desc).filter((w) => !own.has(w) && !/^\d+$/.test(w));
    assert.deepEqual(stray, [], `${desc} ← ${item.text.slice(0, 120)}`);
    n++;
  }
  assert.ok(n > 1400);
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
  }
  assert.equal(termPattern('bed and breakfast').test('a bed and breakfasts permit'), true);
});

test('checking a watch: topics from the list only; leagues by the City\'s spelling; bodies default to all', () => {
  assert.deepEqual(checkWatch({ topics: ['short_term_rentals', 'harris', 'Jane Doe'] }, opts), { ok: true, watch: { topics: ['short_term_rentals'], league: null, bodies: BODIES }, refused: ['harris', 'Jane Doe'] });
  assert.match(checkWatch({ topics: ['price'] }, opts).error, /aren't topics a watch can follow yet/);
  assert.deepEqual(checkWatch({ civic_league: 'ocean view' }, opts).watch, { topics: [], league: 'Ocean View', bodies: BODIES });
  assert.match(checkWatch({ civic_league: 'Atlantis' }, opts).error, /don't know a civic league called "Atlantis"/);
  assert.deepEqual(checkWatch({ topics: ['tattoo'], bodies: ['planning commission'] }, opts).watch.bodies, ['Planning Commission']);
  assert.match(checkWatch({ topics: ['tattoo'], bodies: ['Board of Zoning Appeals'] }, opts).error, /covers City Council or Planning Commission/);
  assert.match(checkWatch({}, opts).error, /needs a topic, a civic league, or both/);
  assert.match(checkWatch({ topics: TOPICS.slice(0, MAX_TOPICS + 1).map((t) => t.id) }, opts).error, /at most 8 topics/);
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
  assert.match(offerWatch({ watches: ctx.watches }, { topics: ['ghosts'] }).note, /say a watch can't follow that yet/);
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
  assert.equal('terms' in params, false, 'no free words');
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
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6085&CssClass='>JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental) at 1210 Sample Avenue (Ward 5/Superward 6)</a>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6084&CssClass='>SEASIDE RENTALS, LLC, for a Conditional Use Permit (Renewal) to operate a Short-Term Rental (Vacation Rental) at 8400 Sample Road</a>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6014&CssClass='>HAPPY TAILS, for a Conditional Use Permit to operate a Kennel at 4200 Example Avenue</a>`;
const NAMES = /JANE DOE|SEASIDE RENTALS|HAPPY TAILS|WILL PRICE/i;

function cityFetch({ extraItem = null, meetingDown = false } = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    const q = decodeURIComponent(url);
    if (url.includes('/resource/dszu-h9cf.json')) {
      return Response.json([{ date_and_time: '2026-11-19T14:30:00.000', organization: 'Planning Commission', type: 'Public Hearing', location: '11th floor Council Chamber', meeting_link: { url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=4674' } }]);
    }
    if (url.includes('/api/views/ere7-kake.json')) return Response.json({ name: 'Address Information', columns: ['full_address', 'house_number', 'full_street_name', 'civic_league'].map((fieldName) => ({ fieldName, dataTypeName: 'text' })) });
    if (url.includes('/resource/ere7-kake.json') && /GROUP BY/.test(q)) return Response.json(LEAGUES.map((l) => ({ civic_league: l, n: '10' })));
    if (url.includes('/resource/ere7-kake.json')) {
      // The league column only: the president's name and email are never asked for.
      assert.doesNotMatch(q, /president|email/i);
      return Response.json([
        { full_address: '1210 SAMPLE AVE', civic_league: 'Willoughby' },
        { full_address: '8400 SAMPLE RD', civic_league: 'Ocean View' },
        { full_address: '4200 EXAMPLE AVE', civic_league: 'Ghent' },
        { full_address: '885 SAMPLE ST', civic_league: 'Ghent' },
      ]);
    }
    if (url.includes('Detail_Meeting.aspx?ID=4674')) {
      if (meetingDown) return new Response('', { status: 503 });
      const more = extraItem ? `\n<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6200&CssClass='>${extraItem}</a>` : '';
      return new Response(MEETING_HTML + more, { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response('not faked', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('the snapshot: described items, no titles kept, tagged by civic league, first-seen kept, an unreadable meeting carried', async () => {
  const kv = readyEnv().LIMITS;
  const { fetchImpl, calls } = cityFetch();
  const now = Date.parse('2026-11-16T12:00:00Z');
  const snap = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl, now });
  assert.equal(snap.meetings.length, 1);
  assert.deepEqual(snap.items.map((i) => [i.id, i.kind, i.topics, i.leagues]), [
    ['6085', 'Conditional Use Permit', ['short_term_rentals'], ['Willoughby']],
    ['6084', 'Conditional Use Permit renewal', ['short_term_rentals'], ['Ocean View']],
    ['6014', 'Conditional Use Permit', ['animals'], ['Ghent']],
  ]);
  assert.doesNotMatch(JSON.stringify(snap), NAMES, 'no title is kept');
  assert.ok(snap.items.every((i) => !('text' in i)));
  assert.deepEqual(snap.leagues, LEAGUES);
  assert.ok(calls.some((u) => /organization%20in%20\('City%20Council'%2C%20'Planning%20Commission'\)/.test(u)));
  const again = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl, now: now + 864e5 });
  assert.equal(again.items[0].first_seen, snap.items[0].first_seen);
  assert.deepEqual(await readSnapshot(kv, 'norfolk'), again);
  const down = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch({ meetingDown: true }).fetchImpl, now: now + 2 * 864e5 });
  assert.equal(down.failed, 1);
  assert.equal(down.items.length, 3, "yesterday's items carried");
});

const USER = 'member@example.org';
async function member(env) {
  const uid = await userId(SECRET, USER);
  await env.LIMITS.put(`member:${uid}`, JSON.stringify({ invite: 'x' }));
  return { uid, cookie: `${userCookieName('')}=${await signUser(SECRET, uid)}` };
}
const watchEnv = (over = {}) => readyEnv({ WATCHES: 'true', RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>', INVITE_REQUIRED: 'true', BLUESKY_LOGIN: undefined, ...over });
const deps = { cityIds: ['norfolk'], cities: { norfolk } };
async function api(env, cookie, path, body, headers = {}) {
  const req = new Request(`https://ask-siren.jason-edelman.org${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', Origin: 'https://ask-siren.jason-edelman.org' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await handleWatches(req, env, path, deps);
  return { status: res.status, body: await res.json() };
}
const built = (env) => buildSnapshot({ kv: env.LIMITS, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch().fetchImpl, now: Date.parse('2026-11-16T12:00:00Z') });

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
    put: async (key, ...a) => { once(key); return kv.put(key, ...a); },
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
  assert.deepEqual(ok.body.already.map((i) => i.description), ['Conditional Use Permit: Short-term rentals, at 1210 Sample Avenue', 'Conditional Use Permit renewal: Short-term rentals, at 8400 Sample Road']);
  assert.doesNotMatch(JSON.stringify(ok.body), NAMES);
  const raw = await env.LIMITS.get(`watch:${ok.body.watch.id}`);
  assert.ok(!raw.toLowerCase().includes('member@'), 'the address is never stored in the clear');
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
  for (const m of sent) assert.doesNotMatch(m.text + m.html + m.subject, NAMES, 'no title in any email');
  const rentals = sent.find((m) => m.text.includes('watch Short-term rentals'));
  assert.equal(rentals.to, USER);
  assert.match(rentals.subject, /^Siren: 2 agenda items for your watch$/);
  assert.match(rentals.text, /Planning Commission Public Hearing, Thursday, November 19, 2026, 2:30 PM \(11th floor Council Chamber\)/);
  assert.match(rentals.text, /- Conditional Use Permit: Short-term rentals, at 1210 Sample Avenue\n {2}https:\/\/norfolkcityva\.iqm2\.com\/Citizens\/Detail_LegiFile\.aspx\?ID=6085/);
  assert.match(rentals.text, /without repeating it: titles can name private people/);
  const stop = `https://ask-siren.jason-edelman.org/watch/stop?t=${encodeURIComponent(await stopToken(SECRET, made.body.watch.id))}`;
  assert.equal(rentals.headers['List-Unsubscribe'], `<${stop}>`);
  assert.equal(rentals.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(sent.find((m) => m.text.includes('everything in Ghent')).text, /Conditional Use Permit: Kennels and animals, at 4200 Example Avenue/);
  assert.equal((await run()).ran, false, 'not due again the same day');
  at += 864e5;
  await run();
  assert.equal(sent.length, 3, 'nothing new, nothing sent');
  at += 864e5;
  const third = await run('Ordinance No. 50501 : An Ordinance Authorizing the Sale and Conveyance to Will Price of That Certain Parcel of Property Located at 885 Sample Street');
  assert.equal(third.ran, true);
  const fresh = sent.slice(3);
  assert.deepEqual(fresh.map((m) => m.subject), ['Siren: 1 agenda item for your watch', 'Siren: 1 agenda item for your watch']);
  assert.ok(fresh.every((m) => /Sale of City property, at 885 Sample Street \(Ordinance No\. 50501\)/.test(m.text)));
  assert.ok(fresh.every((m) => !NAMES.test(m.text + m.html)));
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
  const snapshot = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch({ extraItem: 'JOHN <b>"ROE"</b> &amp; Co, for a Conditional Use Permit to operate a Tattoo Parlor at 4200 Example Avenue' }).fetchImpl, now: Date.parse('2026-11-16T12:00:00Z') });
  const origin = 'https://ask-siren.jason-edelman.org';
  const ghent = atomFeed({ snapshot, slug: leagueSlug('Ghent'), origin, appName: 'Siren', topics: TOPICS });
  assert.match(ghent, /<title>Ghent: upcoming City Council and Planning Commission agenda items<\/title>/);
  assert.equal((ghent.match(/<entry>/g) || []).length, 2);
  assert.match(ghent, /<title>Conditional Use Permit: Tattoo parlors, at 4200 Example Avenue<\/title>/);
  assert.doesNotMatch(ghent, /ROE|<b>|HAPPY TAILS/);
  const all = atomFeed({ snapshot, slug: 'all', origin, appName: 'Siren', topics: TOPICS });
  assert.equal((all.match(/<entry>/g) || []).length, 4);
  assert.doesNotMatch(all, NAMES);
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
  assert.match(d.text, /To speak at City Council: City Clerk, \(757\) 664-4253, ccouncil@norfolk\.gov \(register by 3 p\.m\. the day of the meeting\)\./);
});
