// Block watch (docs/block-watch.md): blocks, never house numbers; the email
// sealed and bound to its account; the daily scan of upcoming agendas; the
// page's forms; and the flag off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { userId, signUser } from '../worker/accounts.js';
import {
  blockOf, blockId, onBlock, itemKinds, sealEmail, openEmail, unsubscribeToken, tokenWatchId, addBlock, removeBlock, loadWatch,
  runBlockWatch, handleWatch, digest, MAX_BLOCKS, BATCH, blockWatchSetupError,
} from '../worker/block-watch.js';

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const v = store.get(key);
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix, limit = 1000, cursor }) {
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const keys = all.slice(from, from + limit).map((name) => ({ name }));
      const done = from + limit >= all.length;
      return { keys, list_complete: done, ...(done ? {} : { cursor: String(from + limit) }) };
    },
  };
}

const EMAIL = 'neighbor@example.org';
const env = (kv) => ({
  BLOCK_WATCH: 'true', LIMITS: kv, INVITE_SECRET: 'invite-secret-that-is-long-enough', WATCH_SECRET: 'w'.repeat(40),
  RESEND_API_KEY: 're_test', LOGIN_FROM: 'Siren <siren@example.org>', PUBLIC_ORIGIN: 'https://siren.example.org',
});
const MATCH = { address: '810 UNION ST', number: '810', street: 'UNION ST' };
const lookup = async () => ({ match: MATCH });
const NOON = Date.parse('2026-11-16T12:05:00Z');

test('the email describes an item by its kind, from fixed phrases: never a title, which can name anyone', () => {
  assert.deepEqual(itemKinds('JANE DOE, for a Conditional Use Permit to operate a Short-Term Rental at 1 A St'), ['a short-term rental', 'a conditional use permit']);
  assert.deepEqual(itemKinds('An Ordinance Approving the Sale and Conveyance to Jane Q. Public of That Certain Parcel at 928 W. 26th Street'), ['a sale or transfer of property']);
  assert.deepEqual(itemKinds('An Ordinance Permitting John Roe and Mary Roe to Encroach into the Right-of-Way at 3101 Pretty Lake Avenue'), ['an encroachment into the public right-of-way']);
  assert.deepEqual(itemKinds('Something else entirely'), ['an agenda item']);
  assert.deepEqual(itemKinds('X, for Conditional Use Permits at 9567 Shore Drive: a. Sale of Alcoholic Beverages'), ['a conditional use permit', 'alcohol sales']);
});

test('a block is the hundred block of one street: its direction and type count, the house number is dropped', () => {
  const b = blockOf('norfolk', MATCH);
  assert.deepEqual(b, { city: 'norfolk', dir: '', core: 'UNION', suffix: 'STREET', hundred: 800, label: '800 block of Union St' });
  assert.equal(blockId(b), 'norfolk:800::UNION:STREET');
  assert.ok(onBlock(b, '812 UNION STREET'));
  assert.ok(onBlock(b, '899 Union St.'));
  assert.ok(onBlock(b, '812A Union Street'));
  assert.ok(!onBlock(b, '900 UNION STREET'));
  assert.ok(!onBlock(b, '810 Union Avenue'), 'another street type is another street');
  assert.ok(!onBlock(b, 'UNION STREET'));
  const w = blockOf('norfolk', { number: '1150', street: 'W OCEAN VIEW AVE' });
  assert.ok(onBlock(w, '1100 W. Ocean View Avenue'));
  assert.ok(!onBlock(w, '1100 E. Ocean View Avenue'), 'another direction is another street');
  assert.ok(!onBlock(w, '1100 Ocean View Road'));
  assert.ok(!onBlock(w, '1100 Ocean View Avenue'), 'an agenda that leaves out the direction is a miss, never a wrong street');
  const n = blockOf('norfolk', { number: '5800', street: 'N MILITARY HWY' });
  assert.ok(!onBlock(n, '5800 S. Military Highway'));
});

test('the email is sealed, and opens only in its own account', async () => {
  const s = 'k'.repeat(40);
  const sealed = await sealEmail(s, 'a'.repeat(64), EMAIL);
  assert.ok(!sealed.includes('neighbor'));
  assert.equal(await openEmail(s, 'a'.repeat(64), sealed), EMAIL);
  assert.equal(await openEmail(s, 'b'.repeat(64), sealed), null);
  assert.equal(await openEmail('x'.repeat(40), 'a'.repeat(64), sealed), null);
});

