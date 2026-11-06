// Bluesky endorsements on accepted source requests. Pure helpers that take
// KV, env and the session as arguments, like requests.js.
//
// What KV holds, and nothing more:
//   endorsement:<id12>:<HMAC(INVITE_SECRET, "endorsement:" + id12 + ":" + eid)>
//     value '1', metadata { y: 1 | 0 | null } (young / established / unknown
//     age), expiring on a month boundary ENDORSE_RETENTION_MONTHS + 1 ahead.
//     eid = HMAC(INVITE_SECRET, "endorser:" + DID) lives only in the sealed
//     session cookie, so one account's endorsements on different requests
//     share no key material, and no key holds a DID, handle, issuer or token.
//   endorse-ev:<day>:d|v|i:<hash32>:<uuid>  one key per action, counted by
//     listing (never read-modify-write), in its own HMAC domain, expiring at
//     the end of the day plus an hour, the same for every key of the day.
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

export async function endorsementKey(secret, id, eid) {
  return `endorsement:${id}:${await hmacHex(secret, `endorsement:${id}:${eid}`, 32)}`;
}

async function listAll(kv, prefix, onKey) {
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) onKey(k);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

export async function countEvents(kv, prefix) {
  let n = 0;
  await listAll(kv, prefix, () => {
    n++;
  });
  return n;
}

export async function recordEvent(kv, prefix, expiration) {
  await kv.put(`${prefix}${crypto.randomUUID()}`, '', { expiration });
}

// KV bulk get (up to 100 keys, one operation), with a fallback for runtimes
// that return something other than a Map.
async function bulkGet(kv, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const got = chunk.length ? await kv.get(chunk) : new Map();
    if (got instanceof Map) for (const [k, v] of got) out.set(k, v);
    else for (const k of chunk) out.set(k, await kv.get(k));
  }
  return out;
}

// KV bulk getWithMetadata (up to 100 keys, one operation): Map(key -> { value, metadata }).
async function bulkGetWithMetadata(kv, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const got = chunk.length ? await kv.getWithMetadata(chunk) : new Map();
    if (got instanceof Map) for (const [k, v] of got) out.set(k, v);
    else for (const k of chunk) out.set(k, await kv.getWithMetadata(k));
  }
  return out;
}

const present = (v) => v !== null && v !== undefined;

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

/**
 * The bucket the per-server cap counts in: an approximate registrable domain
 * of the issuer (the last two labels, or three when the second-level label is
 * three characters or fewer, as in co.uk), so a1.evil.dev and a2.evil.dev
 * share one bucket instead of each getting their own.
 */
export function issuerBucket(issuer) {
  let host;
  try {
    host = new URL(issuer).hostname;
  } catch {
    return String(issuer);
  }
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const n = labels[labels.length - 2].length <= 3 ? 3 : 2;
  return labels.slice(-n).join('.');
}

async function prefixes(env, session, visitor, now) {
  const day = dayOf(now);
  const secret = env.INVITE_SECRET;
  const ih = await hmacHex(secret, `issuer-rate:${day}:${issuerBucket(session.issuer)}`, 32);
  return {
    day,
    ih,
    d: `endorse-ev:${day}:d:${await hmacHex(secret, `endorse-rate:${day}:${session.eid}`, 32)}:`,
    v: `endorse-ev:${day}:v:${visitor}:`,
    i: `endorse-ev:${day}:i:${ih}:`,
  };
}

const counted = (env, session, now) => publicPolicy(env) === 'all' || youngFlag(session.created, env, now) === 0;
const countedFlag = (env, y) => publicPolicy(env) === 'all' || y === 0;

// The listed expiration of one endorsement key, so a metadata rewrite keeps
// the month it was made in. A key too new to be listed yet gets this month's.
async function keyExpiration(kv, ekey, env, now) {
  const page = await kv.list({ prefix: ekey, limit: 10 });
  return page.keys.find((k) => k.name === ekey)?.expiration || retentionExpiry(env, now);
}

// Should a stored age flag be rewritten to `y`, the flag the session now
// carries? Only toward better knowledge: unknown -> young or established,
// young -> established. Never from established, and never to unknown.
const shouldUpgrade = (stored, y) => y !== null && stored !== 0 && stored !== y;

/** Thrown when a KV write fails, so the route can answer 503 instead of a bare 500. */
export class StorageError extends Error {
  constructor() {
    super('storage');
    this.code = 'storage';
  }
}

/**
 * Endorse an accepted request. Only ids already on the public list are ever
 * looked up, so new, declined, fulfilled and unknown ids all get the same
 * 404 after the same (zero) KV work.
 */
