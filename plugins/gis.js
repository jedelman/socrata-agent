// Shared GIS for Siren's place tools (street_segment, housing_count,
// area_lookup): named areas and street segments as shapes, the parcels they
// hold or touch, and how many homes those parcels hold. Not a plugin itself.
// docs/gis-skills.md has the design and the worked Graydon question.
//
// The model chooses (an area by name, a street between two cross streets);
// this code makes every query, does every join and every division, and never
// hands the model a coordinate. Every request goes through the plugin
// context: ArcGIS and TIGERweb through ctx.http (traced, counted), the
// assessment roll through ctx.socrata at plugin access, so its owner and deed
// fields stay denied (src/cities/norfolk.js).
//
// Sources, each read live on 2026-11-14:
//   City of Norfolk open-data map services (gisshare.norfolk.gov, OpenData):
//     Parcels/MapServer/1 (GPIN, no owner), Public_Works/MapServer/1 (street
//     centerlines: block numbers, address ranges, speed limit, one-way, class),
//     Maps/MapServer/12 (civic leagues: only LEAGUE is ever requested; the
//     layer also carries a private person's name, address and email),
//     Planning/MapServer/2 (planning districts), Maps/MapServer/7, 8, 10
//     (wards, super wards, ZIP codes).
//   Census Bureau TIGERweb, 2020 Census Blocks (Tracts_Blocks/MapServer/2):
//     HU100, the 2020 count of housing units in each block.
//   Property Assessment and Sales - FY27 (qva7-tzrf): each property's class,
//     one row per condominium unit; apartments only as bands (5-11, 12-48, 49+).

export const OPEN_DATA = 'https://gisshare.norfolk.gov/pubserver/rest/services/OpenData';
export const PARCELS = `${OPEN_DATA}/Parcels/MapServer/1`;
export const CENTERLINES = `${OPEN_DATA}/Public_Works/MapServer/1`;
export const BLOCKS = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/2';
export const ROLL = { id: 'qva7-tzrf', name: 'Property Assessment and Sales - FY27' };

// Named areas a question can use, each by the one field that names it.
export const AREA_KINDS = Object.freeze({
  civic_league: { url: `${OPEN_DATA}/Maps/MapServer/12`, field: 'LEAGUE', label: 'civic league' },
  planning_district: { url: `${OPEN_DATA}/Planning/MapServer/2`, field: 'TEXT', label: 'planning district' },
  ward: { url: `${OPEN_DATA}/Maps/MapServer/7`, field: 'WARD', numeric: true, label: 'ward' },
  super_ward: { url: `${OPEN_DATA}/Maps/MapServer/8`, field: 'SUPWARD', numeric: true, label: 'super ward' },
  zip: { url: `${OPEN_DATA}/Maps/MapServer/10`, field: 'ZIP', label: 'ZIP code' },
});

// How far a parcel may be from a street's centerline (meters) and still touch
// it. Graydon Avenue's 500-700 blocks gave the same 60 residential parcels at
// 10 m and 15 m; 20 m began to reach parcels behind the frontage (2026-11-14).
export const REACH_M = 15;
// Bigger areas are refused rather than spending an answer's request budget.
export const MAX_PARCELS = 4000;
// Fewer residential parcels than this would describe single households.
export const MIN_PARCELS = 5;
// Parcels per roll query: the grouped rows stay under the client's 500-row cap.
const ROLL_BATCH = 400;
const PAGE = 500;

// The centerline's coded values (Public_Works/MapServer/1, read 2026-11-14).
export const ONE_WAY = { 0: 'two-way', 1: 'one-way', 2: 'one-way (divided road)' };
export const ROAD_CLASS = { 1: 'interstate', 2: 'major', 3: 'minor', 4: 'miscellaneous', 5: 'naval base', 6: 'private', 7: 'median', 8: 'paper street', 9: 'closed' };

