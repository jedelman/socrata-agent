// The free tier's public questions in D1 (SIREN_DB, migration
// 0004_public_questions.sql; docs/free-tier.md, "What is stored"). One row
// per question record: the record's AT-URI and CID, the asker's DID and
// handle, the city, the question (the record's own text), the answer and
// the record shown under it, a status and the day; for a follow-up, its
// thread's root and parent (by AT-URI) and its depth; and, internal and
// never served, the answer's tool results for follow-ups to get back.
//
// Every statement here binds only those values, a random public id, a day
// and a ten-minute step: never an invite, a visitor hash, an email account
// or a conversation (test/public-ask.test.js reads every statement the
// public routes run). Pure: every call takes the D1 binding.

import { newPublicId, PUBLIC_ID_RE } from './requests.js';
import { CONTEXT_TURNS } from './conversations.js';

/** A public question id: 16 base32 characters, random (the request ids' shape). */
export const QUESTION_ID_RE = PUBLIC_ID_RE;
/** checked_ms is kept to steps this long, so it gives no exact time. */
export const CHECK_STEP_MS = 10 * 60e3;
/** A claim still "answering" this long after it was made was abandoned (the request died). */
export const STALE_CLAIM_MS = 30 * 60e3;
export const PAGE_SIZE = 20;
/** At most this many questions in one thread, the root included, whatever their status. */
export const THREAD_MAX = 25;
/** A root is depth 0; a follow-up at most this deep. */
export const DEPTH_MAX = 10;
const ANSWER_CHARS = 8000;
const STEWARD_ROWS = 200;
// Each tool result kept for follow-ups, as a private conversation keeps it
// (worker/conversations.js RESULT_CHARS).
const RESULT_CHARS = 6000;
const QUESTION_CHARS = 600;
/** What a withdrawn question's URI becomes wherever another row names it. */
export const withdrawnRef = (id) => `withdrawn:${id}`;

export const stepOf = (now) => Math.floor(now / CHECK_STEP_MS) * CHECK_STEP_MS;
export const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

// Every column the routes read. `tools` is left out: it is read only to
// build a follow-up's context (threadOf with tools), never served.
const COLS = 'seq, id, question_uri, question_cid, did, handle, city, question, answer, record, status, day, checked_ms, root_uri, parent_uri, depth';

/** The key a thread is known by: its root's AT-URI, or 'withdrawn:<id>' once the root is withdrawn. */
export const threadKey = (row) => row.root_uri || row.question_uri || withdrawnRef(row.id);

/**
 * Claim a question record before answering it (unique on its AT-URI).
 * Abandoned claims are cleared first. A follow-up (`reply`: { rootUri,
 * parentUri, depth }) is claimed only while its thread holds fewer than
 * THREAD_MAX questions, checked in the same statement. -> { state:
 * 'claimed', id } for a new claim, { state: <the existing row's status>,
 * row } when the record was claimed before ('answering', 'answered' or
 * 'hidden'), or { state: 'thread_full' }.
 */
export async function claimQuestion(db, { uri, cid, did, handle, city, question, reply = null, now = Date.now() }) {
  await db.prepare("DELETE FROM public_questions WHERE status = 'answering' AND checked_ms < ?").bind(stepOf(now) - STALE_CLAIM_MS).run();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newPublicId();
    const values = [id, uri, cid, did, handle ?? null, city, question, dayOf(now), stepOf(now), reply?.rootUri ?? null, reply?.parentUri ?? null, reply ? reply.depth : 0];
    let res;
    try {
      res = reply
        ? await db.prepare(
          "INSERT INTO public_questions (id, question_uri, question_cid, did, handle, city, question, status, day, checked_ms, root_uri, parent_uri, depth) SELECT ?, ?, ?, ?, ?, ?, ?, 'answering', ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM public_questions WHERE root_uri = ? OR question_uri = ?) < ? ON CONFLICT (question_uri) DO NOTHING",
        ).bind(...values, reply.rootUri, reply.rootUri, THREAD_MAX).run()
        : await db.prepare(
          "INSERT INTO public_questions (id, question_uri, question_cid, did, handle, city, question, status, day, checked_ms, root_uri, parent_uri, depth) VALUES (?, ?, ?, ?, ?, ?, ?, 'answering', ?, ?, ?, ?, ?) ON CONFLICT (question_uri) DO NOTHING",
        ).bind(...values).run();
    } catch (err) {
      // An id already taken (80 random bits: in practice never): a new id.
      if (/UNIQUE/i.test(String(err?.message)) && attempt < 2) continue;
      throw err;
    }
    if (res?.meta?.changes === 1) return { state: 'claimed', id };
    const row = await getByUri(db, uri);
    if (row) return { state: row.status, row };
    if (reply) return { state: 'thread_full' };
    // Withdrawn or dropped between the two statements: try again.
  }
  throw new Error('public question: could not claim');
}

