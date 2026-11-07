// What a KV and D1 dump would show after Bluesky sign-in and endorsing: no
// DID, handle, issuer or token; nothing that joins one account's
// endorsements, or an endorsement to a counter, a visitor or an email
// account; and no Bluesky key in KV at all. Skips without node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLogin, handleCallback, handleEndorse, handleUnendorse, bskyVisitor, FLOW_COOKIE, BSKY_COOKIE, openSession } from '../worker/bluesky.js';
import { addRequest, decide, requestKey, publicId } from '../worker/requests.js';
import { startLogin, userId } from '../worker/accounts.js';
import { hmacHex, sha256, hex, boundary } from '../worker/crypto.js';
import { visitorId } from '../worker/limits.js';
import { W, fakeNetwork, readyEnv, SECRET } from './fake-atproto.js';
import { D1_SKIP } from './fake-d1.js';

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

test('a KV and D1 dump after sign-in, endorsing and an email sign-in holds no identity and no joins', { skip: D1_SKIP }, async () => {
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

  // KV: the Bluesky side wrote nothing there. Only what requests, invites
  // and email sign-in already keep.
  const kvKeys = [...kv.store.keys()];
  for (const k of kvKeys) assert.match(k, /^(request|request-rate|redeem-failures|login-rate|login):/, `${k} is not a Bluesky key`);
  assert.ok(kvKeys.some((k) => k.startsWith('login-rate:')));

  // D1: every row of every table.
  const db = env.SIREN_DB;
  const tables = Object.fromEntries(['endorsements', 'endorsement_counts', 'bsky_rate_counts', 'siren_d1_budget'].map((t) => [t, db.rows(t)]));
  const kvText = [...kv.store.entries()].map(([k, e]) => `${k}\n${e.value}\n${JSON.stringify(e.metadata ?? null)}`);
  const dbText = Object.entries(tables).flatMap(([t, rows]) => rows.map((r) => `${t} ${JSON.stringify(r)}`));
  const forbidden = ['did:', W.HANDLE, 'fixture.dev', W.ACCESS, W.REFRESH, W.CODE, state, eid];
  for (const text of [...kvText, ...dbText]) for (const f of forbidden) assert.ok(!text.includes(f), `${text.slice(0, 60)} holds ${f}`);

  // Rate counters: no part of the eid or the email uid, no other counter's
  // visitor hash, and no request id; so they can't be joined to endorsements.
  const rates = tables.bsky_rate_counts.map((r) => r.k);
  assert.ok(rates.some((k) => k.startsWith('ed:')) && rates.some((k) => k.startsWith('ev:')));
  assert.ok(!rates.some((k) => k.startsWith('bl:')), 'a login start writes no counter');
  const endorsementIds = tables.endorsements.map((r) => r.eh);
  for (const k of [...rates, ...kvKeys.filter((x) => x.startsWith('login-rate:'))]) {
    for (const secretish of [eid, uid, ...endorsementIds]) for (const run of hexRuns(secretish, 16)) assert.ok(!k.includes(run), `${k} carries part of an id`);
    for (const id of [id1, id2]) assert.ok(!k.includes(id), `${k} names a request`);
  }
  for (const k of rates) for (const v of [loginVisitor, visitorHash]) assert.ok(!k.includes(v), `${k} reuses another counter's visitor`);
  assert.notEqual(await bskyVisitor(req('/'), env, 'bsky-login'), await bskyVisitor(req('/'), env, 'bsky-endorse'));

  // Two endorsements on two requests share no 8-hex run.
  assert.equal(endorsementIds.length, 2);
  const runs = hexRuns(endorsementIds[0], 8);
  for (const r of hexRuns(endorsementIds[1], 8)) assert.ok(!runs.has(r), 'two endorsements share no 8-hex run');
  assert.deepEqual(tables.endorsement_counts.map((r) => r.n), [1, 1], 'tallies are per request only');

  // Bucketed expiries: every row of one kind and period shares one exp.
  const groups = new Map();
  for (const r of tables.bsky_rate_counts) {
    const g = r.k.split(':').slice(0, 2).join(':');
    groups.set(g, [...(groups.get(g) || []), r.exp]);
  }
  groups.set('endorsements', tables.endorsements.map((r) => r.exp));
  groups.set('budget', tables.siren_d1_budget.map((r) => r.exp));
  // The budget: a date, a pot and two numbers; nothing per person.
  assert.ok(tables.siren_d1_budget.length > 0);
  assert.ok(tables.siren_d1_budget.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['calls', 'day', 'exp', 'pot', 'writes'])));
  assert.ok(tables.siren_d1_budget.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day) && ['visitor', 'list'].includes(r.pot)));
  for (const [g, exps] of groups) assert.equal(new Set(exps).size, 1, `${g} shares one expiry`);
  const exp = groups.get('endorsements')[0];
  assert.ok([boundary(now, 'month', 12), boundary(now, 'month', 13)].includes(exp), 'a month boundary 12 to 13 months out');
  assert.equal(new Date(exp * 1000).getUTCDate(), 1);
});

