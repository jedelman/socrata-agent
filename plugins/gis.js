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
//   Property Assessment and Sales - FY27 (qva7-tzrf): one row per building on
//     a property (extensions R01, C01, C02 ...); a property's class describes
//     the whole property; each condominium unit is its own property.

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
// it. Graydon Avenue's 500-700 blocks gave the same residential parcels at
// 10 m and 15 m; 20 m began to reach parcels behind the frontage (2026-11-14).
export const REACH_M = 15;
// A lot whose center is this far past a cross street's line is past it.
const PAST_M = 2;
// A parcel box holding more than this is refused before anything is downloaded.
export const BOX_CAP = 12000;
// Parcels counted in one answer (both places together): about 20 roll queries.
export const MAX_PARCELS = 8000;
// Fewer residential parcels than this would describe single households.
export const MIN_PARCELS = 5;
// Parcels per roll query: the grouped rows stay under the client's 500-row cap.
const ROLL_BATCH = 400;
const PAGE = 500;
// Building area assumed per unit when an apartment property records none.
const SQFT_PER_UNIT = 900;

// The centerline's coded values (Public_Works/MapServer/1, read 2026-11-14).
export const ONE_WAY = { 0: 'two-way', 1: 'one-way', 2: 'one-way (divided road)' };
export const ROAD_CLASS = { 1: 'interstate', 2: 'major', 3: 'minor', 4: 'miscellaneous', 5: 'naval base', 6: 'private', 7: 'median', 8: 'paper street', 9: 'closed' };

