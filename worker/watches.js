// Watches and civic-league feeds over upcoming agendas (src/watches.js has
// the pure parts; docs/watches.md the whole design).
//
// Jason, 2026-11-16: "I'd like for people to be able to ask something like
// 'let me know if planning commission or City Council take up any items
// affecting short term rentals' and get an email", then "Let's shift from
// per street to per neighborhood league" for the public feeds he'd approved.
//
// Two flags, both off by default; with both off nothing here runs, no route
// answers and no page changes:
// - WATCHES = "true": signed-in members can keep up to five watches (topic
//   terms, a civic league, or both) and get one email a day when a newly
//   posted agenda item matches. Needs email sign-in (RESEND_API_KEY,
//   LOGIN_FROM, INVITE_SECRET), KV and PUBLIC_ORIGIN.
// - LEAGUE_FEEDS = "true": a public Atom feed per civic league, and one for
//   every item, at /feeds.
//
// Once a day (the cron, at or after 11:00 UTC, or at once when no
// snapshot exists), the job reads the Public Meeting Notices for the next
// three weeks of the bodies the city profile names, fetches each meeting's
// agenda from iqm2, describes each item from parts code extracts (its kind,
// its topics from the city's reviewed list, its addresses and its ordinance
// number; never the title, which can name private people), tags each item with
// its civic league from the City's address list (the league column only:
// that dataset's league-president name and email are never read), and keeps
// the result as the snapshot both features read.
//
// The member's email is the one thing kept that sign-in doesn't keep: a
// watch carries it, AES-GCM encrypted under a key derived from INVITE_SECRET
// and bound to the watch's id, only while the watch exists. It is typed by
// the member when they start the watch and checked against their account
// (the same HMAC that names the account), so a watch can only ever mail the
// address that signed in. It is never logged, returned or shown.

import { checkWatch, matchesWatch, phrasesIn, streetsIn, streetLabel, sameWatch, watchLabel, topicsOf, itemKind, itemNumber, describeItem, titlePlaces, itemKey, normalizeText, WATCH_DAYS, SEEN_MAX } from '../src/watches.js';
import { soqlString, ACCESS } from '../src/socrata.js';
import { createContext } from '../src/agent.js';
import { requestBudget } from '../src/request-budget.js';
import { enc, b64url, unb64url, hmac, hex, sha256, randomToken } from './crypto.js';
import { loginConfigured, sendWithResend, userId, currentUser } from './accounts.js';
import { normalizeEmail, basePathOf } from './invites.js';
import { publicOrigin } from './atproto-oauth.js';
import { setting } from './limits.js';

export const MAX_PER_ACCOUNT = 5;
export const DAYS_AHEAD = 21;
export const RUN_HOUR_UTC = 11;
const SNAPSHOT_TTL = 4 * 86400;
const SNAPSHOT_FETCHES = 300;

const flag = (v) => String(v ?? '').trim() === 'true';
export const watchesOn = (env) => flag(env?.WATCHES);
export const feedsOn = (env) => flag(env?.LEAGUE_FEEDS);

/** What's missing for watches, by name only, or null. */
export function watchesSetupError(env) {
  const missing = [];
  if (!env?.LIMITS) missing.push('the LIMITS KV binding');
  if (!loginConfigured(env)) missing.push('email sign-in (RESEND_API_KEY, LOGIN_FROM, INVITE_SECRET)');
  if (!publicOrigin(env)) missing.push('PUBLIC_ORIGIN');
  return missing.length ? `Watches need ${missing.join(', ')}.` : null;
}
export const watchesReady = (env) => watchesOn(env) && !watchesSetupError(env);
export const feedsReady = (env) => feedsOn(env) && Boolean(env?.LIMITS);

/** Whether a city profile carries what watches need: iqm2 meetings, the bodies to watch, and an address list with a league column. */
export const watchableCity = (city) => Boolean(city?.meetings?.kind === 'iqm2' && city.meetings.noticesDataset && city.meetings.watchBodies?.length && city.address?.fields?.league);

// ---- the snapshot ----

const snapshotKey = (cityId) => `agenda-snapshot:${cityId}`;
export const readSnapshot = (kv, cityId) => kv.get(snapshotKey(cityId), 'json');
const iso = (d) => d.toISOString().slice(0, 19);
const meetingId = (url) => /[?&]ID=(\d+)/i.exec(String(url || ''))?.[1] || null;

