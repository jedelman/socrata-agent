// The flag-off scenario test/public-ask-off.test.js holds byte-identical to
// the code before the free tier (docs/free-tier.md): every existing route of
// the Worker, through its own fetch handler, in three envs (the default
// deployment; Siren invite-only; Siren with Bluesky endorsements on and
// SIREN_DB bound), plus the paths the free tier adds, which must stay 404s.
// public-ask-off-snapshot.json is this scenario's output from main at f6f0e9e (the
// code before any free-tier code; retaken after main gained #31), with
// conversation browsing and search applied to it (retaken 2026-11-10 on
// f6f0e9e plus that change's worker files: still no free-tier code).
//
// Each entry keeps the status, every header and the body (its text when
// short, else its SHA-256 and length), the outbound URLs it made and whether
// it touched D1. Normalized: the asset hash (it changes with any deploy that
// changes a served file) reads {HASH}; signed cookie and token values read
// <signed>; trace timings read 0. Nothing else is rewritten.

import { createHash } from 'node:crypto';
import { signSession } from '../../worker/invites.js';
import { signUser, userId } from '../../worker/accounts.js';
import { claudeResponse } from '../fake-claude.js';

const SECRET = 'test-secret-that-is-long-enough';
const ORIGIN = 'https://ask-siren.jason-edelman.org';
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const HANDLE = 'alice.fixture.dev';
const PDS = 'https://pds.fixture.dev';

function kv() {
  const store = new Map();
  return {
    async get(k, type) {
      if (Array.isArray(k)) return new Map(k.map((x) => [x, store.has(x) ? (type === 'json' ? JSON.parse(store.get(x)) : store.get(x)) : null]));
      if (!store.has(k)) return null;
      return type === 'json' ? JSON.parse(store.get(k)) : store.get(k);
    },
    async getWithMetadata(k) {
      return { value: store.get(k) ?? null, metadata: null };
    },
    async put(k, v) {
      store.set(k, String(v));
    },
    async delete(k) {
      store.delete(k);
    },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true };
    },
    store,
  };
}

const limiter = () => ({ async limit() { return { success: true }; } });

