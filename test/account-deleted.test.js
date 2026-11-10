// A question whose asker deleted their whole account (docs/free-tier.md,
// "Withdrawing, and the steward"). On a Bluesky PDS, getRecord for an account
// the PDS doesn't serve as active goes to the AppView, which answers
// InvalidRequest "Could not find repo" for a deleted account and for a
// deactivated or taken-down one alike (bluesky-social/atproto at dd74699:
// packages/pds/src/api/com/atproto/repo/getRecord.ts, packages/bsky/src/
// api/com/atproto/repo/getRecord.ts, hydration/actor.ts getActors). So the
// shared re-check asks the same PDS, the one the freshly re-resolved DID
// document names, com.atproto.sync.getRepoStatus: 400 RepoNotFound (the
// account's rows deleted: sync/util.ts assertRepoAvailability) is gone; 200
// { active: false, status: 'deactivated' | 'takendown' } stays, since those
// accounts can come back. The same rule for withdrawal, the sweep, a page's
// re-check and the Jetstream watcher; an ask still calls it "unreachable".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepQuestions, takedownIfGone, CHECK_BUDGET } from '../worker/public-ask.js';
import { CHECK_STEP_MS, SWEEP_AGE_MS } from '../worker/questions.js';
import { QuestionWatcher, SUBSCRIBE_PATH } from '../worker/question-watcher.js';
import { QUESTION_NSID } from '../worker/endorse-config.js';
import { requestBudget } from '../src/request-budget.js';
import { didDoc } from './fake-atproto.js';
import { hasSqlite } from './fake-d1.js';
import { NOW, BOB, threads } from './public-ask-world.js';

const skip = !hasSqlite && 'node:sqlite is missing';
const PDS = 'pds.fixture.dev';
const status = (w, id) => w.env.SIREN_DB.rows().find((r) => r.id === id)?.status;
const ACCOUNT = {
  deleted: () => Response.json({ error: 'RepoNotFound', message: `Could not find repo for DID: ${BOB}` }, { status: 400 }),
  deactivated: () => Response.json({ did: BOB, active: false, status: 'deactivated' }),
  takendown: () => Response.json({ did: BOB, active: false, status: 'takendown' }),
  active: () => Response.json({ did: BOB, active: true, rev: '3kaaaaaaaaaaa' }),
  'unreachable status': () => new Response('down', { status: 503 }),
  'another error': () => Response.json({ error: 'InvalidRequest', message: 'nope' }, { status: 400 }),
};

/** Bob's account is in `state` on the PDS his DID document names: getRecord answers as a Bluesky PDS would, through the AppView. */
function bobIs(w, state, { getRecord = 'Could not find repo' } = {}) {
  const real = w.net.routes[`${PDS}/xrpc/com.atproto.repo.getRecord`];
  w.net.routes[`${PDS}/xrpc/com.atproto.repo.getRecord`] = (u, init, net) => {
    if (u.searchParams.get('repo') !== BOB) return real(u, init, net);
    if (getRecord === 'Could not find repo') return Response.json({ error: 'InvalidRequest', message: `Could not find repo: ${BOB}` }, { status: 400 });
    return Response.json({ error: getRecord, message: 'Repo is not available' }, { status: 400 });
  };
  w.net.routes[`${PDS}/xrpc/com.atproto.sync.getRepoStatus`] = (u) => {
    assert.equal(u.searchParams.get('did'), BOB);
    return ACCOUNT[state]();
  };
}
const statusCalls = (w) => w.net.calls.filter((c) => c.url.includes('com.atproto.sync.getRepoStatus'));

test('the shared re-check: a deleted account is gone; deactivated, taken down, active, unreachable or any other answer stays "couldn\'t check"', { skip }, async () => {
  for (const state of Object.keys(ACCOUNT)) {
    const w = threads();
    const q = await w.q('Bob asks?', { did: BOB });
    bobIs(w, state);
    const budget = requestBudget({ limit: CHECK_BUDGET, fetchImpl: w.net.fetch });
    const got = await takedownIfGone(w.env, { id: q.id, question_uri: q.uri }, budget);
    assert.equal(got, state === 'deleted' ? 'gone' : 'unknown', state);
    assert.equal(status(w, q.id), state === 'deleted' ? 'withdrawn' : 'answered', state);
    assert.equal(budget.used, 3, `${state}: the DID document, getRecord, getRepoStatus`);
    const asked = statusCalls(w).map((c) => new URL(c.url).host);
    assert.deepEqual(asked, [PDS], `${state}: asked of the PDS the document names`);
  }
});

test('a getRecord answer that names the repo as deactivated, taken down or suspended stays "couldn\'t check" without asking further', { skip }, async () => {
  for (const code of ['RepoDeactivated', 'RepoTakendown', 'RepoSuspended']) {
    const w = threads();
    const q = await w.q('Bob asks?', { did: BOB });
    bobIs(w, 'deleted', { getRecord: code });
    const budget = requestBudget({ limit: CHECK_BUDGET, fetchImpl: w.net.fetch });
    assert.equal(await takedownIfGone(w.env, { id: q.id, question_uri: q.uri }, budget), 'unknown', code);
    assert.equal(statusCalls(w).length, 0, code);
    assert.equal(status(w, q.id), 'answered');
  }
});

