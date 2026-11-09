// Who endorsed one request: GET <base>/api/requests/<id>/endorsers?cursor=,
// for a request on the public list only (docs/bluesky-endorsements.md,
// "The endorser list"). Public by Jason's direction (2026-11-09): each
// endorser's handle, display name, the day endorsed and any flags. A flag is
// shown, never used to exclude; the count stays the plain number of accounts.
//
// Every listed account comes from Constellation, which is untrusted: before
// an account is shown, its record is fetched from its own PDS, unsigned
// (com.atproto.repo.getRecord, then one page of listRecords for records other
// tools wrote under another key). An account whose record isn't there is
// dropped from the page and counted in `dropped` ("index out of date").
// Record text is never shown; only its createdAt, as a day. Handles and
// display names come from the public AppView, stripped of control and bidi
// characters and capped; the page escapes them.
//
// No people-finding: the list is per request, in Constellation's order, with
// no search, sort or filter by person and no "endorsements by this account"
// route anywhere. The only query parameter read is the cursor.

import { safeFetch, safeUrl, normalizeHandle, resolveDidDoc, docPds } from './atproto-identity.js';
import { backlinkDids, constellationOrigin, validCursor, userAgent } from './constellation.js';
import { ENDORSE_NSID, BLUESKY_MODERATION_DID, MODERATION_FLAGS, endorseSubject, endorses, endorsedDay, capText } from './endorse-config.js';
import { PUBLIC_ID_RE } from './requests.js';
import { mapLimit, cachedPublicList } from './public-list.js';
import { blueskyReady } from './bluesky.js';
import { publicOrigin } from './atproto-oauth.js';
import { setting, visitorId } from './limits.js';
import { hmacHex } from './crypto.js';

export const APPVIEW_DEFAULT = 'https://public.api.bsky.app';
export const PAGE = 25; // getProfiles takes at most 25 actors
export const PAGE_SECONDS = 300;
export const PDS_SECONDS = 3600;
const VERIFY_CONCURRENCY = 6;
const MAX_LABELS = 100;

export class EndorsersError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EndorsersError';
    this.code = code;
  }
}

/** The AppView's origin: APPVIEW_URL if it's a bare https origin, else Bluesky's public one. null if set but unsafe. */
export function appviewOrigin(env) {
  const s = env?.APPVIEW_URL;
  if (s === undefined || s === '') return APPVIEW_DEFAULT;
  const u = safeUrl(s);
  return u && (u.pathname === '/' || u.pathname === '') && !u.search && (s === u.origin || s === `${u.origin}/`) ? u.origin : null;
}