// Units per assessment row by class code (the description's leading number).
export const FIXED_UNITS = Object.freeze({
  510: 1, 511: 1, 512: 1, 513: 1, 514: 1, 515: 1, 516: 1, 517: 1, 518: 2,
  520: 2, 521: 2, 530: 3, 531: 3, 540: 4, 541: 4,
  550: 1, 551: 1, 552: 1, 553: 1, 554: 1, 555: 1, 556: 1, 557: 1,
});
// Buildings whose units the roll gives only as a band. Public and religious
// residential classes carry no count at all.
export const BANDED_UNITS = Object.freeze({
  401: [5, 11], 402: [5, 11], 403: [12, 48], 404: [12, 48], 405: [49, Infinity], 406: [49, Infinity], 407: [49, Infinity],
  418: [1, 10], 602: [1, Infinity], 622: [1, Infinity], 672: [1, Infinity],
});
export const classCode = (desc) => {
  const m = /^\s*(\d{3})\b/.exec(String(desc || ''));
  return m ? Number(m[1]) : 0;
};
export const isResidentialCode = (c) => c in FIXED_UNITS || c in BANDED_UNITS;
export function classFamily(c) {
  if (c >= 510 && c <= 517) return 'single-family';
  if (c === 518) return 'single-family with an extra unit';
  if (c === 520 || c === 521) return 'duplex';
  if (c === 530 || c === 531) return 'triplex';
  if (c === 540 || c === 541) return 'fourplex';
  if (c >= 550 && c <= 557) return 'condominium unit';
  if (c >= 401 && c <= 407) return 'apartment building';
  if (c === 418) return 'shop with apartments over';
  if (c in BANDED_UNITS) return 'public or institutional residential';
  return null;
}

// --- names ----------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9 .'&/-]{1,60}$/;
/** A name safe to put in a map-service query, or null. */
export function cleanName(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return NAME_RE.test(t) ? t : null;
}
export const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

const STREET_TYPES = new Set(['AVE', 'AVENUE', 'AV', 'ST', 'STREET', 'RD', 'ROAD', 'BLVD', 'BOULEVARD', 'DR', 'DRIVE', 'PL', 'PLACE', 'CT', 'COURT', 'LN', 'LANE', 'WAY', 'CIR', 'CIRCLE', 'TER', 'TERRACE', 'PKWY', 'PARKWAY', 'HWY', 'HIGHWAY', 'ARCH', 'GDNS', 'GARDENS', 'SQ', 'SQUARE', 'CRES', 'CRESCENT']);
const DIRS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST']);
/** "Graydon Ave" -> "GRAYDON", as the centerline's ST_NAME holds it; null if unusable. */
export function streetKey(s) {
  const t = cleanName(s);
  if (!t) return null;
  const w = t.toUpperCase().replace(/[.']/g, '').split(' ').filter(Boolean);
  while (w.length > 1 && DIRS.has(w[0])) w.shift();
  while (w.length > 1 && STREET_TYPES.has(w[w.length - 1])) w.pop();
  return w.join(' ') || null;
}

// --- geometry (lon/lat in, meters for distances) ----------------------------

export function projector(lat0) {
  const R = 6371008.8;
  const ky = (Math.PI / 180) * R;
  const kx = ky * Math.cos((lat0 * Math.PI) / 180);
  return ([x, y]) => [x * kx, y * ky];
}
const ringArea = (r) => {
  let a = 0;
  for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return a / 2;
};
/** Area-weighted centroid of a polygon's largest ring. */
export function centroid(rings) {
  const r = rings.reduce((best, x) => (Math.abs(ringArea(x)) > Math.abs(ringArea(best)) ? x : best), rings[0]);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const f = r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    a += f;
    cx += (r[i][0] + r[i + 1][0]) * f;
    cy += (r[i][1] + r[i + 1][1]) * f;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : r[0];
}
/** Point in polygon, even-odd over every ring (so holes and multipart shapes work). */
export function inside([x, y], rings) {
  let c = false;
  for (const r of rings) {
    for (let i = 0; i < r.length - 1; i++) {
      const [x1, y1] = r[i];
      const [x2, y2] = r[i + 1];
      if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) c = !c;
    }
  }
  return c;
}
export function bbox(rings) {
  let [xmin, ymin, xmax, ymax] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) {
    if (x < xmin) xmin = x;
    if (y < ymin) ymin = y;
    if (x > xmax) xmax = x;
    if (y > ymax) ymax = y;
  }
  return { xmin, ymin, xmax, ymax };
}
export const unionBox = (boxes) => boxes.reduce((a, b) => ({ xmin: Math.min(a.xmin, b.xmin), ymin: Math.min(a.ymin, b.ymin), xmax: Math.max(a.xmax, b.xmax), ymax: Math.max(a.ymax, b.ymax) }));
export const padBox = (b, d) => ({ xmin: b.xmin - d, ymin: b.ymin - d, xmax: b.xmax + d, ymax: b.ymax + d });
const inBox = ([x, y], b) => x >= b.xmin && x <= b.xmax && y >= b.ymin && y <= b.ymax;
export const within = (a, b) => a.xmin >= b.xmin && a.ymin >= b.ymin && a.xmax <= b.xmax && a.ymax <= b.ymax;

