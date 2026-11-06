// Bluesky endorsements on accepted source requests, stored in D1 (the
// SIREN_DB binding; schema in migrations/). Pure helpers that take the
// database, env and the session as arguments, like requests.js.
//
// What D1 holds, and nothing more (migrations/0001_bluesky_endorsements.sql):
//   endorsements(eh, request_id, y, exp): one row per (request, account).
//     eh = HMAC(INVITE_SECRET, "endorsement:" + id12 + ":" + eid), 32 hex;
//     eid = HMAC(INVITE_SECRET, "endorser:" + DID) lives only in the sealed
//     session cookie, so one account's endorsements on different requests
//     share nothing, and no row holds a DID, handle, issuer or token. y is
//     1 (young), 0 (established) or NULL (unknown age); exp is a month
//     boundary ENDORSE_RETENTION_MONTHS + 1 ahead, shared by every
//     endorsement made that month.
//   endorsement_counts: per-request tallies kept exact by triggers, so a
//     count reads one row per request.
//   bsky_rate_counts(k, n, exp): one row per (kind, period, keyed hash),
//     each hash in its own HMAC domain and day- or hour-scoped; no request
//     id and no part of an endorsement id, so it can't be joined to the
//     endorsement rows.
//   bsky_flows_used(sh, exp): single-use markers for finished sign-ins.
// Every table is WITHOUT ROWID (no insertion order). Rows past exp are never
// counted or reported, and are deleted by purgeExpired: daily by the cron
// (purgeAll; the rollout makes it a requirement for switching the flag on),
// and also where the public list and the admin page are computed and after
// endorse, unendorse and sign-in starts. The orphan sweep never runs on a
// person's own action.
//
// Nothing here runs unless BLUESKY_LOGIN is "true" (endorseDb): with the flag
// unset, no D1 call happens anywhere. Every statement is prepared, with bound
// parameters; several writes go in one batch (one transaction, all or
// nothing, and one query against the per-invocation limit).
//
// Endorsements are a signal for the steward, not a vote: counted per
// account, and by default the public number counts only did:plc accounts at
// least ENDORSE_YOUNG_DAYS old.

import { hmacHex, boundary } from './crypto.js';
import { setting } from './limits.js';
import { requestKey, publicId, publicNumber } from './requests.js';

export { publicNumber };

const ID_RE = /^[0-9a-f]{12}$/;
const NOT_FOUND = Object.freeze({ ok: false, status: 404, code: 'not_found', error: 'No open request has that id.' });
const BUSY = Object.freeze({ ok: false, status: 429, code: 'busy', error: "That's a lot of endorsing for one day. Try again tomorrow." });
const BUSY_NOW = Object.freeze({ ok: false, status: 429, code: 'busy', error: 'Lots of endorsing from here right now. Try again in a minute.' });

/** For the operator's log and the steward's page, never shown to the public. */
export const DB_SETUP_ERROR = 'BLUESKY_LOGIN is "true" but the SIREN_DB D1 binding is missing, so Bluesky sign-in and endorsements are off. '
  + 'Create the database, apply migrations/ and add the [[env.siren.d1_databases]] block (docs/bluesky-endorsements.md, "Setting up the database").';

/**
 * The endorsement database: the SIREN_DB binding, only when BLUESKY_LOGIN is
 * "true". Every D1 call in Siren goes through this, so with the flag unset
 * nothing touches D1, and with the flag on and no binding the feature is off.
 */
export function endorseDb(env) {
  if (env?.BLUESKY_LOGIN !== 'true') return null;
  const db = env.SIREN_DB;
  return db && typeof db.prepare === 'function' && typeof db.batch === 'function' ? db : null;
}

/** The flag is on but there's no database: a message for the log and the steward, else null. */
export function dbSetupError(env) {
  return env?.BLUESKY_LOGIN === 'true' && !endorseDb(env) ? DB_SETUP_ERROR : null;
}

/** Thrown when a D1 call fails, so a route can answer 503 instead of a bare 500. */
export class StorageError extends Error {
  constructor(cause) {
    super('storage');
    this.code = 'storage';
    if (cause) this.cause = cause;
  }
}

