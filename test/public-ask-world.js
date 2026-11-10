// The free tier's test world (test/public-ask.test.js and
// test/public-ask-review.test.js): the fake atproto network, a D1 over
// node:sqlite with migration 0004, an invite, the public routes called
// directly, and a fake answer that records what the model would get.
import assert from 'node:assert/strict';
import { handlePublicAsk, handlePublicWithdraw, handleQuestions, handleQuestion } from '../worker/public-ask.js';
import { QUESTION_NSID, buildQuestion } from '../worker/endorse-config.js';
import { signSession } from '../worker/invites.js';
import { W, fakeNetwork, readyEnv, SECRET, didDoc } from './fake-atproto.js';
import { fakeD1 } from './fake-d1.js';

export const ORIGIN = 'https://ask-siren.jason-edelman.org';
export const NOW = Date.parse('2026-11-10T15:00:00Z');
export const INVITE_HASH = 'a'.repeat(64);
export const INVITE_COOKIE = `__Host-siren_invite=${await signSession(SECRET, INVITE_HASH, NOW)}`;
export const OTHER = 'did:plc:cccccccccccccccccccccccc';

export function world({ env: over = {}, now = NOW } = {}) {
  const net = fakeNetwork();
  const env = readyEnv({ PUBLIC_ASK: 'true', INVITE_REQUIRED: 'true', SIREN_DB: fakeD1(), ...over });
  env.LIMITS.store.set(`invite:${INVITE_HASH}`, { value: JSON.stringify({ label: 'test', max_uses: 5 }) });
  const answers = [];
  const w = { net, env, answers, clock: { t: now } };
  w.deps = (extra = {}) => ({
    base: '', cities: ['norfolk'], apiKey: 'sk-test', subrequestBudget: 120, fetchImpl: net.fetch, now: w.clock.t,
    answer: async ({ question, cityId, budget, history = [], carried = [] }) => {
      answers.push({ question, cityId, usedBefore: budget.used, history, carried });
      // A test may act while the answer is being worked out.
      if (w.duringAnswer) await w.duringAnswer();
      await budget.model('https://api.anthropic.com/v1/messages').catch(() => {});
      return {
        answer: `I found nothing for: ${question}`, trace: [{ n: 1, tool: 'query_dataset', ok: true, rows: 0, ms: 5, url: 'https://data.norfolk.gov/x' }], resources: { links: [{ title: 'Portal', url: 'https://data.norfolk.gov' }] }, voice: { ok: true }, model: 'claude-sonnet-5-5', steps: 1, cost: 0.002, requestBudget: budget.summary(),
        toolResults: [{ name: 'query_dataset', args: { soql: `about ${question}` }, content: JSON.stringify({ rows: [{ note: `rows for ${question}` }] }) }],
      };
    },
    ...extra,
  });
  /** A question record in the asker's own repo (W.DID on W.PDS): -> { uri, cid, rkey, record }. */
  w.record = ({ text = 'What is on my block at 810 Union St?', city = 'norfolk', at = w.clock.t, did = W.DID, extra = {}, reply = null } = {}) => {
    const rkey = net.state.nextTid();
    const record = { ...buildQuestion({ text, city, now: at, reply }), ...extra };
    net.state.putRecord(did, QUESTION_NSID, rkey, record, { index: false });
    return { uri: `at://${did}/${QUESTION_NSID}/${rkey}`, cid: net.state.cidOf(record), rkey, record };
  };
  w.ask = async (body, { cookie = INVITE_COOKIE, deps = {}, headers = {} } = {}) => {
    const waits = [];
    const req = new Request(`${ORIGIN}/api/public/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify(body) });
    const res = await handlePublicAsk(req, env, { waitUntil: (p) => waits.push(p) }, w.deps(deps));
    await Promise.all(waits);
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  w.withdraw = async (uri) => {
    const res = await handlePublicWithdraw(new Request(`${ORIGIN}/api/public/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri }) }), env, {}, { fetchImpl: net.fetch });
    return { status: res.status, body: await res.json() };
  };
  w.list = async (q = '') => {
    const res = await handleQuestions(new Request(`${ORIGIN}/api/questions${q}`), env, {}, { fetchImpl: net.fetch, cache: null, now: w.clock.t });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  w.one = async (id) => {
    const res = await handleQuestion(new Request(`${ORIGIN}/api/q/${id}`), env, {}, id, { fetchImpl: net.fetch, cache: null, now: w.clock.t });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return w;
}

export const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
export const CAROL = 'did:plc:cccccccccccccccccccccccc';
// Two more askers on the same PDS, each with a handle that resolves back.
export function threads(opts = {}) {
  const w = world({ env: { PER_INVITE_DAILY: '100', ADMIN_EMAILS: 'steward@example.org' }, ...opts });
  const handles = { [W.DID]: W.HANDLE, [BOB]: 'bob.fixture.dev', [CAROL]: 'carol.fixture.dev' };
  w.net.state.didDocs.set(BOB, didDoc({ did: BOB, handle: handles[BOB], pds: W.PDS }));
  w.net.state.didDocs.set(CAROL, didDoc({ did: CAROL, handle: handles[CAROL], pds: W.PDS }));
  w.handles = handles;
  // DNS for the handles; a test may wrap w.dns to act mid-request.
  w.dns = (u) => {
    const name = u.searchParams.get('name');
    const did = Object.keys(handles).find((d) => `_atproto.${handles[d]}` === name);
    return new Response(JSON.stringify(did ? { Status: 0, Answer: [{ name, type: 16, data: `"did=${did}"` }] } : { Status: 3 }), { headers: { 'Content-Type': 'application/json' } });
  };
  w.net.routes['dns.fixture.dev/dns-query'] = (u) => w.dns(u);
  const ref = (r) => ({ uri: r.uri, cid: r.cid });
  /** Ask, and return the record with its public id. `on`: the parent's record; `root`: the thread's root record. */
  w.q = async (text, { did = W.DID, on = null, root = null, expect = 200 } = {}) => {
    const rec = w.record({ text, did, reply: on ? { root: ref(root || on), parent: ref(on) } : null });
    const out = await w.ask({ uri: rec.uri, cid: rec.cid });
    assert.equal(out.status, expect, `${text}: ${JSON.stringify(out.body)}`);
    return { ...rec, id: out.body.id, out };
  };
  /** The asker deletes the record in their own account, without Siren's page. */
  w.del = (r) => w.net.state.repos.get(r.uri.split('/')[2]).get(QUESTION_NSID).delete(r.rkey);
  w.remove = async (r) => {
    w.del(r);
    assert.equal((await w.withdraw(r.uri)).status, 200);
  };
  return w;
}
