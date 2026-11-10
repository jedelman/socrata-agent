// The free tier's instant takedowns (docs/free-tier.md, "Deletions as they
// happen"): the QuestionWatcher Durable Object, driven with a fake
// WebSocket, a fake clock, fake Durable Object storage, the fake atproto
// network and a D1 over node:sqlite. A delete event only names a record to
// look at: the PDS decides. Every fetch is counted, nothing logged names a
// DID, and with the flag off the object does nothing but close.
// Shared modules are imported statically, above the Worker's text hook
// (the Node 24 note in worker/index.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  QuestionWatcher, readFrame, subscribeUrl, jetstreamOrigins, micros, pingQuestionWatcher, WATCHER_NAME, SUBSCRIBE_PATH, DEFAULT_JETSTREAM_URL,
  TICK_MS, CURSOR_SAVE_MS, REWIND_US, MAX_REPLAY_MS, BACKOFF_MIN_MS, BACKOFF_MAX_MS, STABLE_MS, IDLE_RECYCLE_MS, CHECKS_PER_MINUTE,
  QUEUE_MAX, COOLDOWN_MS, MAX_FRAME_CHARS, PER_DID_PER_MINUTE, LOOKUPS_PER_MINUTE, UPGRADE_TIMEOUT_MS, CONNECT_STALE_MS, BLOCKED_AFTER, BLOCKED_BACKOFF_MS,
  DOWN_LOG_MS, NOT_HELD_MEMO_MS,
} from '../worker/question-watcher.js';
import { QUESTION_NSID } from '../worker/endorse-config.js';
import { CHECK_BUDGET, takedownIfGone } from '../worker/public-ask.js';
import { heldByUris, HELD_BATCH } from '../worker/questions.js';
import { requestBudget } from '../src/request-budget.js';
import { W, fakeLimiter, didDoc } from './fake-atproto.js';
import { fakeD1, hasSqlite } from './fake-d1.js';
import { NOW, BOB, CAROL, threads } from './public-ask-world.js';

const skip = !hasSqlite && 'node:sqlite is missing';
const EAST = 'jetstream.us-east.bsky.network';
const WEST = 'jetstream.us-west.bsky.network';
const LEX = 'network.bsky.jetstream.subscribeEvents';