async function stored(fn) {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof StorageError ? err : new StorageError(err);
  }
}

const slots = (n, from = 1) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(', ');

// D1 allows 100 bound parameters per statement; IN lists leave room for one more.
const CHUNK = 99;
const chunks = (xs, n = CHUNK) => {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Every statement Siren runs against SIREN_DB (a test runs EXPLAIN QUERY PLAN over each). */
export const SQL = Object.freeze({
  get: 'SELECT y FROM endorsements WHERE eh = ?1 AND exp > ?2',
  // A new row, or one whose expiry passed but isn't purged yet; never an unexpired one.
  insert: 'INSERT INTO endorsements (eh, request_id, y, exp) VALUES (?1, ?2, ?3, ?4) '
    + 'ON CONFLICT (eh) DO UPDATE SET y = excluded.y, exp = excluded.exp WHERE endorsements.exp <= ?5',
  // Only toward better knowledge: never from established (0), never to unknown (NULL).
  upgrade: 'UPDATE endorsements SET y = ?1 WHERE eh = ?2 AND exp > ?3 AND y IS NOT 0 AND y IS NOT ?1 RETURNING eh',
  remove: 'DELETE FROM endorsements WHERE eh = ?1',
  bump: 'INSERT INTO bsky_rate_counts (k, n, exp) VALUES (?1, 1, ?2) ON CONFLICT (k) DO UPDATE SET n = n + 1',
  rates: (n) => `SELECT k, n FROM bsky_rate_counts WHERE exp > ?1 AND k IN (${slots(n, 2)})`,
  counts: 'SELECT request_id, n, young, unknown FROM endorsement_counts',
  countOne: 'SELECT n, young, unknown FROM endorsement_counts WHERE request_id = ?1',
  // Rows past their expiry but not yet purged, to take off the tallies: reads only those rows.
  expired: 'SELECT request_id, COUNT(*) AS n, SUM(y IS 1) AS young, SUM(y IS NULL) AS unknown FROM endorsements INDEXED BY endorsements_exp WHERE exp <= ?1 GROUP BY request_id',
  expiredOne: 'SELECT COUNT(*) AS n, SUM(y IS 1) AS young, SUM(y IS NULL) AS unknown FROM endorsements INDEXED BY endorsements_exp WHERE exp <= ?1 AND request_id = ?2',
  requestIds: 'SELECT request_id FROM endorsement_counts',
  endorsedIn: (n) => `SELECT eh FROM endorsements WHERE exp > ?1 AND eh IN (${slots(n, 2)})`,
  upgradeIn: (n) => `UPDATE endorsements SET y = 0 WHERE exp > ?1 AND (y IS NULL OR y = 1) AND eh IN (${slots(n, 2)})`,
  removeIn: (n) => `DELETE FROM endorsements WHERE eh IN (${slots(n, 1)}) RETURNING eh`,
  clear: 'DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements WHERE request_id = ?1 LIMIT ?2) RETURNING eh',
  // Several requests' rows in one statement, at most ?1 rows: the orphan sweep.
  clearIn: (n) => `DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements WHERE request_id IN (${slots(n, 2)}) LIMIT ?1) RETURNING request_id`,
  // Bounded, so a month's cohort expiring in the same second is deleted over
  // a few purges instead of in one statement.
  purgeEndorsements: 'DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements INDEXED BY endorsements_exp WHERE exp <= ?1 LIMIT ?2)',
  purgeRates: 'DELETE FROM bsky_rate_counts WHERE k IN (SELECT k FROM bsky_rate_counts INDEXED BY bsky_rate_counts_exp WHERE exp <= ?1 LIMIT ?2)',
  purgeFlows: 'DELETE FROM bsky_flows_used WHERE sh IN (SELECT sh FROM bsky_flows_used INDEXED BY bsky_flows_used_exp WHERE exp <= ?1 LIMIT ?2)',
  useFlow: 'INSERT INTO bsky_flows_used (sh, exp) VALUES (?1, ?2) ON CONFLICT (sh) DO NOTHING RETURNING sh',
});

export function publicPolicy(env) {
  return env?.ENDORSE_PUBLIC === 'all' ? 'all' : 'established';
}

const youngDays = (env) => setting(env?.ENDORSE_YOUNG_DAYS, 30, { min: 0, max: 3650 });

/** 1 (young), 0 (established) or null (unknown age, e.g. did:web) for an account created on `created`. */
export function youngFlag(created, env, now = Date.now()) {
  if (typeof created !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(created)) return null;
  const t = Date.parse(`${created}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 86400e3 < youngDays(env) ? 1 : 0;
}

const accountDays = (created, now) => {
  const t = typeof created === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(created) ? Date.parse(`${created}T00:00:00Z`) : NaN;
  return Number.isFinite(t) ? (now - t) / 86400e3 : null;
};

const BARE_HTTPS = /^https:\/\/[a-z0-9.-]+$/;

/** Is this issuer exempt from the per-issuer daily cap (ENDORSE_OPEN_ISSUERS)? */
export function openIssuer(issuer, env) {
  const raw = env?.ENDORSE_OPEN_ISSUERS ?? 'https://bsky.social';
  const list = String(raw).split(',').map((s) => s.trim()).filter((s) => {
    if (!BARE_HTTPS.test(s)) return false;
    try {
      return new URL(s).origin === s;
    } catch {
      return false;
    }
  });
  return typeof issuer === 'string' && list.includes(issuer);
}

/** The per-request endorsement id: HMAC(secret, "endorsement:" + id + ":" + eid), 32 hex. */
export async function endorsementId(secret, id, eid) {
  return hmacHex(secret, `endorsement:${id}:${eid}`, 32);
}

const secs = (now) => Math.floor(now / 1000);

/** Map(k -> n) for the given rate-counter keys, unexpired only. One statement. */
export async function readRates(db, keys, now = Date.now()) {
  const out = new Map();
  if (!keys.length) return out;
  const { results } = await db.prepare(SQL.rates(keys.length)).bind(secs(now), ...keys).all();
  for (const r of results || []) out.set(r.k, Number(r.n) || 0);
  return out;
}

/** One rate-counter row's count. */
export async function countRate(db, key, now = Date.now()) {
  return (await readRates(db, [key], now)).get(key) || 0;
}

/** The statement that adds one to a rate counter (for a batch). */
export const bumpRate = (db, key, expiration) => db.prepare(SQL.bump).bind(key, expiration);

/**
 * Claim a single-use marker: true the first time, false on a replay.
 * `expiration` is in seconds.
 */
export async function useFlowOnce(db, marker, expiration) {
  const { results } = await db.prepare(SQL.useFlow).bind(marker, expiration).all();
  return (results || []).length === 1;
}

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false; // a limiter that fails counts as limited
  }
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const eventExpiry = (now) => boundary(now, 'day', 1) + 3600;
const retentionExpiry = (env, now) => boundary(now, 'month', setting(env?.ENDORSE_RETENTION_MONTHS, 12, { min: 1, max: 24 }) + 1);

// Public suffixes of more than one label, where a registrable domain keeps
// one more label than usual: country second-level names (co.uk) and shared
// hosting (github.io), whose tenants are unrelated people. A short list, not
// the Public Suffix List: a suffix missing here only pools its tenants into
// one per-domain bucket, and each tenant still has its own per-server cap.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'geek.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in',
  'co.za', 'org.za', 'net.za', 'co.il', 'org.il', 'co.id', 'or.id', 'web.id',
  'com.br', 'net.br', 'org.br', 'com.mx', 'org.mx', 'com.ar', 'com.co', 'com.pe', 'com.uy',
  'com.cn', 'net.cn', 'org.cn', 'com.tw', 'org.tw', 'com.hk', 'org.hk', 'com.sg', 'org.sg',
  'com.my', 'com.ph', 'com.vn', 'com.tr', 'com.pl', 'com.ua', 'co.ua', 'com.es', 'com.pt',
  'com.gr', 'co.at', 'or.at', 'co.hu', 'com.ng', 'com.eg', 'com.sa', 'co.ke', 'com.pk',
  'github.io', 'gitlab.io', 'codeberg.page', 'fly.dev', 'onrender.com', 'herokuapp.com',
  'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'deno.dev', 'railway.app',
  'web.app', 'firebaseapp.com', 'appspot.com', 'glitch.me', 'repl.co', 'replit.app',
  'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'trycloudflare.com', 'duckdns.org',
  'dynv6.net', 'freemyip.com', 'ddns.net', 'no-ip.org', 'hopto.org', 'zapto.org',
  'tailscale.net', 'ts.net', 'azurewebsites.net', 'cloudapp.net', 'run.app',
  'up.railway.app', 'a.run.app', 'onion.pet', 'nip.io', 'sslip.io',
]);

/** The issuer's host: the bucket the per-server daily cap counts in. */
export function issuerHost(issuer) {
  try {
    return new URL(issuer).hostname;
  } catch {
    return String(issuer);
  }
}

/**
 * The issuer's approximate registrable domain: the last two labels, or one
 * more under a multi-label suffix (MULTI_LABEL_SUFFIXES). The per-domain
 * daily cap and the burst limit count in it, so a1.abc.dev and a2.abc.dev,
 * or a wildcard farm of servers under one domain, share one bucket, while
 * pds1.github.io and pds2.github.io don't.
 */
export function issuerBucket(issuer) {
  const host = issuerHost(issuer);
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  let n = 2;
  for (const k of [3, 2]) {
    if (labels.length > k && MULTI_LABEL_SUFFIXES.has(labels.slice(-k).join('.'))) {
      n = k + 1;
      break;
    }
  }
  return labels.slice(-n).join('.');
}

// The day's rate-counter keys for one action: per account (d), per visitor
// (v), and, for a server not in ENDORSE_OPEN_ISSUERS, per server (i) and per
// registrable domain (r). Each hash in its own domain; none holds a request.
async function rateKeys(env, session, visitor, now) {
  const day = dayOf(now);
  const secret = env.INVITE_SECRET;
  const ih = await hmacHex(secret, `issuer-rate:${day}:${issuerHost(session.issuer)}`, 32);
  const rh = await hmacHex(secret, `domain-rate:${day}:${issuerBucket(session.issuer)}`, 32);
  return {
    rh,
    d: `ed:${day}:${await hmacHex(secret, `endorse-rate:${day}:${session.eid}`, 32)}`,
    v: `ev:${day}:${visitor}`,
    i: `ei:${day}:${ih}`,
    r: `er:${day}:${rh}`,
  };
}

const counted = (env, session, now) => publicPolicy(env) === 'all' || youngFlag(session.created, env, now) === 0;
const countedFlag = (env, y) => publicPolicy(env) === 'all' || y === 0;

// Should a stored age flag be rewritten to `y`, the flag the session now
// carries? Only toward better knowledge: unknown -> young or established,
// young -> established. Never from established, and never to unknown.
// (SQL.upgrade says the same in its WHERE clause.)
const shouldUpgrade = (stored, y) => y !== null && stored !== 0 && stored !== y;

/**
 * Endorse an accepted request. Only ids already on the public list are ever
 * looked up, so new, declined, fulfilled and unknown ids all get the same
 * 404 after the same work (none).
 */
export async function endorse({ kv, db, env, id, session, visitor, publicList, now = Date.now() }) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return NOT_FOUND;
  const r = (publicList?.requests || []).find((x) => x.id === id && x.status === 'accepted');
  if (!r) return NOT_FOUND;
  const key = await requestKey(r.source);
  if (publicId(key) !== id) return NOT_FOUND;
  const cur = await kv.get(key, 'json');
  if (cur?.status !== 'accepted') return NOT_FOUND;

  const minDays = setting(env.ENDORSE_MIN_ACCOUNT_DAYS, 0, { min: 0, max: 3650 });
  if (minDays > 0) {
    const age = accountDays(session.created, now);
    if (age === null || age < minDays) return { ok: false, status: 403, code: 'too_new', error: `Accounts newer than ${minDays} days can't endorse yet.` };
  }

  const y = youngFlag(session.created, env, now);
  const eh = await endorsementId(env.INVITE_SECRET, id, session.eid);
  const existing = await stored(() => db.prepare(SQL.get).bind(eh, secs(now)).first());
  if (existing) {
    // The account has aged past "young", or its age is now known: record it.
    // The expiry is kept. Free, like any repeat. One conditional UPDATE, so a
    // withdrawal in another tab can't be undone by it.
    let flag = existing.y ?? null;
    if (shouldUpgrade(flag, y)) {
      try {
        const { results } = await db.prepare(SQL.upgrade).bind(y, eh, secs(now)).all();
        if (results?.length) flag = y;
        else if (!(await db.prepare(SQL.get).bind(eh, secs(now)).first())) return { ok: true, endorsed: false }; // withdrawn meanwhile
      } catch {
        // Best effort: the next repeat or `me` retries.
      }
    }
    return { ok: true, endorsed: true, already: true, counted: countedFlag(env, flag) };
  }

  // Burst limits first: they're per location and cost no D1 read.
  const k = await rateKeys(env, session, visitor, now);
  const issuerCapped = !openIssuer(session.issuer, env);
  if (!(await allowed(env.BSKY_VISITOR_RL, `end:${visitor}`))) return BUSY_NOW;
  if (issuerCapped && !(await allowed(env.BSKY_INPUT_RL, `iss:${k.rh}`))) return BUSY_NOW;
  const used = await stored(() => readRates(db, issuerCapped ? [k.d, k.v, k.i, k.r] : [k.d, k.v], now));
  if ((used.get(k.d) || 0) >= setting(env.ENDORSE_PER_DID_DAILY, 30, { min: 1 })) return BUSY;
  if ((used.get(k.v) || 0) >= setting(env.ENDORSE_PER_VISITOR_DAILY, 200, { min: 1 })) return BUSY;
  if (issuerCapped && ((used.get(k.i) || 0) >= setting(env.ENDORSE_PER_ISSUER_DAILY, 20, { min: 1 })
    || (used.get(k.r) || 0) >= setting(env.ENDORSE_PER_DOMAIN_DAILY, 60, { min: 1 }))) {
    return { ok: false, status: 429, code: 'busy', error: 'Your Bluesky server has reached its endorsements for today. Try again tomorrow.' };
  }
  if (!(await allowed(env.BSKY_SITE_RL, 'endorse'))) return { ok: false, status: 429, code: 'busy', error: 'Lots of endorsements right now. Try again in a minute.' };

  // The endorsement and its counters in one transaction: a failure writes
  // and charges nothing. A withdraw and a re-endorse charge the server again.
  const exp = eventExpiry(now);
  await stored(() => db.batch([
    db.prepare(SQL.insert).bind(eh, id, y, retentionExpiry(env, now), secs(now)),
    bumpRate(db, k.d, exp),
    bumpRate(db, k.v, exp),
    ...(issuerCapped ? [bumpRate(db, k.i, exp), bumpRate(db, k.r, exp)] : []),
  ]));
  return { ok: true, endorsed: true, counted: counted(env, session, now) };
}

/**
 * Withdraw an endorsement. No request lookup at all: the answer is the same
 * for every well-formed id, and people can always withdraw.
 */
export async function unendorse({ db, env, id, session, visitor, now = Date.now() }) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, status: 400, code: 'bad_id', error: 'Give the request id.' };
  if (!(await allowed(env.BSKY_VISITOR_RL, `end:${visitor}`))) return BUSY_NOW;
  const k = await rateKeys(env, session, visitor, now);
  const used = await stored(() => readRates(db, [k.d, k.v], now));
  if ((used.get(k.d) || 0) >= setting(env.ENDORSE_PER_DID_DAILY, 30, { min: 1 })) return BUSY;
  if ((used.get(k.v) || 0) >= setting(env.ENDORSE_PER_VISITOR_DAILY, 200, { min: 1 })) return BUSY;
  const exp = eventExpiry(now);
  await stored(async () => db.batch([
    db.prepare(SQL.remove).bind(await endorsementId(env.INVITE_SECRET, id, session.eid)),
    bumpRate(db, k.d, exp),
    bumpRate(db, k.v, exp),
  ]));
  return { ok: true, endorsed: false };
}