// The tool results kept for follow-ups: trimmed as a private conversation
// keeps them (worker/conversations.js saveTurn), never served.
const clipResult = (s) => (s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}… [trimmed: ${s.length - RESULT_CHARS} more characters]` : s);
export function keptTools(toolResults) {
  return (Array.isArray(toolResults) ? toolResults : []).map((t) => ({
    name: t.name,
    // note_unanswered keeps only what was noted, never the drafted question.
    args: t.name === 'note_unanswered' ? { answered: t.args?.answered, gaps: t.args?.gaps } : t.args,
    result: clipResult(String(t.content)),
  }));
}

/** Store the answer on a claim still being answered. -> whether it was stored (false: withdrawn meanwhile). */
export async function storeAnswer(db, id, { answer, record, tools = [], now = Date.now() }) {
  const res = await db.prepare(
    "UPDATE public_questions SET status = 'answered', answer = ?, record = ?, tools = ?, day = ?, checked_ms = ? WHERE id = ? AND status = 'answering'",
  ).bind(String(answer ?? '').slice(0, ANSWER_CHARS), JSON.stringify(record ?? {}), JSON.stringify(keptTools(tools)), dayOf(now), stepOf(now), id).run();
  return res?.meta?.changes === 1;
}

/**
 * Every question in the thread `row` belongs to, oldest first (the root
 * first). `tools`: also the internal tool results (for a follow-up's
 * context only).
 */
export async function threadOf(db, row, { tools = false } = {}) {
  const key = threadKey(row);
  const rootId = key.startsWith('withdrawn:') ? key.slice('withdrawn:'.length) : '';
  const { results } = await db.prepare(
    `SELECT ${COLS}${tools ? ', tools' : ''} FROM public_questions WHERE root_uri = ? OR question_uri = ? OR id = ? ORDER BY seq LIMIT ?`,
  ).bind(key, key, rootId, THREAD_MAX * 2).all();
  return results || [];
}

/** How many answered replies each of these roots has: Map(root uri -> n). */
export async function replyCounts(db, rootUris) {
  const uris = [...new Set(rootUris.filter(Boolean))].slice(0, PAGE_SIZE);
  if (!uris.length) return new Map();
  const { results } = await db.prepare(
    `SELECT root_uri, count(*) AS n FROM public_questions WHERE status = 'answered' AND root_uri IN (${uris.map(() => '?').join(', ')}) GROUP BY root_uri`,
  ).bind(...uris).all();
  return new Map((results || []).map((r) => [r.root_uri, Number(r.n)]));
}

/**
 * The chain from the thread's root down to `parent`, oldest first, and no
 * siblings: each row's parent is found by its parent_uri (an AT-URI, or
 * 'withdrawn:<id>'). -> rows, or null if the chain is broken.
 */
export function chainTo(thread, parent) {
  const byRef = new Map();
  for (const r of thread) {
    if (r.question_uri) byRef.set(r.question_uri, r);
    byRef.set(withdrawnRef(r.id), r);
  }
  const chain = [];
  let cur = parent;
  for (let i = 0; cur && i <= DEPTH_MAX; i++) {
    chain.unshift(cur);
    if (!cur.parent_uri) return chain;
    cur = byRef.get(cur.parent_uri);
  }
  return null;
}

/**
 * The history a follow-up's answer gets, the way a private conversation's
 * next question does (worker/conversations.js historyFrom): each earlier
 * question and answer in the chain, oldest first, its tool results as data.
 * A withdrawn question's text and answer never go in (nor a hidden one's):
 * it is skipped, and a note in its place says so. At most CONTEXT_TURNS turns (what a conversation feeds back),
 * the root kept and the nearest ancestors after it, as a conversation is
 * bounded. -> turns for historyFrom.
 */
export function contextTurns(chain) {
  const turns = [];
  let skipped = { withdrawn: 0, hidden: 0 };
  const flush = () => {
    const parts = [];
    if (skipped.withdrawn) parts.push(`${skipped.withdrawn === 1 ? 'an earlier question in this thread was' : `${skipped.withdrawn} earlier questions in this thread were`} withdrawn by ${skipped.withdrawn === 1 ? 'its asker' : 'their askers'}`);
    if (skipped.hidden) parts.push(`${skipped.hidden === 1 ? 'an earlier question was' : `${skipped.hidden} earlier questions were`} hidden by the steward`);
    if (parts.length) turns.push({ question: `[Siren's note, not a question: ${parts.join(', and ')}, so ${skipped.withdrawn + skipped.hidden === 1 ? 'its text and answer are' : 'their text and answers are'} left out here.]`, answer: '[Left out.]', tools: [], note: true });
    skipped = { withdrawn: 0, hidden: 0 };
  };
  for (const r of chain) {
    if (r.status !== 'answered') {
      if (r.status === 'hidden') skipped.hidden++;
      else skipped.withdrawn++;
      continue;
    }
    flush();
    let tools = [];
    try {
      const t = JSON.parse(r.tools || '[]');
      tools = Array.isArray(t) ? t : [];
    } catch {
      tools = [];
    }
    turns.push({ question: String(r.question ?? '').slice(0, QUESTION_CHARS), answer: String(r.answer ?? '').slice(0, ANSWER_CHARS), tools, at: r.day });
  }
  flush();
  if (turns.length <= CONTEXT_TURNS) return turns;
  return [turns[0], { question: `[Siren's note, not a question: ${turns.length - CONTEXT_TURNS} earlier exchanges in this thread are left out here, to keep within the size a conversation may carry.]`, answer: '[Left out.]', tools: [], note: true }, ...turns.slice(-(CONTEXT_TURNS - 2))];
}

