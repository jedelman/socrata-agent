// The free tier's instant takedowns (docs/free-tier.md, "Deletions as they
// happen"; Jason, 2026-11-10: "Takedowns should be a worker path so it's
// instant"). A question record deleted on Siren's own page is withdrawn at
// once (POST /api/public/withdraw), and so is a steward's hide. A record
// deleted directly in the asker's Bluesky account used to wait for the
// ten-minute sweep, or for someone to open its page. This Durable Object
// closes that gap: one instance (idFromName(WATCHER_NAME)) holds one
// WebSocket to Jetstream, filtered to commits in QUESTION_NSID's collection,
// and on a delete for a record Siren holds it takes the question down
// through the same code path withdrawal uses (public-ask.js takedownIfGone).
// The sweep stays as the backstop.
//
// The event is never trusted. A delete only names a record to look at:
// Siren re-resolves the DID, asks the PDS its document names for the record,
// and withdraws only on a clear RecordNotFound. A forged or replayed event
// finds the record present (or the PDS unreachable) and changes nothing,
// with no D1 write. Creates and updates are ignored, and a delete for a URI
// Siren doesn't hold costs one batched D1 read and nothing else.
//
// Bounds: a frame over MAX_FRAME_CHARS is skipped unread; at most
// DELETES_PER_MINUTE deletions are taken a minute and QUEUE_MAX wait at once
// (the rest are the sweep's); D1 lookups go HELD_BATCH URIs to a statement;
// at most CHECKS_PER_MINUTE records are checked a minute, each behind the
// site breaker (BSKY_SITE_RL, key 'takedown') and on its own counted budget
// (CHECK_BUDGET, src/request-budget.js), as the sweep's are; the WebSocket
// upgrade is counted too. Nothing logged names a DID: only host names, fixed
// sentences and counts.
//
// With PUBLIC_ASK off or not ready, nothing fetches this object (index.js
// `scheduled` returns before the ping), and if it wakes anyway (an alarm
// set before the flag went off) it closes its socket, deletes its alarm and
// does nothing else.
//
// Jetstream, as read on 2026-11-10 (https://bsky.network/docs/jetstream/,
// and its lexicon and design doc, lexicons/network/bsky/jetstream/
// subscribeEvents.json and docs/README.md §5, github.com/bluesky-social/
// jetstream at c9cbd1b, 2026-10-27). The project's README now points to that
// site, which recommends Jetstream v2 for new projects: wss://jetstream
// .us-east.bsky.network and wss://jetstream.us-west.bsky.network, the path
// /xrpc/network.bsky.jetstream.subscribeEvents, filters `kinds` (commit,
// identity, account, sync), `collections` (NSIDs; it "constrains only commit
// events", so a commits-only stream needs kinds=commit too) and `dids`, and
// a `cursor` that, at or above 1e15, is "a unix-microseconds timestamp" for
// the live tail ("Cursors in the future drop into live-tip mode"; one below
// the 36-hour lookback is clamped and an #info OutdatedCursor sent). Each
// frame is {"$type": "message", "payload": {...}}, the payload's $type
// network.bsky.jetstream.subscribeEvents#commit (or #identity, #account,
// #sync, #info) with did, seq, time, witnessedAt, operation, collection,
// rkey; "A delete carries no record or cid". {"$type": "error"} frames are
// terminal. Delivery is at-least-once and "any client data frame closes the
// connection", so the watcher never sends. witnessedAt is "the portable
// resume position" across instances, so the cursor is a time: on reconnect,
// to either instance, the stream resumes from it less five seconds, as
// Jetstream's own client does on failover (specs/client.md, "Cursor modes &
// failover": "resume at lastWitnessed - WithFailoverRewind (default 5s)").
// The v1 wire (/subscribe, wantedCollections, time_us, {kind: 'commit',
// commit: {operation}}) is still served, but delivers every account's
// identity and account events whatever the collection filter; v2's
// kinds=commit leaves only this collection's commits.
//
// Cloudflare, as read on 2026-11-10:
// - An outbound WebSocket is a fetch() with `Upgrade: websocket` to an
//   http(s) URL, whose response carries `webSocket`; accept() it to handle
//   it in JavaScript ("Write a WebSocket client", developers.cloudflare.com/
//   workers/examples/websockets/, last updated 2026-04-23; "use http: or
//   https: as the protocol, not ws: nor wss:", /workers/configuration/
//   compatibility-flags/). Going through fetch() lets the upgrade be counted.
// - "Outgoing WebSockets do not hibernate", and "an open outbound WebSocket
//   connection prevents eviction for up to 15 minutes"; "Events such as
//   alarms, incoming requests ... prevent hibernation" (/durable-objects/
//   best-practices/websockets/, last updated 2026-10-30). An idle object is
//   evicted after 70-140 seconds without requests or events (/durable-objects/
//   concepts/durable-object-lifecycle/). The one-minute alarm keeps this one
//   in memory and reconnects whatever closed the socket.
// - Alarms: setAlarm(ms since epoch) (one per object), getAlarm, deleteAlarm;
//   alarm() runs at least once and is retried with exponential backoff, up
//   to six times, if it throws (/durable-objects/api/alarms/, /api/base/). So
//   alarm() never throws here, and the cron's ping re-arms it regardless.
// - Billing: "Calling accept() on a WebSocket in an Object will incur
//   duration charges for the entire time the WebSocket is connected"; Workers
//   Paid includes 400,000 GB-s and 1 million requests a month, then $12.50
//   per million GB-s and $0.15 per million; duration is billed on 128 MB;
//   alarm invocations are requests; "There is no charge for outgoing
//   WebSocket messages"; each setAlarm is one row written (/durable-objects/
//   platform/pricing/, last updated 2026-10-18). docs/free-tier.md works out
//   the month.
//
// A plain class, not `extends DurableObject`: the object is reached only by
// fetch() and its alarm, which a plain class serves, and index.js and this
// file stay importable by the Node tests (no `cloudflare:workers` import).

