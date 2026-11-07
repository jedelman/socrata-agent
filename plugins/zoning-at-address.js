// zoning_at_address: which zoning district, and which overlays, an address is in,
// from the City's own planning map service. A place lookup, never a person lookup.
// Checked live on 2026-11-07 (gisshare.norfolk.gov, OpenData/Planning FeatureServer):
//   - layer 1 "Zoning": polygons; fields ZONE (e.g. C-C, HC-G3), TYPE (e.g. Commercial,
//     Historic District), url (the ordinance section for the district)
//   - layer 6 "Zoning Overlays": polygons; field NAME (e.g. "Colley Avenue Pedestrian
//     Commercial Overlay", "Coastal Resilience Overlay")
//   Point-in-polygon queries (inSR 4326) at 1300 Colley Ave returned C-C / Commercial and
//   those two overlays. Layer 1's field NAME and layer 6's field ZONE do not exist, and a
//   query that asks for them returns HTTP 400.
// The service is the City's open data copy; Norfolk AIR and a written Zoning
// Determination from the Department of City Planning are the official answers.

import { definePlugin } from '../src/plugins.js';

const SERVICE = 'https://gisshare.norfolk.gov/pubserver/rest/services/OpenData/Planning/FeatureServer';
const ORDINANCE_PAGE = 'https://www.norfolk.gov/3910/Zoning-Ordinance-Rewrite';

const settle = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: String(err?.message || err) };
  }
};

export function pointQuery(layer, lon, lat, outFields) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'false',
    f: 'json',
  });
  return `${SERVICE}/${layer}/query?${params}`;
}

export default definePlugin({
  name: 'zoning_at_address',
  cities: ['norfolk'],
  description:
    'The zoning district (for example C-C, HC-G3, SF-T) and the zoning overlays (for example a Pedestrian Commercial or Coastal Resilience overlay) that an address is in, from the City\'s planning map service, with a link to the Zoning Ordinance. Use it for questions about what zoning applies at an address, or before asking what a use (a restaurant, a carriage house) needs there. It reports the district only; the Zoning Ordinance\'s use table for that district says what is allowed.',
  parameters: {
    type: 'object',
    properties: { address: { type: 'string', description: 'House number and street, e.g. "1300 Colley Ave".' } },
    required: ['address'],
    additionalProperties: false,
  },

  async run(ctx, { address }) {
    const found = await ctx.lookupAddress(address);
    if (!found.match) return found;
    const a = found.match;
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return { address: a.address, error: 'No parcel coordinates in the address record.' };

    const get = async (layer, fields, tool) => {
      const data = await ctx.http.json(pointQuery(layer, a.lon, a.lat, fields), { tool });
      if (data.error) throw new Error(data.error.message || 'Planning map service error');
      return (data.features || []).map((f) => f.attributes);
    };
    const [district, overlays] = await Promise.all([
      settle(() => get(1, 'ZONE,TYPE,url', 'zoning district at parcel centroid')),
      settle(() => get(6, 'NAME', 'zoning overlays at parcel centroid')),
    ]);

    ctx.resources.addLink({ title: 'Norfolk Zoning Ordinance (official approved PDF) and zoning map', url: ORDINANCE_PAGE });
    ctx.resources.addLink({ title: 'City planning map service: Zoning layer', url: `${SERVICE}/1` });

    return {
      address: a.address,
      district: Array.isArray(district)
        ? district.map((d) => ({ zone: d.ZONE, type: d.TYPE, ordinance_section: d.url || null }))
        : district,
      overlays: Array.isArray(overlays) ? overlays.map((o) => o.NAME) : overlays,
      matched_on: 'the parcel centroid; a lot that crosses a district line can sit in more than one district, and a map can differ from the ordinance until updated',
      note: 'This reports the district and overlays only. What a use needs there is in the Zoning Ordinance use table for that district (a district can permit it, require a Conditional Use Permit, or prohibit it), and Historic and Cultural Conservation districts add a Certificate of Appropriateness for exterior changes. For a binding answer, ask the Department of City Planning for a Zoning Determination.',
    };
  },
});
