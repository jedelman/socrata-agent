// An answer written beside card tools (offer_followup, suggest_data_source,
// offer_watch) is the answer. The model trial of 2026-11-20 found Siren's
// text dropped whenever she wrote her answer and asked for a follow-up
// button in the same reply: the loop asked again and kept only "I've added a
// button under the answer." And a source request can't ask for records that
// find a person (the same trial: one run asked for the Assessor's ownership
// records "and how to contact the owner").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ask, createContext, CARD_TOOLS, CARD_TEXT_NOTE } from '../src/agent.js';
import { runTool, seeksPerson, PERSON_SOURCE_NOTE } from '../src/tools.js';
import { getCity } from '../src/cities/index.js';
import { definePlugin } from '../src/plugins.js';
import { claudeResponse } from './fake-claude.js';

const norfolk = getCity('norfolk');
const LEGI = 'https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=5949';
const ANSWER = 'I found Ordinance 50487, which approved a cooperation agreement for the Military Circle site. Council adopted it on August 25, 2026. The City advances $200,000 to the Economic Development Authority, repaid from a state grant.';
const SHORT = 'I found Ordinance 50487 for the Military Circle site.';

// OpenRouter-shaped replies: each may carry text, tool calls, or both.
function scripted(replies) {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://openrouter.ai')) {
      bodies.push(JSON.parse(init.body));
      const r = replies[Math.min(n++, replies.length - 1)];
      const message = { content: r.text ?? '', ...(r.tools ? { tool_calls: r.tools.map(([name, args], k) => ({ id: `c${n}-${k}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : {}) };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { cost: 0.001 } }));
    }
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Work Orders' }));
    return new Response(JSON.stringify([{ n: '1' }]));
  };
  return { fetchImpl, bodies, calls: () => n };
}
// Hands off one legislation record, as the iqm2 tools do, so a follow-up can offer it.
const recordPlugin = definePlugin({
  name: 'the_record_tool',
  description: 'Hands off a record.',
  async run(ctx) {
    ctx.resources.addRecord({ kind: 'legislation', title: 'Ordinance 50487: Cooperation agreement', url: LEGI });
    return { url: LEGI };
  },
});
const FOLLOWUP = ['offer_followup', { question: 'What does the cooperation agreement say about repayment?', source_title: 'x', url: LEGI }];

test('the card tools only add a card: note_unanswered feeds the answer, and offer_watch can carry notes the answer must say', () => {
  assert.deepEqual([...CARD_TOOLS].sort(), ['offer_followup', 'suggest_data_source']);
  assert.ok(ANSWER.length >= 200 && SHORT.length < 200);
});

test('text written beside a follow-up button is the answer, and no further call is made to say so', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    { text: ANSWER, tools: [FOLLOWUP] },
    { text: "I've added a button under the answer." },
  ]);
  const out = await ask({ question: "What's the plan for Military Circle?", city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(out.answer, ANSWER);
  assert.equal(s.calls(), 2, 'the reply about the button is never asked for');
  assert.equal(out.followups.length, 1);
  assert.equal(out.followups[0].url, LEGI);
  assert.equal(out.steps, 2);
});

const TREES = 'I found no separate figure for tree care in the records I reach. The closest is Parks and Forestry Operations, budgeted at $13,139,514 for FY2027, which also covers mowing, landscaping and athletic fields, so it is more than trees.';
test('text beside a source request is the answer too', async () => {
  const s = scripted([
    { text: TREES, tools: [['suggest_data_source', { need: 'Tree care spending as its own line', source: 'Park and Forestry Operations budget detail by activity', why: 'It would split tree work from grounds work.' }]] },
    { text: 'The button below will send that request.' },
  ]);
  const out = await ask({ question: 'How much does Norfolk budget for tree care?', city: norfolk, apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(out.answer, TREES);
  assert.equal(out.suggestions.length, 1);
  assert.equal(s.calls(), 1);
});

test('text that reads as a step, not an answer, goes on with the card-text note: a short line, a "Let me" opener, a closing colon', async () => {
  const longLinks = `I've also offered to read [the cooperation agreement](${LEGI}&a=${'x'.repeat(60)}) and [the companion ordinance](${LEGI}&b=${'y'.repeat(60)}) next, each with a button under this answer.`;
  assert.ok(longLinks.length >= 200, 'long only because of its URLs');
  for (const step of [SHORT, `Let me add a button for the agreement. ${ANSWER}`, `${ANSWER} Here is what the agreement covers:`, longLinks, `Adding a follow-up so you can have me read the agreement next. I found the ordinance and its exhibit, and the button under this answer will ask me to read the rest of it for you.`]) {
    const s = scripted([
      { tools: [['the_record_tool', {}]] },
      { text: step, tools: [FOLLOWUP] },
      { text: ANSWER },
    ]);
    const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
    assert.equal(s.calls(), 3, step.slice(0, 40));
    assert.equal(out.answer, ANSWER);
    assert.equal(s.bodies[2].messages.at(-1).content, CARD_TEXT_NOTE);
    assert.equal(out.followups.length, 1, 'the card made on the way stays');
  }
});

test('a card asked for beside another tool keeps the loop going with the card-text note; an empty reply after it gets the honest fallback, and no rewrite', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    { text: 'There is more: let me check the work orders too.', tools: [FOLLOWUP, ['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT count(*) AS n' }]] },
    { text: '' },
  ]);
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(s.calls(), 3, 'a research tool ran, so the model was asked again, and nothing after');
  assert.equal(s.bodies[2].messages.at(-1).content, CARD_TEXT_NOTE);
  assert.match(out.answer, /^I couldn't put an answer together/, 'never the step text, which broke the voice check too');
});

test('a refused card followed by an empty reply never ships the refused turn\'s text', async () => {
  const s = scripted([
    { text: `I've asked for the Assessor's ownership records to be added; you can request them below. ${ANSWER}`, tools: [['suggest_data_source', { need: 'Who owns 810 Union St', source: 'Assessor ownership records', why: 'It would show the owner.' }]] },
    { text: '' },
  ]);
  const out = await ask({ question: 'Who owns 810 Union St?', city: norfolk, apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.match(out.answer, /^I couldn't put an answer together/);
  assert.equal(out.suggestions.length, 0);
});

test('a reply with text of its own after a mixed turn is still the answer', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    { text: 'Let me check the work orders too.', tools: [FOLLOWUP, ['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT count(*) AS n' }]] },
    { text: `${ANSWER} I found one work order as well.` },
  ]);
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(out.answer, `${ANSWER} I found one work order as well.`);
});

test('a voice rewrite after an answer that ended beside a card gets the card results first, then the instruction', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    { text: `There is an ordinance, 50487, for the Military Circle site. ${ANSWER}`, tools: [FOLLOWUP] },
    { text: ANSWER },
  ]);
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(out.voice.rewritten, true);
  assert.equal(out.answer, ANSWER);
  assert.equal(s.calls(), 3);
  const sent = s.bodies[2].messages;
  const [assistant, toolMsg, instruction] = sent.slice(-3);
  assert.equal(assistant.role, 'assistant');
  assert.ok(assistant.tool_calls?.some((c) => c.function.name === 'offer_followup'), 'the card turn is in once');
  assert.equal(toolMsg.role, 'tool', 'its tool call is answered');
  assert.equal(instruction.role, 'user');
  assert.equal(sent.filter((m) => m.role === 'assistant' && m.tool_calls?.some((c) => c.function.name === 'offer_followup')).length, 1, 'not appended twice');
  assert.equal(out.followups.length, 1, 'the card stays');
});

