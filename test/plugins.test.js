import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlugin } from './conformance.js';
import { definePlugin, applyConfig, tracedHttp, USER_AGENT } from '../src/plugins.js';
import { Trace } from '../src/trace.js';
import { toolsFor } from '../src/tools.js';
import { getCity } from '../src/cities/index.js';
import { systemPrompt } from '../src/prompt.js';
import water, { tractGeoid, leagueKey, km, TIDE_GAUGES } from '../plugins/water-on-my-block.js';
import trees, { summarize, trunkSizes } from '../plugins/trees-on-my-block.js';
import litter, { median, perMeter } from '../plugins/litter-on-my-street.js';
import sponge from '../deployments/sponge-city-norfolk.config.js';
import { verifyAccess, resetAccessCache } from '../worker/access.js';

const norfolk = getCity('norfolk');
const recent = new Date(Date.now() - 864e5).toISOString().slice(0, 19);

// A fake network that answers like the real sources did on 2026-10-06.
function respond(url) {
  if (url.includes('/api/views/')) return { name: 'some dataset' };
  if (url.includes('hazards.fema.gov')) return { features: [{ attributes: { FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD', SFHA_TF: 'F', STATIC_BFE: -9999 } }] };
  const q = decodeURIComponent(url);
  if (url.includes('/resource/ere7-kake'))
    return [{ full_address: '111 PENNSYLVANIA AVENUE', gpin: '1438184218', house_number: '111', full_street_name: 'PENNSYLVANIA AVENUE', street_name: 'PENNSYLVANIA', ward_district: '2', parcel_centroid_latitude: '36.88223592', parcel_centroid_longitude: '-76.28240994', census_tract_number: '28', civic_league: 'Colonial Place and Riverview', evacuation_zone: 'B' }];
  if (url.includes('/resource/suf7-r643')) return [{ cause_of_damage: 'Tidal water overflow', claims: '166', building_paid: '1700000', contents_paid: '70385' }];
  if (url.includes('/resource/uvc6-r75u') && q.includes('GROUP BY civicleague')) return [{ civicleague: 'Colonial Place/ Riverview', n: '1168' }];
  if (url.includes('/resource/uvc6-r75u')) return [{ work_type: 'Drains/Structures Cleaned', asset_type: 'Catch Basin', n: '59' }];
  if (url.includes('/resource/qzfe-wj25') && q.includes("'Forestry'")) return [{ primary_task_description: 'Removal', n: '96' }, { primary_task_description: 'Plantings', n: '19' }];
  if (url.includes('/resource/qzfe-wj25')) return [];
  if (url.includes('/resource/mgyn-4sni') && q.includes('min(')) return [{ hi: '3.06', lo: '-1.03' }];
  if (url.includes('/resource/mgyn-4sni') && q.includes('max(')) return [{ high: '4.94' }];
  if (url.includes('/resource/mgyn-4sni')) return [{ localtime: recent, lafayette_river: '2.286' }];
  throw new Error(`unexpected request ${url}`);
}

test('water_on_my_block passes plugin conformance', async () => {
  const { result, trace } = await checkPlugin(water, { city: norfolk, args: { address: '111 Pennsylvania Ave' }, respond });
  assert.equal(result.flood_zone.zones[0].zone, 'X');
  assert.equal(result.flood_claims_in_tract.tract_geoid, '51710002800');
  assert.equal(result.flood_claims_in_tract.by_cause[0].paid_usd, 1770385);
  assert.equal(result.stormwater.civic_league_matched, 'Colonial Place/ Riverview');
  assert.equal(result.trees.removals, 96);
  assert.equal(result.tide.gauges[0].gauge, 'Lafayette River at Mayflower Rd');
  assert.equal(result.tide.gauges[0].reporting, true);
  assert.ok(trace.some((s) => s.tool === 'FEMA flood zone at parcel centroid'));
});

test('conformance catches a plugin that skips the trace', async () => {
  const sneaky = definePlugin({ name: 'sneaky_tool', description: 'x', run: async () => (await fetch('https://example.org')).text() });
  await assert.rejects(checkPlugin(sneaky, { city: norfolk, args: {}, respond }), /called fetch directly/);
});

test('water helpers', () => {
  assert.equal(tractGeoid('28'), '51710002800');
  assert.equal(tractGeoid(65.02), '51710006502');
  assert.equal(tractGeoid(''), null);
  assert.equal(leagueKey('Colonial Place and Riverview'), leagueKey('Colonial Place/ Riverview'));
  const lafayette = TIDE_GAUGES.find((g) => g.field === 'lafayette_river');
  assert.ok(km({ lat: 36.88223592, lon: -76.28240994 }, lafayette) < 1);
});

test('plugins attach per city and cannot replace core tools', () => {
  assert.ok(toolsFor(norfolk, [water]).some((t) => t.function.name === 'water_on_my_block'));
  assert.ok(!toolsFor(getCity('chicago'), [water]).some((t) => t.function.name === 'water_on_my_block'));
  const impostor = definePlugin({ name: 'block_report', description: 'x', run: async () => ({}) });
  assert.throws(() => toolsFor(norfolk, [impostor]), /replace a core tool/);
  assert.throws(() => definePlugin({ name: 'Bad Name', description: 'x', run() {} }), /snake_case/);
});

test('config adds to a city but cannot remove its exclusions', () => {
  const city = applyConfig(norfolk, { ...sponge, excluded: [] });
  assert.ok(city.excluded.some((e) => e.id === 'cab7-wvn5'));
  assert.ok(city.links.some((l) => l.url.includes('msc.fema.gov')));
  const prompt = systemPrompt(city, '2026-10-06');
  assert.match(prompt, /Notes from the operator of this deployment \(Norfolk sponge city \(example\)\)/);
  assert.match(prompt, /never override the rules/);
  assert.ok(prompt.indexOf('Notes from the operator') > prompt.indexOf('How you speak'));
});

// Cloudflare Access: sign a token with a throwaway key and verify it.
async function signedToken(claims, kid = 'k1') {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid });
  const body = enc(claims);
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`))).toString('base64url');
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid };
  return { token: `${head}.${body}.${sig}`, jwk };
}

test('Access tokens are verified, not trusted', async () => {
  const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud123' };
  const good = { email: 'Volunteer@Example.org', aud: ['aud123'], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600 };
  const { token, jwk } = await signedToken(good);
  const certs = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const req = (t, extra = {}) => new Request('https://x/api/ask', { headers: { ...(t ? { 'Cf-Access-Jwt-Assertion': t } : {}), ...extra } });

  resetAccessCache();
  assert.deepEqual(await verifyAccess(req(token), env, certs), { email: 'volunteer@example.org' });
  await assert.rejects(verifyAccess(req(null, { 'Cf-Access-Authenticated-User-Email': 'spoof@example.org' }), env, certs), /missing Access token/);
  await assert.rejects(verifyAccess(req(token), { ...env, ACCESS_AUD: 'other' }, certs), /wrong audience/);
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, email: 'boss@example.org' })).toString('base64url')}.${s}`;
  await assert.rejects(verifyAccess(req(forged), env, certs), /bad signature/);
  const expired = await signedToken({ ...good, exp: 1 }, 'k2');
  resetAccessCache();
  await assert.rejects(verifyAccess(req(expired.token), env, async () => new Response(JSON.stringify({ keys: [expired.jwk] }))), /expired/);
});

test('plugin HTTP identifies itself and is traced', async () => {
  let seen;
  const trace = new Trace();
  const http = tracedHttp(trace, async (url, init) => {
    seen = init.headers['User-Agent'];
    return new Response('{"ok":true}');
  });
  assert.deepEqual(await http.json('https://hazards.fema.gov/x', { tool: 'fema' }), { ok: true });
  assert.equal(seen, USER_AGENT);
  assert.equal(trace.steps[0].tool, 'fema');
  await assert.rejects(http.json('http://insecure.example/x'), /only fetch https/);
});

test('sponge_site_screen serves the prebuilt screen with provenance', async () => {
  const { default: screenPlugin } = await import('../plugins/sponge-site-screen.js');
  const { result, trace, resources } = await checkPlugin(screenPlugin, { city: norfolk, args: { intervention: 'rain_garden', limit: 5, include_ruled_out: true }, respond });
  assert.match(result.built_by, /not a City of Norfolk analysis/);
  assert.ok(result.sites.length > 0 && result.sites.every((s) => s.verdict.ok));
  assert.ok(result.ruled_out.every((s) => !s.verdict.ok));
  assert.equal(trace[0].tool, 'read sponge-city screen');
  assert.match(trace[0].soql, /from \d+ queries/);
  assert.ok(resources.links.some((l) => l.url.endsWith('docs/sponge-screen-norfolk.md')));
  for (const s of result.sites) assert.match(s.owner, /^(City Of Norfolk|Norfolk Redevelopment|Economic Dev)/i);
  const swales = await checkPlugin(screenPlugin, { city: norfolk, args: { intervention: 'bioswale', civic_league: 'crossroads' }, respond });
  assert.ok(swales.result.streets.every((s) => /crossroads/i.test(s.civic_league)));
});

test('plugin HTTP retries a server error once, inside one traced step', async () => {
  let calls = 0;
  const trace = new Trace();
  const http = tracedHttp(trace, async () => (++calls === 1 ? new Response('busy', { status: 504 }) : new Response('{"ok":1}')));
  assert.deepEqual(await http.json('https://hazards.fema.gov/x', { tool: 'fema', retryDelayMs: 0 }), { ok: 1 });
  assert.equal(calls, 2);
  assert.equal(trace.steps.length, 1);
  const always = tracedHttp(new Trace(), async () => new Response('down', { status: 503 }));
  await assert.rejects(always.json('https://hazards.fema.gov/x', { retryDelayMs: 0 }), /HTTP 503/);
});

// Fakes shaped like the live answers on 2026-11-04.
function respondTreesLitter(url) {
  const q = decodeURIComponent(url);
  if (url.includes('/api/views/')) return { name: 'some dataset', columns: [] };
  if (url.includes('/resource/ere7-kake'))
    return [{ full_address: '111 PENNSYLVANIA AVENUE', gpin: '1438184218', house_number: '111', full_street_name: 'PENNSYLVANIA AVENUE', street_name: 'PENNSYLVANIA', ward_district: '2', parcel_centroid_latitude: '36.88223592', parcel_centroid_longitude: '-76.28240994', census_tract_number: '28', civic_league: 'Colonial Place and Riverview' }];
  if (url.includes('/resource/qzfe-wj25')) {
    if (q.includes('min(created_datetime)')) return [{ first: '2020-08-05T08:31:36.000', last: '2026-11-02T15:32:11.000' }];
    if (q.includes('GROUP BY civic_league')) return [{ civic_league: 'Colonial Place/ Riverview', n: '324' }];
    if (q.includes('date_extract_y')) return [{ y: '2025', n: '3', cost: '1155.5' }];
    if (q.includes('GROUP BY t, p')) return [{ t: 'Removal', p: 'Dead Tree', n: '2', cost: '900' }];
    if (q.includes('GROUP BY t')) return [{ t: 'Removal', n: '60', cost: '30000' }, { t: 'Stump Grinding', n: '55', cost: '14000' }, { t: 'Pruning', n: '70', cost: '18000' }, { t: 'Plantings', n: '12', cost: '3000' }];
    return [{ work_order_number: '25-1', primary_task_description: 'Removal', problem_description: 'Dead Tree', status_description: 'Complete', created_datetime: '2025-08-25T00:00:00.000' }];
  }
  if (url.includes('/resource/cmvv-agyb')) {
    if (q.includes('GROUP BY civic_league')) return [{ civic_league: 'Colonial Place/ Riverview', n: '2100' }];
    if (q.includes('GROUP BY common_name')) return [{ common_name: 'Crapemyrtle', n: '12' }, { common_name: 'Willow Oak', n: '2' }];
    // Shaped like the live answer for this circle on 2026-11-06: a tree carries a range or a diameter, rarely both.
    if (q.includes('GROUP BY r, d')) return [{ d: '0.0', n: '3' }, { d: '17.0', n: '2' }, { d: '-1.0', n: '1' }, { r: '6" to 12"', n: '5' }, { r: '0" to 6"', d: '4.0', n: '1' }, { n: '2' }];
    return [{ n: '93993' }];
  }
  if (url.includes('/resource/iz5u-2wb3')) return q.includes('GROUP BY category') ? [{ category: 'smoking', n: '50' }, { category: 'drink', n: '50' }] : [{ object: 'cigarettebutt', n: '47' }, { object: 'bottle', n: '53' }];
  if (url.includes('/resource/fq5y-c2yn'))
    return [
      { location_name: 'Granby Street', latitude: '36.884', longitude: '-76.285', litter_per_meter_spring_2022: '0.1', litter_per_meter_summer_2022: '0.14' },
      { location_name: 'Far Road', latitude: '36.95', longitude: '-76.2', litter_per_meter_fall_2022: '0.05' },
    ];
  if (url.includes('/resource/nbz2-dgus')) return [{ ward_route: 'Ward 2-1a', _2010: '1', _2019: '2' }, { ward_route: 'Ward 2-1b', _2010: '2', _2019: '2' }];
  throw new Error(`unexpected request ${url}`);
}

test('trees_on_my_block passes conformance and never counts private trees', async () => {
  const { result, requests } = await checkPlugin(trees, { city: norfolk, args: { address: '111 Pennsylvania Ave' }, respond: respondTreesLitter });
  assert.equal(result.near_you.city_trees, 14);
  assert.equal(result.near_you.no_size_recorded, 6, 'empty, 0 and -1 diameters with no range');
  assert.equal(result.near_you.no_diameter_recorded, 11);
  assert.deepEqual(result.near_you.trunk_diameter, { trees: 3, min: 4, median: 17, max: 17 });
  assert.deepEqual(result.near_you.trunk_diameter_range, [{ range: '0" to 6"', count: 1 }, { range: '6" to 12"', count: 5 }]);
  assert.ok(requests.map(decodeURIComponent).some((u) => /trunk_diameter AS d/.test(u) && /GROUP BY r, d/.test(u)));
  assert.ok(result.about_the_data.some((n) => /0 or less is counted as unrecorded/.test(n) && /6,918/.test(n)));
  assert.ok(!result.about_the_data.some((n) => /most trees have no trunk size/.test(n)));
  assert.equal(result.civic_league.civic_league_matched, 'Colonial Place/ Riverview');
  assert.equal(result.civic_league.removals_per_planting, 5);
  assert.equal(result.civic_league.city_trees_in_inventory, 2100);
  assert.equal(result.citywide.city_trees_in_inventory, 93993);
  assert.ok(result.work_orders_cover.years > 6);
  for (const u of requests.filter((x) => x.includes('/resource/cmvv-agyb'))) assert.match(decodeURIComponent(u), /common_name != 'PRIVATE TREES'/);
  assert.ok(result.about_the_data.some((n) => /re-inventory/.test(n)));
});

test('trunk sizes read the diameter too, and count 0 or less as unrecorded', () => {
  const s = trunkSizes([
    { r: '12" to 18"', n: '2' },
    { r: '6" to 12"', d: '0.0', n: '1' },
    { d: '10.0', n: '1' },
    { d: '20', n: '3' },
    { d: '0.0', n: '4' },
    { d: '-1.0', n: '1' },
    { d: '', n: '1' },
    { n: '5' },
  ]);
  assert.deepEqual(s.trunk_diameter_range, [{ range: '6" to 12"', count: 1 }, { range: '12" to 18"', count: 2 }]);
  assert.deepEqual(s.trunk_diameter, { trees: 4, min: 10, median: 20, max: 20 });
  assert.equal(s.no_diameter_recorded, 14);
  assert.equal(s.no_size_recorded, 11, 'a range alone is a size; 0, -1, empty and missing diameters are not');
  assert.equal(trunkSizes([{ d: '4', n: '1' }, { d: '9', n: '1' }]).trunk_diameter.median, 6.5);
  const none = trunkSizes([{ d: '0.0', n: '2' }]);
  assert.equal(none.trunk_diameter, null);
  assert.equal(none.no_size_recorded, 2);
  assert.deepEqual(trunkSizes([]), { trunk_diameter_range: [], trunk_diameter: null, no_diameter_recorded: 0, no_size_recorded: 0 });
});

test('tree summary ratios', () => {
  const s = summarize([{ t: 'Removal', n: '10', cost: '5000' }, { t: 'Stump Grinding', n: '9', cost: '1000' }, { t: 'Pruning', n: '20', cost: '3000' }, { t: 'Plantings', n: '4' }], { trees: 2000, years: 5 });
  assert.equal(s.removals_per_planting, 2.5);
  assert.equal(s.spent_removing_vs_pruning, 2);
  assert.equal(s.pruning_work_orders_per_year, 4);
  assert.equal(s.years_to_prune_every_tree_once_at_this_pace, 500);
  assert.equal(summarize([], {}).removals_per_planting, null);
});

test('litter_on_my_street passes conformance and labels the survey honestly', async () => {
  const { result } = await checkPlugin(litter, { city: norfolk, args: { address: '111 Pennsylvania Ave' }, respond: respondTreesLitter });
  assert.equal(result.survey_near_you.items_recorded, 100);
  assert.equal(result.survey_near_you.by_category[0].percent, 50);
  assert.equal(result.nearest_surveyed_stretches.nearest.length, 1, 'only stretches within 1.5 km');
  assert.equal(result.nearest_surveyed_stretches.nearest[0].location, 'Granby Street');
  assert.deepEqual(result.litter_index.by_year.map((y) => y.year), [2010, 2019]);
  assert.equal(result.cleanup_spending.civic_league.civic_league_matched, 'Colonial Place/ Riverview');
  assert.ok(result.about_the_data.some((n) => /244 chosen locations/.test(n)));
});

test('litter helpers', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.ok(Math.abs(perMeter({ litter_per_meter_spring_2022: '0.1', litter_per_meter_summer_2022: '0.2' }) - 0.15) < 1e-9);
  assert.equal(perMeter({}), null);
});

