// housing_count: how many homes an area or a street segment holds, and its
// share of another's, computed in code. Jason's challenge question (a Siren
// conversation, 2026-11-13): "What proportion of Ghent's housing is on Graydon
// between Colley and Colonial?" (docs/gis-skills.md).
//
// Homes come from the FY27 assessment roll. Most classes count exactly (a
// duplex 2, each condominium unit its own row). Apartment buildings come only
// as bands, so their units are estimated from the 2020 Census block counts
// (gis.js homesByParcel), and the answer says which part is estimated. Jason
// asked for per-building counts (2026-11-14); the City publishes none, so this
// estimate is the closest the open records allow. On 2026-11-14, against 43
// apartment buildings whose units a City assessment layer records, its median
// error was 17% (band midpoints: 33%).
//
// Refuses fewer than 5 residential parcels (that would describe households)
// and areas over 4,000 parcels (more than one answer's request budget).

import { definePlugin } from '../src/plugins.js';
import {
  AREA_KINDS, OPEN_DATA, BLOCKS, MIN_PARCELS, REACH_M,
  areaShapes, resolveSegment, censusBlocks, parcelsIn, rollGroups, homesByParcel, tally, touchingParcels,
  centroid, inside, unionBox, padBox, blockIndex, within,
} from './gis.js';

const PLACE = {
  type: 'object',
  description: 'Either areas (one or more, counted together; names as area_lookup returns them) or a street with two cross streets.',
  properties: {
    areas: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: Object.keys(AREA_KINDS) }, name: { type: 'string' } },
        required: ['kind', 'name'], additionalProperties: false,
      },
    },
    street: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  },
  additionalProperties: false,
};

const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : null);

async function resolve(ctx, place) {
  if (place?.areas?.length) {
    const shapes = await areaShapes(ctx, place.areas);
    return { type: 'areas', shapes, box: unionBox(shapes.map((s) => s.box)), what: shapes.map((s) => `${s.name} (${s.label})`).join(' + ') };
  }
  if (place?.street && place?.from && place?.to) {
    const found = await resolveSegment(ctx, place);
    if (found.error) throw new Error(found.error);
    const s = found.segment;
    const blocks = s.blocks.map((b) => b.block);
    return { type: 'segment', segment: s, box: padBox(s.box, 0.0003), what: `${s.street} between ${place.from} and ${place.to} (the ${blocks.join(', ')} blocks${s.addresses ? `, addresses ${s.addresses}` : ''})` };
  }
  throw new Error('Give a place as areas (from area_lookup) or as a street with two cross streets.');
}