import { QUESTION_NSID, TID_RE } from './endorse-config.js';
import { isSupportedDid } from './atproto-identity.js';
import { publicAskReady, takedownIfGone, CHECK_BUDGET } from './public-ask.js';
import { heldByUris, HELD_BATCH, SWEEP_AGE_MS } from './questions.js';
import { mapLimit } from './public-list.js';
import { requestBudget } from '../src/request-budget.js';

/** The one instance's name: env.QUESTION_WATCHER.idFromName(WATCHER_NAME). */
export const WATCHER_NAME = 'jetstream';
/** Jetstream v2's public instances, US East first (SIREN_DB is in ENAM). JETSTREAM_URL replaces them. */
export const DEFAULT_JETSTREAM_URL = 'wss://jetstream.us-east.bsky.network,wss://jetstream.us-west.bsky.network';
export const SUBSCRIBE_PATH = '/xrpc/network.bsky.jetstream.subscribeEvents';
const LEXICON = 'network.bsky.jetstream.subscribeEvents';
/** The alarm: the socket is checked, and reconnected if it's down, every minute. */
export const TICK_MS = 60e3;
/** The cursor is written to storage at most this often (and on every tick and close). */
export const CURSOR_SAVE_MS = 5e3;
/** A reconnect resumes this far before the cursor (microseconds). */
export const REWIND_US = 5e6;
/** ...and never further back than this: a deletion older than the sweep's hour is the sweep's. */
export const MAX_REPLAY_MS = SWEEP_AGE_MS;
/** Reconnect backoff: doubling from the first to the last, with jitter. */
export const BACKOFF_MIN_MS = 1e3;
export const BACKOFF_MAX_MS = 30e3;
/** A session open this long was progress: the backoff starts again from the first step. */
export const STABLE_MS = 60e3;
/** No frame for this long: reconnect anyway, since a socket can die without closing. */
export const IDLE_RECYCLE_MS = 30 * 60e3;
/** A frame longer than this is skipped unread (a delete is a few hundred characters). */
export const MAX_FRAME_CHARS = 65536;
/** Deletions taken a minute, and waiting at once; past either, they are left for the sweep. */
export const DELETES_PER_MINUTE = 300;
export const QUEUE_MAX = 200;
/** Records checked at their PDS a minute; the rest wait for the next minute. */
export const CHECKS_PER_MINUTE = 20;
const CHECK_CONCURRENCY = 4;
/** A record checked this recently isn't checked again for a re-delivered event. */
export const COOLDOWN_MS = 10 * 60e3;
const RECENT_MAX = 1000;
const CURSOR_KEY = 'cursor';
const MIN_CURSOR_US = 1e15; // Jetstream reads a cursor at or above this as a time

