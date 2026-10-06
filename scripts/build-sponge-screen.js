#!/usr/bin/env node
// Norfolk sponge-city screen: where rain gardens, bioswales and tree plantings
// would do the most good, from public records only.
//
//   node scripts/build-sponge-screen.js
//
// Writes data/norfolk-sponge-screen.json (results, method, and the full trace
// of every query) and docs/sponge-screen-norfolk.md (the readable report).
//
// This is a screen, not a design: it ranks places to look first. Every site
// still needs a visit, a soil/infiltration test, a utility locate, and the
// neighbors' say. Sources were checked live on 2026-10-06.

import { writeFile } from 'node:fs/promises';
import { Trace } from '../src/trace.js';
import { Resources } from '../src/resources.js';
import { Socrata, soqlString } from '../src/socrata.js';
import { USER_AGENT } from '../src/plugins.js';
import norfolk from '../src/cities/norfolk.js';
import { leagueKey } from '../plugins/water-on-my-block.js';
import { matchLegislation } from '../src/block.js';
import { readFile } from 'node:fs/promises';

const legislation = JSON.parse(await readFile(new URL('../data/norfolk-legislation.json', import.meta.url), 'utf8'));

const GIS = 'https://gisshare.norfolk.gov/pubserver/rest/services/OpenData';
const LAYERS = {
  leagues: `${GIS}/Neighborhoods_Group_OpenData/MapServer/0`,
  tracts: `${GIS}/Planning/FeatureServer/7`,
  parcels: `${GIS}/Parcels/FeatureServer/1`,
  // The city's own FIRM layer fails point queries; FEMA's national layer is the source behind it.
  firm: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28',
  surge1: `${GIS}/Environmental_Group_OpenData/MapServer/3`,
  structures: `${GIS}/Environmental_Group_OpenData/MapServer/9`,
  bmps: `${GIS}/Environmental_Group_OpenData/MapServer/10`,
};
const DS = {
  addresses: 'ere7-kake',
  assessment: 'qva7-tzrf', // FY27
  workOrders: 'qzfe-wj25',
  trees: 'cmvv-agyb',
  nfip: 'suf7-r643',
  acs: 'q552-bpmw',
};
const VACANT_PUBLIC_CLASSES = ['610 Norfolk Vacant Land', '620 NRHA Vacant Land'];
const ENRICH = { rain_garden: 120, tree: 30 };
const CATCH_BASIN_RADIUS_M = 60;
const BMP_RADIUS_M = 400;
const CONCURRENCY = 4;
const MIN_ADDRESSES = 200;

const trace = new Trace();
const resources = new Resources();
const socrata = new Socrata({ city: norfolk, trace, resources, appToken: process.env.SOCRATA_APP_TOKEN });

async function getJSON(url, tool) {
  return trace.record({ tool, url }, async () => {
    for (let i = 1; ; i++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        const body = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
        const data = JSON.parse(body);
        if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        return { result: data, rows: data.features?.length ?? data.count ?? null };
      } catch (err) {
        if (i >= 3) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      }
    }
  });
}

const arcgis = (layer, params, tool) => getJSON(`${layer}/query?${new URLSearchParams({ f: 'json', ...params })}`, tool);

async function soils(lon, lat) {
  const url = 'https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest';
  const query = `SELECT mu.muname, c.compname, c.comppct_r, c.hydgrp FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${lon} ${lat})') AS m JOIN mapunit mu ON mu.mukey = m.mukey JOIN component c ON c.mukey = mu.mukey WHERE c.majcompflag = 'Yes' ORDER BY c.comppct_r DESC`;
  return trace.record({ tool: 'USDA soil map unit at site', url: `${url}#point(${lon.toFixed(5)},${lat.toFixed(5)})` }, async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ format: 'JSON+COLUMNNAME', query }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const [head, ...rows] = data.Table || [[]];
    const out = rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    return { result: out, rows: out.length };
  });
}

async function pool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i]);
        } catch (err) {
          out[i] = { error: String(err.message || err) };
        }
      }
    })
  );
  return out;
}