/**
 * The ids of accepted, public requests this account has endorsed. When the
 * session's account is now established, endorsements stored while it was
 * young (or while its age couldn't be looked up) are rewritten as
 * established in the same batch, keeping their expiry: the page never sends
 * a repeat endorse for an endorsed request, so aging takes effect here, on load.
 */
export async function endorsedBy({ db, env, session, publicList, now = Date.now() }) {
  const ids = (publicList?.requests || []).filter((r) => r.status === 'accepted' && ID_RE.test(r.id)).map((r) => r.id);
  if (!ids.length) return [];
  const ehs = await Promise.all(ids.map((id) => endorsementId(env.INVITE_SECRET, id, session.eid)));
  const t = secs(now);
  const parts = chunks(ehs);
  const upgrades = youngFlag(session.created, env, now) === 0 ? parts.map((p) => db.prepare(SQL.upgradeIn(p.length)).bind(t, ...p)) : [];
  const reads = parts.map((p) => db.prepare(SQL.endorsedIn(p.length)).bind(t, ...p));
  const out = await stored(() => db.batch([...upgrades, ...reads]));
  const found = new Set(out.slice(upgrades.length).flatMap((r) => (r.results || []).map((x) => x.eh)));
  return ids.filter((id, i) => found.has(ehs[i]));
}

