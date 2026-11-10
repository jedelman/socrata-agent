// The free tier, the Worker's side (docs/free-tier.md): asking in public with
// a Bluesky sign-in and an invite, behind PUBLIC_ASK (off by default). Every
// question and answer is public, on Siren's own site: a row in D1 SIREN_DB
// (questions.js) and a page at /q/<id>.
//
// The Worker never holds a Bluesky token, and no route here reads an
// Authorization or DPoP header. Who asked is proven by the question record
// in the asker's own repo: the browser writes it, posts its AT-URI and CID,
// and the Worker reads it itself from the PDS the re-resolved DID document
// names (atproto-identity.js, the hardened resolver endorsements use). The
// answer is to the record's text, never the POST body's.
//
// The request carries the invite cookie and the question's author at once:
// the invite is checked exactly as /api/ask checks it (the cookie, the same
// per-invite daily count and the same daily budget), and neither is ever
// stored or logged beside the other. No D1 statement here binds an invite or
// a visitor hash, no KV key or value written here holds a DID or a handle,
// and nothing logged names either. The email account is never read on these
// routes (only the steward's, on the steward's own routes).
//
// Follow-ups (Jason, 2026-11-10): any signed-in asker with an invite may ask
// a follow-up on any answered public question, as a threaded reply. The
// record's `reply` names the parent and the thread's root by strongRef;
// both must be answered public questions here, at those CIDs, the root must
// be the parent's root, and the thread stays under THREAD_MAX questions and
// DEPTH_MAX deep. The answer gets the chain from the root down to the parent
// as history, the way a private conversation's next question does, with no
// siblings, no askers' names, and no withdrawn or hidden question's text.
//
// Every outbound fetch is counted (src/request-budget.js): on an ask, the
// verification fetches go through the answer's own counter, which ask()
// then carries on with; elsewhere through a small counter of their own.
// The route handlers live here, not in index.js, so tests can drive them.

import { safeFetch, resolveDidDoc, docPds, docHandle, resolveHandle, isSupportedDid } from './atproto-identity.js';
import { QUESTION_NSID, validQuestion, parseRecordUri, TID_RE, CID_RE } from './endorse-config.js';
import { publicOrigin, clientIds, clientMetadata } from './atproto-oauth.js';
import { blueskyReady } from './bluesky.js';
import { currentInvite, redeem, sessionCookie, signSession } from './invites.js';
import { isAdmin, currentUser } from './accounts.js';
import { setting, spentToday, recordSpend, visitorId } from './limits.js';
import { boundary, hmacHex } from './crypto.js';
import { mapLimit } from './public-list.js';
import { answerRecord, historyFrom } from './conversations.js';
import { getProfiles, flagsFor, appviewOrigin, youngDays } from './endorsers.js';
import { userAgent } from './constellation.js';
import { requestBudget } from '../src/request-budget.js';
import {
  QUESTION_ID_RE, THREAD_MAX, DEPTH_MAX, claimQuestion, storeAnswer, dropClaim, getById, getByUri, listPublic, withdrawQuestion, markChecked,
  setHidden, listAll, publicView, placeholderView, stewardView, dayOf, threadOf, chainTo, contextTurns, threadCounts, withdrawnRef,
  staleRows, clearStaleClaims, SWEEP_AGE_MS,
} from './questions.js';

/** A record older than this is refused as a replay. */
export const FRESH_MS = 10 * 60e3;
/** A browser clock a little ahead is allowed; past this, "dated in the future". */
export const FUTURE_SKEW_MS = 60e3;
/** /q/<id> re-checks the record when the last check is older than this. */
export const RECHECK_MS = 10 * 60e3;
/**
 * Outbound requests one record check may make: the DID document, one
 * getRecord, and the handle's two lookups (DNS and the well-known, with its
 * redirects).
 */
export const CHECK_BUDGET = 8;
/** At most this many stale questions re-checked on one page view (its thread). */
export const PAGE_RECHECKS = 10;
/** The sweep's batch, its concurrency and its time. */
export const SWEEP_BATCH = 40;
const SWEEP_CONCURRENCY = 6;
export const SWEEP_DEADLINE_MS = 25000;
const PROFILE_SECONDS = 300;
const ANSWER_CHARS = 8000;
const CURSOR_RE = /^[1-9][0-9]{0,15}$/;

/** The flag: only "true" turns the free tier on. */
export const publicAskOn = (env) => env?.PUBLIC_ASK === 'true';
const inviteMode = (env) => env?.INVITE_REQUIRED === 'true' && !env.ACCESS_TEAM_DOMAIN;
const hasDb = (env) => typeof env?.SIREN_DB?.prepare === 'function';

/** The flag and everything it needs: Bluesky sign-in, SIREN_DB, invite mode and its secret. */
export function publicAskReady(env) {
  return publicAskOn(env) && blueskyReady(env) && hasDb(env) && inviteMode(env) && Boolean(env.INVITE_SECRET);
}