test("the unsubscribe token carries the watch's random id, not the account, and can't be forged", async () => {
  const s = 'k'.repeat(40);
  const id = 'c'.repeat(32);
  const t = await unsubscribeToken(s, id);
  assert.equal(await tokenWatchId(s, t), id);
  assert.equal(await tokenWatchId(s, `${'d'.repeat(32)}.${t.split('.')[1]}`), null);
  assert.equal(await tokenWatchId(s, 'nonsense'), null);
});

test("adding a block: the account's own email only; the house number is never stored; limits hold", async () => {
  const kv = fakeKV();
  const e = env(kv);
  const uid = await userId(e.INVITE_SECRET, EMAIL);
  assert.equal((await addBlock({ env: e, kv, uid, email: 'someone@else.org', address: '810 Union St', cityKey: 'norfolk', lookup })).code, 'email');
  assert.equal(kv.store.size, 0);
  const ok = await addBlock({ env: e, kv, uid, email: EMAIL, address: '810 Union St', cityKey: 'norfolk', lookup });
  assert.ok(ok.ok);
  const raw = kv.store.get(`watch:${uid}`);
  assert.ok(!raw.includes('810'), 'no house number');
  assert.ok(!raw.includes('neighbor'), 'no plain email');
  assert.equal((await addBlock({ env: e, kv, uid, email: EMAIL, address: '812 Union St', cityKey: 'norfolk', lookup })).already, true);
  assert.equal((await addBlock({ env: e, kv, uid, email: EMAIL, address: 'x', cityKey: 'seattle', lookup })).code, 'city');
  assert.equal((await addBlock({ env: e, kv, uid, email: EMAIL, address: '1 Nowhere', cityKey: 'norfolk', lookup: async () => ({ match: null, candidates: [] }) })).code, 'notfound');
  for (let i = 1; i < MAX_BLOCKS; i++) {
    await addBlock({ env: e, kv, uid, email: EMAIL, address: 'x', cityKey: 'norfolk', lookup: async () => ({ match: { ...MATCH, number: String(810 + i * 100) } }) });
  }
  assert.equal((await loadWatch(kv, uid)).blocks.length, MAX_BLOCKS);
  assert.equal((await addBlock({ env: e, kv, uid, email: EMAIL, address: 'x', cityKey: 'norfolk', lookup })).code, 'full');
  await removeBlock({ env: e, kv, uid, id: 'norfolk:800::UNION:STREET' });
  assert.equal((await loadWatch(kv, uid)).blocks.length, MAX_BLOCKS - 1);
});

test('lookups are limited per account per day', async () => {
  const kv = fakeKV();
  const e = env(kv);
  const uid = await userId(e.INVITE_SECRET, EMAIL);
  const miss = async () => ({ match: null });
  let last;
  for (let i = 0; i < 21; i++) last = await addBlock({ env: e, kv, uid, email: EMAIL, address: '1 A St', cityKey: 'norfolk', lookup: miss });
  assert.equal(last.code, 'rate');
});