/** A WebSocket as a Worker's fetch() hands one back: accept(), listeners, close(). It records anything sent (nothing should be). */
class FakeSocket {
  constructor(host) {
    this.host = host;
    this.listeners = {};
    this.accepted = false;
    this.closed = null;
    this.sent = [];
  }
  accept() {
    this.accepted = true;
    this.readyState = 1;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  emit(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  frame(obj) {
    this.emit('message', { data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  /** The far end goes away. */
  drop() {
    this.readyState = 3;
    this.emit('close', { code: 1006 });
  }
}

/** Both Jetstream instances on the fake network: each upgrade request gets a FakeSocket, or a 503 while that host is `down`. */
function jetstream(w) {
  const js = { sockets: [], urls: [], down: new Set() };
  for (const host of [EAST, WEST]) {
    w.net.routes[`${host}${SUBSCRIBE_PATH}`] = (u, init) => {
      js.urls.push(u);
      if (js.down.has(host)) return new Response('unavailable', { status: 503 });
      assert.equal(init.headers?.Upgrade, 'websocket');
      const s = new FakeSocket(host);
      js.sockets.push(s);
      return { status: 101, webSocket: s, body: null };
    };
  }
  js.last = () => js.sockets.at(-1);
  return js;
}

/** Durable Object storage: the cursor and the one alarm, with an op log. */
function fakeState() {
  const st = { store: new Map(), ops: [], alarm: null };
  st.storage = {
    async get(k) {
      st.ops.push(['get', k]);
      return st.store.get(k);
    },
    async put(k, v) {
      st.ops.push(['put', k, v]);
      st.store.set(k, v);
    },
    async getAlarm() {
      return st.alarm;
    },
    async setAlarm(t) {
      st.ops.push(['setAlarm', Number(t)]);
      st.alarm = Number(t);
    },
    async deleteAlarm() {
      st.ops.push(['deleteAlarm']);
      st.alarm = null;
    },
  };
  return st;
}

function watch(w, { env = w.env, state = fakeState() } = {}) {
  const js = jetstream(w);
  const watcher = new QuestionWatcher(state, env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  return { state, js, watcher };
}
const ping = (watcher) => watcher.fetch(new Request('https://question-watcher/ping', { method: 'POST' }));

// Frames as Jetstream v2 sends them (lexicons/network/bsky/jetstream/subscribeEvents.json).
const iso = (ms, us = 0) => new Date(ms).toISOString().replace('Z', `${String(us).padStart(3, '0')}Z`);
function commit({ did = W.DID, rkey, operation = 'delete', collection = QUESTION_NSID, at = NOW, us = 0 }) {
  return {
    $type: 'message',
    payload: {
      $type: `${LEX}#commit`, did, seq: 7, time: iso(at, us), witnessedAt: iso(at, us), rev: '3kaaaaaaaaaaa', operation, collection, rkey,
      ...(operation === 'delete' ? {} : { cid: 'bafyreiaaaaaaaa', record: { $type: collection, text: 'x', city: 'norfolk', createdAt: iso(at) } }),
    },
  };
}
const deleteOf = (rec, at = NOW) => commit({ did: rec.uri.split('/')[2], rkey: rec.rkey, at });
const writes = (db, from = 0) => db.log.slice(from).filter((e) => /^\s*(INSERT|UPDATE|DELETE)/i.test(e.sql));
const status = (w, id) => w.env.SIREN_DB.rows().find((r) => r.id === id)?.status;

/** console.log, .error and .warn captured while `fn` runs. */
async function capture(fn) {
  const lines = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(real)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, real);
  }
  return lines;
}

test('a delete for a held answered question withdraws it once its PDS confirms, through the withdraw path: row emptied, replies kept, references rewritten', { skip }, async () => {
  const w = threads();
  const root = await w.q('Alice asks: what is at 810 Union St?');
  const reply = await w.q('Bob follows up?', { did: BOB, on: root });
  const { watcher, js } = watch(w);
  const res = await ping(watcher);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual({ ...body, stats: undefined }, { connected: true, host: EAST, failures: 0, queued: 0, stats: undefined });
  assert.equal(body.stats.connects, 1);
  assert.equal(js.sockets.length, 1);
  assert.ok(js.last().accepted, 'accept()ed, to be handled here');
  w.del(root); // deleted in Alice's own account, not on Siren's page
  const calls = w.net.calls.length;
  js.last().frame(deleteOf(root));
  await watcher.settled();
  const row = w.env.SIREN_DB.rows().find((r) => r.id === root.id);
  assert.equal(row.status, 'withdrawn');
  for (const col of ['question_uri', 'question_cid', 'did', 'handle', 'city', 'question', 'answer', 'record', 'tools']) assert.equal(row[col], null, col);
  const kept = w.env.SIREN_DB.rows().find((r) => r.id === reply.id);
  assert.deepEqual([kept.status, kept.root_uri, kept.parent_uri], ['answered', `withdrawn:${root.id}`, `withdrawn:${root.id}`]);
  // The check: the DID document, then getRecord on the PDS it names. Nothing else.
  const made = w.net.calls.slice(calls).map((c) => new URL(c.url));
  assert.deepEqual(made.map((u) => `${u.host}${u.pathname}`), [`plc.fixture.dev/${W.DID}`, 'pds.fixture.dev/xrpc/com.atproto.repo.getRecord']);
  assert.equal(made[1].searchParams.get('repo'), W.DID);
  assert.equal(made[1].searchParams.get('rkey'), root.rkey);
  assert.equal(watcher.stats.withdrawn, 1);
  // Off the list and its page at once, with no page opened and no sweep run.
  assert.deepEqual((await w.list()).body.questions, []);
  assert.equal((await w.one(root.id)).body.withdrawn, true);
  assert.deepEqual(js.last().sent, [], 'the watcher never sends (any client frame closes a v2 stream)');
  // The next minute's tick logs the last minute's counts, and only counts.
  w.clock.t = NOW + TICK_MS;
  const lines = await capture(() => watcher.alarm());
  assert.deepEqual(lines, ['question watcher: last minute, 1 taken down, 0 still present, 0 couldn\'t be checked, 0 not held here, 0 left for the sweep']);
  const quiet = await capture(async () => {
    w.clock.t += TICK_MS;
    await watcher.alarm();
  });
  assert.deepEqual(quiet, [], 'a quiet minute logs nothing');
});

test('an event the PDS contradicts changes nothing: the record is still there, so no D1 write; a replayed event is not checked again', { skip }, async () => {
  const w = threads();
  const q = await w.q('Still here?');
  const { watcher, js } = watch(w);
  await ping(watcher);
  const from = w.env.SIREN_DB.log.length;
  const before = w.net.calls.length;
  // A forged or mistaken delete: the record is in its repo.
  for (let i = 0; i < 3; i++) js.last().frame(deleteOf(q));
  await watcher.settled();
  assert.equal(status(w, q.id), 'answered');
  assert.deepEqual(writes(w.env.SIREN_DB, from), [], 'no D1 write');
  assert.equal(watcher.stats.present, 1);
  assert.equal(w.net.calls.slice(before).filter((c) => c.url.includes('getRecord')).length, 1, 're-delivered events within the cooldown cost nothing');
  // After the cooldown, an event for it is checked again (still present: still nothing).
  w.clock.t += COOLDOWN_MS;
  js.last().frame(deleteOf(q, w.clock.t));
  await watcher.settled();
  assert.equal(watcher.stats.present, 2);
  assert.deepEqual(writes(w.env.SIREN_DB, from), []);
});

test('an unreachable PDS (or DID directory) changes nothing: "couldn\'t check", no D1 write', { skip }, async () => {
  for (const down of ['pds.fixture.dev/xrpc/com.atproto.repo.getRecord', `plc.fixture.dev/${W.DID}`]) {
    const w = threads();
    const q = await w.q('Kept?');
    const { watcher, js } = watch(w);
    await ping(watcher);
    w.del(q);
    w.net.routes[down] = () => new Response('down', { status: 503 });
    const from = w.env.SIREN_DB.log.length;
    js.last().frame(deleteOf(q));
    await watcher.settled();
    assert.equal(status(w, q.id), 'answered', down);
    assert.deepEqual(writes(w.env.SIREN_DB, from), [], down);
    assert.equal(watcher.stats.unknown, 1, down);
  }
});

test('deletions of records Siren doesn\'t hold cost one batched read and no write; creates and updates cost nothing at all', { skip }, async () => {
  const w = threads();
  const q = await w.q('Mine?');
  const gone = await w.q('Withdrawn already?');
  await w.remove(gone);
  const { watcher, js } = watch(w);
  await ping(watcher);
  const from = w.env.SIREN_DB.log.length;
  const before = w.net.calls.length;
  // Creates and updates, ours and anyone's: ignored, no D1 statement at all.
  js.last().frame(commit({ rkey: q.rkey, operation: 'create' }));
  js.last().frame(commit({ rkey: q.rkey, operation: 'update' }));
  js.last().frame(commit({ did: CAROL, rkey: '3kzzzzzzzzzzz', operation: 'create' }));
  await watcher.settled();
  assert.equal(w.env.SIREN_DB.log.length, from, 'no D1 statement for a create or an update');
  // Deletes for records never asked here, and for one already withdrawn (its URI is gone from D1).
  const unheld = ['3kzzzzzzzzzza', '3kzzzzzzzzzzb', '3kzzzzzzzzzzc'].map((rkey) => commit({ did: CAROL, rkey }));
  for (const f of [...unheld, deleteOf(gone)]) js.last().frame(f);
  await watcher.settled();
  const stmts = w.env.SIREN_DB.log.slice(from);
  assert.ok(stmts.length >= 1 && stmts.length <= 2, `batched: ${stmts.length} statements`);
  assert.ok(stmts.every((e) => /^SELECT id, question_uri, status FROM public_questions WHERE question_uri IN \(/.test(e.sql)), 'reads only');
  assert.deepEqual(writes(w.env.SIREN_DB, from), []);
  assert.equal(watcher.stats.notHeld, 4);
  assert.equal(w.net.calls.length, before, 'no PDS asked about a record Siren doesn\'t hold');
  assert.equal(status(w, q.id), 'answered');
  // Other collections and malformed deletes never reach D1.
  const from2 = w.env.SIREN_DB.log.length;
  js.last().frame(commit({ rkey: q.rkey, collection: 'app.bsky.feed.post' }));
  js.last().frame(commit({ did: 'did:example:nope', rkey: q.rkey }));
  js.last().frame(commit({ rkey: 'self' }));
  js.last().frame({ $type: 'message', payload: { $type: `${LEX}#identity`, did: W.DID, seq: 9, time: iso(NOW) } });
  await watcher.settled();
  assert.equal(w.env.SIREN_DB.log.length, from2);
});

test('hidden questions and claims still being answered are taken down too; the steward\'s hidden one is withdrawn, not shown again', { skip }, async () => {
  const w = threads();
  const hidden = await w.q('Hidden by the steward?');
  w.env.SIREN_DB.db.prepare("UPDATE public_questions SET status = 'hidden' WHERE id = ?").run(hidden.id);
  let during = null;
  const { watcher, js } = watch(w);
  await ping(watcher);
  w.del(hidden);
  js.last().frame(deleteOf(hidden));
  await watcher.settled();
  assert.equal(status(w, hidden.id), 'withdrawn');
  // Deleted while Siren is still answering it: the claim is withdrawn, and the answer keeps nothing.
  w.duringAnswer = async () => {
    w.duringAnswer = null;
    const row = w.env.SIREN_DB.rows().find((r) => r.status === 'answering');
    during = row;
    w.net.state.repos.get(W.DID).get(QUESTION_NSID).delete(row.question_uri.split('/').pop());
    js.last().frame(commit({ rkey: row.question_uri.split('/').pop(), at: w.clock.t }));
    await watcher.settled();
  };
  const rec = w.record({ text: 'Deleted mid-answer?' });
  const out = await w.ask({ uri: rec.uri, cid: rec.cid });
  assert.equal(out.status, 410);
  assert.equal(out.body.code, 'withdrawn_meanwhile');
  assert.equal(status(w, during.id), 'withdrawn');
});

test('the cursor: the newest witnessed time, saved at most every five seconds, never past Siren\'s clock; a reconnect resumes a minute before it, at most a day back', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const { watcher, js } = watch(w, { state });
  await ping(watcher);
  // The first connection starts at the live tip, and listening starts the cursor.
  assert.equal(js.urls[0].searchParams.get('cursor'), null);
  assert.deepEqual(js.urls[0].searchParams.getAll('kinds'), ['commit']);
  assert.deepEqual(js.urls[0].searchParams.getAll('collections'), [QUESTION_NSID]);
  assert.equal(watcher.cursor, NOW * 1000);
  const puts = () => state.ops.filter((o) => o[0] === 'put');
  // Events a second apart: the cursor follows each, storage at most every five seconds.
  // (Each witnessed a millisecond before Siren's clock reads it.)
  for (let i = 1; i <= 12; i++) {
    w.clock.t = NOW + i * 1000;
    js.last().frame(commit({ rkey: '3kaaaaaaaaaab', operation: 'create', at: w.clock.t - 1, us: 250 }));
  }
  await watcher.settled();
  const t = (i) => (NOW + i * 1000 - 1) * 1000 + 250;
  assert.equal(watcher.cursor, t(12), 'microseconds kept');
  // (The first is the ping's: listening started at NOW.)
  assert.deepEqual(puts().map((o) => o[2]), [NOW * 1000, t(5), t(10)]);
  // A time from the future moves the cursor only to Siren's clock.
  js.last().frame(commit({ rkey: '3kaaaaaaaaaab', operation: 'create', at: w.clock.t + 3600e3 }));
  assert.equal(watcher.cursor, w.clock.t * 1000);
  // The stream drops: the close saves the cursor, and the reconnect resumes five seconds before it.
  const saved = watcher.cursor;
  js.last().drop();
  await watcher.settled();
  assert.equal(state.store.get('cursor'), saved);
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.sockets.length, 2);
  assert.equal(Number(js.urls[1].searchParams.get('cursor')), saved - REWIND_US);
  // A new instance (after an eviction or a deploy) resumes from storage.
  const fresh = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  await ping(fresh);
  assert.equal(Number(js.urls[2].searchParams.get('cursor')), saved - REWIND_US);
  // Thirty hours later, the replay goes back a day at most (Jetstream keeps 36 hours): older deletions are the sweep's.
  w.clock.t += 30 * 3600e3;
  const later = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  await ping(later);
  assert.equal(Number(js.urls[3].searchParams.get('cursor')), (w.clock.t - MAX_REPLAY_MS) * 1000);
  assert.equal(MAX_REPLAY_MS, 24 * 3600e3);
  // The rewind covers instances witnessing the same event about a second apart, with room to spare.
  assert.equal(REWIND_US, 60e6);
});

test('backoff and failover: a failed connect moves to the other instance; drops back off, doubling to the cap; a stable session starts the backoff again', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const { watcher, js } = watch(w, { state });
  js.down.add(EAST);
  await ping(watcher);
  assert.deepEqual(js.urls.map((u) => u.host), [EAST]);
  assert.equal(js.sockets.length, 0);
  assert.equal(state.alarm, NOW + BACKOFF_MIN_MS, 'the alarm is set for the retry');
  // Nothing happens before it's due.
  w.clock.t = NOW + BACKOFF_MIN_MS - 1;
  await watcher.alarm();
  assert.equal(js.urls.length, 1);
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.deepEqual(js.urls.map((u) => u.host), [EAST, WEST], 'failed over');
  assert.equal(js.last().host, WEST);
  // Two quick drops: the same instance, 2 s then 4 s.
  w.clock.t += 10e3;
  js.last().drop();
  assert.equal(state.alarm, w.clock.t + 2 * BACKOFF_MIN_MS);
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.last().host, WEST);
  w.clock.t += 10e3;
  js.last().drop();
  // The third failure in a row moves on.
  assert.equal(state.alarm, w.clock.t + 4 * BACKOFF_MIN_MS);
  w.clock.t = state.alarm;
  js.down.delete(EAST);
  await watcher.alarm();
  assert.equal(js.last().host, EAST);
  // A session that lasted resets the backoff: the next retry is a second away.
  w.clock.t += STABLE_MS;
  js.last().drop();
  assert.equal(state.alarm, w.clock.t + BACKOFF_MIN_MS);
  assert.equal(watcher.failures, 1);
  // Both down for a while: the wait doubles to the cap, alternating instances.
  js.down.add(EAST);
  js.down.add(WEST);
  const waits = [];
  for (let i = 0; i < 8; i++) {
    w.clock.t = state.alarm;
    await watcher.alarm();
    waits.push(state.alarm - w.clock.t);
  }
  assert.deepEqual(waits, [2e3, 4e3, 8e3, 16e3, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
  const tried = js.urls.slice(-8).map((u) => u.host);
  assert.ok(tried.includes(EAST) && tried.includes(WEST), 'both instances tried');
  // Jitter stays within a quarter either way.
  const j = new QuestionWatcher(fakeState(), w.env, { now: () => NOW, random: () => 0 });
  j.failed({ rotate: true });
  assert.equal(j.nextAttemptAt, NOW + 0.75 * BACKOFF_MIN_MS);
});

test('the alarm: every minute it checks the socket and reconnects a dropped one; a silent socket is recycled; an error frame ends the session', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const { watcher, js } = watch(w, { state });
  await ping(watcher);
  assert.equal(state.alarm, NOW + TICK_MS);
  // Connected: the alarm only re-arms.
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.sockets.length, 1);
  assert.equal(state.alarm, w.clock.t + TICK_MS);
  // The socket closes with no close event reaching us in time: say the
  // close event's reconnect was lost. The next alarm reconnects.
  watcher.ws = null;
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.sockets.length, 2);
  // No frame for half an hour: closed by us and opened again on the next tick.
  w.clock.t += IDLE_RECYCLE_MS;
  await watcher.alarm();
  assert.equal(js.sockets.length, 3);
  assert.deepEqual(js.sockets[1].closed, { code: 1000, reason: 'idle' });
  // An error frame: the stream is over; closed, and retried on the other instance after the backoff.
  const lines = await capture(async () => {
    js.last().frame({ $type: 'error', error: 'ConsumerTooSlow', message: 'text from far away' });
    js.last().frame({ $type: 'message', payload: { $type: `${LEX}#info`, name: 'OutdatedCursor', message: 'did:plc:zzzz text' } });
  });
  assert.deepEqual(js.sockets[2].closed, { code: 1000, reason: 'error' });
  assert.equal(watcher.ws, null);
  assert.ok(lines.some((l) => l.includes('(ConsumerTooSlow)')));
  assert.ok(!lines.some((l) => l.includes('text from far away')), 'no remote text in the log');
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.last().host, WEST);
  // A throwing alarm would be retried and then dropped: this one never throws, and re-arms.
  state.storage.get = async () => {
    throw new Error('storage unavailable');
  };
  const fresh = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  const errs = await capture(() => fresh.alarm());
  assert.equal(state.alarm, w.clock.t + TICK_MS);
  assert.ok(errs.some((l) => l.includes('alarm failed')));
});