test('only the PDS the freshly re-resolved document names counts: an account moved to a new PDS that holds the record stays up, whatever the old one says', { skip }, async () => {
  const w = threads();
  const q = await w.q('Bob asks?', { did: BOB });
  bobIs(w, 'deleted'); // the old PDS: no such repo
  // Bob moved: his document now names another PDS, which holds the record.
  w.net.state.didDocs.set(BOB, didDoc({ did: BOB, handle: 'bob.fixture.dev', pds: 'https://pds2.fixture.dev' }));
  w.net.routes['pds2.fixture.dev/xrpc/com.atproto.repo.getRecord'] = () => Response.json({ uri: q.uri, cid: q.cid, value: q.record });
  const before = w.net.calls.length;
  const budget = requestBudget({ limit: CHECK_BUDGET, fetchImpl: w.net.fetch });
  assert.equal(await takedownIfGone(w.env, { id: q.id, question_uri: q.uri }, budget), 'present');
  assert.equal(statusCalls(w).length, 0, 'the old PDS was never asked');
  assert.deepEqual(w.net.calls.slice(before).map((c) => new URL(c.url).host), ['plc.fixture.dev', 'pds2.fixture.dev'], 'only the new PDS');
  assert.equal(status(w, q.id), 'answered');
});

test('the sweep and a page\'s re-check take down a deleted account\'s questions and leave a deactivated one\'s', { skip }, async () => {
  for (const state of ['deleted', 'deactivated']) {
    // The sweep.
    const w = threads();
    const q = await w.q('Bob asks?', { did: BOB });
    const other = await w.q('Alice asks?');
    bobIs(w, state);
    w.clock.t = NOW + SWEEP_AGE_MS + CHECK_STEP_MS;
    const out = await sweepQuestions(w.env, { fetchImpl: w.net.fetch, now: w.clock.t });
    assert.deepEqual([out.withdrawn, out.unknown], state === 'deleted' ? [1, 0] : [0, 1], state);
    assert.equal(status(w, q.id), state === 'deleted' ? 'withdrawn' : 'answered', state);
    assert.equal(status(w, other.id), 'answered');
    // A page's re-check of its thread.
    const p = threads();
    const root = await p.q('Alice asks?');
    const reply = await p.q('Bob follows up?', { did: BOB, on: root });
    bobIs(p, state);
    p.clock.t = NOW + 11 * 60e3 + CHECK_STEP_MS;
    const page = (await p.one(root.id)).body;
    assert.equal(page.thread[1].withdrawn === true, state === 'deleted', state);
    assert.equal(status(p, reply.id), state === 'deleted' ? 'withdrawn' : 'answered');
    assert.equal(status(p, root.id), 'answered');
  }
});

test('withdrawal: a deleted account\'s question can be withdrawn; a deactivated one\'s can\'t ("couldn\'t check")', { skip }, async () => {
  for (const state of ['deleted', 'deactivated']) {
    const w = threads();
    const q = await w.q('Bob asks?', { did: BOB });
    bobIs(w, state);
    const out = await w.withdraw(q.uri);
    assert.equal(out.status, state === 'deleted' ? 200 : 502, state);
    assert.equal(status(w, q.id), state === 'deleted' ? 'withdrawn' : 'answered');
  }
});

test('the Jetstream watcher: a delete for a deleted account\'s question takes it down; for a deactivated one, nothing changes', { skip }, async () => {
  for (const state of ['deleted', 'deactivated', 'takendown']) {
    const w = threads();
    const q = await w.q('Bob asks?', { did: BOB });
    bobIs(w, state);
    const sockets = [];
    w.net.routes[`jetstream.us-east.bsky.network${SUBSCRIBE_PATH}`] = () => {
      const listeners = {};
      const s = { accept() {}, close() {}, readyState: 1, addEventListener: (t, fn) => (listeners[t] ||= []).push(fn), emit: (t, e) => (listeners[t] || []).forEach((fn) => fn(e)) };
      sockets.push(s);
      return { status: 101, webSocket: s, body: null };
    };
    const store = new Map();
    const storage = { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v), setAlarm: async () => {}, deleteAlarm: async () => {}, getAlarm: async () => null };
    const watcher = new QuestionWatcher({ storage }, w.env, { now: () => w.clock.t, fetchImpl: w.net.fetch, random: () => 0.5 });
    await watcher.fetch(new Request('https://question-watcher/ping', { method: 'POST' }));
    const iso = new Date(w.clock.t).toISOString();
    sockets[0].emit('message', { data: JSON.stringify({ $type: 'message', payload: { $type: 'network.bsky.jetstream.subscribeEvents#commit', did: BOB, seq: 1, time: iso, witnessedAt: iso, rev: '3kaaaaaaaaaaa', operation: 'delete', collection: QUESTION_NSID, rkey: q.rkey } }) });
    await watcher.settled();
    assert.equal(status(w, q.id), state === 'deleted' ? 'withdrawn' : 'answered', state);
  }
});

test('an ask whose record\'s PDS answers "Could not find repo" is still refused as unreachable, and nothing more is asked', { skip }, async () => {
  const w = threads();
  const rec = w.record({ did: BOB, text: 'Bob asks?' });
  bobIs(w, 'deleted');
  const out = await w.ask({ uri: rec.uri, cid: rec.cid });
  assert.equal(out.status, 502);
  assert.equal(out.body.code, 'unreachable');
  assert.equal(statusCalls(w).length, 0);
  assert.equal(w.answers.length, 0, 'no model call');
});