// An item's places, from its title and the City's address list (`book`,
// src/watches.js compileAddresses): the addresses on the list as the title
// writes them, their streets as the list spells them (for street watches),
// and their civic leagues. Only a listed address, never other words from
// the title. No list, no places.
function placesOf(title, book) {
  const p = titlePlaces(title, book);
  return { addresses: p.addresses.slice(0, 12), streets: p.streets.slice(0, 12), leagues: p.leagues };
}

// A snapshot item's fields, and only those (a carried item from an older snapshot keeps nothing else).
const ITEM_FIELDS = ['key', 'meeting', 'id', 'body', 'when', 'url', 'kind', 'number', 'topics', 'addresses', 'streets', 'leagues', 'title', 'first_seen'];
const knownFields = (x) => Object.fromEntries(ITEM_FIELDS.filter((f) => f in x).map((f) => [f, x[f]]));

/** KV values for many keys, 100 a call (Workers KV's bulk get), as a Map. */
async function bulkGet(kv, keys, type = 'text') {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const got = await kv.get(keys.slice(i, i + 100), type);
    for (const [k, v] of got) out.set(k, v);
  }
  return out;
}

/**
 * Build and store the snapshot for one city: the next DAYS_AHEAD days of
 * the bodies it watches, each posted agenda item described (never its
 * title) with the civic leagues of its listed addresses. `book` is the
 * city's address list (compileAddresses): with none, no item gets an
 * address or a league. Items keep the time they were first seen from the
 * snapshot before; a meeting whose page can't be read today keeps
 * yesterday's items, placed again against today's list. Its title is kept
 * only to match phrases; nothing serves it. Returns the snapshot.
 */
export async function buildSnapshot({ kv, city, cityId, appToken, fetchImpl, now = Date.now(), book = null }) {
  const budget = requestBudget({ limit: SNAPSHOT_FETCHES, fetchImpl });
  const ctx = createContext({ city, appToken, budget });
  const { socrata, iqm2 } = ctx;
  const start = new Date(now);
  const end = new Date(now + DAYS_AHEAD * 864e5);
  const bodies = city.meetings.watchBodies;
  const notices = await socrata.query(
    city.meetings.noticesDataset,
    `SELECT date_and_time, organization, type, location, meeting_link WHERE date_and_time >= ${soqlString(iso(start))} AND date_and_time <= ${soqlString(iso(end))} AND organization in (${bodies.map((b) => soqlString(b)).join(', ')}) ORDER BY date_and_time LIMIT 100`,
    { access: ACCESS.CORE, tool: 'upcoming meetings to watch', name: 'Public Meeting Notices' }
  );
  const before = await readSnapshot(kv, cityId);
  const firstSeen = new Map((before?.items || []).map((i) => [i.key, i.first_seen]));
  const leagues = [...(book?.leagues || [])];
  const topics = city.meetings.watchTopics || [];
  const meetings = [];
  const items = [];
  let failed = 0;
  const carried = [];
  const seenMeetings = new Set();
  for (const n of notices) {
    const id = meetingId(n.meeting_link?.url);
    if (!id || seenMeetings.has(id) || !bodies.includes(n.organization)) continue;
    seenMeetings.add(id);
    let m;
    try {
      m = await iqm2.meeting(id);
    } catch {
      failed++;
      // Yesterday's items for it, so an outage doesn't empty the feeds.
      const old = (before?.meetings || []).find((x) => x.id === id);
      if (old) {
        meetings.push(old);
        carried.push(...(before.items || []).filter((x) => x.meeting === id).map((x) => ({ ...knownFields(x), ...placesOf(x.title, book) })));
      }
      continue;
    }
    meetings.push({ id, body: n.organization, type: String(n.type || m.type || '').slice(0, 80), when: String(n.date_and_time || ''), location: String(n.location || '').slice(0, 120), url: m.url, items: m.items.length });
    for (const it of m.items) {
      const key = itemKey(id, it.id);
      items.push({
        key, meeting: id, id: it.id, body: n.organization, when: String(n.date_and_time || ''), url: it.url,
        kind: itemKind(it.text), number: itemNumber(it.text), topics: topicsOf(it.text, topics),
        ...placesOf(it.text, book),
        // Kept to match members' phrases against (phrasesIn); never served, mailed or put in a feed.
        title: String(it.text || '').slice(0, 1000),
        first_seen: firstSeen.get(key) || new Date(now).toISOString(),
      });
    }
  }
  items.push(...carried);
  const snapshot = { city: cityId, built: new Date(now).toISOString(), through: iso(end), bodies, meetings, items, leagues, failed, requests: budget.used };
  await kv.put(snapshotKey(cityId), JSON.stringify(snapshot), { expirationTtl: SNAPSHOT_TTL });
  return snapshot;
}

