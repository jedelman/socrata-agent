// Invite-only pre-alpha and the waitlist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newCode, normalizeCode, inviteKey, signSession, verifySession, readCookie, sessionCookie,
  currentInvite, redeem, waitlistEntry, joinWaitlist, csvField, inviteCookieName,
} from '../worker/invites.js';

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const v = store.get(key).value;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value: String(value), metadata: opts.metadata });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}
const SECRET = 'test-secret-that-is-long-enough';
// A deployment under a path (BASE_PATH), where the cookie keeps its plain name.
const env = { INVITE_REQUIRED: 'true', INVITE_SECRET: SECRET, BASE_PATH: '/ask-siren' };
const withCookie = (value) => new Request('https://x/ask-siren/api/ask', { headers: { Cookie: `other=1; siren_invite=${value}` } });

async function addInvite(kv, record) {
  const code = newCode();
  await kv.put(await inviteKey(code), JSON.stringify(record));
  return code;
}

test('codes are readable, unambiguous, and typed loosely', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = newCode();
    assert.match(c, /^SIREN-[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 200);
  const c = newCode();
  assert.equal(normalizeCode(c.toLowerCase().replace(/-/g, ' ')), normalizeCode(c));
  assert.equal(normalizeCode(c.slice(6)), normalizeCode(c)); // without the prefix
  assert.equal(normalizeCode('SIREN-ABCDE-FGHJ1'), null); // 1 is not in the alphabet
  assert.equal(normalizeCode('short'), null);
  assert.equal(normalizeCode(undefined), null);
});

test('session cookies verify, and reject tampering, expiry and the wrong secret', async () => {
  const hash = 'a'.repeat(64);
  const now = Date.UTC(2026, 10, 2);
  const v = await signSession(SECRET, hash, now);
  assert.equal(await verifySession(SECRET, v, now), hash);
  assert.equal(await verifySession('other-secret', v, now), null);
  assert.equal(await verifySession(SECRET, v, now + 31 * 86400e3), null);
  const [payload, sig] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ k: 'b'.repeat(64), e: 9e9 })).toString('base64url');
  assert.equal(await verifySession(SECRET, `${forged}.${sig}`, now), null);
  assert.equal(await verifySession(SECRET, `${payload}.${sig.slice(0, -2)}xx`, now), null);
  assert.equal(await verifySession(SECRET, 'garbage', now), null);
  assert.equal(await verifySession(undefined, v, now), null);
});

