#!/usr/bin/env node
// How close housing_count's apartment estimate comes, against the apartment
// properties whose units the City records.
//
//   node scripts/check-unit-estimate.js [--sample 60]
//
// The open assessment roll gives apartment properties only as bands (5-11,
// 12-48, 49+ units), so housing_count estimates their units from each 2020
// Census block's housing count (plugins/gis.js homesByParcel). The City's
// Real_Estate/Submarkets map layers record `number_uni` for apartment
// properties in the neighborhoods they cover (16 layers, part of the city).
// This script takes a fixed sample of those properties, runs the same
// estimate on each one's census block through the plugin context, and
// writes eval/unit-estimate-<date>.json: every property's recorded and
// estimated units and the summary that housing-count.js's ACCURACY quotes.
//
// Only GPIN, LRSN, extension, ext_descri (the building's description),
// number_uni and PropClassD are requested from Submarkets; the layer also
// carries owner and deed fields, never read here. A property counts as
// recorded only when every building row records units, apart from rows
// describing a clubhouse, office, pool or the like, which hold none: a row
// with 0 units and any other description is a building whose units weren't
// recorded, and its property is left out.
// The sample is the first N properties in SHA-256 order of their GPIN, so a
// rerun picks the same properties while the layer holds the same ones.
// About five requests a property.

import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getCity } from '../src/cities/index.js';
import { createContext } from '../src/agent.js';
import { pluginContext } from '../src/plugins.js';
import {
  PARCELS, BANDED_UNITS, arcgis, censusBlocks, parcelsIn, rollGroups, homesByParcel, blockIndex, centroid, classCode,
} from '../plugins/gis.js';

const SUBMARKETS = 'https://gisshare.norfolk.gov/pubserver/rest/services/Real_Estate/Submarkets/MapServer';
const LAYERS = 16;
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SAMPLE = Number(arg('--sample', 60));
const city = getCity('norfolk');
const fresh = () => pluginContext(createContext({ city }));
const tool = 'unit-estimate check';

// Recorded units per parcel: sum over its building rows, each (LRSN, extension) once.
const NO_DWELLINGS = /club ?house|office|leasing|maintenance|pool|garage|storage|laundry|community|amenit|fitness|shed|carport|cabana|gazebo/i;
const byParcel = new Map();
for (let lid = 0; lid < LAYERS; lid++) {
  const fs = await arcgis(fresh(), `${SUBMARKETS}/${lid}`, {
    where: "PropClassD LIKE '40%'",
    outFields: 'GPIN,LRSN,extension,ext_descri,number_uni,PropClassD', returnGeometry: 'false',
  }, tool);
  for (const { attributes: a } of fs) {
    const g = String(a.GPIN ?? '').trim();
    if (!/^\d{6,12}$/.test(g)) continue;
    const r = byParcel.get(g) || { units: 0, seen: new Set(), unrecorded: 0 };
    const key = `${a.LRSN}|${a.extension}`;
    if (r.seen.has(key)) continue;
    r.seen.add(key);
    const u = Number(a.number_uni) || 0;
    r.units += u;
    if (u <= 0 && !NO_DWELLINGS.test(String(a.ext_descri || ''))) r.unrecorded += 1;
    byParcel.set(g, r);
  }
}
const recorded = new Map([...byParcel].filter(([, r]) => !r.unrecorded && r.units >= 5 && r.units <= 2000));
const incomplete = [...byParcel.values()].filter((r) => r.unrecorded && r.units >= 5).length;
const order = (g) => createHash('sha256').update(g).digest('hex');
const sample = [...recorded.keys()].sort((x, y) => (order(x) < order(y) ? -1 : 1)).slice(0, SAMPLE);

const midpoint = (c) => {
  const [lo, hi] = BANDED_UNITS[c] || [0, 0];
  return Number.isFinite(hi) ? (lo + hi) / 2 : lo;
};

