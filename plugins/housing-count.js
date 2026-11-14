// housing_count: how many homes an area or a street segment holds, and its
// share of another's, computed in code. Jason's challenge question (a Siren
// conversation, 2026-11-13): "What proportion of Ghent's housing is on Graydon
// between Colley and Colonial?" (docs/gis-skills.md).
//
// Homes come from the FY27 assessment roll, counted per property (an account:
// a house, a duplex, each condominium unit). Most classes count exactly.
// Apartment properties come only as bands, so their units are estimated from
// the 2020 Census block counts (gis.js homesByParcel), and the answer says
// which part is estimated. Jason asked for per-building counts (2026-11-14);
// the open roll has none, so this estimate is the closest the open records
// allow. scripts/check-unit-estimate.js measures it against the City's
// Submarkets layer, which records units for some apartment properties; its
// latest run is in eval/.
//
// Refuses fewer than 5 residential parcels (that would describe households),
// a box of more than 12,000 parcels before downloading it, and more than
// 8,000 parcels to count (past one answer's request budget).

import { definePlugin } from '../src/plugins.js';
import {
  AREA_KINDS, OPEN_DATA, BLOCKS, MIN_PARCELS, MAX_PARCELS, REACH_M, BANDED_UNITS,
  areaShapes, resolveSegment, censusBlocks, parcelsIn, rollGroups, homesByParcel, tally, touchingParcels,
  centroid, inside, unionBox, padBox, blockIndex, within, classCode,
} from './gis.js';

// Parcels outside the places counted only so their blocks' apartment estimates see every home.
const MAX_EXTRA = 4000;

// Measured by scripts/check-unit-estimate.js; the run is eval/unit-estimate-2026-11-14.json.
export const ACCURACY = "Checked on 2026-11-14 against 58 of the 650 apartment properties whose units the City's Submarkets assessment layers record (they cover part of the city): the estimate was off by 15% at the median, and within 20% for 38 of the 58; band midpoints were off by 33%. Summed over the 58 it ran 8% high. It is closer over a neighborhood than for any one property, and widest for the largest buildings. Per-property counts exist in the City assessor's records but aren't in the open data.";

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
const tooLarge = (n) => `That place holds more than ${n} parcels, more than one answer can count. A civic league or a planning district works; wards and most ZIP codes are too large.`;

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
    return { type: 'segment', segment: s, box: padBox(s.box, 0.001), what: `${s.street} between ${place.from} and ${place.to} (${blocks.length ? `the ${blocks.join(', ')} blocks` : 'unnumbered blocks'}${s.addresses ? `, addresses ${s.addresses}` : ''})` };
  }
  throw new Error('Give a place as areas (from area_lookup) or as a street with two cross streets.');
}

function members(p, parcels) {
  if (p.type === 'segment') return new Set(touchingParcels(parcels, p.segment));
  const out = new Set();
  for (const [g, rings] of parcels) {
    const c = centroid(rings);
    if (p.shapes.some((s) => inside(c, s.rings))) out.add(g);
  }
  return out;
}