export async function endorse({ kv, env, id, session, visitor, publicList, now = Date.now() }) {
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
  const ekey = await endorsementKey(env.INVITE_SECRET, id, session.eid);
  const existing = await kv.getWithMetadata(ekey);
  if (present(existing?.value)) {
    // The account has aged past "young", or its age is now known: record it,
    // keeping the original expiration. Free, like any repeat.
    let stored = existing.metadata?.y ?? null;
    if (shouldUpgrade(stored, y)) {
      try {
        await kv.put(ekey, '1', { metadata: { y }, expiration: await keyExpiration(kv, ekey, env, now) });
        stored = y;
      } catch {
        // Best effort (a write to this key in the last second): the next repeat or `me` retries.
      }
    }
    return { ok: true, endorsed: true, already: true, counted: countedFlag(env, stored) };
  }

  // Burst limits first: the daily caps below are KV listings that lag about a
  // minute, so a coordinated burst would pass them. These bindings don't lag.
  const p = await prefixes(env, session, visitor, now);
  const issuerCapped = !openIssuer(session.issuer, env);
  if (!(await allowed(env.BSKY_VISITOR_RL, `end:${visitor}`))) return BUSY_NOW;
  if (issuerCapped && !(await allowed(env.BSKY_INPUT_RL, `iss:${p.ih}`))) return BUSY_NOW;
  if ((await countEvents(kv, p.d)) >= setting(env.ENDORSE_PER_DID_DAILY, 30, { min: 1 })) return BUSY;
  if ((await countEvents(kv, p.v)) >= setting(env.ENDORSE_PER_VISITOR_DAILY, 200, { min: 1 })) return BUSY;
  if (issuerCapped && (await countEvents(kv, p.i)) >= setting(env.ENDORSE_PER_ISSUER_DAILY, 20, { min: 1 })) {
    return { ok: false, status: 429, code: 'busy', error: 'Your Bluesky server has reached its endorsements for today. Try again tomorrow.' };
  }
  if (!(await allowed(env.BSKY_SITE_RL, 'endorse'))) return { ok: false, status: 429, code: 'busy', error: 'Lots of endorsements right now. Try again in a minute.' };

  // The endorsement first, so a failed write charges nothing.
  try {
    await kv.put(ekey, '1', { metadata: { y }, expiration: retentionExpiry(env, now) });
  } catch {
    throw new StorageError();
  }
  const exp = eventExpiry(now);
  // The per-server event is named by (day, request, account), so withdrawing
  // and endorsing again overwrites it instead of using up the server's day.
  const issuerEvent = issuerCapped
    ? kv.put(`${p.i}${await hmacHex(env.INVITE_SECRET, `issuer-ev:${p.day}:${id}:${session.eid}`, 32)}`, '', { expiration: exp })
    : null;
  try {
    await Promise.all([recordEvent(kv, p.d, exp), recordEvent(kv, p.v, exp), ...(issuerEvent ? [issuerEvent] : [])]);
  } catch {
    // The endorsement stands; the bindings above still bound bursts.
    console.error('endorse: event write failed');
  }
  return { ok: true, endorsed: true, counted: counted(env, session, now) };
}

/**
 * Withdraw an endorsement. No request lookup at all: the answer is the same
 * for every well-formed id, and people can always withdraw.
 */
export async function unendorse({ kv, env, id, session, visitor, now = Date.now() }) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, status: 400, code: 'bad_id', error: 'Give the request id.' };
  if (!(await allowed(env.BSKY_VISITOR_RL, `end:${visitor}`))) return BUSY_NOW;
  const p = await prefixes(env, session, visitor, now);
  if ((await countEvents(kv, p.d)) >= setting(env.ENDORSE_PER_DID_DAILY, 30, { min: 1 })) return BUSY;
  if ((await countEvents(kv, p.v)) >= setting(env.ENDORSE_PER_VISITOR_DAILY, 200, { min: 1 })) return BUSY;
  try {
    await kv.delete(await endorsementKey(env.INVITE_SECRET, id, session.eid));
  } catch {
    throw new StorageError();
  }
  const exp = eventExpiry(now);
  try {
    await Promise.all([recordEvent(kv, p.d, exp), recordEvent(kv, p.v, exp)]);
  } catch {
    console.error('unendorse: event write failed');
  }
  return { ok: true, endorsed: false };
}

// At most this many age-flag rewrites per `me` call (each is a list and a
// put); the next call picks up the rest. `me` itself is charged under
// BSKY_ACCOUNT_RL, so this is bounded per account per minute too.
const UPGRADES_PER_CALL = 10;

