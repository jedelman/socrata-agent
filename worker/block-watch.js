// Block watch (docs/block-watch.md; Jason, 2026-11-14: "Watch by block gives
// plausible deniability. Let's build it."): a signed-in member names an
// address once, Siren keeps only its hundred block ("800 block of Union St"),
// and once a day the cron reads the agendas of meetings in the next two weeks
// and emails the member when an agenda item names an address on that block.
// It's Siren's first forward-looking feature: analysis tells you what was
// decided; this tells you what's coming up.
//
// What's stored, per account, under watch:<uid> (uid is the account's keyed
// hash, worker/accounts.js): the blocks (city, direction, street, suffix,
// hundred), the email address sealed with AES-GCM under a key derived from the
// WATCH_SECRET secret (the uid is the additional data, so a sealed address
// can't be moved to another record), a random id for the unsubscribe link,
// and the day it last changed. Never the house number: the address someone
// types is looked up, cut to its block and dropped, and it's never logged or
// traced anywhere that's kept. Sign-in still stores no email address
// (accounts.js); a watch is the one place Siren keeps one, sealed, because it
// has to send mail to it, and only until the member removes the watch or
// unsubscribes. Only the member's own actions write watch:<uid>; the scan
// never does (its sent list is a key of its own), so a removal can't be
// undone by a scan that read the record before it.
//
// The email never carries an agenda title. Titles name private people
// anywhere in them (buyers of City lots, people allowed to encroach, tenants,
// applicants), so the email says only what kind of item it is, from a fixed
// list of phrases, and which address on the block it names; the reader opens
// the City's record for the rest.
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
import { Iqm2, extractAddresses, normalizeAddress } from '../src/adapters/iqm2.js';
import { Trace } from '../src/trace.js';
import { Resources } from '../src/resources.js';
import { requestBudget } from '../src/request-budget.js';
import { lookupAddress } from '../src/block.js';
import { userId, sendWithResend, loginConfigured, memberInvite } from './accounts.js';
import { normalizeEmail } from './invites.js';
import { enc, b64url, unb64url, hmac, hmacHex, hex, boundary } from './crypto.js';

export const MAX_BLOCKS = 5;
export const ADDS_DAILY = 20;
export const DAYS_AHEAD = 14;
export const MAX_MEETINGS = 20;
// Watches handled per cron tick. Each costs at most eight KV operations (the
// watch read twice, its member and invite keys, the sent list read and
// write, or a deletion's read and three deletes), so a batch stays well under
// the 1,000 a Worker invocation may make; the rest of the list waits for the
// next tick, ten minutes later, from a stored cursor.
export const BATCH = 80;
export const MAX_EMAILS = 100;
export const MAX_SENT = 300;
const SENT_DAYS = 120;
// 12:00 UTC is 7 or 8 a.m. in Norfolk: the scan starts on the first tick at or after it.
export const SCAN_HOUR_UTC = 12;
// Requests one city's agendas may take each tick: the notices query, the meeting pages, and spare.
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

// Directions and street types as normalizeAddress spells them.
const DIRS = new Set(['NORTH', 'SOUTH', 'EAST', 'WEST']);
const SUFFIXES = new Set([
  'STREET', 'AVENUE', 'BOULEVARD', 'ROAD', 'DRIVE', 'LANE', 'COURT', 'CIRCLE', 'PLACE', 'WAY', 'TERRACE', 'PARKWAY',
  'HIGHWAY', 'CRESCENT', 'SQUARE', 'TRAIL', 'ARCH', 'LANDING', 'POINT', 'QUAY', 'RUN', 'WALK', 'MEWS',
]);

/**
 * An address's street, kept whole: number, direction, name and type. Two
 * streets that differ only by direction (W and E Ocean View Ave) or type
 * (Union St and Union Ave) are different streets.
 */
export function streetParts(address) {
  const words = normalizeAddress(String(address).split(',')[0]).split(' ').filter(Boolean);
  const i = words.findIndex((w) => /^\d+[A-Z]?$/.test(w));
  if (i < 0) return null;
  const num = parseInt(words[i], 10);
  let rest = words.slice(i + 1);
  let dir = '';
  if (rest.length > 1 && DIRS.has(rest[0])) {
    dir = rest[0];
    rest = rest.slice(1);
  }
  let suffix = '';
  if (rest.length > 1 && SUFFIXES.has(rest.at(-1))) suffix = rest.pop();
  if (!rest.length || !Number.isFinite(num)) return null;
  return { num, dir, core: rest.join(' '), suffix };
}