/**
 * Delete every endorsement this account made. The ids are computed for every
 * request that has endorsements (from the tallies), so nothing is listed but
 * request ids, and nothing is missed.
 */
export async function forgetEndorser({ db, env, session }) {
  const { results } = await stored(() => db.prepare(SQL.requestIds).all());
  const ids = (results || []).map((r) => r.request_id).filter((id) => ID_RE.test(id));
  if (!ids.length) return { removed: 0 };
  const ehs = await Promise.all(ids.map((id) => endorsementId(env.INVITE_SECRET, id, session.eid)));
  const out = await stored(() => db.batch(chunks(ehs, 100).map((p) => db.prepare(SQL.removeIn(p.length)).bind(...p))));
  return { removed: out.reduce((n, r) => n + (r.results || []).length, 0) };
}

const asCount = (r) => ({ n: Number(r?.n) || 0, young: Number(r?.young) || 0, unknown: Number(r?.unknown) || 0 });

const minus = (a, b) => ({ n: a.n - b.n, young: a.young - b.young, unknown: a.unknown - b.unknown });

/**
 * Map(id -> { n, young, unknown }) over every unexpired endorsement: the
 * tallies (one row per request), less any rows past their expiry that
 * haven't been purged yet. One batch, reads only; purgeExpired deletes.
 */