/** With PUBLIC_ASK "true" but something missing, what's missing, by name only, for the log; else null. */
export function publicAskSetupError(env) {
  if (!publicAskOn(env) || publicAskReady(env)) return null;
  const missing = [
    ...(blueskyReady(env) ? [] : ['Bluesky sign-in (BLUESKY_LOGIN and what it needs)']),
    ...(hasDb(env) ? [] : ['SIREN_DB']),
    ...(inviteMode(env) ? [] : ['invite mode (INVITE_REQUIRED = "true", without Cloudflare Access)']),
    ...(env.INVITE_SECRET ? [] : ['INVITE_SECRET']),
  ];
  return `PUBLIC_ASK is "true" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing, so asking in public is off (docs/free-tier.md).`;
}

// Fixed sentences; remote text never reaches a person.
export const ASK_ERRORS = {
  not_set_up: "Asking in public isn't set up here yet.",
  not_here: "Ask from this site's own page.",
  bad_body: 'Send the question record\'s address and version: {"uri": "at://…", "cid": "…"}.',
  invite: 'Asking needs an invite for now. Enter your invite code, or join the waitlist on the main page.',
  no_model: 'This site is not configured yet (no model key).',
  busy: 'Lots of questions right now. Try again in a minute.',
  unavailable: "Public questions can't be read just now. Try again in a minute.",
  bad_uri: "That isn't the address of a question record.",
  wrong_collection: "That record isn't a question for this site.",
  no_pds: "That account doesn't name a server I can read.",
  not_found: "I couldn't find that question record on the asker's server.",
  wrong_cid: "That record isn't the version that was sent.",
  malformed: "That record isn't a question I can answer: a question of 1 to 600 characters, and nothing else.",
  stale: 'That question record is more than 10 minutes old. Ask again to write a new one.',
  future: 'That question record is dated in the future. Check your clock, and ask again.',
  bad_city: "This site doesn't serve the city that record names.",
  unreachable: "I couldn't reach the asker's server. Try again in a minute.",
  answering: 'This question is still being answered. Look for it on the list in a minute.',
  hidden: "This question isn't public.",
  withdrawn_meanwhile: 'The question was withdrawn while it was being answered, so nothing was kept.',
  still_there: 'That question record is still in its account. Delete it there first.',
  not_listed: 'No public question has that address.',
  not_found_page: 'No public question has that id.',
  bad_cursor: "That page link isn't valid. Start from the first page.",
  parent_not_public: "That question isn't answered and public here, so it takes no follow-ups.",
  parent_mismatch: "That follow-up names a version of a question that isn't the one published here.",
  root_mismatch: "That follow-up's thread doesn't match the question it replies to.",
  thread_city: 'A follow-up asks about the same city as the rest of its thread.',
  thread_deep: `That thread is as deep as it goes (${DEPTH_MAX} follow-ups in a row). Ask a new question instead.`,
  thread_full: `That thread is full (${THREAD_MAX} questions). Ask a new question instead.`,
  parent_gone: 'The question this follows up was withdrawn or hidden while it was being answered, so nothing was kept.',
};
const STATUS = {
  not_set_up: 503, not_here: 403, bad_body: 400, no_model: 503, busy: 429, unavailable: 503, bad_uri: 400, wrong_collection: 400,
  no_pds: 400, not_found: 404, wrong_cid: 400, malformed: 400, stale: 400, future: 400, bad_city: 400, unreachable: 502,
  answering: 409, hidden: 409, withdrawn_meanwhile: 410, still_there: 409, not_listed: 404, not_found_page: 404, bad_cursor: 400,
  parent_not_public: 409, parent_mismatch: 400, root_mismatch: 400, thread_city: 400, thread_deep: 409, thread_full: 409, parent_gone: 409,
};

/** Public, but not put in search engines (Jason, docs/free-tier.md). */
export const NOINDEX = { 'X-Robots-Tag': 'noindex' };
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...NOINDEX, ...headers } });
const fail = (code) => json({ error: ASK_ERRORS[code], code }, STATUS[code] || 400);

/** The routes' answer with the flag on but something missing: 503, and why in the log (names only). */
export function notReady(env) {
  const why = publicAskSetupError(env);
  if (why) console.error('public ask:', why);
  return fail('not_set_up');
}

async function readJson(req) {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false; // fail closed
  }
}

/**
 * The per-visitor limit (BSKY_VISITOR_RL), as the endorsement routes charge
 * it: keyed by a hash of the visitor in its own domain, only ever a limiter
 * key, never stored or logged. -> whether this visitor may make Siren fetch.
 */