// Even-odd point-in-polygon over every ring (holes fall out naturally).
function inRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
const locate = (polys, x, y) => polys.find((p) => inRings(x, y, p.rings));

function pctRank(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return (v) => {
    if (!Number.isFinite(v) || !sorted.length) return null;
    let lo = 0;
    while (lo < sorted.length && sorted[lo] <= v) lo++;
    return lo / sorted.length;
  };
}
// A missing component counts as middling (0.5), so one strong number can't
// carry a site on its own.
const mean = (xs) => xs.reduce((a, x) => a + (x == null ? 0.5 : x), 0) / xs.length;
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

console.error('Fetching boundaries…');
const [leagueFC, tractFC] = await Promise.all([
  arcgis(LAYERS.leagues, { where: '1=1', outFields: 'LEAGUE', outSR: '4326', maxAllowableOffset: '0.00005' }, 'civic league boundaries'),
  arcgis(LAYERS.tracts, { where: '1=1', outFields: 'GEOID20,NAME20', outSR: '4326', maxAllowableOffset: '0.00005' }, 'census tract boundaries (2020)'),
]);
const leaguePolys = leagueFC.features.map((f) => ({ name: f.attributes.LEAGUE, key: leagueKey(f.attributes.LEAGUE), rings: f.geometry?.rings || [] }));
const tractPolys = tractFC.features.map((f) => ({ geoid: f.attributes.GEOID20, name: f.attributes.NAME20, rings: f.geometry?.rings || [] }));

console.error('Fetching city-wide measures…');
const [addrByLeague, floodByLeague, floodByStreet, forestryByLeague, forestryByStreet, treeMix, nfip, acs, parcelsRaw] = await Promise.all([
  socrata.query(DS.addresses, 'SELECT civic_league, count(*) AS n GROUP BY civic_league LIMIT 500', { tool: 'addresses per civic league', name: 'Address Information' }),
  socrata.query(DS.workOrders, "SELECT civic_league, count(*) AS n, min(created_datetime) AS since WHERE area = 'Stormwater' AND problem_description = 'Blockage / Flooding' GROUP BY civic_league LIMIT 500", { tool: 'blockage/flooding work orders per civic league', name: 'Work Orders' }),
  socrata.query(DS.workOrders, "SELECT civic_league, street, ward, count(*) AS n, sum(case(status_code < 800 OR status_code = 941, 1, true, 0)) AS open, max(created_datetime) AS latest WHERE area = 'Stormwater' AND problem_description = 'Blockage / Flooding' GROUP BY civic_league, street, ward ORDER BY n DESC LIMIT 500", { tool: 'blockage/flooding work orders per street', name: 'Work Orders' }),
  socrata.query(DS.workOrders, "SELECT civic_league, primary_task_description, count(*) AS n WHERE area = 'Forestry' AND primary_task_description in ('Removal', 'Plantings') GROUP BY civic_league, primary_task_description LIMIT 1000", { tool: 'tree removals and plantings per civic league', name: 'Work Orders' }),
  socrata.query(DS.workOrders, "SELECT civic_league, street, sum(case(primary_task_description = 'Removal', 1, true, 0)) AS removals, sum(case(primary_task_description = 'Plantings', 1, true, 0)) AS plantings WHERE area = 'Forestry' AND primary_task_description in ('Removal', 'Plantings') GROUP BY civic_league, street ORDER BY removals DESC LIMIT 500", { tool: 'tree removals and plantings per street', name: 'Work Orders' }),
  socrata.query(DS.trees, "SELECT civic_league, count(*) AS n, sum(case(common_name = 'Crapemyrtle', 1, true, 0)) AS crape GROUP BY civic_league LIMIT 500", { tool: 'tree inventory mix per civic league', name: 'City Tree Inventory' }),
  socrata.query(DS.nfip, "SELECT census_tract, sum(case(cause_of_damage like '%rainfall%', 1, true, 0)) AS rain, sum(case(cause_of_damage like '%Tidal%', 1, true, 0)) AS tidal, count(*) AS n GROUP BY census_tract LIMIT 500", { tool: 'flood insurance claims by block group, rain vs tide', name: 'FEMA NFIP Claims' }),
  socrata.query(DS.acs, 'SELECT geoid, median_household_income, households LIMIT 500', { tool: 'median household income per tract', name: 'Norfolk 2020 American Community Survey Five-Year Estimates' }),
  socrata.query(DS.assessment, `SELECT gpin, lrsn, owner, property_street_number, property_street_direction, property_street_name, property_street_type, acreage, property_class_description WHERE property_class_description in (${VACANT_PUBLIC_CLASSES.map(soqlString).join(', ')}) LIMIT 500`, { tool: 'city-owned vacant parcels (page 1)', name: 'Property Assessment and Sales - FY27' }),
]);