test('flag off or not ready: the object does nothing but close its socket and delete its alarm: no fetch, no D1, no cursor', { skip }, async () => {
  for (const over of [{ PUBLIC_ASK: undefined }, { PUBLIC_ASK: 'false' }, { BLUESKY_LOGIN: undefined }, { INVITE_REQUIRED: undefined }]) {
    const w = threads();
    const state = fakeState();
    const { watcher, js } = watch(w, { state });
    await ping(watcher);
    const sock = js.last();
    sock.frame(commit({ rkey: '3kaaaaaaaaaab', operation: 'create', at: NOW }));
    // The flag goes off (a later deploy); the old alarm wakes the object.
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete w.env[k];
      else w.env[k] = v;
    }
    const calls = w.net.calls.length;
    const d1 = w.env.SIREN_DB.log.length;
    const ops = state.ops.length;
    await watcher.alarm();
    assert.deepEqual(sock.closed, { code: 1000, reason: 'off' }, JSON.stringify(over));
    assert.equal(state.alarm, null);
    assert.deepEqual(state.ops.slice(ops), [['deleteAlarm']], 'nothing else: no cursor read or write');
    // A ping too (nothing sends one with the flag off; if one came).
    const res = await ping(watcher);
    assert.equal(res.status, 204);
    assert.equal(w.net.calls.length, calls);
    assert.equal(w.env.SIREN_DB.log.length, d1);
    // A late frame on the closed socket does nothing.
    sock.frame(commit({ rkey: '3kaaaaaaaaaab' }));
    await watcher.settled();
    assert.equal(w.env.SIREN_DB.log.length, d1);
  }
  // Never started with the flag off: the same.
  const w = threads({ env: { PUBLIC_ASK: undefined } });
  const state = fakeState();
  const { watcher } = watch(w, { state });
  assert.equal((await ping(watcher)).status, 204);
  assert.deepEqual(state.ops, [['deleteAlarm']]);
  assert.equal(w.net.calls.length, 0);
});

