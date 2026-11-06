// Source requests: when Siren can't answer from the records she reaches, she
// names the source that would have answered, and the person can ask for it
// to be added. Requests are pooled by source, so the most-wanted sources rise
// to the top. Nothing about who asked is kept: no account, no visitor id;
// only the source, a link if one was given, and short notes on what people
// wanted to know, which the person sees and can edit first. Dates are kept as
// days, never finer.
//
// The list is public, through a steward gate: a request starts as "new" and
// appears on the public list (and as a GitHub issue) only once the steward
// accepts it. Notes are reviewed one by one, whatever the request's status: a
// new note waits as review "pending" until the steward approves it (or
// deletes it), and only approved notes written under the "requests are
// public" notice (public: true) are ever shown. Notes from before that notice
// stay private. Notes from before per-note review (no `review` field) count
// as reviewed only if they were written no later than the request's last
// decision. Statuses: new, accepted, declined, fulfilled.
//
// A request that was ever public carries was_public. If it later leaves the
// public list (declined, or set back to new), the public feed lists it under
// `withdrawn` with the day, so the GitHub mirror can close its issue.

import { sha256hex } from './invites.js';

const NOTE_CHARS = 300;
const KEEP_NOTES = 20;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const asDay = (v) => (typeof v === 'string' && v ? v.slice(0, 10) : v);
const randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const requestKey = async (source) => `request:${await sha256hex(clip(source, 200).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())}`;

export const STATUSES = ['new', 'accepted', 'declined', 'fulfilled'];
const PUBLIC = new Set(['accepted', 'fulfilled']);
export const NOTE_ACTIONS = ['approve', 'delete'];

// A note from before per-note review gets a stable id from its old timestamp
// (FNV-1a, not a hash of what the person wrote), so the steward's page and the
// CLI name it the same way before and after it is rewritten in the new shape.
function legacyNoteId(n) {
  let h = 0x811c9dc5;
  for (const c of String(n.at ?? n.day ?? '')) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `l${h.toString(16).padStart(8, '0')}`;
}

// Legacy notes ({text, at, public}) count as reviewed only when written no
// later than the request's last decision; later ones wait for the steward.
function legacyReview(n, r) {
  const at = Date.parse(n.at);
  const decided = Date.parse(r.decided);
  return Number.isFinite(at) && Number.isFinite(decided) && at <= decided ? 'ok' : 'pending';
}

/**
 * A request in the current shape: every note has an id, a day, public and
 * review; first and last are days. Pure; legacy records are read through it
 * and rewritten in this shape on their next write. Run it before a decision
 * changes `decided`, so the legacy rule is judged against the earlier one.
 */
export function normalizeRecord(r) {
  const seen = new Set();
  const needs = (r.needs || []).map((n) => {
    let out;
    if (typeof n.review === 'string') out = { id: String(n.id || ''), text: n.text, day: asDay(n.day ?? n.at), public: n.public === true, review: n.review === 'ok' ? 'ok' : 'pending' };
    else out = { id: legacyNoteId(n), text: n.text, day: asDay(n.at ?? n.day), public: n.public === true, review: legacyReview(n, r) };
    if (!out.id || seen.has(out.id)) {
      let i = 2;
      while (seen.has(`${out.id || 'n'}-${i}`)) i++;
      out.id = `${out.id || 'n'}-${i}`;
    }
    seen.add(out.id);
    return out;
  });
  return { ...r, first: asDay(r.first), last: asDay(r.last), needs };
}

