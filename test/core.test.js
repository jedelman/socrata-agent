import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voiceViolations } from '../src/voice.js';
import { clampLimit, Socrata } from '../src/socrata.js';
import { Trace } from '../src/trace.js';
import { Resources } from '../src/resources.js';
import { parseLegiFile, parseMeeting, extractAddresses, normalizeAddress } from '../src/adapters/iqm2.js';
import { addressKey, matchLegislation } from '../src/block.js';
import { toolsFor } from '../src/tools.js';
import { getCity } from '../src/cities/index.js';
import { ask } from '../src/agent.js';

const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('voice: flags claims about the world', () => {
  assert.equal(voiceViolations('There are 3 open permits.').length, 1);
  assert.equal(voiceViolations("There's a pending review.").length, 1);
  assert.equal(voiceViolations('Nobody voted against it.').length, 1);
  assert.equal(voiceViolations('there were no complaints and no one objected').length, 2);
});

test('voice: allows reports of what was found, and quotations', () => {
  assert.deepEqual(voiceViolations('I found 3 open permits. I see no complaints.'), []);
  assert.deepEqual(voiceViolations('The ordinance title reads "there is hereby granted".'), []);
  assert.deepEqual(voiceViolations('Use `there is` sparingly.'), []);
  assert.deepEqual(voiceViolations('> There is a quote here.'), []);
  assert.deepEqual(voiceViolations('Thereafter the council voted.'), []);
});

test('clampLimit adds and caps LIMIT', () => {
  assert.equal(clampLimit('SELECT a'), 'SELECT a LIMIT 100');
  assert.equal(clampLimit('SELECT a LIMIT 20'), 'SELECT a LIMIT 20');
  assert.equal(clampLimit('SELECT a LIMIT 50000'), 'SELECT a LIMIT 500');
  assert.equal(clampLimit('SELECT a LIMIT 50000 OFFSET 10'), 'SELECT a LIMIT 500 OFFSET 10');
});

test('iqm2: legislative record with roll calls', () => {
  const r = parseLegiFile(fixture('iqm2-legifile.html'));
  assert.equal(r.number, 'Ordinance No. 50451');
  assert.equal(r.status, 'Adopted');
  assert.equal(r.department, 'Planning');
  assert.equal(r.category, 'Conditional Rezoning');
  assert.equal(r.history.length, 2);
  const [pc, council] = r.history;
  assert.equal(pc.body, 'Planning Commission');
  assert.equal(pc.result, 'APPROVAL RECOMMENDED [UNANIMOUS]');
  assert.deepEqual(pc.absent, ['Lelia Vann']);
  assert.equal(pc.minutes_draft, true);
  assert.equal(council.body, 'City Council');
  assert.equal(council.ayes.length, 8);
  assert.deepEqual(council.nays, []);
});

test('iqm2: meeting agenda items', () => {
  const m = parseMeeting(fixture('iqm2-meeting.html'));
  assert.equal(m.body, 'City Council');
  assert.equal(m.items.length, 39);
  assert.ok(m.items.some((i) => i.id === '5832' && i.text.includes('111 Pennsylvania Avenue')));
});

test('extractAddresses handles lists and ordinal streets', () => {
  assert.deepEqual(extractAddresses('Property Located at 9519 and 9523 22nd Bay Street From R-C'), ['9519 22nd Bay Street', '9523 22nd Bay Street']);
  assert.deepEqual(extractAddresses('Located at 160 W. Virginia Beach Boulevard'), ['160 W. Virginia Beach Boulevard']);
  assert.deepEqual(extractAddresses('An Ordinance Approving the FY2027 Budget'), []);
});

test('addressKey matches across spellings', () => {
  assert.deepEqual(addressKey('160 W. Virginia Beach Blvd'), addressKey('160 W VIRGINIA BEACH BOULEVARD'));
  assert.deepEqual(addressKey('111 Pennsylvania Ave, Norfolk VA 23508'), { num: '111', street: 'PENNSYLVANIA' });
  assert.deepEqual(addressKey('111 Pennsylvania Ave Norfolk VA 23508'), { num: '111', street: 'PENNSYLVANIA' });
  assert.deepEqual(addressKey('160 W Virginia Beach Blvd'), { num: '160', street: 'VIRGINIA BEACH' });
  assert.equal(normalizeAddress('111 Pennsylvania Ave.'), '111 PENNSYLVANIA AVENUE');
});