test('every fetch is counted: the upgrade and each check go through a budget (CHECK_BUDGET a check), and the real network is never touched', { skip }, async () => {
  const w = threads();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('the real network was asked');
  };
  try {
    const qs = [];
    for (let i = 0; i < 3; i++) qs.push(await w.q(`Counted ${i}?`));
    const start = w.net.calls.length;
    const state = fakeState();
    const { watcher, js } = watch(w, { state });
    js.down.add(EAST);
    await ping(watcher); // one failed upgrade
    w.clock.t = state.alarm;
    await watcher.alarm(); // one good one
    w.del(qs[0]);
    w.del(qs[1]);
    for (const q of qs) js.last().frame(deleteOf(q, w.clock.t));
    await watcher.settled();
    assert.deepEqual(qs.map((q) => status(w, q.id)), ['withdrawn', 'withdrawn', 'answered']);
    assert.equal(w.net.calls.length - start, watcher.stats.fetches, 'every call the network saw was counted');
    assert.equal(watcher.stats.fetches, 2 + 3 * 2);
  } finally {
    globalThis.fetch = realFetch;
  }
  // One check can't pass its budget, whatever the PDS does (a redirect chain here).
  const v = threads();
  const q = await v.q('Redirects?');
  v.del(q);
  v.net.routes['pds.fixture.dev/xrpc/com.atproto.repo.getRecord'] = () => new Response(null, { status: 302, headers: { Location: 'https://pds.fixture.dev/xrpc/com.atproto.repo.getRecord?again=1' } });
  const budget = requestBudget({ limit: CHECK_BUDGET, fetchImpl: v.net.fetch });
  assert.equal(await takedownIfGone(v.env, { id: q.id, question_uri: q.uri }, budget), 'unknown');
  assert.ok(budget.used <= CHECK_BUDGET);
  assert.equal(status(v, q.id), 'answered');
});

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
const b32 = (i, n) => [...i.toString(32).padStart(n, '0')].map((c) => S32[parseInt(c, 32)]).join('');
const rkeyN = (i) => `3k${b32(i, 11)}`;
const didN = (i) => `did:plc:${b32(i, 24)}`;