export default definePlugin({
  name: 'housing_count',
  cities: ['norfolk'],
  description:
    "Count the homes in an area (civic leagues or planning districts, one or several counted together; wards and most ZIP codes are too large) or along a street between two cross streets (the parcels touching it, corner buildings included), and with `of` that place's share of another's homes, computed in code. Returns residential parcels, homes (exact for houses, duplexes to fourplexes and condo units; estimated for apartment properties from the 2020 Census), homes and properties by kind, and for areas the 2020 Census count. Find area names with area_lookup first.",
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
    let allBlocks;
    let parcels;
    let mine;
    let theirs;
    let wanted;
    try {
      target = await resolve(ctx, place);
      whole = of ? await resolve(ctx, of) : null;
      const core = unionBox([target.box, ...(whole ? [whole.box] : [])]);
      parcels = await parcelsIn(ctx, core);
      mine = members(target, parcels);
      theirs = whole ? members(whole, parcels) : null;
      const counted = theirs ? [...mine].filter((g) => theirs.has(g)).length : mine.size;
      if (counted < MIN_PARCELS) return { error: few(target, whole) };
      wanted = new Set([...mine, ...(theirs || [])]);
      if (wanted.size > MAX_PARCELS) throw new Error(tooLarge(MAX_PARCELS));
      allBlocks = await censusBlocks(ctx, core);
    } catch (err) {
      return { error: String(err.message || err) };
    }
    let groups = await rollGroups(ctx, wanted);

    // An apartment estimate needs every home in its census block, so the
    // parcels of blocks holding a counted apartment property are read too,
    // and only those.
    const banded = new Set(groups.filter((r) => classCode(r.property_class_description) in BANDED_UNITS).map((r) => String(r.gpin)));
    const apartments = new Map([...parcels].filter(([g]) => wanted.has(g) && banded.has(g)));
    const aptGeoids = new Set(blockIndex(apartments, allBlocks).values());
    const aptBlocks = allBlocks.filter((b) => aptGeoids.has(b.geoid));
    const extra = new Set();
    try {
      const core = unionBox([target.box, ...(whole ? [whole.box] : [])]);
      const reaching = aptBlocks.filter((b) => !within(b.box, core));
      if (reaching.length) {
        for (const [g, rings] of await parcelsIn(ctx, unionBox(reaching.map((b) => b.box)))) if (!parcels.has(g)) parcels.set(g, rings);
      }
      for (const g of blockIndex(parcels, aptBlocks).keys()) if (!wanted.has(g)) extra.add(g);
      if (extra.size > MAX_EXTRA) throw new Error(tooLarge(MAX_PARCELS));
    } catch (err) {
      return { error: String(err.message || err) };
    }
    if (extra.size) groups = groups.concat(await rollGroups(ctx, extra));
    const used = new Map([...parcels].filter(([g]) => wanted.has(g) || extra.has(g)));
    const { byParcel, notes } = homesByParcel(used, aptBlocks, groups);

    const census = (p) => (p.type === 'areas' ? allBlocks.filter((b) => p.shapes.some((s) => inside(b.point, s.rings))).reduce((n, b) => n + b.hu, 0) : null);
    const outside = theirs ? [...mine].filter((g) => byParcel.has(g) && !theirs.has(g)).length : 0;
    if (theirs) mine = new Set([...mine].filter((g) => theirs.has(g)));
    const t = tally(byParcel, mine);
    if (t.residential_parcels < MIN_PARCELS) return { error: few(target, whole, 'residential ') };
    const describe = (p, set, s) => ({
      what: p.what,
      ...s,
      ...(p.type === 'segment'
        ? (() => {
          const on = [...set].filter((g) => byParcel.get(g)?.streets.has(p.segment.streetTag)).length;
          return { residential_addressed_on_this_street: on, residential_addressed_on_cross_streets_or_others: s.residential_parcels - on };
        })()
        : { census_2020_housing_units: census(p) }),
    });

    ctx.resources.addLink({ title: 'City of Norfolk open-data map services: parcels, street centerlines, civic leagues (gisshare.norfolk.gov)', url: OPEN_DATA });
    ctx.resources.addLink({ title: 'Census Bureau TIGERweb: 2020 Census blocks with housing-unit counts', url: BLOCKS });

    const w = whole ? tally(byParcel, theirs) : null;
    return {
      place: describe(target, mine, t),
      ...(whole
        ? {
          of: describe(whole, theirs, w),
          share: { of_residential_parcels: pct(t.residential_parcels, w.residential_parcels), of_homes: pct(t.homes, w.homes) },
          ...(outside ? { parcels_outside_of: `${outside} residential parcels of ${target.what} lie outside ${whole.what} and aren't counted in the share.` } : {}),
        }
        : {}),
      how_homes_were_counted: {
        exact: 'Per property in the FY27 assessment roll: single-family houses 1, a house with an extra unit 2, duplexes 2, triplexes 3, fourplexes 4, and each condominium unit (its own property) 1.',
        estimated: "Apartment properties: the roll gives only bands (5-11, 12-48, 49+ units), so each census block's 2020 housing count, less the homes the roll counts exactly there, is shared among the block's apartment properties by building area, within each property's band. Mobile home parks, cooperatives and shops with apartments over are estimated the same way. A property built after 2020, or in no census block, counts at its band's floor.",
        apartment_properties: notes,
        accuracy: ACCURACY,
      },
      about_the_data: [
        membershipNote(target),
        "Homes are the assessment roll's residential classes; a building used otherwise, or vacant, isn't counted. The 2020 Census count is for comparison: blocks don't follow street frontage, and building since 2020 isn't in it.",
        "These are the City's open-data map layers and assessment records, not surveys.",
      ],
    };
  },
});

function few(target, whole, kind = '') {
  return `${target.what} holds fewer than ${MIN_PARCELS} ${kind}parcels${whole ? ` inside ${whole.what}` : ''}, too few to count without describing single households.`;
}

function membershipNote(target) {
  return target.type === 'segment'
    ? `A parcel is on the street when its shape comes within ${REACH_M} m of a carriageway's centerline and the center of its lot isn't past either cross street, so corner buildings addressed on a cross street count.`
    : 'A parcel is in an area when the center of its lot is.';
}
