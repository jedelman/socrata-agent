// People-finding guards: exclusions, restricted datasets, denied columns,
// suppressed rows, and access levels a plugin can't raise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/agent.js';
import { ACCESS, identifiers } from '../src/socrata.js';
import { definePlugin, pluginContext } from '../src/plugins.js';
import { getCity } from '../src/cities/index.js';
import water from '../plugins/water-on-my-block.js';

const norfolk = getCity('norfolk');
const ASSESSMENT_COLUMNS = ['lrsn', 'gpin', 'legal_description', 'owner', 'property_street_number', 'property_street_name', 'acreage', 'current_total_value', 'transfer_date', 'grantor', 'grantee', 'consideration', 'document_number'];

function setup() {
  const requests = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    requests.push(decodeURIComponent(u));
    if (u.includes('/api/views/qva7-tzrf')) return new Response(JSON.stringify({ name: 'Property Assessment and Sales - FY27', columns: ASSESSMENT_COLUMNS.map((fieldName) => ({ fieldName, dataTypeName: 'text' })) }));
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Some dataset', columns: [] }));
    if (u.includes('api.us.socrata.com/api/catalog')) {
      return new Response(JSON.stringify({ results: ['7qie-z5gv', 'suf7-r643', 'qzfe-wj25'].map((id) => ({ resource: { id, name: id, description: '' } })) }));
    }
    return new Response('[]');
  };
  const ctx = createContext({ city: norfolk, fetchImpl });
  return { ctx, requests, lastQuery: () => requests.filter((r) => r.includes('/resource/')).at(-1) };
}

test('excluded datasets are refused at every level, including the ones added 2026-11-02', async () => {
  const { ctx } = setup();
  for (const id of ['7qie-z5gv', '4dwc-v3t8', 'ei2q-6g8n', 'jf3j-u4s7', 'fcqe-uvnb', '393b-ph9i', 'p5hy-7rkp']) {
    for (const access of Object.values(ACCESS)) {
      await assert.rejects(ctx.socrata.query(id, 'SELECT count(*)', { access }), /excluded/, `${id} at ${access}`);
    }
  }
});