test('bounds: one DID\'s deletions a minute, the queue, D1 lookups a minute and checks a minute are capped; only held questions count against the checks; behind the site breaker; long frames skipped unread', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const { watcher, js } = watch(w, { state });
  await ping(watcher);
  // One account deleting a burst in this collection: its share a minute is taken, the rest are the sweep's, unread.
  let from = w.env.SIREN_DB.log.length;
  for (let i = 0; i < PER_DID_PER_MINUTE + 10; i++) js.last().frame(commit({ did: CAROL, rkey: rkeyN(100000 + i) }));
  await watcher.settled();
  assert.equal(watcher.stats.notHeld, PER_DID_PER_MINUTE);
  assert.equal(watcher.stats.leftForSweep, 10);
  assert.ok(w.env.SIREN_DB.log.length - from <= 2, 'batched: the first alone (it starts the drain), the rest together');
  assert.deepEqual(writes(w.env.SIREN_DB, from), []);
  // Many accounts at once: LOOKUPS_PER_MINUTE statements of HELD_BATCH this minute, the rest the next minute.
  w.clock.t = state.alarm;
  await watcher.alarm();
  from = w.env.SIREN_DB.log.length;
  const total = (LOOKUPS_PER_MINUTE + 2) * HELD_BATCH;
  for (let i = 0; i < total; i++) js.last().frame(commit({ did: didN(Math.floor(i / PER_DID_PER_MINUTE)), rkey: rkeyN(200000 + i) }));
  await watcher.settled();
  const reads = w.env.SIREN_DB.log.slice(from);
  assert.equal(reads.length, LOOKUPS_PER_MINUTE);
  assert.ok(reads.every((e) => e.params.length <= HELD_BATCH));
  const looked = reads.reduce((n, e) => n + e.params.length, 0);
  assert.ok(looked > (LOOKUPS_PER_MINUTE - 1) * HELD_BATCH - HELD_BATCH);
  assert.equal(watcher.queue.size, total - looked, 'the rest wait, still holding the cursor');
  assert.ok(watcher.safeCursor() <= NOW * 1000, 'the saved cursor waits for them');
  w.clock.t = state.alarm;
  await watcher.alarm();
  await watcher.settled();
  assert.equal(watcher.queue.size, 0, 'looked up the next minute');
  assert.deepEqual(writes(w.env.SIREN_DB, from), []);
  // Not looked up again when a replay re-delivers them.
  const reread = w.env.SIREN_DB.log.length;
  js.last().frame(commit({ did: didN(0), rkey: rkeyN(200000) }));
  await watcher.settled();
  assert.equal(w.env.SIREN_DB.log.length, reread);
  assert.ok(NOT_HELD_MEMO_MS >= MAX_REPLAY_MS);
  // The queue's own cap: nothing past QUEUE_MAX waits at once.
  const q = new QuestionWatcher(fakeState(), w.env, { now: () => w.clock.t });
  q.pump = Promise.resolve(); // nothing drains
  for (let i = 0; i < QUEUE_MAX + 5; i++) q.take({ uri: `at://${didN(i)}/${QUESTION_NSID}/${rkeyN(300000 + i)}`, did: didN(i), at: NOW * 1000 }, w.clock.t);
  assert.equal(q.queue.size, QUEUE_MAX);
  assert.equal(q.stats.leftForSweep, 5);
  // A new minute: CHECKS_PER_MINUTE held deletions checked now, the rest on the next tick.
  w.clock.t = state.alarm;
  await watcher.alarm();
  const qs = [];
  for (let i = 0; i < CHECKS_PER_MINUTE + 3; i++) qs.push(await w.q(`Held ${i}?`, { did: [W.DID, BOB, CAROL][i % 3] }));
  for (const x of qs) w.del(x);
  for (const x of qs) js.last().frame(deleteOf(x, w.clock.t));
  await watcher.settled();
  assert.equal(watcher.stats.withdrawn, CHECKS_PER_MINUTE);
  assert.equal(qs.filter((x) => status(w, x.id) === 'answered').length, 3);
  w.clock.t = state.alarm;
  await watcher.alarm();
  await watcher.settled();
  assert.ok(qs.every((x) => status(w, x.id) === 'withdrawn'), 'the rest on the next minute');
  // The site breaker refuses: no fetch, left for the sweep.
  const b = threads();
  const bq = await b.q('Behind the breaker?');
  b.del(bq);
  b.env.BSKY_SITE_RL = { limit: async ({ key }) => ({ success: key !== 'takedown' }) };
  const bw = watch(b);
  await ping(bw.watcher);
  const calls = b.net.calls.length;
  bw.js.last().frame(deleteOf(bq));
  await bw.watcher.settled();
  assert.equal(b.net.calls.length, calls);
  assert.equal(status(b, bq.id), 'answered');
  assert.equal(bw.watcher.stats.leftForSweep, 1);
  // A frame over the cap is skipped before it's parsed.
  assert.deepEqual(readFrame(`${JSON.stringify(commit({ rkey: '3kaaaaaaaaaab' })).slice(0, -1)}, "pad": "${'x'.repeat(MAX_FRAME_CHARS)}"}`), { kind: 'skip' });
});

test('privacy: nothing logged names a DID, whatever happens (connects, drops, takedowns, contradictions, failures)', { skip }, async () => {
  const w = threads();
  const lines = await capture(async () => {
    const a = await w.q('Alice asks?');
    const b = await w.q('Bob asks?', { did: BOB });
    const c = await w.q('Carol asks?', { did: CAROL });
    const state = fakeState();
    const { watcher, js } = watch(w, { state });
    js.down.add(EAST);
    await ping(watcher);
    w.clock.t = state.alarm;
    await watcher.alarm();
    w.del(a);
    w.net.routes['pds.fixture.dev/xrpc/com.atproto.repo.getRecord'] = (u) => {
      if (u.searchParams.get('repo') === CAROL) return new Response('down', { status: 503 });
      const rec = w.net.state.repos.get(u.searchParams.get('repo'))?.get(u.searchParams.get('collection'))?.get(u.searchParams.get('rkey'));
      return rec ? Response.json({ uri: 'x', cid: w.net.state.cidOf(rec), value: rec }) : Response.json({ error: 'RecordNotFound' }, { status: 400 });
    };
    for (const q of [a, b, c]) js.last().frame(deleteOf(q, w.clock.t));
    js.last().frame(commit({ did: 'did:plc:dddddddddddddddddddddddd', rkey: '3kaaaaaaaaaab' }));
    js.last().frame('not json');
    await watcher.settled();
    w.env.SIREN_DB.fail = true; // D1 down: logged, without the DID it was asked about
    js.last().frame(commit({ did: BOB, rkey: '3kaaaaaaaaaac' }));
    await watcher.settled();
    w.env.SIREN_DB.fail = false;
    js.last().drop();
    w.clock.t = state.alarm;
    await watcher.alarm();
    js.last().frame({ $type: 'error', error: 'ConsumerTooSlow' });
    assert.equal(status(w, a.id), 'withdrawn');
  });
  assert.ok(lines.length >= 5, `logged: ${lines.length}`);
  assert.deepEqual(lines.filter((l) => /did:[a-z]+:/.test(l)), [], 'no DID in any log line');
  assert.ok(!lines.some((l) => /alice|bob|carol/i.test(l)), 'no handle either');
});

test('JETSTREAM_URL: the default pair, a list of wss:// origins, a local instance; anything else turns the watcher off (logged), and the sweep is untouched', { skip }, async () => {
  assert.deepEqual(jetstreamOrigins({}), [`https://${EAST}`, `https://${WEST}`]);
  assert.equal(DEFAULT_JETSTREAM_URL, `wss://${EAST},wss://${WEST}`);
  assert.deepEqual(jetstreamOrigins({ JETSTREAM_URL: 'wss://js.example.org/' }), ['https://js.example.org']);
  assert.deepEqual(jetstreamOrigins({ JETSTREAM_URL: ' wss://a.example.org , wss://b.example.org ' }), ['https://a.example.org', 'https://b.example.org']);
  assert.deepEqual(jetstreamOrigins({ JETSTREAM_URL: 'ws://127.0.0.1:6008' }), ['http://127.0.0.1:6008']);
  for (const bad of ['https://js.example.org', 'wss://js.example.org/subscribe', 'wss://js.example.org:8443', 'ws://js.example.org', 'wss://user@js.example.org', 'wss://10.0.0.1', 'ws://localhost:6008', 'wss://a.example.org,nope', 'wss://a.x.org,wss://b.x.org,wss://c.x.org,wss://d.x.org,wss://e.x.org']) {
    assert.equal(jetstreamOrigins({ JETSTREAM_URL: bad }), null, bad);
  }
  assert.equal(subscribeUrl('https://js.example.org', 1794344631402123), `https://js.example.org${SUBSCRIBE_PATH}?kinds=commit&collections=${QUESTION_NSID}&cursor=1794344631402123`);
  assert.equal(subscribeUrl('https://js.example.org', 12), `https://js.example.org${SUBSCRIBE_PATH}?kinds=commit&collections=${QUESTION_NSID}`, 'never a cursor Jetstream would read as a seq');
  const w = threads({ env: { JETSTREAM_URL: 'https://wrong.example.org' } });
  const state = fakeState();
  const { watcher } = watch(w, { state });
  const lines = await capture(() => ping(watcher));
  assert.equal(w.net.calls.length, 0);
  assert.equal(state.alarm, null);
  assert.ok(lines.some((l) => l.includes('JETSTREAM_URL is not a list of wss:// origins')));
});