// The portal and Socrata, faked: one upcoming Council meeting whose agenda has
// an item on the 800 block of Union, one elsewhere, one with no address.
function fakeNet() {
  const calls = [];
  const mails = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/resource/dszu-h9cf.json')) {
      return new Response(JSON.stringify([{ date_and_time: '2026-11-24T18:00:00.000', organization: 'City Council', meeting_link: { url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=9001' } }]), { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('Detail_Meeting.aspx?ID=9001')) {
      return new Response(`<span id="ContentPlaceholder1_lblMeetingGroup">City Council</span>
        <a href='Detail_LegiFile.aspx?Frame=&MeetingID=9001&ID=7001'>ROBERT WARING, for a conditional change in zoning on Property Located at 812 Union Street</a>
        <a href='Detail_LegiFile.aspx?Frame=&MeetingID=9001&ID=7002'>An Ordinance to Rezone Property Located at 300 Granby Street</a>
        <a href='Detail_LegiFile.aspx?Frame=&MeetingID=9001&ID=7003'>An Ordinance Amending the Annual Budget</a>`);
    }
    if (u === 'https://api.resend.com/emails') {
      mails.push({ ...JSON.parse(init.body), idempotency: init.headers['Idempotency-Key'] });
      return new Response(JSON.stringify({ id: 'm1' }));
    }
    return new Response('no', { status: 404 });
  };
  return { calls, mails, fetchImpl };
}

test('the scan: off, early, or with no watches, it fetches nothing', async () => {
  const kv = fakeKV();
  const net = fakeNet();
  assert.equal((await runBlockWatch({ ...env(kv), BLOCK_WATCH: undefined }, { now: NOON, fetchImpl: net.fetchImpl })).skipped, 'off');
  assert.equal((await runBlockWatch(env(kv), { now: Date.parse('2026-11-16T11:55:00Z'), fetchImpl: net.fetchImpl })).skipped, 'early');
  const none = await runBlockWatch(env(kv), { now: NOON, fetchImpl: net.fetchImpl });
  assert.equal(none.watches, 0);
  assert.equal(net.calls.length, 0);
});

// A member: the account bound to a live invite (accounts.js memberInvite).
async function makeMember(kv, uid) {
  await kv.put(`member:${uid}`, JSON.stringify({ invite: 'inv1' }));
  await kv.put('invite:inv1', JSON.stringify({ label: 'test' }));
}
async function watcher(kv, e, email = EMAIL, address = '810 Union St', match = MATCH) {
  const uid = await userId(e.INVITE_SECRET, email);
  await makeMember(kv, uid);
  await addBlock({ env: e, kv, uid, email, address, cityKey: 'norfolk', lookup: async () => ({ match }) });
  return uid;
}

test('the scan emails a watcher once about an item on their block: its kind and address, never its title, and a one-click unsubscribe', async () => {
  const kv = fakeKV();
  const e = env(kv);
  const uid = await watcher(kv, e);
  const before = kv.store.get(`watch:${uid}`);
  const net = fakeNet();
  const out = await runBlockWatch(e, { now: NOON, fetchImpl: net.fetchImpl });
  assert.equal(out.emails, 1);
  assert.equal(out.meetings, 1);
  assert.equal(net.mails.length, 1);
  const m = net.mails[0];
  assert.deepEqual(m.to, [EMAIL]);
  assert.match(m.subject, /800 block of Union St/);
  assert.match(m.text, /City Council, Nov 24, 2026: an item about a zoning change at 812 Union Street/);
  assert.doesNotMatch(m.text + m.html, /WARING|ROBERT|conditional change|Granby|Annual Budget/);
  assert.match(m.text, /Detail_LegiFile\.aspx\?ID=7001/);
  assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/siren\.example\.org\/watch\/unsubscribe\?t=[0-9a-f]{32}\.[0-9a-f]{32}>$/);
  assert.ok(!m.headers['List-Unsubscribe'].includes(uid), 'the link never carries the account id');
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  // Every request but the mail went through the counted, traced clients: the notices query and the one agenda.
  assert.equal(net.calls.filter((u) => !u.includes('resend')).length, 2);
  assert.equal(kv.store.get(`watch:${uid}`), before, 'the scan never writes the watch record');
  // Later the same day: done. The next day: the item was sent, so no email.
  assert.equal((await runBlockWatch(e, { now: NOON + 600e3, fetchImpl: net.fetchImpl })).skipped, 'done');
  const again = await runBlockWatch(e, { now: NOON + 864e5, fetchImpl: net.fetchImpl });
  assert.equal(again.emails, 0);
  assert.equal(net.mails.length, 1);
});

test('the scan: a removal during it stays removed; a member who lost their invite is deleted, not emailed', async () => {
  const kv = fakeKV();
  const e = env(kv);
  const uid = await watcher(kv, e);
  const net = fakeNet();
  const slow = async (url, init) => {
    // The member presses "Stop all alerts" while the scan reads the agendas.
    if (String(url).includes('Detail_Meeting')) await handleWatch(post('/watch/delete', {}), e, '/watch/delete', deps(kv, { uid }));
    return net.fetchImpl(url, init);
  };
  await runBlockWatch(e, { now: NOON, fetchImpl: slow });
  assert.equal(kv.store.get(`watch:${uid}`), undefined, 'not written back');
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith('watch-sent:') || k.startsWith('watch-by-id:')), 'nothing kept for it');

  const kv2 = fakeKV();
  const e2 = env(kv2);
  const uid2 = await watcher(kv2, e2);
  await kv2.delete(`member:${uid2}`);
  const out = await runBlockWatch(e2, { now: NOON, fetchImpl: fakeNet().fetchImpl });
  assert.equal(out.removed, 1);
  assert.equal(out.emails, 0);
  assert.equal(await loadWatch(kv2, uid2), null);
});

