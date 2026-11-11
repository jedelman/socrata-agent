// Research memory's storage and routes (docs/research-memory.md; the tool is
// src/prior-research.js). Jason, 2026-11-11: research counts from "Public,
// shared, and within the account." What any scope gives back is where to
// look (sources, with the day read), never an earlier answer's words.
//
//   account  the asking account's own conversations (conversations.js
//            researchInConversations): only with PRIOR_RESEARCH = "true", for
//            signed-in accounts; off by default;
//   public   answered free-tier questions in SIREN_DB (with PUBLIC_ASK on):
//            only questions the public-text checks pass, and only their
//            sources that could point at no address or person;
//   shared   sources people shared from their private answers with the
//            "Share these sources" button, in SIREN_DB table shared_sources
//            (migration 0005), behind SHARED_RESEARCH = "true".
//
// Sharing is the person's own click on one saved answer. The Worker reads
// the sources from that saved turn (never from the page), drops anything
// that could point at an address or a person, and keeps each source's title,
// link, kind, city and days: never who shared it, the question or the answer.
// The shared list is public (GET /api/research) so the case-file routine can
// read what people found useful; the steward removes a source at
// /admin/research, at once, for prior_research and the list both.

import { topicSources, addressTurn, scoreTexts, enough, MAX_MATCHES, MAX_SOURCES } from '../src/prior-research.js';
import { normalizeUrl } from '../src/answer-links.js';
import { sourceKey } from '../src/prior-research.js';
import { hmacHex } from './crypto.js';
import { publicTextViolations } from '../src/public-text.js';
import { loadConversation, researchInConversations, chargeSearch } from './conversations.js';
import { currentUser, isAdmin } from './accounts.js';
import { newPublicId, PUBLIC_ID_RE } from './requests.js';
import { publicOrigin } from './atproto-oauth.js';

/** Shares an account may make per UTC day (one per answer shared). */
export const SHARE_DAILY = 20;
/** Sources kept from one shared answer, at most. */
export const SHARE_MAX = 20;
/** The public list's page size: the default and the most a page may ask for. */
export const LIST_DEFAULT = 50;
export const LIST_MAX = 100;
const STEWARD_ROWS = 200;
// At most 40 threads of at most 25 questions each (docs/free-tier.md).
const THREAD_ROWS = 1000;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const NOINDEX = { 'X-Robots-Tag': 'noindex' };

