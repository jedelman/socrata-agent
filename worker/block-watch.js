// Block watch (docs/block-watch.md; Jason, 2026-11-14: "Watch by block gives
// plausible deniability. Let's build it."): a signed-in member names an
// address once, Siren keeps only its hundred block ("800 block of Union St"),
// and once a day the cron reads the agendas of meetings in the next two weeks
// and emails the member when an item's title names an address on that block.
// It's Siren's first forward-looking feature: analysis tells you what was
// decided; this tells you what's coming up.
//
// What's stored, per account, under watch:<uid> (uid is the account's keyed
// hash, worker/accounts.js): the blocks (city, street, hundred), the email
// address sealed with AES-GCM under a key derived from the WATCH_SECRET secret
// (the uid is the additional data, so a sealed address can't be moved to
// another record), the agenda items already sent, and the day it last changed.
// Never the house number: the address someone types is looked up, cut to its
// block and dropped, and it's never logged or traced anywhere that's kept.
// Sign-in still stores no email address (accounts.js); a watch is the one
// place Siren keeps one, sealed, because it has to send mail to it, and only
// until the member removes the watch or unsubscribes.
//
// The email typed when adding a watch must be the account's own: its keyed
// hash has to equal the uid, so nobody can sign someone else's inbox up, and
// no new verification email is needed (the account was signed in by a link
// sent to that address).
//
// Off unless BLOCK_WATCH = "true". With it off, every /watch path is the
// Worker's ordinary 404, the cron does nothing for it, and watch.css isn't
// served. On but not set up (LIMITS, INVITE_SECRET, WATCH_SECRET of 32+
// characters, Resend and PUBLIC_ORIGIN), its paths answer 503 and the cron
// logs why.

import { getCity } from '../src/cities/index.js';
import { Socrata, ACCESS, soqlString } from '../src/socrata.js';
import { Iqm2, extractAddresses, normalizeAddress, withholdApplicant } from '../src/adapters/iqm2.js';
import { Trace } from '../src/trace.js';
import { Resources } from '../src/resources.js';
import { requestBudget } from '../src/request-budget.js';
import { addressKey, lookupAddress } from '../src/block.js';
import { userId, sendWithResend, loginConfigured } from './accounts.js';
import { normalizeEmail } from './invites.js';
import { enc, b64url, unb64url, hmac, hmacHex, boundary } from './crypto.js';

export const MAX_BLOCKS = 5;
export const ADDS_DAILY = 20;
export const DAYS_AHEAD = 14;
export const MAX_MEETINGS = 20;
export const MAX_WATCHES = 2000;
export const MAX_EMAILS = 200;
export const MAX_SENT = 300;
// 12:00 UTC is 7 or 8 a.m. in Norfolk: the first cron tick at or after it runs the day's scan.
export const SCAN_HOUR_UTC = 12;
// Requests one city's scan may make: the notices query, the meeting pages, and spare.
export const SCAN_BUDGET = 40;
const PREFIX = 'watch:';

export const blockWatchOn = (env) => env?.BLOCK_WATCH === 'true';

export function blockWatchSetupError(env) {
  if (!env.LIMITS) return 'block watch needs the LIMITS storage';
  if (!env.INVITE_SECRET) return 'block watch needs INVITE_SECRET (email sign-in)';
  if (!env.WATCH_SECRET || String(env.WATCH_SECRET).length < 32) return 'block watch needs the WATCH_SECRET secret, 32+ characters';
  if (!loginConfigured(env)) return 'block watch needs email sign-in (RESEND_API_KEY and LOGIN_FROM)';
  if (!env.PUBLIC_ORIGIN) return 'block watch needs PUBLIC_ORIGIN for the links it emails';
  return null;
}

// Cities whose agendas can be read (the iqm2 adapter) and whose addresses can be looked up.
export const watchable = (city) => Boolean(city?.meetings?.kind === 'iqm2' && city.meetings.noticesDataset && city.address);

