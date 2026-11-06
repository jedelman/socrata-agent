// What a KV dump would show after Bluesky sign-in and endorsing: no DID,
// handle, issuer or token; nothing that joins one account's endorsements,
// or an endorsement to a visitor or an email account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLogin, handleCallback, handleEndorse, handleUnendorse, bskyVisitor, FLOW_COOKIE, BSKY_COOKIE, openSession } from '../worker/bluesky.js';
import { addRequest, decide, requestKey, publicId } from '../worker/requests.js';
import { startLogin, userId } from '../worker/accounts.js';
import { hmacHex, sha256, hex, boundary } from '../worker/crypto.js';
import { visitorId } from '../worker/limits.js';
import { W, fakeNetwork, readyEnv, SECRET } from './fake-atproto.js';

const ORIGIN = 'https://jason-edelman.org';
const BASE = '/ask-siren';
const IP = '198.51.100.23';

const req = (path, { method = 'GET', body, cookie } = {}) => new Request(`${ORIGIN}${BASE}${path}`, {
  method,
  headers: { 'CF-Connecting-IP': IP, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const hexRuns = (s, n) => {
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
};

test('a KV dump after sign-in, endorsing and an email sign-in holds no identity and no joins', async () => {
  const env = readyEnv({ RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <s@example.org>' });
  const kv = env.LIMITS;
  const net = fakeNetwork();
  const now = Date.now();

  // Three requests: two accepted, one new. The asker's visitor hash is the one index.js uses.
  const visitorHash = hex(await sha256(`${env.IP_SALT}:${visitorId(IP)}`)).slice(0, 32);
  for (const s of ['Source one', 'Source two', 'Source three']) await addRequest({ body: { source: s }, kv, visitor: visitorHash });
  const id1 = publicId(await requestKey('Source one'));
  const id2 = publicId(await requestKey('Source two'));
  await decide(kv, { id: id1, status: 'accepted' });
  await decide(kv, { id: id2, status: 'accepted' });
  await kv.put(`redeem-failures:${new Date().toISOString().slice(0, 13)}:${visitorHash}`, '1', { expirationTtl: 7200 });

  // A full Bluesky sign-in.
  const login = await handleLogin(req('/api/bsky/login', { method: 'POST', body: { account: W.HANDLE } }), env, null, BASE, { fetchImpl: net.fetch, now });
  assert.equal(login.status, 200);
  const flow = login.headers.get('Set-Cookie').match(/^siren_bsky_flow=([^;]*)/)[1];
  const state = net.state.par[0].form.state;
  const cb = await handleCallback(req(`/oauth/callback?state=${encodeURIComponent(state)}&iss=${encodeURIComponent(W.ISSUER)}&code=${W.CODE}`, { cookie: `${FLOW_COOKIE}=${flow}` }), env, null, BASE, { fetchImpl: net.fetch, now, defer: () => {} });
  const sessionValue = cb.headers.getSetCookie()[0].match(/^siren_bsky=([^;]*)/)[1];
  const cookie = `${BSKY_COOKIE}=${sessionValue}`;
  const { eid } = await openSession(SECRET, sessionValue);

  // Two endorsements on different requests, then an unendorse of a third id.
  for (const id of [id1, id2]) assert.equal((await handleEndorse(req('/api/bsky/endorse', { method: 'POST', body: { id }, cookie }), env, null, BASE, { now })).status, 200);
  assert.equal((await handleUnendorse(req('/api/bsky/unendorse', { method: 'POST', body: { id: 'abcdefabcdef' }, cookie }), env, null, BASE, { now })).status, 200);

  // An email sign-in from the same IP, with index.js's login-only visitor hash.
  const loginVisitor = await hmacHex(env.IP_SALT, `login:${visitorId(IP)}`, 32);
  await startLogin({ body: { email: 'neighbor@example.org' }, env, kv, visitor: loginVisitor, link: `${ORIGIN}${BASE}/login`, send: async () => {}, now });
  const uid = await userId(SECRET, 'neighbor@example.org');

  const dump = [...kv.store.entries()].map(([k, e]) => ({ k, text: `${k}\n${e.value}\n${JSON.stringify(e.metadata ?? null)}`, e }));
  const forbidden = ['did:', W.HANDLE, 'fixture.dev', W.ACCESS, W.REFRESH, W.CODE, state];
  for (const { k, text } of dump) for (const f of forbidden) assert.ok(!text.includes(f), `${k} holds ${f}`);

  const rateKeys = dump.filter(({ k }) => /^(endorse-ev|bsky-ev|login-rate):/.test(k)).map(({ k }) => k);
  assert.ok(rateKeys.some((k) => k.startsWith('endorse-ev:')) && rateKeys.some((k) => k.startsWith('bsky-ev:')) && rateKeys.some((k) => k.startsWith('login-rate:')));
  for (const secretish of [eid, uid]) {
    for (const run of hexRuns(secretish, 16)) for (const k of rateKeys) assert.ok(!k.includes(run), `${k} carries part of an id`);
  }
  const otherVisitors = [loginVisitor, visitorHash];
  for (const k of rateKeys.filter((x) => /^(endorse-ev|bsky-ev):/.test(x))) for (const v of otherVisitors) assert.ok(!k.includes(v), `${k} reuses another counter's visitor`);
  assert.notEqual(await bskyVisitor(req('/'), env, 'bsky-login'), await bskyVisitor(req('/'), env, 'bsky-endorse'));

  const endorsementIds = dump.filter(({ k }) => k.startsWith('endorsement:')).map(({ k }) => k.split(':')[2]);
  assert.equal(endorsementIds.length, 2);
  const runs = hexRuns(endorsementIds[0], 8);
  for (const r of hexRuns(endorsementIds[1], 8)) assert.ok(!runs.has(r), 'two endorsements share no 8-hex run');

  // Bucketed expirations: every key of one kind in one bucket expires together.
  const kindOf = (k) => k.split(':').slice(0, 2).join(':') + (k.startsWith('endorse-ev:') || k.startsWith('bsky-ev:') || k.startsWith('login-rate:') ? `:${k.split(':')[2]}` : '');
  const groups = new Map();
  for (const { k, e } of dump) {
    if (!/^(endorsement|endorse-ev|bsky-ev|login-rate|bsky-flow-used):/.test(k)) continue;
    assert.equal(e.expirationTtl, undefined, `${k} uses an absolute expiration`);
    assert.ok(e.expiration, `${k} has an expiration`);
    const g = k.startsWith('endorsement:') ? 'endorsement' : kindOf(k);
    groups.set(g, [...(groups.get(g) || []), e.expiration]);
  }
  for (const [g, exps] of groups) assert.equal(new Set(exps).size, 1, `${g} shares one expiration`);
  const exp = groups.get('endorsement')[0];
  assert.ok([boundary(now, 'month', 12), boundary(now, 'month', 13)].includes(exp), 'a month boundary 12 to 13 months out');
  assert.equal(new Date(exp * 1000).getUTCDate(), 1);
});
