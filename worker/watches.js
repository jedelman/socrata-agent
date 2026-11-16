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
// Once a day (the cron, an hour or more after 11:00 UTC, or at once when no
// snapshot exists), the job reads the Public Meeting Notices for the next
// three weeks of the bodies the city profile names, fetches each meeting's
// agenda from iqm2, withholds private applicants' names, tags each item with
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

import { checkWatch, matchesWatch, sameWatch, watchLabel, withholdApplicant, itemKey, normalizeText, WATCH_DAYS, SEEN_MAX } from '../src/watches.js';
import { extractAddresses, normalizeAddress } from '../src/adapters/iqm2.js';
import { addressKey } from '../src/block.js';
import { soqlString, ACCESS } from '../src/socrata.js';
import { createContext } from '../src/agent.js';
import { requestBudget } from '../src/request-budget.js';
import { enc, b64url, unb64url, hmac, hex, sha256, randomToken } from './crypto.js';
import { loginConfigured, sendWithResend, userId, currentUser } from './accounts.js';
import { normalizeEmail, basePathOf } from './invites.js';
import { publicOrigin } from './atproto-oauth.js';

export const MAX_PER_ACCOUNT = 5;
export const DAYS_AHEAD = 21;
export const RUN_HOUR_UTC = 11;
const SNAPSHOT_TTL = 4 * 86400;
const LEAGUE_TTL = 7 * 86400;
const ADDRESS_TTL = 90 * 86400;
const ITEM_CHARS = 600;
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

/** The civic leagues the address list names, cached a week. */
async function civicLeagues(kv, socrata, city, cityId) {
  const key = `civic-leagues:${cityId}`;
  const cached = await kv.get(key, 'json');
  if (Array.isArray(cached) && cached.length) return cached;
  const f = city.address.fields.league;
  const rows = await socrata.query(city.address.dataset, `SELECT ${f}, count(*) AS n WHERE ${f} IS NOT NULL GROUP BY ${f} ORDER BY ${f} LIMIT 1000`, { access: ACCESS.CORE, tool: 'civic leagues', name: city.address.name });
  const names = [...new Set(rows.map((r) => String(r[f] ?? '').trim()).filter(Boolean))].sort();
  if (names.length) await kv.put(key, JSON.stringify(names), { expirationTtl: LEAGUE_TTL });
  return names;
}

/**
 * The civic league of each address, from the address list's league column
 * (never its president's name or email), cached 90 days per address. An
 * address that doesn't match exactly one row gets no league.
 */
async function leaguesOf(kv, socrata, city, cityId, addresses) {
  const cfg = city.address;
  const f = cfg.fields;
  const out = new Map();
  const todo = [];
  for (const a of addresses) {
    const k = addressKey(a);
    if (!k.num || !k.street) continue;
    const cacheKey = `addr-league:${cityId}:${hex(await sha256(`${k.num} ${k.street}`)).slice(0, 32)}`;
    const hit = await kv.get(cacheKey);
    if (hit !== null) out.set(a, hit);
    else todo.push({ a, k, cacheKey });
  }
  for (let i = 0; i < todo.length; i += 8) {
    const group = todo.slice(i, i + 8);
    const where = group.map(({ k }) => {
      const longest = k.street.split(' ').sort((x, y) => y.length - x.length)[0];
      return `(${f.number} = ${soqlString(k.num)} AND upper(${f.street}) like ${soqlString(`%${longest}%`)})`;
    }).join(' OR ');
    let rows;
    try {
      rows = await socrata.query(cfg.dataset, `SELECT ${f.full}, ${f.league} WHERE ${where} LIMIT 500`, { access: ACCESS.CORE, tool: 'civic league of agenda addresses', name: cfg.name });
    } catch {
      continue;
    }
    for (const { a, k, cacheKey } of group) {
      const leagues = new Set(rows.filter((r) => {
        const rk = addressKey(r[f.full]);
        return rk.num === k.num && rk.street === k.street;
      }).map((r) => String(r[f.league] ?? '').trim()).filter(Boolean));
      const league = leagues.size === 1 ? [...leagues][0] : '';
      out.set(a, league);
      await kv.put(cacheKey, league, { expirationTtl: ADDRESS_TTL });
    }
  }
  return out;
}

