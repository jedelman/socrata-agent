// parcel_inventory: everything the City's open-data map services say about the
// spot an address sits on, in one call. A place lookup, never a person lookup.
//
// One ArcGIS `identify` per service returns every layer that covers the parcel
// centroid, so a new layer the City publishes shows up without a new connector.
// Checked live on 2026-11-07 at 1300 Colley Ave (gisshare.norfolk.gov, pubserver,
// folder OpenData, MapServer identify with layers=all, tolerance 0):
//   Planning        zoning, planning district, future land use, zoning overlays,
//                   census tract, neighborhood service area (also CBPA,
//                   conditional zoning where they apply)
//   Maps            school boundaries, wards and super wards, precinct, ZIP,
//                   civic league, economic district
//   Environmental   FIRM flood zone, wetlands
//   Public_Safety   fire demand zone, police car district and precinct (AICUZ
//                   zones where they apply)
//   Parcels         address record, parcel (GPIN, tax account)
//   RPOS            parks (when the point is in one)
// What is dropped before the model sees it:
//   - any field named like a person (core's isPersonColumn, the same rule
//     Socrata reads follow), plus civic league president fields: the Maps
//     service's Civic Leagues layer carries a private person's name, mailing
//     address and email;
//   - who edited the map (created_user, last_edited_user: staff usernames) and
//     geometry bookkeeping (Shape, OBJECTID, STArea, STLength);
//   - empty values ("Null", blank).
// Elected officials' names in the Wards layers are kept: they are public office.

import { definePlugin } from '../src/plugins.js';
import { isPersonColumn } from '../src/socrata.js';

const BASE = 'https://gisshare.norfolk.gov/pubserver/rest/services/OpenData';
export const SERVICES = ['Planning', 'Maps', 'Environmental', 'Public_Safety', 'Parcels', 'RPOS'];
const ORDINANCE_PAGE = 'https://www.norfolk.gov/3910/Zoning-Ordinance-Rewrite';

const BOOKKEEPING = /^(objectid(_\d+)?|fid|globalid|shape|shape_leng|shape_length|shape_area|perimeter|created_user|created_date|last_edited_user|last_edited_date|lastsyndate)$|\.?st(area|length)\(\)$/;
const OFFICER = /(^|_)pres(ident)?(_|$)|^pres_/;
export const fieldKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9.()]+/g, '_').replace(/^_|_$/g, '');

/** Keep what describes the place; drop people, editors, bookkeeping and blanks. */
export function cleanAttributes(attrs) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    const key = fieldKey(k);
    if (BOOKKEEPING.test(key)) continue;
    if (isPersonColumn(key) || OFFICER.test(key)) {
      dropped.push(k);
      continue;
    }
    if (v == null || v === 'Null' || String(v).trim() === '') continue;
    out[k] = v;
  }
  return { attributes: out, dropped };
}

export function identifyUrl(service, lon, lat) {
  const d = 0.001;
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    sr: '4326',
    layers: 'all',
    tolerance: '0',
    mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`,
    imageDisplay: '400,400,96',
    returnGeometry: 'false',
    f: 'json',
  });
  return `${BASE}/${service}/MapServer/identify?${params}`;
}

const settle = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: String(err?.message || err) };
  }
};

export default definePlugin({
  name: 'parcel_inventory',
  cities: ['norfolk'],
  description:
    "Everything the City's open-data map layers say about the spot an address sits on, in one call: zoning district and overlays, future land use, planning district, flood zone (FIRM), wetlands, Chesapeake Bay Preservation Area, conditional zoning, parcel GPIN and tax account, school boundaries, ward and super ward, precinct, ZIP, civic league, census tract, fire and police districts, AICUZ zones, parks. Use it for zoning questions (what district is this, before asking what a use like a restaurant needs) and for any question about what map layers cover an address. Fields naming private people are removed.",
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

    const withheld = new Set();
    const byService = await Promise.all(
      SERVICES.map((service) =>
        settle(async () => {
          const data = await ctx.http.json(identifyUrl(service, a.lon, a.lat), { tool: `map layers at parcel centroid (${service})` });
          if (data.error) throw new Error(data.error.message || 'map service error');
          return (data.results || []).map((r) => {
            const { attributes, dropped } = cleanAttributes(r.attributes);
            for (const f of dropped) withheld.add(`${r.layerName}: ${f}`);
            return { layer: r.layerName, ...attributes };
          });
        }).then((layers) => [service, layers])
      )
    );

    ctx.resources.addLink({ title: "City of Norfolk open-data map services (gisshare.norfolk.gov)", url: `${BASE}` });
    ctx.resources.addLink({ title: 'Norfolk Zoning Ordinance (official approved PDF) and zoning map', url: ORDINANCE_PAGE });

    return {
      address: a.address,
      layers: Object.fromEntries(byService),
      withheld_fields: [...withheld].sort(),
      matched_on: 'the parcel centroid; a lot that crosses a boundary can sit in more than one district, and a map can lag the ordinance or a new decision',
      note: "These are the City's open-data map layers, not legal determinations. For zoning, the district's use table in the Zoning Ordinance says whether a use is permitted, needs a Conditional Use Permit, or is prohibited; for a binding answer, ask the Department of City Planning for a Zoning Determination. Fields naming private people (for example a civic league president's name, address and email) are withheld; contacts come from the address record instead.",
    };
  },
});
