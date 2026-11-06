// Source requests: when Siren can't answer from the records she reaches, she
// names the source that would have answered, and the person can ask for it
// to be added. Requests are pooled by source, so the most-wanted sources rise
// to the top. Nothing about who asked is kept: no account, no visitor id;
// only the source, a link if one was given, and short notes on what people
// wanted to know, which the person sees and can edit first.
//
// The list is public, through a steward gate: a request starts as "new" and
// appears on the public list (and as a GitHub issue) only once the steward
// accepts it. Notes appear publicly only if they were written under the
// "requests are public" notice (public: true); notes from before that notice
// stay private. Statuses: new, accepted, declined, fulfilled.
//
// Endorsements (endorsements.js) are the one place a person's identity
// touches requests. To count a Bluesky account once per request, KV keeps
// HMAC(INVITE_SECRET, request + account), never the DID, the handle, the
// issuer or any token, and one account's endorsements on different requests
// have no key material in common (someone who lists KV over and over could
// still pair keys written close together in time). Counts are public;
// endorsers are pseudonymous to anyone without the key. When a request is
// decided, its count is frozen into the record and the per-account keys are
// deleted; any written around the decision are swept within minutes. This module never imports
// endorsements.js: callers count and pass the counts in. Nothing else may be
// keyed under `request:` (the list and steward tools parse every such key).

import { sha256hex } from './invites.js';

const NOTE_CHARS = 300;
const KEEP_NOTES = 20;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

export const requestKey = async (source) => `request:${await sha256hex(clip(source, 200).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())}`;