async function visitorAllowed(req, env) {
  if (!req) return true;
  const visitor = await hmacHex(env.IP_SALT, `bsky-q:${visitorId(req.headers.get('CF-Connecting-IP'))}`, 32);
  return allowed(env.BSKY_VISITOR_RL, `q:${visitor}`);
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// For the log: an error's message, cut short. Never a DID, handle or invite:
// the callers log only errors from D1 and the model provider.
const clip = (err) => String(err?.message || err || 'unknown').slice(0, 200);

const plcUrl = (env) => env.PLC_URL || 'https://plc.directory';
const sameOrigin = (req, env) => {
  const o = req.headers.get('Origin');
  return o === null || o === publicOrigin(env).origin;
};

/** The page of a public question: from PUBLIC_ORIGIN, never the Host header. */
export const questionUrl = (env, base, id) => `${publicOrigin(env).origin}${base}/q/${id}`;

/**
 * Read a question record from the PDS the DID document names, at that CID.
 * -> { doc, value } or { error } (not_found also carries the doc).
 */
async function readQuestion(env, { did, collection, rkey, uri, cid, fetchImpl }) {
  let doc;
  try {
    doc = await resolveDidDoc(did, { fetchImpl, plcUrl: plcUrl(env) });
  } catch {
    return { error: 'unreachable' };
  }
  const pds = docPds(doc);
  if (!pds) return { error: 'no_pds' };
  const u = new URL('/xrpc/com.atproto.repo.getRecord', pds);
  u.searchParams.set('repo', did);
  u.searchParams.set('collection', collection);
  u.searchParams.set('rkey', rkey);
  if (cid) u.searchParams.set('cid', cid);
  let res;
  try {
    res = await safeFetch(u.href, { fetchImpl, maxBytes: 16384 });
  } catch {
    return { error: 'unreachable' };
  }
  const body = parse(res.text);
  if (res.status === 400 && body?.error === 'RecordNotFound') return { error: 'not_found', doc };
  if (res.status !== 200 || !body || typeof body !== 'object' || Array.isArray(body)) return { error: 'unreachable' };
  if (uri && body.uri !== uri) return { error: 'malformed' };
  if (cid && body.cid !== cid) return { error: 'wrong_cid' };
  return { doc, value: body.value };
}

/**
 * The record by its key, any version: { state: 'gone' (a clear
 * RecordNotFound from the PDS the DID document names), 'present' (with the
 * DID document), or 'unknown' (couldn't check) }.
 */
async function recordState(env, { did, collection, rkey }, fetchImpl) {
  const got = await readQuestion(env, { did, collection, rkey, fetchImpl });
  if (got.error === 'not_found') return { state: 'gone' };
  if (got.error) return { state: 'unknown' };
  return { state: 'present', doc: got.doc };
}

/** The handle the DID document claims, verified both ways (the handle resolves back to the DID), or null. */
async function verifiedHandle(env, doc, did, fetchImpl) {
  const claimed = docHandle(doc);
  if (!claimed) return null;
  try {
    return (await resolveHandle(claimed, { fetchImpl, dohUrl: env.DOH_URL || 'https://cloudflare-dns.com/dns-query' })) === did ? claimed : null;
  } catch {
    return null;
  }
}

/**
 * A follow-up's thread, checked against D1: the parent and the root answered
 * and public, at the CIDs the record names, the root the parent's own, the
 * same city, under the caps. -> { reply: { rootUri, parentUri, depth },
 * turns (its context, for historyFrom) } or { error }.
 */
async function followUp(db, rec) {
  const [parent, root] = await Promise.all([getByUri(db, rec.reply.parent.uri), getByUri(db, rec.reply.root.uri)]);
  if (!parent || parent.status !== 'answered' || !root || root.status !== 'answered') return { error: 'parent_not_public' };
  if (parent.question_cid !== rec.reply.parent.cid || root.question_cid !== rec.reply.root.cid) return { error: 'parent_mismatch' };
  if (Number(root.depth) !== 0 || (parent.root_uri || parent.question_uri) !== root.question_uri) return { error: 'root_mismatch' };
  if (rec.city !== root.city) return { error: 'thread_city' };
  if (Number(parent.depth) + 1 > DEPTH_MAX) return { error: 'thread_deep' };
  const thread = await threadOf(db, root, { tools: true });
  if (thread.length >= THREAD_MAX) return { error: 'thread_full' };
  const chain = chainTo(thread, thread.find((r) => r.id === parent.id));
  if (!chain || chain[0].id !== root.id) return { error: 'root_mismatch' };
  return {
    reply: { rootUri: root.question_uri, rootCid: root.question_cid, parentUri: parent.question_uri, parentCid: parent.question_cid, depth: Number(parent.depth) + 1 },
    turns: contextTurns(chain),
  };
}

/**
 * Re-check one answered or hidden question: withdrawn on a clear
 * RecordNotFound; present, its handle verified both ways again (updated,
 * or none if it no longer verifies); unknown, left as it is, not checked
 * again for a while. -> the state. Each fetch on `budget`.
 */
async function recheck(env, row, { budget, now }) {
  const p = parseRecordUri(row.question_uri);
  if (!p) {
    await markChecked(env.SIREN_DB, row.id, now);
    return 'unknown';
  }
  const { state, doc } = await recordState(env, p, budget.tool);
  if (state === 'gone') await withdrawQuestion(env.SIREN_DB, row.id);
  else if (state === 'present') await markChecked(env.SIREN_DB, row.id, now, { handle: await verifiedHandle(env, doc, p.did, budget.tool) });
  else await markChecked(env.SIREN_DB, row.id, now);
  return state;
}

/**
 * A deletion reported by someone other than the asker (Jetstream, through
 * worker/question-watcher.js), confirmed by the rule withdrawal uses and
 * acted on through the same code path: the DID re-resolved, getRecord asked
 * of the PDS its document names, and the question withdrawn (withdrawQuestion:
 * the row emptied, references rewritten to 'withdrawn:<id>') only on a clear
 * RecordNotFound. The report itself is never trusted: a forged or replayed
 * event finds the record present, or can't check, and changes nothing (no
 * D1 write). `row` is { id, question_uri } as D1 holds it; each fetch goes
 * through `budget` (src/request-budget.js). -> 'gone' (withdrawn),
 * 'present' or 'unknown'.
 */
export async function takedownIfGone(env, row, budget) {
  const p = parseRecordUri(row?.question_uri);
  if (!p || p.collection !== QUESTION_NSID || !isSupportedDid(p.did) || !QUESTION_ID_RE.test(String(row?.id))) return 'unknown';
  const { state } = await recordState(env, p, budget.tool);
  if (state === 'gone') await withdrawQuestion(env.SIREN_DB, row.id);
  return state;
}

// The full upstream error goes to the operator's log only; askers get the gist.
function askErrorBody(err) {
  const status = String(err?.message || '').match(/^(Anthropic|OpenRouter) (\d{3}|error)/);
  return { error: 'Something went wrong answering that. Try again, or rephrase.', ...(status ? { detail: `${status[1]} ${status[2]}` } : {}) };
}

/**
 * POST <base>/api/public/ask {uri, cid}. `deps`: { base, cities (the city
 * ids this site serves), apiKey, subrequestBudget, answer({question, cityId,
 * budget, onCost}) -> ask()'s output, fetchImpl?, now? }.
 */
export async function handlePublicAsk(req, env, ctx, deps) {
  if (!publicAskReady(env)) return notReady(env);
  if (!sameOrigin(req, env)) return fail('not_here');
  const body = await readJson(req);
  const uri = typeof body?.uri === 'string' && body.uri.length <= 512 ? body.uri : null;
  const cid = typeof body?.cid === 'string' && CID_RE.test(body.cid) ? body.cid : null;
  if (!uri || !cid) return fail('bad_body');
  const kv = env.LIMITS;
  // The invite, exactly as /api/ask checks a cookie-held one.
  const invite = await currentInvite(req, env, kv);
  if (!invite) return json({ error: ASK_ERRORS.invite, gate: 'invite' }, 401);
  if (!deps.apiKey) return fail('no_model');
  const now = deps.now ?? Date.now();
  const day = dayOf(now);
  const limit = setting(env.PER_INVITE_DAILY, 30);
  const key = `inv-day:${day}:${invite.hash.slice(0, 32)}`;
  const [used, spent] = await Promise.all([kv.get(key), spentToday(kv, day)]);
  if (Number(used || 0) >= limit) {
    return json({ error: `This invite has been used for ${limit} questions today, its daily limit (shared by everyone using it). It resets at midnight UTC.`, limit: 'invite' }, 429);
  }
  if (spent >= setting(env.DAILY_BUDGET_USD, 2)) {
    return json({ error: "Today's shared budget for this free site is used up. It resets at midnight UTC.", limit: 'budget' }, 503);
  }
  // Counted before the work, as /api/ask counts it, on the same key. Its
  // expiry is a day boundary, not 48 hours from now, so this key itself
  // carries no exact time (other records do: docs/free-tier.md, "What is
  // stored").
  await kv.put(key, String(Number(used || 0) + 1), { expiration: boundary(now, 'day', 2) });
  // The site-wide breaker, before any outbound fetch.
  if (!(await allowed(env.BSKY_SITE_RL, 'ask'))) return fail('busy');
  const p = parseRecordUri(uri);
  if (!p || !isSupportedDid(p.did)) return fail('bad_uri');
  if (p.collection !== QUESTION_NSID) return fail('wrong_collection');
  if (!TID_RE.test(p.rkey)) return fail('bad_uri');
  // The answer's own counter, from the first fetch: ask() carries it on.
  const budget = requestBudget({ limit: deps.subrequestBudget, fetchImpl: deps.fetchImpl });
  const got = await readQuestion(env, { ...p, uri, cid, fetchImpl: budget.tool });
  if (got.error) return fail(got.error);
  if (!validQuestion(got.value)) return fail('malformed');
  const rec = got.value;
  const t = Date.parse(rec.createdAt);
  if (t > now + FUTURE_SKEW_MS) return fail('future');
  if (now - t > FRESH_MS) return fail('stale');
  if (!(deps.cities || []).includes(rec.city)) return fail('bad_city');
  const question = rec.text.trim();
  // A follow-up: its thread checked, and its context built, before any model call.
  let thread = null;
  if (rec.reply) {
    try {
      thread = await followUp(env.SIREN_DB, rec);
    } catch (err) {
      console.error('public ask: D1 thread read failed', clip(err));
      return fail('unavailable');
    }
    if (thread.error) return fail(thread.error);
  }
  const handle = await verifiedHandle(env, got.doc, p.did, budget.tool);
  let claim;
  try {
    claim = await claimQuestion(env.SIREN_DB, { uri, cid, did: p.did, handle, city: rec.city, question, now, reply: thread?.reply || null });
  } catch (err) {
    console.error('public ask: D1 claim failed', clip(err));
    return fail('unavailable');
  }
  if (claim.state === 'thread_full' || claim.state === 'parent_gone') return fail(claim.state === 'parent_gone' ? 'parent_not_public' : 'thread_full');
  if (claim.state === 'answered') {
    const v = publicView(claim.row);
    return json({ id: v.id, url: questionUrl(env, deps.base, v.id), answer: v.answer, record: v.record, already: true });
  }
  if (claim.state !== 'claimed') return fail(claim.state === 'hidden' ? 'hidden' : 'answering');

  // The context, read again now the claim holds: a question in the chain
  // withdrawn or hidden since followUp() read it is left out.
  if (thread) {
    try {
      const fresh = await threadOf(env.SIREN_DB, { root_uri: null, question_uri: thread.reply.rootUri, id: '' }, { tools: true });
      const parent = fresh.find((r) => r.question_uri === thread.reply.parentUri && r.status === 'answered');
      const chain = parent && chainTo(fresh, parent);
      if (!chain || chain[0].question_uri !== thread.reply.rootUri) {
        await dropClaim(env.SIREN_DB, claim.id);
        return fail('parent_not_public');
      }
      thread.turns = contextTurns(chain);
    } catch (err) {
      console.error('public ask: D1 thread read failed', clip(err));
      await dropClaim(env.SIREN_DB, claim.id).catch(() => {});
      return fail('unavailable');
    }
  }

  const spends = [];
  const onCost = (usd) => {
    if (usd) spends.push(recordSpend(kv, day, usd).catch((err) => console.error('recording spend failed', clip(err))));
  };
  // Under waitUntil, so a reader who leaves doesn't stop it at once: the
  // answer is still stored if it finishes in Cloudflare's grace period.
  const work = (async () => {
    try {
      // The chain as history, as a private conversation carries its turns.
      const { history, carried } = thread ? historyFrom({ turns: thread.turns }) : { history: [], carried: [] };
      const out = await deps.answer({ question, cityId: rec.city, budget, onCost, history, carried, publicThread: Boolean(thread) });
      const record = answerRecord(out);
      const answer = String(out.answer ?? '').slice(0, ANSWER_CHARS);
      const stored = await storeAnswer(env.SIREN_DB, claim.id, { answer, record, tools: out.toolResults, reply: thread?.reply || null, now: deps.now ?? Date.now() });
      if (stored === 'gone') return fail('withdrawn_meanwhile');
      if (stored === 'parent_gone') return fail('parent_gone');
      return json({ id: claim.id, url: questionUrl(env, deps.base, claim.id), answer, record });
    } catch (err) {
      console.error('public ask: the answer failed', clip(err));
      await dropClaim(env.SIREN_DB, claim.id).catch((e) => console.error('public ask: dropping the claim failed', clip(e)));
      return json(askErrorBody(err), 502);
    } finally {
      await Promise.all(spends);
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(work);
  return work;
}

/**
 * POST <base>/api/public/withdraw {uri}: the asker deleted the record (the
 * browser holds the delete permission). Confirmed gone from the DID's own
 * PDS, the row keeps only its id, day and status. Needs no invite: only the
 * account that holds the record can make it gone.
 */
export async function handlePublicWithdraw(req, env, ctx, deps = {}) {
  if (!publicAskReady(env)) return notReady(env);
  if (!sameOrigin(req, env)) return fail('not_here');
  const body = await readJson(req);
  const p = parseRecordUri(body?.uri);
  if (!p || !isSupportedDid(p.did)) return fail('bad_uri');
  if (p.collection !== QUESTION_NSID) return fail('wrong_collection');
  let row;
  try {
    row = await getByUri(env.SIREN_DB, body.uri);
  } catch (err) {
    console.error('public withdraw: D1 read failed', clip(err));
    return fail('unavailable');
  }
  if (!row || row.did !== p.did || row.status === 'withdrawn') return fail('not_listed');
  if (!(await visitorAllowed(req, env)) || !(await allowed(env.BSKY_SITE_RL, 'withdraw'))) return fail('busy');
  const budget = requestBudget({ limit: CHECK_BUDGET, fetchImpl: deps.fetchImpl });
  const { state } = await recordState(env, p, budget.tool);
  if (state === 'present') return fail('still_there');
  if (state !== 'gone') return fail('unreachable');
  try {
    await withdrawQuestion(env.SIREN_DB, row.id);
  } catch (err) {
    console.error('public withdraw: D1 write failed', clip(err));
    return fail('unavailable');
  }
  return json({ ok: true, id: row.id });
}

const defaultCache = () => (typeof caches !== 'undefined' && caches?.default ? caches.default : null);

/**
 * The flags for these askers (endorsers.js flagsFor: shown, never used to
 * exclude), from the public AppView, each profile cached five minutes.
 * -> Map(did -> flags), or null when the AppView couldn't be asked.
 */
async function askerFlags(env, dids, { fetchImpl, cache, cacheBase, now, req }) {
  const want = [...new Set(dids.filter((d) => typeof d === 'string' && isSupportedDid(d)))].slice(0, 25);
  const profiles = new Map();
  const missing = [];
  const keyOf = (did) => new Request(`${cacheBase}/__cache/q-profile-v1/${encodeURIComponent(did)}`);
  for (const did of want) {
    let hit = null;
    if (cache) {
      try {
        const r = await cache.match(keyOf(did));
        hit = r ? await r.json() : null;
      } catch {
        hit = null;
      }
    }
    if (hit) profiles.set(did, hit.none ? null : hit.profile);
    else missing.push(did);
  }
  if (missing.length) {
    if (!(await visitorAllowed(req, env)) || !(await allowed(env.BSKY_SITE_RL, 'questions'))) return null;
    const budget = requestBudget({ limit: 1, fetchImpl });
    let got;
    try {
      got = await getProfiles(missing, { origin: appviewOrigin(env), fetchImpl: budget.tool, ua: userAgent(`${cacheBase}/`) });
    } catch {
      return null;
    }
    for (const did of missing) {
      const profile = got.get(did) || null;
      profiles.set(did, profile);
      if (cache) {
        await cache.put(keyOf(did), new Response(JSON.stringify(profile ? { profile } : { none: true }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${PROFILE_SECONDS}` } })).catch(() => {});
      }
    }
  }
  const young = youngDays(env);
  return new Map(want.map((did) => [did, flagsFor(did, profiles.get(did) || undefined, { now, young })]));
}

/** GET <base>/api/questions?cursor=: answered questions, newest first, 20 a page. */
export async function handleQuestions(req, env, ctx, deps = {}) {
  if (!publicAskReady(env)) return notReady(env);
  const cursor = new URL(req.url).searchParams.get('cursor');
  if (cursor !== null && !CURSOR_RE.test(cursor)) return fail('bad_cursor');
  let page;
  try {
    page = await listPublic(env.SIREN_DB, { before: cursor ? Number(cursor) : null });
  } catch (err) {
    console.error('public questions: D1 read failed', clip(err));
    return fail('unavailable');
  }
  let counts;
  try {
    counts = await threadCounts(env.SIREN_DB, page.rows.map((r) => r.question_uri));
  } catch (err) {
    console.error('public questions: D1 read failed', clip(err));
    return fail('unavailable');
  }
  const cache = deps.cache !== undefined ? deps.cache : defaultCache();
  const flags = page.rows.length
    ? await askerFlags(env, page.rows.map((r) => r.did), { fetchImpl: deps.fetchImpl, cache, cacheBase: `${new URL(req.url).origin}${deps.base || ''}`, now: deps.now ?? Date.now(), req })
    : new Map();
  return json({
    // Roots only, each with its answered replies' count, whether its thread
    // takes another follow-up, and the refs one carries (null when it's full).
    questions: page.rows.map((r) => {
      const c = counts.get(r.question_uri) || { answered: 0, total: 0 };
      const full = c.total + 1 >= THREAD_MAX;
      return publicView(r, flags?.get(r.did), { parent: null, replies: c.answered, thread_full: full, followup: full ? null : refsTo(r, r) });
    }),
    cursor: page.cursor,
    ...(flags ? {} : { flags_unavailable: true }),
  });
}

const strongRef = (row) => ({ uri: row.question_uri, cid: row.question_cid });
/** The strongRefs a follow-up to `row` carries, in a thread whose root is `root`. */
const refsTo = (row, root) => ({ root: strongRef(root), parent: strongRef(row) });

/** Whether a thread takes another follow-up: null if it does, else why not ('full', 'withdrawn', 'hidden'). */
function threadClosed(thread) {
  const root = thread.find((r) => !r.parent_uri) || null;
  if (!root || root.status === 'withdrawn') return 'withdrawn';
  if (root.status === 'hidden') return 'hidden';
  return thread.length >= THREAD_MAX ? 'full' : null;
}

/**
 * A thread as the page shows it, oldest first: answered questions in full,
 * withdrawn and hidden ones as placeholders, each with its parent's public
 * id (null for the root). A question can take a follow-up while the root is
 * answered, the thread is under THREAD_MAX and it is under DEPTH_MAX.
 */
function threadView(thread, flags) {
  const idOf = new Map();
  for (const r of thread) {
    if (r.question_uri) idOf.set(r.question_uri, r.id);
    idOf.set(withdrawnRef(r.id), r.id);
  }
  const root = thread.find((r) => !r.parent_uri) || null;
  const open = !threadClosed(thread);
  return thread.filter((r) => r.status !== 'answering').map((r) => {
    const parent = r.parent_uri ? idOf.get(r.parent_uri) || null : null;
    if (r.status !== 'answered') return placeholderView(r, { parent });
    return publicView(r, flags?.get(r.did), { parent, followup: open && Number(r.depth) < DEPTH_MAX ? refsTo(r, root) : null });
  });
}

/** Whether a question has a page: 'answered' or 'withdrawn' (else null). For the page route. */
export async function questionPageState(env, id) {
  if (!QUESTION_ID_RE.test(String(id))) return null;
  const row = await getById(env.SIREN_DB, id);
  return row && (row.status === 'answered' || row.status === 'withdrawn') ? row.status : null;
}

/**
 * GET <base>/api/q/<id>: one question. A withdrawn one says only that. The
 * record is re-checked when the last check is over ten minutes old (one
 * getRecord, counted, behind the site breaker), and the question withdrawn
 * on a clear RecordNotFound; an unreachable PDS is "couldn't check", and
 * the page stays.
 */
export async function handleQuestion(req, env, ctx, id, deps = {}) {
  if (!publicAskReady(env)) return notReady(env);
  if (typeof id !== 'string' || !QUESTION_ID_RE.test(id)) return fail('not_found_page');
  const db = env.SIREN_DB;
  const now = deps.now ?? Date.now();
  let row;
  try {
    row = await getById(db, id);
  } catch (err) {
    console.error('public question: D1 read failed', clip(err));
    return fail('unavailable');
  }
  if (!row || (row.status !== 'answered' && row.status !== 'withdrawn')) return fail('not_found_page');
  let thread;
  try {
    thread = await threadOf(db, row);
  } catch (err) {
    console.error('public question: D1 read failed', clip(err));
    return fail('unavailable');
  }
  // Every question this page shows whose last check is over ten minutes
  // old (at most PAGE_RECHECKS, this one first), each behind the site
  // breaker, after the visitor's own limit, every fetch counted.
  const stale = thread
    .filter((r) => (r.status === 'answered' || r.status === 'hidden') && now - Number(r.checked_ms || 0) > RECHECK_MS)
    .sort((a, b) => (b.id === row.id) - (a.id === row.id) || Number(a.checked_ms) - Number(b.checked_ms))
    .slice(0, PAGE_RECHECKS);
  if (stale.length && (await visitorAllowed(req, env))) {
    const budget = requestBudget({ limit: CHECK_BUDGET * stale.length, fetchImpl: deps.fetchImpl });
    await mapLimit(stale, 5, async (r) => {
      if (!(await allowed(env.BSKY_SITE_RL, 'recheck'))) return;
      try {
        await recheck(env, r, { budget, now });
      } catch (err) {
        console.error('public question: re-check failed', clip(err));
      }
    });
    // Read again: a check may have withdrawn some, or changed a handle.
    try {
      row = (await getById(db, id)) || row;
      thread = await threadOf(db, row);
    } catch (err) {
      console.error('public question: D1 read failed', clip(err));
      return fail('unavailable');
    }
  }
  const answered = thread.filter((r) => r.status === 'answered');
  const cache = deps.cache !== undefined ? deps.cache : defaultCache();
  const flags = answered.length
    ? await askerFlags(env, answered.map((r) => r.did), { fetchImpl: deps.fetchImpl, cache, cacheBase: `${new URL(req.url).origin}${deps.base || ''}`, now, req })
    : new Map();
  const view = threadView(thread, flags);
  const focus = view.find((v) => v.id === row.id);
  const closed = threadClosed(thread);
  return json({
    // A withdrawn question says only that; the thread around it stays.
    ...(row.status === 'withdrawn' ? { id: row.id, withdrawn: true } : { question: focus }),
    thread: view,
    // Whether the thread takes another follow-up, and if not, why.
    thread_open: !closed,
    ...(closed ? { thread_closed: closed } : {}),
    ...(flags ? {} : { flags_unavailable: true }),
  });
}

/**
 * The Cron Trigger's sweep (worker/index.js scheduled, every ten minutes):
 * abandoned claims cleared, then at most SWEEP_BATCH answered or hidden
 * questions not checked for SWEEP_AGE_MS re-checked, oldest check first, so
 * a record deleted in the asker's own account comes off the site without
 * anyone opening its page. The same rule as a page's re-check: only a clear
 * RecordNotFound from the DID's own PDS withdraws. Each question is charged
 * to the site breaker; every fetch is counted on the run's budget; the run
 * stops starting checks at its deadline. With the free tier off or not
 * ready it does nothing at all: no D1 call, no fetch.
 * -> { skipped } or { cleared, checked, withdrawn, unknown }.
 */
export async function sweepQuestions(env, { fetchImpl, now = Date.now(), limit = SWEEP_BATCH, deadlineMs = SWEEP_DEADLINE_MS } = {}) {
  if (!publicAskReady(env)) return { skipped: true };
  const db = env.SIREN_DB;
  const cleared = await clearStaleClaims(db, now);
  const rows = await staleRows(db, { before: now - SWEEP_AGE_MS, limit });
  const budget = requestBudget({ limit: CHECK_BUDGET * rows.length, fetchImpl });
  const deadline = Date.now() + deadlineMs;
  const out = { cleared, checked: 0, withdrawn: 0, unknown: 0 };
  let stop = false;
  await mapLimit(rows, SWEEP_CONCURRENCY, async (r) => {
    if (stop || Date.now() > deadline) return;
    if (!(await allowed(env.BSKY_SITE_RL, 'recheck'))) {
      stop = true;
      return;
    }
    let state;
    try {
      state = await recheck(env, r, { budget, now });
    } catch (err) {
      console.error('public sweep: re-check failed', clip(err));
      return;
    }
    out.checked++;
    if (state === 'gone') out.withdrawn++;
    if (state === 'unknown') out.unknown++;
  });
  return out;
}

/**
 * GET <base>/api/public/session: whether this browser holds an invite (the
 * cookie only), so the page can say so before anyone writes a record, and
 * Siren's clock, so the record's createdAt isn't off by the browser's.
 * Renews the cookie while it's in use, as /api/session does.
 */
export async function handlePublicSession(req, env, deps = {}) {
  if (!publicAskReady(env)) return notReady(env);
  const invite = await currentInvite(req, env, env.LIMITS);
  const headers = invite ? { 'Set-Cookie': sessionCookie(await signSession(env.INVITE_SECRET, invite.hash), `${deps.base || ''}/`) } : {};
  return json({ invited: Boolean(invite), now: deps.now ?? Date.now() }, 200, headers);
}

/**
 * POST <base>/api/public/redeem {code}: the invite as a cookie, always
 * (/api/redeem binds it to an email account when one is signed in, and the
 * public routes never read an email account). Re-entering a code this
 * browser already holds costs no use.
 */
export async function handlePublicRedeem(req, env, deps = {}) {
  if (!publicAskReady(env)) return notReady(env);
  const body = await readJson(req);
  const current = (await currentInvite(req, env, env.LIMITS))?.hash || null;
  const out = await redeem({ code: body?.code, env, kv: env.LIMITS, visitor: deps.visitor, current, maxFailures: setting(env.REDEEM_FAILURES_HOURLY, 30, { min: 1 }) });
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(out.cookie, `${deps.base || ''}/`) });
}

/** GET <base>/question-client-metadata.json: the ask client's client_id document (a non-loopback origin only). */
export function handleQuestionMetadata(req, env, base, appName = 'Siren') {
  if (!publicAskReady(env)) return notReady(env);
  const ids = clientIds(env, base, { kind: 'ask' });
  if (!ids || ids.loopback) return new Response('Not found', { status: 404 });
  return new Response(req.method === 'HEAD' ? null : JSON.stringify(clientMetadata({ ...ids, appName }), null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * The steward's routes for public questions: GET /api/admin/questions (every
 * row, newest first) and POST /api/admin/questions/hide {id, hidden}.
 * Questions publish at once, with no review first; hiding is the remedy.
 */
export async function handleAdminQuestions(req, env, path) {
  const headers = { 'Cache-Control': 'no-store', ...NOINDEX };
  if (!publicAskReady(env)) return notReady(env);
  const uid = await currentUser(req, env);
  if (!uid) return json({ error: 'Sign in first.', signin: true }, 401, headers);
  if (!(await isAdmin(env, uid))) return json({ error: 'This account is not a steward here.' }, 403, headers);
  const db = env.SIREN_DB;
  try {
    if (req.method === 'GET' && path === '/api/admin/questions') return json({ questions: (await listAll(db)).map(stewardView) }, 200, headers);
    if (req.method === 'POST' && path === '/api/admin/questions/hide') {
      const o = req.headers.get('Origin');
      if (o !== null && o !== new URL(req.url).origin && o !== publicOrigin(env)?.origin) return json({ error: "Act from this site's own admin page.", code: 'not_here' }, 403, headers);
      const body = await readJson(req);
      if (!QUESTION_ID_RE.test(String(body?.id)) || typeof body?.hidden !== 'boolean') return json({ error: 'Give the question id and hidden: true or false.' }, 400, headers);
      const status = await setHidden(db, body.id, body.hidden);
      if (!status) return json({ error: 'Only an answered question can be hidden, and only a hidden one unhidden.' }, 409, headers);
      return json({ ok: true, id: body.id, status }, 200, headers);
    }
  } catch (err) {
    console.error('public questions (steward): D1 failed', clip(err));
    return fail('unavailable');
  }
  return json({ error: 'Not found' }, 404, headers);
}