test('the cookie is HttpOnly, Secure, SameSite=Lax and scoped to the base path', () => {
  const c = sessionCookie('v', '/ask-siren/');
  assert.match(c, /^siren_invite=v; /);
  for (const part of ['Path=/ask-siren/', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(c.includes(part), part);
  assert.equal(readCookie(withCookie('abc.def')), 'abc.def');
  assert.equal(readCookie(new Request('https://x/')), null);
});

test('at the root of its own origin the cookie is __Host-siren_invite, and only that name counts', async () => {
  assert.equal(inviteCookieName(''), '__Host-siren_invite');
  assert.equal(inviteCookieName('/ask-siren'), 'siren_invite');
  const c = sessionCookie('v', '/');
  assert.equal(c, '__Host-siren_invite=v; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax', 'Secure, Path=/, no Domain: what __Host- requires');
  assert.ok(!/Domain=/i.test(c));
  const kv = fakeKV();
  const code = await addInvite(kv, { label: 'root' });
  const root = { INVITE_REQUIRED: 'true', INVITE_SECRET: SECRET };
  const out = await redeem({ code, env: root, kv, visitor: 'v1' });
  const at = (cookie) => new Request('https://ask-siren.example/api/ask', { headers: { Cookie: cookie } });
  assert.equal((await currentInvite(at(`__Host-siren_invite=${out.cookie}`), root, kv)).label, 'root');
  assert.equal(await currentInvite(at(`siren_invite=${out.cookie}`), root, kv), null, 'the old name is not read at the root');
  assert.equal(await currentInvite(at(`__Host-siren_invite=${out.cookie}`), env, kv), null, 'nor the new name under a path');
});

test('redeeming a code signs you in; revoking the invite signs you out', async () => {
  const kv = fakeKV();
  const code = await addInvite(kv, { label: 'friends', max_uses: 2 });
  const out = await redeem({ code: code.toLowerCase(), env, kv, visitor: 'v1' });
  assert.equal(out.ok, true);
  const invite = await currentInvite(withCookie(out.cookie), env, kv);
  assert.equal(invite.label, 'friends');
  await kv.delete(await inviteKey(code));
  assert.equal(await currentInvite(withCookie(out.cookie), env, kv), null);
});

test('a code stops working after its last use', async () => {
  const kv = fakeKV();
  const code = await addInvite(kv, { label: 'one person', max_uses: 1 });
  assert.equal((await redeem({ code, env, kv, visitor: 'v1' })).ok, true);
  const again = await redeem({ code, env, kv, visitor: 'v2' });
  assert.equal(again.ok, false);
  assert.match(again.error, /used up/);
});

test('wrong codes are refused, and guessing is limited per visitor', async () => {
  const kv = fakeKV();
  const now = Date.UTC(2026, 10, 2, 12);
  for (let i = 0; i < 10; i++) {
    const r = await redeem({ code: newCode(), env, kv, visitor: 'guesser', maxFailures: 10, now });
    assert.equal(r.status, 403);
  }
  const code = await addInvite(kv, { label: 'real', max_uses: 5 });
  const blocked = await redeem({ code, env, kv, visitor: 'guesser', maxFailures: 10, now });
  assert.equal(blocked.status, 429); // even a real code, once over the limit
  assert.equal((await redeem({ code, env, kv, visitor: 'someone-else', maxFailures: 10, now })).ok, true);
});

test('a room on one network can all redeem: only failures count', async () => {
  const kv = fakeKV();
  for (let i = 0; i < 40; i++) {
    const code = await addInvite(kv, { label: `guest ${i}`, max_uses: 1 });
    assert.equal((await redeem({ code, env, kv, visitor: 'venue-wifi' })).ok, true, `guest ${i}`);
  }
});

test('re-entering a code in a browser already signed in with it costs no use', async () => {
  const kv = fakeKV();
  const code = await addInvite(kv, { label: 'one', max_uses: 1 });
  const first = await redeem({ code, env, kv, visitor: 'v' });
  const again = await redeem({ code, env, kv, visitor: 'v', current: first.hash });
  assert.equal(again.ok, true);
  assert.equal([...kv.store.keys()].filter((k) => k.startsWith('redeemed:')).length, 1);
});

test('without a secret, invites fail closed', async () => {
  const kv = fakeKV();
  const code = await addInvite(kv, { label: 'x', max_uses: 1 });
  assert.equal((await redeem({ code, env: { INVITE_REQUIRED: 'true' }, kv, visitor: 'v' })).status, 503);
  const signed = await signSession(SECRET, 'a'.repeat(64));
  assert.equal(await currentInvite(withCookie(signed), { INVITE_REQUIRED: 'true' }, kv), null);
});

test('the waitlist keeps only what people typed, one entry per email', async () => {
  assert.match(waitlistEntry({ email: 'not an email' }).error, /doesn't look right/);
  assert.match(waitlistEntry(null).error, /email/);
  assert.equal(waitlistEntry({ email: 'a@b.co', website: 'http://spam' }).spam, true);
  const { entry } = waitlistEntry({ email: '  Ana@Example.ORG ', name: 'Ana\u0007', org: 'x'.repeat(500), extra: 'dropped' });
  assert.deepEqual(Object.keys(entry), ['email', 'name', 'org', 'note']);
  assert.equal(entry.email, 'ana@example.org');
  assert.equal(entry.name, 'Ana');
  assert.equal(entry.org.length, 160);

  assert.ok(waitlistEntry({ email: "o'brien@example.org" }).entry, 'apostrophes are valid in emails');
  assert.ok(waitlistEntry({ email: 'ana@example.xn--p1ai' }).entry, 'punycode TLDs are valid');
  const kv = fakeKV();
  await joinWaitlist({ body: { email: 'ana@example.org', note: 'flooding' }, kv, visitor: 'v', source: 'Siren' });
  await joinWaitlist({ body: { email: 'ANA@example.org', note: 'trees' }, kv, visitor: 'someone-else', source: 'Siren' });
  const entries = [...kv.store.keys()].filter((k) => k.startsWith('waitlist:'));
  assert.equal(entries.length, 1);
  const saved = JSON.parse(kv.store.get(entries[0]).value);
  assert.equal(saved.note, 'flooding', "a second signup can't overwrite the first");
  assert.equal(saved.source, 'Siren');
  assert.ok(!JSON.stringify(saved).includes('"v"'), 'no visitor id stored with the entry');
});

test('the honeypot looks successful but stores nothing; signups are rate limited', async () => {
  const kv = fakeKV();
  assert.deepEqual(await joinWaitlist({ body: { email: 'bot@spam.biz', website: 'x' }, kv, visitor: 'bot', source: 'Siren' }), { ok: true });
  assert.equal([...kv.store.keys()].filter((k) => k.startsWith('waitlist:')).length, 0);
  for (let i = 0; i < 5; i++) assert.equal((await joinWaitlist({ body: { email: `p${i}@x.org` }, kv, visitor: 'busy', source: 'Siren', perDay: 5 })).ok, true);
  assert.equal((await joinWaitlist({ body: { email: 'p0@x.org' }, kv, visitor: 'busy', source: 'Siren', perDay: 5 })).ok, true, 'signing up again is free');
  assert.equal((await joinWaitlist({ body: { email: 'p6@x.org' }, kv, visitor: 'busy', source: 'Siren', perDay: 5 })).status, 429);
});

test('waitlist export fields never run as spreadsheet formulas', () => {
  assert.equal(csvField('=HYPERLINK("https://evil.example","x")'), `"'=HYPERLINK(""https://evil.example"",""x"")"`);
  for (const lead of ['+', '-', '@']) assert.ok(csvField(`${lead}1`).startsWith(`"'${lead}`));
  assert.equal(csvField('plain'), '"plain"');
  assert.equal(csvField(null), '""');
});
