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
import UI from './ui.html';
import deployments from '../deployments/index.js';
import { applyConfig, definePlugin } from '../src/plugins.js';
import { verifyAccess } from './access.js';
import { skins } from './skins.js';
import { setting, askLimits, visitorId, spentToday, recordSpend } from './limits.js';
import { currentInvite, redeem, joinWaitlist, sessionCookie, signSession } from './invites.js';
import { currentUser, currentUserInfo, startLogin, finishLogin, memberInvite, bindInvite, loginConfigured, userCookie, clearUserCookie } from './accounts.js';
import { addRequest, raiseResponse, publicRequests } from './requests.js';
import { hmacHex } from './crypto.js';
import { handleAdmin, scheduledPurge } from './admin.js';
import { cachedPublicList } from './public-list.js';
import {
  blueskyReady, handleMetadata, handleLogin as handleBskyLogin, handleCallback, handleMe, handleLogout as handleBskyLogout,
  handleEndorse, handleUnendorse, handleForget,
} from './bluesky.js';
import REQUESTS_PAGE from './requests.html';
import ADMIN_PAGE from './admin.html';
import { CASES } from '../plugins/case-file.js';
import { toAnnotations } from '../plugins/cases.js';
import { loadConversation, saveTurn, historyFrom, listConversations, deleteConversation, newConversationId, turnView } from './conversations.js';