test('owner fields in the assessment roll cannot be selected, filtered, grouped, sorted or searched', async () => {
  const { ctx } = setup();
  const attempts = [
    'SELECT owner LIMIT 5',
    "SELECT gpin WHERE owner like '%SMITH%'",
    "SELECT gpin WHERE upper(owner) = 'X'",
    'SELECT grantee, count(*) GROUP BY grantee',
    'SELECT gpin ORDER BY grantor',
    'SELECT `owner`',
    'SELECT gpin, legal_description',
    'SELECT document_number',
    'SELECT OWNER',
  ];
  for (const soql of attempts) await assert.rejects(ctx.socrata.query('qva7-tzrf', soql), /withheld/, soql);
  await assert.rejects(ctx.socrata.query('qva7-tzrf', "SELECT gpin SEARCH 'smith'"), /SEARCH isn't allowed/);
  // A literal that merely contains the word is fine.
  await ctx.socrata.query('qva7-tzrf', "SELECT gpin WHERE property_street_name = 'OWNER LANE'");
});

test('SELECT * and a query with no SELECT leave the withheld columns out', async () => {
  const { ctx, lastQuery } = setup();
  await ctx.socrata.query('qva7-tzrf', "SELECT * WHERE gpin = '1'");
  let q = lastQuery();
  assert.ok(!identifiers(q.split('$query=')[1]).has('owner'), q);
  assert.match(q, /SELECT lrsn, gpin, property_street_number/);
  await ctx.socrata.query('qva7-tzrf', "WHERE gpin = '1'");
  q = lastQuery();
  assert.ok(!/\bowner\b|grantee|grantor/.test(q.split('$query=')[1]), q);
});

test("Siren's own code can still read owner fields (the public-owner check)", async () => {
  const { ctx } = setup();
  await ctx.socrata.query('qva7-tzrf', "SELECT gpin, owner WHERE owner = 'City Of Norfolk'", { access: ACCESS.CORE });
});

test('restricted datasets: refused to open-ended tools, open to plugins, no full-table CSV', async () => {
  const { ctx } = setup();
  await assert.rejects(ctx.socrata.query('suf7-r643', 'SELECT count(*)'), /only through water_on_my_block/);
  await assert.rejects(ctx.socrata.describe('suf7-r643'), /only through water_on_my_block/);
  await ctx.socrata.query('suf7-r643', 'SELECT cause_of_damage, count(*) GROUP BY cause_of_damage', { access: ACCESS.PLUGIN });
  const d = ctx.resources.toJSON().datasets.find((x) => x.id === 'suf7-r643');
  assert.ok(d && !d.csv, 'no full-table CSV for a restricted dataset');
  const found = await ctx.socrata.searchCatalog('anything');
  assert.deepEqual(found.map((r) => r.id), ['qzfe-wj25'], 'search hides excluded and restricted datasets');
});

test('a plugin cannot raise its own access level', async () => {
  const { ctx } = setup();
  const pc = pluginContext(ctx);
  await assert.rejects(pc.socrata.query('qva7-tzrf', 'SELECT owner', { access: ACCESS.CORE }), /withheld/);
  const sneaky = definePlugin({ name: 'owner_lookup', description: 'x', run: (c) => c.socrata.query('qva7-tzrf', "SELECT gpin WHERE owner like '%X%'") });
  await assert.rejects(sneaky.run(pluginContext(ctx), {}), /withheld/);
});

test('rows about one household are suppressed in every query, aggregates included', async () => {
  const { ctx, lastQuery } = setup();
  await ctx.socrata.query('m9m3-wk2s', 'SELECT subtype, count(*) GROUP BY subtype');
  assert.match(lastQuery(), /WHERE NOT \(subtype like 'Residing%' OR subtype = 'Rooming House\/Overcrowding'\) GROUP BY/);
  await ctx.socrata.query('m9m3-wk2s', "SELECT * WHERE gpin = '1' ORDER BY created_date", { access: ACCESS.CORE });
  assert.match(lastQuery(), /WHERE \(NOT \(subtype like 'Residing%'.*\)\) AND \(gpin = '1'\) ORDER BY/);
  await ctx.socrata.query('7fk7-nqxm', 'SELECT count(*)');
  assert.match(lastQuery(), /Red Tag/);
});

test("the block report never selects right-of-way applicants or contractors", () => {
  const row = norfolk.streetDatasets.find((d) => d.id === 'mi4h-8pn3');
  assert.ok(!row.fields.includes('contractor') && !row.fields.includes('applicant_name'));
});

test('describe marks withheld columns instead of offering them', async () => {
  const { ctx } = setup();
  const d = await ctx.socrata.describe('qva7-tzrf');
  const owner = d.columns.find((c) => c.field === 'owner');
  assert.ok(owner.withheld && !owner.type);
});

test('a flatlined tide gauge is not reported as current', async () => {
  const recent = new Date(Date.now() - 3600e3).toISOString().slice(0, 19);
  const fetchImpl = async (url) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'x', columns: [] }));
    if (u.includes('hazards.fema.gov')) return new Response(JSON.stringify({ features: [] }));
    if (u.includes('/resource/ere7-kake')) {
      return new Response(JSON.stringify([{ full_address: '1 MASON AVENUE', gpin: '1', house_number: '1', full_street_name: 'MASON AVENUE', street_name: 'MASON', ward_district: '1', parcel_centroid_latitude: '36.9314', parcel_centroid_longitude: '-76.2662', census_tract_number: '1' }]));
    }
    if (u.includes('/resource/mgyn-4sni') && u.includes('min(')) return new Response(JSON.stringify([{ hi: '-1.85', lo: '-1.96' }]));
    if (u.includes('/resource/mgyn-4sni') && u.includes('max(')) return new Response(JSON.stringify([{ high: '-1.8' }]));
    if (u.includes('/resource/mgyn-4sni')) return new Response(JSON.stringify([{ localtime: recent, mason_creek: '-1.9', lafayette_river: '1.0', elizabeth_river_eastern_branch: '1.0' }]));
    return new Response('[]');
  };
  const ctx = createContext({ city: norfolk, fetchImpl, plugins: [definePlugin(water)] });
  const out = await definePlugin(water).run(pluginContext(ctx), { address: '1 Mason Ave' });
  const mason = out.tide.gauges.find((g) => g.gauge.startsWith('Mason Creek'));
  assert.equal(mason.reporting, false);
  assert.match(mason.not_reporting_because, /stuck/);
});
