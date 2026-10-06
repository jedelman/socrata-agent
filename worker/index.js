// Cloudflare Worker: the public chat app. The operator's OpenRouter key lives
// in a secret; every visitor shares it, so every request is limited:
//   - per visitor (hashed IP) per day      PER_IP_DAILY       default 20
//   - for everyone per day, in dollars     DAILY_BUDGET_USD   default 2
//   - per question: length, history, tool steps, output tokens
// Limits are counted in KV (binding LIMITS). KV is eventually consistent, so a
// burst can overshoot by a few requests; set an OpenRouter key limit as the
// hard ceiling.

import { ask } from '../src/agent.js';
import { cities, getCity } from '../src/cities/index.js';
import norfolkLegislation from '../data/norfolk-legislation.json';
import UI from './ui.html';

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
  const ids = (env.CITIES || Object.keys(cities).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.filter((id) => cities[id]);
}

async function handleAsk(req, env) {
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
  const perIp = Number(env.PER_IP_DAILY || 20);
  const budget = Number(env.DAILY_BUDGET_USD || 2);
  let ipKey;
  if (kv) {
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    ipKey = `ip:${day}:${(await sha256(`${env.IP_SALT || 'socrata-agent'}:${ip}`)).slice(0, 32)}`;
    const [used, spent] = await Promise.all([kv.get(ipKey), kv.get(`spend:${day}`)]);
    if (Number(used || 0) >= perIp) {
      return json({ error: `You've asked ${perIp} questions today, the limit for this free site. It resets at midnight UTC. To keep going now, run socrata-agent on your own computer with your own key.`, limit: 'visitor' }, 429);
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
      city: getCity(cityId),
      indexes: INDEXES,
      apiKey: env.OPENROUTER_API_KEY,
      appToken: env.SOCRATA_APP_TOKEN,
      model: env.MODEL,
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

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(UI, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/cities') {
      return json(
        allowedCities(env).map((id) => ({ id, name: cities[id].name, portal: cities[id].portal, block: Boolean(cities[id].address) }))
      );
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') return handleAsk(req, env);
    return new Response('Not found', { status: 404 });
  },
};
