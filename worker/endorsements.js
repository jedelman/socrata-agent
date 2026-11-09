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
//   siren_d1_budget(day, pot, calls, writes, exp): Siren's daily D1 budget
//     (chargeD1), a date, a pot and two numbers.
// Every table is WITHOUT ROWID (no insertion order). Rows past exp are
// deleted by purgeExpired, run by the daily cron (purgeAll; the rollout makes
// it a requirement for switching the flag on). A person's own action never
// carries a purge or the orphan sweep. With the flag off, the steward's
// `node scripts/invites.js endorsements-purge` keeps deletion going.
//
// The account's D1 limits are shared with Scout (docs/bluesky-endorsements.md,
// "Siren's worst case on the account's D1"). So nothing before a finished
// sign-in touches D1 (login starts and the callback make no D1 call), every
// D1 call a visitor can cause is behind a Rate Limiting binding that runs
// first, and every D1 write is charged, before it happens, to a daily budget
// with a fixed ceiling (chargeD1). A refused charge writes nothing.
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
import { requestKey, publicNumber, currentId } from './requests.js';

export { publicNumber };

const ID_RE = /^(?:[0-9a-f]{12}|[a-z2-7]{16})$/;
const NOT_FOUND = Object.freeze({ ok: false, status: 404, code: 'not_found', error: 'No open request has that id.' });
const BUSY = Object.freeze({ ok: false, status: 429, code: 'busy', error: "That's a lot of endorsing for one day. Try again tomorrow." });
const BUSY_NOW = Object.freeze({ ok: false, status: 429, code: 'busy', error: 'Lots of endorsing from here right now. Try again in a minute.' });
const SITE_BUSY = Object.freeze({ ok: false, status: 429, code: 'busy', error: 'Lots of endorsements right now. Try again in a minute.' });
/** The day's D1 budget is spent: nothing was read past the charge, nothing written. */
export const OVER_BUDGET = Object.freeze({ ok: false, status: 503, code: 'over_budget', error: "Endorsing is paused until midnight UTC: the site has used today's share of its database. Nothing was changed." });

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
  // The tallies, one row per request. Rows past their expiry stay in them
  // until the daily purge deletes those rows: subtracting them here would
  // read every expired row on every count.
  counts: 'SELECT request_id, n, young, unknown FROM endorsement_counts',
  countOne: 'SELECT n, young, unknown FROM endorsement_counts WHERE request_id = ?1',
  requestIds: 'SELECT request_id FROM endorsement_counts',
  upgradeIn: (n) => `UPDATE endorsements SET y = 0 WHERE exp > ?1 AND (y IS NULL OR y = 1) AND eh IN (${slots(n, 2)})`,
  // `me`: one SELECT for this account's endorsements among the accepted requests.
  mine: (n) => `SELECT eh, y FROM endorsements WHERE exp > ?1 AND eh IN (${slots(n, 2)})`,
  removeIn: (n) => `DELETE FROM endorsements WHERE eh IN (${slots(n, 1)}) RETURNING eh`,
  clear: 'DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements WHERE request_id = ?1 LIMIT ?2) RETURNING eh',
  // Several requests' rows in one statement, at most ?1 rows: the orphan sweep.
  clearIn: (n) => `DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements WHERE request_id IN (${slots(n, 2)}) LIMIT ?1) RETURNING request_id`,
  // Bounded, so a month's cohort expiring in the same second is deleted over
  // a few purges instead of in one statement.
  purgeEndorsements: 'DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements INDEXED BY endorsements_exp WHERE exp <= ?1 LIMIT ?2) RETURNING eh',
  purgeRates: 'DELETE FROM bsky_rate_counts WHERE k IN (SELECT k FROM bsky_rate_counts INDEXED BY bsky_rate_counts_exp WHERE exp <= ?1 LIMIT ?2) RETURNING k',
  // Past days' budget rows (at most two a day; the table stays tiny).
  purgeBudget: 'DELETE FROM siren_d1_budget WHERE exp <= ?1 RETURNING day',
  // What one purge would delete, at most ?2 of each kind: reads only those rows.
  expiredCounts: 'SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM endorsements INDEXED BY endorsements_exp WHERE exp <= ?1 LIMIT ?2)) AS e, '
    + '(SELECT COUNT(*) FROM (SELECT 1 FROM bsky_rate_counts INDEXED BY bsky_rate_counts_exp WHERE exp <= ?1 LIMIT ?2)) AS r, '
    + '(SELECT COUNT(*) FROM siren_d1_budget WHERE exp <= ?1) AS b',
  // Add to today's budget row only if both caps still hold, in one statement:
  // D1 runs statements one at a time, so two charges can't both take the last
  // of a cap. No row returned means refused, and nothing was written.
  charge: 'INSERT INTO siren_d1_budget (day, pot, calls, writes, exp) SELECT ?1, ?2, ?3, ?4, ?5 WHERE ?3 <= ?6 AND ?4 <= ?7 '
    + 'ON CONFLICT (day, pot) DO UPDATE SET calls = calls + excluded.calls, writes = writes + excluded.writes '
    + 'WHERE calls + excluded.calls <= ?6 AND writes + excluded.writes <= ?7 RETURNING calls, writes',
});