/** A failed answer deletes its claim; the record stays in the asker's repo for them to delete. */
export async function dropClaim(db, id) {
  await db.prepare("DELETE FROM public_questions WHERE id = ? AND status = 'answering'").bind(id).run();
}

export async function getById(db, id) {
  if (typeof id !== 'string' || !QUESTION_ID_RE.test(id)) return null;
  return (await db.prepare(`SELECT ${COLS} FROM public_questions WHERE id = ?`).bind(id).first()) || null;
}

export async function getByUri(db, uri) {
  if (typeof uri !== 'string' || !uri) return null;
  return (await db.prepare(`SELECT ${COLS} FROM public_questions WHERE question_uri = ?`).bind(uri).first()) || null;
}

/**
 * One page of the public list: answered rows only, newest first. `before`
 * is the cursor (a seq). -> { rows, cursor (the next page's, or null) }.
 */
export async function listPublic(db, { before = null, limit = PAGE_SIZE } = {}) {
  const stmt = Number.isSafeInteger(before) && before > 0
    ? db.prepare(`SELECT ${COLS} FROM public_questions WHERE status = 'answered' AND depth = 0 AND seq < ? ORDER BY seq DESC LIMIT ?`).bind(before, limit + 1)
    : db.prepare(`SELECT ${COLS} FROM public_questions WHERE status = 'answered' AND depth = 0 ORDER BY seq DESC LIMIT ?`).bind(limit + 1);
  const results = (await stmt.all())?.results || [];
  const rows = results.slice(0, limit);
  return { rows, cursor: results.length > limit ? String(rows.at(-1).seq) : null };
}

