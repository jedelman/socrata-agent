// Gaps in Siren's answers (docs/gaps.md §8, §15 items 4 and 5) and absence
// lines (§8.6). Fakes only: no network, no spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ask, createContext } from '../src/agent.js';
import { toolsFor, runTool } from '../src/tools.js';
import { systemPrompt } from '../src/prompt.js';
import { pluginContext } from '../src/plugins.js';
import { getCity } from '../src/cities/index.js';
import { gapCheck } from '../src/gaps/kinds.js';
import { absenceFor, gapStatementsFor, matchGaps, liveGaps, refilterUnanswered, turnFacts, touches, ABSENCE_ADAPTERS } from '../src/gaps/answer.js';
import { CASES } from '../src/gaps/cases.js';
import { treesKey } from './fixtures/trees-live.js';
import { gapsOffScenario } from './fixtures/gaps-off-scenario.js';
import { buildGaps, Recorder } from '../scripts/build-gaps.js';
import { saveTurn } from '../worker/conversations.js';
import trees from '../plugins/trees-on-my-block.js';
import { theRecord } from '../plugins/cases.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// The gap file replayed from its stored responses against today's case files,
// dated the day of the stored build: the code under test sees all 13 gaps
// whatever day npm test runs, and a case-file edit the committed file hasn't
// caught up with yet (CI's check-gaps job flags that) can't fail it.
const TRACE = JSON.parse(read('data/gaps/norfolk.trace.json'));
const DATA = (await buildGaps({ recorder: new Recorder({ responses: TRACE.responses }), today: TRACE.built, previous: JSON.parse(read('data/gaps/norfolk.json')) })).file;
const STREETS = JSON.parse(read('data/gaps/norfolk-streets.json')).streets;
const GAPS = { data: DATA, streets: STREETS };
const norfolk = getCity('norfolk');
const NO_STREET = 'norfolk.work-orders.removal-no-street';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A scripted model: each reply is { tools: [[name, args]...] } or { text }. */
function fakeWorld(replies, { socrata = () => [{ n: '1' }] } = {}) {
  const bodies = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://openrouter.ai')) {
      bodies.push(JSON.parse(init.body));
      const r = replies[Math.min(i++, replies.length - 1)];
      const message = r.tools ? { content: '', tool_calls: r.tools.map(([name, args], k) => call(`c${i}-${k}`, name, args)) } : { content: r.text };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { cost: 0.001 } }));
    }
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Work Orders', columns: [] }));
    const body = socrata(u);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body));
  };
  return { fetchImpl, bodies };
}

const strip = (out) => JSON.parse(JSON.stringify(out, (k, v) => (k === 'ms' ? 0 : v)));

test('gaps off: the prompt, tools and answer keys are unchanged, and note_unanswered is an unknown tool', async () => {
  const today = '2026-11-06';
  assert.equal(systemPrompt(norfolk, today), systemPrompt(norfolk, today, {}));
  assert.doesNotMatch(systemPrompt(norfolk, today), /note_unanswered/);
  assert.match(systemPrompt(norfolk, today, { gaps: true }), /call note_unanswered with a citywide version/);
  assert.deepEqual(toolsFor(norfolk), toolsFor(norfolk, [], {}));
  assert.ok(!toolsFor(norfolk).some((t) => t.function.name === 'note_unanswered'));
  const on = toolsFor(norfolk, [], { gaps: DATA }).map((t) => t.function.name);
  assert.equal(on[on.indexOf('suggest_data_source') + 1], 'note_unanswered');
  await assert.rejects(runTool(createContext({ city: norfolk }), 'note_unanswered', { question: 'x?', answered: 'no' }), /Unknown tool note_unanswered/);

  const script = [{ tools: [['note_unanswered', { question: 'Was a tree removed?', answered: 'no' }]] }, { text: 'I found 1 work order.' }];
  const a = await ask({ question: 'q', city: norfolk, apiKey: 'k', ...fakeWorld(script) });
  const b = await ask({ question: 'q', city: norfolk, apiKey: 'k', gaps: null, ...fakeWorld(script) });
  assert.deepEqual(strip(a), strip(b));
  assert.deepEqual(Object.keys(a).sort(), ['answer', 'cost', 'markdown', 'model', 'resources', 'steps', 'suggestions', 'toolResults', 'trace', 'voice']);
  assert.ok(a.trace.every((s) => !/gap catalog/.test(s.tool)));
  const ctx = createContext({ city: norfolk });
  assert.equal('gapStatements' in pluginContext(ctx), false);
});