test('frames: v2 deletes in the question collection by a supported DID with a TID key, witnessed times to the microsecond; anything else is ignored', () => {
  assert.deepEqual(readFrame(JSON.stringify(commit({ rkey: '3kaaaaaaaaaab', us: 789 }))), { kind: 'delete', uri: `at://${W.DID}/${QUESTION_NSID}/3kaaaaaaaaaab`, did: W.DID, at: NOW * 1000 + 789 });
  assert.equal(micros('2026-11-10T15:00:00.123456Z'), Date.parse('2026-11-10T15:00:00Z') * 1000 + 123456);
  assert.equal(micros('2026-11-10T10:00:00.5-05:00'), Date.parse('2026-11-10T15:00:00Z') * 1000 + 500000);
  assert.equal(micros('2026-11-10T15:00:00Z'), Date.parse('2026-11-10T15:00:00Z') * 1000);
  for (const bad of [null, 5, '', 'yesterday', '2026-11-10', '1970-01-01T00:00:00Z']) assert.equal(micros(bad), null, String(bad));
  // witnessedAt is the resume position; time is the fallback.
  const f = commit({ rkey: '3kaaaaaaaaaab' });
  delete f.payload.witnessedAt;
  assert.equal(readFrame(JSON.stringify(f)).at, NOW * 1000);
  assert.deepEqual(readFrame(JSON.stringify(commit({ rkey: '3kaaaaaaaaaab', operation: 'create' }))), { kind: 'other', at: NOW * 1000 });
  for (const data of ['', 'nope', '[]', 'null', '{}', JSON.stringify({ $type: 'message' }), new ArrayBuffer(4), undefined]) assert.equal(readFrame(data).kind, 'skip');
  assert.deepEqual(readFrame(JSON.stringify({ $type: 'error', error: 'ConsumerTooSlow' })), { kind: 'error', name: 'ConsumerTooSlow' });
  assert.deepEqual(readFrame(JSON.stringify({ $type: 'error', error: 'did:plc:x <b>' })), { kind: 'error', name: 'unnamed' });
  assert.deepEqual(readFrame(JSON.stringify({ $type: 'message', payload: { $type: `${LEX}#info`, name: 'OutdatedCursor' } })), { kind: 'info', name: 'OutdatedCursor' });
  // The v1 wire's shape is not what this subscription receives, and isn't read as a delete.
  assert.equal(readFrame(JSON.stringify({ did: W.DID, time_us: NOW * 1000, kind: 'commit', commit: { operation: 'delete', collection: QUESTION_NSID, rkey: '3kaaaaaaaaaab' } })).kind, 'skip');
});

test('heldByUris reads only, at most a batch, and only questions a deletion can take down', { skip }, async () => {
  const w = threads();
  const a = await w.q('Answered?');
  const h = await w.q('Hidden?');
  const g = await w.q('Gone?');
  w.env.SIREN_DB.db.prepare("UPDATE public_questions SET status = 'hidden' WHERE id = ?").run(h.id);
  await w.remove(g);
  const from = w.env.SIREN_DB.log.length;
  const rows = await heldByUris(w.env.SIREN_DB, [a.uri, h.uri, g.uri, a.uri, 'at://did:plc:x/y/z', 5]);
  assert.deepEqual(rows.map((r) => [r.id, r.status]).sort(), [[a.id, 'answered'], [h.id, 'hidden']].sort());
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'question_uri', 'status']);
  assert.equal(w.env.SIREN_DB.log.length - from, 1);
  assert.deepEqual(await heldByUris(w.env.SIREN_DB, []), []);
  assert.equal(w.env.SIREN_DB.log.length - from, 1, 'none asked: no statement');
  const many = Array.from({ length: HELD_BATCH + 20 }, (_, i) => `at://${CAROL}/${QUESTION_NSID}/3k${String(i).padStart(11, 'a')}`);
  await heldByUris(w.env.SIREN_DB, many);
  assert.equal(w.env.SIREN_DB.log.at(-1).params.length, HELD_BATCH);
});

// ---- After the second review (P1-P5 began as the reviewer's probes) ------

/** Timers a test fires by hand: set() records, fire() runs whatever is still set. */
function manualTimers() {
  const t = { list: [] };
  t.set = (fn, ms) => {
    const h = { fn, ms, done: false };
    t.list.push(h);
    return h;
  };
  t.clear = (h) => {
    if (h) h.done = true;
  };
  t.fire = () => {
    for (const h of t.list) {
      if (!h.done) {
        h.done = true;
        h.fn();
      }
    }
  };
  return t;
}
const tickOver = () => new Promise((r) => setImmediate(r));

/** EAST takes the connection and never answers the upgrade (until a test resolves it). */
function hangEast(w, js) {
  const hung = [];
  w.net.routes[`${EAST}${SUBSCRIBE_PATH}`] = (u, init) => {
    js.urls.push(u);
    return new Promise((resolve) => hung.push({ resolve, init }));
  };
  return hung;
}

test('P1: an upgrade that never answers is given up on after UPGRADE_TIMEOUT_MS; the alarm is set before the attempt; the next alarm tries the other instance; a late answer is closed unused', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const js = jetstream(w);
  const hung = hangEast(w, js);
  const timers = manualTimers();
  const watcher = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5, timers });
  const first = watcher.alarm();
  await tickOver();
  assert.equal(watcher.connecting, true);
  assert.equal(state.alarm, NOW + TICK_MS, 'the next alarm is set before the upgrade is awaited');
  assert.equal(timers.list[0].ms, UPGRADE_TIMEOUT_MS);
  assert.equal(UPGRADE_TIMEOUT_MS, 10e3);
  assert.equal(hung[0].init.redirect, 'manual');
  assert.ok(hung[0].init.signal instanceof AbortSignal);
  assert.equal(hung[0].init.signal.aborted, false);
  timers.fire(); // ten seconds pass
  await first;
  assert.equal(hung[0].init.signal.aborted, true, 'the request is aborted');
  assert.equal(watcher.connecting, false);
  assert.equal(watcher.ws, null);
  assert.equal(state.alarm, NOW + BACKOFF_MIN_MS, 'retried after the backoff');
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.last().host, WEST, 'on the other instance');
  assert.equal(watcher.ws, js.last());
  // The hung upgrade answers at last: that socket is closed unused, the live one untouched.
  const late = new FakeSocket(EAST);
  hung[0].resolve({ status: 101, webSocket: late, body: null });
  await tickOver();
  assert.deepEqual(late.closed, { code: 1000, reason: 'late' });
  assert.equal(watcher.ws, js.last());
  // A timer cleared once the answer came: an open socket's request is never aborted later.
  const live = timers.list.at(-1);
  assert.equal(live.done, true);
});