test('matchLegislation separates the parcel from its hundred block', () => {
  const index = {
    items: [
      { id: '1', text: 'at 111 Pennsylvania Avenue', addresses: ['111 PENNSYLVANIA AVENUE'], meetings: [] },
      { id: '2', text: 'at 125 Pennsylvania Avenue', addresses: ['125 PENNSYLVANIA AVENUE'], meetings: [] },
      { id: '3', text: 'at 211 Pennsylvania Avenue', addresses: ['211 PENNSYLVANIA AVENUE'], meetings: [] },
    ],
  };
  const m = matchLegislation(index, '111 PENNSYLVANIA AVENUE');
  assert.deepEqual(m.exact.map((x) => x.id), ['1']);
  assert.deepEqual(m.same_block.map((x) => x.id), ['2']);
});

test('excluded datasets are refused before any request is made', async () => {
  const trace = new Trace();
  const s = new Socrata({ city: getCity('norfolk'), trace, resources: new Resources(), fetchImpl: async () => assert.fail('no request should be made') });
  await assert.rejects(s.query('cab7-wvn5', 'SELECT *'), /searchable by personal name/);
  const generic = new Socrata({ city: getCity('chicago'), trace, resources: new Resources(), fetchImpl: async () => assert.fail('no request') });
  await assert.rejects(generic.query('abcd-1234', 'SELECT *', { name: 'Sex Offenders' }), /excluded/);
  await assert.rejects(s.query('../../etc', 'SELECT *'), /not a Socrata dataset id/);
});

test('querying by bare id still checks the dataset name', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ name: 'Sex Offenders' }));
  };
  const s = new Socrata({ city: getCity('chicago'), trace: new Trace(), resources: new Resources(), fetchImpl });
  await assert.rejects(s.query('vc9r-bqvy', 'SELECT *'), /excluded/);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/views\/vc9r-bqvy\.json$/);
});

test('tools depend on what the city profile supports', () => {
  const n = toolsFor(getCity('norfolk')).map((t) => t.function.name);
  const c = toolsFor(getCity('chicago')).map((t) => t.function.name);
  assert.ok(n.includes('block_report') && n.includes('get_legislation'));
  assert.ok(!c.includes('block_report') && c.includes('query_dataset'));
  assert.equal(getCity('data.example.gov').domain, 'data.example.gov');
  assert.throws(() => getCity('not a city'));
});

// A full agent turn against fakes: one tool call, an answer that breaks the
// voice contract, and the rewrite. No network, no spend.
test('agent: trace is written by code and the voice check rewrites', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith('https://openrouter.ai')) {
      const body = JSON.parse(init.body);
      const n = calls.filter((u) => u.startsWith('https://openrouter.ai')).length;
      const reply =
        n === 1
          ? { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'query_dataset', arguments: JSON.stringify({ dataset_id: 'qzfe-wj25', soql: 'SELECT area, count(*) AS n GROUP BY area' }) } }] }
          : n === 2
            ? { content: 'There are 2 areas: Landscape and Traffic.' }
            : { content: 'I found 2 areas: Landscape and Traffic.' };
      if (n === 3) assert.ok(body.messages.at(-1).content.startsWith('Rewrite your last answer'));
      return new Response(JSON.stringify({ choices: [{ message: reply }], usage: { cost: 0.001 } }));
    }
    if (String(url).includes('/api/views/')) return new Response(JSON.stringify({ name: 'Work Orders' }));
    return new Response(JSON.stringify([{ area: 'Landscape', n: '46685' }, { area: 'Traffic', n: '32445' }]));
  };
  const out = await ask({ question: 'How many work orders by area?', city: getCity('norfolk'), apiKey: 'test', fetchImpl });
  assert.equal(out.answer, 'I found 2 areas: Landscape and Traffic.');
  assert.deepEqual(out.voice, { ok: true, rewritten: true, violations: [] });
  // Two requests ran, so the trace shows two: the exclusion check, then the query.
  assert.deepEqual(out.trace.map((s) => s.tool), ['check dataset name', 'query']);
  assert.equal(out.trace[1].dataset, 'qzfe-wj25');
  assert.equal(out.trace[1].rows, 2);
  assert.match(out.trace[1].soql, /LIMIT 100$/);
  assert.equal(out.cost, 0.003);
  assert.ok(out.resources.datasets[0].queries[0].includes('.csv?$query='));
  assert.ok(out.resources.contacts.some((c) => c.role.startsWith('City services')));
});