test('gaps off: the prompt, core tools and a scripted answer are byte-identical to the merge base before gaps', async () => {
  const now = await gapsOffScenario({ ask, toolsFor, systemPrompt, getCity });
  assert.deepEqual(now, JSON.parse(read('test/fixtures/gaps-off-snapshot.json')));
});

test('gaps on: a query without the Forestry filter attaches no Forestry gap', async () => {
  const { fetchImpl, bodies } = fakeWorld([{ tools: [['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT area, count(*) AS n GROUP BY area' }]] }, { text: 'I found 2 areas.' }]);
  const out = await ask({ question: 'Work orders by area?', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  assert.deepEqual(out.gaps.shown, []);
  assert.equal(out.fallback, false);
  assert.deepEqual(out.unanswered, []);
  assert.match(bodies[0].messages[0].content, /note_unanswered/);
  assert.ok(bodies[0].tools.some((t) => t.function.name === 'note_unanswered'));
});

test('gaps on: a Forestry street query attaches and bites the no-street gap, with a cite step', async () => {
  const soql = "SELECT count(*) AS n WHERE area = 'Forestry' AND street = 'BOLLING' AND primary_task_description = 'Removal'";
  const { fetchImpl } = fakeWorld([{ tools: [['query_dataset', { dataset_id: 'qzfe-wj25', soql }]] }, { text: 'I found 1 Forestry removal on that street.' }]);
  const out = await ask({ question: 'Was a tree removed on Bolling?', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  const ids = out.gaps.shown.map((g) => g.gap);
  assert.equal(ids[0], NO_STREET);
  assert.equal(out.gaps.shown[0].bit, true);
  assert.ok(out.gaps.shown.length <= 3);
  assert.ok(out.gaps.more > 0, 'the rest are counted');
  assert.match(out.trace.at(-1).tool, /^read the gap catalog: \d+ gaps, measured \d{4}-\d{2}-\d{2}$/);
  assert.match(out.markdown.gaps, /Absent or empty field/);
});

test('gaps on: steps that errored attach nothing', async () => {
  const soql = "SELECT count(*) AS n WHERE area = 'Forestry'";
  const { fetchImpl } = fakeWorld([{ tools: [['query_dataset', { dataset_id: 'qzfe-wj25', soql }]] }, { text: 'I could not read the work orders.' }], {
    socrata: () => new Response('{"error":true,"message":"boom"}', { status: 500 }),
  });
  const out = await ask({ question: 'Forestry work?', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  assert.deepEqual(out.gaps.shown, []);
});

test('gaps on: a call that errored attaches nothing, though its dataset-name check succeeded', async () => {
  // The only call: a query on the tree inventory that fails after Socrata's
  // own metadata read (ok, with the dataset set) went through.
  const { fetchImpl } = fakeWorld([{ tools: [['query_dataset', { dataset_id: 'cmvv-agyb', soql: 'SELECT count(*) AS n' }]] }, { text: 'I could not read the tree inventory.' }], {
    socrata: () => new Response('{"error":true,"message":"boom"}', { status: 500 }),
  });
  const out = await ask({ question: 'How many city trees?', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  assert.ok(out.trace.some((s) => s.ok && s.dataset === 'cmvv-agyb' && !s.soql), 'the name check is in the trace, ok');
  assert.deepEqual(out.gaps.shown, []);
  assert.equal(out.gaps.more, 0);
});

test('touches: a step that succeeded inside a call that threw, and a bare metadata lookup, count for nothing', () => {
  const g = liveGaps(DATA).find((x) => (x.touches || []).some((p) => p.dataset === 'cmvv-agyb'));
  const query = { n: 1, ok: true, dataset: 'cmvv-agyb', soql: 'SELECT count(*) AS n', tool: 'query' };
  const lookup = { n: 2, ok: true, dataset: 'cmvv-agyb', tool: 'check dataset name' };
  const facts = (steps, errored = []) => turnFacts({ trace: { steps }, erroredSteps: new Set(errored), attempted: [] });
  assert.equal(touches(g, facts([query])), true);
  assert.equal(touches(g, facts([query], [query])), false, 'its call threw after the query returned');
  assert.equal(touches(g, facts([lookup])), false, 'a name check reads no records');
  assert.equal(touches(g, facts([{ ...lookup, tool: 'describe dataset' }])), true, 'a describe reads the dataset');
});

test('gaps on: a restricted refusal attaches the 311 gap through ctx.attempted', async () => {
  const { fetchImpl } = fakeWorld([{ tools: [['query_dataset', { dataset_id: 'nbyu-xjez', soql: 'SELECT count(*)' }]] }, { text: 'I found that I cannot query 311 requests.' }]);
  const out = await ask({ question: '311 tree requests?', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  assert.deepEqual(out.gaps.shown.map((g) => g.gap), ['norfolk.311.restricted']);
  assert.equal(out.gaps.shown[0].bit, true);
});

test('note_unanswered: checked against the batch, blanked on a house number or "will", once per question', async () => {
  const soql = "SELECT count(*) AS n WHERE area = 'Forestry'";
  const { fetchImpl } = fakeWorld([
    { tools: [['note_unanswered', { question: 'Was the tree at 1500 Bolling Ave removed?', answered: 'no', gaps: [NO_STREET, 'norfolk.311.restricted'] }], ['query_dataset', { dataset_id: 'qzfe-wj25', soql }]] },
    { tools: [['note_unanswered', { question: 'Second try?', answered: 'partly' }]] },
    { text: 'I found Forestry work orders, but not the one you asked about.' },
  ]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  assert.equal(out.unanswered.length, 1);
  assert.deepEqual(out.unanswered[0], { answered: 'no', gaps: [NO_STREET] }, 'the house-number draft is blanked; the untouched gap is dropped');
  assert.equal(out.gaps.noted, true, 'the panel opens when the question was noted');
  const first = JSON.parse(out.toolResults.find((t) => t.name === 'note_unanswered').content);
  assert.equal(first.noted, true);
  assert.equal(first.statements[0].gap, NO_STREET);
  assert.ok(first.general_questions.includes('Was a city tree removed on my street?'));
  assert.ok(out.gaps.shown.find((g) => g.gap === NO_STREET).named);

  const ctx = createContext({ city: norfolk });
  ctx.gaps = GAPS;
  ctx.attempted = [];
  ctx.unanswered = [];
  const r = await runTool(ctx, 'note_unanswered', { question: 'Will the City remove more trees next year?', answered: 'no' });
  assert.equal(r.noted, true);
  assert.equal('question' in ctx.unanswered[0], false, 'a "will" draft is blanked');
});

test('note_unanswered: refused after an excluded or withheld-column refusal; no text after a restricted one', async () => {
  const ctx = createContext({ city: norfolk });
  ctx.gaps = GAPS;
  ctx.unanswered = [];
  ctx.attempted = [{ name: 'query_dataset', ok: false, refusal: 'excluded' }];
  assert.deepEqual(await runTool(ctx, 'note_unanswered', { question: 'Who was arrested?', answered: 'no' }), { noted: false });
  ctx.attempted = [{ name: 'query_dataset', ok: false, refusal: 'restricted', dataset: 'nbyu-xjez' }];
  const r = await runTool(ctx, 'note_unanswered', { question: 'How many 311 tree requests citywide?', answered: 'no', gaps: ['norfolk.311.restricted'] });
  assert.equal(r.noted, true);
  assert.deepEqual(ctx.unanswered[0], { answered: 'no', gaps: ['norfolk.311.restricted'] });
});

test('note_unanswered: the refusal rules hold whatever order the batch runs in', async () => {
  const q = 'How many tree requests reached 311 citywide last year?';
  const note = ['note_unanswered', { question: q, answered: 'no', gaps: ['norfolk.311.restricted'] }];
  const restricted = ['query_dataset', { dataset_id: 'nbyu-xjez', soql: 'SELECT count(*) AS n' }];
  for (const batch of [[note, restricted], [restricted, note]]) {
    const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', gaps: GAPS, ...fakeWorld([{ tools: batch }, { text: 'I found no 311 records I can read.' }]) });
    assert.deepEqual(out.unanswered, [{ answered: 'no', gaps: ['norfolk.311.restricted'] }], batch.map((b) => b[0]).join(', '));
  }
  const excluded = ['query_dataset', { dataset_id: 'cab7-wvn5', soql: 'SELECT count(*) AS n' }];
  for (const batch of [[note, excluded], [excluded, note]]) {
    const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', gaps: GAPS, ...fakeWorld([{ tools: batch }, { text: 'I found nothing I can read.' }]) });
    assert.deepEqual(out.unanswered, [], batch.map((b) => b[0]).join(', '));
  }
});

test('an address miss attaches no gap, and a tool still to run gets no statements', async () => {
  const { fetchImpl } = fakeWorld([{ tools: [['block_report', { address: '99999 Nowhere Ln' }]] }, { text: 'I found no address matching that.' }], { socrata: () => [] });
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS, indexes: { 'norfolk-legislation': { built: '2026-11-02', items: [] } } });
  assert.deepEqual(out.gaps.shown, []);
  const ctx = createContext({ city: norfolk });
  ctx.gaps = GAPS;
  ctx.attempted = [];
  ctx.unanswered = [];
  ctx.batchCalls = [{ name: 'trees_on_my_block', args: { address: '99999 Nowhere Ln' } }];
  const r = await runTool(ctx, 'note_unanswered', { question: 'Was a city tree removed on my street?', answered: 'no', gaps: [NO_STREET] });
  assert.deepEqual(r.statements, []);
  assert.deepEqual(ctx.unanswered[0].gaps, [NO_STREET], 'noted, and checked again after the loop');
  assert.deepEqual(refilterUnanswered(ctx, [])[0].gaps, [], 'the tool never read tree data');
});

test('gaps on: the world-claim rewrite fires with the addendum', async () => {
  const { fetchImpl, bodies } = fakeWorld([{ text: 'The tree inventory has not been re-surveyed since about 2000.' }, { text: 'The inventory’s own description, as I read it, dates its original survey to the late 1990s/early 2000s.' }]);
  const out = await ask({ question: 'How old is the inventory?', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  assert.equal(out.voice.rewritten, true);
  assert.ok(out.voice.ok);
  assert.match(bodies[1].messages.at(-1).content, /^Rewrite your last answer.*Also rewrite every sentence that claims/s);
  const off = fakeWorld([{ text: 'The tree inventory has not been re-surveyed since about 2000.' }]);
  assert.equal((await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl: off.fetchImpl })).voice.rewritten, false, 'with gaps off the check is unchanged');
});

test('gaps on: a fallback answer gets no gaps and says so', async () => {
  const { fetchImpl } = fakeWorld([{ tools: [['query_dataset', { dataset_id: 'qzfe-wj25', soql: "SELECT count(*) WHERE area = 'Forestry'" }]] }, { text: '' }]);
  const out = await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS });
  assert.equal(out.fallback, true);
  assert.deepEqual(out.gaps.shown, []);
});

test('saved conversations keep only what note_unanswered noted, never the drafted question', async () => {
  const kv = { store: new Map(), async put(k, v) { this.store.set(k, v); } };
  const next = await saveTurn(kv, 'u'.repeat(32), 'c1', null, { city: 'norfolk', question: 'q', answer: 'a', tools: [{ name: 'note_unanswered', args: { question: 'Was the oak on my street removed?', answered: 'no', gaps: [NO_STREET] }, content: '{"noted":true}' }] });
  assert.deepEqual(next.turns[0].tools[0].args, { answered: 'no', gaps: [NO_STREET] });
  assert.equal(JSON.stringify(next).includes('oak'), false);
});

// The trees plugin against fakes, as in test/plugins.test.js.
function respondTrees(url, { removal = true } = {}) {
  const q = decodeURIComponent(url);
  if (url.includes('/api/views/')) return { name: 'some dataset', columns: [] };
  if (url.includes('/resource/ere7-kake'))
    return [{ full_address: '111 PENNSYLVANIA AVENUE', gpin: '1438184218', house_number: '111', full_street_name: 'PENNSYLVANIA AVENUE', street_name: 'PENNSYLVANIA', ward_district: '2', parcel_centroid_latitude: '36.88223592', parcel_centroid_longitude: '-76.28240994', census_tract_number: '28', civic_league: 'Colonial Place and Riverview' }];
  if (url.includes('/resource/qzfe-wj25')) {
    if (q.includes('min(created_datetime)')) return [{ first: '2020-08-05T08:31:36.000', last: '2026-11-05T15:32:11.000' }];
    if (q.includes('GROUP BY civic_league')) return [{ civic_league: 'Colonial Place/ Riverview', n: '324' }];
    if (q.includes('GROUP BY t, p')) return removal ? [{ t: 'Removal', p: 'Dead Tree', n: '2', cost: '900' }] : [{ t: 'Pruning', p: 'General Maintenance', n: '3', cost: '700' }];
    if (q.includes('GROUP BY t')) return [{ t: 'Removal', n: '60', cost: '30000' }, { t: 'Pruning', n: '70', cost: '18000' }, { t: 'Plantings', n: '12', cost: '3000' }];
    return [{ work_order_number: '25-1', primary_task_description: 'Pruning', problem_description: 'General Maintenance', status_description: 'Complete', created_datetime: '2025-08-25T00:00:00.000' }];
  }
  if (url.includes('/resource/cmvv-agyb')) {
    if (q.includes('GROUP BY civic_league')) return [{ civic_league: 'Colonial Place/ Riverview', n: '2100' }];
    if (q.includes('GROUP BY common_name')) return [{ common_name: 'Crapemyrtle', n: '12' }];
    if (q.includes('GROUP BY r')) return [{ r: '6" to 12"', n: '5' }, { n: '9' }];
    return [{ n: '93993' }];
  }
  throw new Error(`unexpected request ${url}`);
}

async function runTrees({ gaps, removal }) {
  const fetchImpl = async (url) => new Response(JSON.stringify(respondTrees(String(url), { removal })));
  const ctx = createContext({ city: norfolk, fetchImpl, plugins: [trees] });
  if (gaps) {
    ctx.gaps = gaps;
    ctx.attempted = [];
  }
  return { ctx, result: await trees.run(pluginContext(ctx), { address: '111 Pennsylvania Ave' }) };
}

// A live run, replayed: realistic sizes for the 16,000-character cut.
const LIVE_TREES = JSON.parse(read('test/fixtures/trees-111-pennsylvania.json'));
async function runLiveTrees(gaps) {
  const fetchImpl = async (url) => {
    const body = LIVE_TREES.responses[treesKey(url)];
    if (body === undefined) throw new Error(`no recorded response for ${url}`);
    return new Response(JSON.stringify(body));
  };
  const ctx = createContext({ city: norfolk, fetchImpl, plugins: [trees] });
  if (gaps) {
    ctx.gaps = gaps;
    ctx.attempted = [];
  }
  return { ctx, result: await trees.run(pluginContext(ctx), { address: LIVE_TREES.address }) };
}

test('on a live-sized trees answer, the caveats and what it couldn’t answer come before the 16,000-character cut', async () => {
  const CUT = 16000;
  const { result } = await runLiveTrees(GAPS);
  const json = JSON.stringify(result);
  assert.ok(json.length > CUT, `the recorded answer is ${json.length} characters, long enough to be cut`);
  // Everything up to the case file survives the cut whole.
  const record = json.indexOf('"the_record":');
  assert.ok(record > 0 && record < CUT);
  assert.deepEqual(Object.keys(result).at(-1), 'the_record', 'the case file comes last');
  for (const k of ['work_orders_cover', 'about_the_data']) assert.ok(json.indexOf(`"${k}":`) < record, k);
  const couldnt = JSON.stringify(result.the_record.what_i_couldnt_answer);
  assert.ok(json.indexOf(couldnt) > record && json.indexOf(couldnt) + couldnt.length < CUT, 'what_i_couldnt_answer survives');
  assert.ok(result.the_record.what_i_couldnt_answer.length >= 1 && result.the_record.what_i_couldnt_answer.length <= 3);
  for (const s of result.the_record.what_i_couldnt_answer) assert.deepEqual(gapCheck(s.statement, 'short'), []);
  assert.deepEqual(result.the_record.what_i_couldnt_answer, gapStatementsFor(DATA, 'norfolk-trees'));
  const off = await runLiveTrees(null);
  assert.equal('what_i_couldnt_answer' in off.result.the_record, false);
});

// With gaps off, trees_on_my_block returns what it did before gaps. On the
// recorded live run its result was compared byte for byte with the merge base
// (c5d7f58) when this was written. The test pins what gaps could change: the
// key order with gaps off, and that gaps on differs only in the case file's
// place and what_i_couldnt_answer. It doesn't freeze the rest, so the trees
// branch's own changes to the result don't fail the deploy gate on merge.
test('gaps off: trees_on_my_block keeps its key order, and gaps on changes only the case file', async () => {
  const { ctx, result } = await runLiveTrees(null);
  assert.deepEqual(Object.keys(result), ['address', 'near_you', 'on_your_street', 'civic_league', 'citywide', 'the_record', 'work_orders_cover', 'about_the_data']);
  assert.deepEqual(result.the_record, theRecord(pluginContext(ctx), CASES['norfolk-trees']));
  const on = await runLiveTrees(GAPS);
  const { what_i_couldnt_answer, ...rest } = on.result.the_record;
  assert.ok(what_i_couldnt_answer.length);
  assert.equal(Object.keys(on.result).at(-1), 'the_record');
  const back = Object.fromEntries(Object.keys(result).map((k) => [k, k === 'the_record' ? rest : on.result[k]]));
  assert.equal(JSON.stringify(back), JSON.stringify(result));
});

test('gap bites read the tool’s value, not its content cut at 16,000 characters', async () => {
  const { ctx, result } = await runLiveTrees(GAPS);
  const content = JSON.stringify(result);
  assert.ok(content.length > 16000);
  const cut = [{ name: 'trees_on_my_block', content: `${content.slice(0, 16000)}… [truncated]` }];
  const fromCut = matchGaps(ctx, cut);
  ctx.toolValues = [{ name: 'trees_on_my_block', value: result }];
  const fromValue = matchGaps(ctx, cut);
  const bitIds = (m) => m.all.filter((x) => x.bit).map((x) => x.g.id).sort();
  assert.ok(bitIds(fromValue).length > bitIds(fromCut).length, `${bitIds(fromValue)} vs ${bitIds(fromCut)}`);
  assert.ok(bitIds(fromValue).includes('norfolk.tree-inventory.no-usable-size'), 'a {tool, field} bite on near_you');
  // A filter on the gap's field outranks a tool that merely returned its part.
  assert.equal(fromValue.shown[0].g.id, NO_STREET);
});

test('a tool that read no topic dataset (an address-lookup miss) attaches no topic gap', async () => {
  const ctx = createContext({ city: norfolk });
  ctx.gaps = GAPS;
  ctx.attempted = [{ name: 'trees_on_my_block', ok: true }];
  ctx.toolValues = [{ name: 'trees_on_my_block', value: { match: null, candidates: [] } }];
  await ctx.trace.record({ tool: 'look up the address', dataset: 'ere7-kake', url: 'https://data.norfolk.gov/resource/ere7-kake.json' }, async () => ({ result: [], rows: 0 }));
  assert.deepEqual(matchGaps(ctx).all.filter((x) => x.g.topic), []);
});

test('a gap whose quoted finding is no longer verified in the bundled case file stays out of answers', () => {
  const quoting = DATA.gaps.filter((g) => g.evidence.some((e) => e.type === 'finding'));
  assert.ok(quoting.length >= 1);
  assert.equal(liveGaps(DATA).length, DATA.gaps.length, 'all hold today');
  const cases = structuredClone(CASES);
  const f = cases['norfolk-trees'].findings.find((x) => x.id === 'dominion');
  f.unverified = true;
  const live = liveGaps(DATA, cases).map((g) => g.id);
  assert.equal(live.includes('norfolk.utility.line-clearance'), false);
  assert.equal(live.length, DATA.gaps.length - 1);
  const changed = structuredClone(CASES);
  changed['norfolk-trees'].findings.find((x) => x.id === 'contract-removal').quote += ' (edited)';
  assert.equal(liveGaps(DATA, changed).some((g) => g.id === 'norfolk.work-orders.no-contract-link'), false);
});

test('note_unanswered drops the gaps property when no gap is live', () => {
  const empty = { ...DATA, gaps: [] };
  const tool = toolsFor(norfolk, [], { gaps: empty }).find((t) => t.function.name === 'note_unanswered');
  assert.equal('gaps' in tool.function.parameters.properties, false);
  const full = toolsFor(norfolk, [], { gaps: DATA }).find((t) => t.function.name === 'note_unanswered');
  assert.equal(full.function.parameters.properties.gaps.items.enum.length, DATA.gaps.length);
});

test('absence lines: only with the option on, only when the street shows no removal, and they pass the checks', async () => {
  const today = '2026-11-06';
  const none = await runTrees({ gaps: { ...GAPS, absenceLines: true }, removal: false });
  absenceFor(none.ctx, 'trees_on_my_block', none.result, today);
  assert.equal(none.ctx.absences.length, 1);
  const line = none.ctx.absences[0].line;
  assert.match(line, /^I found no Forestry work orders with task “Removal” on PENNSYLVANIA in ward 2 in the City's Work Orders records \(qzfe-wj25\), created through 2026-11-05, as I read them on 2026-11-06\. In Siren's gap catalog, measured \d{4}-\d{2}-\d{2}, I found no street on [\d,]+ of [\d,]+ Forestry removal work orders with status “Complete” \(\d+%\); a street search can't find those\.$/);
  assert.deepEqual(gapCheck(line, 'absence'), []);
  const facts = matchGaps(none.ctx, [{ name: 'trees_on_my_block', content: JSON.stringify(none.result) }]);
  assert.equal(facts.shown.find((x) => x.g.id === NO_STREET).bit, true);

  const some = await runTrees({ gaps: { ...GAPS, absenceLines: true }, removal: true });
  absenceFor(some.ctx, 'trees_on_my_block', some.result, today);
  assert.equal(some.ctx.absences, undefined, 'a removal on the street: no line');
  const off = await runTrees({ gaps: GAPS, removal: false });
  absenceFor(off.ctx, 'trees_on_my_block', off.result, today);
  assert.equal(off.ctx.absences, undefined, 'absence lines are off by default');
  const err = { ...none.result, on_your_street: { error: 'The address record has no street name or ward.' } };
  const ctx = createContext({ city: norfolk });
  ctx.gaps = { ...GAPS, absenceLines: true };
  absenceFor(ctx, 'trees_on_my_block', err, today);
  assert.equal(ctx.absences, undefined, 'an errored street query: no line');
  absenceFor(ctx, 'block_report', { datasets: [] }, today);
  assert.equal(ctx.absences, undefined, 'no block_report adapter');
  const capped = { ...none.result, on_your_street: { ...none.result.on_your_street, by_task_and_reason: Array.from({ length: 50 }, (_, i) => ({ task: 'Pruning', reason: `code ${i}`, work_orders: 1 })) } };
  absenceFor(ctx, 'trees_on_my_block', capped, today);
  assert.equal(ctx.absences, undefined, 'at the GROUP BY cap of 50 rows, no line');
  assert.equal(ABSENCE_ADAPTERS.trees_on_my_block.gap, NO_STREET);
});

test('an answer built only from block_report attaches no Forestry gap', async () => {
  const address = [{ full_address: '810 UNION STREET', gpin: '1', house_number: '810', full_street_name: 'UNION STREET', street_name: 'UNION', ward_district: '2', parcel_centroid_latitude: '36.85', parcel_centroid_longitude: '-76.29', census_tract_number: '1' }];
  const { fetchImpl } = fakeWorld([{ tools: [['block_report', { address: '810 Union St' }]] }, { text: 'I found 2 open work orders on the street.' }], {
    socrata: (u) => (u.includes('/resource/ere7-kake') ? address : u.includes('/resource/qzfe-wj25') ? [{ work_order_number: '1', area: 'Forestry', status_description: 'New Work Order' }] : []),
  });
  const out = await ask({ question: "What's on my block? 810 Union St", city: norfolk, apiKey: 'k', fetchImpl, gaps: GAPS, indexes: { 'norfolk-legislation': { built: '2026-11-02', items: [] } } });
  assert.ok(out.trace.some((s) => s.dataset === 'qzfe-wj25'), 'block_report read Work Orders');
  const forestry = out.gaps.shown.filter((g) => /work-orders|tree-inventory|utility/.test(g.gap));
  assert.deepEqual(forestry, []);
  assert.deepEqual(out.gaps.shown.map((g) => g.gap), ['norfolk.legislation.no-address']);
});