const titleCase = (s) => String(s).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** The block of a looked-up address (lookupAddress's match): never the house number. */
export function blockOf(cityKey, match) {
  const hundred = Math.floor(Number(match.number) / 100) * 100;
  const street = addressKey(`${match.number} ${match.street}`).street;
  return { city: cityKey, street, hundred, label: `${hundred} block of ${titleCase(match.street)}` };
}
export const blockId = (b) => `${b.city}:${b.hundred}:${b.street}`;

/** Whether an address written in an agenda title is on the block. */
export function onBlock(block, address) {
  const k = addressKey(address);
  if (!k.num || k.street !== block.street) return false;
  return Math.floor(Number(k.num) / 100) * 100 === block.hundred;
}

// The email, sealed. The key is derived from WATCH_SECRET with a label of its
// own; the uid is the additional data, so a sealed address opens only in its
// own record.
async function emailKey(secret) {
  return crypto.subtle.importKey('raw', await hmac(secret, 'block-watch:email-key'), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealEmail(secret, uid, email) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(uid) }, await emailKey(secret), enc.encode(email)));
  return `${b64url(iv)}.${b64url(ct)}`;
}
export async function openEmail(secret, uid, sealed) {
  try {
    const [iv, ct] = String(sealed).split('.').map(unb64url);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(uid) }, await emailKey(secret), ct);
    return normalizeEmail(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}

// The unsubscribe link's token: the uid and an HMAC of it under its own label.
// It can only remove that account's watch.
export async function unsubscribeToken(secret, uid) {
  return `${uid}.${await hmacHex(secret, `block-watch:unsubscribe:${uid}`, 32)}`;
}
export async function tokenUid(secret, token) {
  const m = /^([0-9a-f]{64})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!m) return null;
  return (await hmacHex(secret, `block-watch:unsubscribe:${m[1]}`, 32)) === m[2] ? m[1] : null;
}

const day = (now) => new Date(now).toISOString().slice(0, 10);

export async function loadWatch(kv, uid) {
  const w = await kv.get(`${PREFIX}${uid}`, 'json');
  return w && Array.isArray(w.blocks) ? w : null;
}
export async function deleteWatch(kv, uid) {
  await kv.delete(`${PREFIX}${uid}`);
}

/**
 * Add a block for a signed-in member. `lookup(cityKey, address)` returns
 * lookupAddress's result (index.js passes one that runs it on a counted,
 * traced Socrata client). Returns { ok, block } or { ok: false, code }; codes
 * are fixed words the page turns into text, never the input.
 */
export async function addBlock({ env, kv, uid, email, address, cityKey, lookup, now = Date.now() }) {
  const city = getCity(cityKey);
  if (!watchable(city)) return { ok: false, code: 'city' };
  const addr = String(address || '').trim().slice(0, 120);
  if (!addr) return { ok: false, code: 'address' };
  const mail = normalizeEmail(email);
  if (!mail || (await userId(env.INVITE_SECRET, mail)) !== uid) return { ok: false, code: 'email' };
  const watch = (await loadWatch(kv, uid)) || { v: 1, blocks: [], sent: [] };
  if (watch.blocks.length >= MAX_BLOCKS) return { ok: false, code: 'full' };
  // Lookups per account per UTC day, counted under a key that can't be joined to the account's other keys.
  const rateKey = `watch-rate:${day(now)}:${await hmacHex(env.WATCH_SECRET, `watch-rate:${uid}`, 32)}`;
  const used = Number((await kv.get(rateKey)) || 0);
  if (used >= ADDS_DAILY) return { ok: false, code: 'rate' };
  await kv.put(rateKey, String(used + 1), { expiration: boundary(now, 'day', 2) });
  let found;
  try {
    found = await lookup(cityKey, addr);
  } catch {
    return { ok: false, code: 'lookup' };
  }
  if (!found?.match) return { ok: false, code: found?.candidates?.length ? 'ambiguous' : 'notfound' };
  const block = blockOf(cityKey, found.match);
  if (!block.street || !Number.isFinite(block.hundred)) return { ok: false, code: 'notfound' };
  if (watch.blocks.some((b) => blockId(b) === blockId(block))) return { ok: true, block, already: true };
  watch.blocks.push({ ...block, added: day(now) });
  watch.email = await sealEmail(env.WATCH_SECRET, uid, mail);
  watch.updated = day(now);
  await kv.put(`${PREFIX}${uid}`, JSON.stringify(watch));
  return { ok: true, block };
}