// For the log: an error's message, cut short, with anything shaped like a
// DID taken out (nothing logged here names one; this is belt and braces).
const clip = (err) => String(err?.message || err || 'unknown').replace(/did:[a-z]+:[A-Za-z0-9._:%-]+/g, 'did:…').slice(0, 200);

/**
 * The Jetstream instances to use, in order, as the http(s) origins fetch()
 * takes: JETSTREAM_URL (comma-separated wss:// origins, at most four; or
 * ws://127.0.0.1:<port> for a local instance), else the default pair.
 * -> [origin], or null when JETSTREAM_URL is set but any entry isn't one of
 * those shapes (fail closed: no connection, and the log says why).
 */
export function jetstreamOrigins(env) {
  const raw = env?.JETSTREAM_URL;
  const list = String(raw === undefined || raw === null || raw === '' ? DEFAULT_JETSTREAM_URL : raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.length > 4) return null;
  const out = [];
  for (const s of list) {
    const remote = /^wss:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9])\/?$/.exec(s);
    const local = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(s);
    if (remote && remote[1].length <= 253) out.push(`https://${remote[1]}`);
    else if (local && Number(local[1]) <= 65535) out.push(`http://127.0.0.1:${local[1]}`);
    else return null;
  }
  return out;
}

/** The subscribe URL: this collection's commits only, from `cursorUs` (a unix-microsecond time) or the live tip. */
export function subscribeUrl(origin, cursorUs = null) {
  const u = new URL(SUBSCRIBE_PATH, origin);
  u.searchParams.append('kinds', 'commit');
  u.searchParams.append('collections', QUESTION_NSID);
  if (Number.isSafeInteger(cursorUs) && cursorUs >= MIN_CURSOR_US) u.searchParams.set('cursor', String(cursorUs));
  return u.href;
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
/** An RFC 3339 datetime as unix microseconds (Date.parse keeps only milliseconds), or null. */
export function micros(s) {
  if (typeof s !== 'string' || s.length > 40) return null;
  const m = RFC3339.exec(s);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[3]}`);
  if (!Number.isFinite(ms)) return null;
  const us = ms * 1000 + Number((m[2] || '').padEnd(6, '0').slice(0, 6));
  return Number.isSafeInteger(us) && us >= MIN_CURSOR_US ? us : null;
}

const plain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/**
 * One Jetstream frame, read: { kind: 'delete', uri, at } for a delete in
 * QUESTION_NSID's collection by a supported DID with a TID record key;
 * { kind: 'error', name } (the stream is ending); { kind: 'info', name };
 * { kind: 'other', at } for any other event; { kind: 'skip' } for anything
 * unreadable or too long. `at` is the event's witnessed time in unix
 * microseconds (witnessedAt, else time), or null. Names are kept only when
 * they are a plain word, so no remote text reaches the log.
 */
export function readFrame(data) {
  if (typeof data !== 'string' || data.length > MAX_FRAME_CHARS) return { kind: 'skip' };
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return { kind: 'skip' };
  }
  if (!plain(msg)) return { kind: 'skip' };
  if (msg.$type === 'error') return { kind: 'error', name: NAME_RE.test(String(msg.error)) ? msg.error : 'unnamed' };
  if (msg.$type !== 'message' || !plain(msg.payload)) return { kind: 'skip' };
  const p = msg.payload;
  if (p.$type === `${LEXICON}#info`) return { kind: 'info', name: NAME_RE.test(String(p.name)) ? p.name : 'unnamed' };
  const at = micros(p.witnessedAt) ?? micros(p.time);
  if (p.$type !== `${LEXICON}#commit` || p.operation !== 'delete' || p.collection !== QUESTION_NSID) return { kind: 'other', at };
  if (!isSupportedDid(p.did) || typeof p.rkey !== 'string' || !TID_RE.test(p.rkey)) return { kind: 'other', at };
  return { kind: 'delete', uri: `at://${p.did}/${QUESTION_NSID}/${p.rkey}`, at };
}

async function allowed(limiter, key) {
  try {
    return Boolean((await limiter.limit({ key }))?.success);
  } catch {
    return false; // fail closed: the sweep takes it
  }
}

/**
 * Where the one instance is created: near SIREN_DB (ENAM) and the first
 * Jetstream instance (US East), not wherever the cron first ran. "Only the
 * first call to get() for a particular Object will respect the hint", and
 * hints are best effort (/durable-objects/reference/data-location/, read
 * 2026-11-10).
 */
export const WATCHER_LOCATION = 'enam';