export default definePlugin({
  name: 'housing_count',
  cities: ['norfolk'],
  description:
    "Count the homes in an area (civic leagues, planning districts, wards, ZIP codes: one or several counted together) or along a street between two cross streets (the parcels touching it, corner buildings included), and with `of` that place's share of another's homes, computed in code. Returns residential parcels, homes (exact for houses, duplexes to fourplexes and condo units; estimated for apartment buildings from the 2020 Census), homes by kind, and for areas the 2020 Census count. Find area names with area_lookup first.",
  parameters: {
    type: 'object',
    properties: {
      place: PLACE,
      of: { ...PLACE, description: 'Optional: the larger place to give `place` as a share of, e.g. Ghent for a street in it.' },
    },
    required: ['place'],
    additionalProperties: false,
  },

  async run(ctx, { place, of }) {
    let target;
    let whole;
    try {
      target = await resolve(ctx, place);
      whole = of ? await resolve(ctx, of) : null;
    } catch (err) {
      return { error: String(err.message || err) };
    }
    const core = unionBox([target.box, ...(whole ? [whole.box] : [])]);
    const members = (p, parcels) => {
      if (p.type === 'segment') return new Set(touchingParcels(parcels, p.segment));
      const out = new Set();
      for (const [g, rings] of parcels) {
        const c = centroid(rings);
        if (p.shapes.some((s) => inside(c, s.rings))) out.add(g);
      }
      return out;
    };
    let blocks;
    let parcels;
    let mine;
    let theirs;
    try {
      blocks = await censusBlocks(ctx, core);
      parcels = await parcelsIn(ctx, core);
      mine = members(target, parcels);
      theirs = whole ? members(whole, parcels) : null;
      // Only the blocks that hold a parcel of either place matter, and each of
      // those needs all of its parcels, so a block reaching past the box widens it.
      const wanted = new Set([...mine, ...(theirs || [])]);
      const of = blockIndex(parcels, blocks);
      const used = new Set([...wanted].map((g) => of.get(g)).filter(Boolean));
      blocks = blocks.filter((b) => used.has(b.geoid));
      const reach = blocks.length ? unionBox(blocks.map((b) => b.box)) : core;
      if (!within(reach, core)) parcels = await parcelsIn(ctx, unionBox([core, reach]));
      const keep = blockIndex(parcels, blocks);
      parcels = new Map([...parcels].filter(([g]) => wanted.has(g) || keep.has(g)));
    } catch (err) {
      return { error: String(err.message || err) };
    }
    const groups = await rollGroups(ctx, parcels.keys());
    const { byParcel, notes } = homesByParcel(parcels, blocks, groups);

    const census = (p) => (p.type === 'areas' ? blocks.filter((b) => p.shapes.some((s) => inside(b.point, s.rings))).reduce((n, b) => n + b.hu, 0) : null);

    const outside = theirs ? [...mine].filter((g) => byParcel.has(g) && !theirs.has(g)).length : 0;
    if (theirs) mine = new Set([...mine].filter((g) => theirs.has(g)));
    const t = tally(byParcel, mine);
    if (t.residential_parcels < MIN_PARCELS) {
      return { error: `${target.what} holds fewer than ${MIN_PARCELS} residential parcels${whole ? ` inside ${whole.what}` : ''}, too few to count without describing single households.` };
    }
    const describe = (p, s) => ({
      what: p.what,
      ...s,
      ...(p.type === 'segment'
        ? (() => {
          const on = [...(p === target ? mine : theirs)].filter((g) => byParcel.get(g)?.streets.has(p.segment.streetKey)).length;
          return { addressed_on_this_street: on, addressed_on_cross_streets_or_others: s.residential_parcels - on };
        })()
        : { census_2020_housing_units: census(p) }),
    });

    ctx.resources.addLink({ title: "City of Norfolk open-data map services: parcels, street centerlines, civic leagues (gisshare.norfolk.gov)", url: OPEN_DATA });
    ctx.resources.addLink({ title: 'Census Bureau TIGERweb: 2020 Census blocks with housing-unit counts', url: BLOCKS });

    const w = whole ? tally(byParcel, theirs) : null;
    return {
      place: describe(target, t),
      ...(whole
        ? {
          of: describe(whole, w),
          share: { of_residential_parcels: pct(t.residential_parcels, w.residential_parcels), of_homes: pct(t.homes, w.homes) },
          ...(outside ? { parcels_outside_of: `${outside} residential parcels of ${target.what} lie outside ${whole.what} and aren't counted in the share.` } : {}),
        }
        : {}),
      how_homes_were_counted: {
        exact: 'Single-family houses, duplexes, triplexes, fourplexes and each condominium unit, from the FY27 assessment roll.',
        estimated: "Apartment buildings: the roll gives only bands (5-11, 12-48, 49+ units), so each block's 2020 Census housing count, less the homes the roll counts exactly, is shared among the block's apartment buildings by building area, within each building's band. Buildings put up after 2020 count at their band's floor.",
        apartment_buildings: notes,
        accuracy: 'On 2026-11-14, against 43 apartment buildings whose units a City assessment layer records, the estimate was off by 17% at the median (band midpoints: 33%). Per-building counts exist in the City assessor\'s records but aren\'t in the open data.',
      },
      about_the_data: [
        membershipNote(target),
        'Homes are the assessment roll\'s residential classes; a building used otherwise, or vacant, isn\'t counted. The 2020 Census count is for comparison: blocks don\'t follow street frontage, and building since 2020 isn\'t in it.',
        "These are the City's open-data map layers and assessment records, not surveys.",
      ].filter(Boolean),
    };
  },
});

function membershipNote(target) {
  return target.type === 'segment'
    ? `A parcel is on the street when its shape comes within ${REACH_M} m of the street's centerline and it isn't past either cross street, so corner buildings addressed on a cross street count.`
    : 'A parcel is in an area when the center of its lot is.';
}
