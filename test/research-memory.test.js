// Research memory (docs/research-memory.md; Jason, 2026-11-11: research
// counts from "Public, shared, and within the account"). What carries over is
// where to look, never what an earlier answer concluded; the account scope
// reads only the account's own conversations; shared sources hold nothing
// about who shared them, and nothing that could point at an address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { researchTerms, topicSources, priorResearch, scoreTexts, enough, RECHECK_DAYS, MAX_HANDOFF, HOW_TO_USE, NOTHING_FOUND, SCOPE_LABELS } from '../src/prior-research.js';
import { ask, researchScopesFor } from '../src/agent.js';
import { toolsFor } from '../src/tools.js';
import { systemPrompt, RESEARCH_LINE } from '../src/prompt.js';
import { voiceViolations } from '../src/voice.js';
import { getCity } from '../src/cities/index.js';
import { definePlugin } from '../src/plugins.js';
import { compileStreets } from '../src/public-text.js';
import { Resources } from '../src/resources.js';
import { saveTurn, researchInConversations, answerRecord } from '../worker/conversations.js';
import { priorResearchFor, handleShare, handleResearchList, handleAdminResearch, searchShared, searchPublic, turnByAddress, SHARE_DAILY } from '../worker/research.js';
import { signUser, userId } from '../worker/accounts.js';
import { TOOL_LABELS } from '../worker/ask-stream.js';
import { fakeKV } from './fake-atproto.js';
import { fakeD1, hasSqlite } from './fake-d1.js';

const norfolk = getCity('norfolk');
const STREETS = compileStreets(JSON.parse(readFileSync(new URL('../data/gaps/norfolk-streets.json', import.meta.url), 'utf8')).streets);
const SECRET = 'test-secret-that-is-long-enough';
const ORIGIN = 'https://ask-siren.jason-edelman.org';
const LEGI = 'https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=7337';
const PLAN = 'https://www.norfolk.gov/DocumentCenter/View/81234/Downtown-Plan-2030';
const PAGE = 'https://data.norfolk.gov/d/qzfe-wj25';
const sqliteSkip = !hasSqlite && 'node:sqlite is missing';

// A hand-off with a topic's sources and every kind of thing that must not carry over.
const RESOURCES = {
  records: [
    { kind: 'legislation', title: 'Ordinance approving the MacArthur Center redevelopment agreement', url: LEGI },
    { kind: 'legislation', title: 'Conditional use permit for 1234 Granby Street', url: 'https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=7338' },
    { kind: 'web', title: 'Downtown plan for MacArthur', url: PLAN },
    { kind: 'web', title: 'Staff report', url: 'https://www.norfolk.gov/DocumentCenter/View/81235/810-Union-St-staff-report' },
    { kind: 'web', title: 'Report by Mr. Smith', url: 'https://www.norfolk.gov/DocumentCenter/View/1/x' },
    { kind: 'web', title: 'Colley Ave and 21st St corner study', url: 'https://www.norfolk.gov/DocumentCenter/View/2/y' },
    { kind: 'earlier', title: 'A pointer from before', url: 'https://www.norfolk.gov/DocumentCenter/View/3/z' },
  ],
  datasets: [{ id: 'qzfe-wj25', name: 'Work Orders', page: PAGE, csv: 'https://data.norfolk.gov/api/views/qzfe-wj25/rows.csv', docs: 'https://dev.socrata.com/foundry/data.norfolk.gov/qzfe-wj25', queries: ["https://data.norfolk.gov/resource/qzfe-wj25.csv?$where=address='810 UNION ST'"] }],
  contacts: [{ role: 'Council member', name: 'A council member', url: 'https://www.norfolk.gov/council' }],
  links: [{ title: 'Portal', url: 'https://data.norfolk.gov' }],
};

// ---- the text rules ----