// Control characters, and the bidi marks and overrides that can reorder the
// text around them.
const STRIP = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** A display name as the page may show it: stripped, trimmed, at most 64 graphemes; '' if nothing is left. */
export function cleanName(s) {
  if (typeof s !== 'string') return '';
  return capText(s.slice(0, 2048).replace(STRIP, '').replace(/\s+/g, ' ').trim(), 64, 640);
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * app.bsky.actor.getProfiles for up to 25 DIDs, asking for Bluesky's
 * moderation labels explicitly. -> Map(did -> {handle, displayName, labels,
 * createdAt}) for the DIDs asked about only. Throws EndorsersError('unavailable').
 */
export async function getProfiles(dids, { origin, fetchImpl = fetch, ua } = {}) {
  if (!dids.length) return new Map();
  if (dids.length > PAGE || !origin) throw new EndorsersError('unavailable');
  const u = new URL('/xrpc/app.bsky.actor.getProfiles', origin);
  for (const d of dids) u.searchParams.append('actors', d);
  let res;
  try {
    res = await safeFetch(u.href, { fetchImpl, maxBytes: 262144, headers: { Accept: 'application/json', 'atproto-accept-labelers': BLUESKY_MODERATION_DID, ...(ua ? { 'User-Agent': ua } : {}) } });
  } catch {
    throw new EndorsersError('unavailable');
  }
  const body = res.status === 200 ? parse(res.text) : null;
  if (!body || !Array.isArray(body.profiles)) throw new EndorsersError('unavailable');
  const asked = new Set(dids);
  const out = new Map();
  for (const p of body.profiles.slice(0, PAGE)) {
    if (!p || typeof p !== 'object' || !asked.has(p.did) || out.has(p.did)) continue;
    const labels = (Array.isArray(p.labels) ? p.labels.slice(0, MAX_LABELS) : [])
      .filter((l) => l && typeof l.src === 'string' && typeof l.val === 'string' && l.val.length <= 128)
      .map((l) => ({ src: l.src, val: l.val, neg: l.neg === true }));
    out.set(p.did, {
      handle: typeof p.handle === 'string' ? normalizeHandle(p.handle) : null,
      displayName: cleanName(p.displayName),
      labels,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : null,
    });
  }
  return out;
}

/** The young-account threshold in days (ENDORSE_YOUNG_DAYS, default 30). */
export const youngDays = (env) => setting(env?.ENDORSE_YOUNG_DAYS, 30, { min: 0, max: 3650 });

/**
 * The flags for one endorser, each {kind, reason}: shown, never used to
 * exclude (Jason, 2026-11-09). `profile` is from getProfiles, or undefined.
 */
export function flagsFor(did, profile, { now = Date.now(), young = 30 } = {}) {
  if (!profile) return [{ kind: 'no-profile', reason: 'No Bluesky profile found' }];
  const flags = [];
  // Bluesky's bot label is a self-label: it counts only from the account itself.
  if (profile.labels.some((l) => l.val === 'bot' && l.src === did && !l.neg)) {
    flags.push({ kind: 'bot', reason: "Marked as a bot by the account (Bluesky's bot label)" });
  }
  // Moderation labels count only from Bluesky's own labeler (D13 values, default, pending Jason).
  const mod = [...new Set(profile.labels.filter((l) => l.src === BLUESKY_MODERATION_DID && !l.neg && MODERATION_FLAGS.includes(l.val)).map((l) => l.val))];
  for (const val of mod) flags.push({ kind: 'moderation', reason: `Labelled '${val}' by Bluesky moderation` });
  const created = profile.createdAt && /^\d{4}-\d{2}-\d{2}T/.test(profile.createdAt) ? Date.parse(profile.createdAt) : NaN;
  if (!Number.isFinite(created) || created > now + 86400e3) {
    flags.push({ kind: 'age-unknown', reason: 'Account age unknown' });
  } else {
    const days = Math.max(0, Math.floor((now - created) / 86400e3));
    if (days < young) flags.push({ kind: 'new', reason: `Account created ${days} day${days === 1 ? '' : 's'} ago` });
  }
  return flags;
}

const defaultCache = () => (typeof caches !== 'undefined' && caches?.default ? caches.default : null);

/** DID -> its PDS origin, from its DID document (cached an hour), or null. */
async function pdsFor(did, { env, fetchImpl, cache, cacheBase }) {
  const key = cache ? new Request(`${cacheBase}/__cache/did-pds-v1/${encodeURIComponent(did)}`) : null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      const v = hit ? await hit.text() : null;
      if (v && safeUrl(v)) return v;
    } catch {
      // miss
    }
  }
  let pds = null;
  try {
    pds = docPds(await resolveDidDoc(did, { fetchImpl, plcUrl: env.PLC_URL || 'https://plc.directory' }));
  } catch {
    pds = null;
  }
  if (pds && cache) await cache.put(key, new Response(pds, { headers: { 'Cache-Control': `public, max-age=${PDS_SECONDS}` } })).catch(() => {});
  return pds;
}

/**
 * Whether this account's own PDS holds an endorsement of `subject`: the
 * record under rkey = the request id first, then one page of listRecords
 * (records another tool wrote under another key). -> { found, day }.
 */
export async function verifyEndorser(did, { env, subject, id, fetchImpl = fetch, cache = null, cacheBase = '' }) {
  const pds = await pdsFor(did, { env, fetchImpl, cache, cacheBase });
  if (!pds) return { found: false, day: null };
  const q = (method, params) => {
    const u = new URL(`/xrpc/com.atproto.repo.${method}`, pds);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.href;
  };
  try {
    const res = await safeFetch(q('getRecord', { repo: did, collection: ENDORSE_NSID, rkey: id }), { fetchImpl, maxBytes: 16384 });
    const body = res.status === 200 ? parse(res.text) : null;
    if (body && endorses(body.value, subject)) return { found: true, day: endorsedDay(body.value) };
  } catch {
    // fall through to the listing
  }
  try {
    const res = await safeFetch(q('listRecords', { repo: did, collection: ENDORSE_NSID, limit: '100' }), { fetchImpl, maxBytes: 262144 });
    const body = res.status === 200 ? parse(res.text) : null;
    const records = Array.isArray(body?.records) ? body.records.slice(0, 100) : [];
    const hit = records.find((r) => r && endorses(r.value, subject));
    if (hit) return { found: true, day: endorsedDay(hit.value) };
  } catch {
    // not found
  }
  return { found: false, day: null };
}

