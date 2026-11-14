// Siren's place tools (plugins/gis.js, street_segment, housing_count,
// area_lookup): Jason's challenge question, "What proportion of Ghent's
// housing is on Graydon between Colley and Colonial?" (2026-11-13), and his
// calls on 2026-11-14: all three Ghents, asked about; touching parcels count;
// per-building apartment units. docs/gis-skills.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPlugin, checkPluginSource } from './conformance.js';
import { getCity } from '../src/cities/index.js';
import siren from '../deployments/siren.config.js';
import streetSegment from '../plugins/street-segment.js';
import housingCount from '../plugins/housing-count.js';
import areaLookup from '../plugins/area-lookup.js';
import {
  streetKey, cleanName, resolveSegment, touchingParcels, homesByParcel, tally, projector, classCode, isResidentialCode, MIN_PARCELS,
} from '../plugins/gis.js';

const norfolk = getCity('norfolk');
const CENTERLINES = JSON.parse(readFileSync(new URL('./fixtures/gis-graydon-centerlines.json', import.meta.url), 'utf8')).features;

// --- a small world, in meters from an origin near Ghent -----------------------
const LAT0 = 36.87;
const LON0 = -76.3;
const ky = (Math.PI / 180) * 6371008.8;
const kx = ky * Math.cos((LAT0 * Math.PI) / 180);
const ll = ([x, y]) => [LON0 + x / kx, LAT0 + y / ky];
const square = (x0, y0, x1, y1) => [[ll([x0, y0]), ll([x1, y0]), ll([x1, y1]), ll([x0, y1]), ll([x0, y0])]];
const line = (pts) => pts.map(ll);

