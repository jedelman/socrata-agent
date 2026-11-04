// People-finding guards: exclusions, restricted datasets, denied columns,
// suppressed rows, and access levels a plugin can't raise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/agent.js';
import { blockReport } from '../src/block.js';
import { systemPrompt } from '../src/prompt.js';
import { runTool } from '../src/tools.js';
import { ACCESS, identifiers, isPersonColumn } from '../src/socrata.js';
import { definePlugin, pluginContext, applyConfig } from '../src/plugins.js';
import { getCity, cities } from '../src/cities/index.js';
import { checkPlugin, checkPluginSource, checkPluginFile } from './conformance.js';
import water from '../plugins/water-on-my-block.js';

const norfolk = getCity('norfolk');
const ASSESSMENT_COLUMNS = ['lrsn', 'gpin', 'legal_description', 'owner', 'property_street_number', 'property_street_name', 'acreage', 'current_total_value', 'transfer_date', 'grantor', 'grantee', 'consideration', 'document_number'];

function setup({ city = norfolk, rows = () => [] } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    requests.push(decodeURIComponent(u));
    if (u.includes('/api/views/qva7-tzrf')) return new Response(JSON.stringify({ name: 'Property Assessment and Sales - FY27', columns: ASSESSMENT_COLUMNS.map((fieldName) => ({ fieldName, dataTypeName: 'text' })) }));
    if (u.includes('/api/views/6tg2-ftte')) return new Response(JSON.stringify({ name: 'Bulky Item Pick Up Requests', modifyingViewUid: 'nbyu-xjez', columns: [] }));
    if (u.includes('/api/views/5k2z-xxxx')) return new Response(JSON.stringify({ name: 'Vehicles moved', columns: ['plate', 'make', 'relocated_date'].map((fieldName) => ({ fieldName })) }));
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Some dataset', columns: [] }));
    if (u.includes('/resource/')) return new Response(JSON.stringify(rows(decodeURIComponent(u))));
    if (u.includes('api.us.socrata.com/api/catalog')) {
      return new Response(JSON.stringify({ results: ['7qie-z5gv', 'suf7-r643', 'qzfe-wj25'].map((id) => ({ resource: { id, name: id, description: '' } })) }));
    }
    return new Response('[]');
  };
  const ctx = createContext({ city, fetchImpl });
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

