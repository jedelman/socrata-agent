// Watches over upcoming agendas (src/watches.js, worker/watches.js): Jason,
// 2026-11-16, "let me know if planning commission or City Council take up
// any items affecting short term rentals" by email, and civic-league feeds
// ("Let's shift from per street to per neighborhood league"). The names in
// these fixtures are invented; the addresses are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withholdApplicant, checkWatch, matchesWatch, termPattern, offerWatch, sameWatch, watchLabel, WITHHELD, MAX_TERMS } from '../src/watches.js';
import { toolsFor } from '../src/tools.js';
import { systemPrompt, WATCH_LINE } from '../src/prompt.js';
import { getCity } from '../src/cities/index.js';
import { compileStreets } from '../src/public-text.js';
import { vocabulary } from '../worker/telemetry.js';
import { buildSnapshot, runWatchJob, readSnapshot, sealEmail, openEmail, stopToken, digest, atomFeed, leagueSlug, meetingTime, jobDue, watchableCity, handleWatches } from '../worker/watches.js';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import { readyEnv, SECRET } from './fake-atproto.js';
import streetsFile from '../data/gaps/norfolk-streets.json' with { type: 'json' };

const norfolk = getCity('norfolk');
const streets = compileStreets(streetsFile.streets);
const BODIES = ['City Council', 'Planning Commission'];
const LEAGUES = ['Ghent', 'Ocean View', 'Willoughby'];
const opts = { vocab: vocabulary(), streets, leagues: LEAGUES, bodies: BODIES };