import { readFileSync, readdirSync } from 'node:fs';

test('case files: every served finding has a source and a checked quote; every fix points at a finding', () => {
  const dir = new URL('../data/cases/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const ids = new Set(doc.findings.map((f) => f.id));
    assert.equal(ids.size, doc.findings.length, `${file}: duplicate finding ids`);
    for (const f of doc.findings) {
      assert.ok(f.claim && f.source?.url?.startsWith('https://') && f.source.title, `${file} ${f.id}: claim and source`);
      assert.ok(['confirms', 'weakens', 'context', 'who_decides', 'rules'].includes(f.stance), `${file} ${f.id}: stance`);
      assert.ok(f.found_by, `${file} ${f.id}: found_by names who found it`);
      if (!f.unverified) assert.ok(f.quote && /^\d{4}-\d{2}-\d{2}$/.test(f.checked || ''), `${file} ${f.id}: run scripts/verify-cases.js --write`);
    }
    for (const h of doc.what_would_help) assert.ok(ids.has(h.finding), `${file}: fix points at missing finding ${h.finding}`);
  }
});

test('the_record serves only checked findings, and puts every source in the trace and hand-off', async () => {
  const { result, trace, resources } = await checkPlugin(trees, { city: norfolk, args: { address: '111 Pennsylvania Ave' }, respond: respondTreesLitter });
  const r = result.the_record;
  assert.ok(r.confirms.length >= 5 && r.weakens.length >= 3);
  assert.ok(r.confirms.some((f) => /5% of street-tree pruning requests/.test(f.claim)));
  assert.ok(r.not_yet_verified.some((c) => /Tree Commission/.test(c)), 'unverified claims are labeled, not served');
  assert.ok(![...r.confirms, ...r.weakens, ...r.context].some((f) => /Tree Commission/.test(f.claim)));
  assert.ok(trace.some((s) => /verified case file/.test(s.tool)));
  assert.ok(resources.records.some((x) => x.url.includes('78214')), 'the budget book is in the hand-off');
  const litterResult = (await checkPlugin(litter, { city: norfolk, args: { address: '111 Pennsylvania Ave' }, respond: respondTreesLitter })).result;
  assert.ok(litterResult.the_record.confirms.some((f) => /bag tax/.test(f.claim)));
});