test('the scan works through the watches a batch a tick, and retries a tick whose agendas failed', async () => {
  const kv = fakeKV();
  const e = env(kv);
  for (let i = 0; i < BATCH + 5; i++) await watcher(kv, e, `n${i}@example.org`);
  const down = async () => new Response('down', { status: 503 });
  const failed = await runBlockWatch(e, { now: NOON, fetchImpl: down });
  assert.equal(failed.retry, true);
  const net = fakeNet();
  const first = await runBlockWatch(e, { now: NOON + 600e3, fetchImpl: net.fetchImpl });
  assert.equal(first.watches, BATCH);
  assert.equal(first.emails, BATCH);
  const second = await runBlockWatch(e, { now: NOON + 1200e3, fetchImpl: net.fetchImpl });
  assert.equal(second.watches, 5);
  assert.equal(second.emails, 5);
  assert.equal((await runBlockWatch(e, { now: NOON + 1800e3, fetchImpl: net.fetchImpl })).skipped, 'done');
  assert.equal(net.mails.length, BATCH + 5);
});

test("the digest speaks in Siren's voice and says what it can't see", () => {
  const d = digest({
    groups: [{ block: { label: '800 block of Union St' }, items: [{ kinds: ['a conditional use permit'], here: ['812 UNION STREET'], meeting: { body: 'City Council', date: '2026-11-24' }, url: 'https://r', meetingUrl: 'https://m' }] }],
    origin: 'https://s', unsubscribe: 'https://s/u',
  });
  assert.match(d.text, /^Siren found/);
  assert.match(d.text, /an item about a conditional use permit at 812 Union Street/);
  assert.match(d.text, /Items that name no address .* are not matched/);
  assert.doesNotMatch(d.text, /\bthere (is|are)\b|\bnobody\b|\bno one\b/i);
  assert.match(d.text, /Nov 24, 2026/);
});

// The routes, through handleWatch with the account helpers it's given.
const ORIGIN = 'https://siren.example.org';
function deps(kv, { uid = null, member = true } = {}) {
  return {
    base: '', origin: ORIGIN, css: '/assets/x/watch.css', pageHeaders: { 'Content-Type': 'text/html; charset=utf-8' },
    currentUserInfo: async () => (uid ? { uid, masked: 'n•••@example.org' } : null), isMember: async () => member, lookup, cityKey: 'norfolk',
  };
}
const post = (path, fields, headers = { Origin: ORIGIN }) => new Request(`${ORIGIN}${path}`, { method: 'POST', body: new URLSearchParams(fields), headers });

test('the page: signed out, not a member, or a member with a form', async () => {
  const kv = fakeKV();
  const e = env(kv);
  const get = (d) => handleWatch(new Request(`${ORIGIN}/watch`), e, '/watch', d);
  assert.match(await (await get(deps(kv))).text(), /Sign in with your email/);
  const uid = await userId(e.INVITE_SECRET, EMAIL);
  assert.match(await (await get(deps(kv, { uid, member: false }))).text(), /redeem your invite/);
  const page = await (await get(deps(kv, { uid }))).text();
  assert.match(page, /<form class="add" method="post" action="\/watch\/add">/);
  assert.doesNotMatch(page, /<script/);
  assert.equal(await handleWatch(new Request(`${ORIGIN}/other`), e, '/other', deps(kv)), null);
});

test('forms: only from this origin; add, remove and delete redirect with a fixed message', async () => {
  const kv = fakeKV();
  const e = env(kv);
  const uid = await userId(e.INVITE_SECRET, EMAIL);
  const d = deps(kv, { uid });
  assert.equal((await handleWatch(post('/watch/add', { address: '810 Union St', email: EMAIL }, {}), e, '/watch/add', d)).status, 403);
  assert.equal((await handleWatch(post('/watch/add', { address: '810 Union St', email: EMAIL }, { Origin: 'https://evil.example' }), e, '/watch/add', d)).status, 403);
  const added = await handleWatch(post('/watch/add', { address: '810 Union St', email: EMAIL }), e, '/watch/add', d);
  assert.equal(added.status, 303);
  assert.equal(added.headers.get('Location'), '/watch?m=added');
  assert.equal((await loadWatch(kv, uid)).blocks.length, 1);
  const wrong = await handleWatch(post('/watch/add', { address: '<b>810</b>', email: 'x@y.org' }), e, '/watch/add', d);
  assert.equal(wrong.headers.get('Location'), '/watch?m=email');
  const page = await (await handleWatch(new Request(`${ORIGIN}/watch?m=<script>`), e, '/watch', d)).text();
  assert.doesNotMatch(page, /<script>/);
  await handleWatch(post('/watch/delete', {}), e, '/watch/delete', d);
  assert.equal(await loadWatch(kv, uid), null);
});

