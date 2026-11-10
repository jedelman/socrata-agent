// Cloudflare Worker: the public chat app. The operator's OpenRouter key lives
// in a secret; every visitor shares it, so every request is limited:
//   - per visitor (hashed IP) per day      PER_IP_DAILY       default 20
//   - or, behind Cloudflare Access, per person (verified email) per day
//                                          PER_USER_DAILY     default 40
//   - for everyone per day, in dollars     DAILY_BUDGET_USD   default 2
//   - per question: length, history, tool steps, output tokens, and
//     outbound requests (SUBREQUEST_BUDGET, default 45)
// Limits are counted in KV (binding LIMITS). KV is eventually consistent, so a
// burst can overshoot by a few requests; set an OpenRouter key limit as the
// hard ceiling.

import { ask, keyNameFor, providerOf } from '../src/agent.js';
import { cities, getCity } from '../src/cities/index.js';
import norfolkLegislation from '../data/norfolk-legislation.json';
import norfolkStreets from '../data/gaps/norfolk-streets.json';
import norfolkGaps from '../data/gaps/norfolk.json';
import { compileStreets } from '../src/public-text.js';
import UI from './ui.html';
import deployments from '../deployments/index.js';
import { applyConfig, definePlugin, webSearchConfig } from '../src/plugins.js';
import { verifyAccess } from './access.js';
import { skins } from './skins.js';
import { setting, askLimits, visitorId, spentToday, recordSpend } from './limits.js';
import { currentInvite, redeem, joinWaitlist, sessionCookie, signSession } from './invites.js';
import { currentUser, currentUserInfo, startLogin, finishLogin, memberInvite, bindInvite, loginConfigured, userCookie, clearUserCookie } from './accounts.js';
import { addRequest, raiseResponse, publicRequests, PUBLIC_ID_RE } from './requests.js';
import { publicOrigin } from './atproto-oauth.js';
import { hmacHex } from './crypto.js';
import { movedResponse, httpsResponse, carryInviteResponse, CARRY_PATH } from './moved.js';
import { handleAdmin } from './admin.js';
import { cachedPublicList } from './public-list.js';
import { blueskyReady, handleMetadata, handleResolve } from './bluesky.js';
import { handleEndorsers } from './endorsers.js';
// The free tier (docs/free-tier.md), behind PUBLIC_ASK: imported as code
// here, above the text imports, like every shared module (see below).
import {
  publicAskOn, publicAskReady, notReady, NOINDEX, handlePublicAsk, handlePublicWithdraw, handleQuestions, handleQuestion,
  questionPageState, handlePublicSession, handlePublicRedeem, handleQuestionMetadata, handleAdminQuestions,
} from './public-ask.js';
import REQUESTS_PAGE from './requests.html';
import QUESTIONS_PAGE from './questions.html';
import ADMIN_QUESTIONS_PAGE from './admin-questions.html';
// The requests page's module and style, and the browser OAuth client with
// the shared modules it imports, served as text (with { type: 'text' } is an
// esbuild import attribute; the same files are imported as code elsewhere).
// Keep every code import of these files above this block: under Node 24 the
// tests' text hook (test/worker-requests.test.js) gives a module imported
// as code after its text import the text version, which has no named
// exports (seen 2026-11-10 with moved.js and crypto.js; esbuild is fine).
import PAGE_JS from './requests-page.js' with { type: 'text' };
import PAGE_CSS from './requests.css' with { type: 'text' };
// The chat page's script and style, served the same way so it can carry a
// strict CSP too.
import CHAT_JS from './chat-page.js' with { type: 'text' };
import CHAT_CSS from './chat.css' with { type: 'text' };
// The public questions pages' script and style, and the steward's page for
// them (the free tier), served only with PUBLIC_ASK on.
import QUESTIONS_JS from './questions-page.js' with { type: 'text' };
import QUESTIONS_CSS from './questions.css' with { type: 'text' };
import ADMIN_QUESTIONS_JS from './admin-questions.js' with { type: 'text' };
import CLIENT_JS from './endorse-client.js' with { type: 'text' };
import STORE_JS from './endorse-store.js' with { type: 'text' };
import IDENTITY_JS from './atproto-identity.js' with { type: 'text' };
import OAUTH_JS from './atproto-oauth.js' with { type: 'text' };
import CONFIG_JS from './endorse-config.js' with { type: 'text' };
import CRYPTO_JS from './crypto.js' with { type: 'text' };
import ADMIN_PAGE from './admin.html';
import { CASES } from '../plugins/case-file.js';
import { toAnnotations } from '../plugins/cases.js';
import { loadConversation, saveTurn, historyFrom, listConversations, deleteConversation, deleteAllConversations, newConversationId, turnView } from './conversations.js';
import { toolsFor } from '../src/tools.js';
import { wantsStream, workingNotesOn, noteEvents, streamResponse } from './ask-stream.js';

// Street names per city, used only to refuse addresses in text that could go
// public (src/public-text.js); built by scripts/build-gaps.js. Compiled here,
// at isolate startup, so no request pays for it in its CPU time.
const STREETS = { norfolk: compileStreets(norfolkStreets.streets) };
// Built gap files per city (scripts/build-gaps.js). An answer carries gaps only
// when its deployment sets gaps.enabled (in a reviewed PR); none does yet.
const GAPS = { norfolk: norfolkGaps };