import caseFile from '../plugins/case-file.js';
import parcelInventory, { SERVICES, cleanAttributes, identifyUrl } from '../plugins/parcel-inventory.js';

test('case_file serves a record with no address, including the rules', async () => {
  const { result, trace } = await checkPlugin(caseFile, { city: norfolk, args: { topic: 'norfolk-trees' }, respond: () => [] });
  assert.ok(result.rules.some((f) => /sec\. 45-13\(b\)/.test(f.claim)), 'the tree ordinance is in the record');
  assert.ok(trace.some((s) => /verified case file/.test(s.tool)));
  const missing = await checkPlugin(caseFile, { city: norfolk, args: { topic: 'nope' }, respond: () => [] });
  assert.match(missing.result.error, /No case file/);
});

import { judge, STALE_DAYS } from '../scripts/verify-cases.js';

test('the case verifier fails on a missing quote, and on a source unreachable too long', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  assert.equal(judge({ found: true }), 'ok');
  assert.equal(judge({ found: false }), 'fail');
  assert.equal(judge({ found: true, absentOk: false }), 'fail');
  assert.equal(judge({ unreachable: true, checked: '2026-11-01', now }), 'warn', 'blocked from here, verified recently');
  assert.equal(judge({ unreachable: true, checked: '2026-09-01', now }), 'fail', `over ${STALE_DAYS} days`);
  assert.equal(judge({ unreachable: true, now }), 'fail', 'never verified');
});