// Aggregates must fit under the client's 500-row cap, or the screen is wrong.
for (const [label, rows] of Object.entries({ addrByLeague, floodByLeague, forestryByLeague, treeMix, nfip, acs })) {
  if (rows.length >= 500) throw new Error(`${label} hit the 500-row cap; the aggregate would be incomplete.`);
}

// The 500-row cap is per query; page through the rest of the vacant parcels.
let parcels = parcelsRaw;
for (let offset = 500; parcels.length === offset; offset += 500) {
  const page = await socrata.query(DS.assessment, `SELECT gpin, lrsn, owner, property_street_number, property_street_direction, property_street_name, property_street_type, acreage, property_class_description WHERE property_class_description in (${VACANT_PUBLIC_CLASSES.map(soqlString).join(', ')}) ORDER BY lrsn LIMIT 500 OFFSET ${offset}`, { tool: `city-owned vacant parcels (from ${offset})`, name: 'Property Assessment and Sales - FY27' });
  parcels = parcels.concat(page);
  if (!page.length) break;
}
// Public owners only. Never carry a private owner's name forward.
parcels = parcels.filter((p) => /^(city of norfolk|norfolk redevelopment|economic dev)/i.test(p.owner || ''));

// League-level measures, keyed by normalized name.
const L = new Map();
const league = (name) => {
  const k = leagueKey(name);
  if (!k) return null;
  if (!L.has(k)) L.set(k, { key: k, names: new Set(), addresses: 0, flood_wo: 0, removals: 0, plantings: 0, trees: 0, crape: 0 });
  const e = L.get(k);
  e.names.add(name);
  return e;
};
for (const r of addrByLeague) if (r.civic_league) league(r.civic_league).addresses += Number(r.n);
for (const r of floodByLeague) if (r.civic_league) league(r.civic_league).flood_wo += Number(r.n);
for (const r of forestryByLeague) if (r.civic_league) league(r.civic_league)[r.primary_task_description === 'Removal' ? 'removals' : 'plantings'] += Number(r.n);
for (const r of treeMix) if (r.civic_league) Object.assign(league(r.civic_league), { trees: league(r.civic_league).trees + Number(r.n), crape: league(r.civic_league).crape + Number(r.crape || 0) });
const floodSince = floodByLeague.map((r) => r.since).filter(Boolean).sort()[0];

for (const e of L.values()) {
  // Rates per address swing wildly where few people live (industrial areas), so
  // leagues under MIN_ADDRESSES are left unranked rather than ranked first.
  e.flood_per_1k = e.addresses >= MIN_ADDRESSES ? (1000 * e.flood_wo) / e.addresses : null;
  e.net_tree_loss_per_1k = e.addresses >= MIN_ADDRESSES ? (1000 * (e.removals - e.plantings)) / e.addresses : null;
  e.small_tree_share = e.trees >= 50 ? e.crape / e.trees : null;
}
const leagues = [...L.values()];
const pFlood = pctRank(leagues.map((e) => e.flood_per_1k));
const pTreeLoss = pctRank(leagues.map((e) => e.net_tree_loss_per_1k));
const pSmall = pctRank(leagues.map((e) => e.small_tree_share));

