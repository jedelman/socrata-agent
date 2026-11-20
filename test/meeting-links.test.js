// upcoming_meetings hands off each meeting's page and agenda, so the answer
// can link them (model trial, 2026-11-20: all three runs' links to meeting
// pages were dropped, since none was in the hand-off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/agent.js';
import { runTool } from '../src/tools.js';
import { getCity } from '../src/cities/index.js';
import { filterAnswerLinks, handoffUrls } from '../src/answer-links.js';

const norfolk = getCity('norfolk');
const MEETING = 'https://www.norfolk.gov/Calendar.aspx?EID=12345';
const AGENDA = 'https://norfolkcityva.iqm2.com/Citizens/FileOpen.aspx?Type=14&ID=4321';

test('meetings: each page and agenda joins the hand-off, and a link to it survives the answer check', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/views/')) return new Response(JSON.stringify({ name: 'Public Meeting Notices' }));
    return new Response(JSON.stringify([
      { date_and_time: '2026-12-03T16:00:00.000', organization: 'The Tree Commission', type: 'Regular', location: 'Parks and Forestry Operations', meeting_link: { url: MEETING }, agenda_link: { url: AGENDA } },
      { date_and_time: '2026-12-01T18:00:00.000', organization: 'City Council', type: 'Formal', location: 'Council Chamber', meeting_link: { url: 'javascript:alert(1)' } },
    ]));
  };
  const ctx = createContext({ city: norfolk, fetchImpl });
  const out = await runTool(ctx, 'upcoming_meetings', { days: 14 });
  assert.equal(out.length, 2);
  const records = ctx.resources.toJSON().records;
  assert.deepEqual(records.map((r) => [r.kind, r.title, r.url]), [
    ['meeting', 'The Tree Commission meeting, 2026-12-03', MEETING],
    ['meeting', 'The Tree Commission agenda, 2026-12-03', AGENDA],
  ], 'https pages only');
  const linked = filterAnswerLinks(`I found [the Tree Commission meeting](${MEETING}) and [its agenda](${AGENDA}).`, handoffUrls(ctx.resources.toJSON()));
  assert.deepEqual({ kept: linked.kept, dropped: linked.dropped }, { kept: 2, dropped: 0 });
});