export async function endorsementCounts(db, { now = Date.now() } = {}) {
  const [tallies, expired] = await stored(() => db.batch([db.prepare(SQL.counts), db.prepare(SQL.expired).bind(secs(now))]));
  const gone = new Map((expired.results || []).map((r) => [r.request_id, asCount(r)]));
  const counts = new Map();
  for (const r of tallies.results || []) {
    if (!ID_RE.test(r.request_id)) continue;
    const c = minus(asCount(r), gone.get(r.request_id) || asCount(null));
    if (c.n > 0) counts.set(r.request_id, c);
  }
  return counts;
}

export async function countFor(db, id, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return asCount(null);
  const [one, expired] = await stored(() => db.batch([db.prepare(SQL.countOne).bind(id), db.prepare(SQL.expiredOne).bind(secs(now), id)]));
  const c = minus(asCount(one.results?.[0]), asCount(expired.results?.[0]));
  return c.n > 0 ? c : asCount(null);
}

// Rows of each kind one purge may delete. A backlog beyond it goes over the
// next purges (the daily cron, list and admin loads, endorse, unendorse and
// sign-in), never in one burst of row writes.
export const PURGE_LIMIT = 500;

/**
 * Delete rows past their expiry, up to `limit` of each kind: endorsements
 * (12 to 13 months), rate counters (about a day) and single-use markers (up
 * to two hours). Run by the daily cron, where the public list or the admin
 * page is computed, and after endorse, unendorse and sign-in starts. It
 * deletes only expired rows, so when it runs says nothing about anyone.
 * The tallies follow by trigger. One batch: one query.
 * -> { endorsements, rates, flows } rows deleted
 */
