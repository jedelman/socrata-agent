// Browsing and searching an account's private conversations: GET
// /api/conversations pages newest-updated first behind an opaque cursor, and
// /api/conversations/search (GET ?q= or POST {q}) searches the account's own
// questions and answers. Through the Worker's own fetch handler, with .html
// and text imports loaded the way Wrangler bundles them; where node:module
// has no registerHooks, the Worker tests skip. Shared modules are imported
// statically, above the hook (see the comment in worker/index.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import {
  saveTurn, foldText, searchQuery, searchConversations, chargeSearch, pageConversations, pageSize, encodeCursor, decodeCursor,
  conversationMetadata, PAGE_DEFAULT, PAGE_MAX, SEARCH_SCAN, SEARCH_RESULTS, SEARCH_PER_CONVERSATION, SEARCH_DAILY,
} from '../worker/conversations.js';
import { boundary } from '../worker/crypto.js';

const USER_COOKIE = userCookieName('');
const canHook = typeof nodeModule.registerHooks === 'function';
const skip = !canHook && 'node:module has no registerHooks';
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

// KV with metadata on keys, and a record of every read and write.
function fakeKV() {
  const store = new Map();
  const gets = [];
  const puts = [];
  return {
    store,
    gets,
    puts,
    fail: null,
    async get(k, type) {
      if (this.fail && this.fail(k)) throw new Error(`KV get failed for ${k}`);
      gets.push(k);
      if (!store.has(k)) return null;
      const v = store.get(k).value;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v, opts = {}) {
      puts.push({ key: k, value: String(v), opts });
      store.set(k, { value: String(v), metadata: opts.metadata, expiration: opts.expiration, ttl: opts.expirationTtl });
    },
    async delete(k) {
      store.delete(k);
    },
    async list({ prefix }) {
      const keys = [...store.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
      return { keys: keys.map(([name, v]) => ({ name, ...(v.metadata ? { metadata: v.metadata } : {}) })), list_complete: true };
    },
  };
}

const SECRET = 'test-secret-that-is-long-enough';
const T0 = Date.parse('2026-11-01T12:00:00Z');
const at = (minutes) => T0 + minutes * 60e3;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A conversation saved the way the Worker saves one, its last turn at `when`.
async function seed(kv, uid, id, turns, when) {
  let conv = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    conv = await saveTurn(kv, uid, id, conv, { city: 'norfolk', question: t.q, answer: t.a, tools: t.tools || [], record: t.record }, { now: when - (turns.length - 1 - i) * 1000 });
  }
  return conv;
}
// Many one-turn conversations at once, written straight to KV with the metadata saveTurn writes.
function seedMany(kv, uid, n, fill) {
  for (let i = 0; i < n; i++) {
    const { q, a, minutes } = fill(i);
    const conv = { city: 'norfolk', created: new Date(at(minutes)).toISOString(), turns: [{ at: new Date(at(minutes)).toISOString(), question: q, answer: a, tools: [] }] };
    kv.store.set(`conv:${uid}:${uuid(i)}`, { value: JSON.stringify(conv), metadata: conversationMetadata(conv) });
  }
}

