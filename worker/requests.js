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
// decision, that decision put the request on the public list, and the old
// public list showed them (the last five public notes).
// Statuses: new, accepted, declined, fulfilled.
//
// A request is one KV record, and a raise rewrites all of it from what it
// read, which can be up to a minute stale elsewhere. So the steward's state
// lives in two more keys that raises never write, and every read lays them
// over the record: `request-decision:<hash>` holds the decision (status,
// decided, was_public, steward_note, fulfilled_by, endorsements_at_decision),
// so a stale raise can't undo a decline or drop a frozen count;
// `request-deleted:<hash>` holds deleted note ids, so a stale raise can't
// bring a deleted note back. Windows that remain until requests move to D1: a stale raise can set an approved note back to pending (it
// hides, never shows), and two steward actions on one request inside the
// propagation window can race on those keys (the admin page sends the notes
// it deleted this session, so its own deletes always add up; the CLI's don't).
//
// A request that was ever public carries was_public. If it later leaves the
// public list (declined, or set back to new), the public feed lists it under
// `withdrawn` with the day, for WITHDRAWN_DAYS, so the GitHub mirror can close
// its issue. Known limit: a public id is the first 12 hex of sha256 of the
// normalized source text, so anyone can confirm a guessed source against it,
// withdrawn ones included while they are listed. A random id stored at
// acceptance would fix that; issue markers depend on the current scheme, so
// it is left for a later change.
//
// Endorsements (endorsements.js) are the one place a person's identity
// touches requests. They live in D1 (SIREN_DB), not in KV with the requests:
// to count a Bluesky account once per request, D1 keeps HMAC(INVITE_SECRET,
// request + account), never the DID, the handle, the issuer or any token, and
// one account's endorsements on different requests have nothing in common.
// Counts are public, for public requests only; endorsers are pseudonymous to
// anyone without the key. When a request is decided, its count is frozen into
// the decision (endorsements_at_decision, a steward-owned field kept in
// `request-decision:` like the rest) and the per-account rows are deleted;
// any written around the decision are swept within minutes. This module
// never imports endorsements.js: callers count and pass the counts in.
// Nothing else may be keyed under `request:` (the list and steward tools
// parse every such key); the side keys use `request-decision:` and
// `request-deleted:`, which a `request:` prefix list doesn't match.

import { sha256hex } from './invites.js';

const NOTE_CHARS = 300;
const KEEP_NOTES = 20;
// Pending notes kept per request, so a run of new notes can't push out the
// approved ones.
const KEEP_PENDING = 10;
const KEEP_DELETED = 500;
// How long a withdrawn request stays in the public feed's `withdrawn` list:
// long enough for nightly syncs to close its issue, not forever.
export const WITHDRAWN_DAYS = 30;
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
// later than the request's last decision, only if that decision put the
// request on the public list (the steward saw them when accepting it), and
// only if the old public list actually showed them: it showed the last five
// public notes, so an older one was never published and waits. After a
// decline or a reset to new, every legacy note waits for the steward.
// normalizeRecord runs before a decision changes status or decided, so
// r.status here is the status set at `decided`.
function legacyReview(n, r, shown) {
  const at = Date.parse(n.at);
  const decided = Date.parse(r.decided);
  return PUBLIC.has(r.status || 'new') && shown.has(n) && Number.isFinite(at) && Number.isFinite(decided) && at <= decided ? 'ok' : 'pending';
}

/** Where the ids of a request's deleted notes are kept. Raises never write it. */
export const deletedKey = (key) => key.replace(/^request:/, 'request-deleted:');

/** A record without the notes whose ids were deleted. Pure. */
export function dropDeleted(r, ids) {
  if (!r || !ids?.length) return r;
  const gone = new Set(ids);
  const cur = normalizeRecord(r);
  return { ...cur, needs: cur.needs.filter((n) => !gone.has(n.id)) };
}

async function readDeleted(kv, key) {
  const ids = await kv.get(deletedKey(key), 'json');
  return Array.isArray(ids) ? ids : [];
}

/** Where a request's steward decision is kept. Raises never write it. */
export const decisionKey = (key) => key.replace(/^request:/, 'request-decision:');
const DECISION_FIELDS = ['status', 'decided', 'was_public', 'steward_note', 'fulfilled_by', 'endorsements_at_decision'];

/** The steward-owned fields of a record. Pure. */
export function decisionOf(r) {
  return Object.fromEntries(DECISION_FIELDS.filter((f) => r?.[f] !== undefined).map((f) => [f, r[f]]));
}

/** A record with the stored decision laid over it: the decision's fields win, and a field it lacks is dropped. Pure. */
export function withDecision(r, d) {
  if (!r || !d || typeof d !== 'object' || typeof d.status !== 'string') return r;
  const out = { ...r };
  for (const f of DECISION_FIELDS) {
    if (d[f] === undefined) delete out[f];
    else out[f] = d[f];
  }
  return out;
}

