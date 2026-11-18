// One email when a requested source is added (worker/request-notify.js; Jason,
// 2026-11-18: "When a source request is fulfilled, does siren notify those
// who had requested that source by email? We should."). Opt-in, the address
// sealed apart from the request, one email when the steward marks it
// fulfilled, then gone. Behind REQUEST_NOTIFY: with it off nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import { addRequest, decide, currentId, publicRequests, allRequests } from '../worker/requests.js';
import { notifyKey, optIn, openFor, sendDecided, notifyMail, notifyReady } from '../worker/request-notify.js';

const SECRET = 'test-secret-that-is-long-enough';
const ORIGIN = 'https://ask-siren.jason-edelman.org';
const EMAIL = 'member@example.org';

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(k, type) {
      if (!store.has(k)) return null;
      return type === 'json' ? JSON.parse(store.get(k)) : store.get(k);
    },
    async put(k, v) {
      store.set(k, String(v));
    },
    async delete(k) {
      store.delete(k);
    },
    async list({ prefix, cursor } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix || '')).map((name) => ({ name })), list_complete: true, cursor };
    },
  };
}
const onEnv = (over = {}) => ({ LIMITS: fakeKV(), INVITE_SECRET: SECRET, IP_SALT: 'salt', RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>', PUBLIC_ORIGIN: ORIGIN, REQUEST_NOTIFY: 'true', ...over });
const notifyKeys = (kv) => [...kv.store.keys()].filter((k) => k.startsWith('request-notify:'));

async function raised(kv, source = 'Tree inventory') {
  const out = await addRequest({ body: { source, need: 'which trees are scheduled', public: true }, kv, visitor: 'v1' });
  assert.equal(out.ok, true);
  return (await currentId(kv, source));
}

test('flag and setup: on only with REQUEST_NOTIFY, email sign-in, a public origin and KV', () => {
  assert.equal(notifyReady(onEnv()), true);
  assert.equal(notifyReady(onEnv({ REQUEST_NOTIFY: undefined })), false);
  assert.equal(notifyReady(onEnv({ REQUEST_NOTIFY: 'yes' })), false);
  assert.equal(notifyReady(onEnv({ RESEND_API_KEY: undefined })), false);
  assert.equal(notifyReady(onEnv({ PUBLIC_ORIGIN: undefined })), false);
});

test('kept apart and sealed: one key per account per request, the address unreadable without the secret, nothing in the request', async () => {
  const env = onEnv();
  const kv = env.LIMITS;
  const id = await raised(kv);
  const uid = await userId(SECRET, EMAIL);
  const name = await optIn(kv, env, { uid, source: 'Tree inventory', email: EMAIL });
  await optIn(kv, env, { uid, source: '  tree   INVENTORY ', email: EMAIL });
  assert.deepEqual(notifyKeys(kv), [name], 'a second ask, however spelled, replaces the first');
  assert.equal(name, await notifyKey(SECRET, 'Tree inventory', uid));
  assert.doesNotMatch(name, new RegExp(uid), 'the key never names the account');
  const raw = kv.store.get(name);
  assert.doesNotMatch(raw, /member|example\.org/, 'the address is sealed');
  assert.equal(await openFor(SECRET, name, JSON.parse(raw).sealed), EMAIL);
  await assert.rejects(openFor('another-secret-entirely-long', name, JSON.parse(raw).sealed));
  await assert.rejects(openFor(SECRET, `${name}x`, JSON.parse(raw).sealed), 'bound to its key');
  // The request, its steward views and the public list carry nothing of it.
  const stewardSide = JSON.stringify(await allRequests(kv));
  const publicSide = JSON.stringify(await publicRequests(kv));
  for (const s of [stewardSide, publicSide, kv.store.get(`request:${name.split(':')[1]}`)]) assert.doesNotMatch(s, /notify|member@|sealed/);
  assert.ok(id);
});

test('the cron: one email when the request is fulfilled, then the address is deleted; nothing before, nothing twice', async () => {
  const env = onEnv();
  const kv = env.LIMITS;
  const id = await raised(kv);
  const uid = await userId(SECRET, EMAIL);
  const other = await userId(SECRET, 'neighbor@example.org');
  await optIn(kv, env, { uid, source: 'Tree inventory', email: EMAIL });
  await optIn(kv, env, { uid: other, source: 'Tree inventory', email: 'neighbor@example.org' });
  const sent = [];
  const send = async (_env, mail) => {
    sent.push(mail);
    return { id: 'x' };
  };
  // Accepted, not fulfilled: nothing goes.
  assert.equal((await decide(kv, { id, status: 'accepted' })).ok, true);
  assert.equal((await sendDecided(env, { send })).sent, 0);
  assert.equal(notifyKeys(kv).length, 2);
  assert.equal((await decide(kv, { id, status: 'fulfilled', fulfilled_by: 'https://github.com/jedelman/socrata-agent/pull/99', note: 'Read from the City\'s tree inventory dataset.' })).ok, true);
  const out = await sendDecided(env, { send, appName: 'Siren' });
  assert.equal(out.sent, 2);
  assert.deepEqual(sent.map((m) => m.to).sort(), [EMAIL, 'neighbor@example.org']);
  assert.equal(sent[0].subject, 'Added to Siren: Tree inventory');
  assert.match(sent[0].text, /https:\/\/github\.com\/jedelman\/socrata-agent\/pull\/99/);
  assert.match(sent[0].text, /From the steward: Read from the City's tree inventory dataset\./);
  assert.match(sent[0].text, /one email when this request was decided\. This is it, and Siren has now deleted your address/);
  assert.notEqual(sent[0].idempotencyKey, sent[1].idempotencyKey);
  assert.equal(notifyKeys(kv).length, 0, 'deleted once sent');
  assert.equal((await sendDecided(env, { send })).sent, 0, 'never twice');
  assert.equal(kv.store.get(`request-notify-count:${new Date().toISOString().slice(0, 10)}`), '2');
});

test('the cap, a pause, Resend refusing, and a request set back before the cron', async () => {
  const env = onEnv({ REQUEST_NOTIFY_DAILY: '1' });
  const kv = env.LIMITS;
  const id = await raised(kv);
  for (const e of ['a@example.org', 'b@example.org', 'c@example.org']) await optIn(kv, env, { uid: await userId(SECRET, e), source: 'Tree inventory', email: e });
  await decide(kv, { id, status: 'fulfilled', fulfilled_by: 'https://github.com/jedelman/socrata-agent/pull/99' });
  const ok = async () => ({ id: 'x' });
  let out = await sendDecided(env, { send: ok });
  assert.deepEqual([out.sent, out.capped], [1, 2]);
  assert.equal(notifyKeys(kv).length, 2, 'the rest wait for tomorrow');
  // "0" pauses.
  out = await sendDecided({ ...env, REQUEST_NOTIFY_DAILY: '0' }, { send: ok });
  assert.deepEqual([out.sent, out.capped], [0, 2]);
  // Resend busy: stop, keep the keys.
  out = await sendDecided({ ...env, REQUEST_NOTIFY_DAILY: '100' }, { send: async () => { throw new Error('Resend 503'); } });
  assert.equal(out.stopped, true);
  assert.equal(notifyKeys(kv).length, 2);
  // 409: Resend already took this key, so it went.
  out = await sendDecided({ ...env, REQUEST_NOTIFY_DAILY: '100' }, { send: async () => { throw new Error('Resend 409'); } });
  assert.equal(out.sent, 2);
  assert.equal(notifyKeys(kv).length, 0);
  // Set back to open before the cron: nothing goes.
  const id2 = await raised(kv, 'Sidewalk repair list');
  await optIn(kv, env, { uid: await userId(SECRET, 'd@example.org'), source: 'Sidewalk repair list', email: 'd@example.org' });
  await decide(kv, { id: id2, status: 'fulfilled', fulfilled_by: 'https://github.com/jedelman/socrata-agent/pull/100' });
  await decide(kv, { id: id2, status: 'accepted' });
  assert.equal((await sendDecided({ ...env, REQUEST_NOTIFY_DAILY: '100' }, { send: ok })).sent, 0);
  assert.equal(notifyKeys(kv).length, 1);
  // With the flag off, the cron does nothing at all.
  assert.deepEqual(await sendDecided({ ...env, REQUEST_NOTIFY: undefined }, { send: ok }), { kept: 0, due: 0, sent: 0, failed: 0, capped: 0, stopped: false });
});

test('declined: one email with the steward\'s note, but only once the day of the decision has passed', async () => {
  const env = onEnv();
  const kv = env.LIMITS;
  const id = await raised(kv);
  await optIn(kv, env, { uid: await userId(SECRET, EMAIL), source: 'Tree inventory', email: EMAIL });
  const sent = [];
  const send = async (_env, mail) => { sent.push(mail); return { id: 'x' }; };
  const decidedAt = Date.parse('2026-11-18T15:00:00Z');
  await decide(kv, { id, status: 'declined', note: 'The City publishes no tree inventory yet.' }, decidedAt);
  // The same day: nothing yet (a decline made by mistake can still be undone).
  assert.equal((await sendDecided(env, { send, now: Date.parse('2026-11-18T23:50:00Z') })).sent, 0);
  assert.equal(notifyKeys(kv).length, 1);
  const out = await sendDecided(env, { send, now: Date.parse('2026-11-19T00:10:00Z'), appName: 'Siren' });
  assert.equal(out.sent, 1);
  assert.equal(sent[0].subject, 'Not added to Siren: Tree inventory');
  assert.match(sent[0].text, /The steward decided not to add it for now\./);
  assert.match(sent[0].text, /Why: The City publishes no tree inventory yet\./);
  assert.doesNotMatch(sent[0].text, /What added it/);
  assert.equal(notifyKeys(kv).length, 0);
  // A decline undone the same day sends nothing.
  const id2 = await raised(kv, 'Sidewalk repair list');
  await optIn(kv, env, { uid: await userId(SECRET, EMAIL), source: 'Sidewalk repair list', email: EMAIL });
  await decide(kv, { id: id2, status: 'declined' }, decidedAt);
  await decide(kv, { id: id2, status: 'accepted' }, decidedAt + 60_000);
  assert.equal((await sendDecided(env, { send, now: Date.parse('2026-11-19T00:10:00Z') })).sent, 0);
  assert.equal(notifyKeys(kv).length, 1);
});

test('the email: only an https link, and every string escaped in the HTML', () => {
  const m = notifyMail({ appName: 'Siren', origin: ORIGIN, request: { status: 'fulfilled', source: '<b>Trees</b>', fulfilled_by: 'javascript:alert(1)', steward_note: 'a < b & "c"' } });
  const d = notifyMail({ appName: 'Siren', origin: ORIGIN, request: { status: 'declined', source: '<b>Trees</b>', steward_note: 'a < b' } });
  assert.match(d.html, /&lt;b&gt;Trees&lt;\/b&gt;[\s\S]*Why: a &lt; b/);
  assert.doesNotMatch(m.text, /javascript:/);
  assert.doesNotMatch(m.html, /javascript:|<b>Trees/);
  assert.match(m.html, /&lt;b&gt;Trees&lt;\/b&gt;/);
  assert.match(m.html, /a &lt; b &amp; &quot;c&quot;/);
});

// ---- through the Worker ----

const canHook = typeof nodeModule.registerHooks === 'function';
let worker;
async function loadWorker() {
  if (worker) return worker;
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && (context.importAttributes?.type === 'text' || url.endsWith('.html'))) {
        return { format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true };
      }
      if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  worker = (await import('../worker/index.js')).default;
  return worker;
}
const memberEnv = async (over = {}) => {
  const env = onEnv({ INVITE_REQUIRED: 'true', ...over });
  const uid = await userId(SECRET, EMAIL);
  await env.LIMITS.put('invite:inv1', JSON.stringify({ label: 'test' }));
  await env.LIMITS.put(`member:${uid}`, JSON.stringify({ invite: 'inv1' }));
  return { env, uid, cookie: `${userCookieName('')}=${await signUser(SECRET, uid)}` };
};
const post = (path, body, cookie) => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const get = (path, cookie) => new Request(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
const skip = !canHook && 'node:module has no registerHooks';

test('flag off: the session, a raise with notify, and the undo path answer as before', { skip }, async () => {
  const w = await loadWorker();
  const { env, cookie } = await memberEnv({ REQUEST_NOTIFY: undefined });
  const session = await (await w.fetch(get('/api/session', cookie), env, {})).json();
  assert.equal('request_notify' in session, false);
  const res = await w.fetch(post('/api/requests', { source: 'Tree inventory', need: 'q', public: true, notify: true, email: EMAIL }, cookie), env, {});
  assert.deepEqual(await res.json(), { ok: true }, 'notify is ignored');
  assert.equal(notifyKeys(env.LIMITS).length, 0);
  const stop = await w.fetch(post('/api/requests/notify/stop', { source: 'Tree inventory' }, cookie), env, {});
  const unknown = await w.fetch(post('/api/requests/nothing-here', { source: 'Tree inventory' }, cookie), env, {});
  assert.equal(stop.status, unknown.status);
  assert.equal(await stop.text(), await unknown.text());
});

test('flag on: offered when signed in; the signed-in address only; undo deletes it', { skip }, async () => {
  const w = await loadWorker();
  const { env, cookie } = await memberEnv();
  assert.equal((await (await w.fetch(get('/api/session', cookie), env, {})).json()).request_notify, true);
  assert.equal('request_notify' in (await (await w.fetch(get('/api/session'), env, {})).json()), false, 'not offered signed out');
  // Another address: refused, and nothing is raised.
  const wrong = await w.fetch(post('/api/requests', { source: 'Tree inventory', need: 'q', public: true, notify: true, email: 'someone.else@example.org' }, cookie), env, {});
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, 'email');
  assert.equal([...env.LIMITS.store.keys()].some((k) => k.startsWith('request:')), false, 'not raised');
  // The signed-in address (any case).
  const ok = await w.fetch(post('/api/requests', { source: 'Tree inventory', need: 'q', public: true, notify: true, email: 'Member@Example.org' }, cookie), env, {});
  assert.deepEqual(await ok.json(), { ok: true, notify: true });
  assert.equal(notifyKeys(env.LIMITS).length, 1);
  // Without notify, a raise is as before.
  assert.deepEqual(await (await w.fetch(post('/api/requests', { source: 'Sidewalk list', need: 'q', public: true }, cookie), env, {})).json(), { ok: true });
  // Undo.
  const stop = await w.fetch(post('/api/requests/notify/stop', { source: 'tree inventory' }, cookie), env, {});
  assert.deepEqual(await stop.json(), { ok: true, notify: false });
  assert.equal(notifyKeys(env.LIMITS).length, 0);
  assert.equal((await w.fetch(post('/api/requests/notify/stop', { source: 'tree inventory' }), env, {})).status, 401, 'undo needs the account');
});

test('from the public list: an open request by id, the signed-in address only; undo by id; flag off, the path is unknown', { skip }, async () => {
  const w = await loadWorker();
  const { env, cookie } = await memberEnv();
  const kv = env.LIMITS;
  const id = await raised(kv);
  // Not open yet (awaiting review): refused.
  assert.equal((await w.fetch(post('/api/requests/notify', { id, email: EMAIL }, cookie), env, {})).status, 404);
  await decide(kv, { id, status: 'accepted' });
  assert.equal((await w.fetch(post('/api/requests/notify', { id, email: EMAIL }), env, {})).status, 401, 'signed in only');
  assert.equal((await (await w.fetch(post('/api/requests/notify', { id, email: 'other@example.org' }, cookie), env, {})).json()).code, 'email');
  assert.deepEqual(await (await w.fetch(post('/api/requests/notify', { id, email: EMAIL }, cookie), env, {})).json(), { ok: true, notify: true });
  assert.equal(notifyKeys(kv).length, 1);
  assert.equal(notifyKeys(kv)[0], await notifyKey(SECRET, 'Tree inventory', await userId(SECRET, EMAIL)), 'the same key the card would make');
  assert.deepEqual(await (await w.fetch(post('/api/requests/notify/stop', { id }, cookie), env, {})).json(), { ok: true, notify: false });
  assert.equal(notifyKeys(kv).length, 0);
  const off = await memberEnv({ REQUEST_NOTIFY: undefined });
  const res = await w.fetch(post('/api/requests/notify', { id, email: EMAIL }, off.cookie), off.env, {});
  const unknown = await w.fetch(post('/api/requests/nothing-here', { id }, off.cookie), off.env, {});
  assert.equal(res.status, unknown.status);
});