// ---- Siren's daily D1 budget ---------------------------------------------
//
// D1's Free limits are the whole account's, Scout's included, and a Rate
// Limiting binding can't count below one per minute per location, so writes
// are bounded by a daily count instead: every D1 write Siren makes is charged
// first to today's row in siren_d1_budget, in one conditional statement that
// refuses past the cap and then writes nothing. The caps' ceilings sum to
// 5,000 rows a day, 5% of the Free plan's 100,000. The visitor and list pots
// also count calls, which bounds the rows they read (docs/bluesky-endorsements.md
// has the arithmetic): the list pot is how the public list's counts are
// bounded each day without leaning on KV's daily list operations running out.
// Every visitor call and list computation reaches chargeD1 only after the
// Rate Limiting bindings, so a refused charge costs about two rows read.

/**
 * Rows a statement can write, at most, as D1 counts rows_written: the table
 * row, each index entry it touches, and the tally trigger's write (measured
 * on local D1, wrangler 4.147, 2026-11-06; see the doc's table). Upper
 * bounds, so the budget overcounts rather than under.
 */
export const ROWS = Object.freeze({
  budget: 1, // the siren_d1_budget row a charge adds to (primary key only)
  endorsement: 5, // an endorsement inserted, re-made or deleted: row, two index entries, tally row
  counter: 2, // a rate counter created or deleted: row and its exp index entry
  upgrade: 2, // an age-flag rewrite: the row (y has no index) and its tally
});

/** The upkeep pot: the cron's purge, the orphan sweep and the steward's clears. Fixed. */
export const UPKEEP = Object.freeze({ calls: 200, writes: 2200 });
/**
 * The list pot: one charge (the budget row) per public list computation that
 * asks D1 for counts, each then reading N + 1 rows. Fixed. Refused, the list
 * is served without counts.
 */
export const LIST = Object.freeze({ calls: 400, writes: 400 });
/** Ceilings on the visitor pot's settings, so no config takes Siren past 5% of the Free limits (the doc's worst case). */
export const VISITOR_MAX = Object.freeze({ calls: 350, writes: 2400 });

/** { visitor: { calls, writes }, upkeep: { calls, writes }, list: { calls, writes } } per UTC day. */
export function budgetCaps(env) {
  return {
    visitor: {
      calls: setting(env?.ENDORSE_D1_CALLS_DAILY, 300, { min: 1, max: VISITOR_MAX.calls }),
      writes: setting(env?.ENDORSE_D1_WRITES_DAILY, VISITOR_MAX.writes, { min: 1, max: VISITOR_MAX.writes }),
    },
    upkeep: { ...UPKEEP },
    list: { ...LIST },
  };
}