// DEPLOYMENT picks a config from deployments/index.js; unknown names fail
// loudly rather than quietly serving the default. A bad web search list
// fails here too, before any question is asked.
const prepared = new Map();
function getDeployment(env) {
  const name = env.DEPLOYMENT || 'default';
  if (!prepared.has(name)) {
    const config = deployments[name];
    if (!config) throw new Error(`Unknown DEPLOYMENT "${name}". Known: ${Object.keys(deployments).join(', ')}`);
    prepared.set(name, { config, plugins: (config.plugins || []).map(definePlugin), webSearch: webSearchConfig(config) });
  }
  return prepared.get(name);
}

const INDEXES = { 'norfolk-legislation': norfolkLegislation };
const MAX_QUESTION = 600;
const MAX_HISTORY = 6;
const MAX_HISTORY_CHARS = 4000;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const today = () => new Date().toISOString().slice(0, 10);
// Cloudflare Access, when configured, takes the place of invites.
const inviteOnly = (env) => env.INVITE_REQUIRED === 'true' && !env.ACCESS_TEAM_DOMAIN;
// Invite mode hashes visitors for its rate limits; without a salt those hashes
// could be reversed, so it fails closed.
const inviteSetupError = (env) =>
  !env.LIMITS ? 'This site is not configured yet (invite mode needs the LIMITS storage, even in local dev).'
    : !env.INVITE_SECRET || !env.IP_SALT ? 'This site is not configured yet (invites are not set up).' : null;
const basePath = (env) => (env.BASE_PATH || '').replace(/\/$/, '');
// The site's own origin for links it sends out (sign-in emails, annotation
// ids): PUBLIC_ORIGIN when it is set and valid, never the Host header; else
// the request's origin (deployments without PUBLIC_ORIGIN).
const siteOrigin = (env, url) => publicOrigin(env)?.origin || url.origin;