export async function purgeExpired(db, now = Date.now(), { limit = PURGE_LIMIT } = {}) {
  const t = secs(now);
  const out = await stored(() => db.batch([
    db.prepare(SQL.purgeEndorsements).bind(t, limit),
    db.prepare(SQL.purgeRates).bind(t, limit),
    db.prepare(SQL.purgeFlows).bind(t, limit),
  ]));
  return { endorsements: out[0].meta?.changes || 0, rates: out[1].meta?.changes || 0, flows: out[2].meta?.changes || 0 };
}

/**
 * The daily cron's purge: purgeExpired until nothing expired is left, at most
 * `rounds` batches (well under the Free plan's 50 queries per invocation).
 * -> rows deleted, by kind
 */
export async function purgeAll(db, now = Date.now(), { rounds = 20, limit = PURGE_LIMIT } = {}) {
  const total = { endorsements: 0, rates: 0, flows: 0 };
  for (let i = 0; i < rounds; i++) {
    const out = await purgeExpired(db, now, { limit });
    for (const k of Object.keys(total)) total[k] += out[k];
    if (Object.values(out).every((n) => n < limit)) break;
  }
  return total;
}

/**
 * The ids in `counts` whose endorsements outlived their request's decision:
 * the request is fulfilled or declined (its count is frozen), or gone. Rows
 * written by a location still serving a stale list, after the decision's own
 * clear ran, are missed by it; this finds them where the counts are computed
 * anyway. `new` and `accepted` are left alone: their endorsements are live
 * (a request moved back to new keeps them, like any undecided one).
 */