test('researchTerms: keywords only, no stop words or city name, bounded, and errors never repeat the query', () => {
  assert.deepEqual(researchTerms("What's the plan for MacArthur Mall in Norfolk?", { cityName: 'Norfolk, VA' }), { terms: ['macarthur', 'mall'] });
  assert.deepEqual(researchTerms('MACARTHUR center MacArthur', {}).terms, ['macarthur', 'center']);
  assert.equal(researchTerms('one two three four five six seven eight nine', {}).terms.length, 6);
  for (const bad of ['', 'a', 'the and for', 'x'.repeat(101), 42, null]) {
    const r = researchTerms(bad, {});
    assert.ok(r.error, String(bad));
    if (typeof bad === 'string' && bad.length > 3) assert.ok(!r.error.includes(bad));
  }
  assert.equal(scoreTexts(['MacArthur Center', null, 'a mall'], ['macarthur', 'mall', 'plan']), 2);
  assert.equal(enough(1, ['a', 'b', 'c']), false);
  assert.equal(enough(2, ['a', 'b', 'c']), true);
  assert.equal(enough(1, ['a']), true);
});

test('topicSources: records of topic kinds and dataset pages only; filtered, nothing that could point at an address or a person', () => {
  const all = topicSources(RESOURCES);
  // Never a CSV, a query, API docs, a contact, a deployment link or an earlier pointer.
  for (const s of all) assert.ok(!/\.csv|\$where|dev\.socrata|council$|^https:\/\/data\.norfolk\.gov$/.test(s.url), s.url);
  assert.ok(!all.some((s) => s.kind === 'earlier'));
  assert.deepEqual(all.find((s) => s.kind === 'dataset'), { title: 'Work Orders', url: PAGE, kind: 'dataset' });
  const filtered = topicSources(RESOURCES, { filter: true, streets: STREETS }).map((s) => s.title);
  assert.deepEqual(filtered, ['Ordinance approving the MacArthur Center redevelopment agreement', 'Downtown plan for MacArthur', 'Work Orders']);
  // A turn that looked up an address: its legislation and meeting pages may have been found by that address.
  assert.deepEqual(topicSources(RESOURCES, { filter: true, byAddress: true, streets: STREETS }).map((s) => s.title), ['Downtown plan for MacArthur', 'Work Orders']);
  assert.equal(turnByAddress({ tools: [{ name: 'block_report' }] }), true);
  assert.equal(turnByAddress({ record: { trace: [{ tool: 'look up address' }] } }), true);
  assert.equal(turnByAddress({ question: "What's on my block? 810 Union St" }, STREETS), true);
  assert.equal(turnByAddress({ question: 'What is the plan for MacArthur Center?', tools: [{ name: 'find_legislation' }] }, STREETS), false);
});

// ---- the tool, the prompt, the loop ----