test('the unsubscribe link: GET only shows a button; POST, by form or one-click, deletes the watch', async () => {
  const kv = fakeKV();
  const e = env(kv);
  const uid = await userId(e.INVITE_SECRET, EMAIL);
  await addBlock({ env: e, kv, uid, email: EMAIL, address: '810 Union St', cityKey: 'norfolk', lookup });
  const t = await unsubscribeToken(e.WATCH_SECRET, (await loadWatch(kv, uid)).id);
  const shown = await handleWatch(new Request(`${ORIGIN}/watch/unsubscribe?t=${t}`), e, '/watch/unsubscribe', deps(kv));
  assert.equal(shown.status, 200);
  assert.ok(await loadWatch(kv, uid), 'a GET (a mail scanner) changes nothing');
  assert.equal((await handleWatch(new Request(`${ORIGIN}/watch/unsubscribe?t=bad`), e, '/watch/unsubscribe', deps(kv))).status, 400);
  // RFC 8058 one-click: no Origin, no cookie, the token in the URL.
  const oneClick = new Request(`${ORIGIN}/watch/unsubscribe?t=${t}`, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal((await handleWatch(oneClick, e, '/watch/unsubscribe', deps(kv))).status, 200);
  assert.equal(await loadWatch(kv, uid), null);
  // Spent: the watch is gone, so the link no longer works, even after a new watch.
  await addBlock({ env: e, kv, uid, email: EMAIL, address: '810 Union St', cityKey: 'norfolk', lookup });
  assert.equal((await handleWatch(new Request(`${ORIGIN}/watch/unsubscribe?t=${t}`), e, '/watch/unsubscribe', deps(kv))).status, 400);
});

test('setup: every piece it needs is named', () => {
  const kv = fakeKV();
  assert.equal(blockWatchSetupError(env(kv)), null);
  assert.match(blockWatchSetupError({ ...env(kv), WATCH_SECRET: 'short' }), /WATCH_SECRET/);
  assert.match(blockWatchSetupError({ ...env(kv), PUBLIC_ORIGIN: '' }), /PUBLIC_ORIGIN/);
});

// The Worker itself: with BLOCK_WATCH unset, /watch is the ordinary 404 and the
// stylesheet isn't served; on but not set up, 503.
const skip = typeof nodeModule.registerHooks !== 'function' && 'node:module has no registerHooks';
let worker;
async function loadWorker() {
  if (worker) return worker;
  const asText = (url) => ({ format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true });
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && (context.importAttributes?.type === 'text' || url.endsWith('.html'))) return asText(url);
      if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) {
        return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  worker = (await import('../worker/index.js')).default;
  return worker;
}

test('the Worker: flag off, /watch is a 404 and the cron does nothing; on without setup, 503', { skip }, async () => {
  const w = await loadWorker();
  const off = await w.fetch(new Request('https://siren.example.org/watch'), {}, {});
  assert.equal(off.status, 404);
  const offPost = await w.fetch(post('/watch/add', { address: 'x' }), {}, {});
  assert.equal(offPost.status, 415, 'the JSON-only rule answers, as for any form post');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched++;
    return new Response('{}');
  };
  try {
    await w.scheduled({ cron: '*/10 * * * *' }, {}, {});
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0);
  const on = await w.fetch(new Request('https://siren.example.org/watch'), { BLOCK_WATCH: 'true' }, {});
  assert.equal(on.status, 503);
  const kv = fakeKV();
  const uid = await userId(env(kv).INVITE_SECRET, EMAIL);
  const cookie = `__Host-siren_user=${await signUser(env(kv).INVITE_SECRET, uid, Date.now(), 'n•••@example.org')}`;
  const ready = await w.fetch(new Request('https://siren.example.org/watch', { headers: { Cookie: cookie } }), env(kv), {});
  assert.equal(ready.status, 200);
  assert.match(ready.headers.get('Content-Security-Policy'), /form-action 'self'/);
  assert.match(await ready.text(), /redeem your invite/);
});