test('the "What Siren keeps" panel matches the retention the code and the rollout give', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const html = read('worker/requests.html');
  const panel = html.slice(html.indexOf('<summary>What {{APP_NAME}} keeps</summary>'), html.indexOf('</details>', html.indexOf('What {{APP_NAME}} keeps')));
  const doc = read('docs/bluesky-endorsements.md');
  const toml = read('wrangler.toml');
  const index = read('worker/index.js');
  // Deletion doesn't wait for visitors: the daily cron, turned on with the flag.
  const cron = toml.match(/^# crons = \["(\d+) (\d+) \* \* \*"\]$/m);
  assert.ok(cron, 'wrangler.toml carries the daily cron, for the flag-flip PR to uncomment');
  assert.match(index, /async scheduled\([^)]*\) \{\s*scheduledPurge\(env, ctx\);/);
  assert.match(read('worker/admin.js'), /export function scheduledPurge\(env, ctx\) \{\s*const db = endorseDb\(env\);[\s\S]{0,120}purgeAll\(db, env\)/);
  assert.match(doc, /Flip the flag and turn on the cleanup[\s\S]{0,300}crons = \["17 7 \* \* \*"\]/);
  assert.equal(`${cron[1]} ${cron[2]}`, '17 7');
  // Counters expire an hour after the UTC day ends (endorsements.js eventExpiry);
  // the worst case to the next cron run is what "about a day and a half" must cover.
  let worst = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const made = Date.UTC(2026, 10, 6, 0, m);
    const exp = boundary(made, 'day', 1) * 1000 + 3600e3;
    let run = Date.UTC(2026, 10, 6, Number(cron[2]), Number(cron[1]));
    while (run < exp) run += 86400e3;
    worst = Math.max(worst, run - made);
  }
  assert.ok(worst <= 36 * 3600e3, `counters deleted within ${worst / 3600e3} h`);
  assert.match(panel, /counters of recent endorsing, deleted within about a day and a half/);
  assert.match(doc, /within about a day and a half/);
  assert.ok(!/for about a day/.test(panel), 'no "kept for about a day" promise that only expiry, not deletion, keeps');
  assert.match(panel, /deleted when the request is decided, and in any case within about <span class="retention">13<\/span> months/);
  // D1 Time Travel: deleted rows stay restorable for 7 days on Free.
  assert.match(panel, /restorable history of it for 7 days[^.]*recover a deleted entry for up to 7 days/);
  assert.match(doc, /Time Travel\): 7 days on the\s+Workers Free plan/);
  // That history pairs an endorsement with its counters: the page says what that shows.
  assert.match(panel, /match an endorsement with the counters written alongside it, which can show which network and which Bluesky server/);
  assert.match(panel, /daily codes for your Bluesky server and its domain/);
  // A login start keeps nothing, so the panel promises nothing about one.
  assert.ok(!/start a sign-in/i.test(panel));
  // The D1 limits are the account's, and Jason decides before the flag flips.
  assert.match(doc, /D1 daily limits are per account, not per database/);
  assert.match(doc, /Before rollout step 5, Jason decides/);
});