async function member(kv, email = 'reader@example.org') {
  const uid = await userId(SECRET, email);
  await kv.put('invite:h1', JSON.stringify({ label: 'test' }));
  await kv.put(`member:${uid}`, JSON.stringify({ invite: 'h1' }));
  return { uid, cookie: `${USER_COOKIE}=${await signUser(SECRET, uid)}` };
}
const envWith = (kv) => ({ LIMITS: kv, INVITE_REQUIRED: 'true', INVITE_SECRET: SECRET, IP_SALT: 'salt' });
const get = (path, cookie) => new Request(`https://x.org${path}`, { headers: { 'CF-Connecting-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) } });
const post = (path, body, cookie, type = 'application/json') =>
  new Request(`https://x.org${path}`, { method: 'POST', headers: { 'Content-Type': type, 'CF-Connecting-IP': '203.0.113.9', ...(cookie ? { Cookie: cookie } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const searchGet = (q, cookie) => get(`/api/conversations/search?q=${encodeURIComponent(q)}`, cookie);
const searchPost = (q, cookie) => post('/api/conversations/search', { q }, cookie);

// ---- The pieces ----

test('folding: NFKC, case and whitespace, the same for the query and the text', () => {
  assert.equal(foldText('  Union\n\t  ST  '), 'union st');
  assert.equal(foldText('ＵＮＩＯＮ'), 'union', 'full-width letters fold to ASCII');
  assert.equal(foldText('ﬁsh'), 'fish', 'ligatures unfold');
  assert.equal(foldText('ΟΔΟΣ'), foldText('οδος'), 'final sigma and capital sigma fold together');
  // Lowercasing a character at a time agrees with lowercasing the whole string, after the sigma fold.
  const mixed = 'İstanbul ΣΟΦΟΣ ﬁ Ⅻ ＡＢＣ Straße';
  assert.equal(foldText(mixed), [...mixed.normalize('NFKC')].map((c) => c.toLowerCase()).join('').replace(/ς/g, 'σ'));
  // Markdown reads as it does on the page.
  assert.equal(
    foldText('## Removals\n> I found a **Willow Oak** removal in `qzfe-wj25`, see [the work order](https://data.norfolk.gov/d/qzfe-wj25 "x").\n\n| Tree | When |\n|---|:---:|\n| Oak | May |\n\n#12 permit'),
    'removals i found a willow oak removal in qzfe-wj25, see the work order. tree when oak may #12 permit',
  );
  // Long runs of markdown-ish characters fold quickly (no pattern backtracks on them).
  const t = Date.now();
  for (const s of ['-'.repeat(8000) + 'x', '['.repeat(8000), '| ---- '.repeat(1300) + 'x', `[${'a'.repeat(8000)}`]) foldText(s);
  assert.ok(Date.now() - t < 500);
});

test('the query is 2 to 100 characters once folded, and its errors never repeat it', () => {
  for (const q of ['', 'a', '   a   ', '　x　', null, undefined, 7, ['ab']]) assert.ok(searchQuery(q).error, String(q));
  assert.equal(searchQuery('ab').folded, 'ab');
  assert.equal(searchQuery('  Union   St ').folded, 'union st');
  assert.equal(searchQuery('x'.repeat(100)).folded.length, 100);
  assert.ok(searchQuery('x'.repeat(101)).error);
  assert.ok(searchQuery('ab'.repeat(5000)).error, 'a long string is refused before folding');
  assert.equal(searchQuery(`${'x'.repeat(49)}${' '.repeat(400)}${'y'.repeat(50)}`).folded.length, 100, 'whitespace collapses before counting');
  const secret = 'zq-secret-term';
  for (const q of [secret.slice(0, 1), secret.repeat(20)]) assert.ok(!searchQuery(q).error.includes('zq'), 'the error text is fixed');
});

test('page sizes and cursors: default 20, at most 50; a cursor this code did not make is refused', () => {
  assert.equal(pageSize(null), PAGE_DEFAULT);
  assert.equal(pageSize(''), PAGE_DEFAULT);
  assert.equal(pageSize('abc'), PAGE_DEFAULT);
  assert.equal(pageSize('0'), PAGE_DEFAULT);
  assert.equal(pageSize('-5'), PAGE_DEFAULT);
  assert.equal(pageSize('7'), 7);
  assert.equal(pageSize('500'), PAGE_MAX);
  const c = encodeCursor({ updated: '2026-11-01T12:00:00.000Z', id: uuid(1) });
  assert.match(c, /^[A-Za-z0-9_-]+$/, 'opaque, URL-safe');
  assert.deepEqual(decodeCursor(c), { updated: '2026-11-01T12:00:00.000Z', id: uuid(1) });
  for (const bad of ['', 'x', '!!!!!!!!!!', btoa('2026-11-01|nope'), btoa(`not-a-date|${uuid(1)}`), encodeCursor({ updated: '2026-11-01T12:00:00.000Z', id: '../../x' }), 'A'.repeat(500)]) {
    assert.equal(decodeCursor(bad), null, bad);
  }
});

test('paging: newest updated first, ties broken by id, every conversation once, and a robust cursor', async () => {
  const kv = fakeKV();
  const uid = await userId(SECRET, 'a@b.org');
  // 45 conversations, some sharing a minute (ties), in no particular key order.
  seedMany(kv, uid, 45, (i) => ({ q: `q${i}`, a: 'a', minutes: (i * 7) % 30 }));
  const want = [...kv.store.entries()].filter(([k]) => k.startsWith('conv:')).map(([k, v]) => ({ id: k.split(':')[2], updated: v.metadata.updated }))
    .sort((x, y) => (x.updated > y.updated ? -1 : x.updated < y.updated ? 1 : x.id < y.id ? -1 : 1)).map((x) => x.id);
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await pageConversations(kv, uid, { limit: '20', cursor });
    seen.push(...page.conversations.map((c) => c.id));
    cursor = page.next;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.deepEqual(seen, want, 'stable order across pages, nothing twice, nothing missed');
  assert.equal((await pageConversations(kv, uid, {})).conversations.length, 20, 'default page size');
  assert.equal((await pageConversations(kv, uid, { limit: '500' })).conversations.length, 45, 'capped at 50 (all 45 here)');
  assert.equal((await pageConversations(kv, uid, { cursor: 'not-a-cursor' })), null);

  // The conversation the cursor names is deleted, and another is continued, between pages.
  const first = await pageConversations(kv, uid, { limit: '20' });
  const last = first.conversations.at(-1);
  kv.store.delete(`conv:${uid}:${last.id}`);
  const moved = want[30];
  const conv = JSON.parse(kv.store.get(`conv:${uid}:${moved}`).value);
  await saveTurn(kv, uid, moved, conv, { city: 'norfolk', question: 'again', answer: 'a' }, { now: at(999) });
  const second = await pageConversations(kv, uid, { limit: '20', cursor: first.next });
  assert.deepEqual(second.conversations.map((c) => c.id), want.slice(20, 40).filter((id) => id !== moved).concat(want.slice(40, 41)), 'the page after the cursor, as if nothing moved but the continued one');
  const third = await pageConversations(kv, uid, { limit: '20', cursor: second.next });
  assert.deepEqual(third.conversations.map((c) => c.id), want.slice(41));
  assert.equal(third.next, null);
  // A cursor past the end: an empty page, no next.
  assert.deepEqual(await pageConversations(kv, uid, { cursor: encodeCursor({ updated: '2000-01-01T00:00:00.000Z', id: uuid(0) }) }), { conversations: [], next: null });
});

// ---- Search ----

test('search hits questions and answers, never tool results or the record, with a snippet around the hit', async () => {
  const kv = fakeKV();
  const uid = await userId(SECRET, 'a@b.org');
  const filler = 'The work orders I found list sidewalk repairs and storm drain cleaning on this block. '.repeat(4);
  await seed(kv, uid, uuid(1), [
    { q: 'What is on my block at 810 Union St?', a: `${filler}One of them is a **Willow Oak** removal, done in March. ${filler}`, tools: [{ name: 'block_report', args: {}, content: 'TOOLONLY marker in a tool result' }], record: { answer: 'x', trace: [{ n: 1, tool: 'RECORDONLY query', soql: 'SELECT RECORDONLY', ok: true, url: 'https://data.norfolk.gov/' }] } },
    { q: 'And the willow oak permits?', a: 'I found no permit for it.' },
  ], at(10));
  // The answer: a hit in the middle of a long answer.
  let r = await searchConversations(kv, uid, searchQuery('WILLOW   oak removal').folded);
  assert.equal(r.matches.length, 1);
  const [m] = r.matches;
  assert.deepEqual([m.id, m.turn, m.field, m.title], [uuid(1), 0, 'answer', 'What is on my block at 810 Union St?']);
  assert.ok(m.snippet.length <= 170 && m.snippet.length >= 120, `about 160 characters: ${m.snippet.length}`);
  assert.equal(m.snippet.slice(m.mark[0], m.mark[1]), 'Willow Oak removal', 'the mark is the hit, as the answer reads (its bold marks dropped)');
  assert.ok(m.snippet.startsWith('…') && m.snippet.endsWith('…'));
  assert.ok(!m.snippet.includes('**'));
  // The question: newest turn first, one match per turn.
  r = await searchConversations(kv, uid, searchQuery('willow oak').folded);
  assert.deepEqual(r.matches.map((x) => [x.turn, x.field]), [[1, 'question'], [0, 'answer']]);
  assert.equal(r.matches[0].snippet, 'And the willow oak permits?');
  // Never the tool results or the record.
  for (const q of ['TOOLONLY', 'RECORDONLY', 'block_report']) assert.deepEqual((await searchConversations(kv, uid, searchQuery(q).folded)).matches, [], q);
});

test('search returns at most 20 matches, newest first, three turns at most per conversation', async () => {
  const kv = fakeKV();
  const uid = await userId(SECRET, 'a@b.org');
  seedMany(kv, uid, 30, (i) => ({ q: `Permit question ${i}`, a: 'a', minutes: i }));
  const r = await searchConversations(kv, uid, searchQuery('permit').folded);
  assert.equal(r.matches.length, SEARCH_RESULTS);
  assert.equal(r.more, true, 'more matches were left out');
  assert.equal(r.bounded, false);
  assert.deepEqual(r.matches.map((x) => x.title), Array.from({ length: 20 }, (_, i) => `Permit question ${29 - i}`), 'newest first');
  assert.ok(r.searched < 30, 'reading stops once the matches are full');
  // One conversation with many matching turns gives three.
  const kv2 = fakeKV();
  await seed(kv2, uid, uuid(7), Array.from({ length: 6 }, (_, i) => ({ q: `trees ${i}`, a: 'trees' })), at(5));
  const r2 = await searchConversations(kv2, uid, searchQuery('trees').folded);
  assert.equal(r2.matches.length, SEARCH_PER_CONVERSATION);
  assert.deepEqual(r2.matches.map((x) => x.turn), [5, 4, 3]);
  assert.equal(r2.more, false);
});

test('search reads at most the 300 newest conversations, and says so when that cut it short', async () => {
  const kv = fakeKV();
  const uid = await userId(SECRET, 'a@b.org');
  // 305 conversations; conversation i is updated at minute i, so the 5 oldest are 0 to 4.
  seedMany(kv, uid, 305, (i) => ({ q: i < 5 ? `oldest sycamore ${i}` : i === 5 ? 'the 300th newest: sycamore' : `q${i}`, a: 'a', minutes: i }));
  kv.gets.length = 0;
  const r = await searchConversations(kv, uid, searchQuery('sycamore').folded);
  assert.equal(r.searched, SEARCH_SCAN);
  assert.equal(r.bounded, true);
  assert.equal(r.notice, 'Searched your 300 newest conversations.');
  assert.deepEqual(r.matches.map((x) => x.title), ['the 300th newest: sycamore'], 'the 300th newest is read; the five older are not');
  assert.ok(kv.gets.filter((k) => k.startsWith('conv:')).length <= SEARCH_SCAN, 'no more than 300 conversations read');
  // Under the bound: no notice.
  const few = fakeKV();
  seedMany(few, uid, 3, (i) => ({ q: `q${i}`, a: 'a', minutes: i }));
  const r2 = await searchConversations(few, uid, searchQuery('q1').folded);
  assert.equal(r2.bounded, false);
  assert.equal(r2.notice, undefined);
});

test('the daily search count: 100 a day, keyed so it cannot be joined to the account, reset the next day', async () => {
  const kv = fakeKV();
  const uid = await userId(SECRET, 'a@b.org');
  const other = await userId(SECRET, 'b@b.org');
  const now = Date.parse('2026-11-10T23:59:30Z');
  for (let i = 0; i < SEARCH_DAILY; i++) assert.equal(await chargeSearch(kv, SECRET, uid, { now }), 'ok');
  assert.equal(await chargeSearch(kv, SECRET, uid, { now }), 'limit', 'the 101st is refused');
  assert.equal(await chargeSearch(kv, SECRET, other, { now }), 'ok', "another account's count is its own");
  assert.equal(await chargeSearch(kv, SECRET, uid, { now: now + 60e3 }), 'ok', 'a new UTC day');
  const keys = [...kv.store.keys()].filter((k) => k.startsWith('search-rate:'));
  assert.equal(keys.length, 3);
  for (const k of keys) {
    assert.match(k, /^search-rate:\d{4}-\d{2}-\d{2}:[0-9a-f]{32}$/);
    for (const id of [uid, other]) for (let i = 0; i + 16 <= id.length; i += 8) assert.ok(!k.includes(id.slice(i, i + 16)), 'no slice of the account id');
  }
  const today = keys.find((k) => k.startsWith('search-rate:2026-11-10:') && kv.store.get(k).value === String(SEARCH_DAILY));
  const tomorrow = keys.find((k) => k.startsWith('search-rate:2026-11-11:'));
  assert.ok(today && tomorrow);
  assert.notEqual(today.split(':')[2], tomorrow.split(':')[2], "one account's keys on two days don't match");
  assert.equal(kv.store.get(today).expiration, boundary(now, 'day', 2), 'every key of a day expires together');
  // KV refuses a second write to one key within a second: that search isn't counted, so it isn't run.
  const busy = fakeKV();
  busy.put = async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); };
  assert.equal(await chargeSearch(busy, SECRET, uid, { now }), 'busy');
});

// ---- Through the Worker ----

test('signed out, or signed in without an invite, every conversation route is a 401, never cached', { skip }, async () => {
  const w = await loadWorker();
  const kv = fakeKV();
  const env = envWith(kv);
  const loner = await userId(SECRET, 'no-invite@example.org');
  const lonerCookie = `${USER_COOKIE}=${await signUser(SECRET, loner)}`;
  for (const cookie of [undefined, lonerCookie, `${USER_COOKIE}=forged.value`]) {
    for (const req of [get('/api/conversations', cookie), get('/api/conversations?limit=50', cookie), searchGet('trees', cookie), searchPost('trees', cookie), get(`/api/conversation?id=${uuid(1)}`, cookie)]) {
      const res = await w.fetch(req, env, {});
      assert.equal(res.status, 401, `${req.method} ${req.url} ${cookie ? 'cookie' : 'none'}`);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    }
  }
  assert.ok(!kv.puts.some((p) => p.key.startsWith('search-rate:')), 'a refused search is not counted');
});

test('the list pages through the Worker, with no-store and a cursor the next request takes', { skip }, async () => {
  const w = await loadWorker();
  const kv = fakeKV();
  const env = envWith(kv);
  const { uid, cookie } = await member(kv);
  seedMany(kv, uid, 25, (i) => ({ q: `q${i}`, a: 'a', minutes: i }));
  const res = await w.fetch(get('/api/conversations', cookie), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const page = await res.json();
  assert.deepEqual(Object.keys(page).sort(), ['conversations', 'next']);
  assert.equal(page.conversations.length, 20);
  assert.deepEqual(Object.keys(page.conversations[0]).sort(), ['city', 'id', 'title', 'turns', 'updated']);
  assert.equal(page.conversations[0].title, 'q24');
  const rest = await (await w.fetch(get(`/api/conversations?cursor=${encodeURIComponent(page.next)}`, cookie), env, {})).json();
  assert.deepEqual(rest.conversations.map((c) => c.title), ['q4', 'q3', 'q2', 'q1', 'q0']);
  assert.equal(rest.next, null);
  const small = await (await w.fetch(get('/api/conversations?limit=3', cookie), env, {})).json();
  assert.equal(small.conversations.length, 3);
  const stale = await w.fetch(get('/api/conversations?cursor=garbage', cookie), env, {});
  assert.equal(stale.status, 400);
  assert.equal(stale.headers.get('Cache-Control'), 'no-store');
});

test("search through the Worker: the account's own conversations only, GET or POST, opening at the matching turn", { skip }, async () => {
  const w = await loadWorker();
  const kv = fakeKV();
  const env = envWith(kv);
  const a = await member(kv, 'a@example.org');
  const b = await member(kv, 'b@example.org');
  await seed(kv, a.uid, uuid(1), [{ q: 'Trees on Raleigh Ave?', a: 'I found 12 crape myrtles.' }, { q: 'Any removals?', a: 'I found one removal of a crape myrtle in May.' }], at(10));
  await seed(kv, b.uid, uuid(2), [{ q: 'Crape myrtle pruning schedule?', a: "I found B's own answer about crape myrtles." }], at(20));
  for (const req of [searchGet('Crape Myrtle', a.cookie), searchPost('Crape Myrtle', a.cookie)]) {
    const res = await w.fetch(req, env, {});
    assert.equal(res.status, 200, req.method);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['bounded', 'matches', 'more', 'searched']);
    assert.deepEqual(body.matches.map((m) => [m.id, m.turn, m.field]), [[uuid(1), 1, 'answer'], [uuid(1), 0, 'answer']], "never b's conversation");
    assert.deepEqual(Object.keys(body.matches[0]).sort(), ['field', 'id', 'mark', 'snippet', 'title', 'turn', 'updated']);
    assert.ok(!JSON.stringify(body).includes("B's own"));
    // The match's turn is where the page scrolls when it opens the conversation.
    const opened = await (await w.fetch(get(`/api/conversation?id=${body.matches[0].id}`, a.cookie), env, {})).json();
    assert.match(opened.turns[body.matches[0].turn].answer, /removal of a crape myrtle/);
  }
  const theirs = await (await w.fetch(searchPost('crape myrtle', b.cookie), env, {})).json();
  assert.deepEqual(theirs.matches.map((m) => m.id), [uuid(2)], 'and b sees only its own');
  // POST takes JSON only.
  assert.equal((await w.fetch(post('/api/conversations/search', 'q=crape', a.cookie, 'text/plain'), env, {})).status, 415);
});

test('search query rules through the Worker: 400 with no-store, never echoing the query, never counted', { skip }, async () => {
  const w = await loadWorker();
  const kv = fakeKV();
  const env = envWith(kv);
  const { cookie } = await member(kv);
  const cases = [get('/api/conversations/search', cookie), searchGet('z', cookie), searchGet(`zqx${'y'.repeat(98)}`, cookie), searchPost('z', cookie), post('/api/conversations/search', { q: ['zqx-array'] }, cookie), post('/api/conversations/search', {}, cookie)];
  for (const req of cases) {
    const res = await w.fetch(req, env, {});
    assert.equal(res.status, 400, req.url);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.ok(!(await res.text()).includes('zqx'), 'the error never repeats the query');
  }
  assert.ok(!kv.puts.some((p) => p.key.startsWith('search-rate:')), 'refused queries are not counted');
  assert.equal((await w.fetch(searchGet('zq', cookie), env, {})).status, 200, 'two characters is enough');
  assert.equal((await w.fetch(searchGet('z'.repeat(100), cookie), env, {})).status, 200, 'and 100 is the most');
});

test('the rate limit through the Worker: the 101st search of the day is a 429, and another account is unaffected', { skip }, async () => {
  const w = await loadWorker();
  const kv = fakeKV();
  const env = envWith(kv);
  const a = await member(kv, 'a@example.org');
  const b = await member(kv, 'b@example.org');
  await seed(kv, a.uid, uuid(1), [{ q: 'Trees?', a: 'I found trees.' }], at(1));
  for (let i = 0; i < SEARCH_DAILY; i++) assert.equal((await w.fetch(searchPost('trees', a.cookie), env, {})).status, 200, `search ${i + 1}`);
  const over = await w.fetch(searchPost('trees', a.cookie), env, {});
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('Cache-Control'), 'no-store');
  const body = await over.json();
  assert.equal(body.limit, 'search');
  assert.match(body.error, /100 times today/);
  assert.equal((await w.fetch(searchGet('trees', a.cookie), env, {})).status, 429, 'GET counts against the same limit');
  assert.equal((await w.fetch(searchPost('trees', b.cookie), env, {})).status, 200);
  assert.equal((await w.fetch(get('/api/conversations', a.cookie), env, {})).status, 200, 'browsing is not limited');
  // A counter write KV refuses (two searches within a second): a 429 that asks to wait, and nothing searched.
  const put = kv.put;
  kv.put = async (k, ...rest) => {
    if (k.startsWith('search-rate:')) throw new Error('KV PUT failed: 429 Too Many Requests');
    return put.call(kv, k, ...rest);
  };
  kv.gets.length = 0;
  const busy = await w.fetch(searchPost('trees', b.cookie), env, {});
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('Cache-Control'), 'no-store');
  assert.equal((await busy.json()).limit, 'busy');
  assert.ok(!kv.gets.some((k) => k.startsWith('conv:')), 'no conversation read');
  kv.put = put;
});

test('the query and the results are never logged, stored or cached, even when the search fails', { skip }, async () => {
  const w = await loadWorker();
  const kv = fakeKV();
  const env = envWith(kv);
  const { uid, cookie } = await member(kv);
  const Q = 'Zebrawood Lane';
  await seed(kv, uid, uuid(1), [{ q: `What is at 12 ${Q}?`, a: `I found a permit at 12 ${Q}.` }], at(1));
  const lines = [];
  const saved = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    saved[level] = console[level];
    console[level] = (...args) => lines.push(args.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  }
  const putsBefore = kv.puts.length;
  try {
    const ok = await w.fetch(searchPost(Q, cookie), env, {});
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).matches.length, 1);
    await w.fetch(searchGet(Q, cookie), env, {});
    await w.fetch(searchGet(`${Q}${'x'.repeat(200)}`, cookie), env, {});
    // A read that fails mid-search: a fixed log line and a 503 that names nothing.
    kv.fail = (k) => k.startsWith(`conv:${uid}:`);
    const failed = await w.fetch(searchPost(Q, cookie), env, {});
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('Cache-Control'), 'no-store');
    assert.ok(!(await failed.text()).toLowerCase().includes('zebrawood'));
    kv.fail = null;
  } finally {
    for (const level of Object.keys(saved)) console[level] = saved[level];
  }
  assert.deepEqual(lines, ['conversation search failed'], 'one fixed line, from the failure only');
  // Stored: the only writes are the counter, which holds a number.
  const writes = kv.puts.slice(putsBefore);
  assert.ok(writes.length > 0 && writes.every((p) => p.key.startsWith('search-rate:') && /^\d+$/.test(p.value)), JSON.stringify(writes.map((p) => p.key)));
  for (const [k, v] of kv.store) {
    if (k.startsWith('conv:')) continue; // the conversation itself, saved before
    assert.ok(!`${k} ${v.value}`.toLowerCase().includes('zebrawood'), k);
  }
});