// DEPLOYMENT picks a config from deployments/index.js; unknown names fail
// loudly rather than quietly serving the default.
const prepared = new Map();
function getDeployment(env) {
  const name = env.DEPLOYMENT || 'default';
  if (!prepared.has(name)) {
    const config = deployments[name];
    if (!config) throw new Error(`Unknown DEPLOYMENT "${name}". Known: ${Object.keys(deployments).join(', ')}`);
    prepared.set(name, { config, plugins: (config.plugins || []).map(definePlugin) });
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

  // Every paid call is counted as it happens, so spend is recorded even when a
  // later step fails or the visitor leaves; the write runs after the response.
  let cost = 0;
  try {
    const out = await ask({
      question,
      history,
      carried,
      city: applyConfig(getCity(cityId), deployment),
      plugins,
      indexes: INDEXES,
      apiKey,
      appToken: env.SOCRATA_APP_TOKEN,
      model,
      effort: env.EFFORT || undefined,
      // Steps, outbound requests and tokens per answer (worker/limits.js).
      ...askLimits(env, providerOf(model)),
      referer: new URL(req.url).origin,
      onCost: (usd) => {
        cost += usd;
      },
    });
    const { toolResults, ...answer } = out;
    if (conversationId) {
      const save = saveTurn(kv, uid, conversationId, conversation, { city: cityId, question, answer: out.answer, tools: toolResults, record: answer }, { days: env.CONVERSATION_DAYS })
        .catch((err) => console.error('saving the conversation failed', err));
      if (ctx?.waitUntil) ctx.waitUntil(save);
      else await save;
    }
    return json({ city: cityId, ...answer, ...(conversationId ? { conversation: conversationId } : {}) });
  } catch (err) {
    console.error(err);
    // The full upstream error goes to the operator's log only; visitors get the gist.
    const status = String(err?.message || '').match(/^(Anthropic|OpenRouter) (\d{3}|error)/);
    return json({ error: 'Something went wrong answering that. Try again, or rephrase.', ...(status ? { detail: `${status[1]} ${status[2]}` } : {}) }, 502);
  } finally {
    if (kv && cost) {
      const write = recordSpend(kv, day, cost).catch((err) => console.error('recording spend failed', err));
      if (ctx?.waitUntil) ctx.waitUntil(write);
      else await write;
    }
  }
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
  const origin = new URL(req.url).origin;
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
  const out = await addRequest({ body: await readJson(req), kv, visitor: await visitorHash(req, env) });
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
    if (!conv) return json({ error: 'That conversation is gone (they expire) or was never yours.' }, 404, headers);
    return json({ city: conv.city, turns: conv.turns.map(turnView) }, 200, headers);
  }
  if (req.method === 'POST' && path === '/api/conversations/delete') {
    const body = await readJson(req);
    await deleteConversation(kv, uid, body?.id);
    return json({ ok: true }, 200, headers);
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

// The page, with the deployment's name, copy and skin filled in. Config text
// is escaped; skin markup comes from worker/skins.js, which is trusted code.
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function page(env) {
  const { config } = getDeployment(env);
  const ui = config.ui || {};
  const skinName = skins[ui.skin] ? ui.skin : 'plain';
  const skin = skins[skinName];
  const fill = {
    APP_NAME: esc(env.APP_NAME || config.name || 'socrata-agent'),
    SKIN: skinName,
    TAGLINE: esc(ui.tagline),
    LOADING: esc(ui.loading || 'Looking it up. This usually takes 10 to 30 seconds'),
    FOOTER_NOTE: esc(ui.footerNote),
    BADGE: esc(ui.badge),
    OPERATOR: esc(ui.operator ? `${APP_NAME_OF(env, config)} is run by ${ui.operator}. ` : ''),
    MARK: skin.mark,
    FONTS: skin.fonts,
    FAVICON: skin.favicon,
  };
  return UI.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

export default {
  // The daily cron: deletes endorsement rows past their expiry (admin.js
  // scheduledPurge). Without BLUESKY_LOGIN and SIREN_DB it does nothing.
  async scheduled(controller, env, ctx) {
    scheduledPurge(env, ctx);
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Served under a path on someone else's site (jason-edelman.org/ask-siren):
    // strip the prefix, and send the bare path to the trailing-slash form so the
    // page's relative API links resolve under it.
    let path = url.pathname;
    const base = basePath(env);
    if (base) {
      if (path === base) return Response.redirect(`${url.origin}${base}/${url.search}`, 301);
      if (!path.startsWith(`${base}/`)) return new Response('Not found', { status: 404 });
      path = path.slice(base.length);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/index.html' || path === '/login')) {
      return new Response(page(env), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    }
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
      // KV failing (or past the Free plan's daily list operations) is a JSON
      // 503, never a thrown error, and never cached; with endorsements on,
      // D1 isn't asked then. No `withdrawn` in it either.
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
    // Bluesky sign-in (bluesky.js). The client metadata is the OAuth client_id
    // URL, served whenever PUBLIC_ORIGIN is set; the rest need BLUESKY_LOGIN.
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/oauth-client-metadata.json') {
      const { config } = getDeployment(env);
      return handleMetadata(req, env, base, APP_NAME_OF(env, config));
    }
    if (req.method === 'GET' && path === '/oauth/callback') return handleCallback(req, env, ctx, base);
    if (req.method === 'GET' && path === '/api/bsky/me') return handleMe(req, env, ctx, base);
    // Case files as W3C Web Annotations (JSON-LD), CC BY 4.0, for any tool or agent.
    if (req.method === 'GET' && (path === '/api/cases' || path.startsWith('/api/cases/'))) {
      const casesBase = `${url.origin}${base}`;
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
      return new Response(ADMIN_PAGE.replace(/\{\{APP_NAME\}\}/g, esc(APP_NAME_OF(env, config))), {
        // Its buttons act for the signed-in steward, so it can't be framed.
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' },
      });
    }
    if (req.method === 'GET' && path === '/api/admin/requests') return handleAdmin(req, env, path, ctx);
    if ((req.method === 'GET' || req.method === 'HEAD') && path === '/requests') {
      const { config } = getDeployment(env);
      // The page can't be framed (with sign-in on, its buttons act for a signed-in account).
      const frame = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
      const extra = { ...frame, 'Cache-Control': blueskyReady(env) ? 'public, max-age=60' : 'public, max-age=300' };
      return new Response(REQUESTS_PAGE.replace(/\{\{APP_NAME\}\}/g, esc(APP_NAME_OF(env, config))).replace(/\{\{REPO\}\}/g, esc(env.REPO_URL || 'https://github.com/jedelman/socrata-agent')), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra },
      });
    }
    if (req.method === 'GET' && (path === '/api/conversations' || path === '/api/conversation')) return handleConversations(req, env, path);
    if (req.method === 'POST' && !isJson(req)) return json({ error: 'Send JSON (Content-Type: application/json).' }, 415);
    if (req.method === 'POST' && path === '/api/ask') return handleAsk(req, env, ctx);
    if (req.method === 'POST' && path === '/api/redeem') return handleRedeem(req, env);
    if (req.method === 'POST' && path === '/api/waitlist') return handleWaitlist(req, env);
    if (req.method === 'POST' && path === '/api/login') return handleLogin(req, env);
    if (req.method === 'POST' && path === '/api/requests') return handleRequest(req, env);
    if (req.method === 'POST' && (path === '/api/admin/requests/decide' || path === '/api/admin/requests/note' || path === '/api/admin/requests/endorsements/clear')) return handleAdmin(req, env, path, ctx);
    if (req.method === 'POST' && path === '/api/bsky/login') return handleBskyLogin(req, env, ctx, base);
    if (req.method === 'POST' && path === '/api/bsky/logout') return handleBskyLogout(req, env, base);
    if (req.method === 'POST' && path === '/api/bsky/forget') return handleForget(req, env, ctx, base);
    if (req.method === 'POST' && path === '/api/bsky/endorse') return handleEndorse(req, env, ctx, base);
    if (req.method === 'POST' && path === '/api/bsky/unendorse') return handleUnendorse(req, env, ctx, base);
    if (req.method === 'POST' && path === '/api/login/verify') return handleLoginVerify(req, env);
    if (req.method === 'POST' && path === '/api/logout') return json({ ok: true }, 200, { 'Set-Cookie': clearUserCookie(`${basePath(env)}/`), 'Cache-Control': 'no-store' });
    if (req.method === 'POST' && path === '/api/conversations/delete') return handleConversations(req, env, path);
    return new Response('Not found', { status: 404 });
  },
};