/**
 * Build and store the snapshot for one city: the next DAYS_AHEAD days of
 * the bodies it watches, each posted agenda item with its applicant
 * withheld and its civic leagues. Items keep the time they were first seen
 * from the snapshot before. Returns the snapshot.
 */
export async function buildSnapshot({ kv, city, cityId, appToken, fetchImpl, now = Date.now() }) {
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
  const meetings = [];
  const items = [];
  let failed = 0;
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
      continue;
    }
    meetings.push({ id, body: n.organization, type: String(n.type || m.type || '').slice(0, 80), when: String(n.date_and_time || ''), location: String(n.location || '').slice(0, 120), url: m.url, items: m.items.length });
    for (const it of m.items) {
      const key = itemKey(id, it.id);
      items.push({
        key, meeting: id, id: it.id, body: n.organization, when: String(n.date_and_time || ''),
        text: withholdApplicant(it.text).slice(0, ITEM_CHARS), url: it.url,
        addresses: extractAddresses(it.text).slice(0, 12),
        first_seen: firstSeen.get(key) || new Date(now).toISOString(),
      });
    }
  }
  const leagueMap = await leaguesOf(kv, socrata, city, cityId, [...new Set(items.flatMap((i) => i.addresses))]);
  for (const i of items) {
    i.leagues = [...new Set(i.addresses.map((a) => leagueMap.get(a)).filter(Boolean))];
    delete i.addresses;
  }
  let leagues = before?.leagues || [];
  try {
    leagues = await civicLeagues(kv, socrata, city, cityId);
  } catch { /* keep the last list */ }
  const snapshot = { city: cityId, built: new Date(now).toISOString(), through: iso(end), bodies, meetings, items, leagues, failed, requests: budget.used };
  await kv.put(snapshotKey(cityId), JSON.stringify(snapshot), { expirationTtl: SNAPSHOT_TTL });
  return snapshot;
}

// ---- watches: storage ----

const watchKey = (id) => `watch:${id}`;

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
const shown = (w) => ({ id: w.id, city: w.city, terms: w.terms, league: w.league, bodies: w.bodies, label: watchLabel(w), created: w.created, ends: w.ends, last_sent: w.last_sent || null, sent: w.sent || 0 });

export async function accountWatches(kv, uid) {
  const mine = (await listAll(kv)).filter((k) => k.metadata?.u === uid);
  const out = [];
  for (const k of mine) {
    const w = await kv.get(k.name, 'json');
    if (w && w.u === uid) out.push(w);
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

async function putWatch(kv, w) {
  await kv.put(watchKey(w.id), JSON.stringify(w), { metadata: { u: w.u, c: w.city, e: w.ends } });
}

/** A stop link's token: the watch's id and an HMAC of it, so the link works without signing in. */
export async function stopToken(secret, id) {
  return `${id}.${b64url(await hmac(secret, `watch-stop:${id}`)).slice(0, 32)}`;
}
async function tokenId(secret, t) {
  const [id, mac] = String(t || '').split('.');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id || '') || !mac) return null;
  return (await stopToken(secret, id)) === `${id}.${mac}` ? id : null;
}

// ---- watches: the member's routes ----

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