// Fakes shaped like the live identify answers on 2026-11-07 (1300 Colley Ave).
function respondParcel(url) {
  if (url.includes('/resource/ere7-kake'))
    return [{ full_address: '1300 COLLEY AVENUE', gpin: '1428629504', house_number: '1300', full_street_name: 'COLLEY AVENUE', street_name: 'COLLEY', ward_district: '2', parcel_centroid_latitude: '36.86666037', parcel_centroid_longitude: '-76.29843391', census_tract_number: '37', civic_league: 'Ghent Neighborhood League' }];
  const svc = url.match(/OpenData\/([A-Za-z_]+)\/MapServer\/identify/)?.[1];
  const R = {
    Planning: [
      { layerName: 'Zoning', attributes: { OBJECTID: '1', ZONE: 'C-C', last_edited_user: 'MSTRALE', 'Shape.STArea()': '1' } },
      { layerName: 'Zoning Overlays', attributes: { NAME: 'Colley Avenue Pedestrian Commercial Overlay', URL: 'Null' } },
      { layerName: 'Future Land Use', attributes: { LANDUSE: 'Commercial' } },
    ],
    Maps: [
      { layerName: 'Wards', attributes: { WARD: '2', WARD_REP: 'Courtney Doyle' } },
      { layerName: 'Civic Leagues', attributes: { LEAGUE: 'Ghent Neighborhood League', PRESIDENT: 'A Private Person', PRES_ADDRE: 'P.O. Box 1', E_MAIL: 'someone@example.org', MTG_FREQUE: '3rd Wednesday' } },
    ],
    Environmental: [{ layerName: 'FIRM', attributes: { FLD_ZONE: '0.2 PCT ANNUAL CHANCE FLOOD HAZARD', SFHA_TF: 'F' } }],
    Public_Safety: [{ layerName: 'Police Precincts', attributes: { PRECINCT: '1' } }],
    Parcels: [{ layerName: 'Parcels', attributes: { GPIN: '1428629504', TAX_ACCT: '08881900' } }],
  };
  if (svc === 'RPOS') return { error: { message: 'down' } };
  if (svc) return { results: R[svc] || [] };
  throw new Error(`unexpected request ${url}`);
}