// The API takes JSON only. Browsers can't send a cross-site JSON POST without
// a CORS preflight this Worker never answers, which closes off cross-site
// requests that would spend a visitor's invite.
const isJson = (req) => (req.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json');

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A visitor's hashed identity for rate limits; never stored unhashed.
async function visitorHash(req, env) {
  return (await sha256(`${env.IP_SALT || 'socrata-agent'}:${visitorId(req.headers.get('CF-Connecting-IP'))}`)).slice(0, 32);
}

// A visitor hash in its own domain, for one counter only (email sign-in uses
// 'login'), so it can't be joined with the counters keyed by visitorHash or
// with the Bluesky ones (bluesky.js bskyVisitor).
async function visitorHashFor(req, env, purpose) {
  return hmacHex(env.IP_SALT || 'socrata-agent', `${purpose}:${visitorId(req.headers.get('CF-Connecting-IP'))}`, 32);
}

function allowedCities(env) {
  const { config: deployment } = getDeployment(env);
  const ids = (deployment.city || env.CITIES || Object.keys(cities).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.filter((id) => cities[id]);
}

// Who is asking, in invite mode: a signed-in account bound to an invite, or a
// browser holding an invite cookie (the way codes worked before sign-in).
async function inviteAccess(req, env, kv) {
  const uid = await currentUser(req, env);
  const viaAccount = uid ? await memberInvite(kv, uid) : null;
  if (viaAccount) return { uid, invite: viaAccount, member: true };
  return { uid, invite: await currentInvite(req, env, kv), member: false };
}

async function handleAsk(req, env, ctx) {
  const { config: deployment, plugins } = getDeployment(env);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Send JSON: {"question": "...", "city": "norfolk"}' }, 400);
  }
  const question = String(body.question || '').trim();
  if (!question) return json({ error: 'Ask a question.' }, 400);
  if (question.length > MAX_QUESTION) return json({ error: `Keep questions under ${MAX_QUESTION} characters.` }, 400);
  const cityId = body.city || allowedCities(env)[0];
  if (!allowedCities(env).includes(cityId)) return json({ error: `This site doesn't serve "${cityId}".` }, 400);
  const clientHistory = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));

  const kv = env.LIMITS;
  if (!kv && env.ALLOW_UNLIMITED !== 'true') {
    // Fail closed: a public deploy without limits would spend the shared key freely.
    return json({ error: 'This site is not configured yet (no usage limits are set up).' }, 503);
  }
  const model = env.MODEL || deployment.model;
  const apiKey = env[keyNameFor(model)];
  if (!apiKey) return json({ error: 'This site is not configured yet (no model key).' }, 503);
  const day = today();
  const budget = setting(env.DAILY_BUDGET_USD, 2);
  // Behind Cloudflare Access, count per verified person; in invite-only mode,
  // per invite; otherwise per hashed IP.
  let who;
  // A signed-in account bound to an invite; only accounts keep conversations.
  let uid = null;
  if (env.ACCESS_TEAM_DOMAIN) {
    try {
      const { email } = await verifyAccess(req, env);
      who = { key: `user:${day}:${(await sha256(`${env.IP_SALT || 'socrata-agent'}:${email}`)).slice(0, 32)}`, limit: setting(env.PER_USER_DAILY, 40), kind: 'person' };
    } catch (err) {
      return json({ error: 'Sign in through this site\'s access page first.', detail: err.message }, 401);
    }
  } else if (inviteOnly(env)) {
    const setup = inviteSetupError(env);
    if (setup) return json({ error: setup }, 503);
    const access = await inviteAccess(req, env, kv);
    if (!access.invite) return json({ error: 'Siren is invite-only for now. Sign in, enter your invite code, or join the waitlist.', gate: 'invite' }, 401);
    uid = access.member ? access.uid : null;
    who = uid
      ? { key: `user-day:${day}:${uid.slice(0, 32)}`, limit: setting(env.PER_USER_DAILY, 30), kind: 'person' }
      : { key: `inv-day:${day}:${access.invite.hash.slice(0, 32)}`, limit: setting(env.PER_INVITE_DAILY, 30), kind: 'invite' };
  } else {
    who = { key: `ip:${day}:${await visitorHash(req, env)}`, limit: setting(env.PER_IP_DAILY, 20), kind: 'visitor' };
  }
  const ipKey = who.key;
  if (kv) {
    const [used, spent] = await Promise.all([kv.get(ipKey), spentToday(kv, day)]);
    if (Number(used || 0) >= who.limit) {
      const used = who.kind === 'invite'
        ? `This invite has been used for ${who.limit} questions today, its daily limit (shared by everyone using it).`
        : `You've asked ${who.limit} questions today, the limit for this site.`;
      return json({ error: `${used} It resets at midnight UTC. To keep going now, run socrata-agent on your own computer with your own key.`, limit: who.kind }, 429);
    }
    if (spent >= budget) {
      return json({ error: "Today's shared budget for this free site is used up. It resets at midnight UTC. To keep going now, run socrata-agent on your own computer with your own key.", limit: 'budget' }, 503);
    }
    await kv.put(ipKey, String(Number(used || 0) + 1), { expirationTtl: 172800 });
  }

  // Follow-ups: a signed-in account's conversation carries the earlier tool
  // results. Anyone else gets the older behavior: the text of recent turns.
  let conversationId = null;
  let conversation = null;
  let history = clientHistory;
  let carried = [];
  if (uid && kv) {
    conversation = await loadConversation(kv, uid, body.conversation);
    if (conversation && conversation.city !== cityId) conversation = null;
    conversationId = conversation ? body.conversation : newConversationId();
    ({ history, carried } = historyFrom(conversation));
  }

  const gapsOn = deployment.gaps?.enabled === true && GAPS[cityId];
  // Built inside each path's try, as before, so a failure here is an error body.
  const askArgs = () => ({ question, history, carried, ...answerArgs(env, req, cityId) });
  // The response body, and the conversation save (started, not awaited).
  const finish = (out) => {
    const { toolResults, ...answer } = out;
    const save = conversationId
      ? saveTurn(kv, uid, conversationId, conversation, { city: cityId, question, answer: out.answer, tools: toolResults, record: answer }, { days: env.CONVERSATION_DAYS })
        .catch((err) => console.error('saving the conversation failed', err))
      : null;
    return { save, body: { city: cityId, ...answer, ...(conversationId ? { conversation: conversationId } : {}) } };
  };

  // Spend is recorded per paid call, as it happens (one KV key each, so
  // concurrent writes can't overwrite each other), so a call already made is
  // counted even if the rest of the answer never runs.
  const spends = [];
  const onCost = (usd) => {
    if (kv && usd) spends.push(recordSpend(kv, day, usd).catch((err) => console.error('recording spend failed', err)));
  };

  // Streamed (worker/ask-stream.js): the same answer, limits, spend and save,
  // with the working notes sent as they come. It runs under ctx.waitUntil, so
  // a reader who leaves doesn't stop it at once; Cloudflare gives that about
  // 30 seconds after they leave. Each call's spend is recorded as it happens;
  // the turn is saved as soon as the answer exists, before the final line, so
  // it is saved only if the answer finishes within that grace period.
  if (wantsStream(req) && workingNotesOn(env)) {
    return streamResponse(ctx, async (send) => {
      if (conversationId) send({ type: 'start', conversation: conversationId });
      try {
        const args = askArgs();
        // The tools this answer declares: a tool line names only one of these.
        const known = new Set(toolsFor(args.city, plugins, gapsOn ? { gaps: GAPS[cityId] } : {}).map((t) => t.function.name));
        const { save, body } = finish(await ask({ ...args, onCost, onEvent: noteEvents(send, { known }), thinkingEvents: true }));
        if (save) await save;
        send({ type: 'final', body });
      } catch (err) {
        console.error(err);
        send({ type: 'error', status: 502, body: askErrorBody(err) });
      } finally {
        await Promise.all(spends);
      }
    });
  }

  try {
    const { save, body } = finish(await ask({ ...askArgs(), onCost }));
    if (save) {
      if (ctx?.waitUntil) ctx.waitUntil(save);
      else await save;
    }
    return json(body);
  } catch (err) {
    console.error(err);
    return json(askErrorBody(err), 502);
  } finally {
    if (spends.length) {
      const write = Promise.all(spends);
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
  }
}

// What every answer runs with, private or public: the deployment's city,
// plugins, model and limits, for one city.
function answerArgs(env, req, cityId) {
  const { config: deployment, plugins, webSearch } = getDeployment(env);
  const model = env.MODEL || deployment.model;
  const gapsOn = deployment.gaps?.enabled === true && GAPS[cityId];
  return {
    city: applyConfig(getCity(cityId), deployment),
    plugins,
    indexes: INDEXES,
    apiKey: env[keyNameFor(model)],
    appToken: env.SOCRATA_APP_TOKEN,
    model,
    effort: env.EFFORT || undefined,
    // Steps, outbound requests and tokens per answer (worker/limits.js).
    ...askLimits(env, providerOf(model)),
    referer: new URL(req.url).origin,
    ...(gapsOn ? { gaps: { data: GAPS[cityId], streets: STREETS[cityId], absenceLines: deployment.gaps.absenceLines === true } } : {}),
    // Off unless the deployment sets webSearch (Claude models only).
    // WEB_SEARCH = "off" turns it off without a deploy of new code: a request
    // carrying the tool fails with a 400 if the Anthropic organization has
    // web search disabled in the Console (web search tool docs, 2026-11-10).
    ...(webSearch && String(env.WEB_SEARCH ?? '').trim().toLowerCase() !== 'off' ? { webSearch } : {}),
  };
}