// Units per property by class code (the description's leading number).
export const FIXED_UNITS = Object.freeze({
  510: 1, 511: 1, 512: 1, 513: 1, 514: 1, 515: 1, 516: 1, 517: 1, 518: 2,
  520: 2, 521: 2, 530: 3, 531: 3, 540: 4, 541: 4,
  550: 1, 551: 1, 552: 1, 553: 1, 554: 1, 555: 1, 556: 1, 557: 1,
});
// Properties whose units the roll gives only as a band, or not at all.
export const BANDED_UNITS = Object.freeze({
  401: [5, 11], 402: [5, 11], 403: [12, 48], 404: [12, 48], 405: [49, Infinity], 406: [49, Infinity], 407: [49, Infinity],
  415: [1, Infinity], 418: [1, 10], 558: [1, Infinity], 602: [1, Infinity], 622: [1, Infinity], 672: [1, Infinity],
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
  if (c >= 401 && c <= 407) return 'apartments';
  if (c === 415) return 'mobile home park';
  if (c === 418) return 'apartments over a shop';
  if (c === 558) return 'cooperative';
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

// Street types: what people write (and the roll's abbreviations) to the
// centerline's ST_TYPE word (both read 2026-11-14).
const TYPE_WORDS = {
  AVENUE: ['AVE', 'AV', 'AVENUE'], STREET: ['ST', 'STREET'], ROAD: ['RD', 'ROAD'], DRIVE: ['DR', 'DRIVE'], BOULEVARD: ['BLVD', 'BOULEVARD'],
  COURT: ['CT', 'COURT'], CIRCLE: ['CIR', 'CIRCLE'], PLACE: ['PL', 'PLACE'], LANE: ['LN', 'LA', 'LANE'], CRESCENT: ['CRES', 'CRESCENT'],
  TERRACE: ['TER', 'TERR', 'TERRACE'], WAY: ['WAY'], HIGHWAY: ['HWY', 'HIGHWAY'], GARDENS: ['GDNS', 'GARDENS'], PARKWAY: ['PKWY', 'PARKWAY'],
  ARCH: ['ARCH'], PARK: ['PARK'], SQUARE: ['SQ', 'SQUARE'], MEWS: ['MEWS'], TRAIL: ['TRL', 'TRAIL'], LOOP: ['LOOP'], POINT: ['PT', 'POINT'],
  RUN: ['RUN'], QUARTER: ['QTR', 'QUARTER'], CHASE: ['CH', 'CHASE'], TURN: ['TURN'], LAIR: ['LAIR'], COVE: ['COVE'], LANDING: ['LD', 'LANDING'],
  OVERLOOK: ['OVLK', 'OVERLOOK'], END: ['END'], WALK: ['WALK'], QUAY: ['QUAY'], BRIDGE: ['BRIDGE'], CROSS: ['CROSS'],
};
const TYPE_OF = new Map(Object.entries(TYPE_WORDS).flatMap(([full, abbrs]) => abbrs.map((a) => [a, full])));
export const typeOf = (w) => TYPE_OF.get(String(w || '').trim().toUpperCase()) || null;
const DIRS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST']);

/**
 * A street as people write it, as the centerline's ST_NAME might hold it:
 * the names to look for (with and without a leading direction, so both
 * "North Shore" and "W Little Creek" are found, and "Avenue I" as "I"), and
 * the type and direction if given. Null if unusable.
 */
export function streetQuery(s) {
  const t = cleanName(s);
  if (!t) return null;
  const w = t.toUpperCase().replace(/[.']/g, '').split(' ').filter(Boolean);
  if (!w.length) return null;
  const core = [...w];
  let type = null;
  if (core.length > 1 && typeOf(core[core.length - 1])) type = typeOf(core.pop());
  const keys = [core.join(' ')];
  const dir = core.length > 1 && DIRS.has(core[0]) ? core[0][0] : null;
  if (dir) keys.push(core.slice(1).join(' '));
  if (core.length > 1 && typeOf(core[0])) keys.push(core.slice(1).join(' '));
  return { keys: [...new Set(keys)], type, dir, label: t };
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
  for (let i = 0; i < r.length - 1; i++) a += (r[i][0] - r[0][0]) * (r[i + 1][1] - r[0][1]) - (r[i + 1][0] - r[0][0]) * (r[i][1] - r[0][1]);
  return a / 2;
};
/** Area-weighted centroid of a polygon's largest ring, computed about the ring's first vertex (no loss of precision). */
export function centroid(rings) {
  const r = rings.reduce((best, x) => (Math.abs(ringArea(x)) > Math.abs(ringArea(best)) ? x : best), rings[0]);
  const [ox, oy] = r[0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const x0 = r[i][0] - ox;
    const y0 = r[i][1] - oy;
    const x1 = r[i + 1][0] - ox;
    const y1 = r[i + 1][1] - oy;
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  return a ? [ox + cx / (3 * a), oy + cy / (3 * a)] : r[0];
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
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]), a, b };
}
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
const boxQuery = (box) => ({ geometry: envParam(box), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' });

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

const TOO_LARGE = (n) => `That place holds more than ${n} parcels, more than one answer can count. A civic league or a planning district works; wards and most ZIP codes are too large.`;

/** How many parcels meet a box, without downloading them. */
export async function countParcels(ctx, box) {
  const data = await ctx.http.json(`${PARCELS}/query?${new URLSearchParams({ f: 'json', ...boxQuery(box), returnCountOnly: 'true' })}`, { tool: 'parcels: count (City map services)' });
  if (data?.error) throw new Error(data.error.message || 'map service error');
  return Number(data?.count) || 0;
}

/** Parcels whose shapes meet a box: Map GPIN -> rings. Refuses a box past BOX_CAP before downloading. */
export async function parcelsIn(ctx, box) {
  if ((await countParcels(ctx, box)) > BOX_CAP) throw new Error(TOO_LARGE(BOX_CAP));
  const fs = await arcgis(ctx, PARCELS, { ...boxQuery(box), outFields: 'GPIN', returnGeometry: 'true', outSR: '4326' }, 'parcels (City map services)', { limit: BOX_CAP });
  if (fs.length > BOX_CAP) throw new Error(TOO_LARGE(BOX_CAP));
  const out = new Map();
  for (const f of fs) {
    const g = String(f.attributes?.GPIN ?? '').trim();
    if (/^\d{6,12}$/.test(g) && f.geometry?.rings?.length && !out.has(g)) out.set(g, f.geometry.rings);
  }
  return out;
}

/** 2020 Census blocks that meet a box: [{ geoid, hu, point, rings, box }]. */
export async function censusBlocks(ctx, box) {
  const fs = await arcgis(ctx, BLOCKS, { ...boxQuery(box), outFields: 'GEOID,HU100,INTPTLON,INTPTLAT', returnGeometry: 'true', outSR: '4326' }, '2020 Census blocks (Census Bureau TIGERweb)');
  return fs
    .filter((f) => f.geometry?.rings?.length && Number.isFinite(Number(f.attributes?.HU100)))
    .map((f) => ({ geoid: String(f.attributes.GEOID), hu: Number(f.attributes.HU100), point: [Number(f.attributes.INTPTLON), Number(f.attributes.INTPTLAT)], rings: f.geometry.rings, box: bbox(f.geometry.rings) }));
}

/**
 * The roll for these parcels, grouped by parcel, class and street, with no
 * owner field: properties (distinct accounts, so a condo unit is one and a
 * property's several buildings are one), building rows, building area and the
 * oldest building's year.
 */
export async function rollGroups(ctx, gpins) {
  const ids = [...new Set([...gpins].map(String))].filter((g) => /^\d{6,12}$/.test(g)).sort();
  const rows = [];
  for (let i = 0; i < ids.length; i += ROLL_BATCH) {
    const list = ids.slice(i, i + ROLL_BATCH).join(', ');
    for (let offset = 0; ; offset += PAGE) {
      const q = `SELECT gpin, property_class_description, property_street_name, property_street_type, count(distinct lrsn) AS n, count(*) AS rows, sum(commercial_building_area) AS area, min(improvement_year_built) AS built WHERE gpin IN (${list}) GROUP BY gpin, property_class_description, property_street_name, property_street_type ORDER BY gpin, property_class_description, property_street_name, property_street_type LIMIT ${PAGE}${offset ? ` OFFSET ${offset}` : ''}`;
      const got = await ctx.socrata.query(ROLL.id, q, { tool: 'assessment roll: property classes by parcel', name: ROLL.name });
      rows.push(...got);
      if (got.length < PAGE) break;
    }
  }
  return rows;
}

// --- homes --------------------------------------------------------------------

export const streetTag = (name, type) => `${String(name || '').trim().toUpperCase()}|${type || ''}`;

/**
 * Homes per parcel. Fixed classes count exactly, per property (a duplex 2, a
 * house with an extra unit 2, each condominium unit 1). Apartment properties
 * come only as bands, so their units are estimated from the 2020 Census: in
 * each block, the block's housing units less the homes the roll counts
 * exactly (for buildings standing in 2020) are shared among the block's
 * apartment properties by building area, within each property's band. A
 * property whose buildings all went up after 2020, or on a parcel in none of
 * `blocks`, counts at its band's floor. Pass every parcel of each block in
 * `blocks`, so each block's estimate sees all of its homes.
 * Returns { byParcel: Map gpin -> { exact, estimated, homesByKind, propertiesByKind, streets }, notes }.
 */
export function homesByParcel(parcels, blocks, groups) {
  const byParcel = new Map();
  for (const r of groups) {
    const g = String(r.gpin);
    const c = classCode(r.property_class_description);
    if (!isResidentialCode(c)) continue;
    const n = Number(r.n) || 1;
    const fam = classFamily(c);
    const built = Number(r.built) || 0;
    const p = byParcel.get(g) || { exact: 0, estimated: 0, standing2020: 0, homesByKind: {}, propertiesByKind: {}, streets: new Set(), apartments: [] };
    p.propertiesByKind[fam] = (p.propertiesByKind[fam] || 0) + n;
    if (r.property_street_name) p.streets.add(streetTag(r.property_street_name, typeOf(r.property_street_type)));
    if (c in FIXED_UNITS) {
      const u = FIXED_UNITS[c] * n;
      p.exact += u;
      p.homesByKind[fam] = (p.homesByKind[fam] || 0) + u;
      if (!(built > 2020)) p.standing2020 += u;
    } else {
      const [lo, hi] = BANDED_UNITS[c];
      const area = Number(r.area) || 0;
      p.apartments.push({ p, fam, n, lo: lo * n, hi: hi * n, weight: area > 0 ? area : lo * n * SQFT_PER_UNIT, built });
    }
    byParcel.set(g, p);
  }
  const notes = { blocks_used: 0, apartment_properties_fit: 0, short_of_bands: 0, over_bands: 0, built_after_2020: 0, no_block: 0 };
  const give = (a, units) => {
    a.p.estimated += units;
    a.p.homesByKind[a.fam] = (a.p.homesByKind[a.fam] || 0) + units;
  };
  const inBlock = blockIndex(new Map([...parcels].filter(([g]) => byParcel.has(g))), blocks);
  const perBlock = new Map();
  for (const [g, p] of byParcel) {
    const k = inBlock.get(g) ?? null;
    if (!perBlock.has(k)) perBlock.set(k, []);
    perBlock.get(k).push(p);
  }
  const hu = new Map(blocks.map((b) => [b.geoid, b.hu]));
  for (const [geoid, members] of perBlock) {
    const old = [];
    for (const p of members) for (const a of p.apartments) {
      if (geoid === null) { give(a, a.lo); notes.no_block += a.n; continue; }
      if (a.built > 2020) { give(a, a.lo); notes.built_after_2020 += a.n; continue; }
      old.push(a);
    }
    if (geoid === null || !old.length) continue;
    const known = members.reduce((s, p) => s + p.standing2020, 0);
    const lo = old.reduce((s, a) => s + a.lo, 0);
    const hi = old.reduce((s, a) => s + a.hi, 0);
    const resid = hu.get(geoid) - known;
    const target = Math.min(Math.max(resid, lo), hi);
    notes.blocks_used += 1;
    const props = old.reduce((s, a) => s + a.n, 0);
    if (resid < lo) notes.short_of_bands += props;
    else if (resid > hi) notes.over_bands += props;
    else notes.apartment_properties_fit += props;
    const alloc = old.map((a) => a.lo);
    let rest = target - lo;
    for (let round = 0; round < 12 && rest > 1e-9; round++) {
      const room = old.map((a, i) => i).filter((i) => alloc[i] < old[i].hi);
      if (!room.length) break;
      const w = room.reduce((s, i) => s + old[i].weight, 0);
      let spill = 0;
      for (const i of room) {
        const share = (rest * old[i].weight) / w;
        const take = Math.min(share, old[i].hi - alloc[i]);
        alloc[i] += take;
        spill += share - take;
      }
      rest = spill;
    }
    old.forEach((a, i) => give(a, alloc[i]));
  }
  for (const p of byParcel.values()) {
    delete p.apartments;
    delete p.standing2020;
  }
  return { byParcel, notes };
}

/** Totals over a set of parcels: homes overall and by kind (rounded), and properties by kind. */
export function tally(byParcel, gpins) {
  let exact = 0;
  let estimated = 0;
  let parcels = 0;
  const homes = {};
  const properties = {};
  for (const g of gpins) {
    const p = byParcel.get(g);
    if (!p) continue;
    parcels += 1;
    exact += p.exact;
    estimated += p.estimated;
    for (const [k, v] of Object.entries(p.homesByKind)) homes[k] = (homes[k] || 0) + v;
    for (const [k, v] of Object.entries(p.propertiesByKind)) properties[k] = (properties[k] || 0) + v;
  }
  return {
    residential_parcels: parcels,
    homes: Math.round(exact + estimated),
    homes_counted_exactly: exact,
    homes_estimated: Math.round(estimated),
    homes_by_kind: Object.fromEntries(Object.entries(homes).map(([k, v]) => [k, Math.round(v)])),
    properties_by_kind: properties,
  };
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

// A cross street meets the street where one of its vertices lies this close to a piece's end.
const SNAP_M = 3;
// Pieces of one street join where their ends lie this close (North Shore Road's
// 1400 and 1500 blocks are 8.8 m apart at Hampton Boulevard, 2026-11-14).
const JOIN_M = 12;
// The other carriageway of a divided road lies within this of the walked one.
const CORRIDOR_M = 40;
const near = (a, b, m = SNAP_M) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= m;
const plen = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const unit = ([x, y]) => {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

/**
 * The shortest connected way along one street's centerline pieces from a node
 * where cross street A meets it to a node where B does. Pieces join where
 * their ends lie within JOIN_M; a cross street meets the street where one of
 * its vertices lies within SNAP_M of a piece's end. Edges are { pts (projected), len }.
 * Returns { meetsA, meetsB } and, when connected, { path (edge indexes), start, end, length }.
 */
export function walk(edges, vertsA, vertsB) {
  const nodes = [];
  const members = [];
  const nodeOf = (pt) => {
    let i = nodes.findIndex((q) => near(q, pt, JOIN_M));
    if (i < 0) {
      i = nodes.push(pt) - 1;
      members.push([]);
    }
    members[i].push(pt);
    return i;
  };
  const adj = new Map();
  edges.forEach((e, k) => {
    const n0 = nodeOf(e.pts[0]);
    const n1 = nodeOf(e.pts[e.pts.length - 1]);
    for (const [u, v] of [[n0, n1], [n1, n0]]) {
      if (!adj.has(u)) adj.set(u, []);
      adj.get(u).push({ v, k });
    }
  });
  const meeting = (verts) => new Set(nodes.flatMap((q, i) => (members[i].some((m) => verts.some((v) => near(m, v))) ? [i] : [])));
  const atA = meeting(vertsA);
  const atB = meeting(vertsB);
  if (!atA.size || !atB.size) return { meetsA: atA.size > 0, meetsB: atB.size > 0 };
  const dist = new Map([...atA].map((i) => [i, 0]));
  const prev = new Map();
  const todo = new Set(atA);
  while (todo.size) {
    let u = null;
    for (const i of todo) if (u === null || dist.get(i) < dist.get(u)) u = i;
    todo.delete(u);
    if (atB.has(u) && !atA.has(u)) {
      const path = [];
      let x = u;
      while (prev.has(x)) {
        path.unshift(prev.get(x).k);
        x = prev.get(x).from;
      }
      return { meetsA: true, meetsB: true, path, start: nodes[x], end: nodes[u], length: dist.get(u) };
    }
    for (const { v, k } of adj.get(u) || []) {
      const d = dist.get(u) + edges[k].len;
      if (!dist.has(v) || d < dist.get(v)) {
        dist.set(v, d);
        prev.set(v, { from: u, k });
        todo.add(v);
      }
    }
  }
  return { meetsA: true, meetsB: true };
}

/** Direction into the stretch from its end E, along the edge that starts there (taken 10 m in). */
function inwardFrom(E, pts) {
  const p = near(pts[0], E) ? pts : [...pts].reverse();
  const q = p.find((x) => Math.hypot(x[0] - E[0], x[1] - E[1]) >= 10) || p[p.length - 1];
  return unit([q[0] - E[0], q[1] - E[1]]);
}

/**
 * One end of the stretch: the cross street's line through E, with n the unit
 * normal pointing into the stretch. Where the cross street runs within 30
 * degrees of the street itself, the cut is square to the street instead.
 */
function endAt(E, crossLines, inward) {
  const m = nearestOnLines(E, crossLines);
  const t = unit([m.b[0] - m.a[0], m.b[1] - m.a[1]]);
  const n = [-t[1], t[0]];
  const c = dot(n, inward);
  if (Math.abs(c) < 0.5) return { E, n: inward };
  return { E, n: c < 0 ? [-n[0], -n[1]] : n };
}

/** Whether a projected point lies more than `tol` meters past either end of a stretch, on the far side of its cross street's line. */
export function pastEnd(pt, ends, tol = PAST_M) {
  return ends.some(({ E, n }) => dot([pt[0] - E[0], pt[1] - E[1]], n) < -tol);
}

const nameOf = (f) => String(f.attributes?.ST_NAME ?? '').trim();
const typeIn = (f) => String(f.attributes?.ST_TYPE ?? '').trim();
const dirIn = (f) => String(f.attributes?.PRE_DIR ?? '').trim();

/** The centerline pieces a street as written names: its exact name if any piece has it, then its type and direction if given. */
function piecesNamed(features, q) {
  let list = features.filter((f) => q.keys.includes(nameOf(f)));
  const narrow = (test) => {
    if (list.some(test)) list = list.filter(test);
  };
  narrow((f) => nameOf(f) === q.keys[0]);
  if (q.type) narrow((f) => typeIn(f) === q.type);
  if (q.dir) narrow((f) => dirIn(f) === q.dir);
  return list;
}

/**
 * A street between two cross streets, from the City's centerlines: the
 * connected stretch from one crossing to the other (both carriageways of a
 * divided road), its blocks and address ranges and the centerline's own
 * fields. Each full street name (Llewellyn Avenue, Llewellyn Mews) is walked
 * on its own; the shortest connected one wins. Returns { segment } or { error }.
 */
export async function resolveSegment(ctx, { street, from, to }) {
  const [S, A, B] = [street, from, to].map(streetQuery);
  if (!S || !A || !B) return { error: 'Give the street and both cross streets as plain names, e.g. Graydon, Colley and Colonial.' };
  const same = (x, y) => x.keys[0] === y.keys[0] && (!x.type || !y.type || x.type === y.type);
  if (same(S, A) || same(S, B) || same(A, B)) {
    return { error: 'The street and its two cross streets must be three different streets.' };
  }
  const keys = [...new Set([...S.keys, ...A.keys, ...B.keys])];
  const fs = await arcgis(ctx, CENTERLINES, {
    where: `ST_NAME IN (${keys.map(sqlString).join(', ')})`,
    outFields: 'FULLNAME,PRE_DIR,ST_NAME,ST_TYPE,LBLOCK,LADD_FR,LADD_TO,RADD_FR,RADD_TO,SPEEDLIMIT,ONEWAY,CLASS',
    returnGeometry: 'true', outSR: '4326',
  }, 'street centerlines (City map services)');
  const usable = fs.filter((f) => f.geometry?.paths?.some((p) => p.length > 1));
  const mains = piecesNamed(usable, S);
  if (!mains.length) return { error: `I found no street named ${street} in the City's centerlines.` };
  const lat0 = mains[0].geometry.paths.find((p) => p.length > 1)[0][1];
  const P = projector(lat0);
  const linesOf = (list) => list.flatMap((f) => f.geometry.paths.filter((p) => p.length > 1).map((p) => p.map(P)));
  const crossA = linesOf(piecesNamed(usable, A).filter((f) => !mains.includes(f)));
  const crossB = linesOf(piecesNamed(usable, B).filter((f) => !mains.includes(f)));
  if (!crossA.length) return { error: `I found no street named ${from} in the City's centerlines.` };
  if (!crossB.length) return { error: `I found no street named ${to} in the City's centerlines.` };
  const vertsA = crossA.flat();
  const vertsB = crossB.flat();
  let best = null;
  let meetsA = false;
  let meetsB = false;
  for (const name of [...new Set(mains.map((f) => f.attributes.FULLNAME))]) {
    const edges = mains.filter((f) => f.attributes.FULLNAME === name).flatMap((f) => f.geometry.paths.filter((p) => p.length > 1).map((p) => {
      const pts = p.map(P);
      return { f, path: p, pts, len: plen(pts) };
    }));
    const w = walk(edges, vertsA, vertsB);
    meetsA ||= w.meetsA;
    meetsB ||= w.meetsB;
    if (w.path && (!best || w.length < best.w.length)) best = { name, edges, w };
  }
  if (!best) {
    if (!meetsA) return { error: `In the City's centerlines, ${from} doesn't meet ${street}.` };
    if (!meetsB) return { error: `In the City's centerlines, ${to} doesn't meet ${street}.` };
    return { error: `In the City's centerlines, ${street} doesn't run unbroken from ${from} to ${to}.` };
  }
  const { edges, w } = best;
  const pathLines = w.path.map((k) => edges[k].pts);
  const ends = [
    endAt(w.start, crossA, inwardFrom(w.start, edges[w.path[0]].pts)),
    endAt(w.end, crossB, inwardFrom(w.end, edges[w.path[w.path.length - 1]].pts)),
  ];
  // The other carriageway of a divided road: the same street, alongside the
  // walked one all the way, and not running past either cross street.
  // Median crossovers (road class 7) join the two but belong to neither.
  const chosen = new Set(w.path);
  edges.forEach((e, k) => {
    if (!chosen.has(k) && Number(e.f.attributes.CLASS) !== 7 && e.pts.every((p) => nearestOnLines(p, pathLines).d <= CORRIDOR_M && !pastEnd(p, ends, 10))) chosen.add(k);
  });
  const segEdges = [...chosen].map((k) => edges[k]);
  const feats = [...new Set(segEdges.map((e) => e.f))];
  const blockOf = (f) => Number(f.attributes.LBLOCK);
  const uniq = (xs) => [...new Set(xs.filter((x) => x != null && x !== ''))];
  const walked = new Map();
  for (const k of w.path) if (Number(edges[k].f.attributes.CLASS) !== 7) walked.set(blockOf(edges[k].f), (walked.get(blockOf(edges[k].f)) || 0) + edges[k].len);
  const blocks = [...new Set(feats.filter((f) => Number(f.attributes.CLASS) !== 7).map(blockOf))].filter((b) => Number.isFinite(b) && b > 0).sort((x, y) => x - y).map((block) => {
    const here = feats.filter((f) => blockOf(f) === block && Number(f.attributes.CLASS) !== 7).map((f) => f.attributes);
    const nums = here.flatMap((a) => [a.LADD_FR, a.LADD_TO, a.RADD_FR, a.RADD_TO]).map(Number).filter((x) => x > 0);
    return {
      block,
      addresses: nums.length ? `${Math.min(...nums)}-${Math.max(...nums)}` : null,
      carriageways: here.some((a) => Number(a.ONEWAY) === 2) ? 2 : 1,
      length_ft: walked.has(block) ? Math.round(walked.get(block) * 3.28084) : null,
      speed_limit_mph: uniq(here.map((a) => a.SPEEDLIMIT)).map(Number),
      traffic: uniq(here.map((a) => ONE_WAY[a.ONEWAY] ?? null)),
      road_class: uniq(here.map((a) => ROAD_CLASS[a.CLASS] ?? null)),
    };
  });
  const all = blocks.flatMap((b) => (b.addresses ? b.addresses.split('-').map(Number) : []));
  return {
    segment: {
      street: best.name,
      from, to,
      blocks,
      addresses: all.length ? `${Math.min(...all)}-${Math.max(...all)}` : null,
      length_m: Math.round(w.length),
      streetTag: streetTag(nameOf(feats[0]), typeIn(feats[0]) || null),
      prefix: dirIn(feats[0]) || null,
      lat0,
      lines: segEdges.map((e) => e.pts),
      ends,
      box: bbox(segEdges.map((e) => e.path)),
    },
  };
}

/** Parcels that touch a segment: within `reach` m of a carriageway's centerline, their lot's center not past either cross street. */
export function touchingParcels(parcels, segment, reach = REACH_M) {
  const P = projector(segment.lat0);
  const pad = padBox(segment.box, 0.0005);
  const out = [];
  for (const [g, rings] of parcels) {
    const b = bbox(rings);
    if (b.xmax < pad.xmin || b.xmin > pad.xmax || b.ymax < pad.ymin || b.ymin > pad.ymax) continue;
    const pr = rings.map((r) => r.map(P));
    if (pastEnd(centroid(pr), segment.ends)) continue;
    if (polygonToLines(pr, segment.lines) <= reach) out.push(g);
  }
  return out;
}