export async function removeBlock({ kv, uid, id, now = Date.now() }) {
  const watch = await loadWatch(kv, uid);
  if (!watch) return { ok: true };
  watch.blocks = watch.blocks.filter((b) => blockId(b) !== id);
  if (!watch.blocks.length) {
    await deleteWatch(kv, uid);
    return { ok: true };
  }
  watch.updated = day(now);
  await kv.put(`${PREFIX}${uid}`, JSON.stringify(watch));
  return { ok: true };
}

/**
 * Upcoming agenda items for a city that name an address: the meetings in the
 * Public Meeting Notices dataset for the next DAYS_AHEAD days, each meeting's
 * agenda read from the meeting portal. Every request goes through `trace`
 * and one counting fetch.
 */
export async function upcomingItems({ city, env, fetchImpl, now = Date.now() }) {
  const budget = requestBudget({ limit: SCAN_BUDGET, fetchImpl });
  const trace = new Trace();
  const resources = new Resources();
  const socrata = new Socrata({ city, trace, resources, appToken: env.SOCRATA_APP_TOKEN, fetchImpl: budget.tool });
  const iqm2 = new Iqm2({ base: city.meetings.iqm2, trace, resources, fetchImpl: budget.tool });
  const iso = (t) => new Date(t).toISOString().slice(0, 19);
  const rows = await socrata.query(
    city.meetings.noticesDataset,
    `SELECT date_and_time, organization, meeting_link WHERE date_and_time >= ${soqlString(iso(now))} AND date_and_time <= ${soqlString(iso(now + DAYS_AHEAD * 864e5))} ORDER BY date_and_time LIMIT 100`,
    { access: ACCESS.CORE, tool: 'block watch: upcoming meetings', name: 'Public Meeting Notices' }
  );
  const meetings = new Map();
  for (const r of rows) {
    const id = r.meeting_link?.url?.match(/Detail_Meeting\.aspx\?ID=(\d+)/i)?.[1];
    if (id && !meetings.has(id)) meetings.set(id, { id, body: r.organization || 'Meeting', date: String(r.date_and_time || '').slice(0, 10) });
  }
  const chosen = [...meetings.values()].slice(0, MAX_MEETINGS);
  const items = [];
  let failed = 0;
  for (const mt of chosen) {
    try {
      const m = await iqm2.meeting(mt.id);
      for (const it of m.items) {
        const addresses = extractAddresses(it.text).map(normalizeAddress);
        if (addresses.length) items.push({ id: it.id, title: it.text, addresses, meeting: mt, url: iqm2.legiUrl(it.id), meetingUrl: iqm2.meetingUrl(mt.id) });
      }
    } catch {
      failed++;
    }
  }
  return { items, meetings: chosen.length, failed, requests: trace.steps.length };
}