test('a source request can\'t ask for records that find who owns, bought, rents or lives at a place, or how to reach them', async () => {
  for (const t of [
    'Who is the owner of record for the parcel at 810 Union St, Norfolk, and how to contact the owner',
    'The owner of record for a specific house. Real Estate Assessor parcel ownership records. It would show the owner of record.',
    'Which LLC owns the apartment complex on Granby',
    'Who bought the house on my block',
    'Rental registry with landlord details',
    'Occupant list for the building',
    'Property owner contact information for rental units',
    'Who owns the vacant lots on Church Street',
    'Names of residents on my block',
    'Mailing addresses for property owners',
    'How to contact the owner of a house',
    'Whose house is on the corner',
    'The current owner of the property at 810 Union St',
    "Who's the landlord at 123 Main St",
    'Who is renting the house at 123 Main St',
    'Who is living in the apartment next door',
    'who resides at 400 Granby St',
    'Tenant at 810 Union St',
    'Parcel ownership for 810 Union St',
    'Name and address of the owner',
    'Phone number for the landlord',
    'Deed records showing who holds title to 810 Union St',
    'Taxpayer mailing address for 810 Union St',
    'Grantee on the latest deed',
  ]) assert.equal(seeksPerson(t), true, t);
  for (const t of [
    'How residents can contact their council member',
    'Landlord-tenant mediation program: how to reach the program office',
    'Homeowner grant program, apply by phone',
    'Who decides which residents get a parking permit',
    'How much Norfolk budgets for street tree care, Park and Forestry Operations program budget detail',
    'Which parcels does the City own: Assessor ownership records for City-owned land',
    'Rental inspection program rules for landlords, Norfolk City Code chapter 27',
    'Who decides rezonings, and how are neighbors notified? Norfolk Zoning Ordinance',
    'Who maintains the trees in front of homeowners houses? City Code chapter 45',
    'Short-term rental permits issued by year',
    'Number of owner-occupied homes by neighborhood',
    "Contact tenants' rights organizations",
    "List of residents' rights under the VRLTA",
    'Call the owner-occupancy inspection program',
    'Who owns Harbor Park',
    'Ownership information for parcels the City sold',
    'Dr. Martin Luther King Jr. Blvd paving plan',
    'Tenant rights guide from NRHA',
    'Who owns the vacant lot on Church Street owned by the City, and what is planned for it',
  ]) assert.equal(seeksPerson(t), false, t);
  // Clipped as kept, so a huge request is cheap to check.
  const t0 = Date.now();
  await runTool(createContext({ city: norfolk }), 'suggest_data_source', { need: 'who '.repeat(20000), source: 'x'.repeat(50000), why: 'y' });
  assert.ok(Date.now() - t0 < 200);
  const ctx = createContext({ city: norfolk });
  const refused = await runTool(ctx, 'suggest_data_source', { need: 'Who owns the house at 810 Union St and how do I reach them', source: 'Norfolk Real Estate Assessor, parcel ownership records', why: 'It would show the owner of record.' });
  assert.deepEqual(refused, { noted: false, note: PERSON_SOURCE_NOTE });
  assert.equal(ctx.suggestions.length, 0, 'nothing reaches the request card');
  const kept = await runTool(ctx, 'suggest_data_source', { need: 'Tree care spending as its own line', source: 'Park and Forestry Operations budget detail', why: 'It would split tree work from grounds work.' });
  assert.equal(kept.noted, true);
  assert.equal(ctx.suggestions.length, 1);
});