export const sharedResearchOn = (env) => env.SHARED_RESEARCH === 'true';
/** Shared research needs its table's database, the KV store and the secret its daily count is keyed with. */
export const sharedResearchReady = (env) => sharedResearchOn(env) && Boolean(env.SIREN_DB && env.LIMITS && env.INVITE_SECRET);
/** PRIOR_RESEARCH = "off" turns the tool off everywhere, without a deploy of new code. */
export const priorResearchOff = (env) => String(env.PRIOR_RESEARCH ?? '').trim().toLowerCase() === 'off';
/** The account scope is opt-in: on only with PRIOR_RESEARCH = "true". */
export const accountResearchOn = (env) => env.PRIOR_RESEARCH === 'true';
/** How long a shared answer is remembered as shared, so sharing it again counts once. */
const SHARED_TURN_TTL = 400 * 86400;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const likeTerm = (t) => `%${String(t).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const parse = (s, fallback) => {
  try {
    const v = JSON.parse(s || '');
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

// Codes that mark a question as about one address or property.
const PLACE_CODES = new Set(['house_number', 'number_street', 'intersection', 'block_of', 'unit', 'parcel_grain', 'coordinates']);
/** Whether a saved turn looked up an address: its tools, its trace's labels, or a question naming one. */
export function turnByAddress(turn, streets) {
  const names = (Array.isArray(turn?.tools) ? turn.tools : []).map((t) => t?.name);
  if (addressTurn(names)) return true;
  if ((turn?.record?.trace || []).some((s) => /^(?:look up address|block report)\b/.test(String(s?.tool || '')))) return true;
  return publicTextViolations(String(turn?.question || ''), { streets }).some((c) => PLACE_CODES.has(c));
}

/** Whether any turn of a conversation looked up an address: then every turn's legislation and meeting pages may come from it. */
export function conversationByAddress(conv, streets) {
  return (Array.isArray(conv?.turns) ? conv.turns : []).some((t) => turnByAddress(t, streets));
}

// ---- The scopes ----

/**
 * Answered public questions for prior_research. Only questions whose text
 * passes the public-text checks; only sources that could point at no address
 * or person (none of a thread's legislation or meeting pages when any
 * question in that thread looked one up). Matched on the question, the
 * answer and the source titles, but neither text comes back: each match is
 * { day, page, sources }, the page being the question's own (/q/<id>), so a
 * question withdrawn later is gone from here too.
 */
export async function searchPublic(db, city, terms, { streets, pageBase, limit = MAX_MATCHES } = {}) {
  if (!db || !terms?.length) return [];
  const where = terms.map(() => "question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\' OR record LIKE ? ESCAPE '\\'").join(' OR ');
  const { results = [] } = (await db.prepare(
    `SELECT id, day, question, answer, record, tools, question_uri, root_uri FROM public_questions WHERE status = 'answered' AND city = ? AND (${where}) ORDER BY seq DESC LIMIT 40`
  ).bind(city, ...terms.flatMap((t) => [likeTerm(t), likeTerm(t), likeTerm(t)])).all()) || {};
  const rows = results.filter((row) => PUBLIC_ID_RE.test(String(row.id)) && !publicTextViolations(String(row.question || ''), { streets }).length);
  // Threads that looked up an address anywhere: a follow-up carries its root's results.
  const threadOf = (row) => row.root_uri || row.question_uri;
  const roots = [...new Set(rows.map(threadOf).filter(Boolean))];
  const byAddress = new Set();
  if (roots.length) {
    const marks = roots.map(() => '?').join(', ');
    const { results: thread = [] } = (await db.prepare(
      `SELECT question_uri, root_uri, question, json_extract(record, '$.trace') AS trace, tools FROM public_questions WHERE root_uri IN (${marks}) OR question_uri IN (${marks}) LIMIT ${THREAD_ROWS}`
    ).bind(...roots, ...roots).all()) || {};
    for (const t of thread) {
      const tools = parse(t.tools, []);
      const trace = parse(t.trace, []);
      if (turnByAddress({ tools: Array.isArray(tools) ? tools : [], record: { trace: Array.isArray(trace) ? trace : [] }, question: t.question }, streets)) byAddress.add(threadOf(t));
    }
  }
  const found = [];
  for (const row of rows) {
    const record = parse(row.record, {});
    const sources = topicSources(record?.resources || {}, { filter: true, byAddress: byAddress.has(threadOf(row)), streets });
    if (!sources.length) continue;
    const score = scoreTexts([row.question, row.answer, ...sources.map((s) => s.title)], terms);
    if (!enough(score, terms)) continue;
    found.push({ score, match: { day: row.day, page: `${pageBase}/q/${row.id}`, sources: sources.slice(0, MAX_SOURCES).map((s) => ({ ...s, read: row.day })) } });
  }
  // Best first; the query's order (newest first) breaks ties.
  return found.sort((a, b) => b.score - a.score).slice(0, limit).map((f) => f.match);
}

/** The normalized URLs a steward removed (shared_sources status 'removed'). */
export async function removedUrls(db) {
  const { results = [] } = (await db.prepare("SELECT url_key FROM shared_sources WHERE status = 'removed'").all()) || {};
  return new Set(results.map((r) => r.url_key));
}

/** Listed shared sources for prior_research, matched on their titles: each its own { day, sources: [one] }. */
export async function searchShared(db, city, terms, { limit = MAX_MATCHES * 2 } = {}) {
  if (!db || !terms?.length) return [];
  const { results = [] } = (await db.prepare(
    `SELECT title, url, kind, read_day FROM shared_sources WHERE status = 'listed' AND city = ? AND (${terms.map(() => "title LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY last_day DESC, seq DESC LIMIT 40`
  ).bind(city, ...terms.map(likeTerm)).all()) || {};
  return results
    .map((r) => ({ score: scoreTexts([r.title], terms), r }))
    .filter((x) => enough(x.score, terms))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r }) => ({ day: r.read_day, sources: [{ title: r.title, url: r.url, kind: r.kind, read: r.read_day }] }));
}