/**
 * The ids of accepted, public requests this account has endorsed. When the
 * session's account is now established, endorsements stored while it was
 * young (or while its age couldn't be looked up) are rewritten as
 * established, keeping their expiration: the page never sends a repeat
 * endorse for an endorsed request, so aging takes effect here, on load.
 */
export async function endorsedBy({ kv, env, session, publicList, now = Date.now() }) {
  const ids = (publicList?.requests || []).filter((r) => r.status === 'accepted' && ID_RE.test(r.id)).map((r) => r.id);
  const keys = await Promise.all(ids.map((id) => endorsementKey(env.INVITE_SECRET, id, session.eid)));
  const y = youngFlag(session.created, env, now);
  if (y !== 0) {
    const got = await bulkGet(kv, keys);
    return ids.filter((id, i) => present(got.get(keys[i])));
  }
  const got = await bulkGetWithMetadata(kv, keys);
  const found = ids.filter((id, i) => present(got.get(keys[i])?.value));
  const stale = keys.filter((k) => present(got.get(k)?.value) && shouldUpgrade(got.get(k).metadata?.y ?? null, 0)).slice(0, UPGRADES_PER_CALL);
  for (const k of stale) {
    try {
      await kv.put(k, '1', { metadata: { y: 0 }, expiration: await keyExpiration(kv, k, env, now) });
    } catch {
      // Best effort; the next `me` retries.
    }
  }
  return found;
}

/**
 * Delete every endorsement this account made. Keys are computed for every
 * request (not listed), so one made seconds ago is found despite list lag.
 */
export async function forgetEndorser({ kv, env, session }) {
  const ids = new Set();
  await listAll(kv, 'request:', (k) => ids.add(publicId(k.name)));
  const list = [...ids];
  const keys = await Promise.all(list.map((id) => endorsementKey(env.INVITE_SECRET, id, session.eid)));
  const got = await bulkGet(kv, keys);
  const found = keys.filter((k) => present(got.get(k)));
  try {
    await Promise.all(found.map((k) => kv.delete(k)));
  } catch {
    throw new StorageError();
  }
  return { removed: found.length };
}

const tally = (map, id, metadata) => {
  const c = map.get(id) || { n: 0, young: 0, unknown: 0 };
  c.n++;
  if (metadata?.y === 1) c.young++;
  else if (metadata?.y == null) c.unknown++;
  map.set(id, c);
};

/** Map(id -> { n, young, unknown }) over every endorsement, in one paginated listing. */
export async function endorsementCounts(kv) {
  const counts = new Map();
  await listAll(kv, 'endorsement:', (k) => {
    const m = /^endorsement:([0-9a-f]{12}):[0-9a-f]{32}$/.exec(k.name);
    if (m) tally(counts, m[1], k.metadata);
  });
  return counts;
}

export async function countFor(kv, id) {
  const counts = new Map();
  if (typeof id === 'string' && ID_RE.test(id)) {
    await listAll(kv, `endorsement:${id}:`, (k) => tally(counts, id, k.metadata));
  }
  return counts.get(id) || { n: 0, young: 0, unknown: 0 };
}

/**
 * The ids in `counts` whose endorsements outlived their request's decision:
 * the request is fulfilled or declined (its count is frozen), or gone. Keys
 * written in the minute before a decision, or by a location still serving a
 * stale list, are missed by the decision's own clear; this finds them where
 * the counts are computed anyway. `new` and `accepted` are left alone: their
 * endorsements are live (a request moved back to new keeps them, like any
 * undecided one).
 */
export function orphanedIds(counts, statuses) {
  const out = [];
  for (const id of counts.keys()) {
    const st = statuses.get(id);
    if (st === undefined || st === 'declined' || st === 'fulfilled') out.push(id);
  }
  return out;
}

/** Clear orphaned endorsements (see orphanedIds); errors are logged, never thrown. */
export async function sweepOrphans(kv, counts, statuses) {
  const ids = orphanedIds(counts, statuses);
  for (const id of ids) {
    try {
      await clearRequestEndorsements(kv, id);
    } catch (err) {
      console.error('endorsements: orphan sweep failed', err?.message);
    }
  }
  return ids;
}

/** Delete up to `max` of one request's endorsement keys. -> { cleared, remaining } */
export async function clearRequestEndorsements(kv, id, { max = 800 } = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { cleared: 0, remaining: 0 };
  const names = [];
  await listAll(kv, `endorsement:${id}:`, (k) => names.push(k.name));
  const doomed = names.slice(0, max);
  for (let i = 0; i < doomed.length; i += 50) await Promise.all(doomed.slice(i, i + 50).map((k) => kv.delete(k)));
  return { cleared: doomed.length, remaining: names.length - doomed.length };
}
