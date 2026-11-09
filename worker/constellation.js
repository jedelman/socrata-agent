// Constellation (microcosm), the public backlink index Siren counts
// endorsements through: it indexes every record on the network that links to
// a URL, by collection and JSON path, and needs no Lexicon. Docs:
// https://constellation.microcosm.blue/ (read 2026-11-09). Its own terms:
// "api is unstable and likely to change", best-effort uptime on a volunteer's
// Raspberry Pi, "Please do not build the torment nexus", and a User-Agent
// naming the project and a contact. CONSTELLATION_URL switches to a
// self-hosted instance (D11: the public one for now, default, pending Jason).
//
// Its answers are untrusted input: shapes are checked, sizes capped, DIDs
// validated, and the caller never shows a listed account without first
// finding the record on that account's own server (endorsers.js). Pure:
// every call takes `fetchImpl`, through safeFetch.

import { safeFetch, safeUrl, isSupportedDid } from './atproto-identity.js';
import { ENDORSE_SOURCE } from './endorse-config.js';

export const CONSTELLATION_DEFAULT = 'https://constellation.microcosm.blue';
export const TIMEOUT_MS = 4000;
const MAX_BYTES = 65536;
const MAX_TOTAL = 1e9;

export class ConstellationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConstellationError';
    this.code = code;
  }
}

/** The instance's origin: CONSTELLATION_URL if it's a bare https origin, else the public instance. null if set but unsafe. */
export function constellationOrigin(env) {
  const s = env?.CONSTELLATION_URL;
  if (s === undefined || s === '') return CONSTELLATION_DEFAULT;
  const u = safeUrl(s);
  return u && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && (s === u.origin || s === `${u.origin}/`) ? u.origin : null;
}

/**
 * The User-Agent for Constellation: the project and its public URL, no
 * personal contact (D5, default, pending Jason).
 */
export function userAgent(publicUrl) {
  return `Siren (+${publicUrl}; https://github.com/jedelman/socrata-agent)`;
}

// Opaque, but bounded: what Constellation has sent so far is short and
// URL-safe. Anything else is refused rather than passed on.
const CURSOR_RE = /^[A-Za-z0-9._~:+/=-]{1,256}$/;
export const validCursor = (c) => typeof c === 'string' && CURSOR_RE.test(c);

/**
 * GET blue.microcosm.links.getBacklinkDids for one subject URL:
 * -> { total (distinct DIDs), dids (valid, distinct, at most `limit`), cursor | null }.
 * Throws ConstellationError('unavailable' | 'bad_response').
 */
export async function backlinkDids({ origin, subject, limit = 1, cursor, fetchImpl = fetch, signal, ua }) {
  if (!origin) throw new ConstellationError('unavailable');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConstellationError('bad_request');
  if (cursor !== undefined && cursor !== null && !validCursor(cursor)) throw new ConstellationError('bad_request');
  const u = new URL('/xrpc/blue.microcosm.links.getBacklinkDids', origin);
  u.searchParams.set('subject', subject);
  u.searchParams.set('source', ENDORSE_SOURCE);
  u.searchParams.set('limit', String(limit));
  if (cursor) u.searchParams.set('cursor', cursor);
  let res;
  try {
    res = await safeFetch(u.href, { fetchImpl, signal, timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, headers: { Accept: 'application/json', ...(ua ? { 'User-Agent': ua } : {}) } });
  } catch {
    throw new ConstellationError('unavailable');
  }
  if (res.status !== 200) throw new ConstellationError('unavailable');
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    throw new ConstellationError('bad_response');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConstellationError('bad_response');
  const { total, linking_dids: list } = body;
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_TOTAL) throw new ConstellationError('bad_response');
  if (list !== undefined && !Array.isArray(list)) throw new ConstellationError('bad_response');
  const dids = [...new Set((list || []).slice(0, limit).filter(isSupportedDid))];
  const next = body.cursor;
  if (next !== undefined && next !== null && !validCursor(next)) throw new ConstellationError('bad_response');
  return { total, dids, cursor: next || null };
}

/** The number of distinct accounts that endorsed this subject. Throws ConstellationError. */
export async function countEndorsers(opts) {
  return (await backlinkDids({ ...opts, limit: 1, cursor: undefined })).total;
}