// ---- The page ----

// The page's renderers, run as the page runs them (worker/chat-page.js is a
// classic script: its functions are pulled out of its text).
const pageRenderers = () => {
  const ui = readFileSync(new URL('../worker/chat-page.js', import.meta.url), 'utf8');
  const line = (mark) => {
    const i = ui.indexOf(mark);
    assert.ok(i >= 0, mark);
    return ui.slice(i, ui.indexOf('\n', i));
  };
  const block = (mark) => {
    const i = ui.indexOf(mark);
    assert.ok(i >= 0, mark);
    return ui.slice(i, ui.indexOf('\n}\n', i) + 2);
  };
  const src = [line('const esc = '), block('function renderRecent(list) {'), block('function renderMatches(list) {')].join('\n');
  return { ui, ...new Function(`${src}\nreturn { renderRecent, renderMatches };`)() };
};

test('page: titles and snippets are escaped, and the hit is marked with an escaped <mark>', () => {
  const { renderRecent, renderMatches } = pageRenderers();
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const list = renderRecent([{ id: `${uuid(1)}"><script>`, title: evil, turns: '<b>2</b>', updated: '2026-11-01T12:00:00.000Z<i>' }]);
  assert.ok(!/<img|<script|<b>|<i>/.test(list), list);
  assert.ok(list.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
  assert.ok(list.includes('0 questions'), 'a turn count that is not a number shows as 0');
  const snippet = '…before <script>alert(1)</script> Willow <b>Oak</b> after…';
  const s = snippet.indexOf('Willow');
  const html = renderMatches([{ id: uuid(1), title: evil, updated: '2026-11-01T12:00:00.000Z', turn: 2, field: 'answer', snippet, mark: [s, s + 'Willow <b>Oak</b>'.length] }]);
  assert.ok(!/<img|<script|<b>/.test(html), html);
  assert.ok(html.includes('<mark>Willow &lt;b&gt;Oak&lt;/b&gt;</mark>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes(`data-id="${uuid(1)}" data-turn="2"`));
  assert.ok(html.includes('2026-11-01 · in an answer'));
  // A mark out of range, or not numbers, marks nothing (and still escapes).
  for (const mark of [[5, 999], [-1, 3], [3, 3], ['0', '2'], null]) {
    const h = renderMatches([{ id: uuid(1), title: 't', updated: '', turn: 'x', field: 'question', snippet: '<i>abc</i>', mark }]);
    assert.ok(!h.includes('<mark>') && h.includes('&lt;i&gt;abc&lt;/i&gt;') && h.includes('data-turn=""') && h.includes('in a question'), JSON.stringify(mark));
  }
});

test('page: the query goes in a POST body, the box keeps no history, and the panel keeps Forget all and gains Show more', () => {
  const ui = readFileSync(new URL('../worker/chat-page.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../worker/ui.html', import.meta.url), 'utf8');
  assert.match(ui, /postJson\('api\/conversations\/search', \{ q: \$\('#conv-q'\)\.value \}\)/);
  assert.ok(!/conversations\/search\?/.test(ui), 'the page never puts the query in a URL');
  assert.match(ui, /api\/conversations\?cursor=\$\{encodeURIComponent\(recentNext\)\}/);
  assert.match(html, /<form id="conv-search" class="convsearch" role="search" autocomplete="off">/);
  assert.match(html, /<input id="conv-q"[^>]*minlength="2" maxlength="100"[^>]*autocomplete="off">/);
  assert.match(html, /<button type="button" id="conv-more" hidden>Show more<\/button>/);
  assert.match(html, /<button type="button" id="conv-forget-all" class="textbtn">Forget all my conversations<\/button>/);
  // Everything sits inside the panel that only a signed-in member sees.
  const panel = html.slice(html.indexOf('<div class="convbar" id="convbar" hidden>'), html.indexOf('<main id="log"'));
  for (const id of ['conv-search', 'conv-q', 'conv-results', 'conv-list', 'conv-more', 'conv-forget-all']) assert.ok(panel.includes(`id="${id}"`), id);
  assert.ok(!/\son[a-z]+=/i.test(panel) && !/\sstyle=/.test(panel), 'no inline handler or style');
});