// ---- watches: storage ----

const watchKey = (id) => `watch:${id}`;
// What a watch has been sent ({ seen, sent, last_sent }), in its own key: the
// job writes only this, never the watch itself, so a stop or a renewal made
// elsewhere (KV reads are cached at each location for about a minute) can't
// be undone by the job writing back an older copy.
const sentKey = (id) => `watch-sent:${id}`;
// Every watch key expires a week after the watch's end, so a watch and the
// email it keeps go even if the daily job never runs again.
const expiresAt = (ends) => Math.floor(Date.parse(ends) / 1000) + 7 * 86400;
async function removeWatch(kv, id) {
  await kv.delete(watchKey(id));
  await kv.delete(sentKey(id)).catch(() => {});
}

async function emailKey(secret) {
  const raw = await hmac(secret, 'watch-email-key:v1');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function sealEmail(secret, id, email) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`watch:${id}`) }, await emailKey(secret), enc.encode(email)));
  return { iv: b64url(iv), ct: b64url(ct) };
}
export async function openEmail(secret, id, sealed) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(sealed.iv), additionalData: enc.encode(`watch:${id}`) }, await emailKey(secret), unb64url(sealed.ct));
  return new TextDecoder().decode(pt);
}

/** Every watch's key and metadata ({ u, c, e }), by listing. */
async function listAll(kv) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'watch:', cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

/** What the member sees of a watch: never the email. */
const shown = (w, topics = [], sent = null) => ({ id: w.id, city: w.city, topics: w.topics, phrases: w.phrases || [], streets: w.streets || [], league: w.league, bodies: w.bodies, label: watchLabel(w, topics), created: w.created, ends: w.ends, last_sent: sent?.last_sent || null, sent: sent?.sent || 0 });
const topicsFor = (city) => city?.meetings?.watchTopics || [];