export async function addRequest({ body, kv, visitor, perDay = 20, now = Date.now() }) {
  const source = clip(body?.source, 200);
  if (source.length < 3) return { ok: false, status: 400, error: 'Name the source to add.' };
  const url = clip(body?.url, 500);
  const need = clip(body?.need, NOTE_CHARS);
  const day = dayOf(now);
  const rateKey = `request-rate:${day}:${visitor}`;
  const used = Number((await kv.get(rateKey)) || 0);
  if (used >= perDay) return { ok: false, status: 429, error: 'That is a lot of requests for one day. Thank you; try again tomorrow.' };
  await kv.put(rateKey, String(used + 1), { expirationTtl: 90000 });
  const key = await requestKey(source);
  const cur = normalizeRecord((await kv.get(key, 'json')) || { source, url: '', count: 0, first: day, needs: [], status: 'new' });
  const note = { id: `n${randomHex(4)}`, text: need, day, public: body?.public === true, review: 'pending' };
  const next = {
    ...cur,
    url: cur.url || (/^https:\/\//i.test(url) ? url : ''),
    count: cur.count + 1,
    last: day,
    needs: need ? [...cur.needs, note].slice(-KEEP_NOTES) : cur.needs,
  };
  // KV is eventually consistent, so two requests at once can count as one.
  // The count is a signal for the steward, not a vote.
  await kv.put(key, JSON.stringify(next));
  // The caller shows the count only for a request that is already public.
  return { ok: true, count: next.count, public: PUBLIC.has(next.status || 'new') };
}

/**
 * What POST /api/requests answers for a saved request: {ok: true}, plus the
 * count only when the request is already public, so the answer says nothing
 * about requests still awaiting review.
 */
export const raiseResponse = (out) => (out.public ? { ok: true, count: out.count } : { ok: true });

/** The short public id of a request: the first 12 hex of its key. */
export const publicId = (key) => key.replace(/^request:/, '').slice(0, 12);

/** What the public list shows of one request. Dates are days; notes only if public and approved. */
export function publicView(key, r) {
  const n = normalizeRecord(r);
  return {
    id: publicId(key),
    source: n.source,
    ...(n.url ? { url: n.url } : {}),
    count: n.count,
    status: n.status,
    first: n.first,
    last: n.last,
    ...(n.fulfilled_by ? { fulfilled_by: n.fulfilled_by } : {}),
    ...(n.steward_note ? { steward_note: n.steward_note } : {}),
    notes: n.needs.filter((x) => x.public && x.review === 'ok').slice(-5).map((x) => x.text),
  };
}

async function listRequests(kv) {
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
 * The public list: accepted and fulfilled requests, most wanted first; how
 * many await review; and the requests that were public and no longer are
 * (id and the day of that decision only), so the mirror can close them.
 */
export async function publicRequests(kv) {
  const rows = await listRequests(kv);
  const shown = rows.filter(([, r]) => PUBLIC.has(r.status || 'new')).map(([k, r]) => publicView(k, r));
  shown.sort((a, b) => (a.status === b.status ? b.count - a.count : a.status === 'accepted' ? -1 : 1));
  const withdrawn = rows
    .filter(([, r]) => r.was_public === true && !PUBLIC.has(r.status || 'new'))
    .map(([k, r]) => ({ id: publicId(k), day: asDay(r.decided) || null }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { requests: shown, awaiting_review: rows.filter(([, r]) => (r.status || 'new') === 'new').length, withdrawn };
}

/** Steward decision. `extra` may carry steward_note (public) or fulfilled_by (a PR or commit URL). */
export function withStatus(r, status, extra = {}, now = Date.now()) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of ${STATUSES.join(', ')}.`);
  // Normalize first: legacy notes are judged against the earlier decision.
  const cur = normalizeRecord(r);
  const out = { ...cur, status, decided: new Date(now).toISOString() };
  // Set at acceptance and kept: a request that leaves the public list later
  // is listed as withdrawn. A legacy request that is public now counts too.
  if (r.was_public === true || PUBLIC.has(status) || PUBLIC.has(r.status || 'new')) out.was_public = true;
  if (extra.steward_note) out.steward_note = String(extra.steward_note).slice(0, 300);
  if (extra.fulfilled_by) {
    if (!/^https:\/\//.test(extra.fulfilled_by)) throw new Error('fulfilled_by must be an https link to the PR or commit.');
    out.fulfilled_by = extra.fulfilled_by;
  }
  return out;
}

/** Steward review of one note: approve it (shown if it was written under the public notice) or delete it. */
export function withNoteReview(r, noteId, action) {
  if (!NOTE_ACTIONS.includes(action)) throw new Error(`The note action must be one of ${NOTE_ACTIONS.join(', ')}.`);
  const cur = normalizeRecord(r);
  if (!cur.needs.some((n) => n.id === noteId)) throw new Error('That request has no note with that id.');
  const needs = action === 'delete' ? cur.needs.filter((n) => n.id !== noteId) : cur.needs.map((n) => (n.id === noteId ? { ...n, review: 'ok' } : n));
  return { ...cur, needs };
}

/** One request as the steward sees it: all statuses, every note with its id, day, public and review. */
export function adminView(key, r) {
  const n = normalizeRecord(r);
  return { id: publicId(key), ...n, status: n.status || 'new', needs: n.needs.map(({ id, text, day, public: pub, review }) => ({ id, text, day, public: pub, review })) };
}

/** Every request, for the steward: all statuses, private and pending notes marked. */
export async function allRequests(kv) {
  return (await listRequests(kv)).map(([k, r]) => adminView(k, r)).sort((a, b) => b.count - a.count);
}

async function findRequest(kv, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return { error: { ok: false, status: 400, error: 'Give the request id.' } };
  const page = await kv.list({ prefix: `request:${id}` });
  if (page.keys.length !== 1) return { error: { ok: false, status: 404, error: 'No single request has that id.' } };
  const key = page.keys[0].name;
  return { key, cur: await kv.get(key, 'json') };
}

/** Apply a steward decision by public id. Returns { ok, request } or { ok: false, status, error }. */
export async function decide(kv, { id, status, note, fulfilled_by }, now = Date.now()) {
  const found = await findRequest(kv, id);
  if (found.error) return found.error;
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
  await kv.put(key, JSON.stringify(next));
  return { ok: true, request: publicView(key, next) };
}

/** Approve or delete one note by request id and note id. Returns { ok, request, needs } or { ok: false, status, error }. */
export async function reviewNote(kv, { id, note, action }) {
  const found = await findRequest(kv, id);
  if (found.error) return found.error;
  const { key, cur } = found;
  if (typeof note !== 'string' || !/^[0-9a-z-]{1,24}$/.test(note)) return { ok: false, status: 400, error: 'Give the note id.' };
  let next;
  try {
    next = withNoteReview(cur, note, action);
  } catch (err) {
    return { ok: false, status: /no note/.test(err.message) ? 404 : 400, error: err.message };
  }
  await kv.put(key, JSON.stringify(next));
  return { ok: true, request: publicView(key, next), needs: adminView(key, next).needs };
}
