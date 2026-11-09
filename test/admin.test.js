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