/**
 * A stored record as every reader should see it: normalized (against its own
 * decision, for the legacy rule), deleted notes dropped, then the stored
 * decision laid over it. Pure; null for a missing record.
 */
export function stewardView(stored, deleted, decision) {
  if (!stored) return null;
  return withDecision(normalizeRecord(dropDeleted(stored, deleted)), decision);
}

async function readRequest(kv, key) {
  const [stored, deleted, decision] = await Promise.all([kv.get(key, 'json'), readDeleted(kv, key), kv.get(decisionKey(key), 'json')]);
  return { cur: stewardView(stored, deleted, decision), deleted };
}

/**
 * The notes to keep, in order: the newest KEEP_PENDING pending notes and as
 * many of the newest approved ones as fit in KEEP_NOTES.
 */
export function trimNotes(needs) {
  const pending = needs.filter((n) => n.review !== 'ok').slice(-KEEP_PENDING);
  const ok = needs.filter((n) => n.review === 'ok').slice(-(KEEP_NOTES - pending.length));
  const keep = new Set([...pending, ...ok]);
  return needs.filter((n) => keep.has(n));
}

/**
 * A request in the current shape: every note has an id, a day, public and
 * review; first and last are days. Pure; legacy records are read through it
 * and rewritten in this shape on their next write. Run it before a decision
 * changes `decided`, so the legacy rule is judged against the earlier one.
 */