/**
 * The asker withdrew it (or deleted the record elsewhere): keep only the id,
 * the day, the status and its place in the thread. Every other column is
 * emptied, the record's URI and the asker's DID included, and every other
 * row that named its URI (its replies, and theirs) names 'withdrawn:<id>'
 * instead, so its replies stay in the thread. -> whether a row changed.
 */
export async function withdrawQuestion(db, id) {
  const row = await getById(db, id);
  if (!row || !['answering', 'answered', 'hidden'].includes(row.status)) return false;
  const ref = withdrawnRef(row.id);
  const [res] = await db.batch([
    db.prepare(
      "UPDATE public_questions SET status = 'withdrawn', question_uri = NULL, question_cid = NULL, did = NULL, handle = NULL, city = NULL, question = NULL, answer = NULL, record = NULL, tools = NULL, checked_ms = 0 WHERE id = ? AND status IN ('answering', 'answered', 'hidden')",
    ).bind(row.id),
    db.prepare('UPDATE public_questions SET root_uri = ? WHERE root_uri = ?').bind(ref, row.question_uri),
    db.prepare('UPDATE public_questions SET parent_uri = ? WHERE parent_uri = ?').bind(ref, row.question_uri),
  ]);
  return res?.meta?.changes === 1;
}

/** The record was confirmed present (or couldn't be checked): don't check again for a while. */
export async function markChecked(db, id, now = Date.now()) {
  await db.prepare("UPDATE public_questions SET checked_ms = ? WHERE id = ? AND status = 'answered'").bind(stepOf(now), id).run();
}

/** The steward hides an answered question, or unhides a hidden one. -> the new status, or null. */
export async function setHidden(db, id, hidden) {
  const [from, to] = hidden ? ['answered', 'hidden'] : ['hidden', 'answered'];
  const res = await db.prepare('UPDATE public_questions SET status = ? WHERE id = ? AND status = ?').bind(to, id, from).run();
  return res?.meta?.changes === 1 ? to : null;
}

/** Every row, newest first, for the steward. */
export async function listAll(db, limit = STEWARD_ROWS) {
  return (await db.prepare(`SELECT ${COLS} FROM public_questions ORDER BY seq DESC LIMIT ?`).bind(limit).all())?.results || [];
}

const parseRecord = (s) => {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/**
 * An answered row as the public sees it, with the asker's flags (or null
 * when they couldn't be read). `extra`: its place in a thread (parent: the
 * parent's public id), a root's reply count, and `followup`, the strongRefs
 * a follow-up to it carries (null when its thread takes none).
 */
export function publicView(row, flags = null, extra = {}) {
  return {
    id: row.id,
    uri: row.question_uri,
    cid: row.question_cid,
    day: row.day,
    did: row.did,
    handle: row.handle || null,
    city: row.city,
    question: row.question,
    answer: row.answer,
    record: parseRecord(row.record),
    flags: Array.isArray(flags) ? flags : null,
    depth: Number(row.depth) || 0,
    ...extra,
  };
}

/** A withdrawn or hidden question in a thread: a placeholder, with its place kept and nothing else. */
export function placeholderView(row, extra = {}) {
  return { id: row.id, [row.status === 'hidden' ? 'hidden' : 'withdrawn']: true, depth: Number(row.depth) || 0, ...extra };
}

/** A row as the steward sees it: everything public, plus the status. */
export function stewardView(row) {
  return { id: row.id, status: row.status, day: row.day, did: row.did, handle: row.handle || null, city: row.city, question: row.question, answer: row.answer, uri: row.question_uri, depth: Number(row.depth) || 0 };
}