export function orphanedIds(counts, statuses) {
  const out = [];
  for (const id of counts.keys()) {
    const st = statuses.get(id);
    if (st === undefined || st === 'declined' || st === 'fulfilled') out.push(id);
  }
  return out;
}

// Rows one sweep may delete in all, so a large orphan is spread over a few
// sweeps instead of one invocation's row writes.
export const SWEEP_BUDGET = 100;

/**
 * Clear orphaned endorsements (see orphanedIds), at most `budget` rows, in
 * one statement: one D1 query whatever the number of orphans (the Free plan
 * allows 50 per invocation). The first 99 orphaned ids go in one sweep (D1's
 * 100 bound parameters, less the budget), the rest in the next. Errors are
 * logged, never thrown. -> the orphaned ids
 */
export async function sweepOrphans(db, counts, statuses, { budget = SWEEP_BUDGET } = {}) {
  const ids = orphanedIds(counts, statuses);
  const some = ids.filter((id) => ID_RE.test(id)).slice(0, CHUNK);
  if (some.length && budget > 0) {
    try {
      await stored(() => db.prepare(SQL.clearIn(some.length)).bind(budget, ...some).all());
    } catch (err) {
      console.error('endorsements: orphan sweep failed', err?.cause?.message || err?.message);
    }
  }
  return ids;
}

/** Delete up to `max` of one request's endorsements. -> { cleared, remaining } */
export async function clearRequestEndorsements(db, id, { max = 800 } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { cleared: 0, remaining: 0 };
  const [gone, left] = await stored(() => db.batch([db.prepare(SQL.clear).bind(id, max), db.prepare(SQL.countOne).bind(id)]));
  return { cleared: (gone.results || []).length, remaining: asCount(left.results?.[0]).n };
}