/**
 * One page of a listed request's endorsers. -> { endorsers, total, cursor,
 * dropped, as_of }. Throws EndorsersError('unavailable') when Constellation
 * or the AppView can't answer.
 */
export async function endorserPage(env, id, { base = '', cursor, fetchImpl = fetch, cache = null, cacheBase = '', now = Date.now() } = {}) {
  const po = publicOrigin(env);
  const subject = po && endorseSubject(po.origin, base, id);
  if (!subject) throw new EndorsersError('unavailable');
  const ua = userAgent(`${po.origin}${base}/`);
  let page;
  try {
    page = await backlinkDids({ origin: constellationOrigin(env), subject, limit: PAGE, cursor, fetchImpl, ua });
  } catch {
    throw new EndorsersError('unavailable');
  }
  const profiles = await getProfiles(page.dids, { origin: appviewOrigin(env), fetchImpl, ua });
  const young = youngDays(env);
  const checked = await mapLimit(page.dids, VERIFY_CONCURRENCY, (did) => verifyEndorser(did, { env, subject, id, fetchImpl, cache, cacheBase }));
  const endorsers = [];
  let dropped = 0;
  page.dids.forEach((did, i) => {
    if (!checked[i].found) {
      dropped++;
      return;
    }
    const p = profiles.get(did);
    endorsers.push({
      did,
      handle: p?.handle || null,
      ...(p?.displayName ? { displayName: p.displayName } : {}),
      endorsed: checked[i].day,
      flags: flagsFor(did, p, { now, young }),
    });
  });
  return { endorsers, total: page.total, cursor: page.cursor, dropped, as_of: new Date(now).toISOString().slice(0, 16) + 'Z' };
}

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false;
  }
}

const jsonRes = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

const ERRORS = {
  not_found: 'No request on the public list has that id.',
  bad_cursor: "That page link isn't valid. Start from the first page.",
  busy: 'Lots of activity right now. Try again in a minute.',
  unavailable: 'The list of endorsers is unavailable right now. Try again in a few minutes.',
};
const fail = (code, status) => jsonRes({ error: ERRORS[code], code }, status);

/** The route. `id` is the path segment as given; `deps` carries fetchImpl, cache and publicList in tests. */
export async function handleEndorsers(req, env, ctx, base, id, deps = {}) {
  if (!blueskyReady(env)) return new Response('Not found', { status: 404 });
  if (typeof id !== 'string' || !PUBLIC_ID_RE.test(id)) return fail('not_found', 404);
  const cursor = new URL(req.url).searchParams.get('cursor');
  if (cursor !== null && !validCursor(cursor)) return fail('bad_cursor', 400);
  const visitor = await hmacHex(env.IP_SALT, `bsky-list:${visitorId(req.headers.get('CF-Connecting-IP'))}`, 32);
  if (!(await allowed(env.BSKY_VISITOR_RL, `list:${visitor}`))) return fail('busy', 429);
  const cache = deps.cache !== undefined ? deps.cache : defaultCache();
  const origin = new URL(req.url).origin;
  const list = deps.publicList || await cachedPublicList({ env, ctx, kv: env.LIMITS, origin, base, cache, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  if (list.unavailable) return fail('unavailable', 503);
  if (!(list.requests || []).some((r) => r.id === id && (r.status === 'accepted' || r.status === 'fulfilled'))) return fail('not_found', 404);
  const key = new Request(`${origin}${base}/__cache/endorsers-v1/${id}/${encodeURIComponent(cursor || '')}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return jsonRes(await hit.json(), 200, { 'Cache-Control': `public, max-age=${PAGE_SECONDS}` });
    } catch {
      // miss
    }
  }
  // The site-wide breaker before any outbound call.
  if (!(await allowed(env.BSKY_SITE_RL, 'endorsers'))) return fail('busy', 429);
  let page;
  try {
    page = await endorserPage(env, id, { base, cursor: cursor || undefined, fetchImpl: deps.fetchImpl || fetch, cache, cacheBase: `${origin}${base}`, now: deps.now ?? Date.now() });
  } catch {
    return fail('unavailable', 503);
  }
  if (cache) {
    const p = cache.put(key, new Response(JSON.stringify(page), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${PAGE_SECONDS}` } })).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(p);
    else await p;
  }
  return jsonRes(page, 200, { 'Cache-Control': `public, max-age=${PAGE_SECONDS}` });
}