/** Each parcel to the 2020 Census block holding its center: Map GPIN -> GEOID. */
export function blockIndex(parcels, blocks) {
  const out = new Map();
  for (const [g, rings] of parcels) {
    const c = centroid(rings);
    const b = blocks.find((x) => inBox(c, x.box) && inside(c, x.rings));
    if (b) out.set(g, b.geoid);
  }
  return out;
}

function nearestOnSegment(p, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
  const q = [a[0] + t * vx, a[1] + t * vy];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}
/** Nearest point on a set of polylines (projected) to p. */
function nearestOnLines(p, lines) {
  let best = { q: null, d: Infinity };
  for (const ln of lines) for (let i = 0; i < ln.length - 1; i++) {
    const n = nearestOnSegment(p, ln[i], ln[i + 1]);
    if (n.d < best.d) best = n;
  }
  return best;
}
/** Least distance between a polygon (projected rings) and polylines (projected). */
function polygonToLines(rings, lines) {
  let d = Infinity;
  for (const r of rings) {
    for (const p of r) d = Math.min(d, nearestOnLines(p, lines).d);
    for (const ln of lines) for (const p of ln) for (let i = 0; i < r.length - 1; i++) d = Math.min(d, nearestOnSegment(p, r[i], r[i + 1]).d);
  }
  return d;
}

// --- queries -----------------------------------------------------------------

const envParam = (b) => `${b.xmin},${b.ymin},${b.xmax},${b.ymax}`;

/** One ArcGIS query, paged; throws on a service error. */
export async function arcgis(ctx, layer, params, tool, { limit = Infinity } = {}) {
  const out = [];
  for (let offset = 0, page = 0; page < 20; page++) {
    const p = new URLSearchParams({ f: 'json', ...params, ...(offset ? { resultOffset: String(offset) } : {}) });
    const data = await ctx.http.json(`${layer}/query?${p}`, { tool });
    if (data?.error) throw new Error(data.error.message || 'map service error');
    const fs = Array.isArray(data?.features) ? data.features : [];
    out.push(...fs);
    if (out.length > limit) return out;
    if (!data.exceededTransferLimit || !fs.length) break;
    offset += fs.length;
  }
  return out;
}