export async function accountWatches(kv, uid) {
  const mine = (await listAll(kv)).filter((k) => k.metadata?.u === uid);
  const got = await bulkGet(kv, mine.map((k) => k.name), 'json');
  const sent = await bulkGet(kv, mine.map((k) => sentKey(k.name.slice('watch:'.length))), 'json');
  const out = [];
  for (const k of mine) {
    const w = got.get(k.name);
    if (w && w.u === uid) out.push({ ...w, _sent: sent.get(sentKey(w.id)) || null });
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

async function putWatch(kv, w) {
  const { _sent, ...stored } = w;
  await kv.put(watchKey(w.id), JSON.stringify(stored), { metadata: { u: w.u, c: w.city, e: w.ends }, expiration: expiresAt(w.ends) });
}

/** A stop link's token: the watch's id and an HMAC of it, so the link works without signing in. */
export async function stopToken(secret, id) {
  return `${id}.${b64url(await hmac(secret, `watch-stop:${id}`)).slice(0, 32)}`;
}
async function tokenId(secret, t) {
  const [id, mac] = String(t || '').split('.');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id || '') || !mac) return null;
  const want = (await stopToken(secret, id)).slice(id.length + 1);
  if (want.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0 ? id : null;
}

// ---- watches: the member's routes ----

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

/**
 * The member's API: GET /api/watches; POST /api/watches (start one),
 * /api/watches/delete, /api/watches/renew, and /api/watches/stop (by a stop
 * link's token, signed in or not). `deps`: { cityIds, cities, canAsk(uid),
 * names() (common names, for phrases), ordinary() (the books' lower-case
 * words), textCheck(cityId) (the public-text check: true when a phrase is
 * clean), book(cityId) (the address list, compileAddresses: its civic
 * leagues, and street phrases), now }.
 */
export async function handleWatches(req, env, path, deps = {}) {
  const setup = watchesSetupError(env);
  if (setup) return json({ error: 'Watches are not set up on this site yet.' }, 503);
  const kv = env.LIMITS;
  const now = deps.now ? deps.now() : Date.now();
  if (req.method === 'POST') {
    const o = req.headers.get('Origin');
    if (o !== null && o !== new URL(req.url).origin && o !== publicOrigin(env)?.origin) return json({ error: "Act from this site's own page.", code: 'not_here' }, 403);
  }
  let body = {};
  if (req.method === 'POST') {
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Send JSON.' }, 400);
    }
  }
  if (req.method === 'POST' && path === '/api/watches/stop') {
    const id = await tokenId(env.INVITE_SECRET, body?.t);
    if (!id) return json({ error: "That stop link isn't valid." }, 400);
    await removeWatch(kv, id);
    return json({ ok: true, stopped: true });
  }
  const uid = await currentUser(req, env);
  if (!uid) return json({ error: 'Sign in to keep watches.', code: 'signin' }, 401);
  const cityIds = (deps.cityIds || []).filter((c) => watchableCity(deps.cities?.[c]));
  if (req.method === 'GET' && path === '/api/watches') {
    const watches = (await accountWatches(kv, uid)).map((w) => shown(w, topicsFor(deps.cities?.[w.city]), w._sent));
    const options = {};
    for (const c of cityIds) {
      const snap = await readSnapshot(kv, c);
      options[c] = { bodies: deps.cities[c].meetings.watchBodies, topics: topicsFor(deps.cities[c]).map((t) => ({ id: t.id, label: t.label })), leagues: [...(deps.book?.(c)?.leagues || [])], checked: snap?.built || null };
    }
    return json({ watches, max: MAX_PER_ACCOUNT, options });
  }
  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (path === '/api/watches/delete' || path === '/api/watches/renew') {
    const id = String(body?.id || '');
    const w = /^[A-Za-z0-9_-]{8,40}$/.test(id) ? await kv.get(watchKey(id), 'json') : null;
    if (!w || w.u !== uid) return json({ error: 'No such watch.' }, 404);
    if (path === '/api/watches/delete') {
      await removeWatch(kv, id);
      return json({ ok: true });
    }
    w.ends = new Date(now + WATCH_DAYS * 864e5).toISOString();
    await putWatch(kv, w);
    return json({ ok: true, watch: shown(w, topicsFor(deps.cities?.[w.city])) });
  }
  if (path !== '/api/watches') return json({ error: 'Not found' }, 404);
  if (deps.canAsk && !(await deps.canAsk(uid))) return json({ error: 'Watches come with an invite. Enter yours on the main page first.' }, 403);
  const cityId = cityIds.includes(body?.city) ? body.city : cityIds[0];
  if (!cityId) return json({ error: 'No city here has agendas to watch.' }, 400);
  // The address the watch will mail: the one this account signed in with, typed again.
  const email = normalizeEmail(body?.email);
  if (!email || (await userId(env.INVITE_SECRET, email)) !== uid) return json({ error: "Enter the email you signed in with. Watches mail only that address.", code: 'email' }, 400);
  const snap = await readSnapshot(kv, cityId);
  const topics = topicsFor(deps.cities[cityId]);
  const book = deps.book?.(cityId) || null;
  const checked = checkWatch(body, { topics, leagues: [...(book?.leagues || [])], bodies: deps.cities[cityId].meetings.watchBodies, names: deps.names?.() || null, ordinary: deps.ordinary?.() || null, textCheck: deps.textCheck?.(cityId) || null, book });
  if (!checked.ok) return json({ error: checked.error, refused: checked.refused, refused_phrases: checked.refusedPhrases || [] }, 400);
  const all = await listAll(kv);
  const mineKeys = all.filter((k) => k.metadata?.u === uid);
  if (mineKeys.length >= MAX_PER_ACCOUNT) return json({ error: `You have ${MAX_PER_ACCOUNT} watches, the most an account can keep. Stop one to start another.` }, 409);
  const max = setting(env.WATCH_MAX, 200, { min: 0 });
  if (all.length >= max) return json({ error: 'This site has as many watches as it can send right now. Try again later.' }, 503);
  for (const k of mineKeys) {
    const w = await kv.get(k.name, 'json');
    if (w && w.city === cityId && sameWatch(w, checked.watch)) return json({ error: 'You already have this watch.', watch: shown(w, topics) }, 409);
  }
  const id = randomToken(12);
  const w = {
    v: 1, id, u: uid, city: cityId, ...checked.watch,
    created: new Date(now).toISOString(), ends: new Date(now + WATCH_DAYS * 864e5).toISOString(),
    email: await sealEmail(env.INVITE_SECRET, id, email),
  };
  await putWatch(kv, w);
  // What's already on a posted agenda: shown now, and sent in the first email.
  const already = (snap?.items || []).filter((i) => matchesWatch(w, i)).slice(0, 10).map((i) => ({ body: i.body, when: i.when, description: describeItem(i, topics), number: i.number || null, url: i.url }));
  return json({ ok: true, watch: shown(w, topics), already, refused: checked.refused, refused_phrases: checked.refusedPhrases || [] });
}

