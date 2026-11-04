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

/** What the public list shows of one request. */
export function publicView(key, r) {
  return {
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
}

/** The public list: accepted and fulfilled requests, most wanted first, plus how many await review. */
export async function publicRequests(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'request:', cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const rows = (await Promise.all(keys.map(async (k) => [k, await kv.get(k, 'json')]))).filter(([, r]) => r);
  const shown = rows.filter(([, r]) => PUBLIC.has(r.status || 'new')).map(([k, r]) => publicView(k, r));
  shown.sort((a, b) => (a.status === b.status ? b.count - a.count : a.status === 'accepted' ? -1 : 1));
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

/** Every request, for the steward: all statuses, private notes marked. */
export async function allRequests(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'request:', cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const rows = await Promise.all(keys.map(async (k) => [k, await kv.get(k, 'json')]));
  return rows
    .filter(([, r]) => r)
    .map(([k, r]) => ({ id: publicId(k), ...r, status: r.status || 'new', needs: (r.needs || []).map((n) => ({ text: n.text, at: n.at, public: Boolean(n.public) })) }))
    .sort((a, b) => b.count - a.count);
}

/** Apply a steward decision by public id. Returns { ok, request } or { ok: false, status, error }. */
export async function decide(kv, { id, status, note, fulfilled_by }, now = Date.now()) {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return { ok: false, status: 400, error: 'Give the request id.' };
  const page = await kv.list({ prefix: `request:${id}` });
  if (page.keys.length !== 1) return { ok: false, status: 404, error: 'No single request has that id.' };
  const key = page.keys[0].name;
  const cur = await kv.get(key, 'json');
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