// Tract-level measures: NFIP block groups roll up to 11-digit tract GEOIDs.
const T = new Map();
for (const r of acs) T.set(String(r.geoid), { geoid: String(r.geoid), income: Number(r.median_household_income) || null, households: Number(r.households) || null, rain: 0, tidal: 0 });
let nfipUnmatched = 0;
for (const r of nfip) {
  const geoid = String(r.census_tract || '').slice(0, 11);
  const t = T.get(geoid);
  if (!t) {
    nfipUnmatched += Number(r.n);
    continue;
  }
  t.rain += Number(r.rain || 0);
  t.tidal += Number(r.tidal || 0);
}
for (const t of T.values()) t.rain_per_1k_hh = t.households ? (1000 * t.rain) / t.households : null;
const tracts = [...T.values()];
const pRain = pctRank(tracts.map((t) => t.rain_per_1k_hh));
const pPoor = pctRank(tracts.map((t) => (t.income ? -t.income : null)));

console.error(`Locating ${parcels.length} city-owned vacant parcels…`);
const byGpin = new Map(parcels.filter((p) => p.gpin).map((p) => [p.gpin, p]));
const gpins = [...byGpin.keys()];
for (let i = 0; i < gpins.length; i += 100) {
  const batch = gpins.slice(i, i + 100);
  const fc = await arcgis(LAYERS.parcels, { where: `GPIN IN (${batch.map((g) => `'${g}'`).join(',')})`, outFields: 'GPIN', returnGeometry: 'false', returnCentroid: 'true', outSR: '4326' }, `parcel centroids (${i + 1}–${i + batch.length})`);
  for (const f of fc.features) {
    const p = byGpin.get(f.attributes.GPIN);
    if (p && f.centroid) Object.assign(p, { lon: f.centroid.x, lat: f.centroid.y });
  }
}

const sites = [];
for (const p of byGpin.values()) {
  if (!Number.isFinite(p.lon)) continue;
  const lg = locate(leaguePolys, p.lon, p.lat);
  const tr = locate(tractPolys, p.lon, p.lat);
  const e = lg ? L.get(lg.key) : null;
  const t = tr ? T.get(tr.geoid) : null;
  const acres = Number(p.acreage) || null;
  const where = [p.property_street_number && p.property_street_number !== '0' ? p.property_street_number : null, p.property_street_direction, p.property_street_name, p.property_street_type].filter(Boolean).join(' ');
  const s = {
    gpin: p.gpin,
    lrsn: p.lrsn,
    location: p.property_street_number === '0' ? `lot on ${where}` : where,
    owner: p.owner,
    class: p.property_class_description,
    acres,
    lon: p.lon,
    lat: p.lat,
    civic_league: lg?.name || null,
    tract: tr?.geoid || null,
    league_flood_wo_per_1k_addresses: r2(e?.flood_per_1k),
    league_net_tree_loss_per_1k_addresses: r2(e?.net_tree_loss_per_1k),
    league_small_tree_share: r2(e?.small_tree_share),
    tract_rain_claims_per_1k_households: r2(t?.rain_per_1k_hh),
    tract_rain_claims: t?.rain ?? null,
    tract_tidal_claims: t?.tidal ?? null,
    tract_median_income: t?.income ?? null,
  };
  const pf = pFlood(e?.flood_per_1k);
  const pr = pRain(t?.rain_per_1k_hh);
  const pe = pPoor(t?.income ? -t.income : null);
  // A site is only ranked when its civic league is.
  s.need = {
    rain_garden: pf == null ? null : r2(mean([pf, pr, pe])),
    tree: pf == null ? null : r2(mean([pTreeLoss(e?.net_tree_loss_per_1k), pSmall(e?.small_tree_share), pf, pe])),
  };
  sites.push(s);
}
const located = sites.length;

// Bigger lots hold more water and more trees; very small slivers rarely work.
const sizeFactor = (acres) => (acres == null ? 0.5 : Math.min(1, Math.max(0.2, acres / 0.25)));
const rank = (kind) =>
  sites
    .filter((s) => s.need[kind] != null)
    .map((s) => ({ ...s, score: r2(s.need[kind] * 0.8 + sizeFactor(s.acres) * 0.2) }))
    .sort((a, b) => b.score - a.score);