/**
 * What ask() takes as `priorResearch` for one answer, or null when no scope
 * is on: the scopes, whether the trace may show the words searched (a
 * private answer), and the search. `uid` is the signed-in account (the
 * account scope); `exclude` the conversation being answered. A scope that
 * fails to read is left out of the result, logged with a fixed line (never
 * the words searched).
 */
export function priorResearchFor(env, { uid = null, city, exclude = null, streets, publicOn = false, private: priv = true, pageBase = '' } = {}) {
  if (priorResearchOff(env)) return null;
  const scopes = [];
  if (uid && env.LIMITS && accountResearchOn(env)) scopes.push('account');
  if (publicOn && env.SIREN_DB) scopes.push('public');
  if (sharedResearchReady(env)) scopes.push('shared');
  if (!scopes.length) return null;
  return {
    scopes,
    private: priv,
    streets,
    async search(terms, { scopes: want = scopes } = {}) {
      const out = {};
      const run = (scope, job) => job.then((r) => { out[scope] = r; }, () => console.error(`prior research: the ${scope} scope could not be read`));
      await Promise.all([
        want.includes('account') && scopes.includes('account') ? run('account', researchInConversations(env.LIMITS, uid, terms, { exclude })) : null,
        want.includes('public') && scopes.includes('public') ? run('public', searchPublic(env.SIREN_DB, city, terms, { streets, pageBase })) : null,
        want.includes('shared') && scopes.includes('shared') ? run('shared', searchShared(env.SIREN_DB, city, terms)) : null,
      ]);
      // A source a steward removed leaves every scope, whether or not shared
      // research is still on. The removals must be read: if they can't be,
      // nothing comes back. Only a database without the table (migration 0005
      // not applied, so nothing was ever removed) goes without them.
      if (!env.SIREN_DB || !Object.keys(out).length) return out;
      let removed;
      try {
        removed = await removedUrls(env.SIREN_DB);
      } catch (err) {
        if (!sharedResearchReady(env) && /no such table/i.test(String(err?.message || err))) return out;
        console.error('prior research: removed sources could not be read');
        return {};
      }
      for (const scope of Object.keys(out)) {
        out[scope] = (out[scope] || [])
          .map((m) => ({ ...m, sources: (m.sources || []).filter((x) => !removed.has(sourceKey(x.url))) }))
          .filter((m) => m.sources.length);
      }
      return out;
    },
  };
}

// ---- Sharing ----

/**
 * Store a saved turn's shareable sources: an upsert per source, by URL. A
 * removed source stays removed. -> how many were written.
 */
export async function storeShared(db, { city, sources, readDay, now = Date.now() }) {
  const day = dayOf(now);
  // Keyed by sourceKey (src/prior-research.js), as every
  // dedupe and removal check is: "…/page" and "…/page/" are one source.
  const stmts = sources.map((s) => db.prepare(
    `INSERT INTO shared_sources (id, url_key, url, title, kind, city, read_day, first_day, last_day, shares, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'listed')
     ON CONFLICT (url_key) DO UPDATE SET title = excluded.title, kind = excluded.kind, read_day = max(shared_sources.read_day, excluded.read_day), last_day = excluded.last_day, shares = shared_sources.shares + 1
     WHERE shared_sources.status = 'listed'`
  ).bind(newPublicId(), sourceKey(s.url), s.url, s.title, s.kind, city, readDay, day, day));
  if (!stmts.length) return 0;
  await db.batch(stmts);
  return stmts.length;
}

const sameSite = (req, env) => {
  const o = req.headers.get('Origin');
  return o === null || o === new URL(req.url).origin || o === publicOrigin(env)?.origin;
};

