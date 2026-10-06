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

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function allowedCities(env) {
  const { config: deployment } = getDeployment(env);
  const ids = (deployment.city || env.CITIES || Object.keys(cities).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.filter((id) => cities[id]);
}

async function handleAsk(req, env) {
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
  const budget = Number(env.DAILY_BUDGET_USD || 2);
  // Behind Cloudflare Access, count per verified person; otherwise per hashed IP.
  let who;
  if (env.ACCESS_TEAM_DOMAIN) {
    try {
      const { email } = await verifyAccess(req, env);
      who = { key: `user:${day}:${(await sha256(`${env.IP_SALT || 'socrata-agent'}:${email}`)).slice(0, 32)}`, limit: Number(env.PER_USER_DAILY || 40), kind: 'person' };
    } catch (err) {
      return json({ error: 'Sign in through this site\'s access page first.', detail: err.message }, 401);
    }
  } else {
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    who = { key: `ip:${day}:${(await sha256(`${env.IP_SALT || 'socrata-agent'}:${ip}`)).slice(0, 32)}`, limit: Number(env.PER_IP_DAILY || 20), kind: 'visitor' };
  }
  const ipKey = who.key;
  if (kv) {
    const [used, spent] = await Promise.all([kv.get(ipKey), kv.get(`spend:${day}`)]);
    if (Number(used || 0) >= who.limit) {
      return json({ error: `You've asked ${who.limit} questions today, the limit for this site. It resets at midnight UTC. To keep going now, run socrata-agent on your own computer with your own key.`, limit: who.kind }, 429);
    }
    if (Number(spent || 0) / 1e6 >= budget) {
      return json({ error: "Today's shared budget for this free site is used up. It resets at midnight UTC. To keep going now, run socrata-agent on your own computer with your own key.", limit: 'budget' }, 503);
    }
    await kv.put(ipKey, String(Number(used || 0) + 1), { expirationTtl: 172800 });
  }

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
      maxSteps: Number(env.MAX_STEPS || 6),
      maxTokens: Number(env.MAX_TOKENS || 1200),
      referer: new URL(req.url).origin,
    });
    if (kv && out.cost) {
      const key = `spend:${day}`;
      const spent = Number((await kv.get(key)) || 0);
      await kv.put(key, String(spent + Math.round(out.cost * 1e6)), { expirationTtl: 172800 });
    }
    return json({ city: cityId, ...out });
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong answering that. Try again, or rephrase.', detail: String(err.message || err).slice(0, 300) }, 502);
  }
}

// The page, with the deployment's name filled in.
function page(env) {
  const { config } = getDeployment(env);
  const name = env.APP_NAME || config.name || 'socrata-agent';
  return UI.replaceAll('{{APP_NAME}}', name.replace(/[<>&"]/g, ''));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Served under a path on someone else's site (jason-edelman.org/ask-siren):
    // strip the prefix, and send the bare path to the trailing-slash form so the
    // page's relative API links resolve under it.
    let path = url.pathname;
    const base = (env.BASE_PATH || '').replace(/\/$/, '');
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
    if (req.method === 'POST' && path === '/api/ask') return handleAsk(req, env);
    return new Response('Not found', { status: 404 });
  },
};