test('applicants: a private applicant is withheld, an organization and the City are kept, and so is a Council title', () => {
  assert.equal(withholdApplicant('JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental) at 1210 Sample Avenue'), `${WITHHELD}, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental) at 1210 Sample Avenue`);
  assert.equal(withholdApplicant('JANE DOE AND JOHN ROE, for the following Conditional Use Permits at 26 Sample Street'), `${WITHHELD}, for the following Conditional Use Permits at 26 Sample Street`);
  assert.match(withholdApplicant('SEASIDE RENTALS, LLC, for a Conditional Use Permit (Renewal)'), /^SEASIDE RENTALS, LLC, for/);
  assert.match(withholdApplicant('CITY OF NORFOLK, for the following Conditional Use Permits'), /^CITY OF NORFOLK, for/);
  assert.match(withholdApplicant('CITY PLANNING COMMISSION, for a Zoning Ordinance text amendment'), /^CITY PLANNING COMMISSION, for/);
  // Not plainly an organization by name: withheld, as get_legislation's rule does.
  assert.match(withholdApplicant('HAPPY TAILS, for a Conditional Use Permit to operate a Kennel'), /^\[applicant's name withheld\], for a Conditional Use Permit to operate a Kennel/);
  // A name after a courtesy title, anywhere.
  assert.equal(withholdApplicant('Design review requested by Mr. John Roe for 100 Sample Street'), `Design review requested by ${WITHHELD} for 100 Sample Street`);
  const council = 'Ordinance No. 49330 : An Ordinance Granting a Conditional Use Permit to Authorize a Short-Term Rental Unit (Vacation Rental) on Property Located at 1039 Sample Avenue.';
  assert.equal(withholdApplicant(council), council);
});

test('terms: topic words are kept; names, streets, addresses and civic leagues are refused with a reason', () => {
  const out = checkWatch({ terms: ['Short-Term Rental', 'vacation rental', 'homestay', 'bed and breakfast', 'Jane Doe', 'smith', 'Colley Avenue', '810 Union St', 'Ghent', 'short term rental'] }, opts);
  assert.equal(out.ok, true);
  assert.deepEqual(out.watch, { terms: ['short term rental', 'vacation rental', 'homestay', 'bed and breakfast'], league: null, bodies: BODIES });
  const why = Object.fromEntries(out.refused.map((r) => [r.term, r.reason]));
  assert.match(why['Jane Doe'], /never a name/);
  assert.match(why.smith, /never a name/);
  assert.match(why['Colley Avenue'], /street: watch its civic league/);
  assert.match(why['810 Union St'], /no numbers/);
  assert.match(why.Ghent, /civic league/);
  // Too long, too many words, too many terms.
  assert.match(checkWatch({ terms: ['rental rental rental rental rental'] }, opts).refused[0].reason, /at most 4 words/);
  const many = checkWatch({ terms: ['rental', 'kennel', 'tattoo', 'parking', 'garage', 'signage', 'density', 'flood', 'tree'] }, opts);
  assert.equal(many.ok, false);
  assert.match(many.error, new RegExp(`at most ${MAX_TERMS} terms`));
});

test('leagues and bodies: a league is matched to the City\'s spelling, an unknown one refused; bodies default to all', () => {
  assert.deepEqual(checkWatch({ civic_league: 'ocean view' }, opts).watch, { terms: [], league: 'Ocean View', bodies: BODIES });
  assert.match(checkWatch({ civic_league: 'Atlantis' }, opts).error, /don't know a civic league called "Atlantis"/);
  assert.deepEqual(checkWatch({ terms: ['rental'], bodies: ['planning commission'] }, opts).watch.bodies, ['Planning Commission']);
  assert.match(checkWatch({ terms: ['rental'], bodies: ['Board of Zoning Appeals'] }, opts).error, /covers City Council or Planning Commission/);
  assert.match(checkWatch({}, opts).error, /needs a topic term, a civic league, or both/);
  assert.match(checkWatch({ terms: ['Jane Doe'] }, opts).error, /None of those terms can be watched/);
});

test('matching: plurals and hyphens, the body and the league; a name in the applicant\'s place never matches', () => {
  const item = (text, extra = {}) => ({ body: 'Planning Commission', text: withholdApplicant(text), leagues: ['Ocean View'], ...extra });
  const w = { terms: ['short term rental'], league: null, bodies: BODIES };
  assert.ok(matchesWatch(w, item('SEASIDE RENTALS, LLC, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental)')));
  assert.ok(matchesWatch(w, item('An Ordinance to authorize Short-Term Rentals on Property')));
  assert.ok(!matchesWatch(w, item('A kennel at 4200 Example Avenue')));
  assert.ok(!matchesWatch({ ...w, bodies: ['City Council'] }, item('a Short-Term Rental')));
  // League only: every item there; league and terms: both.
  assert.ok(matchesWatch({ terms: [], league: 'Ocean View', bodies: BODIES }, item('A kennel')));
  assert.ok(!matchesWatch({ terms: [], league: 'Ghent', bodies: BODIES }, item('A kennel')));
  assert.ok(!matchesWatch({ terms: ['kennel'], league: 'Ghent', bodies: BODIES }, item('A kennel')));
  // "park" is a word the ordinance uses; as a surname in the applicant's place it's already withheld.
  assert.ok(!matchesWatch({ terms: ['park'], league: null, bodies: BODIES }, item('JOHN PARK, for a Conditional Use Permit to operate a Restaurant')));
  assert.ok(matchesWatch({ terms: ['park'], league: null, bodies: BODIES }, item('A Conditional Use Permit for a park')));
  assert.equal(termPattern('bed and breakfast').test('a bed and breakfasts permit'), true);
});

test('the offer: one per answer, only with the Worker\'s checker, and the model is told what it can say', () => {
  const ctx = { watches: { check: (a) => checkWatch(a, opts) } };
  const first = offerWatch(ctx, { terms: ['short-term rental', 'Jane Doe'] });
  assert.equal(first.offered, true);
  assert.deepEqual(ctx.watchOffer.terms, ['short term rental']);
  assert.match(first.note, /Never say it is already set up/);
  assert.match(first.note, /Left out: "Jane Doe"/);
  assert.equal(offerWatch(ctx, { terms: ['kennel'] }).note, 'A watch is already offered for this answer.');
  assert.match(offerWatch({ watches: ctx.watches }, { terms: ['Jane Doe'] }).note, /Refused: "Jane Doe"/);
  assert.equal(offerWatch({}, { terms: ['rental'] }).offered, false);
  assert.ok(sameWatch({ terms: ['b', 'a'], league: null, bodies: BODIES }, { terms: ['a', 'b'], league: null, bodies: [...BODIES].reverse() }));
  assert.equal(watchLabel({ terms: [], league: 'Ghent', bodies: BODIES }), 'anything in Ghent, at City Council or Planning Commission');
});

test('without watches, the tools and the prompt are exactly as before; with them, offer_watch and its line', () => {
  const plain = toolsFor(norfolk);
  assert.ok(!plain.some((t) => t.function.name === 'offer_watch'));
  assert.deepEqual(toolsFor(norfolk, [], {}), plain);
  const withWatch = toolsFor(norfolk, [], { watches: { bodies: BODIES } });
  const names = withWatch.map((t) => t.function.name);
  assert.equal(names.indexOf('offer_watch'), names.indexOf('offer_followup') + 1);
  assert.deepEqual(withWatch.find((t) => t.function.name === 'offer_watch').function.parameters.properties.bodies.items.enum, BODIES);
  assert.ok(!systemPrompt(norfolk, '2026-11-16').includes(WATCH_LINE));
  assert.ok(systemPrompt(norfolk, '2026-11-16', { watches: true }).includes(WATCH_LINE));
  // A plugin can't take the name.
  assert.ok(watchableCity(norfolk));
});

// ---- the snapshot, the job, the mail and the feeds, with the City faked ----

const MEETING_HTML = `<span id="ContentPlaceholder1_lblMeetingGroup">Planning Commission</span>
<span id="ContentPlaceholder1_lblMeetingType">Public Hearing</span>
<span id="ContentPlaceholder1_lblMeetingDate">11/19/2026 2:30 PM</span>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6085&CssClass='>JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental (Vacation Rental) at 1210 Sample Avenue (Ward 5/Superward 6)</a>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6084&CssClass='>SEASIDE RENTALS, LLC, for a Conditional Use Permit (Renewal) to operate a Short-Term Rental (Vacation Rental) at 8400 Sample Road</a>
<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6014&CssClass='>HAPPY TAILS, for a Conditional Use Permit to operate a Kennel at 4200 Example Avenue</a>`;

function cityFetch({ extraItem = null } = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    const q = decodeURIComponent(url);
    if (url.includes('/resource/dszu-h9cf.json')) {
      return Response.json([{ date_and_time: '2026-11-19T14:30:00.000', organization: 'Planning Commission', type: 'Public Hearing', location: '11th floor Council Chamber', meeting_link: { url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=4674' } }]);
    }
    if (url.includes('/resource/ere7-kake.json') && /GROUP BY/.test(q)) return Response.json(LEAGUES.map((l) => ({ civic_league: l, n: '10' })));
    if (url.includes('/resource/ere7-kake.json')) {
      // The league column only: the president's name and email are never asked for.
      assert.doesNotMatch(q, /president|email/i);
      return Response.json([
        { full_address: '1210 SAMPLE AVE', civic_league: 'Willoughby' },
        { full_address: '8400 SAMPLE RD', civic_league: 'Ocean View' },
        { full_address: '4200 EXAMPLE AVE', civic_league: 'Ghent' },
      ]);
    }
    if (url.includes('Detail_Meeting.aspx?ID=4674')) {
      const more = extraItem ? `\n<a href='Detail_LegiFile.aspx?Frame=&MeetingID=4674&MediaPosition=&ID=6200&CssClass='>${extraItem}</a>` : '';
      return new Response(MEETING_HTML + more, { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response('not faked', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('the snapshot: posted items with applicants withheld, tagged by civic league, keeping when each was first seen', async () => {
  const kv = readyEnv().LIMITS;
  const { fetchImpl, calls } = cityFetch();
  const now = Date.parse('2026-11-16T12:00:00Z');
  const snap = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl, now });
  assert.equal(snap.meetings.length, 1);
  assert.deepEqual(snap.items.map((i) => [i.id, i.leagues]), [['6085', ['Willoughby']], ['6084', ['Ocean View']], ['6014', ['Ghent']]]);
  assert.ok(snap.items.every((i) => !/JANE DOE|HAPPY TAILS/.test(i.text)));
  assert.match(snap.items[1].text, /^SEASIDE RENTALS, LLC/);
  assert.deepEqual(snap.leagues, LEAGUES);
  assert.ok(calls.some((u) => /organization%20in%20\('City%20Council'%2C%20'Planning%20Commission'\)/.test(u)));
  // A second build a day later keeps first_seen; addresses come from the cache.
  const again = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl, now: now + 864e5 });
  assert.equal(again.items[0].first_seen, snap.items[0].first_seen);
  assert.deepEqual(await readSnapshot(kv, 'norfolk'), again);
});

const USER = 'member@example.org';
async function member(env) {
  const uid = await userId(SECRET, USER);
  await env.LIMITS.put(`member:${uid}`, JSON.stringify({ invite: 'x' }));
  return { uid, cookie: `${userCookieName('')}=${await signUser(SECRET, uid)}` };
}
const watchEnv = (over = {}) => readyEnv({ WATCHES: 'true', RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>', INVITE_REQUIRED: 'true', BLUESKY_LOGIN: undefined, ...over });
const deps = { cityIds: ['norfolk'], cities: { norfolk }, streets: () => streets, vocab: vocabulary };
async function api(env, cookie, path, body, headers = {}) {
  const req = new Request(`https://ask-siren.jason-edelman.org${path}`, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', Origin: 'https://ask-siren.jason-edelman.org' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await handleWatches(req, env, path, deps);
  return { status: res.status, body: await res.json() };
}

test('starting a watch: only with the email this account signed in with, kept encrypted, never shown back', async () => {
  const env = watchEnv();
  const { cookie, uid } = await member(env);
  await buildSnapshot({ kv: env.LIMITS, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch().fetchImpl, now: Date.parse('2026-11-16T12:00:00Z') });
  assert.equal((await api(env, '', '/api/watches')).status, 401);
  const wrong = await api(env, cookie, '/api/watches', { terms: ['short-term rental'], email: 'someone@example.org' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'email');
  const ok = await api(env, cookie, '/api/watches', { terms: ['short-term rental', 'Jane Doe'], email: ' Member@Example.org ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.watch.terms, ['short term rental']);
  assert.equal(ok.body.refused[0].term, 'Jane Doe');
  // What's already on a posted agenda comes back with it.
  assert.deepEqual(ok.body.already.map((i) => i.url.replace(/.*ID=/, '')), ['6085', '6084']);
  const raw = await env.LIMITS.get(`watch:${ok.body.watch.id}`);
  assert.ok(!raw.includes(USER) && !raw.toLowerCase().includes('member@'), 'the address is never stored in the clear');
  const stored = JSON.parse(raw);
  assert.equal(stored.u, uid);
  assert.equal(await openEmail(SECRET, stored.id, stored.email), USER);
  // Bound to the watch: another watch's id can't open it.
  await assert.rejects(openEmail(SECRET, 'another-id-000', stored.email));
  const list = await api(env, cookie, '/api/watches');
  assert.equal(list.body.watches.length, 1);
  assert.ok(!JSON.stringify(list.body).includes(USER));
  assert.deepEqual(list.body.options.norfolk.leagues, LEAGUES);
  // The same watch again, and the cap.
  assert.equal((await api(env, cookie, '/api/watches', { terms: ['Short-Term Rental'], email: USER })).status, 409);
  for (const t of ['kennel', 'tattoo', 'signage', 'parking']) assert.equal((await api(env, cookie, '/api/watches', { terms: [t], email: USER })).status, 200, t);
  const sixth = await api(env, cookie, '/api/watches', { terms: ['garage'], email: USER });
  assert.equal(sixth.status, 409);
  assert.match(sixth.body.error, /5 watches/);
  // Renew and stop; nobody else's.
  const other = await signUser(SECRET, await userId(SECRET, 'other@example.org'));
  assert.equal((await api(env, `${userCookieName('')}=${other}`, '/api/watches/delete', { id: ok.body.watch.id })).status, 404);
  const renewed = await api(env, cookie, '/api/watches/renew', { id: ok.body.watch.id });
  assert.equal(renewed.status, 200);
  assert.equal((await api(env, cookie, '/api/watches/delete', { id: ok.body.watch.id })).status, 200);
  assert.equal(await env.LIMITS.get(`watch:${ok.body.watch.id}`), null);
  // From another site: refused.
  assert.equal((await api(env, cookie, '/api/watches', { terms: ['garage'], email: USER }, { Origin: 'https://evil.example' })).status, 403);
});

test('a stop link works without signing in, and only for its own watch', async () => {
  const env = watchEnv();
  const { cookie } = await member(env);
  const made = await api(env, cookie, '/api/watches', { terms: ['kennel'], email: USER });
  const id = made.body.watch.id;
  const t = await stopToken(SECRET, id);
  assert.equal((await api(env, '', '/api/watches/stop', { t: `${id}.forged` })).status, 400);
  assert.equal((await api(env, '', '/api/watches/stop', { t })).status, 200);
  assert.equal(await env.LIMITS.get(`watch:${id}`), null);
});

test('the daily job: one digest a day per watch, never an item twice, to the address it keeps, with a one-click stop', async () => {
  const env = watchEnv();
  const { cookie } = await member(env);
  await buildSnapshot({ kv: env.LIMITS, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch().fetchImpl, now: Date.parse('2026-11-16T12:00:00Z') });
  const made = await api(env, cookie, '/api/watches', { terms: ['short-term rental'], email: USER });
  await api(env, cookie, '/api/watches', { league: 'Ghent', email: USER });
  const sent = [];
  const send = async (_env, msg) => { sent.push(msg); return { id: 'e' }; };
  let at = Date.parse('2026-11-17T11:30:00Z');
  const run = (extraItem) => runWatchJob(env, { ...deps, appName: 'Siren', fetchImpl: cityFetch({ extraItem }).fetchImpl, send, now: () => at });
  const first = await run();
  assert.equal(first.ran, true);
  assert.equal(sent.length, 2);
  const rentals = sent.find((m) => m.text.includes('short term rental'));
  assert.equal(rentals.to, USER);
  assert.match(rentals.subject, /^Siren: 2 agenda items for your watch$/);
  assert.match(rentals.text, /Planning Commission Public Hearing, Thursday, November 19, 2026, 2:30 PM \(11th floor Council Chamber\)/);
  assert.doesNotMatch(rentals.text + rentals.html, /JANE DOE|HAPPY TAILS/);
  assert.match(rentals.text, /\[applicant's name withheld\], for a Conditional Use Permit to operate a Short-Term Rental/);
  const stop = `https://ask-siren.jason-edelman.org/watch/stop?t=${encodeURIComponent(await stopToken(SECRET, made.body.watch.id))}`;
  assert.equal(rentals.headers['List-Unsubscribe'], `<${stop}>`);
  assert.equal(rentals.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(rentals.text.includes(`Stop this watch: ${stop}`));
  const ghent = sent.find((m) => m.text.includes('anything in Ghent'));
  assert.match(ghent.text, /Kennel at 4200 Example Avenue/);
  // The same day: not due again.
  assert.equal((await run()).ran, false);
  // The next day, nothing new: nothing sent. A new item: only it.
  at += 864e5;
  await run();
  assert.equal(sent.length, 2);
  at += 864e5;
  await run('SEASIDE RENTALS, LLC, for a Conditional Use Permit to operate a Short-Term Rental at 8400 Sample Road');
  assert.equal(sent.length, 3);
  assert.match(sent[2].subject, /1 agenda item for/);
});

test('the daily cap, a watch at its end, and an address that keeps refusing', async () => {
  const env = watchEnv({ WATCH_DAILY_EMAILS: '1' });
  const { cookie } = await member(env);
  await buildSnapshot({ kv: env.LIMITS, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch().fetchImpl, now: Date.parse('2026-11-16T12:00:00Z') });
  await api(env, cookie, '/api/watches', { terms: ['rental'], email: USER });
  await api(env, cookie, '/api/watches', { terms: ['kennel'], email: USER });
  const sent = [];
  const out = await runWatchJob(env, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async (_e, m) => { sent.push(m); }, now: () => Date.parse('2026-11-17T12:00:00Z') });
  assert.equal(sent.length, 1);
  assert.equal(out.capped, 1);
  // A year on, each watch gets one note that it ended, and is deleted.
  const later = Date.parse('2027-11-18T12:00:00Z');
  const env2 = { ...env, WATCH_DAILY_EMAILS: '10' };
  const ended = [];
  const res = await runWatchJob(env2, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async (_e, m) => { ended.push(m); }, now: () => later });
  assert.equal(res.ended, 2);
  assert.ok(ended.every((m) => /has ended/.test(m.subject)));
  assert.equal((await env.LIMITS.list({ prefix: 'watch:' })).keys.length, 0);
  // An address the mail service refuses five days running: the watch stops.
  await api(env, cookie, '/api/watches', { terms: ['rental'], email: USER });
  for (let d = 0; d < 5; d++) {
    await runWatchJob(env2, { ...deps, fetchImpl: cityFetch().fetchImpl, send: async () => { throw new Error('Resend 422'); }, now: () => Date.parse('2026-11-20T12:00:00Z') + d * 864e5 });
    assert.equal((await env.LIMITS.list({ prefix: 'watch:' })).keys.length, d < 4 ? 1 : 0, `day ${d + 1}`);
  }
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

test('feeds: one per civic league and one for everything, escaped, with withheld names', async () => {
  const kv = readyEnv().LIMITS;
  const snapshot = await buildSnapshot({ kv, city: norfolk, cityId: 'norfolk', fetchImpl: cityFetch({ extraItem: 'A <b>"quoted"</b> &amp; item at 4200 Example Avenue' }).fetchImpl, now: Date.parse('2026-11-16T12:00:00Z') });
  const origin = 'https://ask-siren.jason-edelman.org';
  const ghent = atomFeed({ snapshot, slug: leagueSlug('Ghent'), origin, appName: 'Siren' });
  assert.match(ghent, /<title>Ghent: upcoming City Council and Planning Commission agenda items<\/title>/);
  assert.equal((ghent.match(/<entry>/g) || []).length, 2);
  assert.match(ghent, /<link rel="self" href="https:\/\/ask-siren\.jason-edelman\.org\/feeds\/ghent\.atom"\/>/);
  assert.doesNotMatch(ghent, /HAPPY TAILS|<b>/);
  assert.match(ghent, /&quot;quoted&quot;/);
  const all = atomFeed({ snapshot, slug: 'all', origin, appName: 'Siren' });
  assert.equal((all.match(/<entry>/g) || []).length, 4);
  assert.doesNotMatch(all, /JANE DOE/);
  assert.equal(atomFeed({ snapshot, slug: 'atlantis', origin, appName: 'Siren' }), null);
  assert.equal(leagueSlug('Algonquin Park and North Shore Point'), 'algonquin-park-and-north-shore-point');
  assert.equal(meetingTime('2026-12-01T18:00:00.000'), 'Tuesday, December 1, 2026, 6:00 PM');
});

test('sealing: the same address seals differently each time and opens only under its own watch id', async () => {
  const a = await sealEmail(SECRET, 'watch-aaaaaaaa', USER);
  const b = await sealEmail(SECRET, 'watch-aaaaaaaa', USER);
  assert.notEqual(a.ct, b.ct);
  assert.equal(await openEmail(SECRET, 'watch-aaaaaaaa', a), USER);
  await assert.rejects(openEmail('another-secret-that-is-long-enough', 'watch-aaaaaaaa', a));
  const d = digest({ appName: 'Siren', watch: { terms: ['rental'], league: null, bodies: BODIES, ends: '2027-11-16T00:00:00Z' }, items: [{ meeting: '1', body: 'City Council', when: '2026-12-01T18:00:00.000', text: 'An item', url: 'https://example.org/1' }], meetings: [{ id: '1', body: 'City Council', type: 'Formal Session', when: '2026-12-01T18:00:00.000', location: 'Council Chamber', url: 'https://example.org/m' }], city: norfolk, stopUrl: 'https://s/stop', manageUrl: 'https://s/watches' });
  // A Council item says how to speak there, from the city profile's verified contact.
  assert.match(d.text, /To speak at City Council: City Clerk, \(757\) 664-4253, ccouncil@norfolk\.gov \(register by 3 p\.m\. the day of the meeting\)\./);
});