/**
 * POST /api/research/share {conversation, at}: the signed-in account shares
 * one saved answer's sources. 503 with the feature off or not set up; 401
 * signed out; 404 for a conversation it doesn't have; 409 while the answer
 * is still being saved; 429 past SHARE_DAILY (counted only when something is
 * shared). An answer counts once: sharing it again changes nothing
 * (`already_shared`), under a key that is an HMAC of the account, the
 * conversation and the answer, so it can't be joined to any of them.
 * Legislation and meeting pages are kept only when no turn of the
 * conversation looked up an address. `streetsFor(city)` gives the city's
 * compiled street names. -> { shared, left_out } or { shared: 0, already_shared }.
 */
export async function handleShare(req, env, { streetsFor = () => undefined, now = Date.now() } = {}) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!sharedResearchReady(env)) return json({ error: "Sharing sources isn't on here yet." }, 503, headers);
  if (!(req.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) return json({ error: 'Send JSON.' }, 415, headers);
  if (!sameSite(req, env)) return json({ error: 'Share from this site.' }, 403, headers);
  const uid = await currentUser(req, env);
  if (!uid) return json({ error: 'Sign in to share sources.' }, 401, headers);
  let body;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body.at !== 'string' || !AT.test(body.at)) return json({ error: 'Say which answer to share.' }, 400, headers);
  const conv = await loadConversation(env.LIMITS, uid, body.conversation);
  if (!conv) return json({ error: 'That conversation could not be found.' }, 404, headers);
  const turn = (conv.turns || []).find((t) => t.at === body.at);
  if (!turn) return json({ error: 'This answer is still being saved. Try again in a moment.' }, 409, headers);
  // The city's street names, so addresses written without a house number are caught too.
  const streets = streetsFor(String(conv.city || ''));
  const all = topicSources(turn.record?.resources || {});
  const sources = topicSources(turn.record?.resources || {}, { filter: true, byAddress: conversationByAddress(conv, streets), streets }).slice(0, SHARE_MAX);
  if (!sources.length) return json({ shared: 0, left_out: all.length }, 200, headers);
  const turnKey = `share-turn:${await hmacHex(env.INVITE_SECRET, `share-turn:${uid}:${body.conversation}:${body.at}`, 32)}`;
  if (await env.LIMITS.get(turnKey)) return json({ shared: 0, already_shared: true }, 200, headers);
  const charged = await chargeSearch(env.LIMITS, env.INVITE_SECRET, uid, { now, daily: SHARE_DAILY, name: 'share-rate' });
  if (charged === 'limit') return json({ error: `You've shared ${SHARE_DAILY} answers' sources today, the daily limit. It resets at midnight UTC.` }, 429, headers);
  if (charged === 'busy') return json({ error: 'Too many at once. Try again in a moment.' }, 503, headers);
  try {
    const shared = await storeShared(env.SIREN_DB, { city: String(conv.city || ''), sources, readDay: turn.at.slice(0, 10), now });
    await env.LIMITS.put(turnKey, '1', { expirationTtl: SHARED_TURN_TTL }).catch(() => console.error('shared research: the shared answer could not be marked'));
    return json({ shared, left_out: Math.max(0, all.length - shared) }, 200, headers);
  } catch {
    console.error('shared research: the share could not be stored');
    return json({ error: "The sources couldn't be shared just now. Try again in a minute." }, 503, headers);
  }
}

const listView = (r) => ({ id: r.id, title: r.title, url: r.url, kind: r.kind, city: r.city, read_day: r.read_day, first_day: r.first_day, last_day: r.last_day, shares: Number(r.shares) || 1 });

/**
 * GET /api/research?city=&limit=&before=: the listed shared sources, last
 * shared first (then newest row first), as { sources, next }: next is the
 * `before` for the page after ("<last_day>.<seq>"), or null. A source shared
 * again between two pages moves to the top, so paging can miss or repeat
 * it. Public; nothing about who shared. 503 when not set up.
 */