/** Parcels whose shapes meet a box: Map GPIN -> rings. Throws past MAX_PARCELS. */
export async function parcelsIn(ctx, box) {
  const fs = await arcgis(ctx, PARCELS, {
    geometry: envParam(box), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'GPIN', returnGeometry: 'true', outSR: '4326',
  }, 'parcels (City map services)', { limit: MAX_PARCELS });
  if (fs.length > MAX_PARCELS) throw new Error(`That area holds more than ${MAX_PARCELS} parcels, more than one answer can count. Try a smaller area, such as a civic league or a planning district.`);
  const out = new Map();
  for (const f of fs) {
    const g = String(f.attributes?.GPIN ?? '').trim();
    if (/^\d{6,12}$/.test(g) && f.geometry?.rings?.length && !out.has(g)) out.set(g, f.geometry.rings);
  }
  return out;
}

/** 2020 Census blocks that meet a box: [{ geoid, hu, point, rings, box }]. */
export async function censusBlocks(ctx, box) {
  const fs = await arcgis(ctx, BLOCKS, {
    geometry: envParam(box), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'GEOID,HU100,INTPTLON,INTPTLAT', returnGeometry: 'true', outSR: '4326',
  }, '2020 Census blocks (Census Bureau TIGERweb)');
  return fs
    .filter((f) => f.geometry?.rings?.length && Number.isFinite(Number(f.attributes?.HU100)))
    .map((f) => ({ geoid: String(f.attributes.GEOID), hu: Number(f.attributes.HU100), point: [Number(f.attributes.INTPTLON), Number(f.attributes.INTPTLAT)], rings: f.geometry.rings, box: bbox(f.geometry.rings) }));
}

/** The roll's rows for these parcels, grouped by parcel, class and street (no owner fields). */
export async function rollGroups(ctx, gpins) {
  const ids = [...new Set([...gpins].map(String))].filter((g) => /^\d{6,12}$/.test(g)).sort();
  const rows = [];
  for (let i = 0; i < ids.length; i += ROLL_BATCH) {
    const list = ids.slice(i, i + ROLL_BATCH).join(', ');
    for (let offset = 0; ; offset += PAGE) {
      const q = `SELECT gpin, property_class_description, property_street_name, count(*) AS n, sum(commercial_building_area) AS area, max(improvement_year_built) AS built WHERE gpin IN (${list}) GROUP BY gpin, property_class_description, property_street_name ORDER BY gpin, property_class_description, property_street_name LIMIT ${PAGE}${offset ? ` OFFSET ${offset}` : ''}`;
      const got = await ctx.socrata.query(ROLL.id, q, { tool: 'assessment roll: property classes by parcel', name: ROLL.name });
      rows.push(...got);
      if (got.length < PAGE) break;
    }
  }
  return rows;
}

// --- homes --------------------------------------------------------------------

/**
 * Homes per parcel. Fixed classes count exactly (a duplex 2, each condo row 1).
 * Apartment buildings come only as bands, so their units are estimated from the
 * 2020 Census: in each block, the block's housing units less the units the roll
 * states exactly are shared among the block's apartment buildings by building
 * area, within each building's band. A building put up after 2020, or on a
 * parcel in no block, counts at its band's floor.
 * Returns { byParcel: Map gpin -> { exact, estimated, codes, streets }, notes }.
 */