/** The block of a looked-up address (lookupAddress's match): never the house number. */
export function blockOf(cityKey, match) {
  const p = streetParts(`${match.number} ${match.street}`);
  if (!p) return null;
  const hundred = Math.floor(p.num / 100) * 100;
  return { city: cityKey, dir: p.dir, core: p.core, suffix: p.suffix, hundred, label: `${hundred} block of ${titleCase(match.street)}` };
}
export const blockId = (b) => `${b.city}:${b.hundred}:${b.dir}:${b.core}:${b.suffix}`;

/**
 * Whether an address written in an agenda title is on the block: the same
 * street name, direction and type (an agenda that leaves out a direction the
 * block has doesn't match: a miss, never a wrong street), and the same hundred.
 */
export function onBlock(block, address) {
  const p = streetParts(address);
  if (!p || p.core !== block.core || p.dir !== block.dir || p.suffix !== block.suffix) return false;
  return Math.floor(p.num / 100) * 100 === block.hundred;
}

// What kind of item it is, in Siren's words, from fixed phrases only: the
// email never quotes a title.
const KINDS = [
  [/short[- ]term rental/i, 'a short-term rental'],
  [/conditional use permit/i, 'a conditional use permit'],
  [/rezon|change (?:in|of) zoning|zoning map/i, 'a zoning change'],
  [/encroach/i, 'an encroachment into the public right-of-way'],
  // "Sale of Alcoholic Beverages" is a permit, not a property sale.
  [/\bconvey|\bsale of (?!alcohol)(?:city|certain|real|that|the|property|land|surplus|a parcel)/i, 'a sale or transfer of property'],
  [/\blease\b|license agreement/i, 'a lease or license'],
  [/demoli/i, 'a demolition'],
  [/design review|development certificate|certificate of appropriateness/i, 'a design review'],
  [/variance|special exception/i, 'a variance or exception'],
  [/easement/i, 'an easement'],
  [/subdivision|\bplat\b/i, 'a subdivision'],
  [/accessory dwelling|\bADU\b/, 'an accessory dwelling unit'],
  [/[Aa]lcohol|\bABC\b/, 'alcohol sales'],
];
export function itemKinds(title) {
  const out = KINDS.filter(([re]) => re.test(String(title))).map(([, phrase]) => phrase);
  return out.length ? out.slice(0, 3) : ['an agenda item'];
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

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// The unsubscribe link carries the watch's own random id (made when the watch
// is, gone when it is), never the uid, and an HMAC of it under its own label.
// It can only remove that one watch, and it stops working once the watch is
// deleted, even if the member watches a block again later.
export async function unsubscribeToken(secret, id) {
  return `${id}.${await hmacHex(secret, `block-watch:unsubscribe:${id}`, 32)}`;
}
export async function tokenWatchId(secret, token) {
  const m = /^([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!m) return null;
  return sameString(await hmacHex(secret, `block-watch:unsubscribe:${m[1]}`, 32), m[2]) ? m[1] : null;
}

const day = (now) => new Date(now).toISOString().slice(0, 10);
const sentListKey = async (secret, uid) => `watch-sent:${await hmacHex(secret, `watch-sent:${uid}`, 32)}`;

export async function loadWatch(kv, uid) {
  const w = await kv.get(`${PREFIX}${uid}`, 'json');
  return w && Array.isArray(w.blocks) ? w : null;
}
/** Delete a watch and everything kept for it: the record, its sent list and its unsubscribe id. */
export async function deleteWatch(env, uid) {
  const kv = env.LIMITS;
  const w = await loadWatch(kv, uid);
  await kv.delete(`${PREFIX}${uid}`);
  await kv.delete(await sentListKey(env.WATCH_SECRET, uid));
  if (w?.id) await kv.delete(`watch-by-id:${w.id}`);
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
  const watch = (await loadWatch(kv, uid)) || { v: 1, blocks: [] };
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
  if (!block) return { ok: false, code: 'notfound' };
  if (watch.blocks.some((b) => blockId(b) === blockId(block))) return { ok: true, block, already: true };
  watch.blocks.push({ ...block, added: day(now) });
  watch.email = await sealEmail(env.WATCH_SECRET, uid, mail);
  if (!watch.id) watch.id = hex(crypto.getRandomValues(new Uint8Array(16)));
  watch.updated = day(now);
  await kv.put(`watch-by-id:${watch.id}`, uid);
  await kv.put(`${PREFIX}${uid}`, JSON.stringify(watch));
  return { ok: true, block };
}

export async function removeBlock({ env, kv, uid, id, now = Date.now() }) {
  const watch = await loadWatch(kv, uid);
  if (!watch) return { ok: true };
  watch.blocks = watch.blocks.filter((b) => blockId(b) !== id);
  if (!watch.blocks.length) {
    await deleteWatch(env, uid);
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
 * and one counting fetch. Throws if the notices can't be read.
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
        if (addresses.length) items.push({ id: it.id, kinds: itemKinds(it.text), addresses, meeting: mt, url: iqm2.legiUrl(it.id), meetingUrl: iqm2.meetingUrl(mt.id) });
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
const joinList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/**
 * The digest, plain text and HTML. Each item is described by its kind (fixed
 * phrases) and the addresses on the watched block it names: never its title.
 */
export function digest({ groups, origin, unsubscribe, appName = 'Siren' }) {
  const manage = `${origin}/watch`;
  const lead = `${appName} found agenda items naming an address on a block you watch.`;
  const lines = [lead, ''];
  const html = [`<p>${esc(lead)}</p>`];
  for (const g of groups) {
    lines.push(g.block.label);
    html.push(`<h3>${esc(g.block.label)}</h3><ul>`);
    for (const it of g.items) {
      const what = `an item about ${joinList(it.kinds.map((k) => k.replace(/^an agenda item$/, 'City business')))} at ${joinList(it.here.map(titleCase))}`;
      lines.push(`- ${it.meeting.body}, ${prettyDay(it.meeting.date)}: ${what}`, `  Record: ${it.url}`, `  Agenda: ${it.meetingUrl}`);
      html.push(`<li><strong>${esc(it.meeting.body)}, ${esc(prettyDay(it.meeting.date))}</strong>: <a href="${esc(it.url)}">${esc(what)}</a> (<a href="${esc(it.meetingUrl)}">agenda</a>)</li>`);
    }
    lines.push('');
    html.push('</ul>');
  }
  const caveat = 'I matched these by the street address written in each agenda title, and described each by its kind; the City\'s record has the rest. Items that name no address (citywide ordinances, budgets) are not matched, so this is not everything that could affect the block. AI can make mistakes; the record is the word.';
  lines.push(caveat, '', `Manage your blocks: ${manage}`, `Stop these emails: ${unsubscribe}`);
  html.push(`<p>${esc(caveat)}</p><p><a href="${esc(manage)}">Manage your blocks</a> · <a href="${esc(unsubscribe)}">Stop these emails</a></p>`);
  const n = groups.length;
  const subject = n === 1 ? `On an upcoming agenda: the ${groups[0].block.label}` : `On upcoming agendas: ${n} of your blocks`;
  return { subject, text: lines.join('\n'), html: html.join('') };
}

/**
 * The daily scan, from the cron. From SCAN_HOUR_UTC each UTC day it reads the
 * upcoming agendas and works through the watches BATCH at a time, one batch a
 * tick, keeping its place in `watch-run:<day>`; a tick whose agendas can't be
 * read leaves the place as it was, so the next tick tries again. With no
 * watches it reads no agendas. A member who has lost their invite has their
 * watch deleted, not emailed. It never writes a watch record. Logs one line
 * of counts a tick, never an address, block, email or account.
 */
export async function runBlockWatch(env, { now = Date.now(), fetchImpl, send = sendWithResend } = {}) {
  if (!blockWatchOn(env)) return { skipped: 'off' };
  const setup = blockWatchSetupError(env);
  if (setup) {
    console.error('block watch:', setup);
    return { skipped: 'setup' };
  }
  if (new Date(now).getUTCHours() < SCAN_HOUR_UTC) return { skipped: 'early' };
  const kv = env.LIMITS;
  const stateKey = `watch-run:${day(now)}`;
  const state = await kv.get(stateKey, 'json');
  if (state?.done) return { skipped: 'done' };
  const expiration = boundary(now, 'day', 2);
  const page = await kv.list({ prefix: PREFIX, limit: BATCH, ...(state?.cursor ? { cursor: state.cursor } : {}) });
  const next = page.list_complete || !page.cursor ? { done: true } : { cursor: page.cursor };
  const summary = { event: 'block_watch', watches: 0, meetings: 0, items: 0, failed_meetings: 0, requests: 0, emails: 0, email_failures: 0, removed: 0, errors: 0 };
  const watches = [];
  for (const k of page.keys) {
    try {
      const w = await kv.get(k.name, 'json');
      if (w && Array.isArray(w.blocks) && w.blocks.length) watches.push({ uid: k.name.slice(PREFIX.length), w });
    } catch {
      summary.errors++;
    }
  }
  summary.watches = watches.length;
  if (!watches.length) {
    await kv.put(stateKey, JSON.stringify(next), { expiration });
    console.log(JSON.stringify(summary));
    return summary;
  }
  const byCity = new Map();
  for (const { w } of watches) for (const b of w.blocks) byCity.set(b.city, null);
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
      // The agendas couldn't be read: keep the place, try again next tick.
      summary.errors++;
      console.log(JSON.stringify({ ...summary, retry: true }));
      return { ...summary, retry: true };
    }
  }
  const origin = String(env.PUBLIC_ORIGIN).replace(/\/$/, '') + String(env.BASE_PATH || '').replace(/\/$/, '');
  for (const { uid, w } of watches) {
    if (summary.emails >= MAX_EMAILS) break;
    try {
      if (!(await memberInvite(kv, uid))) {
        await deleteWatch(env, uid);
        summary.removed++;
        continue;
      }
      const listKey = await sentListKey(env.WATCH_SECRET, uid);
      const sent = new Set((await kv.get(listKey, 'json')) || []);
      const groups = [];
      for (const b of w.blocks) {
        const items = [];
        for (const it of byCity.get(b.city) || []) {
          if (sent.has(sentKey(it))) continue;
          const here = it.addresses.filter((a) => onBlock(b, a));
          if (here.length) items.push({ ...it, here });
        }
        if (items.length) groups.push({ block: b, items });
      }
      if (!groups.length) continue;
      // Read again just before sending: a watch deleted while the agendas were
      // read gets no email and no sent list. (KV can serve a read up to a
      // minute stale, so a deletion in the last moments can still get that
      // day's email; nothing is written back either way.)
      if (!(await loadWatch(kv, uid))) continue;
      const to = await openEmail(env.WATCH_SECRET, uid, w.email);
      if (!to || !w.id) continue;
      const unsubscribe = `${origin}/watch/unsubscribe?t=${await unsubscribeToken(env.WATCH_SECRET, w.id)}`;
      const mail = digest({ groups, origin, unsubscribe, appName: env.APP_NAME || 'Siren' });
      const fresh = [...new Set(groups.flatMap((g) => g.items.map(sentKey)))];
      await send(env, {
        to,
        ...mail,
        headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        idempotencyKey: `watch-${await hmacHex(env.WATCH_SECRET, `watch-mail:${uid}:${fresh.join(',')}`, 32)}`,
      }, fetchImpl);
      summary.emails++;
      await kv.put(listKey, JSON.stringify([...sent, ...fresh].slice(-MAX_SENT)), { expirationTtl: SENT_DAYS * 86400 });
    } catch {
      summary.errors++;
    }
  }
  await kv.put(stateKey, JSON.stringify(next), { expiration });
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
  badlink: "That link didn't work, or the watch was already deleted. Sign in and check your blocks on this page.",
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
      body += `<div class="card"><h2>Add a block</h2><form class="add" method="post" action="${esc(base)}/watch/add"><label>Any address on the block<input name="address" autocomplete="street-address" maxlength="120" required placeholder="810 Union St"></label><label>Your sign-in email, to send the alerts to<input name="email" type="email" autocomplete="email" maxlength="254" required></label><button type="submit">Watch this block</button></form><p class="small">The address is looked up once and not kept. Your email is kept encrypted, only to send these alerts, until you remove your last block or press "Stop all alerts".</p></div>`;
    }
    if (blocks.length) body += `<div class="card"><form method="post" action="${esc(base)}/watch/delete"><button class="quiet" type="submit">Stop all alerts and delete my email</button></form></div>`;
  }
  body += '<p class="small">I match agenda items by the street address written in their titles, and the email says only what kind of item it is and where; the City\'s record has the rest. Items that name no address (citywide ordinances, budgets) are not matched.</p>';
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
  const html = (body, status = 200) => new Response(body, { status, headers: { ...pageHeaders, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
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
      const id = await tokenWatchId(env.WATCH_SECRET, url.searchParams.get('t'));
      const live = id ? await kv.get(`watch-by-id:${id}`) : null;
      return html(unsubscribePage({ token: live ? url.searchParams.get('t') : '', base, css, message: live ? '' : 'badlink' }), live ? 200 : 400);
    }
    if (req.method !== 'POST') return null;
    const f = await form();
    const id = await tokenWatchId(env.WATCH_SECRET, f.get('t') || url.searchParams.get('t'));
    const uid = id ? await kv.get(`watch-by-id:${id}`) : null;
    if (!uid) return html(unsubscribePage({ token: '', base, css, message: 'badlink' }), 400);
    await deleteWatch(env, uid);
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
    await removeBlock({ env, kv, uid, id: String(f.get('block') || '') });
    return back('removed');
  }
  await deleteWatch(env, uid);
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