test('P1: if even the timeout never fires, a connect older than CONNECT_STALE_MS is abandoned and retried, and its late answer is closed', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const js = jetstream(w);
  const hung = hangEast(w, js);
  const never = { set: () => ({}), clear: () => {} };
  const watcher = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5, timers: never });
  watcher.alarm(); // never settles while the upgrade hangs
  await tickOver();
  assert.equal(state.alarm, NOW + TICK_MS, 'an alarm is set all the same');
  // The cron's ping ten seconds later: the connect isn't stale yet, so nothing new.
  w.clock.t = NOW + 10e3;
  await ping(watcher);
  assert.equal(js.urls.length, 1);
  w.clock.t = NOW + CONNECT_STALE_MS;
  await watcher.alarm();
  assert.equal(watcher.connecting, false, 'abandoned');
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.urls.length, 2);
  assert.equal(js.last().host, WEST);
  assert.equal(watcher.ws, js.last());
  const late = new FakeSocket(EAST);
  hung[0].resolve({ status: 101, webSocket: late, body: null });
  await tickOver();
  assert.deepEqual(late.closed, { code: 1000, reason: 'stale' });
  assert.equal(watcher.ws, js.last(), 'the live socket stays');
});

test('P2: an accept() that throws is a failed connect: nothing is left half-connected, and the next alarm connects', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const js = jetstream(w);
  const real = w.net.routes[`${EAST}${SUBSCRIBE_PATH}`];
  let bad = true;
  w.net.routes[`${EAST}${SUBSCRIBE_PATH}`] = (u, init) => {
    const res = real(u, init);
    if (bad) {
      bad = false;
      res.webSocket.accept = () => {
        throw new Error('accept failed');
      };
    }
    return res;
  };
  const watcher = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  const lines = await capture(() => watcher.alarm());
  assert.equal(watcher.connecting, false);
  assert.equal(watcher.ws, null);
  assert.equal(state.alarm, NOW + BACKOFF_MIN_MS);
  assert.ok(lines.some((l) => l.startsWith('question watcher: accepting the stream failed')));
  for (let i = 0; i < 2; i++) {
    w.clock.t = state.alarm;
    await watcher.alarm();
  }
  assert.ok(watcher.ws, 'connected');
  assert.equal(watcher.ws, js.last());
});

test('P3: deletions still waiting for their check hold the saved cursor back, so a restart replays them and they are taken down', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const { watcher, js } = watch(w, { state });
  await ping(watcher);
  const qs = [];
  for (let i = 0; i < CHECKS_PER_MINUTE + 5; i++) qs.push(await w.q(`Held ${i}?`, { did: [W.DID, BOB, CAROL][i % 3] }));
  for (const q of qs) w.del(q);
  const deletedAt = w.clock.t;
  const frames = qs.map((q) => deleteOf(q, deletedAt));
  for (const f of frames) js.last().frame(f);
  await watcher.settled();
  assert.equal(watcher.pending.size, 5, 'five wait for the next minute');
  // Ten seconds later an unrelated create moves the cursor on; the cursor is saved.
  w.clock.t += 10e3;
  js.last().frame(commit({ rkey: rkeyN(999), operation: 'create', at: w.clock.t }));
  await watcher.saveCursor(true);
  assert.ok(watcher.cursor > deletedAt * 1000);
  assert.equal(state.store.get('cursor'), deletedAt * 1000, 'saved no later than the oldest deletion still waiting');
  // A deploy (every push to main) or a restart: a new instance from the same storage.
  const fresh = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  await ping(fresh);
  const resume = Number(js.urls.at(-1).searchParams.get('cursor'));
  assert.equal(resume, deletedAt * 1000 - REWIND_US);
  // Jetstream replays from there: the five still up are taken down; the rest aren't held any more.
  for (const f of frames) js.last().frame(f);
  await fresh.settled();
  assert.ok(qs.every((q) => status(w, q.id) === 'withdrawn'));
  assert.equal(fresh.stats.withdrawn, 5);
  // Once dealt with, they no longer hold the cursor back.
  await fresh.saveCursor(true);
  assert.equal(state.store.get('cursor'), fresh.cursor);
});

test('P4: a flood of deletions of records Siren doesn\'t hold doesn\'t keep a held one from being checked that minute', { skip }, async () => {
  for (const flood of ['one account', 'many accounts']) {
    const w = threads();
    const state = fakeState();
    const { watcher, js } = watch(w, { state });
    await ping(watcher);
    const victim = await w.q('Please take this down?');
    // Anyone can create and delete records in this collection in their own repo (no invite needed).
    const n = flood === 'one account' ? 300 : 600;
    for (let i = 0; i < n; i++) {
      const did = flood === 'one account' ? CAROL : didN(1000 + Math.floor(i / PER_DID_PER_MINUTE));
      js.last().frame(commit({ did, rkey: rkeyN(500000 + i), at: w.clock.t }));
    }
    w.del(victim);
    js.last().frame(deleteOf(victim, w.clock.t));
    await watcher.settled();
    assert.equal(status(w, victim.id), 'withdrawn', `${flood}: the real deletion is taken down this minute`);
    assert.equal(watcher.stats.withdrawn, 1);
    if (flood === 'one account') {
      assert.equal(watcher.stats.notHeld, PER_DID_PER_MINUTE, 'one account gets its share, read in a batch or two');
      assert.equal(watcher.stats.leftForSweep, n - PER_DID_PER_MINUTE);
    } else {
      assert.equal(watcher.stats.notHeld, n, 'many accounts: all looked up, within the minute\'s reads');
      assert.ok(w.env.SIREN_DB.log.filter((e) => /question_uri IN/.test(e.sql)).length <= LOOKUPS_PER_MINUTE);
    }
  }
});