/**
 * Charge `calls` calls and `writes` rows to today's `pot` ('visitor',
 * 'upkeep' or 'list'). -> true if granted; false if a cap would be passed (nothing
 * written). Throws StorageError if D1 fails. `writes` includes the budget
 * row itself (ROWS.budget).
 */
export async function chargeD1(db, env, { pot, calls = 0, writes, now = Date.now() }) {
  const caps = budgetCaps(env)[pot];
  if (!caps) throw new Error(`Unknown budget pot ${pot}`);
  const { results } = await stored(() => db.prepare(SQL.charge).bind(dayOf(now), pot, calls, writes, eventExpiry(now), caps.calls, caps.writes).all());
  return (results || []).length === 1;
}

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

/** The statement that adds one to a rate counter (for a batch). */
export const bumpRate = (db, key, expiration) => db.prepare(SQL.bump).bind(key, expiration);

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
 *
 * Before any D1 call: the per-visitor, per-domain (non-open servers),
 * site-wide and D1 limiters, then the day's budget for the most this action
 * can write. A repeat or a refusal still spends its share; the budget
 * overcounts rather than under.
 */
export async function endorse({ kv, db, env, id, session, visitor, publicList, now = Date.now() }) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return NOT_FOUND;
  const r = (publicList?.requests || []).find((x) => x.id === id && x.status === 'accepted');
  if (!r) return NOT_FOUND;
  const key = await requestKey(r.source);
  if ((await currentId(kv, r.source)) !== id) return NOT_FOUND;
  const cur = await kv.get(key, 'json');
  if (cur?.status !== 'accepted') return NOT_FOUND;

  const minDays = setting(env.ENDORSE_MIN_ACCOUNT_DAYS, 0, { min: 0, max: 3650 });
  if (minDays > 0) {
    const age = accountDays(session.created, now);
    if (age === null || age < minDays) return { ok: false, status: 403, code: 'too_new', error: `Accounts newer than ${minDays} days can't endorse yet.` };
  }

  const y = youngFlag(session.created, env, now);
  const eh = await endorsementId(env.INVITE_SECRET, id, session.eid);
  const k = await rateKeys(env, session, visitor, now);
  const issuerCapped = !openIssuer(session.issuer, env);
  // Limiters first: no D1 call for anything they refuse.
  if (!(await allowed(env.BSKY_VISITOR_RL, `end:${visitor}`))) return BUSY_NOW;
  if (issuerCapped && !(await allowed(env.BSKY_INPUT_RL, `iss:${k.rh}`))) return BUSY_NOW;
  if (!(await allowed(env.BSKY_SITE_RL, 'endorse'))) return SITE_BUSY;
  if (!(await allowed(env.BSKY_D1_RL, 'signed'))) return SITE_BUSY;
  // The most this can write: the endorsement and a new row for each counter
  // (an age-flag rewrite on a repeat writes less).
  const writes = ROWS.budget + ROWS.endorsement + ROWS.counter * (issuerCapped ? 4 : 2);
  if (!(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes, now }))) return OVER_BUDGET;

  const t = secs(now);
  const keys = issuerCapped ? [k.d, k.v, k.i, k.r] : [k.d, k.v];
  // One read: this endorsement and the day's counters.
  const [got, rates] = await stored(() => db.batch([db.prepare(SQL.get).bind(eh, t), db.prepare(SQL.rates(keys.length)).bind(t, ...keys)]));
  const existing = got.results?.[0];
  if (existing) {
    // The account has aged past "young", or its age is now known: record it.
    // The expiry is kept. One conditional UPDATE, so a withdrawal in another
    // tab can't be undone by it.
    let flag = existing.y ?? null;
    if (shouldUpgrade(flag, y)) {
      try {
        const { results } = await db.prepare(SQL.upgrade).bind(y, eh, t).all();
        if (results?.length) flag = y;
        else if (!(await db.prepare(SQL.get).bind(eh, t).first())) return { ok: true, endorsed: false }; // withdrawn meanwhile
      } catch {
        // Best effort: the next repeat or `me` retries.
      }
    }
    return { ok: true, endorsed: true, already: true, counted: countedFlag(env, flag) };
  }

  const used = new Map((rates.results || []).map((x) => [x.k, Number(x.n) || 0]));
  if ((used.get(k.d) || 0) >= setting(env.ENDORSE_PER_DID_DAILY, 30, { min: 1 })) return BUSY;
  if ((used.get(k.v) || 0) >= setting(env.ENDORSE_PER_VISITOR_DAILY, 200, { min: 1 })) return BUSY;
  if (issuerCapped && ((used.get(k.i) || 0) >= setting(env.ENDORSE_PER_ISSUER_DAILY, 20, { min: 1 })
    || (used.get(k.r) || 0) >= setting(env.ENDORSE_PER_DOMAIN_DAILY, 60, { min: 1 }))) {
    return { ok: false, status: 429, code: 'busy', error: 'Your Bluesky server has reached its endorsements for today. Try again tomorrow.' };
  }

  // The endorsement and its counters in one transaction: a failure writes
  // and charges nothing. A withdraw and a re-endorse charge the server again.
  const exp = eventExpiry(now);
  await stored(() => db.batch([
    db.prepare(SQL.insert).bind(eh, id, y, retentionExpiry(env, now), t),
    bumpRate(db, k.d, exp),
    bumpRate(db, k.v, exp),
    ...(issuerCapped ? [bumpRate(db, k.i, exp), bumpRate(db, k.r, exp)] : []),
  ]));
  return { ok: true, endorsed: true, counted: counted(env, session, now) };
}