test('parcel_inventory passes conformance and inventories every layer in one call per service', async () => {
  const { result, trace, resources, requests } = await checkPlugin(parcelInventory, { city: norfolk, args: { address: '1300 Colley Ave' }, respond: respondParcel });
  assert.equal(requests.filter((u) => u.includes('/MapServer/identify')).length, SERVICES.length);
  assert.equal(result.layers.Planning.find((l) => l.layer === 'Zoning').ZONE, 'C-C');
  assert.equal(result.layers.Parcels[0].GPIN, '1428629504');
  assert.match(result.layers.RPOS.error, /down/);
  assert.ok(trace.some((s) => /map layers at parcel centroid/.test(s.tool)));
  assert.ok(resources.links.some((l) => /Zoning Ordinance/.test(l.title)));
});

test('parcel_inventory withholds people, editors and bookkeeping, and keeps elected officials', async () => {
  const { result } = await checkPlugin(parcelInventory, { city: norfolk, args: { address: '1300 Colley Ave' }, respond: respondParcel });
  const text = JSON.stringify(result.layers);
  assert.doesNotMatch(text, /A Private Person|P\.O\. Box 1|someone@example|MSTRALE|STArea|OBJECTID|"Null"/);
  assert.match(text, /Courtney Doyle/);
  assert.match(text, /3rd Wednesday/);
  assert.deepEqual(result.withheld_fields, ['Civic Leagues: E_MAIL', 'Civic Leagues: PRESIDENT', 'Civic Leagues: PRES_ADDRE']);
});