/** The one-click stop from a mail client (RFC 8058): POST to the link, form-encoded. */
export async function handleOneClickStop(req, env) {
  if (!watchesReady(env)) return new Response('Not found', { status: 404 });
  const id = await tokenId(env.INVITE_SECRET, new URL(req.url).searchParams.get('t'));
  if (!id) return new Response("That stop link isn't valid.", { status: 400, headers: { 'Cache-Control': 'no-store' } });
  await removeWatch(env.LIMITS, id);
  return new Response('Stopped.', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---- the daily job ----

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-11-19T14:30:00.000" (the City's local time, as the notice gives it) as "Thursday, November 19, 2026, 2:30 PM". */
export function meetingTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return String(s || '');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const h = +m[4];
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}, ${h % 12 || 12}:${m[5]} ${h < 12 ? 'AM' : 'PM'}`;
}
const day = (isoString) => String(isoString || '').slice(0, 10);

/** The digest for one watch: subject, text and HTML. */
export function digest({ appName, watch, items, meetings, city, stopUrl, manageUrl }) {
  const byMeeting = new Map();
  for (const i of items) {
    if (!byMeeting.has(i.meeting)) byMeeting.set(i.meeting, []);
    byMeeting.get(i.meeting).push(i);
  }
  const meetingOf = new Map(meetings.map((m) => [m.id, m]));
  const council = items.some((i) => /council/i.test(i.body));
  const clerk = council ? (city.contacts || []).find((c) => /clerk/i.test(c.role)) : null;
  const n = items.length;
  const subject = `${appName}: ${n} agenda item${n === 1 ? '' : 's'} for your watch`;
  const topics = topicsFor(city);
  const text = [];
  const html = [];
  text.push(`You asked ${appName} to watch ${watchLabel(watch, topics)}.`, '');
  html.push(`<p>You asked ${esc(appName)} to watch ${esc(watchLabel(watch, topics))}.</p>`);
  for (const [mid, list] of byMeeting) {
    const m = meetingOf.get(mid) || {};
    const head = `${m.body || list[0].body} ${m.type || ''}, ${meetingTime(m.when || list[0].when)}${m.location ? ` (${m.location})` : ''}`.replace(/\s+,/, ',');
    text.push(head);
    html.push(`<h3>${esc(head)}</h3><ul>`);
    for (const i of list) {
      const hits = phrasesIn(watch, i);
      const on = streetsIn(watch, i);
      const why = [hits.length ? `with ${hits.map((h) => `"${h}"`).join(', ')} in its title` : '', on.length ? `on ${on.map(streetLabel).join(', ')}` : ''].filter(Boolean).join(', ');
      const line = `${describeItem(i, topics)}${i.number ? ` (${i.number})` : ''}${why ? `, ${why}` : ''}`;
      text.push(`- ${line}`, `  ${i.url}`);
      html.push(`<li><a href="${esc(i.url)}">${esc(line)}</a></li>`);
    }
    if (m.url) {
      text.push(`  The meeting and its agenda: ${m.url}`);
      html.push(`</ul><p><a href="${esc(m.url)}">The meeting and its agenda</a></p>`);
    } else html.push('</ul>');
    text.push('');
  }
  const note = `Each item is described from its agenda title, without repeating it: titles can name private people. The City's page for each item has the full text. ${appName} matches topics in the titles as the City posted them, and an item can affect a topic without naming it, so a watch can miss one.`;
  text.push(note);
  html.push(`<p>${esc(note)}</p>`);
  if (clerk) {
    const how = `To speak at City Council: ${clerk.role.replace(/\s*\(.*\)$/, '')}, ${[clerk.phone, clerk.email].filter(Boolean).join(', ')}${clerk.note ? ` (${clerk.note})` : ''}.`;
    text.push(how);
    html.push(`<p>${esc(how)}</p>`);
  }
  text.push('', `This watch runs until ${day(watch.ends)}. Your watches: ${manageUrl}`, `Stop this watch: ${stopUrl}`);
  html.push(`<p>This watch runs until ${esc(day(watch.ends))}. <a href="${esc(manageUrl)}">Your watches</a> · <a href="${esc(stopUrl)}">Stop this watch</a></p>`);
  return { subject, text: text.join('\n'), html: html.join('\n') };
}