test('prior_research is declared only with the Worker\'s search, after offer_followup; no plugin may take its name; the prompt line only with it', () => {
  const names = (opts) => toolsFor(norfolk, [], opts).map((t) => t.function.name);
  assert.ok(!names().includes('prior_research'));
  assert.ok(!names({ priorResearch: { scopes: [] } }).includes('prior_research'));
  const on = names({ priorResearch: { scopes: ['account', 'shared'] } });
  assert.equal(on.at(-1), 'prior_research');
  assert.equal(on.indexOf('prior_research'), on.indexOf('offer_followup') + 1);
  const def = toolsFor(norfolk, [], { priorResearch: { scopes: ['public', 'shared'] } }).at(-1).function;
  assert.match(def.description, /public answers on this site, sources people shared/);
  assert.doesNotMatch(def.description, /own earlier conversations/);
  assert.throws(() => toolsFor(norfolk, [definePlugin({ name: 'prior_research', description: 'x', run() {} })]), /replace a core tool/);
  assert.ok(TOOL_LABELS.prior_research);
  // The prompt: byte-identical without it, one line after the follow-up line with it.
  assert.equal(systemPrompt(norfolk, '2026-11-11'), systemPrompt(norfolk, '2026-11-11', {}));
  assert.ok(!systemPrompt(norfolk, '2026-11-11').includes(RESEARCH_LINE));
  const p = systemPrompt(norfolk, '2026-11-11', { priorResearch: true });
  assert.ok(p.includes(RESEARCH_LINE));
  assert.equal(p.replace(RESEARCH_LINE, ''), systemPrompt(norfolk, '2026-11-11'));
  assert.deepEqual(voiceViolations(RESEARCH_LINE.replace(/"[^"]*"/g, '')), []);
  assert.deepEqual(voiceViolations(HOW_TO_USE.replace(/"[^"]*"/g, '')), []);
  assert.deepEqual(voiceViolations(NOTHING_FOUND), []);
  // A public thread never gets the account scope.
  const search = async () => ({});
  assert.deepEqual(researchScopesFor({ scopes: ['account', 'public', 'shared'], search }, true), ['public', 'shared']);
  assert.deepEqual(researchScopesFor({ scopes: ['account'], search }, true), []);
  assert.deepEqual(researchScopesFor({ scopes: ['account'] }, false), [], 'no search, no tool');
});

function scripted(replies) {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://openrouter.ai')) {
      bodies.push(JSON.parse(init.body));
      const r = replies[Math.min(n++, replies.length - 1)];
      const message = r.tools ? { content: '', tool_calls: r.tools.map(([name, args], k) => ({ id: `c${n}-${k}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { content: r.text };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { cost: 0.001 } }));
    }
    return new Response('[]');
  };
  return { fetchImpl, bodies };
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

test('through the loop: scopes labelled, sources dated (old ones marked recheck), no earlier answer text, pointers handed off apart, and the trace written by code', async () => {
  const asked = [];
  const priorResearchArg = {
    scopes: ['account', 'public', 'shared'],
    private: true,
    async search(terms, { scopes }) {
      asked.push({ terms, scopes });
      return {
        account: [{ day: daysAgo(2), question: 'What about MacArthur Center?', answer: 'SECRET EARLIER ANSWER', sources: [{ title: 'Ordinance approving the MacArthur Center redevelopment agreement', url: LEGI, kind: 'legislation', read: daysAgo(2) }] }],
        public: [{ day: daysAgo(40), question: 'MacArthur plans?', page: `${ORIGIN}/q/abcdefghijklmnop`, sources: [{ title: 'Downtown plan for MacArthur', url: PLAN, kind: 'web', read: daysAgo(40) }] }],
        shared: Array.from({ length: 12 }, (_, i) => ({ day: daysAgo(1), sources: [{ title: `MacArthur source ${i}`, url: `https://www.norfolk.gov/DocumentCenter/View/${900 + i}/s`, kind: 'source', read: daysAgo(1) }] })),
      };
    },
  };
  const { fetchImpl, bodies } = scripted([
    { tools: [['prior_research', { query: 'MacArthur Center plans' }]] },
    { text: `I found [the ordinance](${LEGI}), as of ${daysAgo(2)}.` },
  ]);
  const out = await ask({ question: 'What is the plan for MacArthur Center?', city: norfolk, apiKey: 'k', fetchImpl, priorResearch: priorResearchArg });
  assert.deepEqual(asked, [{ terms: ['macarthur', 'center'], scopes: ['account', 'public', 'shared'] }]);
  // The prompt and the tool went to the model.
  assert.ok(bodies[0].messages[0].content.includes(RESEARCH_LINE));
  assert.ok(bodies[0].tools.some((t) => t.function.name === 'prior_research'));
  const result = JSON.parse(out.toolResults.find((t) => t.name === 'prior_research').content);
  assert.equal(result.how_to_use, HOW_TO_USE);
  assert.deepEqual([...new Set(result.results.map((r) => r.scope))], ['account', 'public', 'shared']);
  for (const r of result.results) assert.equal(r.from, SCOPE_LABELS[r.scope]);
  assert.ok(!JSON.stringify(result).includes('SECRET EARLIER ANSWER'), 'never an earlier answer');
  assert.equal(result.results.find((r) => r.scope === 'public').sources[0].recheck, true, `read over ${RECHECK_DAYS} days ago`);
  assert.equal(result.results.find((r) => r.scope === 'account').sources[0].recheck, undefined);
  assert.equal(result.results.filter((r) => r.scope === 'shared').length, 10);
  // Pointers join the hand-off as 'earlier' records, at most MAX_HANDOFF, so the answer's link stands.
  const earlier = out.resources.records.filter((r) => r.kind === 'earlier');
  assert.equal(earlier.length, MAX_HANDOFF);
  assert.ok(earlier.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.read)));
  assert.match(out.answer, /\[the ordinance\]\(https\\:\/\/norfolkcityva/);
  // The record keeps read records first, pointers after, pointers capped at 10.
  const rec = answerRecord({ resources: { records: [...Array.from({ length: 12 }, (_, i) => ({ kind: 'earlier', title: `p${i}`, url: `https://x.gov/${i}`, read: '2026-11-01' })), { kind: 'legislation', title: 'read', url: LEGI }] } });
  assert.equal(rec.resources.records[0].title, 'read');
  assert.equal(rec.resources.records.filter((r) => r.kind === 'earlier').length, 10);
  assert.equal(rec.resources.records[1].read, '2026-11-01');
  // The trace step is code's: the scopes, the count, and (private) the words.
  const step = out.trace.find((t) => /earlier research/.test(t.tool));
  assert.match(step.tool, /your conversations, public answers, shared sources/);
  assert.equal(step.soql, 'macarthur center');
  assert.equal(step.rows, 14);
  // The markdown hand-off keeps them apart.
  const r = new Resources();
  r.addRecord({ kind: 'earlier', title: 'A [pointer]', url: PLAN, read: '2026-11-01' });
  assert.match(r.toMarkdown(), /\*\*Earlier research\*\*[\s\S]*read 2026-11-01/);
  assert.doesNotMatch(r.toMarkdown(), /Public records/);
});

test('a public thread: no account scope, no words in the trace; nothing found says so; off means an unknown tool', async () => {
  const asked = [];
  const pr = { scopes: ['account', 'public'], private: true, async search(terms, { scopes }) { asked.push(scopes); return {}; } };
  const { fetchImpl, bodies } = scripted([{ tools: [['prior_research', { query: 'MacArthur' }]] }, { text: 'I found nothing earlier.' }]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl, priorResearch: pr, publicThread: true, history: [] });
  assert.deepEqual(asked, [['public']]);
  assert.doesNotMatch(bodies[0].tools.find((t) => t.function.name === 'prior_research').function.description, /own earlier conversations/);
  const step = out.trace.find((t) => /earlier research/.test(t.tool));
  assert.equal(step.soql, undefined);
  assert.deepEqual(JSON.parse(out.toolResults[0].content), { searched: ['public'], results: [], note: NOTHING_FOUND });
  // Without the Worker's search the tool isn't declared, and a call to it is an error, whatever the model sends.
  const off = scripted([{ tools: [['prior_research', { query: 'MacArthur' }]] }, { text: 'ok' }]);
  const o = await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl: off.fetchImpl });
  assert.ok(!off.bodies[0].tools.some((t) => t.function.name === 'prior_research'));
  assert.equal(o.toolResults.length, 0);
});

