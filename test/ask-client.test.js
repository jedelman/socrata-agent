// The browser's ask client (worker/endorse-client.js, kind 'ask'; the free
// tier, docs/free-tier.md), in Node against the fake network: its own
// client_id and redirect, the question permission only (and the endorse one
// only to keep it), the granted scope checked, a question record written to
// the person's own PDS and deleted from it, and the session shared with the
// requests page, each page's actions checked against the scope it holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MESSAGES } from '../worker/endorse-client.js';
import { memoryStore } from '../worker/endorse-store.js';
import { QUESTION_NSID, QUESTION_SCOPE, ASK_SCOPE, ASK_CLIENT_SCOPE, OAUTH_SCOPE, ENDORSE_SCOPE, validQuestion, parseRecordUri, TID_RE } from '../worker/endorse-config.js';
import { W, fakeNetwork } from './fake-atproto.js';

const ORIGIN = 'https://ask-siren.jason-edelman.org';
const ID = 'abcdefghijklmnop';

function setup({ net = fakeNetwork(), store = memoryStore(), now = Date.parse('2026-11-10T12:00:00Z') } = {}) {
  const clock = { t: now };
  const mk = (kind) => createClient({ origin: ORIGIN, base: '', store, fetchImpl: net.fetch, now: () => clock.t, dohUrl: W.DOH, plcUrl: W.PLC, kind });
  return { net, store, clock, ask: mk('ask'), endorse: mk('endorse') };
}

async function signIn(w, client, granted) {
  w.net.state.grantedScope = granted;
  await client.signIn(W.HANDLE);
  const par = w.net.state.par.at(-1).form;
  return { par, out: await client.finish(`#state=${encodeURIComponent(par.state)}&iss=${encodeURIComponent(W.ISSUER)}&code=${W.CODE}${w.net.state.par.length}`) };
}

test('sign-in on the questions page: its own client_id, the questions page as redirect, the question permission only', async () => {
  const w = setup();
  const url = await w.ask.signIn(W.HANDLE);
  assert.ok(url.startsWith(`${W.ISSUER}/oauth/authorize?client_id=${encodeURIComponent(`${ORIGIN}/question-client-metadata.json`)}`));
  const form = w.net.state.par[0].form;
  assert.equal(form.scope, ASK_SCOPE);
  assert.equal(form.scope, `atproto ${QUESTION_SCOPE}`);
  assert.equal(form.redirect_uri, `${ORIGIN}/questions`);
  assert.equal(form.client_id, `${ORIGIN}/question-client-metadata.json`);
  assert.equal(form.response_mode, 'fragment');
  assert.equal(w.ask.clientId, `${ORIGIN}/question-client-metadata.json`);
  assert.equal(w.endorse.clientId, `${ORIGIN}/endorse-client-metadata.json`, 'the endorse client unchanged');
  assert.ok(!w.net.calls.some((c) => c.url.startsWith(ORIGIN)), 'nothing went to Siren');
});

test('the granted scope is checked: a token without the question permission is revoked and refused', async () => {
  const w = setup();
  await assert.rejects(signIn(w, w.ask, OAUTH_SCOPE), { code: 'ask_scope_narrow' });
  assert.equal(await w.store.getSession(), null);
  assert.deepEqual(w.net.state.revokes.map((r) => r.form.token), [W.ACCESS]);
  assert.match(MESSAGES.ask_scope_narrow, /create and delete question records only/);
});

test('ask: a question record in the person\'s own repo, its address and version back; delete it again', async () => {
  const w = setup();
  const { out } = await signIn(w, w.ask, ASK_SCOPE);
  assert.equal(out.did, W.DID);
  const s = await w.store.getSession();
  assert.equal(s.scope, ASK_SCOPE);
  assert.equal(s.clientId, `${ORIGIN}/question-client-metadata.json`);
  const at = Date.parse('2026-11-10T12:00:30Z');
  const rec = await w.ask.askQuestion({ text: '  What is on my block at 810 Union St?  ', city: 'norfolk', now: at });
  const p = parseRecordUri(rec.uri);
  assert.deepEqual([p.did, p.collection], [W.DID, QUESTION_NSID]);
  assert.match(p.rkey, TID_RE, 'the PDS minted a TID');
  const write = w.net.state.pdsWrites.find((x) => x.method === 'createRecord');
  assert.equal(write.body.collection, QUESTION_NSID);
  assert.equal(write.body.rkey, undefined);
  assert.ok(!('validate' in write.body));
  const stored = w.net.state.repos.get(W.DID).get(QUESTION_NSID).get(p.rkey);
  assert.deepEqual(stored, { $type: QUESTION_NSID, text: 'What is on my block at 810 Union St?', city: 'norfolk', createdAt: '2026-11-10T12:00:30.000Z' }, 'stamped with the time the page passes (Siren\'s clock)');
  assert.ok(validQuestion(stored));
  assert.equal(rec.cid, w.net.state.cidOf(stored));
  // Too long, or empty: refused before anything is written.
  for (const text of ['x'.repeat(601), '   ']) await assert.rejects(w.ask.askQuestion({ text, city: 'norfolk' }), { code: 'bad_question' });
  // Delete it; someone else's record can't be named.
  await assert.rejects(w.ask.deleteQuestion(`at://did:plc:cccccccccccccccccccccccc/${QUESTION_NSID}/${p.rkey}`), { code: 'not_yours' });
  await assert.rejects(w.ask.deleteQuestion(`at://${W.DID}/app.bsky.feed.post/${p.rkey}`), { code: 'not_yours' });
  assert.deepEqual(await w.ask.deleteQuestion(rec.uri), { ok: true });
  assert.equal(w.net.state.repos.get(W.DID).get(QUESTION_NSID).has(p.rkey), false);
  // The endorse client has no question methods.
  assert.equal(w.endorse.askQuestion, undefined);
});