// A D1 binding that records any use: nothing on these routes may touch it.
function d1(log) {
  const touch = (what) => {
    log.d1 = true;
    throw new Error(`D1 touched: ${what}`);
  };
  return { prepare: (sql) => touch(sql), batch: () => touch('batch'), exec: (sql) => touch(sql), dump: () => touch('dump') };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The outside world: the model provider answers one plain sentence; the
// handle resolves over DoH and the PLC directory; anything else is a 404.
function network(log) {
  return async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    log.urls.push(url.replace(/[?#].*$/, ''));
    const u = new URL(url);
    if (url.startsWith('https://api.anthropic.com/v1/messages')) {
      return claudeResponse(init, {
        id: 'msg_off', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_details: null,
        content: [{ type: 'text', text: 'I found no records for that question.' }],
        usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    }
    if (u.host === 'dns.fixture.dev') {
      return u.searchParams.get('name') === `_atproto.${HANDLE}` ? json({ Status: 0, Answer: [{ name: `_atproto.${HANDLE}`, type: 16, data: `"did=${DID}"` }] }) : json({ Status: 3 });
    }
    if (u.host === 'plc.fixture.dev' && u.pathname === `/${DID}`) {
      return json({ id: DID, alsoKnownAs: [`at://${HANDLE}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    }
    return new Response('not found', { status: 404 });
  };
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

function normalize(text, hash) {
  let s = text;
  if (hash) s = s.split(hash).join('{HASH}');
  return s
    .replace(/=([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g, '=<signed>')
    .replace(/"ms":\d+/g, '"ms":0');
}

const ENVS = {
  // The default deployment, open to everyone.
  plain: () => ({ LIMITS: kv(), IP_SALT: 'salt' }),
  // Siren as deployed: invite-only, its own origin, endorsements off.
  siren: () => ({
    DEPLOYMENT: 'siren', BASE_PATH: '', PUBLIC_ORIGIN: ORIGIN, INVITE_REQUIRED: 'true', INVITE_SECRET: SECRET, IP_SALT: 'salt',
    MODEL: 'claude-sonnet-5-5', ANTHROPIC_API_KEY: 'sk-ant-test', ADMIN_EMAILS: 'steward@example.org', LIMITS: kv(),
  }),
  // Siren with endorsements on and SIREN_DB bound.
  bsky: (log) => ({
    ...ENVS.siren(), BLUESKY_LOGIN: 'true', BSKY_VISITOR_RL: limiter(), BSKY_INPUT_RL: limiter(), BSKY_SITE_RL: limiter(),
    DOH_URL: 'https://dns.fixture.dev/dns-query', PLC_URL: 'https://plc.fixture.dev', CONSTELLATION_URL: 'https://constellation.fixture.dev',
    APPVIEW_URL: 'https://appview.fixture.dev', SIREN_DB: d1(log),
  }),
};

// Every asset the code before the free tier serves, and the names it adds.
const ASSETS = ['requests-page.js', 'requests.css', 'chat-page.js', 'chat.css', 'endorse-client.js', 'endorse-store.js', 'atproto-identity.js', 'atproto-oauth.js', 'endorse-config.js', 'crypto.js'];
const NEW_ASSETS = ['questions-page.js', 'questions.css', 'admin-questions.js'];
// The free tier's paths: with the flag off, each answers as before (a 404).
const NEW_GETS = ['/questions', '/q/abcdefghijklmnop', '/api/questions', '/api/q/abcdefghijklmnop', '/api/public/session', '/admin/questions', '/api/admin/questions', '/question-client-metadata.json'];
const NEW_POSTS = ['/api/public/ask', '/api/public/withdraw', '/api/public/redeem', '/api/admin/questions/hide'];

/**
 * Runs every case against `worker` with `extraEnv` laid over each env (the
 * test passes {} and { PUBLIC_ASK: 'false' }). -> the entries, in order.
 */
export async function publicAskOffScenario({ worker, extraEnv = {} }) {
  const out = [];
  const realFetch = globalThis.fetch;
  try {
    for (const name of Object.keys(ENVS)) {
      const log = { urls: [], d1: false };
      globalThis.fetch = network(log);
      const env = { ...ENVS[name](log), ...extraEnv };
      const invite = async () => {
        const hash = sha('INVITECODE1');
        await env.LIMITS.put(`invite:${hash}`, JSON.stringify({ label: 'test', max_uses: 5 }));
        return `__Host-siren_invite=${await signSession(SECRET, hash)}`;
      };
      const steward = async () => `__Host-siren_user=${await signUser(SECRET, await userId(SECRET, 'steward@example.org'))}`;
      const waits = [];
      const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };
      let hash = '';
      const run = async (label, path, init = {}) => {
        log.urls.length = 0;
        log.d1 = false;
        const headers = new Headers(init.headers || {});
        if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', '203.0.113.9');
        let res;
        try {
          res = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, ctx);
        } catch (err) {
          out.push({ env: name, label, threw: String(err?.message || err) });
          return '';
        }
        const text = init.method === 'HEAD' ? '' : await res.text();
        await Promise.all(waits.splice(0));
        if (!hash) hash = (/\/assets\/([0-9a-f]{16})\//.exec(text) || [])[1] || '';
        const body = normalize(text, hash);
        const hdrs = {};
        for (const [k, v] of [...res.headers.entries()].sort()) hdrs[k] = normalize(v, hash);
        out.push({
          env: name, label, status: res.status, headers: hdrs,
          body: body.length <= 200 ? body : { sha256: sha(body), length: body.length },
          urls: [...log.urls], d1: log.d1,
        });
        return text;
      };
      const postJson = (path, body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

      // Pages.
      await run('GET /', '/');
      await run('HEAD /', '/', { method: 'HEAD' });
      await run('GET /index.html', '/index.html');
      await run('GET /login', '/login');
      await run('GET /requests', '/requests');
      await run('GET /requests/<id>', '/requests/abcdefghijklmnop');
      await run('GET /admin', '/admin');
      await run('GET /carry-invite', '/carry-invite?t=x');
      for (const a of ASSETS) await run(`GET asset ${a}`, `/assets/${hash || '0000000000000000'}/${a}`);
      await run('HEAD asset chat-page.js', `/assets/${hash || '0000000000000000'}/chat-page.js`, { method: 'HEAD' });
      await run('GET stale asset', '/assets/0000000000000000/endorse-client.js');
      for (const a of NEW_ASSETS) await run(`GET new asset ${a}`, `/assets/${hash || '0000000000000000'}/${a}`);
      // JSON routes.
      await run('GET /api/cities', '/api/cities');
      await run('GET /api/session', '/api/session');
      await run('GET /api/session (invite)', '/api/session', { headers: { Cookie: await invite() } });
      await run('GET /api/requests', '/api/requests');
      await run('GET /endorse-client-metadata.json', '/endorse-client-metadata.json');
      await run('GET endorsers', '/api/requests/abcdefghijklmnop/endorsers');
      await run('GET /api/cases', '/api/cases');
      await run('GET /api/admin/requests', '/api/admin/requests');
      await run('GET /api/admin/requests (steward)', '/api/admin/requests', { headers: { Cookie: await steward() } });
      await run('GET /api/conversations', '/api/conversations');
      await run('GET /api/conversation', '/api/conversation?id=x');
      await run('GET /api/conversations/search', '/api/conversations/search?q=trees');
      // Posts.
      await run('POST text/plain', '/api/ask', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
      await run('POST /api/ask (empty)', '/api/ask', postJson('/api/ask', {}));
      await run('POST /api/ask (no invite)', '/api/ask', postJson('/api/ask', { question: 'What is on my block?', city: 'norfolk' }));
      await run('POST /api/ask (invite)', '/api/ask', postJson('/api/ask', { question: 'What is on my block?', city: 'norfolk' }, { Cookie: await invite() }));
      await run('POST /api/ask (invite, stream)', '/api/ask', postJson('/api/ask', { question: 'What is on my block?', city: 'norfolk' }, { Cookie: await invite(), Accept: 'application/x-ndjson, application/json' }));
      await run('POST /api/redeem', '/api/redeem', postJson('/api/redeem', { code: 'SIREN-AAAAA-AAAAA' }));
      await run('POST /api/waitlist', '/api/waitlist', postJson('/api/waitlist', { email: 'not-an-email' }));
      await run('POST /api/login', '/api/login', postJson('/api/login', { email: 'a@example.org' }));
      await run('POST /api/login/verify', '/api/login/verify', postJson('/api/login/verify', { token: 'x' }));
      await run('POST /api/logout', '/api/logout', postJson('/api/logout', {}));
      await run('POST /api/requests', '/api/requests', postJson('/api/requests', { source: 'Tree inventory', need: 'q', public: true }, { Cookie: await invite() }));
      await run('POST decide', '/api/admin/requests/decide', postJson('/api/admin/requests/decide', { id: 'abcdefghijklmnop', status: 'accepted' }));
      await run('POST /api/bsky/resolve', '/api/bsky/resolve', postJson('/api/bsky/resolve', { account: HANDLE }, { Origin: ORIGIN }));
      await run('POST /api/conversations/delete', '/api/conversations/delete', postJson('/api/conversations/delete', { id: 'x' }));
      await run('POST /api/conversations/search', '/api/conversations/search', postJson('/api/conversations/search', { q: 'trees' }));
      // The free tier's paths.
      for (const p of NEW_GETS) await run(`GET ${p}`, p);
      for (const p of NEW_POSTS) await run(`POST ${p}`, p, postJson(p, { uri: `at://${DID}/x.y.z/3kabc`, cid: 'bafy' }, { Cookie: await invite() }));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return out;
}