/** The note when a watch reaches its end. */
function endedNote({ appName, watch, manageUrl, topics = [] }) {
  const line = `Your ${appName} watch for ${watchLabel(watch, topics)} has ended, a year after it started. To keep watching, start it again: ${manageUrl}`;
  return { subject: `${appName}: your watch has ended`, text: line, html: `<p>${esc(line)}</p>` };
}

/** Whether the job should run on this tick: not yet today, and past the hour (or with no snapshot yet). */
export async function jobDue(kv, cityIds, now = Date.now()) {
  if (await kv.get(`watch-run:${day(new Date(now).toISOString())}`)) return false;
  if (new Date(now).getUTCHours() >= RUN_HOUR_UTC) return true;
  for (const c of cityIds) if (!(await readSnapshot(kv, c))) return true;
  return false;
}

/**
 * The daily job: build each city's snapshot, then (with watches on) mail
 * each watch the items it hasn't been sent. `deps`: { cityIds, cities,
 * appName, fetchImpl, send, now, book(cityId) }. One run a day (`watch-run:<day>`), one at
 * a time: a fifteen-minute lock (a cron run's longest), re-read after
 * writing and judged by its own expiry, written once and never deleted (KV
 * refuses a second write to a key within a second).
 */
export async function runWatchJob(env, deps = {}) {
  const kv = env.LIMITS;
  const now = deps.now ? deps.now() : Date.now();
  const cityIds = (deps.cityIds || []).filter((c) => watchableCity(deps.cities?.[c]));
  if (!cityIds.length || !(await jobDue(kv, cityIds, now))) return { ran: false };
  const held = String((await kv.get('watch-lock')) || '');
  if (Number(held.split(':')[1]) > now) return { ran: false, locked: true };
  const token = `${randomToken(9)}:${now + 900000}`;
  await kv.put('watch-lock', token, { expirationTtl: 900 });
  if ((await kv.get('watch-lock')) !== token) return { ran: false, locked: true };
  const result = { ran: true, cities: {}, sent: 0, ended: 0, failed: 0 };
  const snapshots = {};
  for (const c of cityIds) {
    snapshots[c] = await buildSnapshot({ kv, city: deps.cities[c], cityId: c, appToken: env.SOCRATA_APP_TOKEN, fetchImpl: deps.fetchImpl, now, book: deps.book?.(c) || null });
    result.cities[c] = { meetings: snapshots[c].meetings.length, items: snapshots[c].items.length, failed: snapshots[c].failed };
  }
  if (watchesReady(env)) Object.assign(result, await mailWatches(env, { ...deps, now, snapshots }));
  await kv.put(`watch-run:${day(new Date(now).toISOString())}`, new Date(now).toISOString(), { expirationTtl: 3 * 86400 });
  return result;
}

const resendStatus = (err) => Number(/Resend (\d{3})/.exec(String(err?.message || ''))?.[1]) || 0;

/**
 * Mail each watch once. The job never writes a watch: what it has sent goes
 * in the watch's own sent key (`watch-sent:<id>`), so a stop or a renewal
 * made elsewhere can't be undone by an older copy (KV reads are cached at
 * each location for about a minute; a stop clicked seconds before the run
 * may still see one more email, never a revived watch). Each key is written
 * at most once a run; the day's count at most every two seconds, and once
 * at the end.
 * 1. Watches at their end, first: a note if the day's cap allows, and the
 *    watch (with the email it keeps) is deleted either way.
 * 2. The rest, in a new order each day: a failure that may pass (Resend busy
 *    or down: 429, 5xx, no answer) stops the round, and the rest wait for
 *    tomorrow, unsent and unmarked. A 4xx marks nothing (a revoked key or an
 *    unverified domain looks the same); three before any mail goes through
 *    stop the round, since that's the setup, not an address.
 */