const rows = [];
const skipped = [];
for (const gpin of sample) {
  const ctx = fresh();
  try {
    const [f] = await arcgis(ctx, PARCELS, { where: `GPIN = '${gpin}'`, outFields: 'GPIN', returnGeometry: 'true', outSR: '4326' }, tool);
    if (!f?.geometry?.rings) { skipped.push({ gpin, why: 'no parcel shape' }); continue; }
    const [x, y] = centroid(f.geometry.rings);
    const d = 0.0005;
    const near = { xmin: x - d, ymin: y - d, xmax: x + d, ymax: y + d };
    const blocks = await censusBlocks(ctx, near);
    const home = blockIndex(new Map([[gpin, f.geometry.rings]]), blocks).get(gpin);
    const block = blocks.find((b) => b.geoid === home);
    if (!block) { skipped.push({ gpin, why: 'in no census block' }); continue; }
    const parcels = await parcelsIn(ctx, block.box);
    const held = blockIndex(parcels, [block]);
    const inBlock = new Map([...parcels].filter(([g]) => held.has(g)));
    inBlock.set(gpin, f.geometry.rings);
    const groups = await rollGroups(ctx, inBlock.keys());
    const mine = groups.filter((r) => String(r.gpin) === gpin && classCode(r.property_class_description) in BANDED_UNITS);
    if (!mine.length) { skipped.push({ gpin, why: 'no apartment class in the FY27 roll' }); continue; }
    const { byParcel } = homesByParcel(inBlock, [block], groups);
    const p = byParcel.get(gpin);
    const truth = recorded.get(gpin).units;
    const props = mine.reduce((s, r) => s + (Number(r.n) || 1), 0);
    const buildings = mine.reduce((s, r) => s + (Number(r.rows) || 1), 0);
    rows.push({
      gpin,
      class: mine.map((r) => r.property_class_description).join('; '),
      recorded_units: truth,
      estimated_units: Math.round(p.estimated),
      band_midpoint: mine.reduce((s, r) => s + midpoint(classCode(r.property_class_description)) * (Number(r.n) || 1), 0),
      apartment_properties: props,
      building_rows: buildings,
      built_after_2020: mine.some((r) => Number(r.built) > 2020),
      block: block.geoid,
    });
    process.stderr.write('.');
  } catch (err) {
    skipped.push({ gpin, why: String(err.message || err).slice(0, 120) });
  }
}
process.stderr.write('\n');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const summarize = (list) => {
  const err = (k) => list.map((r) => Math.abs(r[k] - r.recorded_units) / r.recorded_units);
  const total = list.reduce((s, r) => s + r.recorded_units, 0);
  const pct = (x) => (x == null ? null : Math.round(100 * x));
  return {
    properties: list.length,
    recorded_units: total,
    median_abs_error_pct: pct(median(err('estimated_units'))),
    median_abs_error_pct_band_midpoint: pct(median(err('band_midpoint'))),
    within_20_pct: err('estimated_units').filter((e) => e <= 0.2).length,
    total_error_pct: pct(list.reduce((s, r) => s + r.estimated_units, 0) / total - 1),
    total_error_pct_band_midpoint: pct(list.reduce((s, r) => s + r.band_midpoint, 0) / total - 1),
  };
};
const date = new Date().toISOString().slice(0, 10);
const out = {
  date,
  method: 'For each sampled apartment property: its 2020 Census block (TIGERweb), every parcel whose lot center is in that block, the FY27 roll grouped by parcel, then plugins/gis.js homesByParcel, as housing_count runs it. Recorded units are the Submarkets layers\' number_uni, summed over each parcel\'s building rows; a property with a building row of 0 units not described as a clubhouse, office, pool or the like is left out as not fully recorded. The band midpoint baseline puts 5-11 at 8 and 12-48 at 30, and the open 49+ band at its floor, 49.',
  source: `${SUBMARKETS} (layers 0-${LAYERS - 1}), class 40x; a property's recorded units are the sum over its building rows, 5 to 2000`,
  population: recorded.size,
  left_out_unrecorded_buildings: incomplete,
  sample_rule: `first ${SAMPLE} GPINs in SHA-256 order`,
  summary: summarize(rows),
  single_building: summarize(rows.filter((r) => r.building_rows === 1 && r.apartment_properties === 1)),
  several_buildings_or_properties: summarize(rows.filter((r) => r.building_rows > 1 || r.apartment_properties > 1)),
  skipped,
  rows,
};
const file = new URL(`../eval/unit-estimate-${date}.json`, import.meta.url);
await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ population: out.population, left_out: incomplete, summary: out.summary, single_building: out.single_building, several: out.several_buildings_or_properties, skipped: skipped.length }, null, 2));
