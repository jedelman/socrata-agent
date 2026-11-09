// The steward's admin API (worker/admin.js) against the fake KV: the steward
// gate, decisions and note review. Endorsements are other people's records,
// so there is no clear route and no per-account tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin } from '../worker/admin.js';
import { addRequest, decide, requestKey, currentId } from '../worker/requests.js';
import { signUser, userId, USER_COOKIE } from '../worker/accounts.js';
import { readyEnv, SECRET } from './fake-atproto.js';

const ORIGIN = 'https://jason-edelman.org';
const STEWARD = 'steward@example.org';

async function world(over = {}) {
  const env = readyEnv({ ADMIN_EMAILS: STEWARD, ...over });
  await addRequest({ body: { source: 'Source A' }, kv: env.LIMITS, visitor: 'v' });
  const id = await currentId(env.LIMITS, 'Source A');
  await decide(env.LIMITS, { id, status: 'accepted' });
  const cookie = `${USER_COOKIE}=${await signUser(SECRET, await userId(SECRET, STEWARD))}`;
  return { env, id, cookie };
}

async function call(w, path, body, deps = {}) {
  const waits = [];
  const req = new Request(`${ORIGIN}/ask-siren${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: w.cookie, ...(body ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handleAdmin(req, w.env, path, { waitUntil: (p) => waits.push(p) }, deps);
  await Promise.all(waits);
  return { status: res.status, body: await res.json() };
}

const record = async (w) => JSON.parse(w.env.LIMITS.store.get(await requestKey('Source A')).value);

test('admin: the flag off means decisions work as before, with nothing frozen', async () => {
  const w = await world({ BLUESKY_LOGIN: undefined });
  assert.equal((await call(w, '/api/admin/requests')).status, 200);
  assert.equal((await call(w, '/api/admin/requests/decide', { id: w.id, status: 'declined' })).status, 200);
  assert.equal((await record(w)).endorsements_at_decision, undefined);
});

test('admin: there is no clear route; endorsements are their authors\' records', async () => {
  const w = await world();
  assert.equal((await call(w, '/api/admin/requests/endorsements/clear', { id: w.id })).status, 404);
});

import { fakeNetwork, fakeCache } from './fake-atproto.js';
import { endorseSubject } from '../worker/endorse-config.js';

const DIDS = ['did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'];

test('admin: a decision freezes the live Constellation count into the request', async () => {
  const w = await world();
  const net = fakeNetwork();
  net.state.backlinks.set(endorseSubject(ORIGIN, '/ask-siren', w.id), DIDS);
  const listed = await call(w, '/api/admin/requests', null, { fetchImpl: net.fetch, cache: fakeCache() });
  assert.equal(listed.body.requests.find((r) => r.id === w.id).endorsements, 2);
  const out = await call(w, '/api/admin/requests/decide', { id: w.id, status: 'declined' }, { fetchImpl: net.fetch, cache: null });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.endorsements_at_decision, 2);
  assert.equal((await record(w)).endorsements_at_decision, 2);
  assert.equal(out.body.warning, undefined);
});

test('admin: Constellation down, the decision still goes through, unfrozen, and says so (D10)', async () => {
  const w = await world();
  const net = fakeNetwork();
  net.state.constellationDown = true;
  const out = await call(w, '/api/admin/requests/decide', { id: w.id, status: 'fulfilled', fulfilled_by: 'https://github.com/o/r/pull/1' }, { fetchImpl: net.fetch, cache: null });
  assert.equal(out.status, 200);
  assert.equal(out.body.endorsements_frozen, false);
  assert.match(out.body.warning, /couldn't be read/);
  const rec = await record(w);
  assert.equal(rec.status, 'fulfilled');
  assert.equal(rec.endorsements_at_decision, undefined);
  // Accepting needs no count at all.
  const calls = net.calls.length;
  assert.equal((await call(w, '/api/admin/requests/decide', { id: w.id, status: 'accepted' }, { fetchImpl: net.fetch, cache: null })).status, 200);
  assert.equal(net.calls.length, calls);
});

test('admin: the flag off makes no outbound call, listing or deciding', async () => {
  const w = await world({ BLUESKY_LOGIN: undefined });
  const fetchImpl = async () => { throw new Error('no network with the flag off'); };
  const listed = await call(w, '/api/admin/requests', null, { fetchImpl });
  assert.equal('endorsements' in listed.body.requests[0], false);
  assert.equal((await call(w, '/api/admin/requests/decide', { id: w.id, status: 'declined' }, { fetchImpl })).status, 200);
});