async function mailWatches(env, { snapshots, cities, appName = 'Siren', fetchImpl, send = sendWithResend, now }) {
  const kv = env.LIMITS;
  const origin = `${publicOrigin(env).origin}${basePathOf(env)}`;
  const manageUrl = `${origin}/watches`;
  const today = day(new Date(now).toISOString());
  const counterKey = `watch-mail:${today}`;
  const cap = setting(env.WATCH_DAILY_EMAILS, 100, { min: 0 });
  let written = Number(await kv.get(counterKey)) || 0;
  let mailed = written;
  // Mid-run writes start two seconds in, so a short run writes the count once;
  // the last write waits out the second KV wants between writes to a key.
  let lastWrite = Date.now();
  let wroteMidRun = false;
  const saveCount = async (final = false) => {
    if (mailed === written) return;
    const since = Date.now() - lastWrite;
    if (!final && since < 2000) return;
    if (final && wroteMidRun && since < 1100) await new Promise((r) => setTimeout(r, 1100 - since));
    try {
      await kv.put(counterKey, String(mailed), { expirationTtl: 2 * 86400 });
      written = mailed;
      lastWrite = Date.now();
      if (!final) wroteMidRun = true;
    } catch {
      console.error("watch: the day's mail count could not be written");
    }
  };
  const out = { sent: 0, ended: 0, failed: 0, capped: 0, stopped: false };
  const keys = (await listAll(kv)).map((k) => k.name);
  const watches = await bulkGet(kv, keys, 'json');
  const sentState = await bulkGet(kv, keys.map((k) => sentKey(k.slice('watch:'.length))), 'json');
  const opened = async (w) => {
    try {
      return await openEmail(env.INVITE_SECRET, w.id, w.email);
    } catch {
      console.error('watch: an email could not be opened');
      return null;
    }
  };
  // A sent key outlives what it guards: the watch's end plus a week, or a month
  // from now, whichever is later (items stay on the 21-day snapshot; a renewal
  // moves the end, and the job is the sent key's only writer).
  const sentExpiry = (w) => Math.max(expiresAt(w.ends), Math.floor(now / 1000) + 30 * 86400);
  const ended = new Set();
  try {
    // 1. At their end.
    for (const key of keys) {
      const first = watches.get(key);
      if (!first || !(Date.parse(first.ends) <= now)) continue;
      ended.add(key);
      try {
        const w = await kv.get(key, 'json');
        if (!w || !(Date.parse(w.ends) <= now)) continue;
        const to = w.email && mailed < cap ? await opened(w) : null;
        if (to) {
          try {
            await send(env, { to, ...endedNote({ appName, watch: w, manageUrl, topics: topicsFor(cities[w.city]) }), idempotencyKey: `watch-end-${w.id}` }, fetchImpl);
            mailed++;
          } catch { /* the watch ends either way */ }
        }
        await removeWatch(kv, w.id);
        out.ended++;
      } catch (err) {
        console.error('watch: an ended watch could not be removed', String(err?.message || '').slice(0, 60));
      }
    }
    // 2. The rest, shuffled, so no fixed set of watches always comes first.
    const order = keys.filter((k) => !ended.has(k));
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    let refusals = 0;
    let delivered = false;
    for (const key of order) {
      if (out.stopped) break;
      const w0 = watches.get(key);
      const snap = w0 ? snapshots[w0.city] : null;
      if (!snap) continue;
      const state = sentState.get(sentKey(w0.id)) || {};
      const seen = new Set(state.seen || []);
      if (!snap.items.some((i) => !seen.has(i.key) && matchesWatch(w0, i))) continue;
      if (mailed >= cap) {
        out.capped++;
        continue;
      }
      try {
        // A watch stopped or changed since the run began (as this location sees it) wins.
        const w = await kv.get(key, 'json');
        if (!w?.email) continue;
        const fresh = snap.items.filter((i) => !seen.has(i.key) && matchesWatch(w, i));
        if (!fresh.length) continue;
        const to = await opened(w);
        if (!to) continue;
        const stopUrl = `${origin}/watch/stop?t=${encodeURIComponent(await stopToken(env.INVITE_SECRET, w.id))}`;
        const mail = digest({ appName, watch: w, items: fresh, meetings: snap.meetings, city: cities[w.city], stopUrl, manageUrl });
        const headers = { 'List-Unsubscribe': `<${stopUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
        // The same items to the same watch are one mail to Resend for a day, whatever the run.
        const idempotencyKey = `watch-${w.id}-${hex(await sha256(fresh.map((i) => i.key).sort().join(','))).slice(0, 24)}`;
        try {
          await send(env, { to, ...mail, headers, idempotencyKey }, fetchImpl);
        } catch (err) {
          const status = resendStatus(err);
          if (status === 409) {
            // Resend already has this key (a rerun after a crash): the mail went; record it, don't count it again.
            await kv.put(sentKey(w.id), JSON.stringify({ ...state, seen: [...new Set([...(state.seen || []), ...fresh.map((i) => i.key)])].slice(-SEEN_MAX) }), { expiration: sentExpiry(w) });
            continue;
          }
          out.failed++;
          console.error('watch: a digest was not sent', status || String(err?.message || '').slice(0, 40));
          if (status >= 400 && status < 500 && status !== 429) {
            refusals++;
            if (!delivered && refusals >= 3) out.stopped = true;
          } else out.stopped = true;
          continue;
        }
        delivered = true;
        mailed++;
        out.sent++;
        await kv.put(sentKey(w.id), JSON.stringify({
          seen: [...new Set([...(state.seen || []), ...fresh.map((i) => i.key)])].slice(-SEEN_MAX),
          sent: (state.sent || 0) + 1,
          last_sent: new Date(now).toISOString(),
        }), { expiration: sentExpiry(w) });
        await saveCount();
      } catch (err) {
        console.error('watch: one watch could not be handled', String(err?.message || '').slice(0, 60));
      }
    }
  } finally {
    await saveCount(true);
  }
  return out;
}

// ---- civic-league feeds ----

export const leagueSlug = (league) => normalizeText(league).replace(/ /g, '-');
const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');

/**
 * One Atom feed: every upcoming item in the snapshot (slug "all") or those
 * tagged with one civic league. Returns null for an unknown league.
 */
export function atomFeed({ snapshot, slug, origin, appName, topics = [] }) {
  const league = slug === 'all' ? null : (snapshot.leagues || []).find((l) => leagueSlug(l) === slug);
  if (slug !== 'all' && !league) return null;
  const items = snapshot.items.filter((i) => !league || (i.leagues || []).includes(league));
  const meetings = new Map(snapshot.meetings.map((m) => [m.id, m]));
  const host = new URL(origin).hostname;
  const self = `${origin}/feeds/${slug}.atom`;
  const title = `${league || 'Norfolk'}: upcoming ${snapshot.bodies.join(' and ')} agenda items`;
  const entries = items.map((i) => {
    const m = meetings.get(i.meeting) || {};
    const when = `${i.body} ${m.type || ''}, ${meetingTime(i.when)}${m.location ? ` (${m.location})` : ''}`.replace(/\s+,/, ',');
    return `  <entry>
    <id>tag:${xml(host)},2026-11-16:agenda/${xml(i.meeting)}/${xml(i.id)}</id>
    <title>${xml(`${describeItem(i, topics)}${i.number ? ` (${i.number})` : ''}`)}</title>
    <link rel="alternate" href="${xml(i.url)}"/>
    <updated>${xml(i.first_seen)}</updated>
    <summary>${xml(`${when}. ${describeItem(i, topics)}${i.number ? `, ${i.number}` : ''}. The City's page has the full agenda item.`)}</summary>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:${xml(host)},2026-11-16:feeds/${xml(slug)}</id>
  <title>${xml(title)}</title>
  <subtitle>${xml(`From the City's posted agendas, checked daily by ${appName}. Each item is described from its title without repeating it (titles can name private people); its link is the City's page. Items are tagged by the civic league of the address their title names, when that address is on the City's address list.`)}</subtitle>
  <link rel="self" href="${xml(self)}"/>
  <link rel="alternate" href="${xml(`${origin}/feeds`)}"/>
  <updated>${xml(snapshot.built)}</updated>
  <author><name>${xml(appName)}</name></author>
${entries.join('\n')}
</feed>
`;
}