test('P5: the upgrade never follows a redirect: a 3xx is a failed connect, nothing is fetched from where it points, and the next attempt goes to the other instance', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const js = jetstream(w);
  const seen = [];
  w.net.routes[`${EAST}${SUBSCRIBE_PATH}`] = (u, init) => {
    seen.push(init);
    return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/stream' } });
  };
  const watcher = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  await ping(watcher);
  assert.equal(seen[0].redirect, 'manual');
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.equal(watcher.ws, null);
  assert.ok(!w.net.calls.some((c) => c.url.includes('elsewhere.example')));
  assert.equal(watcher.refusals, 0, 'a redirect is not a refusal');
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.last().host, WEST);
});

test('refusals: three 4xx answers in a row and the watcher tries every ten minutes; an outage is logged once per change of state; recovery once', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const js = jetstream(w);
  for (const host of [EAST, WEST]) w.net.routes[`${host}${SUBSCRIBE_PATH}`] = (u) => (js.urls.push(u), Response.json({ error: 'InvalidRequest', message: 'unknown parameter' }, { status: 400 }));
  const watcher = new QuestionWatcher(state, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
  const lines = await capture(async () => {
    await ping(watcher);
    for (let i = 1; i < BLOCKED_AFTER; i++) {
      w.clock.t = state.alarm;
      await watcher.alarm();
    }
    assert.equal(js.urls.length, BLOCKED_AFTER);
    assert.equal(watcher.nextAttemptAt, w.clock.t + BLOCKED_BACKOFF_MS);
    // The minute alarm keeps running; no attempt until the ten minutes are up.
    const t0 = w.clock.t;
    while (w.clock.t < t0 + BLOCKED_BACKOFF_MS - TICK_MS) {
      w.clock.t = state.alarm;
      await watcher.alarm();
    }
    assert.equal(js.urls.length, BLOCKED_AFTER, 'no attempts in between');
    w.clock.t = t0 + BLOCKED_BACKOFF_MS;
    await watcher.alarm();
    assert.equal(js.urls.length, BLOCKED_AFTER + 1);
    // Jetstream takes the subscription again.
    jetstream(w);
    w.clock.t = watcher.nextAttemptAt;
    await watcher.alarm();
    assert.ok(watcher.ws);
  });
  assert.deepEqual(lines.map((l) => l.replace(/\d+ minutes/g, 'N minutes')), [
    `question watcher: couldn't connect to ${EAST} (400); retrying`,
    'question watcher: Jetstream refused the subscription 3 times in a row (400); trying every N minutes',
    'question watcher: not connected for N minutes; instant takedowns wait, and the sweep still runs',
    `question watcher: connected to ${EAST} after N minutes`,
  ]);
  assert.ok(DOWN_LOG_MS <= BLOCKED_BACKOFF_MS);
});

test('a socket CLOSING or CLOSED with no close event is reconnected on the next minute', { skip }, async () => {
  const w = threads();
  const state = fakeState();
  const { watcher, js } = watch(w, { state });
  await ping(watcher);
  js.last().readyState = 3; // the close event never reached us
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.sockets.length, 2);
  assert.deepEqual(js.sockets[0].closed, { code: 1000, reason: 'dead' });
  assert.equal(watcher.ws, js.last());
  // An open one (readyState 1) is left alone.
  w.clock.t = state.alarm;
  await watcher.alarm();
  assert.equal(js.sockets.length, 2);
});

// ---- The Worker: the binding, the export, the cron's ping ----------------

const canHook = typeof nodeModule.registerHooks === 'function';
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
  worker = await import('../worker/index.js');
  return worker;
}

/** A Durable Object namespace binding that records how it's used. */
function fakeNamespace(answer = () => new Response(JSON.stringify({ connected: true }), { status: 200 })) {
  const ns = { names: [], fetches: [] };
  ns.idFromName = (name) => {
    ns.names.push(name);
    return { name };
  };
  ns.get = (id, opts) => ({
    fetch: async (url, init) => {
      ns.fetches.push({ id: id.name, hint: opts?.locationHint, url: String(url), method: init?.method });
      return answer();
    },
  });
  return ns;
}

test('the Worker exports the class, and its cron pings the one watcher (with the sweep) only when the free tier is on and ready', { skip: (!canHook && 'node:module has no registerHooks') || skip }, async () => {
  const mod = await loadWorker();
  assert.equal(mod.QuestionWatcher, QuestionWatcher);
  const run = async (env) => {
    const waits = [];
    await mod.default.scheduled({ cron: '*/10 * * * *', scheduledTime: NOW }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    return waits.length;
  };
  const w = threads();
  const ns = fakeNamespace();
  w.env.QUESTION_WATCHER = ns;
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('the real network was asked');
  };
  try {
    assert.equal(await run(w.env), 1);
    assert.deepEqual(ns.names, [WATCHER_NAME]);
    assert.deepEqual(ns.fetches, [{ id: WATCHER_NAME, hint: 'enam', url: 'https://question-watcher/ping', method: 'POST' }]);
    assert.ok(w.env.SIREN_DB.log.some((e) => /status = 'answering'/.test(e.sql)), 'the sweep ran too');
    // A watcher that fails doesn't stop the sweep, and is logged without detail.
    const broken = fakeNamespace(() => {
      throw new Error('object unavailable');
    });
    w.env.QUESTION_WATCHER = broken;
    const lines = await capture(() => run(w.env));
    assert.ok(lines.some((l) => l.startsWith('question watcher: ping failed')));
    // Without the binding (the default deployment): the sweep only.
    delete w.env.QUESTION_WATCHER;
    assert.equal(await pingQuestionWatcher(w.env), false);
    // Off, or on but not ready: nothing reaches the namespace.
    for (const over of [{ PUBLIC_ASK: undefined }, { BLUESKY_LOGIN: undefined }]) {
      const v = threads({ env: over });
      const off = fakeNamespace();
      v.env.QUESTION_WATCHER = off;
      await capture(() => run(v.env));
      assert.deepEqual([off.names, off.fetches], [[], []], JSON.stringify(over));
    }
  } finally {
    globalThis.fetch = real;
  }
});

test('wrangler.toml: the binding and its migration under env.siren, a SQLite class, the default instances documented, the flag still off', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[\[env\.siren\.durable_objects\.bindings\]\]\nname = "QUESTION_WATCHER"\nclass_name = "QuestionWatcher"\n/);
  assert.match(toml, /\[\[env\.siren\.migrations\]\]\ntag = "v1-question-watcher"\nnew_sqlite_classes = \["QuestionWatcher"\]\n/);
  assert.ok(!/^\s*new_classes\s*=/m.test(toml), 'never a key-value-backed class');
  assert.ok(!/^\[\[migrations\]\]/m.test(toml) && !/^\[\[durable_objects/m.test(toml), 'nothing at the top level: the default deployment is unchanged');
  assert.ok(!/^\s*PUBLIC_ASK\s*=/m.test(toml), 'the free tier flips in its own PR');
  assert.ok(!/^\s*JETSTREAM_URL\s*=/m.test(toml), 'the default instances, set in code');
  assert.ok(toml.includes(`# JETSTREAM_URL = "${DEFAULT_JETSTREAM_URL}"`));
});