export function homesByParcel(parcels, blocks, groups) {
  const byParcel = new Map();
  for (const r of groups) {
    const g = String(r.gpin);
    const c = classCode(r.property_class_description);
    if (!isResidentialCode(c)) continue;
    const n = Number(r.n) || 1;
    const p = byParcel.get(g) || { exact: 0, estimated: 0, codes: {}, streets: new Set(), apartments: [] };
    p.codes[c] = (p.codes[c] || 0) + n;
    if (r.property_street_name) p.streets.add(String(r.property_street_name).toUpperCase());
    if (c in FIXED_UNITS) p.exact += FIXED_UNITS[c] * n;
    else {
      const [lo, hi] = BANDED_UNITS[c];
      p.apartments.push({ lo: lo * n, hi: hi * n, area: Number(r.area) || 0, built: Number(r.built) || 0 });
    }
    byParcel.set(g, p);
  }
  const notes = { blocks_used: 0, fit_block_count: 0, short_of_bands: 0, over_bands: 0, built_after_2020: 0, no_block: 0 };
  const inBlock = blockIndex(parcels, blocks);
  const perBlock = new Map();
  for (const [g, p] of byParcel) {
    const k = inBlock.get(g) ?? null;
    if (!perBlock.has(k)) perBlock.set(k, []);
    perBlock.get(k).push([g, p]);
  }
  const hu = new Map(blocks.map((b) => [b.geoid, b.hu]));
  for (const [geoid, members] of perBlock) {
    const old = [];
    for (const [g, p] of members) for (const a of p.apartments) {
      if (geoid === null) { p.estimated += a.lo; notes.no_block += 1; continue; }
      if (a.built > 2020) { p.estimated += a.lo; notes.built_after_2020 += 1; continue; }
      old.push({ p, ...a });
    }
    if (geoid === null || !old.length) continue;
    // Exact units of every parcel in the block, including parcels with no apartments.
    let known = 0;
    for (const [, p] of members) known += p.exact;
    const lo = old.reduce((s, a) => s + a.lo, 0);
    const hi = old.reduce((s, a) => s + a.hi, 0);
    const resid = hu.get(geoid) - known;
    const target = Math.min(Math.max(resid, lo), hi);
    notes.blocks_used += 1;
    if (resid < lo) notes.short_of_bands += old.length;
    else if (resid > hi) notes.over_bands += old.length;
    else notes.fit_block_count += old.length;
    const alloc = old.map((a) => a.lo);
    let rest = target - lo;
    for (let round = 0; round < 8 && rest > 1e-9; round++) {
      const room = old.map((a, i) => i).filter((i) => alloc[i] < old[i].hi);
      if (!room.length) break;
      const w = room.reduce((s, i) => s + (old[i].area || 1), 0);
      let spill = 0;
      for (const i of room) {
        const give = (rest * (old[i].area || 1)) / w;
        const take = Math.min(give, old[i].hi - alloc[i]);
        alloc[i] += take;
        spill += give - take;
      }
      rest = spill;
    }
    old.forEach((a, i) => { a.p.estimated += alloc[i]; });
  }
  for (const p of byParcel.values()) delete p.apartments;
  return { byParcel, notes };
}

/** Totals over a set of parcels. */
export function tally(byParcel, gpins) {
  let exact = 0;
  let estimated = 0;
  let parcels = 0;
  const kinds = {};
  for (const g of gpins) {
    const p = byParcel.get(g);
    if (!p) continue;
    parcels += 1;
    exact += p.exact;
    estimated += p.estimated;
    for (const [c, n] of Object.entries(p.codes)) {
      const f = classFamily(Number(c));
      kinds[f] = (kinds[f] || 0) + n;
    }
  }
  return { residential_parcels: parcels, homes: Math.round(exact + estimated), homes_counted_exactly: exact, homes_estimated: Math.round(estimated), by_kind: kinds };
}

// --- areas ----------------------------------------------------------------------

