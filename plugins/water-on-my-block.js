// water_on_my_block: where does the water go on this block?
// A Norfolk plugin, written against the plugin interface (src/plugins.js) as
// its first real test. Every source was checked live on 2026-10-06:
//   - Address Information (ere7-kake): parcel centroid, census tract, civic league, evacuation zone
//   - FEMA National Flood Hazard Layer, layer 28 "Flood Hazard Zones" (hazards.fema.gov)
//   - FEMA NFIP Claims (suf7-r643): anonymized by FEMA to census tract / block group, never to a parcel
//   - Storm Water Asset Inspections (uvc6-r75u), Work Orders (qzfe-wj25, areas Stormwater and Forestry)
//   - Tide Sensors (mgyn-4sni): station coordinates are from the dataset's own column descriptions

import { definePlugin } from '../src/plugins.js';
import { soqlString } from '../src/socrata.js';

const NORFOLK_COUNTY_FIPS = '51710';
const OPEN_WORK_ORDER = 'status_code < 800 OR status_code = 941';

// From the Tide Sensors (mgyn-4sni) column descriptions.
export const TIDE_GAUGES = [
  { field: 'elizabeth_river_eastern_branch', name: 'Elizabeth River Eastern Branch at Grandy Village', lat: 36.83975, lon: -76.25027 },
  { field: 'little_creek', name: 'Little Creek at 20th Bay St', lat: 36.92551, lon: -76.19395 },
  { field: 'lafayette_river', name: 'Lafayette River at Mayflower Rd', lat: 36.88854, lon: -76.28518 },
  { field: 'mason_creek', name: 'Mason Creek at Granby St', lat: 36.93147, lon: -76.26623, note: 'Water flows through a weir here, so readings differ from the other four gauges.' },
  { field: 'elizabeth_river_main_branch', name: 'Elizabeth River Main Branch at Nauticus', lat: 36.84819, lon: -76.29336 },
];