test('parcel_inventory field rules work on map aliases too', () => {
  const { attributes, dropped } = cleanAttributes({ 'President Address': 'x', 'President Email': 'y', President: 'z', 'Meeting Time': '6:00 pm', 'Owner Name': 'q', 'Sector Color': 'BLUE' });
  assert.deepEqual(Object.keys(attributes), ['Meeting Time', 'Sector Color']);
  assert.equal(dropped.length, 4);
  assert.match(decodeURIComponent(identifyUrl('Planning', -76.298, 36.866)), /OpenData\/Planning\/MapServer\/identify\?geometry=-76.298,36.866/);
});

// Built and merged is not the same as served: everything in data/cases/ and
// plugins/ has to reach Siren.
test('every case file is served by case_file, and every plugin is in Siren', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { CASES } = await import('../plugins/case-file.js');
  const { default: siren } = await import('../deployments/siren.config.js');
  const caseDir = new URL('../data/cases/', import.meta.url);
  for (const f of readdirSync(caseDir).filter((f) => f.endsWith('.json'))) {
    const { id } = JSON.parse(readFileSync(new URL(f, caseDir), 'utf8'));
    assert.ok(CASES[id], `data/cases/${f} (${id}) is not in plugins/case-file.js CASES`);
  }
  const served = new Set(siren.plugins.map((p) => p.name));
  const pluginDir = new URL('../plugins/', import.meta.url);
  for (const f of readdirSync(pluginDir).filter((f) => f.endsWith('.js'))) {
    const mod = await import(new URL(f, pluginDir));
    if (typeof mod.default?.run !== 'function') continue; // a helper module, not a plugin
    assert.ok(served.has(mod.default.name), `plugins/${f} (${mod.default.name}) is not in deployments/siren.config.js`);
  }
});