// ---- the account scope ----

test('the account scope reads only the account\'s own conversations, never the one being answered, and never returns answer text', async () => {
  const kv = fakeKV();
  const turn = (question, answer, records) => ({ city: 'norfolk', question, answer, tools: [], record: { resources: { records } } });
  const mine1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const mine2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const theirs = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await saveTurn(kv, 'uid-me', mine1, null, turn('What is planned for MacArthur Center?', 'MY EARLIER ANSWER', [{ kind: 'legislation', title: 'MacArthur Center agreement', url: LEGI }]), { now: Date.parse('2026-11-01T12:00:00Z') });
  await saveTurn(kv, 'uid-me', mine2, null, turn('MacArthur again', 'x', [{ kind: 'web', title: 'Downtown plan', url: PLAN }]), { now: Date.parse('2026-11-05T12:00:00Z') });
  await saveTurn(kv, 'uid-them', theirs, null, turn('MacArthur Center', 'THEIR ANSWER', [{ kind: 'web', title: 'Their MacArthur page', url: 'https://www.norfolk.gov/DocumentCenter/View/77/theirs' }]), { now: Date.parse('2026-11-06T12:00:00Z') });
  const setup = kv.ops.length;
  const found = await researchInConversations(kv, 'uid-me', ['macarthur', 'center'], { exclude: mine2 });
  assert.deepEqual(found, [{ day: '2026-11-01', question: 'What is planned for MacArthur Center?', sources: [{ title: 'MacArthur Center agreement', url: LEGI, kind: 'legislation', read: '2026-11-01' }] }]);
  assert.ok(!JSON.stringify(found).includes('EARLIER ANSWER'));
  const both = await researchInConversations(kv, 'uid-me', ['macarthur']);
  assert.equal(both.length, 2);
  assert.ok(!JSON.stringify(both).includes('theirs') && !JSON.stringify(both).includes('THEIR'));
  // Only the account's own keys were ever listed or read.
  for (const op of kv.ops.slice(setup)) {
    const keys = op.keys || (op.key ? [op.key] : []);
    for (const k of keys) assert.ok(!k.includes('uid-them'), k);
    if (op.op === 'list') assert.ok(String(op.prefix || '').startsWith('conv:uid-me:'), JSON.stringify(op));
  }
  // The Worker's search: account only with a signed-in account; PRIOR_RESEARCH = "off" turns it all off.
  assert.equal(priorResearchFor({ LIMITS: kv }, {}), null);
  assert.deepEqual(priorResearchFor({ LIMITS: kv }, { uid: 'uid-me' }).scopes, ['account']);
  assert.equal(priorResearchFor({ LIMITS: kv, PRIOR_RESEARCH: 'off' }, { uid: 'uid-me' }), null);
  const got = await priorResearchFor({ LIMITS: kv }, { uid: 'uid-me', exclude: mine1 }).search(['macarthur'], { scopes: ['account'] });
  assert.deepEqual(got.account.map((m) => m.question), ['MacArthur again']);
});