export function km(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Address Information gives tract 28 or 65.02; FEMA uses the census GEOID.
export function tractGeoid(tract) {
  const n = Number(tract);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${NORFOLK_COUNTY_FIPS}${String(Math.round(n * 100)).padStart(6, '0')}`;
}

// "Colonial Place and Riverview" and "Colonial Place/ Riverview" are the same league.
export function leagueKey(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/\bAND\b|&/g, ' ')
    .replace(/[^A-Z]/g, '');
}

const settle = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: String(err?.message || err) };
  }
};

export default definePlugin({
  name: 'water_on_my_block',
  cities: ['norfolk'],
  description:
    'Where the water goes on a block: FEMA flood zone at the parcel, evacuation zone, flood insurance claims in the census tract by cause (rain vs tide), stormwater inspections and work orders in the civic league, open stormwater work orders on the street, tree removals vs plantings, and the nearest tide gauge. Use for flooding, stormwater, drainage, trees or "sponge city" questions about an address.',
  parameters: {
    type: 'object',
    properties: { address: { type: 'string', description: 'House number and street, e.g. "111 Pennsylvania Ave".' } },
    required: ['address'],
    additionalProperties: false,
  },

  async run(ctx, { address }) {
    const found = await ctx.lookupAddress(address);
    if (!found.match) return found;
    const a = found.match;
    const ward = Number(a.ward);
    const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

    const floodZone = settle(async () => {
      if (!Number.isFinite(a.lat)) return { error: 'No parcel coordinates in the address record.' };
      const params = new URLSearchParams({
        geometry: `${a.lon},${a.lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE',
        returnGeometry: 'false',
        f: 'json',
      });
      const url = `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?${params}`;
      const data = await ctx.http.json(url, { tool: 'FEMA flood zone at parcel centroid' });
      if (data.error) throw new Error(data.error.message || 'FEMA service error');
      ctx.resources.addLink({
        title: 'FEMA flood map for this address (Map Service Center)',
        url: `https://msc.fema.gov/portal/search?AddressQuery=${encodeURIComponent(`${a.address}, Norfolk, VA`)}`,
      });
      return {
        zones: (data.features || []).map((f) => ({
          zone: f.attributes.FLD_ZONE,
          subtype: f.attributes.ZONE_SUBTY || null,
          special_flood_hazard_area: f.attributes.SFHA_TF === 'T',
          base_flood_elevation_ft: f.attributes.STATIC_BFE > -9999 ? f.attributes.STATIC_BFE : null,
        })),
        matched_on: 'the parcel centroid; a lot that crosses a zone line can sit in more than one zone',
      };
    });

    const claims = settle(async () => {
      const geoid = tractGeoid(a.census_tract);
      if (!geoid) return { error: 'No census tract in the address record.' };
      const rows = await ctx.socrata.query(
        'suf7-r643',
        // census_tract is numeric here and holds the 12-digit block group, so a
        // tract is the range <tract GEOID>0 .. <tract GEOID>9.
        `SELECT cause_of_damage, count(*) AS claims, sum(net_building_payment_amount) AS building_paid, sum(net_contents_payment_amount) AS contents_paid, min(date_of_loss) AS first_loss, max(date_of_loss) AS last_loss WHERE census_tract >= ${geoid}0 AND census_tract <= ${geoid}9 GROUP BY cause_of_damage ORDER BY claims DESC LIMIT 20`,
        { tool: 'flood claims in tract', name: 'FEMA NFIP Claims' }
      );
      return {
        census_tract: a.census_tract,
        tract_geoid: geoid,
        by_cause: rows.map((r) => ({
          cause: r.cause_of_damage || '(not recorded)',
          claims: Number(r.claims),
          paid_usd: Math.round(Number(r.building_paid || 0) + Number(r.contents_paid || 0)),
          first_loss: r.first_loss?.slice(0, 10),
          last_loss: r.last_loss?.slice(0, 10),
        })),
        note: 'Insured claims only, anonymized by FEMA to the census tract. They describe the tract, not this house, and they count only properties that carried flood insurance.',
      };
    });

    // Stormwater inspections and work orders spell civic leagues differently
    // from Address Information, so match on a normalized name within the ward.
    const league = settle(async () => {
      const rows = await ctx.socrata.query(
        'uvc6-r75u',
        `SELECT civicleague, count(*) AS n WHERE ward = ${soqlString(String(ward))} GROUP BY civicleague LIMIT 200`,
        { tool: 'match civic league', name: 'Storm Water Asset Inspections' }
      );
      if (!a.facts.civic_league) return null;
      const want = leagueKey(a.facts.civic_league);
      const hit = rows.find((r) => leagueKey(r.civicleague) === want);
      return hit ? hit.civicleague : null;
    });

    const leagueName = await league;
    const leagueFound = typeof leagueName === 'string';
    // A failed lookup is an error, not an empty result: say so, don't report "I found no records".
    const leagueError = leagueName?.error ? { error: `The civic league lookup failed: ${leagueName.error}` } : null;

    const stormwater = settle(async () => {
      if (leagueError) return leagueError;
      if (!a.facts.civic_league) return { error: 'The address record names no civic league for this parcel, so I did not look up league-level stormwater records.' };
      if (!leagueFound) return { error: `I found no stormwater records under a civic league matching "${a.facts.civic_league}" in ward ${ward}.` };
      const [inspections, orders, openOnStreet] = await Promise.all([
        ctx.socrata.query(
          'uvc6-r75u',
          `SELECT work_type, asset_type, count(*) AS n WHERE civicleague = ${soqlString(leagueName)} AND inspection_date >= ${soqlString(`${yearAgo}T00:00:00`)} GROUP BY work_type, asset_type ORDER BY n DESC LIMIT 20`,
          { tool: 'stormwater inspections, last 12 months', name: 'Storm Water Asset Inspections' }
        ),
        ctx.socrata.query(
          'qzfe-wj25',
          `SELECT problem_description, status_description, count(*) AS n WHERE area = 'Stormwater' AND civic_league = ${soqlString(leagueName)} AND created_datetime >= ${soqlString(`${yearAgo}T00:00:00`)} GROUP BY problem_description, status_description ORDER BY n DESC LIMIT 20`,
          { tool: 'stormwater work orders, last 12 months', name: 'Work Orders' }
        ),
        ctx.socrata.query(
          'qzfe-wj25',
          `SELECT work_order_number, problem_description, primary_task_description, status_description, created_datetime WHERE area = 'Stormwater' AND street = ${soqlString(a.street_name)} AND ward = ${ward} AND (${OPEN_WORK_ORDER}) ORDER BY created_datetime LIMIT 10`,
          { tool: 'open stormwater work orders on the street', name: 'Work Orders' }
        ),
      ]);
      return {
        civic_league_matched: leagueName,
        inspections_last_12_months: inspections.map((r) => ({ work_type: r.work_type, asset_type: r.asset_type, count: Number(r.n) })),
        work_orders_last_12_months: orders.map((r) => ({ problem: r.problem_description, status: r.status_description, count: Number(r.n) })),
        open_on_street: openOnStreet,
        open_means: 'status codes below 800, or 941 (WO On Hold)',
      };
    });

    const trees = settle(async () => {
      if (leagueError) return leagueError;
      if (!leagueFound) return { error: a.facts.civic_league ? `I found no work orders under a civic league matching "${a.facts.civic_league}".` : 'The address record names no civic league for this parcel.' };
      const rows = await ctx.socrata.query(
        'qzfe-wj25',
        `SELECT primary_task_description, count(*) AS n WHERE area = 'Forestry' AND civic_league = ${soqlString(leagueName)} GROUP BY primary_task_description ORDER BY n DESC LIMIT 20`,
        { tool: 'forestry work by task', name: 'Work Orders' }
      );
      const by = Object.fromEntries(rows.map((r) => [r.primary_task_description, Number(r.n)]));
      return {
        civic_league_matched: leagueName,
        by_task: by,
        removals: by.Removal || 0,
        plantings: by.Plantings || 0,
        note: 'All Forestry work orders the dataset holds for this civic league. Stump grinding usually follows a removal, so it is listed separately rather than added to removals.',
      };
    });

    // A gauge can go quiet (Nauticus last reported 2024-08-08), so report the
    // nearest gauge and, if it's stale, the nearest one still reporting.
    const tide = settle(async () => {
      if (!Number.isFinite(a.lat)) return { error: 'No parcel coordinates in the address record.' };
      const ranked = TIDE_GAUGES.map((g) => ({ ...g, km: km(a, g) })).sort((x, y) => x.km - y.km);
      const round = (x) => (x == null ? null : Math.round(Number(x) * 100) / 100);
      const staleAfter = Date.now() - 30 * 864e5;
      const gauges = [];
      for (const g of ranked) {
        const latest = await ctx.socrata.query('mgyn-4sni', `SELECT localtime, ${g.field} WHERE ${g.field} IS NOT NULL ORDER BY timestamp DESC LIMIT 1`, {
          tool: `latest tide reading: ${g.name}`,
          name: 'Tide Sensors',
        });
        const at = latest[0]?.localtime || null;
        const current = Boolean(at) && Date.parse(at) >= staleAfter;
        const entry = {
          gauge: g.name,
          distance_km: Math.round(g.km * 10) / 10,
          latest: at ? { at, height_ft: round(latest[0][g.field]) } : null,
          reporting: current,
          ...(g.note ? { note: g.note } : {}),
        };
        if (current) {
          const high = await ctx.socrata.query('mgyn-4sni', `SELECT max(${g.field}) AS high WHERE localtime >= ${soqlString(`${yearAgo}T00:00:00`)} LIMIT 1`, {
            tool: `highest tide reading, last 12 months: ${g.name}`,
            name: 'Tide Sensors',
          });
          entry.highest_last_12_months_ft = round(high[0]?.high);
        }
        gauges.push(entry);
        if (current || gauges.length >= 3) break;
      }
      return {
        gauges,
        note: 'Heights are in feet; the dataset does not state the vertical datum, so compare readings with each other, not with ground elevation. A gauge counts as reporting if its latest reading is under 30 days old. The city publishes this data unverified.',
      };
    });

    const [flood_zone, flood_claims, storm, tree_work, tide_gauge] = await Promise.all([floodZone, claims, stormwater, trees, tide]);
    return {
      address: a.address,
      evacuation_zone: a.facts.evacuation_zone || null,
      flood_zone,
      flood_claims_in_tract: flood_claims,
      stormwater: storm,
      trees: tree_work,
      tide: tide_gauge,
    };
  },
});