test('a follow-up: the record names its parent and its thread\'s root by strongRef', async () => {
  const w = setup();
  await signIn(w, w.ask, ASK_SCOPE);
  const root = await w.ask.askQuestion({ text: 'Root?', city: 'norfolk' });
  const parent = await w.ask.askQuestion({ text: 'Parent?', city: 'norfolk', reply: { root, parent: root } });
  const rec = await w.ask.askQuestion({ text: 'Follow-up?', city: 'norfolk', reply: { root: { uri: root.uri, cid: root.cid }, parent: { uri: parent.uri, cid: parent.cid, extra: 'dropped' } } });
  const stored = w.net.state.repos.get(W.DID).get(QUESTION_NSID).get(parseRecordUri(rec.uri).rkey);
  assert.deepEqual(stored.reply, { root: { uri: root.uri, cid: root.cid }, parent: { uri: parent.uri, cid: parent.cid } });
  assert.ok(validQuestion(stored));
  // A reply that doesn't name question records is refused before anything is written.
  const n = w.net.state.pdsWrites.length;
  for (const reply of [{ root, parent: { uri: 'at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3kabcdefghijk', cid: root.cid } }, { root, parent: { uri: root.uri, cid: 'NOT A CID' } }]) {
    await assert.rejects(w.ask.askQuestion({ text: 'q?', city: 'norfolk', reply }), { code: 'bad_question' });
  }
  assert.equal(w.net.state.pdsWrites.length, n);
});

test('one session for both pages: each page\'s action needs its own permission; signing in to ask keeps endorsing', async () => {
  const w = setup();
  // Signed in on the requests page: endorsing works, asking needs a fresh sign-in.
  await signIn(w, w.endorse, OAUTH_SCOPE);
  assert.deepEqual(await w.endorse.endorse({ id: ID, source: 'Tree inventory' }), { ok: true, already: false });
  await assert.rejects(w.ask.askQuestion({ text: 'q?', city: 'norfolk' }), { code: 'reauth' });
  // That sign-in, for the same account, asks for both permissions, so endorsing isn't lost.
  const { par } = await signIn(w, w.ask, ASK_CLIENT_SCOPE);
  assert.equal(par.scope, ASK_CLIENT_SCOPE);
  assert.equal(par.scope, `atproto ${QUESTION_SCOPE} ${ENDORSE_SCOPE}`);
  await w.ask.askQuestion({ text: 'q?', city: 'norfolk' });
  assert.deepEqual(await w.endorse.withdraw(ID), { ok: true, removed: 1 }, 'the requests page still endorses with that session');
  // Sign out revokes with the client the token belongs to.
  await w.endorse.signOut();
  assert.equal(w.net.state.revokes.at(-1).form.client_id, `${ORIGIN}/question-client-metadata.json`);
  // A question-only session on the requests page: endorsing re-authorizes there.
  await signIn(w, w.ask, ASK_SCOPE);
  await assert.rejects(w.endorse.endorse({ id: ID }), { code: 'reauth' });
  // A fresh sign-in with no live endorse session asks for the question permission alone.
  await w.ask.signOut();
  await w.ask.signIn(W.HANDLE);
  assert.equal(w.net.state.par.at(-1).form.scope, ASK_SCOPE);
});

test("a sign-in one page started can't be finished by the other's client", async () => {
  const w = setup();
  await w.endorse.signIn(W.HANDLE);
  const par = w.net.state.par.at(-1).form;
  await assert.rejects(w.ask.finish(`#state=${encodeURIComponent(par.state)}&iss=${encodeURIComponent(W.ISSUER)}&code=c`), { code: 'flow_expired' });
  await w.ask.signIn(W.HANDLE);
  const par2 = w.net.state.par.at(-1).form;
  await assert.rejects(w.endorse.finish(`#state=${encodeURIComponent(par2.state)}&iss=${encodeURIComponent(W.ISSUER)}&code=c`), { code: 'flow_expired' });
  assert.equal(w.net.state.tokens.length, 0, 'no token request');
});
