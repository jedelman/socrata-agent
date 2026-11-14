// area_lookup: which of the City's named areas a place name means. Civic
// leagues, planning districts, wards, super wards and ZIP codes, each by the
// one field that names it in the City's open-data map services. A name can
// match several: "Ghent" matches three civic leagues (Ghent Neighborhood
// League, West Ghent, Ghent Square Community Association), and Siren asks
// which one is meant, offering all of them together (Jason, 2026-11-14: "siren
// can ask clarifying questions and this is a great one"). Only the name field
// is ever requested: the Civic Leagues layer also carries a private person's
// name, mailing address and email.

import { definePlugin } from '../src/plugins.js';
import { findAreas, AREA_KINDS, OPEN_DATA } from './gis.js';

export default definePlugin({
  name: 'area_lookup',
  cities: ['norfolk'],
  description:
    "Find which of the City's named areas a place name means: civic leagues, planning districts, wards, super wards and ZIP codes, from the City's map. Returns every match with its kind and exact name, to pass to housing_count. A neighborhood name often matches more than one area (Ghent matches three civic leagues).",
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The place as the person said it, e.g. "Ghent", "Ward 2", "23507".' },
      kinds: { type: 'array', items: { type: 'string', enum: Object.keys(AREA_KINDS) }, description: 'Only these kinds of area (default: all).' },
    },
    required: ['name'],
    additionalProperties: false,
  },

  async run(ctx, { name, kinds }) {
    const found = await findAreas(ctx, name, kinds?.length ? kinds : undefined);
    if (found.error) return { error: found.error };
    ctx.resources.addLink({ title: "City of Norfolk open-data map services: civic leagues, planning districts, wards, ZIP codes (gisshare.norfolk.gov)", url: OPEN_DATA });
    const matches = found.matches.map((m) => ({ ...m, label: AREA_KINDS[m.kind].label }));
    return {
      matches,
      ...(matches.length > 1
        ? { ask: `"${name}" matches ${matches.length} areas. Unless the question already says which, ask which one is meant, listing these and offering all of them together.` }
        : {}),
      ...(matches.length === 0 ? { note: `I found no civic league, planning district, ward, super ward or ZIP code named like "${name}" in the City's map.` } : {}),
    };
  },
});