// The free tier's answer: the same agent as the private chat, on the
// record's text, for its city, counting on the budget the record's check
// started. A follow-up carries its thread's chain, as a private
// conversation carries its earlier turns.
function publicAskDeps(req, env, base) {
  const { config: deployment } = getDeployment(env);
  const model = env.MODEL || deployment.model;
  return {
    base,
    cities: allowedCities(env),
    apiKey: env[keyNameFor(model)],
    subrequestBudget: askLimits(env, providerOf(model)).subrequestBudget,
    // A follow-up brings its thread's chain as history and carried results.
    answer: ({ question, cityId, budget, onCost, history = [], carried = [] }) => ask({ ...answerArgs(env, req, cityId), question, history, carried, budget, onCost }),
  };
}

// The full upstream error goes to the operator's log only; visitors get the gist.
function askErrorBody(err) {
  const status = String(err?.message || '').match(/^(Anthropic|OpenRouter) (\d{3}|error)/);
  return { error: 'Something went wrong answering that. Try again, or rephrase.', ...(status ? { detail: `${status[1]} ${status[2]}` } : {}) };
}

// What the page needs to decide whether to show the invite gate.
// While an invite is in use, each visit renews its cookie, so active people
// never have to redeem again.
async function handleSession(req, env) {
  const headers = { 'Cache-Control': 'no-store' };
  let invited = false;
  let signedIn = false;
  let member = false;
  let account = null;
  if (inviteOnly(env) && !inviteSetupError(env)) {
    const access = await inviteAccess(req, env, env.LIMITS);
    const { invite } = access;
    account = access.uid ? (await currentUserInfo(req, env))?.masked || 'your email' : null;
    signedIn = Boolean(access.uid);
    member = access.member;
    if (invite) {
      invited = true;
      if (!member) headers['Set-Cookie'] = sessionCookie(await signSession(env.INVITE_SECRET, invite.hash), `${basePath(env)}/`);
    }
  }
  return json({
    invite_required: inviteOnly(env),
    invited,
    waitlist: inviteOnly(env),
    login: inviteOnly(env) && loginConfigured(env),
    signed_in: signedIn,
    // Shown on every page, so a sign-in link someone else sent you is noticed.
    account,
    // Conversations (and follow-ups from earlier findings) need an account bound to an invite.
    conversations: member,
  }, 200, headers);
}

async function handleRedeem(req, env) {
  if (!inviteOnly(env)) return json({ error: 'This site does not use invites.' }, 404);
  const setup = inviteSetupError(env);
  if (setup) return json({ error: setup }, 503);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Send JSON: {"code": "..."}' }, 400);
  }
  const uid = await currentUser(req, env);
  const current = (uid ? (await memberInvite(env.LIMITS, uid))?.hash : null) || (await currentInvite(req, env, env.LIMITS))?.hash || null;
  const out = await redeem({
    code: body?.code, env, kv: env.LIMITS, visitor: await visitorHash(req, env), current,
    maxFailures: setting(env.REDEEM_FAILURES_HOURLY, 30, { min: 1 }),
  });
  if (!out.ok) return json({ error: out.error }, out.status);
  // Signed in: the invite now belongs to the account, on every device.
  if (uid) {
    await bindInvite(env.LIMITS, uid, out.hash);
    return json({ ok: true, bound: true }, 200, { 'Cache-Control': 'no-store' });
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(out.cookie, `${basePath(env)}/`), 'Cache-Control': 'no-store' });
}

