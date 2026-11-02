// Cloudflare Worker: the public chat app. The operator's OpenRouter key lives
// in a secret; every visitor shares it, so every request is limited:
//   - per visitor (hashed IP) per day      PER_IP_DAILY       default 20
//   - or, behind Cloudflare Access, per person (verified email) per day
//                                          PER_USER_DAILY     default 40
//   - for everyone per day, in dollars     DAILY_BUDGET_USD   default 2
//   - per question: length, history, tool steps, output tokens
// Limits are counted in KV (binding LIMITS). KV is eventually consistent, so a
// burst can overshoot by a few requests; set an OpenRouter key limit as the
// hard ceiling.

import { ask } from '../src/agent.js';
import { cities, getCity } from '../src/cities/index.js';
import norfolkLegislation from '../data/norfolk-legislation.json';
import UI from './ui.html';
import deployments from '../deployments/index.js';
import { applyConfig, definePlugin } from '../src/plugins.js';
import { verifyAccess } from './access.js';
import { skins } from './skins.js';
import { setting, visitorId, spentToday, recordSpend } from './limits.js';
import { currentInvite, redeem, joinWaitlist, sessionCookie, signSession } from './invites.js';

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

function allowedCities(env) {
  const { config: deployment } = getDeployment(env);
  const ids = (deployment.city || env.CITIES || Object.keys(cities).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.filter((id) => cities[id]);
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
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));

  const kv = env.LIMITS;
  if (!kv && env.ALLOW_UNLIMITED !== 'true') {
    // Fail closed: a public deploy without limits would spend the shared key freely.
    return json({ error: 'This site is not configured yet (no usage limits are set up).' }, 503);
  }
  if (!env.OPENROUTER_API_KEY) return json({ error: 'This site is not configured yet (no model key).' }, 503);
  const day = today();
  const budget = setting(env.DAILY_BUDGET_USD, 2);
  // Behind Cloudflare Access, count per verified person; in invite-only mode,
  // per invite; otherwise per hashed IP.
  let who;
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
    const invite = await currentInvite(req, env, kv);
    if (!invite) return json({ error: 'Siren is invite-only for now. Enter your invite code, or join the waitlist.', gate: 'invite' }, 401);
    who = { key: `inv-day:${day}:${invite.hash.slice(0, 32)}`, limit: setting(env.PER_INVITE_DAILY, 30), kind: 'invite' };
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

  // Every paid call is counted as it happens, so spend is recorded even when a
  // later step fails or the visitor leaves; the write runs after the response.
  let cost = 0;
  try {
    const out = await ask({
      question,
      history,
      city: applyConfig(getCity(cityId), deployment),
      plugins,
      indexes: INDEXES,
      apiKey: env.OPENROUTER_API_KEY,
      appToken: env.SOCRATA_APP_TOKEN,
      model: env.MODEL || deployment.model,
      maxSteps: setting(env.MAX_STEPS, 6, { min: 1, max: 12 }),
      maxTokens: setting(env.MAX_TOKENS, 1200, { min: 100, max: 4000 }),
      referer: new URL(req.url).origin,
      onCost: (usd) => {
        cost += usd;
      },
    });
    return json({ city: cityId, ...out });
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong answering that. Try again, or rephrase.', detail: String(err.message || err).slice(0, 300) }, 502);
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
  if (inviteOnly(env) && !inviteSetupError(env)) {
    const invite = await currentInvite(req, env, env.LIMITS);
    if (invite) {
      invited = true;
      headers['Set-Cookie'] = sessionCookie(await signSession(env.INVITE_SECRET, invite.hash), `${basePath(env)}/`);
    }
  }
  return json({ invite_required: inviteOnly(env), invited, waitlist: inviteOnly(env) }, 200, headers);
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
  const current = (await currentInvite(req, env, env.LIMITS))?.hash || null;
  const out = await redeem({
    code: body?.code, env, kv: env.LIMITS, visitor: await visitorHash(req, env), current,
    maxFailures: setting(env.REDEEM_FAILURES_HOURLY, 30, { min: 1 }),
  });
  if (!out.ok) return json({ error: out.error }, out.status);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(out.cookie, `${basePath(env)}/`), 'Cache-Control': 'no-store' });
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
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return new Response(page(env), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    }
    if (req.method === 'GET' && path === '/api/cities') {
      return json(
        allowedCities(env).map((id) => ({ id, name: cities[id].name, portal: cities[id].portal, block: Boolean(cities[id].address) }))
      );
    }
    if (req.method === 'GET' && path === '/api/session') return handleSession(req, env);
    if (req.method === 'POST' && !isJson(req)) return json({ error: 'Send JSON (Content-Type: application/json).' }, 415);
    if (req.method === 'POST' && path === '/api/ask') return handleAsk(req, env, ctx);
    if (req.method === 'POST' && path === '/api/redeem') return handleRedeem(req, env);
    if (req.method === 'POST' && path === '/api/waitlist') return handleWaitlist(req, env);
    return new Response('Not found', { status: 404 });
  },
};