// ---- shared research: sharing, the list, the steward ----

const ME = await userId(SECRET, 'me@example.org');
const THEM = await userId(SECRET, 'them@example.org');

async function sharedWorld({ on = 'true' } = {}) {
  const kv = fakeKV();
  const db = fakeD1({ migrations: ['0004_public_questions.sql', '0005_shared_sources.sql'] });
  const steward = await userId(SECRET, 'steward@example.org');
  const env = { SHARED_RESEARCH: on, SIREN_DB: db, LIMITS: kv, INVITE_SECRET: SECRET, PUBLIC_ORIGIN: ORIGIN, BASE_PATH: '', ADMIN_EMAILS: 'steward@example.org' };
  const cookie = async (uid) => `__Host-siren_user=${await signUser(SECRET, uid)}`;
  const conv = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const now = Date.parse('2026-11-10T15:00:00Z');
  await saveTurn(kv, ME, conv, null, { city: 'norfolk', question: 'What is planned for MacArthur Center?', answer: 'my answer', tools: [{ name: 'find_legislation', args: {}, content: '{}' }], record: { resources: RESOURCES, trace: [] } }, { now });
  const at = new Date(now).toISOString();
  const share = async (body, { uid = ME, headers = {} } = {}) => {
    const res = await handleShare(new Request(`${ORIGIN}/api/research/share`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(uid ? { Cookie: await cookie(uid) } : {}), ...headers }, body: JSON.stringify(body) }), env, { streetsFor: () => STREETS, now });
    return { status: res.status, body: await res.json() };
  };
  const list = async (q = '') => {
    const res = await handleResearchList(new Request(`${ORIGIN}/api/research${q}`), env, { cities: ['norfolk'] });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const admin = async (path, body, uid = steward) => {
    const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: await cookie(uid) }, body: JSON.stringify(body) } : { headers: { Cookie: await cookie(uid) } };
    const res = await handleAdminResearch(new Request(`${ORIGIN}${path}`, init), env, path);
    return { status: res.status, body: await res.json() };
  };
  return { kv, db, env, conv, at, share, list, admin };
}