// The public request feed costs a KV list and three reads per request, from
// the account's daily quota that every question also draws on. So it is kept
// in this location's cache for its max-age (five minutes), keyed without the
// query string so a cache-busting query can't spend the quota. Where the
// Cache API is missing (Node tests, workers.dev), it is built every time.
async function cachedFeed(url, ctx, build) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(`${url.origin}${url.pathname}`);
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) return hit;
  const res = await build();
  if (cache && res.ok) {
    const put = cache.put(key, res.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
  }
  return res;
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function handleLogin(req, env) {
  if (!inviteOnly(env)) return json({ error: 'This site has no sign-in.' }, 404);
  const setup = inviteSetupError(env);
  if (setup) return json({ error: setup }, 503);
  const body = await readJson(req);
  const { config } = getDeployment(env);
  const origin = siteOrigin(env, new URL(req.url));
  try {
    const out = await startLogin({
      body, env, kv: env.LIMITS, visitor: await visitorHashFor(req, env, 'login'), link: `${origin}${basePath(env)}/login`, appName: APP_NAME_OF(env, config),
    });
    if (!out.ok) return json({ error: out.error }, out.status);
  } catch (err) {
    console.error('sign-in email failed', err);
    return json({ error: "The sign-in email couldn't be sent. Try again in a minute." }, 502);
  }
  return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
}

async function handleLoginVerify(req, env) {
  if (!inviteOnly(env)) return json({ error: 'This site has no sign-in.' }, 404);
  const setup = inviteSetupError(env);
  if (setup) return json({ error: setup }, 503);
  const body = await readJson(req);
  const out = await finishLogin({ token: body?.token, env, kv: env.LIMITS });
  if (!out.ok) return json({ error: out.error }, out.status);
  const member = Boolean(await memberInvite(env.LIMITS, out.uid));
  return json({ ok: true, member, account: out.masked }, 200, { 'Set-Cookie': userCookie(out.cookie, `${basePath(env)}/`), 'Cache-Control': 'no-store' });
}

async function handleRequest(req, env) {
  const kv = env.LIMITS;
  if (!kv) return json({ error: 'This site is not configured yet.' }, 503);
  if (inviteOnly(env)) {
    const setup = inviteSetupError(env);
    if (setup) return json({ error: setup }, 503);
    if (!(await inviteAccess(req, env, kv)).invite) return json({ error: 'Sign in or enter your invite code first.' }, 401);
  }
  const out = await addRequest({ body: await readJson(req), kv, visitor: await visitorHash(req, env), streets: STREETS[allowedCities(env)[0]] });
  if (!out.ok) return json({ error: out.error }, out.status);
  return json(raiseResponse(out), 200, { 'Cache-Control': 'no-store' });
}

async function handleConversations(req, env, path) {
  const kv = env.LIMITS;
  const uid = kv && inviteOnly(env) ? await currentUser(req, env) : null;
  if (!uid || !(await memberInvite(kv, uid))) return json({ error: 'Sign in to see your conversations.' }, 401);
  const headers = { 'Cache-Control': 'no-store' };
  if (req.method === 'GET' && path === '/api/conversations') return json({ conversations: await listConversations(kv, uid) }, 200, headers);
  if (req.method === 'GET' && path === '/api/conversation') {
    const conv = await loadConversation(kv, uid, new URL(req.url).searchParams.get('id'));
    if (!conv) return json({ error: 'That conversation is gone (it was deleted) or was never yours.' }, 404, headers);
    return json({ city: conv.city, turns: conv.turns.map(turnView) }, 200, headers);
  }
  if (req.method === 'POST' && path === '/api/conversations/delete') {
    const body = await readJson(req);
    await deleteConversation(kv, uid, body?.id);
    return json({ ok: true }, 200, headers);
  }
  if (req.method === 'POST' && path === '/api/conversations/delete-all') {
    const body = await readJson(req);
    // An explicit confirmation in the body, so a stray request can't empty an account.
    if (body?.confirm !== 'delete all') return json({ error: 'Send { "confirm": "delete all" } to delete every conversation.' }, 400, headers);
    return json({ ok: true, deleted: await deleteAllConversations(kv, uid) }, 200, headers);
  }
  return json({ error: 'Not found' }, 404);
}

async function handleWaitlist(req, env) {
  if (!inviteOnly(env)) return json({ error: 'This site has no waitlist.' }, 404);
  const setup = inviteSetupError(env);
  if (setup) return json({ error: setup }, 503);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Send JSON: {"email": "..."}' }, 400);
  }
  const { config } = getDeployment(env);
  const out = await joinWaitlist({
    body, kv: env.LIMITS, visitor: await visitorHash(req, env), source: config.name || 'socrata-agent',
    perDay: setting(env.WAITLIST_PER_VISITOR_DAILY, 50, { min: 1 }),
  });
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
}

const APP_NAME_OF = (env, config) => env.APP_NAME || config.name || 'socrata-agent';

const JS = 'text/javascript; charset=utf-8';
const ASSETS = {
  'requests-page.js': [PAGE_JS, JS],
  'requests.css': [PAGE_CSS, 'text/css; charset=utf-8'],
  'chat-page.js': [CHAT_JS, JS],
  'chat.css': [CHAT_CSS, 'text/css; charset=utf-8'],
  'endorse-client.js': [CLIENT_JS, JS],
  'endorse-store.js': [STORE_JS, JS],
  'atproto-identity.js': [IDENTITY_JS, JS],
  'atproto-oauth.js': [OAUTH_JS, JS],
  'endorse-config.js': [CONFIG_JS, JS],
  'crypto.js': [CRYPTO_JS, JS],
  'questions-page.js': [QUESTIONS_JS, JS],
  'questions.css': [QUESTIONS_CSS, 'text/css; charset=utf-8'],
  'admin-questions.js': [ADMIN_QUESTIONS_JS, JS],
};
// The free tier's files: served only with PUBLIC_ASK on (with it off,
// nothing new is served).
const ASK_ASSETS = new Set(['questions-page.js', 'questions.css', 'admin-questions.js']);
// A content hash of every asset, computed once per isolate (FNV-1a, two
// seeds; for cache-busting, not security), so the page's URLs change with
// any deploy that changes them and each can be cached for a year.
function fnv(s, h) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
const ALL_ASSETS = Object.entries(ASSETS).map(([k, [v]]) => `${k}\n${v}`).join('\n');
const ASSET_HASH = fnv(ALL_ASSETS, 0x811c9dc5) + fnv(ALL_ASSETS, 0x01000193);

function assetResponse(hash, name) {
  const [body, type] = ASSETS[name];
  // An old hash (a page cached across a deploy) still gets the current
  // file, but never cached, so no URL ever holds the wrong content.
  const cache = hash === ASSET_HASH ? 'public, max-age=31536000, immutable' : 'no-store';
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' } });
}

/**
 * The requests pages' policy: scripts and styles only from this origin (no
 * inline script or style), fetches to any https server (the browser talks
 * to each person's own Bluesky server), nothing framed, no base or form
 * target elsewhere. Siren has its own origin, ask-siren.jason-edelman.org,
 * so 'self' is Siren alone (D4, settled by Jason, 2026-11-10: the subdomain;
 * docs/bluesky-endorsements.md, "Where the endorsing page runs").
 */
/**
 * Cloudflare Web Analytics' beacon, which the zone injects into every page
 * (Jason, 2026-11-10: "Allow. We'll need it."). Cloudflare's FAQ names the
 * script; the injected copy loads from a versioned path under it
 * (/beacon.min.js/v<hash>, seen blocked 2026-11-10), and a CSP path without
 * a trailing slash matches only itself, so both forms are listed: the file,
 * and the paths under it, not the whole host. It reports to this origin's
 * /cdn-cgi/rum (automatic injection), which connect-src 'self' covers.
 * https://developers.cloudflare.com/web-analytics/faq/ (read 2026-11-10).
 * Cloudflare already serves these pages and could change them in transit,
 * so trusting its beacon adds no party to the trust base.
 */