const sentKey = (item) => `${item.id}@${item.meeting.id}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const prettyDay = (d) => {
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : d;
};

/** The digest: plain text and HTML, every agenda title with an applicant's name withheld. */
export function digest({ groups, origin, unsubscribe, appName = 'Siren' }) {
  const manage = `${origin}/watch`;
  const lines = [`${appName} found agenda items naming an address on a block you watch.`, ''];
  const html = [`<p>${esc(appName)} found agenda items naming an address on a block you watch.</p>`];
  for (const g of groups) {
    lines.push(g.block.label);
    html.push(`<h3>${esc(g.block.label)}</h3><ul>`);
    for (const it of g.items) {
      const title = withholdApplicant(it.title).slice(0, 400);
      lines.push(`- ${it.meeting.body}, ${prettyDay(it.meeting.date)}: ${title}`, `  Record: ${it.url}`, `  Agenda: ${it.meetingUrl}`);
      html.push(`<li><strong>${esc(it.meeting.body)}, ${esc(prettyDay(it.meeting.date))}</strong>: <a href="${esc(it.url)}">${esc(title)}</a> (<a href="${esc(it.meetingUrl)}">agenda</a>)</li>`);
    }
    lines.push('');
    html.push('</ul>');
  }
  const caveat = 'I matched these by the street address written in each agenda title. Items that name no address (citywide ordinances, budgets) are not matched, so this is not everything that could affect the block. AI can make mistakes; the record is the word.';
  lines.push(caveat, '', `Manage your blocks: ${manage}`, `Stop these emails: ${unsubscribe}`);
  html.push(`<p>${esc(caveat)}</p><p><a href="${esc(manage)}">Manage your blocks</a> · <a href="${esc(unsubscribe)}">Stop these emails</a></p>`);
  const n = groups.length;
  const subject = n === 1 ? `On an upcoming agenda: the ${groups[0].block.label}` : `On upcoming agendas: ${n} of your blocks`;
  return { subject, text: lines.join('\n'), html: html.join('') };
}

async function listWatches(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && keys.length < MAX_WATCHES);
  return keys.slice(0, MAX_WATCHES);
}

/**
 * The daily scan, from the cron. Runs at most once a UTC day, on the first
 * tick at or after SCAN_HOUR_UTC (a claim key, written before any fetch; the
 * sent list keeps a second run from repeating an email anyway). With no
 * watches it makes no request at all. Logs one line of counts, never an
 * address, block, email or account.
 */
export async function runBlockWatch(env, { now = Date.now(), fetchImpl, send = sendWithResend, force = false } = {}) {
  if (!blockWatchOn(env)) return { skipped: 'off' };
  const setup = blockWatchSetupError(env);
  if (setup) {
    console.error('block watch:', setup);
    return { skipped: 'setup' };
  }
  if (!force && new Date(now).getUTCHours() < SCAN_HOUR_UTC) return { skipped: 'early' };
  const kv = env.LIMITS;
  const claim = `watch-run:${day(now)}`;
  if (!force && (await kv.get(claim))) return { skipped: 'done' };
  await kv.put(claim, '1', { expiration: boundary(now, 'day', 2) });
  const keys = await listWatches(kv);
  const watches = [];
  for (const k of keys) {
    const w = await kv.get(k, 'json');
    if (w && Array.isArray(w.blocks) && w.blocks.length) watches.push({ uid: k.slice(PREFIX.length), w });
  }
  const summary = { event: 'block_watch', watches: watches.length, meetings: 0, items: 0, failed_meetings: 0, requests: 0, emails: 0, email_failures: 0 };
  if (!watches.length) {
    console.log(JSON.stringify(summary));
    return summary;
  }
  const byCity = new Map();
  for (const { w } of watches) for (const b of w.blocks) if (!byCity.has(b.city)) byCity.set(b.city, null);
  for (const key of byCity.keys()) {
    const city = getCity(key);
    if (!watchable(city)) continue;
    try {
      const got = await upcomingItems({ city, env, fetchImpl, now });
      byCity.set(key, got.items);
      summary.meetings += got.meetings;
      summary.items += got.items.length;
      summary.failed_meetings += got.failed;
      summary.requests += got.requests;
    } catch {
      summary.failed_meetings += 1;
    }
  }
  const origin = String(env.PUBLIC_ORIGIN).replace(/\/$/, '') + String(env.BASE_PATH || '').replace(/\/$/, '');
  for (const { uid, w } of watches) {
    if (summary.emails >= MAX_EMAILS) break;
    const sent = new Set(w.sent || []);
    const groups = [];
    for (const b of w.blocks) {
      const items = (byCity.get(b.city) || []).filter((it) => !sent.has(sentKey(it)) && it.addresses.some((a) => onBlock(b, a)));
      if (items.length) groups.push({ block: b, items });
    }
    if (!groups.length) continue;
    const to = await openEmail(env.WATCH_SECRET, uid, w.email);
    if (!to) continue;
    const unsubscribe = `${origin}/watch/unsubscribe?t=${await unsubscribeToken(env.WATCH_SECRET, uid)}`;
    const mail = digest({ groups, origin, unsubscribe, appName: env.APP_NAME || 'Siren' });
    const fresh = groups.flatMap((g) => g.items.map(sentKey));
    try {
      await send(env, {
        to,
        ...mail,
        headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        idempotencyKey: `watch-${day(now)}-${await hmacHex(env.WATCH_SECRET, `watch-mail:${uid}:${fresh.join(',')}`, 32)}`,
      }, fetchImpl);
      summary.emails++;
      // Re-read before writing, so a block removed during the scan stays removed.
      const cur = await loadWatch(kv, uid);
      if (cur) {
        cur.sent = [...(cur.sent || []), ...fresh].slice(-MAX_SENT);
        await kv.put(`${PREFIX}${uid}`, JSON.stringify(cur));
      }
    } catch {
      summary.email_failures++;
    }
  }
  console.log(JSON.stringify(summary));
  return summary;
}

// ----- The page and its forms -----

const MESSAGES = {
  added: 'Added. I check upcoming agendas once a day and email you when an item names an address on this block.',
  already: 'You already watch that block.',
  removed: 'Removed.',
  stopped: 'Done. I deleted your watch and your email address; no more of these emails.',
  email: "That email isn't the one this account signed in with. Use the address your sign-in link went to.",
  address: 'Type a street address, like "810 Union St".',
  notfound: "I couldn't find that address in the City's address list. Check the number and street.",
  ambiguous: 'More than one address matched. Add the street type (St, Ave) or direction.',
  full: `You can watch up to ${MAX_BLOCKS} blocks. Remove one to add another.`,
  rate: 'Too many lookups today. Try again tomorrow.',
  lookup: "I couldn't reach the City's address list just now. Try again in a few minutes.",
  city: 'Block watch works for Norfolk addresses for now.',
  badlink: "That link didn't work. Sign in and remove your blocks on this page instead.",
};

function layout({ title, body, css }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="${esc(css)}"></head><body><main class="wrap">${body}</main></body></html>`;
}