// TEST AVENUE runs 0-300 m along y = 0 (blocks 100 and 200), between ALPHA (x = 0) and BETA (x = 300).
const STREETS = [
  { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', LBLOCK: '100', LADD_FR: 101, LADD_TO: 149, RADD_FR: 100, RADD_TO: 148, SPEEDLIMIT: 20, ONEWAY: 0, CLASS: '3', LENGTH: 492 }, geometry: { paths: [line([[0, 0], [150, 0]])] } },
  { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', LBLOCK: '200', LADD_FR: 201, LADD_TO: 249, RADD_FR: 200, RADD_TO: 248, SPEEDLIMIT: 25, ONEWAY: 1, CLASS: '3', LENGTH: 492 }, geometry: { paths: [line([[150, 0], [300, 0]])] } },
  { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', LBLOCK: '300', LADD_FR: 301, LADD_TO: 349, RADD_FR: 300, RADD_TO: 348, SPEEDLIMIT: 25, ONEWAY: 0, CLASS: '3', LENGTH: 492 }, geometry: { paths: [line([[300, 0], [450, 0]])] } },
  { attributes: { FULLNAME: 'ALPHA STREET', ST_NAME: 'ALPHA', LBLOCK: '1000' }, geometry: { paths: [line([[0, -200], [0, 0], [0, 200]])] } },
  { attributes: { FULLNAME: 'BETA STREET', ST_NAME: 'BETA', LBLOCK: '1000' }, geometry: { paths: [line([[300, -200], [300, 0], [300, 200]])] } },
];
// Parcels: a row each side of the street, a row behind the north one, and one past BETA.
const PARCELS = [];
const ROLL = [];
let n = 0;
const parcel = (rings, rows) => {
  n += 1;
  const gpin = String(1400000000 + n);
  PARCELS.push({ attributes: { GPIN: gpin }, geometry: { rings } });
  for (const r of rows) ROLL.push({ gpin, property_street_name: 'Test', n: '1', ...r });
  return gpin;
};
const SF = { property_class_description: '513 S/F Detached =2 but <3 Sty' };
const north = [];
for (let i = 0; i < 10; i++) {
  const x = 5 + i * 29;
  const rows = i === 3 ? [{ property_class_description: '403 Apartment 12-48 Fam Desi', area: '1000', built: '1950' }]
    : i === 6 ? [{ property_class_description: '403 Apartment 12-48 Fam Desi', area: '3000', built: '1950' }]
      : [SF];
  north.push(parcel(square(x, 10, x + 20, 30), i === 0 ? rows.map((r) => ({ ...r, property_street_name: 'Alpha' })) : rows));
}
for (let i = 0; i < 10; i++) {
  const x = 5 + i * 29;
  const rows = i < 6 ? [SF] : i < 8 ? [{ property_class_description: '520 Res Duplex Designed' }] : i === 8 ? [{ property_class_description: '550 Res 2-4 Condo Designed', n: '8' }] : [{ property_class_description: '429 Com Other Retail Bldg' }];
  parcel(square(x, -30, x + 20, -10), rows);
}
for (let i = 0; i < 10; i++) parcel(square(5 + i * 29, 50, 25 + i * 29, 70), [SF]);
const beyond = parcel(square(310, 10, 330, 30), [SF]);
// Exact homes: 8 + 6 + 2x2 + 8 + 10 + 1 = 37; the block holds 117, so 80 are the two apartment buildings'.
const BLOCK = { attributes: { GEOID: '517100000001000', HU100: 117, INTPTLON: ll([150, 0])[0], INTPTLAT: ll([150, 0])[1] }, geometry: { rings: square(-200, -200, 500, 200) } };
const LEAGUE = square(-100, -100, 400, 100);

function world(seen = []) {
  return (url) => {
    seen.push(url);
    const q = new URL(url).searchParams;
    if (url.includes('/Maps/MapServer/12/query')) {
      const where = q.get('where');
      if (where.includes('LIKE')) return { features: [{ attributes: { LEAGUE: 'Test League' } }, { attributes: { LEAGUE: 'West Test' } }] };
      return { features: [{ attributes: { LEAGUE: 'Test League' }, geometry: { rings: LEAGUE } }] };
    }
    if (url.includes('/Planning/MapServer/2/query')) return { features: [] };
    if (url.includes('/Public_Works/MapServer/1/query')) return { features: STREETS };
    if (url.includes('tigerweb.geo.census.gov')) return { features: [BLOCK] };
    if (url.includes('/Parcels/MapServer/1/query')) return { features: PARCELS };
    if (url.includes('/api/views/qva7-tzrf')) {
      return { name: 'Property Assessment and Sales - FY27', columns: ['gpin', 'owner', 'grantor', 'grantee', 'legal_description', 'document_number', 'property_street_name', 'property_class_description', 'commercial_building_area', 'improvement_year_built'].map((fieldName) => ({ fieldName })) };
    }
    if (url.includes('/resource/qva7-tzrf')) {
      const soql = decodeURIComponent(new URL(url).searchParams.get('$query'));
      const ids = new Set((/gpin IN \(([^)]*)\)/.exec(soql)?.[1] || '').split(',').map((s) => s.trim()));
      return ROLL.filter((r) => ids.has(r.gpin));
    }
    throw new Error(`unexpected request ${url}`);
  };
}

test('street and area names: plain names only, types and directions dropped for the centerline', () => {
  assert.equal(streetKey('Graydon Ave'), 'GRAYDON');
  assert.equal(streetKey('W. Little Creek Road'), 'LITTLE CREEK');
  assert.equal(streetKey('Mowbray Arch'), 'MOWBRAY');
  assert.equal(streetKey("O'Keefe St"), 'OKEEFE');
  assert.equal(cleanName("x' OR 1=1 --"), null);
  assert.equal(cleanName('Ghent; DROP'), null);
  assert.equal(streetKey(''), null);
});

test('Graydon between Colley and Colonial is its 500-700 blocks, from the City\'s own centerlines', async () => {
  const ctx = { http: { json: async () => ({ features: CENTERLINES }) } };
  const { segment, error } = await resolveSegment(ctx, { street: 'Graydon Ave', from: 'Colley Ave', to: 'Colonial Ave' });
  assert.equal(error, undefined);
  assert.equal(segment.street, 'GRAYDON AVENUE');
  assert.deepEqual(segment.blocks.map((b) => b.block), [500, 600, 700]);
  assert.equal(segment.addresses, '502-755');
  for (const b of segment.blocks) {
    assert.equal(b.carriageways, 2);
    assert.deepEqual(b.traffic, ['one-way (divided road)']);
    assert.deepEqual(b.speed_limit_mph, [20]);
    assert.deepEqual(b.road_class, ['minor']);
  }
  // Either order of cross streets gives the same blocks.
  const back = await resolveSegment(ctx, { street: 'Graydon', from: 'Colonial', to: 'Colley' });
  assert.deepEqual(back.segment.blocks.map((b) => b.block), [500, 600, 700]);
  const miss = await resolveSegment({ http: { json: async () => ({ features: CENTERLINES.filter((f) => f.attributes.ST_NAME !== 'COLONIAL') }) } }, { street: 'Graydon', from: 'Colley', to: 'Colonial' });
  assert.match(miss.error, /doesn't meet/);
  assert.match((await resolveSegment(ctx, { street: 'Graydon', from: 'Graydon', to: 'Colley' })).error, /three different streets/);
});

test('touching parcels: both frontages and the corner lot; not the row behind, not past the cross street', async () => {
  const ctx = { http: { json: async () => ({ features: STREETS }) } };
  const { segment } = await resolveSegment(ctx, { street: 'Test', from: 'Alpha', to: 'Beta' });
  assert.deepEqual(segment.blocks.map((b) => b.block), [100, 200]);
  const parcels = new Map(PARCELS.map((f) => [f.attributes.GPIN, f.geometry.rings]));
  const touch = new Set(touchingParcels(parcels, segment));
  assert.equal(touch.size, 20, 'ten each side');
  assert.ok(touch.has(north[0]), 'the corner lot');
  assert.ok(!touch.has(beyond), 'past BETA');
  for (const f of PARCELS.slice(20, 30)) assert.ok(!touch.has(f.attributes.GPIN), 'the row behind');
});

test('apartment units: the block\'s 2020 count, less the exact homes, shared by building area within each band', () => {
  const parcels = new Map(PARCELS.map((f) => [f.attributes.GPIN, f.geometry.rings]));
  const blocks = [{ geoid: 'b', hu: 117, point: ll([150, 0]), rings: BLOCK.geometry.rings, box: { xmin: -77, ymin: 36, xmax: -76, ymax: 37 } }];
  const { byParcel, notes } = homesByParcel(parcels, blocks, ROLL);
  assert.equal(Math.round(byParcel.get(north[3]).estimated), 32);
  assert.equal(Math.round(byParcel.get(north[6]).estimated), 48, 'capped at its band, 12-48');
  assert.equal(notes.fit_block_count, 2);
  const all = tally(byParcel, parcels.keys());
  assert.equal(all.homes, 117);
  assert.equal(all.homes_counted_exactly, 37);
  assert.equal(all.residential_parcels, 30, 'the shop is not a home');
  // More homes than the bands allow: each building at its ceiling. Fewer: at its floor.
  const over = homesByParcel(parcels, [{ ...blocks[0], hu: 500 }], ROLL);
  assert.equal(Math.round(over.byParcel.get(north[3]).estimated + over.byParcel.get(north[6]).estimated), 96);
  assert.equal(over.notes.over_bands, 2);
  const short = homesByParcel(parcels, [{ ...blocks[0], hu: 40 }], ROLL);
  assert.equal(Math.round(short.byParcel.get(north[3]).estimated + short.byParcel.get(north[6]).estimated), 24);
  assert.equal(short.notes.short_of_bands, 2);
  // Built after 2020, or in no block: the band's floor.
  const late = homesByParcel(parcels, blocks, ROLL.map((r) => (r.gpin === north[6] ? { ...r, built: '2023' } : r)));
  assert.equal(late.byParcel.get(north[6]).estimated, 12);
  assert.equal(late.notes.built_after_2020, 1);
  const none = homesByParcel(parcels, [], ROLL);
  assert.equal(none.byParcel.get(north[3]).estimated, 12);
  assert.equal(none.notes.no_block, 2);
});

test('class codes: the residential ones count, a boat slip and a shop do not', () => {
  assert.equal(classCode('513 S/F Detached =2 but <3 Sty'), 513);
  assert.ok(isResidentialCode(553) && isResidentialCode(405) && isResidentialCode(518));
  assert.ok(!isResidentialCode(559) && !isResidentialCode(429) && !isResidentialCode(500));
});

test('housing_count: a street\'s share of an area, computed in code, through the plugin context', async () => {
  const seen = [];
  const { result, resources } = await checkPlugin(housingCount, {
    city: norfolk,
    args: { place: { street: 'Test Ave', from: 'Alpha St', to: 'Beta St' }, of: { areas: [{ kind: 'civic_league', name: 'Test League' }] } },
    respond: world(seen),
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.place.residential_parcels, 19);
  assert.equal(result.place.homes, 106);
  assert.equal(result.place.homes_counted_exactly, 26);
  assert.equal(result.place.homes_estimated, 80);
  assert.equal(result.place.addressed_on_this_street, 18);
  assert.equal(result.place.addressed_on_cross_streets_or_others, 1);
  assert.equal(result.of.residential_parcels, 30);
  assert.equal(result.of.homes, 117);
  assert.equal(result.of.census_2020_housing_units, 117);
  assert.deepEqual(result.share, { of_residential_parcels: '63.3%', of_homes: '90.6%' });
  assert.ok(resources.datasets.some((d) => d.id === 'qva7-tzrf'));
  // Never an owner field, never a coordinate or a GPIN in what the model reads.
  const roll = seen.filter((u) => u.includes('/resource/qva7-tzrf')).map((u) => decodeURIComponent(u));
  assert.ok(roll.length >= 1);
  for (const q of roll) assert.doesNotMatch(q, /owner|grantor|grantee|legal_description|document_number/i);
  for (const u of seen.filter((x) => x.includes('/Maps/MapServer/12/'))) assert.equal(new URL(u).searchParams.get('outFields'), 'LEAGUE');
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /-76\.\d{3}|36\.\d{3}|14000000\d\d/);
});

test(`housing_count refuses fewer than ${MIN_PARCELS} residential parcels, and an unknown area`, async () => {
  const few = STREETS.map((f) => (f.attributes.ST_NAME === 'BETA' ? { ...f, geometry: { paths: [line([[40, -200], [40, 0], [40, 200]])] } } : f));
  const respond = (url) => (url.includes('/Public_Works/') ? { features: [...few, { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', LBLOCK: '100' }, geometry: { paths: [line([[0, 0], [40, 0]])] } }].filter((f) => !(f.attributes.ST_NAME === 'TEST' && f.attributes.LBLOCK === '100' && f.geometry.paths[0].length === 2 && f.geometry.paths[0][1][0] > ll([100, 0])[0])) } : world()(url));
  const { result } = await checkPlugin(housingCount, { city: norfolk, args: { place: { street: 'Test', from: 'Alpha', to: 'Beta' } }, respond });
  assert.match(result.error, /fewer than 5 residential parcels/);
  const unknown = await checkPlugin(housingCount, {
    city: norfolk, args: { place: { areas: [{ kind: 'civic_league', name: 'Nowhere' }] } },
    respond: (url) => (url.includes('/Maps/MapServer/12/') ? { features: [] } : world()(url)),
  });
  assert.match(unknown.result.error, /No civic league is named "Nowhere"/);
});

test('housing_count refuses an area past the parcel cap rather than spend the request budget', async () => {
  const many = Array.from({ length: 4001 }, (_, i) => ({ attributes: { GPIN: String(1500000000 + i) }, geometry: { rings: square(0, 0, 1, 1) } }));
  const { result } = await checkPlugin(housingCount, {
    city: norfolk, args: { place: { areas: [{ kind: 'civic_league', name: 'Test League' }] } },
    respond: (url) => (url.includes('/Parcels/') ? { features: many } : world()(url)),
  });
  assert.match(result.error, /more than 4000 parcels/);
});

test('street_segment: blocks, street fields and touching parcels, counted, never listed', async () => {
  const { result } = await checkPlugin(streetSegment, { city: norfolk, args: { street: 'Test', from: 'Alpha', to: 'Beta' }, respond: world() });
  assert.equal(result.street, 'TEST AVENUE');
  assert.deepEqual(result.blocks.map((b) => [b.block, b.speed_limit_mph[0], b.traffic[0]]), [[100, 20, 'two-way'], [200, 25, 'one-way']]);
  assert.equal(result.addresses, '100-249');
  assert.equal(result.parcels_touching, 20);
  assert.equal(result.residential_parcels_touching, 19);
  assert.equal(result.residential_addressed_on_this_street, 18);
  assert.doesNotMatch(JSON.stringify(result), /14000000\d\d|-76\.\d{3}/);
});

test('area_lookup: every match, and a prompt to ask when there is more than one; only the name field is requested', async () => {
  const seen = [];
  const { result } = await checkPlugin(areaLookup, { city: norfolk, args: { name: 'Test' }, respond: world(seen) });
  assert.deepEqual(result.matches.map((m) => m.name), ['Test League', 'West Test']);
  assert.match(result.ask, /matches 2 areas.*ask which one is meant.*all of them together/);
  for (const u of seen.filter((x) => x.includes('/Maps/MapServer/12/'))) assert.equal(new URL(u).searchParams.get('outFields'), 'LEAGUE');
  const one = await checkPlugin(areaLookup, {
    city: norfolk, args: { name: 'Test', kinds: ['civic_league'] },
    respond: (url) => (url.includes('/Maps/MapServer/12/') ? { features: [{ attributes: { LEAGUE: 'Test League' } }] } : world()(url)),
  });
  assert.equal(one.result.ask, undefined);
  const bad = await checkPlugin(areaLookup, { city: norfolk, args: { name: "' OR 1=1" }, respond: world() });
  assert.match(bad.result.error, /plain name/);
});

test('Siren declares the place tools, says when to use them, and asks when a name matches several areas', () => {
  for (const name of ['street_segment', 'housing_count', 'area_lookup']) {
    assert.ok(siren.plugins.some((p) => p.name === name), name);
    assert.match(siren.prompt, new RegExp(name));
  }
  assert.match(siren.prompt, /ask which one the person means, offering all of them together/);
  assert.match(siren.prompt, /give the share it computes rather than working one out/);
  for (const f of ['gis.js', 'street-segment.js', 'housing-count.js', 'area-lookup.js']) checkPluginSource(readFileSync(new URL(`../plugins/${f}`, import.meta.url), 'utf8'));
});

test('projected distances: a meter is a meter near Norfolk', () => {
  const P = projector(LAT0);
  const [x0] = P(ll([0, 0]));
  const [x1] = P(ll([100, 0]));
  assert.ok(Math.abs(x1 - x0 - 100) < 0.01);
});