/**
 * Withdraw an endorsement. No request lookup at all: the answer is the same
 * for every well-formed id, and people can always withdraw (within the
 * day's budget).
 */
export async function unendorse({ db, env, id, session, visitor, now = Date.now() }) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, status: 400, code: 'bad_id', error: 'Give the request id.' };
  if (!(await allowed(env.BSKY_VISITOR_RL, `end:${visitor}`))) return BUSY_NOW;
  if (!(await allowed(env.BSKY_D1_RL, 'signed'))) return SITE_BUSY;
  if (!(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: ROWS.budget + ROWS.endorsement + 2 * ROWS.counter, now }))) return OVER_BUDGET;
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

/** The most requests `me` looks up, in one SELECT (D1 allows 100 bound parameters). */
export const ME_MAX = CHUNK;

/**
 * The ids of accepted, public requests this account has endorsed, among the
 * first ME_MAX on the list: one SELECT. When the session's account is now
 * established, endorsements stored while it was young (or while its age
 * couldn't be looked up) are rewritten as established, keeping their
 * expiry, in a second statement run only when some need it, and only if the
 * budget allows (otherwise the next load tries again): the page never sends
 * a repeat endorse for an endorsed request, so aging takes effect here.
 * The caller has passed the limiters; this charges the budget.
 * -> { ok: true, endorsed } | OVER_BUDGET
 */
export async function endorsedBy({ db, env, session, publicList, now = Date.now() }) {
  const ids = (publicList?.requests || []).filter((r) => r.status === 'accepted' && ID_RE.test(r.id)).map((r) => r.id).slice(0, ME_MAX);
  if (!ids.length) return { ok: true, endorsed: [] };
  if (!(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: ROWS.budget, now }))) return OVER_BUDGET;
  const ehs = await Promise.all(ids.map((id) => endorsementId(env.INVITE_SECRET, id, session.eid)));
  const t = secs(now);
  const { results } = await stored(() => db.prepare(SQL.mine(ehs.length)).bind(t, ...ehs).all());
  const rows = results || [];
  if (youngFlag(session.created, env, now) === 0) {
    const stale = rows.filter((x) => x.y !== 0).map((x) => x.eh);
    if (stale.length) {
      try {
        if (await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: ROWS.budget + ROWS.upgrade * stale.length, now })) {
          await db.prepare(SQL.upgradeIn(stale.length)).bind(t, ...stale).run();
        }
      } catch {
        // Best effort: the next load retries.
      }
    }
  }
  const found = new Set(rows.map((x) => x.eh));
  return { ok: true, endorsed: ids.filter((id, i) => found.has(ehs[i])) };
}