test('sharing keeps a saved answer\'s topic sources only: no account, question, answer, address or person; days only', { skip: sqliteSkip }, async () => {
  const w = await sharedWorld();
  const r = await w.share({ conversation: w.conv, at: w.at });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { shared: 3, left_out: 4 });
  const rows = w.db.db.prepare('SELECT * FROM shared_sources ORDER BY seq').all().map((x) => ({ ...x }));
  assert.deepEqual(rows.map((x) => x.title), ['Ordinance approving the MacArthur Center redevelopment agreement', 'Downtown plan for MacArthur', 'Work Orders']);
  const stored = JSON.stringify(rows);
  for (const never of [ME, 'What is planned', 'my answer', '1234 Granby', '810', 'Smith', 'Colley', '.csv', w.conv]) assert.ok(!stored.includes(never), never);
  for (const x of rows) {
    assert.deepEqual(Object.keys(x).sort(), ['city', 'first_day', 'id', 'kind', 'last_day', 'read_day', 'seq', 'shares', 'status', 'title', 'url']);
    assert.equal(x.read_day, '2026-11-10');
    assert.match(x.id, /^[a-z2-7]{16}$/);
  }
  // Only the share statements touched D1; none carried the account.
  for (const s of w.db.log) assert.ok(!JSON.stringify(s.params).includes(ME));
  // The public list: newest first, nothing about who shared.
  const l = await w.list();
  assert.equal(l.status, 200);
  assert.deepEqual(l.body.sources.map((s) => s.title), ['Work Orders', 'Downtown plan for MacArthur', 'Ordinance approving the MacArthur Center redevelopment agreement']);
  assert.deepEqual(Object.keys(l.body.sources[0]).sort(), ['city', 'first_day', 'id', 'kind', 'last_day', 'read_day', 'shares', 'title', 'url']);
  assert.equal((await w.list('?city=seattle')).status, 400);
  const page = await w.list('?limit=2');
  assert.equal(page.body.sources.length, 2);
  assert.equal((await w.list(`?limit=2&before=${page.body.next}`)).body.sources.length, 1);
  // Sharing again counts, and a removed source stays removed.
  const id = l.body.sources.find((s) => s.kind === 'web').id;
  assert.equal((await w.admin('/api/admin/research/remove', { id }, ME)).status, 403, 'stewards only');
  assert.equal((await w.admin('/api/admin/research/remove', { id })).status, 200);
  assert.equal((await w.share({ conversation: w.conv, at: w.at })).status, 200);
  const after = await w.list();
  assert.ok(!after.body.sources.some((s) => s.id === id), 'gone from the list at once');
  assert.ok(after.body.sources.every((s) => s.shares === 2));
  const found = await searchShared(w.db, 'norfolk', ['macarthur']);
  assert.deepEqual(found.map((m) => m.sources[0].title), ['Ordinance approving the MacArthur Center redevelopment agreement'], 'and from prior_research');
  assert.equal((await w.admin('/api/admin/research')).body.sources.find((s) => s.id === id).status, 'removed');
  assert.equal((await w.admin('/api/admin/research/restore', { id })).status, 200);
  assert.equal((await searchShared(w.db, 'norfolk', ['macarthur'])).length, 2);
});

