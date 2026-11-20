// An answer written beside card tools (offer_followup, suggest_data_source,
// offer_watch) is the answer. The model trial of 2026-11-20 found Siren's
// text dropped whenever she wrote her answer and asked for a follow-up
// button in the same reply: the loop asked again and kept only "I've added a
// button under the answer." And a source request can't ask for records that
// find a person (the same trial: one run asked for the Assessor's ownership
// records "and how to contact the owner").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask, createContext, CARD_TOOLS } from '../src/agent.js';
import { runTool, seeksPerson, PERSON_SOURCE_NOTE } from '../src/tools.js';
import { getCity } from '../src/cities/index.js';
import { definePlugin } from '../src/plugins.js';

const norfolk = getCity('norfolk');
const LEGI = 'https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=5949';
const ANSWER = 'I found Ordinance 50487, which approved a cooperation agreement for the Military Circle site.';

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

test('the card tools are the three that only add a card; note_unanswered feeds the answer, so it is not one', () => {
  assert.deepEqual([...CARD_TOOLS].sort(), ['offer_followup', 'offer_watch', 'suggest_data_source']);
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

test('text beside a source request is the answer too', async () => {
  const s = scripted([
    { text: 'I found no separate figure for tree care in the records I reach.', tools: [['suggest_data_source', { need: 'Tree care spending as its own line', source: 'Park and Forestry Operations budget detail by activity', why: 'It would split tree work from grounds work.' }]] },
    { text: 'The button below will send that request.' },
  ]);
  const out = await ask({ question: 'How much does Norfolk budget for tree care?', city: norfolk, apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(out.answer, 'I found no separate figure for tree care in the records I reach.');
  assert.equal(out.suggestions.length, 1);
  assert.equal(s.calls(), 1);
});

test('a card asked for beside another tool keeps the loop going; if the next reply has no text, the text written beside the card is the answer', async () => {
  const s = scripted([
    { tools: [['the_record_tool', {}]] },
    { text: ANSWER, tools: [FOLLOWUP, ['query_dataset', { dataset_id: 'qzfe-wj25', soql: 'SELECT count(*) AS n' }]] },
    { text: '' },
  ]);
  const out = await ask({ question: 'q', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl: s.fetchImpl });
  assert.equal(s.calls(), 3, 'a research tool ran, so the model was asked again');
  assert.equal(out.answer, ANSWER, "not \"I couldn't put an answer together\"");
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
    { text: 'There is an ordinance, 50487, for the Military Circle site.', tools: [FOLLOWUP] },
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

test('a source request can\'t ask for records that find who owns or lives at a place, or how to reach them', async () => {
  for (const t of [
    'Who is the owner of record for the parcel at 810 Union St, Norfolk, and how to contact the owner',
    'Property owner contact information for rental units',
    'Who owns the vacant lots on Church Street',
    'Names of residents on my block',
    'Owner mailing addresses for parcels',
  ]) assert.equal(seeksPerson(t), true, t);
  for (const t of [
    'How much Norfolk budgets for street tree care, Park and Forestry Operations program budget detail',
    'Which parcels does the City own',
    'Rental inspection program rules for landlords, Norfolk City Code chapter 27',
    'Who decides rezonings, and how are neighbors notified? Norfolk Zoning Ordinance',
    'Who maintains the trees in front of homeowners houses? City Code chapter 45',
    'Short-term rental permits issued by year',
  ]) assert.equal(seeksPerson(t), false, t);
  const ctx = createContext({ city: norfolk });
  const refused = await runTool(ctx, 'suggest_data_source', { need: 'Who owns the house at 810 Union St and how do I reach them', source: 'Norfolk Real Estate Assessor, parcel ownership records', why: 'It would show the owner of record.' });
  assert.deepEqual(refused, { noted: false, note: PERSON_SOURCE_NOTE });
  assert.equal(ctx.suggestions.length, 0, 'nothing reaches the request card');
  const kept = await runTool(ctx, 'suggest_data_source', { need: 'Tree care spending as its own line', source: 'Park and Forestry Operations budget detail', why: 'It would split tree work from grounds work.' });
  assert.equal(kept.noted, true);
  assert.equal(ctx.suggestions.length, 1);
});