export async function handleResearchList(req, env, { cities = [] } = {}) {
  const off = { 'Cache-Control': 'no-store', ...NOINDEX };
  if (!sharedResearchReady(env)) return json({ error: "Shared research isn't on here yet." }, 503, off);
  const url = new URL(req.url);
  const city = url.searchParams.get('city') || cities[0] || '';
  if (!cities.includes(city)) return json({ error: `This site doesn't serve "${city.slice(0, 40)}".` }, 400, off);
  const lim = /^\d{1,3}$/.test(url.searchParams.get('limit') || '') ? Math.min(Math.max(Number(url.searchParams.get('limit')), 1), LIST_MAX) : LIST_DEFAULT;
  const cursor = /^(\d{4}-\d{2}-\d{2})\.(\d{1,15})$/.exec(url.searchParams.get('before') || '');
  const COLS = 'seq, id, title, url, kind, city, read_day, first_day, last_day, shares';
  try {
    const { results = [] } = (await (cursor
      ? env.SIREN_DB.prepare(`SELECT ${COLS} FROM shared_sources WHERE status = 'listed' AND city = ? AND (last_day < ? OR (last_day = ? AND seq < ?)) ORDER BY last_day DESC, seq DESC LIMIT ?`).bind(city, cursor[1], cursor[1], Number(cursor[2]), lim + 1)
      : env.SIREN_DB.prepare(`SELECT ${COLS} FROM shared_sources WHERE status = 'listed' AND city = ? ORDER BY last_day DESC, seq DESC LIMIT ?`).bind(city, lim + 1)
    ).all()) || {};
    const page = results.slice(0, lim);
    const last = page.at(-1);
    return json({ sources: page.map(listView), next: results.length > lim ? `${last.last_day}.${last.seq}` : null }, 200, { 'Cache-Control': 'public, max-age=60', ...NOINDEX });
  } catch {
    console.error('shared research: the list could not be read');
    return json({ error: "Shared research can't be read just now. Try again in a minute." }, 503, off);
  }
}

/**
 * The steward's API: GET /api/admin/research (every source, removed ones
 * too, newest first) and POST /api/admin/research/remove or .../restore
 * {id}. Signed-in stewards only (ADMIN_EMAILS); never cached.
 */
export async function handleAdminResearch(req, env, path) {
  const headers = { 'Cache-Control': 'no-store', ...NOINDEX };
  if (!sharedResearchReady(env)) return json({ error: "Shared research isn't on here yet." }, 503, headers);
  const uid = await currentUser(req, env);
  if (!uid) return json({ error: 'Sign in first.', signin: true }, 401, headers);
  if (!(await isAdmin(env, uid))) return json({ error: 'This account is not a steward here.' }, 403, headers);
  const unreadable = () => {
    console.error('shared research: the steward could not read or write D1');
    return json({ error: "Shared sources can't be read or changed just now. Try again in a minute." }, 503, headers);
  };
  if (req.method === 'GET' && path === '/api/admin/research') {
    try {
      const { results = [] } = (await env.SIREN_DB.prepare('SELECT id, title, url, kind, city, read_day, first_day, last_day, shares, status FROM shared_sources ORDER BY seq DESC LIMIT ?').bind(STEWARD_ROWS).all()) || {};
      return json({ sources: results.map((r) => ({ ...listView(r), status: r.status })) }, 200, headers);
    } catch {
      return unreadable();
    }
  }
  if (req.method === 'POST' && (path === '/api/admin/research/remove' || path === '/api/admin/research/restore')) {
    if (!sameSite(req, env)) return json({ error: "Act from this site's own steward page." }, 403, headers);
    let body;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    if (!body || !PUBLIC_ID_RE.test(String(body.id))) return json({ error: 'Give the source id.' }, 400, headers);
    const [to, from] = path.endsWith('/remove') ? ['removed', 'listed'] : ['listed', 'removed'];
    let res;
    try {
      res = await env.SIREN_DB.prepare('UPDATE shared_sources SET status = ? WHERE id = ? AND status = ?').bind(to, body.id, from).run();
    } catch {
      return unreadable();
    }
    if (res?.meta?.changes !== 1) return json({ error: `No ${from} source with that id.` }, 404, headers);
    return json({ ok: true, status: to }, 200, headers);
  }
  return json({ error: 'Not found' }, 404, headers);
}