test('sharing: signed out, someone else\'s or an unsaved answer, cross-site, the daily limit, and the flag', { skip: sqliteSkip }, async () => {
  const w = await sharedWorld();
  assert.equal((await w.share({ conversation: w.conv, at: w.at }, { uid: null })).status, 401);
  assert.equal((await w.share({ conversation: w.conv, at: w.at }, { uid: THEM })).status, 404, 'another account\'s conversation is not found');
  assert.equal((await w.share({ conversation: w.conv, at: '2026-11-10T15:00:01.000Z' })).status, 409, 'still being saved');
  assert.equal((await w.share({ conversation: w.conv, at: 'yesterday' })).status, 400);
  assert.equal((await w.share({ conversation: w.conv, at: w.at }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  for (let i = 0; i < SHARE_DAILY; i++) assert.equal((await w.share({ conversation: w.conv, at: w.at })).status, 200);
  assert.equal((await w.share({ conversation: w.conv, at: w.at })).status, 429);
  const keys = [...w.kv.store.keys()].filter((k) => k.startsWith('share-rate:'));
  assert.equal(keys.length, 1);
  assert.ok(!keys[0].includes(ME), 'the counter can\'t be joined to the account');
  // Off or not set up: 503 from the handlers (the Worker doesn't route them at all when off).
  const off = await sharedWorld({ on: 'false' });
  assert.equal((await off.share({ conversation: off.conv, at: off.at })).status, 503);
  assert.equal((await off.list()).status, 503);
  assert.equal(priorResearchFor(off.env, {}), null);
  assert.deepEqual(priorResearchFor(w.env, {}).scopes, ['shared']);
});

test('the public scope: answered questions only, never one naming an address or person, only filtered sources, never the answer', { skip: sqliteSkip }, async () => {
  const db = fakeD1({ migrations: ['0004_public_questions.sql', '0005_shared_sources.sql'] });
  const put = (id, status, question, record, tools = []) => db.db.prepare("INSERT INTO public_questions (id, question_uri, status, day, city, question, answer, record, tools) VALUES (?, ?, ?, '2026-11-09', 'norfolk', ?, 'THE PUBLIC ANSWER about MacArthur', ?, ?)").run(id, `at://did:plc:x/q/${id}`, status, question, JSON.stringify(record), JSON.stringify(tools));
  put('aaaaaaaaaaaaaaaa', 'answered', 'What is the plan for MacArthur Center?', { resources: RESOURCES });
  put('bbbbbbbbbbbbbbbb', 'hidden', 'MacArthur Center hidden', { resources: RESOURCES });
  put('cccccccccccccccc', 'answered', 'MacArthur Center near 810 Union St?', { resources: RESOURCES });
  put('dddddddddddddddd', 'answered', 'MacArthur Center by block report', { resources: RESOURCES }, [{ name: 'block_report' }]);
  const found = await searchPublic(db, 'norfolk', ['macarthur', 'center'], { streets: STREETS, pageBase: ORIGIN });
  assert.deepEqual(found.map((m) => m.page), [`${ORIGIN}/q/dddddddddddddddd`, `${ORIGIN}/q/aaaaaaaaaaaaaaaa`]);
  assert.ok(!JSON.stringify(found).includes('THE PUBLIC ANSWER'));
  assert.deepEqual(found[1].sources.map((s) => s.title), ['Ordinance approving the MacArthur Center redevelopment agreement', 'Downtown plan for MacArthur', 'Work Orders']);
  assert.deepEqual(found[0].sources.map((s) => s.title), ['Downtown plan for MacArthur', 'Work Orders'], 'no legislation from an address turn');
  // A query term with LIKE's wildcards matches them literally.
  assert.deepEqual(await searchPublic(db, 'norfolk', ['%%%'], { streets: STREETS, pageBase: ORIGIN }), []);
});

// ---- the Worker with the flag off ----

const skipHook = typeof nodeModule.registerHooks !== 'function' && 'node:module has no registerHooks';
test('flag off: the new paths are 404s, the session and the answer body carry nothing new', { skip: skipHook }, async () => {
  const asText = (url) => ({ format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true });
  nodeModule.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && (context.importAttributes?.type === 'text' || url.endsWith('.html'))) return asText(url);
      if (url.startsWith('file:') && url.endsWith('.json') && !context.importAttributes?.type) return { format: 'module', source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`, shortCircuit: true };
      return next(url, context);
    },
  });
  const worker = (await import('../worker/index.js')).default;
  const env = { LIMITS: fakeKV(), INVITE_SECRET: SECRET, IP_SALT: 's', SIREN_DB: { prepare() { throw new Error('D1 touched'); } } };
  for (const [method, path] of [['GET', '/api/research'], ['POST', '/api/research/share'], ['GET', '/admin/research'], ['GET', '/api/admin/research'], ['POST', '/api/admin/research/remove']]) {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) }), env, {});
    assert.equal(res.status, 404, path);
  }
  const s = await (await worker.fetch(new Request(`${ORIGIN}/api/session`), env, {})).json();
  assert.ok(!('share_research' in s));
});