/** Areas whose names contain the words asked for, of the kinds asked for. */
export async function findAreas(ctx, name, kinds = Object.keys(AREA_KINDS)) {
  const t = cleanName(name);
  if (!t) return { error: 'Give the area as a plain name (letters, numbers, spaces).' };
  const digits = /\b(\d{1,5})\b/.exec(t)?.[1];
  const words = t.replace(/\b(civic league|league|planning district|district|super ward|ward|zip( code)?|neighborhood)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const kind of kinds) {
    const k = AREA_KINDS[kind];
    if (!k) continue;
    let where;
    if (k.numeric) {
      if (!digits || (kind === 'ward' && /super/i.test(t)) || (kind === 'super_ward' && !/super/i.test(t))) continue;
      where = `${k.field} = ${Number(digits)}`;
    } else if (kind === 'zip') {
      if (!/^\d{5}$/.test(words)) continue;
      where = `${k.field} = ${sqlString(words)}`;
    } else {
      if (!words || /^\d+$/.test(words)) continue;
      where = `UPPER(${k.field}) LIKE ${sqlString(`%${words.toUpperCase()}%`)}`;
    }
    const fs = await arcgis(ctx, k.url, { where, outFields: k.field, returnGeometry: 'false' }, `${k.label} names (City map services)`);
    for (const f of fs) {
      const v = f.attributes?.[k.field];
      if (v != null && String(v).trim()) out.push({ kind, name: String(v).trim() });
    }
  }
  const seen = new Set();
  return { matches: out.filter((m) => !seen.has(`${m.kind}|${m.name}`) && seen.add(`${m.kind}|${m.name}`)) };
}

/** The shapes of named areas (exact names, as findAreas returns them). */
export async function areaShapes(ctx, areas) {
  const shapes = [];
  for (const { kind, name } of areas) {
    const k = AREA_KINDS[kind];
    if (!k) throw new Error(`Unknown kind of area: ${kind}. Use one of ${Object.keys(AREA_KINDS).join(', ')}.`);
    const t = cleanName(name);
    if (!t) throw new Error('Give each area by the name area_lookup returned.');
    const where = k.numeric ? `${k.field} = ${Number(/\d+/.exec(t)?.[0])}` : `UPPER(${k.field}) = ${sqlString(t.toUpperCase())}`;
    const fs = await arcgis(ctx, k.url, { where, outFields: k.field, returnGeometry: 'true', outSR: '4326' }, `${k.label} shape (City map services)`);
    const rings = fs.flatMap((f) => f.geometry?.rings || []);
    if (!rings.length) throw new Error(`No ${k.label} is named "${t}" in the City's map. Use area_lookup to find the exact name.`);
    shapes.push({ kind, name: String(fs[0].attributes?.[k.field] ?? t), label: k.label, rings, box: bbox(rings) });
  }
  return shapes;
}

// --- street segments --------------------------------------------------------------

const near = (a, b, m = 3) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= m;

/**
 * A street between two cross streets, from the City's centerlines: the blocks
 * between the two intersections, with their address ranges and the
 * centerline's own fields. Returns { segment } or { error }.
 */