/**
 * The Worker's side: wake the watcher (index.js `scheduled`, every ten
 * minutes, only with the free tier on and ready), so it starts after a
 * deploy or an eviction. -> whether it answered; false without the binding.
 */
export async function pingQuestionWatcher(env) {
  const ns = env?.QUESTION_WATCHER;
  if (!ns || typeof ns.idFromName !== 'function' || typeof ns.get !== 'function') return false;
  const res = await ns.get(ns.idFromName(WATCHER_NAME), { locationHint: WATCHER_LOCATION }).fetch('https://question-watcher/ping', { method: 'POST' });
  try {
    await res.body?.cancel();
  } catch {
    // already read or closed
  }
  return res.ok;
}

export class QuestionWatcher {
  /**
   * The runtime passes (state, env). Tests pass `opts`: { now, fetchImpl,
   * random }, a clock, the network under every counted fetch, and the
   * backoff's jitter.
   */
  constructor(state, env, opts = {}) {
    this.ctx = state;
    this.env = env;
    this.now = opts.now || (() => Date.now());
    this.fetchImpl = opts.fetchImpl; // undefined: the real network, through each budget
    this.random = opts.random || Math.random;
    this.ws = null;
    this.connecting = false;
    this.origin = null;
    this.host = 0; // which instance, round-robin over jetstreamOrigins
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.openedAt = 0;
    this.lastFrameAt = 0;
    this.loaded = false;
    this.cursor = null; // unix microseconds: the newest witnessed time seen
    this.savedCursor = null;
    this.savedAt = -Infinity;
    this.queue = new Set(); // deleted URIs not yet looked up
    this.pending = new Map(); // held rows not yet checked: uri -> { id, question_uri }
    this.recent = new Map(); // uri -> when it was last checked
    this.window = -1;
    this.taken = 0;
    this.checks = 0;
    this.left = 0;
    this.tally = { withdrawn: 0, present: 0, unknown: 0, notHeld: 0 }; // this minute's, for the log
    this.pump = null;
    this.stats = { fetches: 0, connects: 0, withdrawn: 0, present: 0, unknown: 0, notHeld: 0, ignored: 0, leftForSweep: 0 };
  }