const CF_BEACON = ['https://static.cloudflareinsights.com/beacon.min.js', 'https://static.cloudflareinsights.com/beacon.min.js/'];
const REQUESTS_CSP = `default-src 'none'; script-src 'self' ${CF_BEACON.join(' ')}; style-src 'self'; connect-src 'self' https:; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

/**
 * The chat page's scripts from elsewhere: exactly these two files, pinned
 * versions with subresource integrity in ui.html, not the whole CDN.
 */
const CHAT_SCRIPTS = [
  'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
];

/**
 * The chat page's policy, as strict as the requests pages' (D4): no inline
 * script or style; scripts from this origin, the two files above and
 * Cloudflare's analytics beacon (CF_BEACON); styles
 * and fonts from this origin and whatever the skin names (worker/skins.js);
 * fetches to this origin only (the page talks to nothing else); images from
 * this origin and data: URLs (the favicon and the masthead's wave); nothing
 * framed, no base, forms only to this origin. It renders model output, so a
 * script that got in could reach the endorsement session on the same
 * origin; under this policy, injected markup can't run script.
 */
function chatCsp(skin) {
  const extra = (list) => (Array.isArray(list) && list.length ? ` ${list.join(' ')}` : '');
  const font = skin?.csp?.font;
  return [
    "default-src 'none'",
    `script-src 'self' ${[...CHAT_SCRIPTS, ...CF_BEACON].join(' ')}`,
    `style-src 'self'${extra(skin?.csp?.style)}`,
    ...(Array.isArray(font) && font.length ? [`font-src ${font.join(' ')}`] : []),
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The public questions pages' policy (the free tier): the requests pages'
 * (scripts and styles from this origin, fetches to any https server, since
 * the browser talks to each person's own Bluesky server), plus the chat
 * page's two pinned files from the CDN, which render the answers. No inline
 * script, style or handler.
 */
const QUESTIONS_CSP = `default-src 'none'; script-src 'self' ${[...CHAT_SCRIPTS, ...CF_BEACON].join(' ')}; style-src 'self'; connect-src 'self' https:; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
/** The steward's questions page talks to this origin only. */
const ADMIN_QUESTIONS_CSP = `default-src 'none'; script-src 'self' ${CF_BEACON.join(' ')}; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
const PAGE_HEADERS = (csp) => ({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', ...NOINDEX });

/**
 * GET /questions, and /q/<id> for a question that has a page (answered, or
 * withdrawn, which says only that). Everything on them is public.
 */
async function questionsPage(req, env, base, focus) {
  if (!publicAskReady(env)) return notReady(env);
  if (focus) {
    let state;
    try {
      state = await questionPageState(env, focus);
    } catch (err) {
      console.error('public question page: D1 read failed', String(err?.message || err).slice(0, 200));
      return new Response("Public questions can't be read just now. Try again in a minute.", { status: 503, headers: { 'Cache-Control': 'no-store', ...NOINDEX } });
    }
    if (!state) return new Response('Not found', { status: 404, headers: NOINDEX });
  }
  const { config } = getDeployment(env);
  const ui = config.ui || {};
  const fill = {
    APP_NAME: esc(APP_NAME_OF(env, config)),
    REPO: esc(env.REPO_URL || 'https://github.com/jedelman/socrata-agent'),
    BASE: esc(base),
    ASSETS: esc(`${base}/assets/${ASSET_HASH}`),
    ORIGIN: esc(publicOrigin(env).origin),
    FOCUS: esc(focus),
    LOADING: esc(ui.loading || 'Looking it up. This usually takes 10 to 30 seconds'),
    // Where questions go beyond this Worker, as on the chat page.
    DATA_NOTE: ui.dataNote ? `<p>${esc(ui.dataNote)}</p>` : '',
  };
  return new Response(QUESTIONS_PAGE.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m)), {
    headers: { ...PAGE_HEADERS(QUESTIONS_CSP), 'Cache-Control': 'public, max-age=60' },
  });
}

async function requestsPage(req, env, ctx, base, focus) {
  const { config } = getDeployment(env);
  const on = blueskyReady(env);
  if (focus) {
    // A request's own page exists only with endorsements on, and only for a
    // request on the public list.
    if (!on || !PUBLIC_ID_RE.test(focus)) return new Response('Not found', { status: 404 });
    const url = new URL(req.url);
    const list = await cachedPublicList({ env, ctx, kv: env.LIMITS, origin: url.origin, base });
    if (list.unavailable) return new Response("The request list can't be read just now. Try again in a minute.", { status: 503, headers: { 'Cache-Control': 'no-store' } });
    if (!list.requests.some((r) => r.id === focus)) return new Response('Not found', { status: 404 });
  }
  const fill = {
    APP_NAME: esc(APP_NAME_OF(env, config)),
    REPO: esc(env.REPO_URL || 'https://github.com/jedelman/socrata-agent'),
    BASE: esc(base),
    ASSETS: esc(`${base}/assets/${ASSET_HASH}`),
    ORIGIN: esc(on ? publicOrigin(env).origin : ''),
    ENDORSE: on ? 'on' : 'off',
    FOCUS: esc(focus),
  };
  return new Response(REQUESTS_PAGE.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m)), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': on ? 'public, max-age=60' : 'public, max-age=300',
      'Content-Security-Policy': REQUESTS_CSP,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// The page, with the deployment's name, copy and skin filled in. Config text
// is escaped; skin markup comes from worker/skins.js, which is trusted code.
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function page(env) {
  const { config } = getDeployment(env);
  const ui = config.ui || {};
  const skinName = skins[ui.skin] ? ui.skin : 'plain';
  const skin = skins[skinName];
  const fill = {
    ASSETS: esc(`${basePath(env)}/assets/${ASSET_HASH}`),
    APP_NAME: esc(env.APP_NAME || config.name || 'socrata-agent'),
    SKIN: skinName,
    TAGLINE: esc(ui.tagline),
    LOADING: esc(ui.loading || 'Looking it up. This usually takes 10 to 30 seconds'),
    FOOTER_NOTE: esc(ui.footerNote),
    // Where questions go beyond this Worker (the model's provider, and what
    // it keeps), when the deployment states it.
    DATA_NOTE: ui.dataNote ? `<p>${esc(ui.dataNote)}</p>` : '',
    BADGE: esc(ui.badge),
    OPERATOR: esc(ui.operator ? `${APP_NAME_OF(env, config)} is run by ${ui.operator}. ` : ''),
    MARK: skin.mark,
    FONTS: skin.fonts,
    FAVICON: skin.favicon,
    // The other door (the free tier): only with PUBLIC_ASK on and ready; with
    // it off, the page is exactly as before.
    PUBLIC_DOOR: publicAskReady(env) ? '\n    <p class="convbar" id="public-door">Want to ask in public instead? Sign in with Bluesky at <a href="questions">the public questions page</a>.</p>' : '',
  };
  const html = UI.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': chatCsp(skin),
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// The free tier's routes, or null for any other path. Each fails closed (503)
// when the flag is on but something it needs is missing.
async function publicAskRoute(req, env, ctx, path, base) {
  const get = req.method === 'GET' || req.method === 'HEAD';
  const qPage = /^\/q\/([^/]{1,64})$/.exec(path);
  if (get && (path === '/questions' || qPage)) return questionsPage(req, env, base, qPage ? qPage[1] : '');
  if (req.method === 'GET' && path === '/api/questions') return handleQuestions(req, env, ctx, { base });
  const qApi = req.method === 'GET' && /^\/api\/q\/([^/]{1,64})$/.exec(path);
  if (qApi) return handleQuestion(req, env, ctx, qApi[1], { base });
  if (req.method === 'GET' && path === '/api/public/session') return handlePublicSession(req, env, { base });
  if (get && path === '/question-client-metadata.json') {
    const { config } = getDeployment(env);
    return handleQuestionMetadata(req, env, base, APP_NAME_OF(env, config));
  }
  if (get && path === '/admin/questions') {
    if (!publicAskReady(env)) return notReady(env);
    return new Response(ADMIN_QUESTIONS_PAGE.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => ({ ASSETS: esc(`${base}/assets/${ASSET_HASH}`), BASE: esc(base) })[k] ?? m), {
      headers: { ...PAGE_HEADERS(ADMIN_QUESTIONS_CSP), 'Cache-Control': 'no-store' },
    });
  }
  if (req.method === 'GET' && path === '/api/admin/questions') return handleAdminQuestions(req, env, path);
  if (req.method !== 'POST') return null;
  if (path === '/api/public/ask') return handlePublicAsk(req, env, ctx, publicAskDeps(req, env, base));
  if (path === '/api/public/withdraw') return handlePublicWithdraw(req, env, ctx);
  if (path === '/api/public/redeem') return handlePublicRedeem(req, env, { base, visitor: await visitorHash(req, env) });
  if (path === '/api/admin/questions/hide') return handleAdminQuestions(req, env, path);
  return null;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const base = basePath(env);
    // A deployment that moved (MOVED_FROM, worker/moved.js): its old address
    // answers only with redirects to the new one, carrying a cookie-held
    // invite along. Siren moved from jason-edelman.org/ask-siren to
    // ask-siren.jason-edelman.org on 2026-11-10. And plain http on the new
    // host goes to https, where the Secure session cookies work.
    const moved = (await movedResponse(req, env, base)) || httpsResponse(req, env);
    if (moved) return moved;
    // Served under a path on someone else's site (BASE_PATH): strip the prefix,
    // and send the bare path to the trailing-slash form so the page's relative
    // API links resolve under it. With no BASE_PATH (Siren's own origin), the
    // paths are served as they are.
    let path = url.pathname;
    if (base) {
      if (path === base) return Response.redirect(`${url.origin}${base}/${url.search}`, 301);
      if (!path.startsWith(`${base}/`)) return new Response('Not found', { status: 404 });
      path = path.slice(base.length);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/index.html' || path === '/login')) return page(env);
    // An invite carried over from the old address (worker/moved.js).
    if ((req.method === 'GET' || req.method === 'HEAD') && path === CARRY_PATH) return carryInviteResponse(req, env, base);
    if (req.method === 'GET' && path === '/api/cities') {
      return json(
        allowedCities(env).map((id) => ({ id, name: cities[id].name, portal: cities[id].portal, block: Boolean(cities[id].address) }))
      );
    }
    if (req.method === 'GET' && path === '/api/session') return handleSession(req, env);
    // The public source-request list: open to everyone, invited or not. With
    // Bluesky endorsements on, it carries counts and goes through the Cache API.
    if (req.method === 'GET' && path === '/api/requests') {
      // No `withdrawn` here: the mirror closes unlisted issues only when the
      // feed carries that list, so an unconfigured site closes nothing.
      if (!env.LIMITS) return json({ requests: [] });
      // KV failing is a JSON 503, never a thrown error, and never cached;
      // with endorsements on, nothing else is asked then. No `withdrawn` in
      // it either.
      const unavailable = () => json({ error: "The request list can't be read just now. Try again in a minute.", code: 'unavailable', requests: [] }, 503, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      if (!blueskyReady(env)) {
        // Flag off: the requests-only list, cached per location for 5 minutes.
        return cachedFeed(url, ctx, async () => {
          let list;
          try {
            list = await publicRequests(env.LIMITS);
          } catch (err) {
            console.error('public list: request records unreadable', String(err?.message || 'unknown').slice(0, 300));
            return unavailable();
          }
          return json(list, 200, { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
        });
      }
      const list = await cachedPublicList({ env, ctx, kv: env.LIMITS, origin: url.origin, base });
      if (list.unavailable) return unavailable();
      return json(list, 200, { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' });
    }
    // The browser client's OAuth client_id document, whenever PUBLIC_ORIGIN
    // is set (so the rollout can check it with the flag off).
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/endorse-client-metadata.json') {
      const { config } = getDeployment(env);
      return handleMetadata(req, env, base, APP_NAME_OF(env, config));
    }
    // Who endorsed one request on the public list (endorsers.js); 404 with the flag off.
    const endorsersPath = req.method === 'GET' && /^\/api\/requests\/([^/]{1,64})\/endorsers$/.exec(path);
    if (endorsersPath) return handleEndorsers(req, env, ctx, base, endorsersPath[1]);
    // Case files as W3C Web Annotations (JSON-LD), CC BY 4.0, for any tool or agent.
    if (req.method === 'GET' && (path === '/api/cases' || path.startsWith('/api/cases/'))) {
      const casesBase = `${siteOrigin(env, url)}${base}`;
      const h = { 'Content-Type': 'application/ld+json; profile="http://www.w3.org/ns/anno.jsonld"', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' };
      if (path === '/api/cases') {
        return json({ cases: Object.values(CASES).map((c) => ({ id: c.id, title: c.title, annotations: `${casesBase}/api/cases/${c.id}`, license: c.license })) }, 200, { 'Access-Control-Allow-Origin': '*' });
      }
      const doc = CASES[path.slice('/api/cases/'.length).replace(/\.jsonld$/, '')];
      if (!doc) return json({ error: 'No such case file.' }, 404);
      return new Response(JSON.stringify(toAnnotations(doc, casesBase), null, 2), { headers: h });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/admin') {
      const { config } = getDeployment(env);
      const questionsLink = publicAskReady(env) ? '\n  <p class="lede"><a href="admin/questions">Public questions</a>: hide or unhide a question asked in public.</p>' : '';
      return new Response(ADMIN_PAGE.replace(/\{\{APP_NAME\}\}/g, esc(APP_NAME_OF(env, config))).replace('{{QUESTIONS_LINK}}', questionsLink), {
        // Its buttons act for the signed-in steward, so it can't be framed.
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' },
      });
    }
    if (req.method === 'GET' && path === '/api/admin/requests') return handleAdmin(req, env, path, ctx);
    // The requests page, and with endorsements on a page per listed request
    // (the URL endorsement records point at). Served under a strict CSP.
    const permalink = /^\/requests\/([^/]{1,64})$/.exec(path);
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/requests' || permalink)) {
      return requestsPage(req, env, ctx, base, permalink ? permalink[1] : '');
    }
    // The pages' scripts and styles, and the browser client, as text.
    const asset = /^\/assets\/([0-9a-f]{16})\/([a-z-]+\.(?:js|css))$/.exec(path);
    if ((req.method === 'GET' || req.method === 'HEAD') && asset && ASSETS[asset[2]] && (!ASK_ASSETS.has(asset[2]) || publicAskOn(env))) return assetResponse(asset[1], asset[2]);
    if (req.method === 'GET' && (path === '/api/conversations' || path === '/api/conversation')) return handleConversations(req, env, path);
    if (req.method === 'POST' && !isJson(req)) return json({ error: 'Send JSON (Content-Type: application/json).' }, 415);
    if (req.method === 'POST' && path === '/api/ask') return handleAsk(req, env, ctx);
    if (req.method === 'POST' && path === '/api/redeem') return handleRedeem(req, env);
    if (req.method === 'POST' && path === '/api/waitlist') return handleWaitlist(req, env);
    if (req.method === 'POST' && path === '/api/login') return handleLogin(req, env);
    if (req.method === 'POST' && path === '/api/requests') return handleRequest(req, env);
    if (req.method === 'POST' && (path === '/api/admin/requests/decide' || path === '/api/admin/requests/note')) return handleAdmin(req, env, path, ctx);
    if (req.method === 'POST' && path === '/api/bsky/resolve') return handleResolve(req, env);
    if (req.method === 'POST' && path === '/api/login/verify') return handleLoginVerify(req, env);
    if (req.method === 'POST' && path === '/api/logout') return json({ ok: true }, 200, { 'Set-Cookie': clearUserCookie(`${basePath(env)}/`), 'Cache-Control': 'no-store' });
    if (req.method === 'POST' && (path === '/api/conversations/delete' || path === '/api/conversations/delete-all')) return handleConversations(req, env, path);
    // The free tier (docs/free-tier.md): with PUBLIC_ASK anything but "true",
    // none of this is reached and every one of these paths is the 404 below.
    if (publicAskOn(env)) {
      const res = await publicAskRoute(req, env, ctx, path, base);
      if (res) return res;
    }
    return new Response('Not found', { status: 404 });
  },
};