/**
 * Delete every endorsement this account made. The ids are computed for every
 * request that has endorsements (from the tallies), so nothing is listed but
 * request ids, and nothing is missed. Two calls, each charged before it
 * runs: one to read the request ids, then the delete, with the rows it can
 * write.
 * -> { ok: true, removed } | OVER_BUDGET
 */
export async function forgetEndorser({ db, env, session, now = Date.now() }) {
  if (!(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: ROWS.budget, now }))) return OVER_BUDGET;
  const { results } = await stored(() => db.prepare(SQL.requestIds).all());
  const ids = (results || []).map((r) => r.request_id).filter((id) => ID_RE.test(id));
  if (!ids.length) return { ok: true, removed: 0 };
  if (!(await chargeD1(db, env, { pot: 'visitor', calls: 1, writes: ROWS.budget + ROWS.endorsement * ids.length, now }))) return OVER_BUDGET;
  const ehs = await Promise.all(ids.map((id) => endorsementId(env.INVITE_SECRET, id, session.eid)));
  const out = await stored(() => db.batch(chunks(ehs, 100).map((p) => db.prepare(SQL.removeIn(p.length)).bind(...p))));
  return { ok: true, removed: out.reduce((n, r) => n + (r.results || []).length, 0) };
}

const asCount = (r) => ({ n: Number(r?.n) || 0, young: Number(r?.young) || 0, unknown: Number(r?.unknown) || 0 });

/**
 * Map(id -> { n, young, unknown }) from the tallies: one row per request with
 * endorsements, one statement, reads only. Rows past their expiry count until
 * the daily purge deletes them (at most about a day; longer only while the
 * upkeep budget is spent).
 */
export async function endorsementCounts(db) {
  const { results } = await stored(() => db.prepare(SQL.counts).all());
  const counts = new Map();
  for (const r of results || []) {
    if (!ID_RE.test(r.request_id)) continue;
    const c = asCount(r);
    if (c.n > 0) counts.set(r.request_id, c);
  }
  return counts;
}

export async function countFor(db, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return asCount(null);
  const c = asCount(await stored(() => db.prepare(SQL.countOne).bind(id).first()));
  return c.n > 0 ? c : asCount(null);
}

// Rows of each kind one purge may delete. A backlog beyond it goes over the
// next rounds and days, never in one burst of row writes.
export const PURGE_LIMIT = 200;

/**
 * Delete rows past their expiry, up to `limit` of each kind: endorsements
 * (12 to 13 months), rate counters (about a day) and past days' budget rows.
 * It deletes only expired rows, so when it runs says nothing about anyone.
 * The tallies follow by trigger. First a read of how many rows are due (at
 * most `limit` of each), then the upkeep budget is charged for exactly those
 * rows, then one batch deletes them. If the budget can't cover them, nothing
 * is deleted and `deferred` is set.
 * -> { endorsements, rates, budget, deferred } rows deleted, counted by
 * RETURNING (D1's meta.changes also counts the trigger's writes).
 */
