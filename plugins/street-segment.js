// street_segment: a street between two cross streets, from the City's own
// centerlines. Which blocks it spans and their address ranges, each block's
// speed limit, traffic direction and road class, and how many parcels touch
// it. Built for questions about a stretch of street, such as Jason's study of
// Graydon Avenue as a pedestrian street (docs/gis-skills.md). For how many
// homes a segment holds, housing_count does the counting.
//
// "Touching" means a parcel's shape comes within 15 m of the street's
// centerline and the parcel isn't past either cross street, so corner
// buildings addressed on a cross street count (Jason, 2026-11-14: "touching
// parcels should count, intuitively"). Counts only: no parcel, address or
// owner is ever listed.

import { definePlugin } from '../src/plugins.js';
import { resolveSegment, parcelsIn, padBox, touchingParcels, rollGroups, classCode, isResidentialCode, OPEN_DATA, REACH_M } from './gis.js';

export default definePlugin({
  name: 'street_segment',
  cities: ['norfolk'],
  description:
    "A street between two cross streets, from the City's street centerlines: the blocks it spans and their address ranges; each block's speed limit, traffic direction (two-way, one-way, or a divided road) and road class; and how many parcels touch it (within 15 m of the centerline, corner buildings on the cross streets included), how many of those are residential, and how many are addressed on the street itself. Use it for questions about a stretch of street; for how many homes it holds, or its share of a neighborhood's homes, use housing_count.",
  parameters: {
    type: 'object',
    properties: {
      street: { type: 'string', description: 'The street, e.g. "Graydon Ave".' },
      from: { type: 'string', description: 'One cross street, e.g. "Colley Ave".' },
      to: { type: 'string', description: 'The other cross street, e.g. "Colonial Ave".' },
    },
    required: ['street', 'from', 'to'],
    additionalProperties: false,
  },

  async run(ctx, { street, from, to }) {
    const found = await resolveSegment(ctx, { street, from, to });
    if (found.error) return { error: found.error };
    const seg = found.segment;
    const parcels = await parcelsIn(ctx, padBox(seg.box, 0.0006));
    const touch = touchingParcels(parcels, seg);
    const groups = await rollGroups(ctx, touch);
    const residential = new Set();
    const onStreet = new Set();
    for (const r of groups) {
      if (!isResidentialCode(classCode(r.property_class_description))) continue;
      residential.add(String(r.gpin));
      if (String(r.property_street_name || '').toUpperCase() === seg.streetKey) onStreet.add(String(r.gpin));
    }
    ctx.resources.addLink({ title: "City of Norfolk open-data map services: street centerlines and parcels (gisshare.norfolk.gov)", url: OPEN_DATA });
    return {
      street: seg.street,
      between: [from, to],
      addresses: seg.addresses,
      blocks: seg.blocks,
      parcels_touching: touch.length,
      residential_parcels_touching: residential.size,
      residential_addressed_on_this_street: onStreet.size,
      residential_addressed_on_other_streets: residential.size - onStreet.size,
      about_the_data: [
        `A parcel touches the street when its shape comes within ${REACH_M} m of the street's centerline and it isn't past either cross street; corner buildings addressed on a cross street count.`,
        "Speed limits, traffic direction and road class are the City's centerline fields. A divided road has one centerline per direction (carriageways); a block's length is its longer carriageway, in feet.",
        "These are the City's open-data map layers, not legal determinations or surveys.",
      ],
    };
  },
});