export async function addRequest({ body, kv, visitor, perDay = 20, now = Date.now() }) {
  const source = clip(body?.source, 200);
  if (source.length < 3) return { ok: false, status: 400, error: 'Name the source to add.' };
  const url = clip(body?.url, 500);
  const need = clip(body?.need, NOTE_CHARS);
  const day = new Date(now).toISOString().slice(0, 10);
  const rateKey = `request-rate:${day}:${visitor}`;
  const used = Number((await kv.get(rateKey)) || 0);
  if (used >= perDay) return { ok: false, status: 429, error: 'That is a lot of requests for one day. Thank you; try again tomorrow.' };
  await kv.put(rateKey, String(used + 1), { expirationTtl: 90000 });
  const key = await requestKey(source);
  const at = new Date(now).toISOString();
  const cur = (await kv.get(key, 'json')) || { source, url: '', count: 0, first: at, needs: [], status: 'new' };
  const next = {
    ...cur,
    url: cur.url || (/^https:\/\//i.test(url) ? url : ''),
    count: cur.count + 1,
    last: at,
    needs: need ? [...cur.needs, { text: need, at, public: body?.public === true }].slice(-KEEP_NOTES) : cur.needs,
  };
  // KV is eventually consistent, so two requests at once can count as one.
  // The count is a signal for the steward, not a vote.
  await kv.put(key, JSON.stringify(next));
  return { ok: true, count: next.count };
}

export const STATUSES = ['new', 'accepted', 'declined', 'fulfilled'];
const PUBLIC = new Set(['accepted', 'fulfilled']);

/** The short public id of a request: the first 12 hex of its key. */
export const publicId = (key) => key.replace(/^request:/, '').slice(0, 12);

const ZERO = Object.freeze({ n: 0, young: 0, unknown: 0 });
const DECIDED = new Set(['declined', 'fulfilled']);

/**
 * The public number for a count { n, young, unknown }: every endorsement
 * under policy 'all', established accounts only under 'established'.
 */
export function publicNumber(c, policy = 'established') {
  if (!c) return 0;
  const n = Number(c.n) || 0;
  return policy === 'all' ? n : Math.max(0, n - (Number(c.young) || 0) - (Number(c.unknown) || 0));
}

/**
 * What the public list shows of one request. With `live` counts (the Bluesky
 * feature is on), it adds `endorsements`: the live public number for an
 * accepted request, the number frozen at decision for a fulfilled one.
 */
export function publicView(key, r, live, policy = 'established') {
  const out = {
    id: publicId(key),
    source: r.source,
    ...(r.url ? { url: r.url } : {}),
    count: r.count,
    status: r.status,
    first: r.first,
    last: r.last,
    ...(r.fulfilled_by ? { fulfilled_by: r.fulfilled_by } : {}),
    ...(r.steward_note ? { steward_note: r.steward_note } : {}),
    notes: (r.needs || []).filter((n) => n.public).slice(-5).map((n) => n.text),
  };
  if (live !== undefined) {
    out.endorsements = r.status === 'accepted' ? publicNumber(live || ZERO, policy)
      : r.status === 'fulfilled' ? publicNumber(r.endorsements_at_decision, policy) : 0;
  }
  return out;
}

async function requestRows(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'request:', cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return (await Promise.all(keys.map(async (k) => [k, await kv.get(k, 'json')]))).filter(([, r]) => r);
}

/**
 * The public list: accepted and fulfilled requests, accepted first, most
 * asked first, endorsements only breaking ties; plus how many await review.
 * Without `counts` (the feature off), items carry no `endorsements` field.
 * `statuses`, when given, is a Map filled with every request's status by
 * public id (the orphan sweep needs them, and they're read here anyway).
 */
export async function publicRequests(kv, counts, { policy = 'established', statuses } = {}) {
  const rows = await requestRows(kv);
  if (statuses) for (const [k, r] of rows) statuses.set(publicId(k), r.status || 'new');
  const shown = rows
    .filter(([, r]) => PUBLIC.has(r.status || 'new'))
    .map(([k, r]) => publicView(k, r, counts ? counts.get(publicId(k)) || ZERO : undefined, policy));
  shown.sort((a, b) => (a.status !== b.status ? (a.status === 'accepted' ? -1 : 1) : b.count - a.count || (b.endorsements || 0) - (a.endorsements || 0)));
  return { requests: shown, awaiting_review: rows.filter(([, r]) => (r.status || 'new') === 'new').length };
}

/** Steward decision. `extra` may carry steward_note (public) or fulfilled_by (a PR or commit URL). */
export function withStatus(r, status, extra = {}, now = Date.now()) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of ${STATUSES.join(', ')}.`);
  const out = { ...r, status, decided: new Date(now).toISOString() };
  if (extra.steward_note) out.steward_note = String(extra.steward_note).slice(0, 300);
  if (extra.fulfilled_by) {
    if (!/^https:\/\//.test(extra.fulfilled_by)) throw new Error('fulfilled_by must be an https link to the PR or commit.');
    out.fulfilled_by = extra.fulfilled_by;
  }
  return out;
}

/**
 * The count to freeze into a request moving to `status`: the live count on a
 * move into a decided status from an undecided one; the earlier frozen value
 * on a move between decided statuses, or back to accepted (the steward still
 * sees "N at decision"). undefined when there's nothing to store.
 */
export function freezeAtDecision(cur, status, live) {
  const prev = cur?.endorsements_at_decision;
  const from = cur?.status || 'new';
  if (DECIDED.has(status) && !DECIDED.has(from) && live) {
    return { n: Number(live.n) || 0, young: Number(live.young) || 0, unknown: Number(live.unknown) || 0 };
  }
  return prev || undefined;
}

/** Every request, for the steward: all statuses, private notes marked, live endorsement counts. */
export async function allRequests(kv, counts = new Map()) {
  const rows = await requestRows(kv);
  return rows
    .map(([k, r]) => ({
      id: publicId(k), ...r, status: r.status || 'new',
      needs: (r.needs || []).map((n) => ({ text: n.text, at: n.at, public: Boolean(n.public) })),
      endorsements: { ...(counts.get(publicId(k)) || ZERO) },
    }))
    .sort((a, b) => b.count - a.count);
}

/** The one request whose key starts `request:<id>`: { key, cur } or null. */
export async function requestByPublicId(kv, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return null;
  const page = await kv.list({ prefix: `request:${id}` });
  if (page.keys.length !== 1) return null;
  const key = page.keys[0].name;
  const cur = await kv.get(key, 'json');
  return cur ? { key, cur } : null;
}

/**
 * Apply a steward decision by public id. Returns { ok, request, previous } or
 * { ok: false, status, error }. `live`, when given, is the request's live
 * endorsement count, frozen into the record on a move to a decided status.
 * The record is written once (KV refuses a second write to a key within a second).
 */
export async function decide(kv, { id, status, note, fulfilled_by }, now = Date.now(), { live } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return { ok: false, status: 400, error: 'Give the request id.' };
  const found = await requestByPublicId(kv, id);
  if (!found) return { ok: false, status: 404, error: 'No single request has that id.' };
  const { key, cur } = found;
  let next;
  try {
    next = withStatus(cur, status, { steward_note: note, fulfilled_by }, now);
  } catch (err) {
    return { ok: false, status: 400, error: err.message };
  }
  if (status === 'fulfilled' && !next.fulfilled_by) return { ok: false, status: 400, error: 'Give the link to the merged PR or commit.' };
  // A cleared note clears the public note.
  if (note === '') delete next.steward_note;
  const frozen = freezeAtDecision(cur, status, live);
  if (frozen) next.endorsements_at_decision = frozen;
  await kv.put(key, JSON.stringify(next));
  return { ok: true, previous: cur.status || 'new', request: publicView(key, next, live) };
}