/**
 * The member's API: GET /api/watches; POST /api/watches (start one),
 * /api/watches/delete, /api/watches/renew, and /api/watches/stop (by a stop
 * link's token, signed in or not). `deps`: { cityIds, cities, streets(cityId),
 * vocab(), canAsk(uid), now }.
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
    await kv.delete(watchKey(id));
    return json({ ok: true, stopped: true });
  }
  const uid = await currentUser(req, env);
  if (!uid) return json({ error: 'Sign in to keep watches.', code: 'signin' }, 401);
  const cityIds = (deps.cityIds || []).filter((c) => watchableCity(deps.cities?.[c]));
  if (req.method === 'GET' && path === '/api/watches') {
    const watches = (await accountWatches(kv, uid)).map(shown);
    const options = {};
    for (const c of cityIds) {
      const snap = await readSnapshot(kv, c);
      options[c] = { bodies: deps.cities[c].meetings.watchBodies, leagues: snap?.leagues || [], checked: snap?.built || null };
    }
    return json({ watches, max: MAX_PER_ACCOUNT, options });
  }
  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (path === '/api/watches/delete' || path === '/api/watches/renew') {
    const id = String(body?.id || '');
    const w = /^[A-Za-z0-9_-]{8,40}$/.test(id) ? await kv.get(watchKey(id), 'json') : null;
    if (!w || w.u !== uid) return json({ error: 'No such watch.' }, 404);
    if (path === '/api/watches/delete') {
      await kv.delete(watchKey(id));
      return json({ ok: true });
    }
    w.ends = new Date(now + WATCH_DAYS * 864e5).toISOString();
    await putWatch(kv, w);
    return json({ ok: true, watch: shown(w) });
  }
  if (path !== '/api/watches') return json({ error: 'Not found' }, 404);
  if (deps.canAsk && !(await deps.canAsk(uid))) return json({ error: 'Watches come with an invite. Enter yours on the main page first.' }, 403);
  const cityId = cityIds.includes(body?.city) ? body.city : cityIds[0];
  if (!cityId) return json({ error: 'No city here has agendas to watch.' }, 400);
  // The address the watch will mail: the one this account signed in with, typed again.
  const email = normalizeEmail(body?.email);
  if (!email || (await userId(env.INVITE_SECRET, email)) !== uid) return json({ error: "Enter the email you signed in with. Watches mail only that address.", code: 'email' }, 400);
  const snap = await readSnapshot(kv, cityId);
  const checked = checkWatch(body, { vocab: deps.vocab?.(), streets: deps.streets?.(cityId), leagues: snap?.leagues || [], bodies: deps.cities[cityId].meetings.watchBodies });
  if (!checked.ok) return json({ error: checked.error, refused: checked.refused }, 400);
  const all = await listAll(kv);
  const mineKeys = all.filter((k) => k.metadata?.u === uid);
  if (mineKeys.length >= MAX_PER_ACCOUNT) return json({ error: `You have ${MAX_PER_ACCOUNT} watches, the most an account can keep. Stop one to start another.` }, 409);
  const max = Math.max(1, Number(env.WATCH_MAX) || 200);
  if (all.length >= max) return json({ error: 'This site has as many watches as it can send right now. Try again later.' }, 503);
  for (const k of mineKeys) {
    const w = await kv.get(k.name, 'json');
    if (w && w.city === cityId && sameWatch(w, checked.watch)) return json({ error: 'You already have this watch.', watch: shown(w) }, 409);
  }
  const id = randomToken(12);
  const w = {
    v: 1, id, u: uid, city: cityId, ...checked.watch,
    created: new Date(now).toISOString(), ends: new Date(now + WATCH_DAYS * 864e5).toISOString(),
    email: await sealEmail(env.INVITE_SECRET, id, email), seen: [], sent: 0,
  };
  await putWatch(kv, w);
  // What's already on a posted agenda: shown now, and sent in the first email.
  const already = (snap?.items || []).filter((i) => matchesWatch(w, i)).slice(0, 10).map((i) => ({ body: i.body, when: i.when, text: i.text, url: i.url }));
  return json({ ok: true, watch: shown(w), already, refused: checked.refused });
}

/** The one-click stop from a mail client (RFC 8058): POST to the link, form-encoded. */
export async function handleOneClickStop(req, env) {
  if (!watchesReady(env)) return new Response('Not found', { status: 404 });
  const id = await tokenId(env.INVITE_SECRET, new URL(req.url).searchParams.get('t'));
  if (!id) return new Response("That stop link isn't valid.", { status: 400, headers: { 'Cache-Control': 'no-store' } });
  await env.LIMITS.delete(watchKey(id));
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
  const text = [];
  const html = [];
  text.push(`You asked ${appName} to watch ${watchLabel(watch)}.`, '');
  html.push(`<p>You asked ${esc(appName)} to watch ${esc(watchLabel(watch))}.</p>`);
  for (const [mid, list] of byMeeting) {
    const m = meetingOf.get(mid) || {};
    const head = `${m.body || list[0].body} ${m.type || ''}, ${meetingTime(m.when || list[0].when)}${m.location ? ` (${m.location})` : ''}`.replace(/\s+,/, ',');
    text.push(head);
    html.push(`<h3>${esc(head)}</h3><ul>`);
    for (const i of list) {
      text.push(`- ${i.text}`, `  ${i.url}`);
      html.push(`<li><a href="${esc(i.url)}">${esc(i.text)}</a></li>`);
    }
    if (m.url) {
      text.push(`  The meeting and its agenda: ${m.url}`);
      html.push(`</ul><p><a href="${esc(m.url)}">The meeting and its agenda</a></p>`);
    } else html.push('</ul>');
    text.push('');
  }
  const note = 'Matched on agenda titles as the City posted them. An item can affect a topic without naming it, so a watch can miss one. Private applicants\' names are withheld.';
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
function endedNote({ appName, watch, manageUrl }) {
  const line = `Your ${appName} watch for ${watchLabel(watch)} has ended, a year after it started. To keep watching, start it again: ${manageUrl}`;
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
 * appName, fetchImpl, send, now }. One run a day (`watch-run:<day>`), and
 * one at a time (a 15-minute lock, re-read after writing).
 */
export async function runWatchJob(env, deps = {}) {
  const kv = env.LIMITS;
  const now = deps.now ? deps.now() : Date.now();
  const cityIds = (deps.cityIds || []).filter((c) => watchableCity(deps.cities?.[c]));
  if (!cityIds.length || !(await jobDue(kv, cityIds, now))) return { ran: false };
  const token = randomToken(9);
  if (await kv.get('watch-lock')) return { ran: false, locked: true };
  await kv.put('watch-lock', token, { expirationTtl: 900 });
  if ((await kv.get('watch-lock')) !== token) return { ran: false, locked: true };
  const result = { ran: true, cities: {}, sent: 0, ended: 0, failed: 0 };
  try {
    const snapshots = {};
    for (const c of cityIds) {
      snapshots[c] = await buildSnapshot({ kv, city: deps.cities[c], cityId: c, appToken: env.SOCRATA_APP_TOKEN, fetchImpl: deps.fetchImpl, now });
      result.cities[c] = { meetings: snapshots[c].meetings.length, items: snapshots[c].items.length, failed: snapshots[c].failed };
    }
    if (watchesReady(env)) Object.assign(result, await mailWatches(env, { ...deps, now, snapshots }));
    await kv.put(`watch-run:${day(new Date(now).toISOString())}`, new Date(now).toISOString(), { expirationTtl: 3 * 86400 });
  } finally {
    await kv.delete('watch-lock');
  }
  return result;
}

async function mailWatches(env, { snapshots, cities, appName = 'Siren', fetchImpl, send = sendWithResend, now }) {
  const kv = env.LIMITS;
  const origin = `${publicOrigin(env).origin}${basePathOf(env)}`;
  const today = day(new Date(now).toISOString());
  const cap = Math.max(0, Number(env.WATCH_DAILY_EMAILS) || 100);
  let mailed = Number(await kv.get(`watch-mail:${today}`)) || 0;
  const out = { sent: 0, ended: 0, failed: 0, capped: 0 };
  for (const k of await listAll(kv)) {
    const w = await kv.get(k.name, 'json');
    if (!w?.email) continue;
    const snap = snapshots[w.city];
    if (!snap) continue;
    const manageUrl = `${origin}/watches`;
    const stopUrl = `${origin}/watch/stop?t=${encodeURIComponent(await stopToken(env.INVITE_SECRET, w.id))}`;
    let to;
    try {
      to = await openEmail(env.INVITE_SECRET, w.id, w.email);
    } catch {
      console.error('watch: an email could not be opened');
      continue;
    }
    const headers = { 'List-Unsubscribe': `<${stopUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    if (Date.parse(w.ends) <= now) {
      if (mailed < cap) {
        try {
          await send(env, { to, ...endedNote({ appName, watch: w, manageUrl }), idempotencyKey: `watch-end-${w.id}` }, fetchImpl);
          mailed++;
        } catch { /* ended either way */ }
      }
      await kv.delete(k.name);
      out.ended++;
      continue;
    }
    const seen = new Set(w.seen || []);
    const fresh = snap.items.filter((i) => !seen.has(i.key) && matchesWatch(w, i));
    if (!fresh.length) continue;
    if (mailed >= cap) {
      out.capped++;
      continue;
    }
    const mail = digest({ appName, watch: w, items: fresh, meetings: snap.meetings, city: cities[w.city], stopUrl, manageUrl });
    try {
      await send(env, { to, ...mail, headers, idempotencyKey: `watch-${w.id}-${today}` }, fetchImpl);
    } catch (err) {
      out.failed++;
      w.fails = (w.fails || 0) + 1;
      // Five days of refusals in a row (a dead address): the watch stops.
      if (w.fails >= 5) await kv.delete(k.name);
      else await putWatch(kv, w);
      console.error('watch: a digest was not sent', String(err?.message || '').slice(0, 40));
      continue;
    }
    mailed++;
    out.sent++;
    w.seen = [...(w.seen || []), ...fresh.map((i) => i.key)].slice(-SEEN_MAX);
    w.sent = (w.sent || 0) + 1;
    w.last_sent = new Date(now).toISOString();
    w.fails = 0;
    await putWatch(kv, w);
    await kv.put(`watch-mail:${today}`, String(mailed), { expirationTtl: 2 * 86400 });
  }
  await kv.put(`watch-mail:${today}`, String(mailed), { expirationTtl: 2 * 86400 });
  return out;
}

// ---- civic-league feeds ----

export const leagueSlug = (league) => normalizeText(league).replace(/ /g, '-');
const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/**
 * One Atom feed: every upcoming item in the snapshot (slug "all") or those
 * tagged with one civic league. Returns null for an unknown league.
 */
export function atomFeed({ snapshot, slug, origin, appName }) {
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
    <title>${xml(i.text.length > 200 ? `${i.text.slice(0, 197).replace(/\s+\S*$/, '')}…` : i.text)}</title>
    <link rel="alternate" href="${xml(i.url)}"/>
    <updated>${xml(i.first_seen)}</updated>
    <summary>${xml(`${when}. ${i.text}`)}</summary>
  </entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:${xml(host)},2026-11-16:feeds/${xml(slug)}</id>
  <title>${xml(title)}</title>
  <subtitle>${xml(`From the City's posted agendas, checked daily by ${appName}. Private applicants' names are withheld. Items are tagged by the civic league of the address their title names.`)}</subtitle>
  <link rel="self" href="${xml(self)}"/>
  <link rel="alternate" href="${xml(`${origin}/feeds`)}"/>
  <updated>${xml(snapshot.built)}</updated>
  <author><name>${xml(appName)}</name></author>
${entries.join('\n')}
</feed>
`;
}
