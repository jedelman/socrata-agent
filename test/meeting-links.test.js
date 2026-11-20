// upcoming_meetings keeps each meeting's page and agenda aside, and the ones
// the answer links join its hand-off, so those links survive the answer check
// (model trial, 2026-11-20: all three runs' links to meeting pages were
// dropped) while unread meetings never crowd the saved record, research
// memory or shared sources (fresh-context review of #71).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ask, createContext } from '../src/agent.js';
import { runTool } from '../src/tools.js';
import { getCity } from '../src/cities/index.js';
import { answerRecord } from '../worker/conversations.js';

const norfolk = getCity('norfolk');
const MEETING = 'https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=4321';
const AGENDA = 'https://norfolkcityva.iqm2.com/Citizens/FileOpen.aspx?Type=14&ID=4321';
const ROWS = [
  { date_and_time: '2026-12-03T16:00:00.000', organization: 'The Tree Commission', type: 'Regular', location: 'Parks and Forestry Operations', meeting_link: { url: MEETING }, agenda_link: { url: AGENDA } },
  ...Array.from({ length: 30 }, (_, i) => ({ date_and_time: `2026-12-${String(4 + (i % 20)).padStart(2, '0')}T09:00:00.000`, organization: `Board ${i}`, type: 'Regular', meeting_link: { url: `https://norfolkcityva.iqm2.com/Citizens/Detail_Meeting.aspx?ID=${5000 + i}` } })),
  { date_and_time: '2026-12-01T18:00:00.000', organization: 'City Council', type: 'Formal', meeting_link: { url: 'javascript:alert(1)' } },
];
const socrataFetch = async (url) => {
  if (String(url).includes('/api/views/')) return new Response(JSON.stringify({ name: 'Public Meeting Notices' }));
  return new Response(JSON.stringify(ROWS));
};

test('meetings: pages are kept aside, not handed off, until an answer links them', async () => {
  const ctx = createContext({ city: norfolk, fetchImpl: socrataFetch });
  const out = await runTool(ctx, 'upcoming_meetings', { days: 30 });
  assert.equal(out.length, ROWS.length);
  assert.equal(ctx.resources.toJSON().records.length, 0, 'nothing handed off by the tool itself');
  assert.equal(ctx.meetingPages.size, 32, 'https pages and agendas only');
  assert.deepEqual(ctx.meetingPages.get(MEETING), { kind: 'meeting', title: 'The Tree Commission (Regular) meeting, 2026-12-03', url: MEETING });
});

test('meetings: the page an answer links is handed off and its link kept; the others never enter the saved record', async () => {
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://openrouter.ai')) {
      const message = n++ === 0
        ? { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'upcoming_meetings', arguments: '{"days":30}' } }] }
        : { content: `I found [the Tree Commission meeting](${MEETING}) on December 3.` };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { cost: 0.001 } }));
    }
    return socrataFetch(url, init);
  };
  const out = await ask({ question: 'What meetings are coming up?', city: norfolk, apiKey: 'k', fetchImpl });
  assert.deepEqual(out.answerLinks, { kept: 1, dropped: 0 });
  assert.match(out.answer, /\[the Tree Commission meeting\]\(/);
  const meetings = out.resources.records.filter((r) => r.kind === 'meeting');
  assert.deepEqual(meetings.map((r) => r.url), [MEETING], 'only the linked page; not its agenda, not the 30 others');
  const saved = answerRecord(out);
  assert.equal(JSON.stringify(saved).includes('ID=5000'), false, 'unread meetings stay out of the saved record');
});