const notice = (m) => (MESSAGES[m] ? `<div class="card notice${['added', 'already', 'removed', 'stopped'].includes(m) ? '' : ' err'}" role="status"><p>${esc(MESSAGES[m])}</p></div>` : '');

export function watchPage({ state, watch, base, css, message, account }) {
  const intro = '<h1>Watch a block</h1><p class="lede">Name an address once and Siren keeps only its block (the 800 block of Union St, not your house number). Once a day I read the agendas of City meetings in the next two weeks and email you when an item names an address on that block.</p>';
  let body = intro + notice(message);
  if (state === 'signed-out') {
    body += `<div class="card"><p>Sign in with your email on <a href="${esc(base)}/">Siren's page</a> first, then come back here.</p></div>`;
  } else if (state === 'not-member') {
    body += `<div class="card"><p>Block watch is for members: redeem your invite on <a href="${esc(base)}/">Siren's page</a> while signed in, then come back here.</p></div>`;
  } else {
    const blocks = watch?.blocks || [];
    body += `<div class="card"><h2>Your blocks</h2>${account ? `<p class="small">Signed in as ${esc(account)}</p>` : ''}`;
    body += blocks.length
      ? `<ul class="blocks">${blocks.map((b) => `<li><span>${esc(b.label)}</span><form method="post" action="${esc(base)}/watch/remove"><input type="hidden" name="block" value="${esc(blockId(b))}"><button class="quiet" type="submit">Remove</button></form></li>`).join('')}</ul>`
      : '<p class="small">None yet.</p>';
    body += '</div>';
    if (blocks.length < MAX_BLOCKS) {
      body += `<div class="card"><h2>Add a block</h2><form class="add" method="post" action="${esc(base)}/watch/add"><label>Any address on the block<input name="address" autocomplete="street-address" maxlength="120" required placeholder="810 Union St"></label><label>Your sign-in email, to send the alerts to<input name="email" type="email" autocomplete="email" maxlength="254" required></label><button type="submit">Watch this block</button></form><p class="small">The address is looked up once and not kept. Your email is kept encrypted, only to send these alerts, until you remove your last block or press "Stop these emails".</p></div>`;
    }
    if (blocks.length) body += `<div class="card"><form method="post" action="${esc(base)}/watch/delete"><button class="quiet" type="submit">Stop all alerts and delete my email</button></form></div>`;
  }
  body += '<p class="small">I match agenda items by the street address written in their titles. Items that name no address (citywide ordinances, budgets) are not matched.</p>';
  return layout({ title: 'Watch a block', body, css });
}