// ---- review fixes (fresh-context review of #71) -------------------------------

test('a refused card goes back to the model with its note and the card-text note, and the next reply is the answer', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    // Not a source the tools returned: offer_followup refuses it.
    { text: `${ANSWER} Use the button below to have me read the staff report.`, tools: [['offer_followup', { question: 'What does the staff report say?', source_title: 'x', url: 'https://norfolk.example/report.pdf' }]] },
    { text: ANSWER },
  ]);
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(s.calls(), 3, 'the model is asked again');
  assert.equal(out.answer, ANSWER);
  assert.ok(!out.followups, 'no button that was never made');
  const sent = s.bodies[2].messages;
  assert.match(sent.find((m) => m.role === 'tool' && /can't be offered/.test(m.content))?.content || '', /can't be offered/, 'the refusal reaches the model');
  assert.equal(sent.at(-1).role, 'user');
  assert.equal(sent.at(-1).content, CARD_TEXT_NOTE);
});

test('an owner request the guard refuses goes back to the model too, so the answer can\'t promise a request button', async () => {
  const s = scripted([
    { text: `I've asked for the Assessor's ownership records to be added; you can request them below. ${ANSWER}`, tools: [['suggest_data_source', { need: 'Who owns 810 Union St', source: 'Assessor ownership records', why: 'It would show the owner.' }]] },
    { text: "I can't help find who owns a private home. I don't look up owners or residents." },
  ]);
  const out = await ask({ question: 'Who owns 810 Union St?', city: norfolk, apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(s.calls(), 2);
  assert.equal(out.answer, "I can't help find who owns a private home. I don't look up owners or residents.");
  assert.equal(out.suggestions.length, 0);
  assert.ok(s.bodies[1].messages.some((m) => m.role === 'tool' && m.content.includes("can't ask for records that find who owns")));
});

test('the text beside a card never replaces an honest fallback: out of steps stays out of steps', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    { text: 'Let me also check the work orders.', tools: [FOLLOWUP, ['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT count(*) AS n' }]] },
    { text: '' },
  ]);
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl, maxSteps: 2 });
  assert.match(out.answer, /^I ran out of steps/);
});