export async function resolveSegment(ctx, { street, from, to }) {
  const keys = [street, from, to].map(streetKey);
  if (keys.some((k) => !k)) return { error: 'Give the street and both cross streets as plain names, e.g. Graydon, Colley and Colonial.' };
  const [S, A, B] = keys;
  if (new Set(keys).size < 3) return { error: 'The street and its two cross streets must be three different streets.' };
  const fs = await arcgis(ctx, CENTERLINES, {
    where: `ST_NAME IN (${keys.map(sqlString).join(', ')})`,
    outFields: 'FULLNAME,ST_NAME,LBLOCK,LADD_FR,LADD_TO,RADD_FR,RADD_TO,SPEEDLIMIT,ONEWAY,CLASS,LENGTH',
    returnGeometry: 'true', outSR: '4326',
  }, 'street centerlines (City map services)');
  const lat0 = fs.find((f) => f.geometry?.paths?.[0]?.[0])?.geometry.paths[0][0][1] ?? 36.87;
  const P = projector(lat0);
  const of = (k) => fs.filter((f) => f.attributes?.ST_NAME === k && f.geometry?.paths?.length);
  const main = of(S);
  if (!main.length) return { error: `I found no street named ${street} in the City's centerlines.` };
  const crossVerts = (k) => of(k).flatMap((f) => f.geometry.paths.flat().map(P));
  const meets = (k) => {
    const vs = crossVerts(k);
    const hits = [];
    for (const f of main) for (const path of f.geometry.paths) for (const end of [path[0], path[path.length - 1]]) {
      const e = P(end);
      if (vs.some((v) => near(e, v))) hits.push({ f, end });
    }
    return hits;
  };
  const atA = meets(A);
  const atB = meets(B);
  if (!atA.length) return { error: `In the City's centerlines, ${from} doesn't meet ${street}.` };
  if (!atB.length) return { error: `In the City's centerlines, ${to} doesn't meet ${street}.` };
  // The street name both cross streets meet (Graydon Avenue, not Graydon Place).
  const names = [...new Set(atA.map((h) => h.f.attributes.FULLNAME))].filter((n) => atB.some((h) => h.f.attributes.FULLNAME === n));
  if (!names.length) return { error: `${from} and ${to} meet different streets named ${street}.` };
  const blockOf = (f) => Number(f.attributes.LBLOCK);
  const SA = [...new Set(atA.filter((h) => names.includes(h.f.attributes.FULLNAME)).map((h) => blockOf(h.f)))];
  const SB = [...new Set(atB.filter((h) => names.includes(h.f.attributes.FULLNAME)).map((h) => blockOf(h.f)))];
  // The blocks between: from each intersection, the block toward the other one.
  let pair = null;
  for (const a of SA) for (const b of SB) if (!pair || Math.abs(a - b) < Math.abs(pair[0] - pair[1])) pair = [a, b];
  const [lo, hi] = [Math.min(...pair), Math.max(...pair)];
  const segs = main.filter((f) => names.includes(f.attributes.FULLNAME) && blockOf(f) >= lo && blockOf(f) <= hi);
  const ends = [...atA, ...atB].filter((h) => segs.includes(h.f)).map((h) => h.end);
  const blocks = [...new Set(segs.map(blockOf))].sort((x, y) => x - y).map((block) => {
    const here = segs.filter((f) => blockOf(f) === block).map((f) => f.attributes);
    const nums = here.flatMap((a) => [a.LADD_FR, a.LADD_TO, a.RADD_FR, a.RADD_TO]).map(Number).filter((n) => n > 0);
    const uniq = (xs) => [...new Set(xs.filter((x) => x != null && x !== ''))];
    return {
      block,
      addresses: nums.length ? `${Math.min(...nums)}-${Math.max(...nums)}` : null,
      carriageways: here.length,
      length_ft: Math.round(Math.max(...here.map((a) => Number(a.LENGTH) || 0))),
      speed_limit_mph: uniq(here.map((a) => a.SPEEDLIMIT)).map(Number),
      traffic: uniq(here.map((a) => ONE_WAY[a.ONEWAY] ?? null)),
      road_class: uniq(here.map((a) => ROAD_CLASS[a.CLASS] ?? null)),
    };
  });
  const paths = segs.flatMap((f) => f.geometry.paths);
  return {
    segment: {
      street: names.length === 1 ? names[0] : names.join(' / '),
      from, to,
      blocks,
      addresses: (() => {
        const all = blocks.flatMap((b) => (b.addresses ? b.addresses.split('-').map(Number) : []));
        return all.length ? `${Math.min(...all)}-${Math.max(...all)}` : null;
      })(),
      streetKey: S,
      crossKeys: [A, B],
      paths,
      ends,
      box: bbox(paths),
    },
  };
}

/** Parcels that touch a segment: within REACH_M of its centerline, and not past either cross street. */
export function touchingParcels(parcels, segment, reach = REACH_M) {
  const P = projector(segment.paths[0][0][1]);
  const lines = segment.paths.map((path) => path.map(P));
  const ends = segment.ends.map(P);
  const out = [];
  for (const [g, rings] of parcels) {
    const pr = rings.map((r) => r.map(P));
    const n = nearestOnLines(P(centroid(rings)), lines);
    if (n.q && ends.some((e) => near(n.q, e, 1))) continue;
    if (polygonToLines(pr, lines) <= reach) out.push(g);
  }
  return out;
}