export function unsubscribePage({ token, base, css, message }) {
  let body = '<h1>Stop block watch emails</h1>' + notice(message);
  if (!message) body += `<div class="card"><p>This deletes your watched blocks and the email address kept for them.</p><form method="post" action="${esc(base)}/watch/unsubscribe"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Stop these emails</button></form></div>`;
  return layout({ title: 'Stop block watch emails', body, css });
}

/**
 * The /watch routes, or null for any other path. `deps`: { base, origin,
 * css, pageHeaders, currentUserInfo(req), isMember(uid), lookup(cityKey, address), cityKey }.
 * Forms post without script; a post must come from this origin (the session
 * cookie is SameSite=Lax as well), except the unsubscribe link, which is
 * authorized by its token alone so a mail provider's one-click works.
 */
export async function handleWatch(req, env, path, deps) {
  if (path !== '/watch' && !path.startsWith('/watch/')) return null;
  const { base, css, pageHeaders } = deps;
  const html = (body, status = 200) => new Response(body, { status, headers: { ...pageHeaders, 'Cache-Control': 'no-store' } });
  const back = (m) => new Response(null, { status: 303, headers: { Location: `${base}/watch?m=${encodeURIComponent(m)}`, 'Cache-Control': 'no-store' } });
  const setup = blockWatchSetupError(env);
  if (setup) return new Response('Block watch is not set up on this site yet.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const kv = env.LIMITS;
  const sameOrigin = () => req.headers.get('Origin') === deps.origin;
  const form = async () => {
    try {
      return await req.formData();
    } catch {
      return new FormData();
    }
  };

  if (path === '/watch/unsubscribe') {
    const url = new URL(req.url);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const ok = await tokenUid(env.WATCH_SECRET, url.searchParams.get('t'));
      return html(unsubscribePage({ token: url.searchParams.get('t') || '', base, css, message: ok ? '' : 'badlink' }), ok ? 200 : 400);
    }
    if (req.method !== 'POST') return null;
    const f = await form();
    const uid = await tokenUid(env.WATCH_SECRET, f.get('t') || url.searchParams.get('t'));
    if (!uid) return html(unsubscribePage({ token: '', base, css, message: 'badlink' }), 400);
    await deleteWatch(kv, uid);
    return html(unsubscribePage({ token: '', base, css, message: 'stopped' }));
  }

  const info = await deps.currentUserInfo(req);
  const uid = info?.uid || null;
  const member = uid ? await deps.isMember(uid) : false;

  if (path === '/watch' && (req.method === 'GET' || req.method === 'HEAD')) {
    const m = new URL(req.url).searchParams.get('m');
    const state = !uid ? 'signed-out' : !member ? 'not-member' : 'member';
    return html(watchPage({ state, watch: member ? await loadWatch(kv, uid) : null, base, css, message: Object.hasOwn(MESSAGES, m || '') ? m : '', account: info?.masked || '' }));
  }
  if (req.method !== 'POST' || !['/watch/add', '/watch/remove', '/watch/delete'].includes(path)) return null;
  if (!sameOrigin()) return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  if (!uid || !member) return back('');
  const f = await form();
  if (path === '/watch/add') {
    const out = await addBlock({ env, kv, uid, email: f.get('email'), address: f.get('address'), cityKey: deps.cityKey, lookup: deps.lookup });
    return back(out.ok ? (out.already ? 'already' : 'added') : out.code);
  }
  if (path === '/watch/remove') {
    await removeBlock({ kv, uid, id: String(f.get('block') || '') });
    return back('removed');
  }
  await deleteWatch(kv, uid);
  return back('stopped');
}

/** A lookup for addBlock: lookupAddress on its own counted, traced Socrata client, kept nowhere. */
export function addressLookup(env, fetchImpl) {
  return async (cityKey, address) => {
    const city = getCity(cityKey);
    const budget = requestBudget({ limit: 5, fetchImpl });
    const trace = new Trace();
    const resources = new Resources();
    const socrata = new Socrata({ city, trace, resources, appToken: env.SOCRATA_APP_TOKEN, fetchImpl: budget.tool });
    return lookupAddress({ city, socrata, resources }, address);
  };
}