test('only the turn just before counts: card text from an earlier turn is not the answer', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    { text: 'Let me check more.', tools: [FOLLOWUP, ['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT count(*) AS n' }]] },
    { tools: [['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT count(*) AS m' }]] },
    { text: '' },
  ]);
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.match(out.answer, /^I couldn't put an answer together/);
});

test('with gaps on, a source request beside the answer leaves room for note_unanswered', async () => {
  const read = (f) => JSON.parse(readFileSync(new URL(`../data/gaps/${f}`, import.meta.url), 'utf8'));
  const data = read('norfolk.json');
  const s = scripted([
    { text: TREES, tools: [['suggest_data_source', { need: 'Tree care spending', source: 'Forestry budget detail', why: 'It would split tree work out.' }]] },
    { text: 'I found no separate figure for tree care.' },
  ]);
  await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl: s.fetchImpl, gaps: { data, streets: read('norfolk-streets.json').streets } });
  assert.equal(s.calls(), 2, 'not ended at the source request');
});

test('Anthropic: a voice rewrite after an answer that ended beside a card sends the tool results and the instruction in one user turn', async () => {
  const LEGI_ID = 'toolu_rec';
  const requests = [];
  const replies = [
    { content: [{ type: 'tool_use', id: LEGI_ID, name: 'the_record_tool', input: {} }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: `There is an ordinance, 50487, for the site. ${ANSWER}` }, { type: 'tool_use', id: 'toolu_card', name: 'offer_followup', input: { question: 'What does the agreement say about repayment?', source_title: 'x', url: LEGI } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn' },
  ];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('https://api.anthropic.com/v1/messages')) {
      requests.push(JSON.parse(init.body));
      const r = replies[Math.min(requests.length - 1, replies.length - 1)];
      return claudeResponse(init, { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_details: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...r });
    }
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  };
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', fetchImpl });
  assert.equal(requests.length, 3);
  assert.equal(out.answer, ANSWER);
  assert.equal(out.voice.rewritten, true);
  const last = requests[2].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.deepEqual(last.content.map((b) => b.type), ['tool_result', 'text'], 'the card call answered, then the instruction');
  assert.equal(last.content[0].tool_use_id, 'toolu_card');
  assert.equal(requests[2].messages.at(-2).role, 'assistant');
  assert.equal(requests[2].messages.filter((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('toolu_card')).length, 1, 'the card turn is in once');
});

test('Anthropic: no early exit while the turn still has server-side work pending (web search filtering)', async () => {
  const requests = [];
  const replies = [
    { content: [{ type: 'tool_use', id: 'toolu_rec', name: 'the_record_tool', input: {} }], stop_reason: 'tool_use' },
    { content: [
      { type: 'text', text: ANSWER },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: { code: 'print(1)' } },
      { type: 'tool_use', id: 'toolu_card', name: 'offer_followup', input: { question: 'What does the agreement say about repayment?', source_title: 'x', url: LEGI } },
    ], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn' },
  ];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).startsWith('https://api.anthropic.com/v1/messages')) {
      requests.push(JSON.parse(init.body));
      const r = replies[Math.min(requests.length - 1, replies.length - 1)];
      return claudeResponse(init, { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_details: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...r });
    }
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  };
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', fetchImpl });
  assert.equal(requests.length, 3, 'the pending server work is resumed, not cut off');
  assert.equal(out.answer, ANSWER);
});