export async function purgeExpired(db, env, now = Date.now(), { limit = PURGE_LIMIT } = {}) {
  const t = secs(now);
  const due = await stored(() => db.prepare(SQL.expiredCounts).bind(t, limit).first());
  const e = Number(due?.e) || 0;
  const r = Number(due?.r) || 0;
  const b = Number(due?.b) || 0;
  const none = { endorsements: 0, rates: 0, budget: 0, deferred: false };
  if (!e && !r && !b) return none;
  const writes = ROWS.budget + ROWS.endorsement * e + ROWS.counter * r + ROWS.budget * b;
  if (!(await chargeD1(db, env, { pot: 'upkeep', calls: 1, writes, now }))) return { ...none, deferred: true };
  const out = await stored(() => db.batch([
    db.prepare(SQL.purgeEndorsements).bind(t, e),
    db.prepare(SQL.purgeRates).bind(t, r),
    db.prepare(SQL.purgeBudget).bind(t),
  ]));
  const n = (x) => (x.results || []).length;
  return { endorsements: n(out[0]), rates: n(out[1]), budget: n(out[2]), deferred: false };
}

/**
 * The daily cron's purge: purgeExpired until nothing expired is left, at most
 * `rounds` rounds of three queries (well under the Free plan's 50 queries
 * per invocation). When the upkeep budget can't cover a round, it retries
 * with a quarter of the limit, and stops when even a one-row round is
 * refused (or the rounds run out): the rest waits for tomorrow's budget.
 * -> rows deleted, by kind, and whether some were left for lack of budget
 */
export async function purgeAll(db, env, now = Date.now(), { rounds = 12, limit = PURGE_LIMIT } = {}) {
  const total = { endorsements: 0, rates: 0, budget: 0, deferred: false };
  let size = limit;
  for (let i = 0; i < rounds; i++) {
    const out = await purgeExpired(db, env, now, { limit: size });
    if (out.deferred) {
      if (size <= 1) break;
      size = Math.max(1, Math.floor(size / 4));
      continue;
    }
    for (const k of ['endorsements', 'rates', 'budget']) total[k] += out[k];
    if (out.endorsements < size && out.rates < size) return total;
  }
  // The rounds ran out with rows still due (or the last was refused): tomorrow's run continues.
  total.deferred = true;
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
 * 100 bound parameters, less the budget), the rest in the next. The upkeep
 * budget is charged first for the rows the tallies say are there; refused,
 * nothing is deleted and the next sweep tries again. Errors are logged,
 * never thrown. -> the orphaned ids
 */
export async function sweepOrphans(db, env, counts, statuses, { budget = SWEEP_BUDGET, now = Date.now() } = {}) {
  const ids = orphanedIds(counts, statuses);
  const some = ids.filter((id) => ID_RE.test(id)).slice(0, CHUNK);
  const rows = Math.min(budget, some.reduce((n, id) => n + (counts.get(id)?.n || 0), 0));
  if (some.length && rows > 0) {
    try {
      if (await chargeD1(db, env, { pot: 'upkeep', calls: 1, writes: ROWS.budget + ROWS.endorsement * rows, now })) {
        await stored(() => db.prepare(SQL.clearIn(some.length)).bind(rows, ...some).all());
      }
    } catch (err) {
      console.error('endorsements: orphan sweep failed', err?.cause?.message || err?.message);
    }
  }
  return ids;
}

/**
 * Delete up to `max` of one request's endorsements, charged to the upkeep
 * budget first. -> { cleared, remaining, deferred } (deferred: the budget
 * couldn't cover it, nothing deleted; the orphan sweep or a later clear will)
 */
export async function clearRequestEndorsements(db, env, id, { max = 400, now = Date.now() } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { cleared: 0, remaining: 0, deferred: false };
  const have = asCount(await stored(() => db.prepare(SQL.countOne).bind(id).first())).n;
  const rows = Math.min(max, have);
  if (rows <= 0) return { cleared: 0, remaining: 0, deferred: false };
  if (!(await chargeD1(db, env, { pot: 'upkeep', calls: 1, writes: ROWS.budget + ROWS.endorsement * rows, now }))) return { cleared: 0, remaining: have, deferred: true };
  const [gone, left] = await stored(() => db.batch([db.prepare(SQL.clear).bind(id, rows), db.prepare(SQL.countOne).bind(id)]));
  return { cleared: (gone.results || []).length, remaining: asCount(left.results?.[0]).n, deferred: false };
}