test('rows about one household are dropped in a first stage Siren writes, NULL-safe, at every level', async () => {
  const { ctx, lastQuery } = setup();
  const first = "SELECT * WHERE NOT coalesce((subtype like 'Residing%' OR subtype = 'Rooming House/Overcrowding'), false) |> ";
  await ctx.socrata.query('m9m3-wk2s', 'SELECT subtype, count(*) GROUP BY subtype');
  assert.ok(lastQuery().includes(`$query=${first}SELECT subtype, count(*) GROUP BY subtype LIMIT 100`), lastQuery());
  await ctx.socrata.query('m9m3-wk2s', "WHERE gpin = '1' ORDER BY created_date", { access: ACCESS.CORE });
  assert.ok(lastQuery().includes(`${first}SELECT * WHERE gpin = '1' ORDER BY created_date LIMIT 100`), lastQuery());
  // An alias that shadows the tested column can't reach the first stage.
  await ctx.socrata.query('m9m3-wk2s', "SELECT address, 'x' AS subtype WHERE subtype = 'x'");
  assert.ok(lastQuery().includes(first), lastQuery());
  // SEARCH stays legal inside the user's stage.
  await ctx.socrata.query('m9m3-wk2s', "SELECT complaint_id SEARCH 'trash' LIMIT 5");
  assert.ok(lastQuery().endsWith("|> SELECT complaint_id SEARCH 'trash' LIMIT 5"), lastQuery());
  for (const id of ['7fk7-nqxm', 'mxtv-99gh', 'agip-sqwc']) {
    await ctx.socrata.query(id, 'SELECT count(*)', { access: ACCESS.CORE });
    assert.match(lastQuery(), /NOT coalesce\(\(.*(Red Tag|Rooming house)/, id);
  }
});

test('quoting tricks that hide a withheld column from the checks are refused', async () => {
  const { ctx } = setup();
  const attempts = [
    `SELECT gpin, "'", owner, "'"`,
    "SELECT gpin -- '\n, owner -- '",
    "SELECT gpin /* ' */, owner /* ' */",
    "SELECT gpin AS `'`, owner, gpin AS `'`",
    "SELECT gpin WHERE gpin = 'unterminated",
  ];
  for (const soql of attempts) await assert.rejects(ctx.socrata.query('qva7-tzrf', soql), /double quotes|Comments|quoted|unterminated/, soql);
  // The same tricks can't hide FROM, UNION or @dataset either, at any level.
  await assert.rejects(ctx.socrata.query('qzfe-wj25', "SELECT ward -- '\n UNION ALL SELECT ward FROM @7qie-z5gv -- '", { access: ACCESS.CORE }), /Comments/);
  for (const soql of ['SELECT ward INTERSECT SELECT ward FROM @7qie-z5gv', 'SELECT ward MINUS SELECT ward', 'SELECT ward |> SELECT ward']) {
    await assert.rejects(ctx.socrata.query('qzfe-wj25', soql, { access: ACCESS.CORE }), /own dataset|Chained/, soql);
  }
  // A literal holding |>, a double quote or a keyword is still just text.
  await ctx.socrata.query('qzfe-wj25', `SELECT ward WHERE street = 'A "B" |> from -- x'`);
});

test('SELECT DISTINCT * is expanded like SELECT *', async () => {
  const { ctx, lastQuery } = setup();
  for (const soql of ['SELECT DISTINCT *', 'select distinct  * LIMIT 3', 'SELECT DISTINCT *, gpin']) {
    await ctx.socrata.query('qva7-tzrf', soql);
    const q = lastQuery().split('$query=')[1];
    assert.ok(!/\bowner\b|grantee|grantor|legal_description|document_number/.test(q), q);
    assert.match(q, /^SELECT DISTINCT lrsn, gpin/i);
  }
});

test('a withheld column that comes back anyway is never returned', async () => {
  const { ctx } = setup({ rows: () => [{ gpin: '1', OWNER: 'A PERSON' }] });
  await assert.rejects(ctx.socrata.query('qva7-tzrf', 'SELECT gpin'), /refused this result.*OWNER/);
  // Core still reads it.
  await ctx.socrata.query('qva7-tzrf', 'SELECT gpin, owner', { access: ACCESS.CORE });
});

test('a filtered view is refused below core, so a restricted parent stays restricted', async () => {
  const { ctx } = setup();
  await assert.rejects(ctx.socrata.query('6tg2-ftte', 'SELECT *'), /filtered view of dataset nbyu-xjez/);
  await assert.rejects(ctx.socrata.describe('6tg2-ftte'), /filtered view/);
  await assert.rejects(pluginContext(ctx).socrata.query('6tg2-ftte', 'SELECT count(*)'), /filtered view/);
});

test('columns named like a person are withheld in any dataset, reviewed or not', async () => {
  for (const f of ['plate', 'license_plate', 'vehicle_plate_number', 'vin_number', 'owner_name', 'primary_owner', 'first_name', 'contact_number', 'applicant_name', 'email', 'senate_phone', 'mailing_address', 'date_of_birth']) assert.ok(isPersonColumn(f), f);
  for (const f of ['full_street_name', 'street_name', 'owner_type', 'template', 'park_name', 'phase', 'ward', 'driveway']) assert.ok(!isPersonColumn(f), f);
  const { ctx, lastQuery } = setup({ city: getCity('data.example.gov') });
  await assert.rejects(ctx.socrata.query('5k2z-xxxx', "SELECT make WHERE plate = 'ABC123'"), /withheld/);
  await ctx.socrata.query('5k2z-xxxx', 'SELECT *');
  assert.ok(!/plate/.test(lastQuery().split('$query=')[1]), lastQuery());
});

test('the hand-off never offers a full-table CSV for a dataset with withheld columns or rows', async () => {
  const { ctx } = setup();
  await ctx.socrata.query('qva7-tzrf', 'SELECT gpin');
  await ctx.socrata.query('m9m3-wk2s', 'SELECT complaint_id');
  await ctx.socrata.query('qzfe-wj25', 'SELECT ward');
  const ds = Object.fromEntries(ctx.resources.toJSON().datasets.map((d) => [d.id, d]));
  assert.ok(!ds['qva7-tzrf'].csv && !ds['m9m3-wk2s'].csv, 'no full CSV where a policy applies');
  assert.ok(ds['qva7-tzrf'].queries.length, 'the exact-query CSV is still offered');
  assert.ok(ds['qzfe-wj25'].csv, 'a dataset with no policy keeps its full CSV');
});

test('the model is told which datasets have a full download, matching the hand-off', async () => {
  const address = { full_address: '810 UNION ST', house_number: '810', full_street_name: 'UNION ST', street_name: 'UNION', gpin: '1437047621', ward_district: '4' };
  const { ctx } = setup({ rows: (u) => (u.includes('/resource/ere7-kake') ? [address] : []) });
  const report = await blockReport(ctx, '810 Union St');
  const said = Object.fromEntries(report.datasets.map((d) => [d.dataset, d.full_download]));
  assert.equal(said['fahm-yuh4'], false, 'permits withhold a column, so no full download');
  assert.equal(said['qzfe-wj25'], true, 'work orders have no policy, so a full download');
  const handoff = Object.fromEntries(ctx.resources.toJSON().datasets.map((d) => [d.id, Boolean(d.csv)]));
  for (const [id, flag] of Object.entries(said)) assert.equal(flag, handoff[id], id);
  const prompt = systemPrompt(norfolk, '2026-11-03');
  assert.match(prompt, /Promise a full download only/);
  assert.match(prompt, /The trace lists the queries you ran/);
});

test('a capped query points at the exact-query CSV, not a full download', async () => {
  const { ctx } = setup({ rows: () => Array.from({ length: 61 }, (_, i) => ({ ward: String(i) })) });
  const out = await runTool(ctx, 'query_dataset', { dataset_id: 'fahm-yuh4', soql: 'SELECT ward' });
  assert.equal(out.first_rows.length, 60);
  assert.match(out.note, /these rows as CSV/);
  assert.doesNotMatch(out.note, /download/i);
});

test('plugins: ctx.http refuses Socrata, resources take links only, the city is frozen', async () => {
  const { ctx } = setup();
  const pc = pluginContext(ctx);
  for (const url of [
    "https://data.norfolk.gov/resource/qva7-tzrf.json?$query=SELECT owner",
    'https://DATA.NORFOLK.GOV./resource/suf7-r643.csv',
    'https://data.norfolk.gov/api/views/suf7-r643/rows.csv?accessType=DOWNLOAD',
    'https://api.us.socrata.com/api/catalog/v1?q=x',
    'https://mirror.example.org/resource/qva7-tzrf.json',
  ]) await assert.rejects(pc.http.json(url), /ctx.socrata/, url);
  assert.equal(pc.resources.addDataset, undefined);
  assert.equal(pc.resources.addContact, undefined);
  assert.throws(() => pc.resources.addLink({ title: 'x', url: 'https://data.norfolk.gov/api/views/suf7-r643/rows.csv' }), /ctx.socrata/);
  assert.throws(() => { delete pc.city.deniedColumns['qva7-tzrf']; }, TypeError);
  assert.throws(() => pc.city.restricted.splice(0), TypeError);
  // A plugin that tries both fails conformance.
  const esc = { name: 'esc_http', description: 'x', run: (c) => c.http.json('https://data.norfolk.gov/resource/7qie-z5gv.json') };
  await assert.rejects(checkPlugin(esc, { city: norfolk, args: {}, respond: () => [] }), /ctx.socrata/);
});

test('a policy held by Socrata survives later changes to the city object', async () => {
  const city = { ...cities.norfolk, deniedColumns: { ...cities.norfolk.deniedColumns } };
  const { ctx } = setup({ city });
  delete city.deniedColumns['qva7-tzrf'];
  await assert.rejects(ctx.socrata.query('qva7-tzrf', 'SELECT owner'), /withheld/);
});

test("every spelling of a known city's domain loads that city's policy", () => {
  for (const k of ['data.norfolk.gov', 'DATA.NORFOLK.GOV', 'https://data.norfolk.gov/', 'data.norfolk.gov.', 'Norfolk']) assert.equal(getCity(k), cities.norfolk, k);
  assert.equal(getCity('data.seattle.gov'), cities.seattle);
  assert.equal(getCity('cos-data.seattle.gov'), cities.seattle);
  assert.throws(() => getCity('toString'), /Unknown city/);
  assert.ok(Object.isFrozen(getCity('data.example.gov').excludedNamePatterns));
});

test('a deployment config can add every policy tier, and none of them are lost', async () => {
  const city = applyConfig(norfolk, {
    restricted: [{ id: 'qzfe-wj25', reason: 'Work Orders is restricted here.' }],
    deniedColumns: { 'qva7-tzrf': ['acreage'] },
    suppressedRows: { 'm9m3-wk2s': "type = 'X'" },
    excludedNamePatterns: ['work order'],
  });
  assert.ok(Object.isFrozen(city.deniedColumns['qva7-tzrf']));
  assert.deepEqual(city.deniedColumns['qva7-tzrf'], [...norfolk.deniedColumns['qva7-tzrf'], 'acreage']);
  assert.match(city.suppressedRows['m9m3-wk2s'], /^\(subtype like .*\) OR \(type = 'X'\)$/);
  assert.ok(city.excludedNamePatterns.at(-1) instanceof RegExp);
  const { ctx } = setup({ city });
  await assert.rejects(ctx.socrata.query('qzfe-wj25', 'SELECT ward'), /excluded|restricted/);
  assert.throws(() => applyConfig(norfolk, { excludedNamePatterns: [42] }), /RegExps or strings/);
});

test('Chicago excludes Relocated Vehicles', async () => {
  const { ctx } = setup({ city: getCity('chicago') });
  await assert.rejects(ctx.socrata.query('5k2z-suxx', 'SELECT count(*)'), /license plate/);
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

test('conformance reads plugin source for the ways out a fake network cannot see', () => {
  checkPluginFile(new URL('../plugins/water-on-my-block.js', import.meta.url));
  checkPluginFile(new URL('../plugins/sponge-site-screen.js', import.meta.url));
  checkPluginFile(new URL('../plugins/trees-on-my-block.js', import.meta.url));
  checkPluginFile(new URL('../plugins/litter-on-my-street.js', import.meta.url));
  checkPluginFile(new URL('../plugins/ordinances.js', import.meta.url));
  for (const src of [
    "import { Socrata, ACCESS } from '../src/socrata.js';",
    "import { createContext } from '../src/agent.js';",
    "import * as s from '../src/socrata.js';",
    'const f = globalThis.fetch;',
    "import https from 'node:https';",
    "const m = await import('../src/block.js');",
  ]) assert.throws(() => checkPluginSource(src), /plugin:/, src);
});
