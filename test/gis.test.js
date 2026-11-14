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
import housingCount, { ACCURACY } from '../plugins/housing-count.js';
import areaLookup from '../plugins/area-lookup.js';
import {
  streetQuery, cleanName, resolveSegment, touchingParcels, homesByParcel, tally, projector, centroid, classCode, isResidentialCode, MIN_PARCELS, BOX_CAP,
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
  { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', ST_TYPE: 'AVENUE', LBLOCK: '100', LADD_FR: 101, LADD_TO: 149, RADD_FR: 100, RADD_TO: 148, SPEEDLIMIT: 20, ONEWAY: 0, CLASS: '3', LENGTH: 492 }, geometry: { paths: [line([[0, 0], [150, 0]])] } },
  { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', ST_TYPE: 'AVENUE', LBLOCK: '200', LADD_FR: 201, LADD_TO: 249, RADD_FR: 200, RADD_TO: 248, SPEEDLIMIT: 25, ONEWAY: 1, CLASS: '3', LENGTH: 492 }, geometry: { paths: [line([[150, 0], [300, 0]])] } },
  { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', ST_TYPE: 'AVENUE', LBLOCK: '300', LADD_FR: 301, LADD_TO: 349, RADD_FR: 300, RADD_TO: 348, SPEEDLIMIT: 25, ONEWAY: 0, CLASS: '3', LENGTH: 492 }, geometry: { paths: [line([[300, 0], [450, 0]])] } },
  // A piece of the same street across town, numbered between the two blocks: not part of the walk.
  { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', ST_TYPE: 'AVENUE', LBLOCK: '150', LADD_FR: 151, LADD_TO: 199, RADD_FR: 150, RADD_TO: 198, ONEWAY: 0, CLASS: '3' }, geometry: { paths: [line([[5000, 0], [5100, 0]])] } },
  // TEST MEWS shares the name: a separate street, never merged with the avenue.
  { attributes: { FULLNAME: 'TEST MEWS', ST_NAME: 'TEST', ST_TYPE: 'MEWS', LBLOCK: '100', ONEWAY: 0, CLASS: '6' }, geometry: { paths: [line([[0, 120], [300, 120]])] } },
  { attributes: { FULLNAME: 'ALPHA STREET', ST_NAME: 'ALPHA', ST_TYPE: 'STREET', LBLOCK: '1000' }, geometry: { paths: [line([[0, -200], [0, 0], [0, 200]])] } },
  { attributes: { FULLNAME: 'BETA STREET', ST_NAME: 'BETA', ST_TYPE: 'STREET', LBLOCK: '1000' }, geometry: { paths: [line([[300, -200], [300, 0], [300, 200]])] } },
];
// Parcels: a row each side of the street, a row behind the north one, and one past BETA.
const PARCELS = [];
const ROLL = [];
let n = 0;
const parcel = (rings, rows) => {
  n += 1;
  const gpin = String(1400000000 + n);
  PARCELS.push({ attributes: { GPIN: gpin }, geometry: { rings } });
  for (const r of rows) ROLL.push({ gpin, property_street_name: 'Test', property_street_type: 'AV', n: '1', rows: '1', ...r });
  return gpin;
};
const SF = { property_class_description: '513 S/F Detached =2 but <3 Sty' };
const north = [];
for (let i = 0; i < 10; i++) {
  const x = 5 + i * 29;
  const rows = i === 3 ? [{ property_class_description: '403 Apartment 12-48 Fam Desi', area: '1000', built: '1950' }]
    : i === 6 ? [{ property_class_description: '403 Apartment 12-48 Fam Desi', area: '3000', built: '1950' }]
      : [SF];
  north.push(parcel(square(x, 10, x + 20, 30), i === 0 ? rows.map((r) => ({ ...r, property_street_name: 'Alpha', property_street_type: 'ST' })) : rows));
}
for (let i = 0; i < 10; i++) {
  const x = 5 + i * 29;
  // The condo row is 8 accounts in 3 building rows: 8 homes, not 3.
  const rows = i < 6 ? [SF] : i < 8 ? [{ property_class_description: '520 Res Duplex Designed' }] : i === 8 ? [{ property_class_description: '550 Res 2-4 Condo Designed', n: '8', rows: '3' }] : [{ property_class_description: '429 Com Other Retail Bldg' }];
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
    if (url.includes('/Parcels/MapServer/1/query')) return q.get('returnCountOnly') ? { count: PARCELS.length } : { features: PARCELS };
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

test('street names: the names a centerline might hold, with the type and direction kept apart', () => {
  assert.deepEqual(streetQuery('Graydon Ave'), { keys: ['GRAYDON'], type: 'AVENUE', dir: null, label: 'Graydon Ave' });
  assert.deepEqual(streetQuery('W. Little Creek Road'), { keys: ['W LITTLE CREEK', 'LITTLE CREEK'], type: 'ROAD', dir: 'W', label: 'W. Little Creek Road' });
  assert.deepEqual(streetQuery('North Shore').keys, ['NORTH SHORE', 'SHORE'], 'North Shore Road is NORTH SHORE in the centerlines');
  assert.deepEqual(streetQuery('Avenue I').keys, ['AVENUE I', 'I'], 'Avenue I is I in the centerlines');
  assert.equal(streetQuery('Llewellyn Mews').type, 'MEWS');
  assert.deepEqual(streetQuery("O'Keefe St").keys, ['OKEEFE']);
  assert.equal(cleanName("x' OR 1=1 --"), null);
  assert.equal(cleanName('Ghent; DROP'), null);
  assert.equal(streetQuery(''), null);
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
  assert.match(miss.error, /no street named Colonial/);
  assert.match((await resolveSegment(ctx, { street: 'Graydon', from: 'Graydon', to: 'Colley' })).error, /three different streets/);
});

test('touching parcels: both frontages and the corner lot; not the row behind, not past the cross street', async () => {
  const ctx = { http: { json: async () => ({ features: STREETS }) } };
  const { segment } = await resolveSegment(ctx, { street: 'Test', from: 'Alpha', to: 'Beta' });
  assert.deepEqual(segment.blocks.map((b) => b.block), [100, 200], 'the walk, not every block numbered between');
  assert.equal(segment.street, 'TEST AVENUE');
  assert.equal(segment.length_m, 300);
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
  assert.equal(notes.apartment_properties_fit, 2);
  const all = tally(byParcel, parcels.keys());
  assert.equal(all.homes, 117);
  assert.equal(all.homes_counted_exactly, 37);
  assert.equal(all.residential_parcels, 30, 'the shop is not a home');
  assert.equal(all.homes_by_kind['condominium unit'], 8, 'eight accounts, three building rows');
  assert.equal(all.properties_by_kind['condominium unit'], 8);
  assert.equal(all.homes_by_kind.duplex, 4);
  assert.equal(all.properties_by_kind.duplex, 2);
  assert.equal(all.homes_by_kind.apartments, 80);
  assert.equal(all.properties_by_kind.apartments, 2);
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
  assert.equal(result.place.residential_addressed_on_this_street, 18);
  assert.equal(result.place.residential_addressed_on_cross_streets_or_others, 1);
  assert.equal(result.of.residential_parcels, 30);
  assert.equal(result.of.homes, 117);
  assert.equal(result.of.census_2020_housing_units, 117);
  assert.deepEqual(result.share, { of_residential_parcels: '63.3%', of_homes: '90.6%' });
  assert.ok(resources.datasets.some((d) => d.id === 'qva7-tzrf'));
  assert.equal(result.how_homes_were_counted.accuracy, ACCURACY);
  assert.doesNotMatch(ACCURACY, /PENDING/);
  // Never an owner field, never a coordinate or a GPIN in what the model reads.
  const roll = seen.filter((u) => u.includes('/resource/qva7-tzrf')).map((u) => decodeURIComponent(u));
  assert.ok(roll.length >= 1);
  for (const q of roll) assert.doesNotMatch(q, /owner|grantor|grantee|legal_description|document_number/i);
  for (const q of roll) assert.match(q, /count\(distinct lrsn\) AS n/, 'properties are distinct accounts');
  for (const u of seen.filter((x) => x.includes('/Maps/MapServer/12/'))) assert.equal(new URL(u).searchParams.get('outFields'), 'LEAGUE');
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /-76\.\d{3}|36\.\d{3}|14000000\d\d/);
});

test(`housing_count refuses fewer than ${MIN_PARCELS} residential parcels, and an unknown area`, async () => {
  const few = STREETS.map((f) => (f.attributes.ST_NAME === 'BETA' ? { ...f, geometry: { paths: [line([[40, -200], [40, 0], [40, 200]])] } } : f));
  const respond = (url) => (url.includes('/Public_Works/') ? { features: [...few, { attributes: { FULLNAME: 'TEST AVENUE', ST_NAME: 'TEST', LBLOCK: '100' }, geometry: { paths: [line([[0, 0], [40, 0]])] } }].filter((f) => !(f.attributes.ST_NAME === 'TEST' && f.attributes.LBLOCK === '100' && f.geometry.paths[0].length === 2 && f.geometry.paths[0][1][0] > ll([100, 0])[0])) } : world()(url));
  const asked = [];
  const { result } = await checkPlugin(housingCount, { city: norfolk, args: { place: { street: 'Test', from: 'Alpha', to: 'Beta' } }, respond: (url) => (asked.push(url), respond(url)) });
  assert.match(result.error, /fewer than 5 (residential )?parcels/);
  assert.ok(!asked.some((u) => u.includes('/resource/qva7-tzrf')), 'refused before any roll query');
  const unknown = await checkPlugin(housingCount, {
    city: norfolk, args: { place: { areas: [{ kind: 'civic_league', name: 'Nowhere' }] } },
    respond: (url) => (url.includes('/Maps/MapServer/12/') ? { features: [] } : world()(url)),
  });
  assert.match(unknown.result.error, /No civic league is named "Nowhere"/);
});

test('housing_count counts parcels first and refuses a box past the cap without downloading it', async () => {
  const seen = [];
  const { result } = await checkPlugin(housingCount, {
    city: norfolk, args: { place: { areas: [{ kind: 'civic_league', name: 'Test League' }] } },
    respond: (url) => {
      seen.push(url);
      if (url.includes('/Parcels/')) {
        assert.equal(new URL(url).searchParams.get('returnCountOnly'), 'true', 'only the count is asked for');
        return { count: BOX_CAP + 1 };
      }
      return world()(url);
    },
  });
  assert.match(result.error, new RegExp(`more than ${BOX_CAP} parcels`));
  assert.ok(!seen.some((u) => u.includes('/resource/qva7-tzrf')), 'no roll query');
});

test('the walk: unbroken from one cross street to the other, by full street name, at a known type', async () => {
  const at = (features) => ({ http: { json: async () => ({ features }) } });
  // TEST MEWS never meets ALPHA and BETA, so TEST and TEST AVENUE both find the avenue.
  for (const street of ['Test', 'Test Ave']) {
    const { segment } = await resolveSegment(at(STREETS), { street, from: 'Alpha', to: 'Beta' });
    assert.equal(segment.street, 'TEST AVENUE', street);
  }
  // Asked for the mews, it isn't the avenue.
  assert.match((await resolveSegment(at(STREETS), { street: 'Test Mews', from: 'Alpha', to: 'Beta' })).error, /doesn't meet/);
  // A gap in the avenue between the cross streets.
  const piece200 = (f) => f.attributes.LBLOCK === '200' && f.attributes.ST_NAME === 'TEST';
  const broken = STREETS.map((f) => (piece200(f) ? { ...f, geometry: { paths: [line([[180, 0], [300, 0]])] } } : f));
  assert.match((await resolveSegment(at(broken), { street: 'Test', from: 'Alpha', to: 'Beta' })).error, /doesn't run unbroken/);
  // A small gap between pieces (under 12 m) is the same street.
  const nudged = STREETS.map((f) => (piece200(f) ? { ...f, geometry: { paths: [line([[158, 0], [300, 0]])] } } : f));
  assert.deepEqual((await resolveSegment(at(nudged), { street: 'Test', from: 'Alpha', to: 'Beta' })).segment.blocks.map((b) => b.block), [100, 200]);
});

test("past the cross street: by which side of it a lot's center lies, along an oblique cross street too", async () => {
  // BETA crosses TEST AVENUE at x = 300 at 45 degrees; a lot short of it counts, one across does not.
  const oblique = STREETS.map((f) => (f.attributes.ST_NAME === 'BETA' ? { ...f, geometry: { paths: [line([[200, -100], [300, 0], [400, 100]])] } } : f));
  const { segment } = await resolveSegment({ http: { json: async () => ({ features: oblique }) } }, { street: 'Test', from: 'Alpha', to: 'Beta' });
  const lots = new Map([
    ['inside', square(250, -30, 268, -10)], // south side, short of the diagonal
    ['across', square(305, -30, 325, -10)], // south side, past the diagonal but within reach of the street's end
    ['corner', square(255, 10, 285, 30)], // north side, its center short of the diagonal
  ]);
  const touch = new Set(touchingParcels(lots, segment));
  assert.ok(touch.has('inside'), 'inside');
  assert.ok(touch.has('corner'), 'corner');
  assert.ok(!touch.has('across'), 'across');
});

test('centroids keep their precision: a 5 m lot near Norfolk, to the centimeter', () => {
  const c = centroid(square(1000, 1000, 1005, 1005));
  const P = projector(LAT0);
  const [a, b] = [P(c), P(ll([1002.5, 1002.5]))];
  assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01);
});

test('street_segment: blocks, street fields and touching parcels, counted, never listed', async () => {
  const { result } = await checkPlugin(streetSegment, { city: norfolk, args: { street: 'Test', from: 'Alpha', to: 'Beta' }, respond: world() });
  assert.equal(result.street, 'TEST AVENUE');
  assert.deepEqual(result.blocks.map((b) => [b.block, b.speed_limit_mph[0], b.traffic[0], b.length_ft]), [[100, 20, 'two-way', 492], [200, 25, 'one-way', 492]]);
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

test('housing_count reads parcels past the places only for blocks holding a counted apartment property', async () => {
  const parcelReads = async (roll) => {
    const seen = [];
    const base = world(seen);
    const { result } = await checkPlugin(housingCount, {
      city: norfolk,
      args: { place: { street: 'Test', from: 'Alpha', to: 'Beta' }, of: { areas: [{ kind: 'civic_league', name: 'Test League' }] } },
      respond: (url) => {
        if (url.includes('/resource/qva7-tzrf')) {
          seen.push(url);
          const soql = decodeURIComponent(new URL(url).searchParams.get('$query'));
          const ids = new Set((/gpin IN \(([^)]*)\)/.exec(soql)?.[1] || '').split(',').map((x) => x.trim()));
          return roll.filter((r) => ids.has(r.gpin));
        }
        return base(url);
      },
    });
    assert.equal(result.error, undefined, result.error);
    return seen.filter((u) => u.includes('/Parcels/') && !new URL(u).searchParams.get('returnCountOnly')).length;
  };
  // The census block reaches past both places: with apartments it is read whole, without them it isn't.
  assert.equal(await parcelReads(ROLL), 2);
  assert.equal(await parcelReads(ROLL.filter((r) => !r.property_class_description.startsWith('403'))), 1);
});

test('housing_count refuses more than 8000 parcels to count, before any roll query', async () => {
  const many = Array.from({ length: 8001 }, (_, i) => ({ attributes: { GPIN: String(1500000000 + i) }, geometry: { rings: square(-90 + (i % 90) * 5, -90 + Math.floor(i / 90) * 2, -89 + (i % 90) * 5, -89 + Math.floor(i / 90) * 2) } }));
  const asked = [];
  const { result } = await checkPlugin(housingCount, {
    city: norfolk, args: { place: { areas: [{ kind: 'civic_league', name: 'Test League' }] } },
    respond: (url) => {
      asked.push(url);
      if (url.includes('/Parcels/')) return new URL(url).searchParams.get('returnCountOnly') ? { count: many.length } : { features: many };
      return world()(url);
    },
  });
  assert.match(result.error, /more than 8000 parcels/);
  assert.ok(!asked.some((u) => u.includes('/resource/qva7-tzrf')));
});

test("an apartment estimate counts the homes of its block's parcels outside the places too", async () => {
  // A house in the census block but outside the league and off the street: read, and subtracted from the block.
  const outsider = { attributes: { GPIN: '1499999999' }, geometry: { rings: square(450, 150, 470, 170) } };
  const roll = [...ROLL, { gpin: '1499999999', property_class_description: '513 S/F Detached =2 but <3 Sty', property_street_name: 'Far', n: '1', rows: '1' }];
  const asked = [];
  const base = world();
  const { result } = await checkPlugin(housingCount, {
    city: norfolk,
    args: { place: { street: 'Test', from: 'Alpha', to: 'Beta' }, of: { areas: [{ kind: 'civic_league', name: 'Test League' }] } },
    respond: (url) => {
      if (url.includes('/Parcels/')) return new URL(url).searchParams.get('returnCountOnly') ? { count: PARCELS.length + 1 } : { features: [...PARCELS, outsider] };
      if (url.includes('/resource/qva7-tzrf')) {
        asked.push(decodeURIComponent(url));
        const soql = decodeURIComponent(new URL(url).searchParams.get('$query'));
        const ids = new Set((/gpin IN \(([^)]*)\)/.exec(soql)?.[1] || '').split(',').map((x) => x.trim()));
        return roll.filter((r) => ids.has(r.gpin));
      }
      return base(url);
    },
  });
  assert.equal(result.error, undefined, result.error);
  assert.ok(asked.some((q) => q.includes('1499999999')), "the outsider's roll rows were read");
  assert.equal(result.place.homes_estimated, 79, '117 in the block, less 38 exact homes');
  assert.equal(result.place.homes, 105);
  assert.equal(result.of.residential_parcels, 30, 'the outsider is not in the league');
});

test('a walk ending on a median crossover keeps its frontage, and the crossover adds no block', async () => {
  // DIV AVENUE: carriageways at y = -10 (south) and y = +10 (north), x 0-300, a crossover at x = 300.
  // ALPHA meets only the south carriageway; BETA, running north, meets only the north one, at the crossover's end.
  const div = (block, pts, extra = {}) => ({ attributes: { FULLNAME: 'DIV AVENUE', ST_NAME: 'DIV', ST_TYPE: 'AVENUE', LBLOCK: block, ONEWAY: 2, CLASS: '2', ...extra }, geometry: { paths: [line(pts)] } });
  const streets = [
    div('100', [[0, -10], [300, -10]], { RADD_FR: 101, RADD_TO: 199 }),
    div('100', [[300, 10], [0, 10]], { LADD_FR: 100, LADD_TO: 198 }),
    div('900', [[300, -10], [300, 10]], { CLASS: '7', ONEWAY: 0 }),
    { attributes: { FULLNAME: 'ALPHA STREET', ST_NAME: 'ALPHA', ST_TYPE: 'STREET' }, geometry: { paths: [line([[0, -200], [0, -10]])] } },
    { attributes: { FULLNAME: 'BETA STREET', ST_NAME: 'BETA', ST_TYPE: 'STREET' }, geometry: { paths: [line([[300, 10], [300, 200]])] } },
  ];
  const { segment } = await resolveSegment({ http: { json: async () => ({ features: streets }) } }, { street: 'Div', from: 'Alpha', to: 'Beta' });
  assert.deepEqual(segment.blocks.map((b) => b.block), [100], 'no block 900 from the crossover');
  assert.equal(segment.length_m, 300, 'the crossover is not length along the street');
  const lots = new Map();
  for (let i = 0; i < 10; i++) {
    lots.set(`n${i}`, square(5 + i * 29, 20, 25 + i * 29, 40));
    lots.set(`s${i}`, square(5 + i * 29, -40, 25 + i * 29, -20));
  }
  lots.set('past', square(310, 20, 330, 40));
  const touch = new Set(touchingParcels(lots, segment));
  for (let i = 0; i < 10; i++) assert.ok(touch.has(`n${i}`) && touch.has(`s${i}`), `frontage ${i}`);
  assert.ok(!touch.has('past'));
});

test('a curving street keeps its frontage where it bends back beyond an end', async () => {
  // BEND ROAD runs west from (400,100) to (0,100), south to (0,0), then east to GAMMA at (300,0);
  // GAMMA leaves nearly along the street, so that end's cut is square to the street (x = 300).
  const bend = (pts) => ({ attributes: { FULLNAME: 'BEND ROAD', ST_NAME: 'BEND', ST_TYPE: 'ROAD', LBLOCK: '100', ONEWAY: 0, CLASS: '3' }, geometry: { paths: [line(pts)] } });
  const streets = [
    bend([[400, 100], [0, 100]]), bend([[0, 100], [0, 0]]), bend([[0, 0], [300, 0]]),
    { attributes: { FULLNAME: 'DELTA STREET', ST_NAME: 'DELTA', ST_TYPE: 'STREET' }, geometry: { paths: [line([[400, 300], [400, 100]])] } },
    { attributes: { FULLNAME: 'GAMMA STREET', ST_NAME: 'GAMMA', ST_TYPE: 'STREET' }, geometry: { paths: [line([[300, 0], [500, 20]])] } },
  ];
  const { segment } = await resolveSegment({ http: { json: async () => ({ features: streets }) } }, { street: 'Bend', from: 'Delta', to: 'Gamma' });
  assert.equal(segment.length_m, 800);
  const lots = new Map([['beyond-the-line', square(320, 110, 380, 130)], ['past-gamma', square(310, -30, 330, -10)]]);
  const touch = new Set(touchingParcels(lots, segment));
  assert.ok(touch.has('beyond-the-line'), 'frontage on the first leg, east of x = 300');
  assert.ok(!touch.has('past-gamma'));
});

test('a walk that overshoots its cross street by a frontage road is cut back at the cross street', async () => {
  // MAIN runs x 0-500 (a node at 420); a frontage piece of MAIN runs back from (420,0) to (300,20), where GAMMA dead-ends.
  const main = (block, pts) => ({ attributes: { FULLNAME: 'MAIN STREET', ST_NAME: 'MAIN', ST_TYPE: 'STREET', LBLOCK: block, ONEWAY: 0, CLASS: '3' }, geometry: { paths: [line(pts)] } });
  const streets = [
    main('100', [[0, 0], [420, 0]]), main('500', [[420, 0], [500, 0]]), main('450', [[420, 0], [400, 20], [300, 20]]),
    { attributes: { FULLNAME: 'ALPHA STREET', ST_NAME: 'ALPHA', ST_TYPE: 'STREET' }, geometry: { paths: [line([[0, -200], [0, 0], [0, 200]])] } },
    { attributes: { FULLNAME: 'GAMMA STREET', ST_NAME: 'GAMMA', ST_TYPE: 'STREET' }, geometry: { paths: [line([[300, 20], [300, 200]])] } },
  ];
  const { segment } = await resolveSegment({ http: { json: async () => ({ features: streets }) } }, { street: 'Main', from: 'Alpha', to: 'Gamma' });
  assert.equal(segment.length_m, 300);
  assert.deepEqual(segment.blocks.map((b) => b.block), [100], 'not the frontage piece past GAMMA');
  const lots = new Map([['before', square(250, -30, 280, -10)], ['beyond', square(330, -30, 360, -10)], ['far', square(440, -30, 470, -10)]]);
  const touch = new Set(touchingParcels(lots, segment));
  assert.ok(touch.has('before'));
  assert.ok(!touch.has('beyond') && !touch.has('far'));
});