export function normalizeRecord(r) {
  const seen = new Set();
  // The legacy notes the old public list showed: the last five public ones.
  const shown = new Set((r.needs || []).filter((n) => typeof n.review !== 'string' && n.public === true).slice(-5));
  const needs = (r.needs || []).map((n) => {
    let out;
    if (typeof n.review === 'string') out = { id: String(n.id || ''), text: n.text, day: asDay(n.day ?? n.at), public: n.public === true, review: n.review === 'ok' ? 'ok' : 'pending' };
    else out = { id: legacyNoteId(n), text: n.text, day: asDay(n.at ?? n.day), public: n.public === true, review: legacyReview(n, r, shown) };
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
  const cur = (await readRequest(kv, key)).cur || normalizeRecord({ source, url: '', count: 0, first: day, needs: [], status: 'new' });
  const note = { id: `n${randomHex(4)}`, text: need, day, public: body?.public === true, review: 'pending' };
  const next = {
    ...cur,
    url: cur.url || (/^https:\/\//i.test(url) ? url : ''),
    count: cur.count + 1,
    last: day,
    needs: need ? trimNotes([...cur.needs, note]) : cur.needs,
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
 * What the public list shows of one request. Dates are days; notes only if
 * public and approved. With `live` counts (the Bluesky feature is on), it
 * adds `endorsements`: the live public number for an accepted request, the
 * number frozen at decision for a fulfilled one.
 */
export function publicView(key, r, live, policy = 'established') {
  const n = normalizeRecord(r);
  const out = {
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
  if (live !== undefined) {
    out.endorsements = n.status === 'accepted' ? publicNumber(live || ZERO, policy)
      : n.status === 'fulfilled' ? publicNumber(n.endorsements_at_decision, policy) : 0;
  }
  return out;
}

/**
 * Every request record as readers see it (side keys laid over, deleted notes
 * dropped): [key, record] pairs, from one or more KV list pages. Throws if KV
 * fails.
 */
export async function requestRows(kv) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'request:', cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const rows = await Promise.all(keys.map(async (k) => [k, (await readRequest(kv, k)).cur]));
  return rows.filter(([, r]) => r);
}

/**
 * The public list: accepted and fulfilled requests, accepted first, most
 * asked first (endorsements, when counted, only break ties), and
 * the requests that were public and no longer are, withdrawn in the last
 * WITHDRAWN_DAYS (id and the day of that decision only), so the mirror can
 * close them. Nothing about requests or notes the steward hasn't reviewed,
 * not even how many there are: a count would let anyone test whether
 * someone else asked for a source, by raising it and watching the number.
 * Reads only, so the public read can't fail on KV's write limits.
 *
 * Without `counts` (the Bluesky feature off), items carry no `endorsements`
 * field and the list is exactly the requests-only list. `statuses`, when
 * given, is a Map filled with every request's status by public id (the
 * orphan sweep needs them, and they're read here anyway). `rows`, when given,
 * are requestRows(kv) already read (the counted list reads KV before D1).
 */
export async function publicRequests(kv, now = Date.now(), { counts, policy = 'established', statuses, rows: given } = {}) {
  const rows = given || await requestRows(kv);
  if (statuses) for (const [k, r] of rows) statuses.set(publicId(k), r.status || 'new');
  const since = dayOf(now - WITHDRAWN_DAYS * 86400000);
  const shown = rows
    .filter(([, r]) => PUBLIC.has(r.status || 'new'))
    .map(([k, r]) => publicView(k, r, counts ? counts.get(publicId(k)) || ZERO : undefined, policy));
  shown.sort((a, b) => (a.status !== b.status ? (a.status === 'accepted' ? -1 : 1) : b.count - a.count || (b.endorsements || 0) - (a.endorsements || 0)));
  const withdrawn = rows
    .filter(([, r]) => r.was_public === true && !PUBLIC.has(r.status || 'new'))
    .map(([k, r]) => ({ id: publicId(k), day: asDay(r.decided) || null }))
    // A withdrawal with no day (never expected) is kept rather than dropped.
    .filter((w) => !w.day || w.day >= since)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { requests: shown, withdrawn };
}

/** Steward decision. `extra` may carry steward_note (public) or fulfilled_by (a PR or commit URL). */
export function withStatus(r, status, extra = {}, now = Date.now()) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of ${STATUSES.join(', ')}.`);
  // Normalize first: legacy notes are judged against the earlier decision.
  const cur = normalizeRecord(r);
  // A day, like every stored date. Safe: every note has its review now, so
  // the legacy rule never compares against this value.
  const out = { ...cur, status, decided: dayOf(now) };
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

/** The tombstone list with one more note id, newest kept. */
export const withDeleted = (ids, noteId) => [...(ids || []).filter((x) => x !== noteId), noteId].slice(-KEEP_DELETED);

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

/** Every request, for the steward: all statuses, private and pending notes marked, live endorsement counts. */
export async function allRequests(kv, counts = new Map()) {
  return (await requestRows(kv))
    .map(([k, r]) => ({ ...adminView(k, r), endorsements: { ...(counts.get(publicId(k)) || ZERO) } }))
    .sort((a, b) => b.count - a.count);
}

async function findRequest(kv, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return { error: { ok: false, status: 400, error: 'Give the request id.' } };
  const page = await kv.list({ prefix: `request:${id}` });
  if (page.keys.length !== 1) return { error: { ok: false, status: 404, error: 'No single request has that id.' } };
  const key = page.keys[0].name;
  const { cur, deleted } = await readRequest(kv, key);
  if (!cur) return { error: { ok: false, status: 404, error: 'No single request has that id.' } };
  return { key, cur, deleted };
}

/** The one request whose key starts `request:<id>`, as readers see it: { key, cur } or null. */
export async function requestByPublicId(kv, id) {
  const found = await findRequest(kv, id);
  return found.error ? null : { key: found.key, cur: found.cur };
}

/**
 * Apply a steward decision by public id. Returns { ok, request, previous } or
 * { ok: false, status, error }. `live`, when given, is the request's live
 * endorsement count, frozen into the decision on a move to a decided status.
 * Each key is written once (KV refuses a second write to a key within a second).
 */
export async function decide(kv, { id, status, note, fulfilled_by }, now = Date.now(), { live } = {}) {
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
  const frozen = freezeAtDecision(cur, status, live);
  if (frozen) next.endorsements_at_decision = frozen;
  // The decision first: if the record write is lost to a stale raise, reads
  // still see this decision.
  await kv.put(decisionKey(key), JSON.stringify(decisionOf(next)));
  await kv.put(key, JSON.stringify(next));
  return { ok: true, previous: cur.status || 'new', request: publicView(key, next, live) };
}

const NOTE_ID = /^[0-9a-z-]{1,24}$/;

/**
 * Approve or delete one note by request id and note id. `deleted` may list
 * note ids this steward already deleted from the request, kept in the
 * tombstone even if this read of it is stale. Returns { ok, request, needs }
 * or { ok: false, status, error }.
 */
export async function reviewNote(kv, { id, note, action, deleted: sent }) {
  const found = await findRequest(kv, id);
  if (found.error) return found.error;
  const { key, cur, deleted } = found;
  if (typeof note !== 'string' || !NOTE_ID.test(note)) return { ok: false, status: 400, error: 'Give the note id.' };
  let next;
  try {
    next = withNoteReview(cur, note, action);
  } catch (err) {
    return { ok: false, status: /no note/.test(err.message) ? 404 : 400, error: err.message };
  }
  // The tombstone first: if the record write is lost to a stale raise, reads
  // still drop the note.
  if (action === 'delete') {
    const known = Array.isArray(sent) ? sent.filter((x) => typeof x === 'string' && NOTE_ID.test(x)).slice(-KEEP_DELETED) : [];
    await kv.put(deletedKey(key), JSON.stringify(withDeleted([...new Set([...deleted, ...known])], note)));
  }
  await kv.put(key, JSON.stringify(next));
  return { ok: true, request: publicView(key, next), needs: adminView(key, next).needs };
}