const rainTop = rank('rain_garden').slice(0, ENRICH.rain_garden);
const treeTop = rank('tree').slice(0, ENRICH.tree);
const toEnrich = new Map([...rainTop, ...treeTop].map((s) => [s.gpin, s]));

console.error(`Checking feasibility at ${toEnrich.size} sites…`);
const point = (s) => ({ geometry: JSON.stringify({ x: s.lon, y: s.lat, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });
const checks = await pool([...toEnrich.values()], async (s) => {
  const [firm, surge, basins, bmps, soil] = await Promise.all([
    arcgis(LAYERS.firm, { ...point(s), outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF', returnGeometry: 'false' }, 'FEMA flood zone at site'),
    arcgis(LAYERS.surge1, { ...point(s), returnCountOnly: 'true' }, 'Category 1 storm surge at site'),
    arcgis(LAYERS.structures, { ...point(s), distance: String(CATCH_BASIN_RADIUS_M), units: 'esriSRUnit_Meter', returnCountOnly: 'true' }, `stormwater structures within ${CATCH_BASIN_RADIUS_M} m`),
    arcgis(LAYERS.bmps, { ...point(s), distance: String(BMP_RADIUS_M), units: 'esriSRUnit_Meter', returnCountOnly: 'true' }, `existing stormwater BMPs within ${BMP_RADIUS_M} m`),
    soils(s.lon, s.lat).catch((err) => ({ error: err.message })),
  ]);
  const z = firm.features?.[0]?.attributes;
  const hsg = Array.isArray(soil) ? soil.find((c) => c.hydgrp)?.hydgrp || null : null;
  return {
    gpin: s.gpin,
    flood_zone: z ? `${z.FLD_ZONE}${z.ZONE_SUBTY ? ` (${z.ZONE_SUBTY.toLowerCase()})` : ''}` : null,
    special_flood_hazard_area: z ? z.SFHA_TF === 'T' : null,
    cat1_storm_surge: surge.count > 0,
    stormwater_structures_nearby: basins.count,
    existing_bmps_nearby: bmps.count,
    soil: Array.isArray(soil) ? soil[0]?.muname || null : null,
    hydrologic_soil_group: hsg,
  };
});
// A vacant city lot may already be slated for something: look for Council and
// Planning Commission items naming its address or its hundred block.
for (const c of checks) {
  const site = toEnrich.get(c?.gpin);
  if (!site || /^lot on /.test(site.location)) continue;
  const m = matchLegislation(legislation, site.location);
  const items = [...m.exact, ...m.same_block.slice(0, 3)].map((it) => ({ id: it.id, title: it.title.slice(0, 160), date: it.meetings[0]?.date || null, match: m.exact.includes(it) ? 'this address' : 'same block' }));
  if (items.length) c.agenda_items = items;
}
// One result per parcel, read by both lists (a lot can rank in both).
const feasibility = new Map(checks.filter((c) => c?.gpin).map((c) => [c.gpin, c]));
for (const list of [rainTop, treeTop]) for (const s of list) s.feasibility = feasibility.get(s.gpin) || null;
const enrichFailures = checks.filter((c) => c?.error).length;

function rainGardenVerdict(f) {
  if (!f) return { ok: false, why: ['not checked'] };
  const why = [];
  let ok = true;
  if (f.special_flood_hazard_area) {
    ok = false;
    why.push(`in FEMA ${f.flood_zone}: tidal or high water likely; infiltration is unreliable`);
  }
  if (f.cat1_storm_surge) {
    ok = false;
    why.push('inside the Category 1 storm surge area');
  }
  const hsg = f.hydrologic_soil_group || '';
  if (/^[AB]\/D$/.test(hsg)) why.push(`soil group ${hsg}: drains well only where the water table is lowered; treat as D until tested`);
  else if (/^[AB]$/.test(hsg)) why.push(`soil group ${hsg}: drains well`);
  else if (f.hydrologic_soil_group) why.push(`soil group ${f.hydrologic_soil_group}: slow-draining; plan an underdrain`);
  else why.push(`soil mapped as "${f.soil || 'unknown'}" with no drainage group: needs an infiltration test`);
  if (f.stormwater_structures_nearby > 0) why.push(`${f.stormwater_structures_nearby} stormwater structure(s) within ${CATCH_BASIN_RADIUS_M} m to tie into`);
  if (f.existing_bmps_nearby > 0) why.push(`${f.existing_bmps_nearby} existing stormwater BMP(s) within ${BMP_RADIUS_M} m`);
  if (f.agenda_items) why.push(`agenda items name ${f.agenda_items.some((i) => i.match === 'this address') ? 'this address' : 'this block'}: check what was decided`);
  return { ok, why };
}
function treeVerdict(f) {
  if (!f) return { why: ['not checked'] };
  const why = [];
  if (f.cat1_storm_surge || f.special_flood_hazard_area) why.push('flood or surge exposure: choose salt- and flood-tolerant species');
  if (f.agenda_items) why.push(`agenda items name ${f.agenda_items.some((i) => i.match === 'this address') ? 'this address' : 'this block'}: check what was decided`);
  return { why };
}

const pick = (list, verdict) =>
  list.map((s) => {
    const v = verdict(s.feasibility);
    return { ...s, verdict: v };
  });

const rainGardens = pick(rainTop, rainGardenVerdict);
const treeSites = pick(treeTop, treeVerdict);

// Bioswales follow streets. Rank street segments by recorded blockage/flooding.
const leagueByKey = (name) => L.get(leagueKey(name));
const bioswaleStreets = floodByStreet
  .filter((r) => r.street && r.civic_league)
  .map((r) => {
    const e = leagueByKey(r.civic_league);
    return {
      street: r.street,
      civic_league: r.civic_league,
      ward: Number(r.ward) || null,
      blockage_flooding_work_orders: Number(r.n),
      open_now: Number(r.open || 0),
      latest: r.latest?.slice(0, 10) || null,
      league_flood_wo_per_1k_addresses: r2(e?.flood_per_1k),
    };
  })
  .sort((a, b) => b.blockage_flooding_work_orders - a.blockage_flooding_work_orders)
  .slice(0, 25);

// Streets losing trees without replanting.
const treeStreets = forestryByStreet
  .filter((r) => r.street && r.civic_league)
  .map((r) => ({ street: r.street, civic_league: r.civic_league, removals: Number(r.removals), plantings: Number(r.plantings) }))
  .map((e) => ({ ...e, net_loss: e.removals - e.plantings }))
  .sort((a, b) => b.net_loss - a.net_loss)
  .slice(0, 25);

const leagueTable = leagues
  .filter((e) => e.addresses >= MIN_ADDRESSES)
  .map((e) => ({
    civic_league: [...e.names][0],
    addresses: e.addresses,
    blockage_flooding_work_orders: e.flood_wo,
    flood_wo_per_1k_addresses: r2(e.flood_per_1k),
    tree_removals: e.removals,
    tree_plantings: e.plantings,
    small_tree_share: r2(e.small_tree_share),
  }))
  .sort((a, b) => (b.flood_wo_per_1k_addresses ?? -1) - (a.flood_wo_per_1k_addresses ?? -1));

const method = {
  candidates: `City- or NRHA-owned parcels classed ${VACANT_PUBLIC_CLASSES.join(' or ')} in the FY27 assessment, placed by the city's parcel map (GPIN centroid). Public land only, so a project needs no private owner's consent.`,
  rain_garden_need: 'Mean of three percentile ranks: the civic league\'s stormwater "Blockage / Flooding" work orders per 1,000 addresses; the census tract\'s rainfall-cause flood insurance claims per 1,000 households; and the tract\'s median household income (lower ranks higher).',
  tree_need: 'Mean of four percentile ranks: the league\'s tree removals minus plantings per 1,000 addresses; the share of its inventoried trees that are crapemyrtles (small canopy); its blockage/flooding rate; and tract income (lower ranks higher).',
  score: 'need × 0.8 + lot size × 0.2 (size counts fully from 0.25 acre up).',
  feasibility: `For the top ${ENRICH.rain_garden} rain-garden and ${ENRICH.tree} tree candidates: FEMA flood zone and Category 1 storm surge at the centroid (from the city's GIS), stormwater structures within ${CATCH_BASIN_RADIUS_M} m, existing stormwater BMPs within ${BMP_RADIUS_M} m, and the USDA soil map unit and hydrologic soil group. Rain gardens in a FEMA special flood hazard area or the surge zone are marked not suitable: tidal water and high groundwater defeat infiltration.`,
  bioswales: 'Streets ranked by stormwater "Blockage / Flooding" work orders (the dataset records street and civic league, not house numbers). Bioswales go in the right of way, so streets are the unit.',
  tree_streets: 'Streets ranked by Forestry removals minus plantings.',
};
const caveats = [
  'A screen ranks places to look first. It is not a design and not a promise that a site works.',
  `Work orders run from ${floodSince?.slice(0, 10) || 'the dataset start'}; they record where crews were sent, which reflects reporting as well as flooding.`,
  'Flood insurance claims count only insured properties, anonymized by FEMA to block groups and rolled up here to tracts. Tract vintages in the claims and the census data may differ; unmatched claims are counted in the method notes.',
  `Civic league names differ across datasets and are matched on normalized spelling. Leagues with fewer than ${MIN_ADDRESSES} addresses (mostly industrial and commercial areas) are left unranked, because rates per address swing wildly there; a missing tract measure counts as middling.`,
  'Urban soils are often mapped as "Urban land" with no drainage group. Those sites need an infiltration test before a rain garden is designed.',
  `Vacant city land may already be slated for development. Sites are checked against the Council and Planning Commission agenda index (built ${legislation.built.slice(0, 10)}, items since July 2023), which only catches items that name a street address.`,
  'Vacant city land may carry deed restrictions (for example, lots bought out after floods must stay open space, which suits green infrastructure). Check each parcel\'s history with the city.',
];

const out = {
  built: new Date().toISOString(),
  title: 'Norfolk sponge-city screen',
  counts: {
    public_vacant_parcels: parcels.length,
    located,
    leagues_ranked: leagueTable.length,
    nfip_claims_without_a_tract_match: nfipUnmatched,
    feasibility_checks_failed: enrichFailures,
    queries: trace.steps.length,
  },
  method,
  caveats,
  rain_gardens: rainGardens,
  tree_sites: treeSites,
  bioswale_streets: bioswaleStreets,
  tree_streets: treeStreets,
  leagues: leagueTable,
  trace: trace.toJSON(),
};
await writeFile(new URL('../data/norfolk-sponge-screen.json', import.meta.url), JSON.stringify(out));

// The readable report.
const mapLink = (s) => `https://www.google.com/maps/search/?api=1&query=${s.lat.toFixed(6)},${s.lon.toFixed(6)}`;
const md = [];
md.push(`# Norfolk sponge-city screen`, '', `Built ${out.built.slice(0, 10)} from ${out.counts.queries} queries against public records. Every query is in \`data/norfolk-sponge-screen.json\` (\`trace\`).`, '');
md.push('This ranks places to look first for rain gardens, bioswales and tree planting. It is a screen, not a design: every site still needs a visit, an infiltration test, a utility locate, and the neighbors\' say.', '');
md.push('## Rain gardens: public vacant lots', '', '| # | Site | Civic league | Acres | Need | Flood zone | Soil group | Verdict |', '|---|---|---|---|---|---|---|---|');
rainGardens.filter((s) => s.verdict.ok).slice(0, 15).forEach((s, i) =>
  md.push(`| ${i + 1} | [${s.location}](${mapLink(s)}) (GPIN ${s.gpin}) | ${s.civic_league || '—'} | ${s.acres ?? '—'} | ${s.need.rain_garden} | ${s.feasibility?.flood_zone || '—'} | ${s.feasibility?.hydrologic_soil_group || 'unmapped'} | ${s.verdict.why.join('; ')} |`)
);
const ruledOut = rainGardens.filter((s) => !s.verdict.ok);
if (ruledOut.length) md.push('', `**${ruledOut.length} of the ${rainGardens.length} highest-need lots checked were ruled out** for rain gardens: ${ruledOut.filter((s) => s.feasibility?.special_flood_hazard_area).length} sit in a FEMA special flood hazard area, ${ruledOut.filter((s) => s.feasibility?.cat1_storm_surge).length} in the Category 1 storm surge zone (many in both). In the neighborhoods with the most recorded flooding, the city's vacant land is mostly where water already sits. Those lots may suit trees, tidal wetland or storage projects instead; they are listed in the JSON with reasons.`);
md.push('', '## Bioswales: streets with the most recorded blockage/flooding', '', '| # | Street | Civic league | Ward | Blockage/flooding work orders | Open now | Latest |', '|---|---|---|---|---|---|---|');
bioswaleStreets.slice(0, 15).forEach((s, i) => md.push(`| ${i + 1} | ${s.street} | ${s.civic_league} | ${s.ward ?? '—'} | ${s.blockage_flooding_work_orders} | ${s.open_now} | ${s.latest} |`));
md.push('', '## Trees: public vacant lots', '', '| # | Site | Civic league | Acres | Need | Notes |', '|---|---|---|---|---|---|');
treeSites.slice(0, 15).forEach((s, i) => md.push(`| ${i + 1} | [${s.location}](${mapLink(s)}) (GPIN ${s.gpin}) | ${s.civic_league || '—'} | ${s.acres ?? '—'} | ${s.need.tree} | ${s.verdict.why.join('; ') || '—'} |`));
md.push('', '## Trees: streets losing the most trees without replanting', '', '| # | Street | Civic league | Removals | Plantings | Net loss |', '|---|---|---|---|---|---|');
treeStreets.slice(0, 15).forEach((s, i) => md.push(`| ${i + 1} | ${s.street} | ${s.civic_league} | ${s.removals} | ${s.plantings} | ${s.net_loss} |`));
md.push('', '## Civic leagues by recorded blockage/flooding', '', '| Civic league | Addresses | Work orders | Per 1,000 addresses | Tree removals | Plantings | Crapemyrtle share |', '|---|---|---|---|---|---|---|');
leagueTable.slice(0, 20).forEach((e) => md.push(`| ${e.civic_league} | ${e.addresses} | ${e.blockage_flooding_work_orders} | ${e.flood_wo_per_1k_addresses} | ${e.tree_removals} | ${e.tree_plantings} | ${e.small_tree_share ?? '—'} |`));
md.push('', '## Method', '');
for (const [k, v] of Object.entries(method)) md.push(`- **${k.replace(/_/g, ' ')}:** ${v}`);
md.push('', '## Caveats', '');
for (const c of caveats) md.push(`- ${c}`);
md.push('', '## Sources', '');
for (const d of resources.toJSON().datasets) md.push(`- ${d.name || d.id} (\`${d.id}\`): [page](${d.page}) · [CSV](${d.csv})`);
md.push(`- City of Norfolk GIS: [OpenData services](${GIS}) (civic leagues, 2020 census tracts, parcels, FIRM, storm surge, stormwater structures and BMPs)`);
md.push('- USDA NRCS Soil Data Access: [SDA](https://sdmdataaccess.nrcs.usda.gov/)');
md.push('', `Rebuild: \`node scripts/build-sponge-screen.js\``, '');
await writeFile(new URL('../docs/sponge-screen-norfolk.md', import.meta.url), md.join('\n'));

const failed = trace.steps.filter((s) => !s.ok).length;
console.error(`${parcels.length} parcels, ${located} located; ${rainGardens.filter((s) => s.verdict.ok).length}/${rainGardens.length} rain-garden candidates pass; ${trace.steps.length} queries, ${failed} failed`);
