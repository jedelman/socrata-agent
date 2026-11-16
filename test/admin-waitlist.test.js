// The steward's waitlist (worker/waitlist-admin.js, the /api/admin/waitlist
// routes in worker/admin.js and the page's script): Jason, 2026-11-16, "send
// waitlisted users a code, thereby taking them off the waitlist and granting
// them access". Sending mints an invite, emails the code from PUBLIC_ORIGIN's
// link, and only then removes the entry; a failed email changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin } from '../worker/admin.js';
import { joinWaitlist, sha256hex, inviteKey, redeem } from '../worker/invites.js';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import { listWaitlist, sendWaitlistInvite, removeFromWaitlist, inviteEmail, SEND_USES } from '../worker/waitlist-admin.js';
import { entryHtml } from '../worker/admin-waitlist.js';
import { readyEnv, SECRET } from './fake-atproto.js';

const ORIGIN = 'https://ask-siren.jason-edelman.org';
const STEWARD = 'steward@example.org';
const USER_COOKIE = userCookieName('');
const CODE_RE = /SIREN-[A-Z0-9]{5}-[A-Z0-9]{5}/;

async function world(over = {}) {
  const env = readyEnv({ ADMIN_EMAILS: STEWARD, RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>', INVITE_REQUIRED: 'true', ...over });
  const at = Date.parse('2026-11-10T12:00:00Z');
  await joinWaitlist({ body: { email: 'Second@Example.org', name: 'Sam', org: 'Civic League', note: 'Trees on my street' }, kv: env.LIMITS, visitor: 'v1', source: 'chat', now: at + 3600e3 });
  await joinWaitlist({ body: { email: 'first@example.org', name: '<b>Ada</b>' }, kv: env.LIMITS, visitor: 'v2', source: 'chat', now: at });
  const cookie = `${USER_COOKIE}=${await signUser(SECRET, await userId(SECRET, STEWARD))}`;
  const sent = [];
  const send = async (_env, msg) => {
    sent.push(msg);
    return { id: 'email_1' };
  };
  return { env, kv: env.LIMITS, cookie, sent, send, id: (email) => sha256hex(email) };
}

async function call(w, path, body, deps = {}, headers = {}) {
  const req = new Request(`${ORIGIN}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: w.cookie, ...(body ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const res = await handleAdmin(req, w.env, path, {}, { appName: 'Siren', send: w.send, ...deps });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('the list: every entry, oldest first, and whether codes can be sent here', async () => {
  const w = await world();
  const out = await listWaitlist(w.kv, w.env);
  assert.deepEqual(out.entries.map((e) => e.email), ['first@example.org', 'second@example.org']);
  assert.equal(out.entries[1].org, 'Civic League');
  assert.equal(out.entries[1].id, await w.id('second@example.org'));
  assert.equal(out.can_send, true);
  assert.equal(out.send_blocked, null);
  assert.equal(out.invite_only, true);
  assert.equal(out.uses, SEND_USES);
  // Without the mail settings, or without PUBLIC_ORIGIN for the link, it says why.
  assert.match((await listWaitlist(w.kv, { ...w.env, RESEND_API_KEY: undefined })).send_blocked, /RESEND_API_KEY/);
  assert.match((await listWaitlist(w.kv, { ...w.env, PUBLIC_ORIGIN: undefined })).send_blocked, /PUBLIC_ORIGIN/);
});

test('the list reads entries 100 at a time, inside a Worker\'s 1,000 KV operations however long it gets', async () => {
  const w = await world();
  for (let i = 0; i < 250; i++) await w.kv.put(`waitlist:${(await sha256hex(`p${i}@example.org`))}`, JSON.stringify({ email: `p${i}@example.org`, at: '2026-11-12T00:00:00.000Z' }));
  const opsBefore = w.kv.ops.length;
  const out = await listWaitlist(w.kv, w.env);
  assert.equal(out.entries.length, 252);
  const ops = w.kv.ops.slice(opsBefore);
  assert.equal(ops.filter((o) => o.op === 'get').length, 3, 'three bulk gets');
  assert.ok(ops.length <= 5);
});

test('sending: a new invite, the code emailed with the site\'s own link, the entry gone; the code redeems', async () => {
  const w = await world();
  const id = await w.id('second@example.org');
  const out = await sendWaitlistInvite({ kv: w.kv, env: w.env, id, appName: 'Siren', send: w.send, now: Date.parse('2026-11-16T15:00:00Z') });
  assert.deepEqual(out, { ok: true, email: 'second@example.org' }, 'no code in the reply');
  assert.equal(w.sent.length, 1);
  const msg = w.sent[0];
  assert.equal(msg.to, 'second@example.org');
  assert.equal(msg.subject, 'Your invite to Siren');
  const code = CODE_RE.exec(msg.text)[0];
  assert.ok(msg.html.includes(code));
  assert.ok(msg.text.includes(`${ORIGIN}/`), 'the link is PUBLIC_ORIGIN');
  assert.match(msg.text, /sign in with this email address, then enter the code/);
  // The invite is stored by the code's hash, labeled with a masked address only.
  const key = await inviteKey(code);
  const record = JSON.parse(w.kv.store.get(key).value);
  assert.deepEqual(record, { label: 'Waitlist: s•••@example.org', max_uses: SEND_USES, created: '2026-11-16T15:00:00.000Z', via: 'waitlist' });
  assert.equal(msg.idempotencyKey, `waitlist-${key.slice('invite:'.length)}`);
  // Off the waitlist, no lock left, and the other entry untouched.
  assert.equal(w.kv.store.has(`waitlist:${id}`), false);
  assert.equal(w.kv.store.has(`waitlist-sending:${id}`), false);
  assert.equal(w.kv.store.has(`waitlist:${await w.id('first@example.org')}`), true);
  // Nothing in KV holds the full address or the code any more.
  for (const [k, v] of w.kv.store) {
    if (k.startsWith('waitlist:')) continue;
    assert.ok(!`${k} ${v.value}`.includes('second@example.org') && !`${k} ${v.value}`.includes(code), k);
  }
  // The emailed code grants access.
  const r = await redeem({ code, env: w.env, kv: w.kv, visitor: 'someone' });
  assert.equal(r.ok, true);
});

test('sending: a refusal from the email provider changes nothing: the invite is taken back and the entry stays', async () => {
  const w = await world();
  const id = await w.id('first@example.org');
  const before = new Map([...w.kv.store].map(([k, v]) => [k, v.value]));
  const out = await sendWaitlistInvite({ kv: w.kv, env: w.env, id, send: async () => { throw new Error('Resend 422'); } });
  assert.equal(out.ok, false);
  assert.equal(out.status, 502);
  assert.match(out.error, /refused the email, so nothing changed/);
  assert.deepEqual(new Map([...w.kv.store].map(([k, v]) => [k, v.value])), before, 'no invite, the entry as it was, no marker');
});

test('sending: an unclear failure keeps the code (it may have arrived) and marks the entry', async () => {
  for (const fail of [() => { throw new Error('Resend 500'); }, () => { throw new TypeError('network connection lost'); }]) {
    const w = await world();
    const id = await w.id('first@example.org');
    let code;
    const out = await sendWaitlistInvite({ kv: w.kv, env: w.env, id, now: Date.parse('2026-11-16T15:00:00Z'), send: async (_e, msg) => { code = CODE_RE.exec(msg.text)[0]; fail(); } });
    assert.equal(out.ok, false);
    assert.equal(out.maybe_sent, true);
    assert.match(out.error, /may or may not have gone out/);
    assert.ok(w.kv.store.has(await inviteKey(code)), 'the code still works if it arrived');
    assert.equal(JSON.parse(w.kv.store.get(`waitlist:${id}`).value).sent_maybe, '2026-11-16T15:00:00.000Z');
    assert.equal(w.kv.store.has(`waitlist-sending:${id}`), false);
    const listed = (await listWaitlist(w.kv, w.env)).entries.find((e) => e.id === id);
    assert.equal(listed.sent_maybe, '2026-11-16T15:00:00.000Z');
    assert.match(entryHtml(listed), /may have gone out to them on 2026-11-16 15:00 UTC/);
    assert.equal((await redeem({ code, env: w.env, kv: w.kv, visitor: 'x' })).ok, true);
  }
});

test('sending: sent, but the entry couldn\'t be removed: still a success, with a warning', async () => {
  const w = await world();
  const id = await w.id('first@example.org');
  const del = w.kv.delete;
  w.kv.delete = async (k) => { if (k === `waitlist:${id}`) throw new Error('KV delete failed'); return del(k); };
  const out = await sendWaitlistInvite({ kv: w.kv, env: w.env, id, send: w.send });
  assert.equal(out.ok, true);
  assert.match(out.warning, /couldn’t be taken off the list just now/);
  assert.equal(w.sent.length, 1);
  assert.ok(JSON.parse(w.kv.store.get(`waitlist:${id}`).value).sent_maybe, 'left marked, so nobody sends again blind');
});

test('sending: two at once send one email', async () => {
  const w = await world();
  const id = await w.id('first@example.org');
  // KV with a little latency, so both requests are in flight together.
  const slow = (f) => async (...a) => { await new Promise((r) => setTimeout(r, 5)); return f(...a); };
  const kv = { ...w.kv, get: slow(w.kv.get), put: slow(w.kv.put), delete: slow(w.kv.delete), list: w.kv.list, store: w.kv.store };
  const outs = await Promise.all([1, 2].map(() => sendWaitlistInvite({ kv, env: w.env, id, send: w.send })));
  assert.deepEqual(outs.map((o) => o.ok).sort(), [false, true]);
  assert.equal(w.sent.length, 1);
  assert.equal([...w.kv.store.keys()].filter((k) => k.startsWith('invite:')).length, 1);
});

test('sending: refused when Siren isn\'t invite-only, where the email\'s forms don\'t exist', async () => {
  const w = await world({ INVITE_REQUIRED: undefined });
  const id = await w.id('first@example.org');
  const out = await sendWaitlistInvite({ kv: w.kv, env: w.env, id, send: w.send });
  assert.equal(out.status, 409);
  assert.match(out.error, /isn’t invite-only/);
  assert.equal(w.sent.length, 0);
  const list = await listWaitlist(w.kv, w.env);
  assert.equal(list.can_send, false);
  assert.match(list.send_blocked, /isn’t invite-only/);
});

test('sending: refusals before anything is made', async () => {
  const w = await world();
  const id = await w.id('first@example.org');
  const none = { kv: w.kv, send: w.send };
  assert.equal((await sendWaitlistInvite({ ...none, env: w.env, id: 'nope' })).status, 400);
  assert.equal((await sendWaitlistInvite({ ...none, env: w.env, id: 'f'.repeat(64) })).status, 404);
  assert.equal((await sendWaitlistInvite({ ...none, env: { ...w.env, LOGIN_FROM: undefined }, id })).status, 503);
  assert.equal((await sendWaitlistInvite({ ...none, env: { ...w.env, PUBLIC_ORIGIN: 'http://evil.example' }, id })).status, 503, 'never a link from anything but PUBLIC_ORIGIN');
  // A second click while one is sending.
  await w.kv.put(`waitlist-sending:${id}`, '1');
  assert.equal((await sendWaitlistInvite({ ...none, env: w.env, id })).status, 409);
  assert.equal(w.sent.length, 0);
  assert.ok(![...w.kv.store.keys()].some((k) => k.startsWith('invite:')), 'no invite made');
});

test('removing: off the waitlist without an email', async () => {
  const w = await world();
  const id = await w.id('first@example.org');
  assert.deepEqual(await removeFromWaitlist({ kv: w.kv, id }), { ok: true });
  assert.equal(w.kv.store.has(`waitlist:${id}`), false);
  assert.equal((await removeFromWaitlist({ kv: w.kv, id })).status, 404);
  assert.equal(w.sent.length, 0);
});

test('the routes: stewards only, a POST from this site only, no caching', async () => {
  const w = await world();
  const list = await call(w, '/api/admin/waitlist');
  assert.equal(list.status, 200);
  assert.equal(list.body.entries.length, 2);
  assert.equal(list.headers.get('Cache-Control'), 'no-store');
  // Not signed in, or signed in but not a steward.
  assert.equal((await call({ ...w, cookie: '' }, '/api/admin/waitlist')).status, 401);
  const stranger = `${USER_COOKIE}=${await signUser(SECRET, await userId(SECRET, 'someone@example.org'))}`;
  assert.equal((await call({ ...w, cookie: stranger }, '/api/admin/waitlist/invite', { id: list.body.entries[0].id })).status, 403);
  assert.equal(w.sent.length, 0);
  // A POST naming another origin.
  assert.equal((await call(w, '/api/admin/waitlist/invite', { id: list.body.entries[0].id }, {}, { Origin: 'https://evil.example' })).status, 403);
  // Sending and removing through the API.
  const sent = await call(w, '/api/admin/waitlist/invite', { id: list.body.entries[0].id });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.email, 'first@example.org');
  assert.equal(w.sent.length, 1);
  const removed = await call(w, '/api/admin/waitlist/remove', { id: list.body.entries[1].id });
  assert.equal(removed.status, 200);
  assert.equal((await call(w, '/api/admin/waitlist')).body.entries.length, 0);
});

test('the email: plain words, the code and the link, escaped in HTML', () => {
  const m = inviteEmail({ appName: 'Siren <x>', link: 'https://ask-siren.jason-edelman.org/', code: 'SIREN-ABCDE-FGHJK', uses: 3 });
  assert.match(m.text, /SIREN-ABCDE-FGHJK/);
  assert.match(m.text, /up to 3 browsers/);
  assert.ok(m.html.includes('Siren &lt;x&gt;') && !m.html.includes('<x>'));
});

test('the page: every typed field shown as text, never markup', () => {
  const html = entryHtml({ id: 'a'.repeat(64), email: 'x@example.org', name: '<img src=x onerror=alert(1)>', org: '"q"', note: '<script>1</script>', source: 'chat', at: '2026-11-10T12:00:00Z' });
  assert.ok(!html.includes('<img') && !html.includes('<script>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('&quot;q&quot;'));
  assert.match(html, /data-action="invite"/);
  assert.match(entryHtml({ id: 'a'.repeat(64), email: 'x@example.org' }, { canSend: false }), /data-action="invite" disabled/);
  assert.ok(!entryHtml({ id: 'bad', email: 'x@example.org' }).includes('data-action'), 'no buttons without a real id');
});

test('past 1,000 entries the list shows the oldest 1,000, and says how many wait in all', async () => {
  const w = await world();
  const at = (i) => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60e3).toISOString();
  for (let i = 0; i < 1001; i++) await w.kv.put(`waitlist:${await sha256hex(`q${i}@example.org`)}`, JSON.stringify({ email: `q${i}@example.org`, at: at(i) }));
  const out = await listWaitlist(w.kv, w.env);
  assert.equal(out.total, 1003);
  assert.equal(out.entries.length, 1000);
  assert.equal(out.truncated, true);
  assert.equal(out.entries[0].email, 'q0@example.org', 'oldest first');
  assert.equal(out.entries[999].email, 'q999@example.org');
  // Exactly 1,000 is all of them.
  const w2 = await world();
  for (let i = 0; i < 998; i++) await w2.kv.put(`waitlist:${await sha256hex(`r${i}@example.org`)}`, JSON.stringify({ email: `r${i}@example.org`, at: at(i) }));
  const all = await listWaitlist(w2.kv, w2.env);
  assert.equal(all.total, 1000);
  assert.equal(all.truncated, false);
});