  /** POST /ping (index.js `scheduled`): connect if down, and keep the alarm set. */
  async fetch(req) {
    try {
      if (!publicAskReady(this.env)) {
        await this.stop();
        return new Response(null, { status: 204 });
      }
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/ping') return new Response('Not found', { status: 404 });
      await this.tick();
      return new Response(JSON.stringify(this.status()), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      console.error('question watcher: ping failed', clip(err));
      return new Response(null, { status: 500 });
    }
  }

  /** Every minute while the free tier is on; never throws (a throwing alarm is retried, then dropped). */
  async alarm() {
    try {
      if (!publicAskReady(this.env)) {
        await this.stop();
        return;
      }
      await this.tick();
    } catch (err) {
      console.error('question watcher: alarm failed', clip(err));
      // Set again only while the free tier is on (off, the object stays stopped).
      try {
        if (publicAskReady(this.env)) await this.arm();
      } catch {
        // the cron's ping sets it again
      }
    }
  }

  /** What the ping answers: counts, nothing about any question or asker. */
  status() {
    return { connected: Boolean(this.ws), host: this.origin ? new URL(this.origin).host : null, failures: this.failures, queued: this.queue.size + this.pending.size, stats: { ...this.stats } };
  }

  async load() {
    if (this.loaded) return;
    const c = await this.ctx.storage.get(CURSOR_KEY);
    this.cursor = Number.isSafeInteger(c) && c >= MIN_CURSOR_US ? c : null;
    this.savedCursor = this.cursor;
    this.loaded = true;
  }

  async tick() {
    await this.load();
    const origins = jetstreamOrigins(this.env);
    if (!origins) {
      this.close('config');
      console.error('question watcher: JETSTREAM_URL is not a list of wss:// origins, so instant takedowns are off; the sweep still runs');
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.saveCursor(true);
    const now = this.now();
    this.roll(now);
    if (this.ws && now - this.lastFrameAt >= IDLE_RECYCLE_MS) {
      this.close('idle');
      this.nextAttemptAt = 0;
    }
    if (!this.ws && !this.connecting && now >= this.nextAttemptAt) await this.connect(origins);
    this.kick();
    await this.arm();
  }

  /** The next alarm: a minute from now, or sooner when a reconnect is due. */
  async arm() {
    const now = this.now();
    let at = now + TICK_MS;
    if (!this.ws && this.nextAttemptAt > now) at = Math.min(at, this.nextAttemptAt);
    await this.ctx.storage.setAlarm(at);
  }

  /** Where a (re)connect resumes: the cursor less REWIND_US, at most MAX_REPLAY_MS back; null for the live tip. */
  resumeFrom(now) {
    if (this.cursor === null) return null;
    return Math.max(this.cursor - REWIND_US, (now - MAX_REPLAY_MS) * 1000);
  }

  async connect(origins) {
    this.connecting = true;
    const origin = origins[this.host % origins.length];
    const now = this.now();
    const budget = requestBudget({ limit: 1, fetchImpl: this.fetchImpl });
    let res = null;
    try {
      res = await budget.tool(subscribeUrl(origin, this.resumeFrom(now)), { headers: { Upgrade: 'websocket' } });
    } catch {
      res = null;
    } finally {
      this.stats.fetches += budget.used;
    }
    const ws = res?.webSocket;
    if (!ws) {
      try {
        await res?.body?.cancel();
      } catch {
        // nothing to cancel
      }
      this.connecting = false;
      console.log(`question watcher: couldn't connect to ${new URL(origin).host}${res ? ` (${Number(res.status) || 'no status'})` : ''}`);
      this.failed({ rotate: true });
      return false;
    }
    ws.accept();
    this.ws = ws;
    this.origin = origin;
    this.openedAt = now;
    this.lastFrameAt = now;
    this.connecting = false;
    // Listening from now: a later reconnect replays from here.
    if (this.cursor === null) this.cursor = now * 1000;
    ws.addEventListener('message', (e) => this.onMessage(ws, e));
    ws.addEventListener('close', () => this.onClose(ws));
    ws.addEventListener('error', () => this.onClose(ws));
    this.stats.connects++;
    console.log(`question watcher: connected to ${new URL(origin).host}`);
    return true;
  }

  /** Close our own socket (no backoff: the caller decides what comes next). */
  close(reason) {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.close(1000, reason);
    } catch {
      // already closed
    }
  }

  /** The flag is off (or the free tier not ready): close, forget the queue, delete the alarm. Nothing else. */
  async stop() {
    this.close('off');
    this.queue.clear();
    this.pending.clear();
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * A failed connect (rotate to the next instance) or a dropped session (the
   * same one, rotating every third failure in a row): the next attempt is
   * due after the backoff. The caller sets the alarm.
   */
  failed({ rotate }) {
    this.failures++;
    if (rotate || this.failures % 3 === 0) this.host++;
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(this.failures - 1, 16));
    this.nextAttemptAt = this.now() + Math.round(step * (0.75 + 0.5 * this.random()));
  }

  /** Off the event path: save the cursor and set the alarm for the reconnect, logging (never throwing) on failure. */
  later() {
    this.saveCursor(true).catch((err) => console.error('question watcher: saving the cursor failed', clip(err)));
    this.arm().catch((err) => console.error('question watcher: setting the alarm failed', clip(err)));
  }

  onClose(ws) {
    if (ws !== this.ws) return; // ours, closed on purpose, or an old one
    this.ws = null;
    if (this.now() - this.openedAt >= STABLE_MS) this.failures = 0;
    console.log('question watcher: the stream closed');
    this.failed({ rotate: false });
    this.later();
  }

  onMessage(ws, event) {
    if (ws !== this.ws) return;
    try {
      const now = this.now();
      this.lastFrameAt = now;
      const f = readFrame(event?.data);
      if (f.at != null) this.advance(f.at, now);
      if (f.kind === 'error') {
        console.log(`question watcher: Jetstream ended the stream (${f.name})`);
        this.close('error');
        this.failed({ rotate: true });
        this.later();
      } else if (f.kind === 'info') {
        console.log(`question watcher: Jetstream notice (${f.name})`);
      } else if (f.kind === 'delete') {
        this.take(f.uri, now);
      } else {
        this.stats.ignored++;
      }
    } catch (err) {
      console.error('question watcher: a frame failed', clip(err));
    }
  }

  /** The cursor moves to an event's witnessed time, never past our own clock (a time in the future would skip the live tail). */
  advance(at, now) {
    const t = Math.min(at, now * 1000);
    if (this.cursor !== null && t <= this.cursor) return;
    this.cursor = t;
    this.saveCursor(false).catch((err) => console.error('question watcher: saving the cursor failed', clip(err)));
  }

  /** Write the cursor if it moved: at most every CURSOR_SAVE_MS, unless forced (a tick, a close). */
  async saveCursor(force) {
    if (this.cursor === null || this.cursor === this.savedCursor) return;
    const now = this.now();
    if (!force && now - this.savedAt < CURSOR_SAVE_MS) return;
    this.savedAt = now;
    const v = this.cursor;
    await this.ctx.storage.put(CURSOR_KEY, v);
    this.savedCursor = v;
  }

  /** A new minute: the per-minute counts start again, and the last minute's are logged (counts only) if anything happened. */
  roll(now) {
    const w = Math.floor(now / 60e3);
    if (w === this.window) return;
    const t = this.tally;
    if (this.left || t.withdrawn || t.present || t.unknown || t.notHeld) {
      console.log(`question watcher: last minute, ${t.withdrawn} taken down, ${t.present} still present, ${t.unknown} couldn't be checked, ${t.notHeld} not held here, ${this.left} left for the sweep`);
    }
    this.window = w;
    this.taken = 0;
    this.checks = 0;
    this.left = 0;
    this.tally = { withdrawn: 0, present: 0, unknown: 0, notHeld: 0 };
  }

  /** A reported deletion, queued for a batched lookup, within the minute's caps. */
  take(uri, now) {
    this.roll(now);
    if (this.queue.has(uri) || this.pending.has(uri)) return;
    const seen = this.recent.get(uri);
    if (seen !== undefined && now - seen < COOLDOWN_MS) return;
    if (this.taken >= DELETES_PER_MINUTE || this.queue.size + this.pending.size >= QUEUE_MAX) {
      this.left++;
      this.stats.leftForSweep++;
      return;
    }
    this.taken++;
    this.queue.add(uri);
    this.kick();
  }

  kick() {
    if (this.pump || (!this.queue.size && !this.pending.size)) return;
    this.pump = this.drain()
      .catch((err) => console.error('question watcher: draining failed', clip(err)))
      .finally(() => {
        this.pump = null;
      });
  }

  /** Until whatever is draining now has finished (for tests). */
  async settled() {
    while (this.pump) await this.pump;
  }

  async drain() {
    while (this.queue.size || this.pending.size) {
      if (this.queue.size) {
        const batch = [...this.queue].slice(0, HELD_BATCH);
        let rows;
        try {
          rows = await heldByUris(this.env.SIREN_DB, batch);
        } catch (err) {
          console.error('question watcher: D1 read failed', clip(err));
          return; // still queued: the next tick tries again
        }
        const held = new Map(rows.map((r) => [r.question_uri, r]));
        for (const uri of batch) {
          this.queue.delete(uri);
          const r = held.get(uri);
          if (r) this.pending.set(uri, { id: r.id, question_uri: r.question_uri });
          else {
            this.stats.notHeld++; // not ours: no write
            this.tally.notHeld++;
          }
        }
      }
      const progressed = await this.check();
      if (!progressed && !this.queue.size) return; // the minute's checks are spent: the next tick goes on
    }
  }

  /** Check up to the minute's remaining room. -> whether any were checked. */
  async check() {
    const now = this.now();
    this.roll(now);
    const room = CHECKS_PER_MINUTE - this.checks;
    if (room <= 0 || !this.pending.size) return false;
    const rows = [...this.pending.values()].slice(0, room);
    for (const r of rows) this.pending.delete(r.question_uri);
    this.checks += rows.length;
    await mapLimit(rows, CHECK_CONCURRENCY, async (row) => {
      this.recent.delete(row.question_uri);
      this.recent.set(row.question_uri, this.now());
      while (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.keys().next().value);
      if (!(await allowed(this.env.BSKY_SITE_RL, 'takedown'))) {
        this.stats.leftForSweep++;
        this.left++;
        return;
      }
      const budget = requestBudget({ limit: CHECK_BUDGET, fetchImpl: this.fetchImpl });
      try {
        const state = await takedownIfGone(this.env, row, budget);
        const key = state === 'gone' ? 'withdrawn' : state === 'present' ? 'present' : 'unknown';
        this.stats[key]++;
        this.tally[key]++;
        if (state === 'gone') console.log('question watcher: took down a question deleted in its account');
      } catch (err) {
        console.error('question watcher: a takedown failed', clip(err));
      } finally {
        this.stats.fetches += budget.used;
      }
    });
    return true;
  }
}
