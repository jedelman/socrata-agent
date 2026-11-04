// litter_on_my_street: what litter the 2022 survey found near an address,
// how littered the nearest surveyed stretches were, and what the City spends
// picking litter up in the civic league. Sources checked live on 2026-11-04:
//   - Litter Study (Litterati) - Litter (iz5u-2wb3): 42,106 items recorded at
//     244 locations, 2022-04-01 to 2022-09-27, by Keep Norfolk Beautiful's
//     City Fingerprint Project. A one-time release. Its image column is
//     withheld by the city profile and never selected here.
//   - Litter Study (Litterati) - Litter Per Meter (fq5y-c2yn): objects per
//     meter walked at each location, spring, summer and fall 2022.
//   - Litter Index (nbz2-dgus): Keep America Beautiful's Community Appearance
//     Index, 60 routes scored 1 ("minimal to no litter") to 4 ("extremely
//     littered"), 2010-2019. Described as annual; no year after 2019.
//   - Work Orders (qzfe-wj25): litter and debris removal by city crews, with cost.

import { definePlugin } from '../src/plugins.js';
import { soqlString } from '../src/socrata.js';
import { leagueKey, km } from './water-on-my-block.js';

export const NEAR_M = 500;
const SEGMENT_KM = 1.5;
const CLEANUP_TASKS = ['Litter / Debris Removal', 'Debris Removal'];
const CLEANUP = `primary_task_description in (${CLEANUP_TASKS.map(soqlString).join(', ')}) AND area in ('Landscape', 'Streets')`;
const SEASONS = ['spring', 'summer', 'fall'];

const settle = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: String(err?.message || err) };
  }
};
const num = (x) => Number(x || 0);
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function median(xs) {
  const v = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Mean objects per meter over the seasons a location was walked.
export function perMeter(r) {
  const vals = SEASONS.map((s) => Number(r[`litter_per_meter_${s}_2022`])).filter(Number.isFinite);
  return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
}

export default definePlugin({
  name: 'litter_on_my_street',
  cities: ['norfolk'],
  description:
    "Litter near an address: what Keep Norfolk Beautiful's 2022 Litterati survey recorded within 500 m (object types, cigarette butts, drinks), how littered the nearest surveyed stretches were per meter against the citywide median, the ward's Litter Index scores 2010-2019, and city crews' litter and debris pickup work orders and cost in the civic league by year. Use for questions about litter, trash on the street, cleanups or what litter costs the City.",
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
    const hasPoint = Number.isFinite(a.lat) && Number.isFinite(a.lon);
    const circle = hasPoint ? `within_circle(latitude_longitude_point, ${a.lat}, ${a.lon}, ${NEAR_M})` : null;

    const survey = settle(async () => {
      if (!circle) return { error: 'No parcel coordinates in the address record.' };
      const [objects, categories] = await Promise.all([
        ctx.socrata.query('iz5u-2wb3', `SELECT object, count(*) AS n WHERE ${circle} GROUP BY object ORDER BY n DESC LIMIT 100`, { tool: `litter recorded within ${NEAR_M} m (2022)`, name: 'Litter Study (Litterati) - Litter' }),
        ctx.socrata.query('iz5u-2wb3', `SELECT category, count(*) AS n WHERE ${circle} GROUP BY category ORDER BY n DESC LIMIT 20`, { tool: `litter categories within ${NEAR_M} m (2022)`, name: 'Litter Study (Litterati) - Litter' }),
      ]);
      const total = objects.reduce((s, r) => s + num(r.n), 0);
      const share = (n) => (total ? Math.round((n / total) * 100) : null);
      return {
        within_m: NEAR_M,
        items_recorded: total,
        top_objects: objects.slice(0, 8).map((r) => ({ object: r.object || '(not recorded)', count: num(r.n) })),
        by_category: categories.map((r) => ({ category: r.category || '(not recorded)', count: num(r.n), percent: share(num(r.n)) })),
        survey_window: '2022-04-01 to 2022-09-27',
        ...(total ? {} : { note: `I found no items the survey recorded within ${NEAR_M} m. The survey walked 244 chosen locations, so this means no surveyed stretch here, not no litter.` }),
      };
    });

    const segments = settle(async () => {
      if (!hasPoint) return { error: 'No parcel coordinates in the address record.' };
      const rows = await ctx.socrata.query('fq5y-c2yn', 'SELECT location_name, latitude, longitude, litter_per_meter_spring_2022, litter_per_meter_summer_2022, litter_per_meter_fall_2022 LIMIT 500', {
        tool: 'litter per meter at every surveyed location (2022)',
        name: 'Litter Study (Litterati) - Litter Per Meter',
      });
      const all = rows.map((r) => ({ name: r.location_name, lat: Number(r.latitude), lon: Number(r.longitude), pm: perMeter(r) })).filter((r) => r.pm != null && Number.isFinite(r.lat));
      const cityMedian = median(all.map((r) => r.pm));
      const nearest = all
        .map((r) => ({ ...r, km: km(a, r) }))
        .filter((r) => r.km <= SEGMENT_KM)
        .sort((p, q) => p.km - q.km)
        .slice(0, 3);
      return {
        citywide_median_objects_per_meter: round(cityMedian),
        locations_surveyed: all.length,
        nearest_within_km: SEGMENT_KM,
        nearest: nearest.map((r) => ({
          location: r.name,
          distance_km: round(r.km, 1),
          objects_per_meter: round(r.pm),
          times_citywide_median: cityMedian ? round(r.pm / cityMedian, 1) : null,
        })),
        method: 'Objects per meter walked, averaged over the 2022 seasons each location was walked.',
      };
    });

    const index = settle(async () => {
      if (!Number.isFinite(ward)) return { error: 'The address record has no ward.' };
      const rows = await ctx.socrata.query('nbz2-dgus', `SELECT * WHERE starts_with(ward_route, ${soqlString(`Ward ${ward}-`)}) LIMIT 100`, {
        tool: `Litter Index routes in ward ${ward}`,
        name: 'Litter Index',
      });
      const years = [];
      for (let y = 2010; y <= 2019; y++) {
        const v = rows.map((r) => Number(r[`_${y}`])).filter(Number.isFinite);
        if (v.length) years.push({ year: y, routes: v.length, average_score: round(v.reduce((s, x) => s + x, 0) / v.length, 2) });
      }
      return {
        ward,
        scale: '1 = minimal to no litter, 4 = extremely littered (volunteer scans of fixed routes)',
        by_year: years,
        note: 'The dataset describes the index as annual, but its latest year is 2019.',
      };
    });

    // Cleanup work orders spell civic leagues differently from Address
    // Information, so match on a normalized name within the ward.
    const cleanup = settle(async () => {
      const [leagues, city] = await Promise.all([
        a.facts.civic_league && Number.isFinite(ward)
          ? ctx.socrata.query('qzfe-wj25', `SELECT civic_league, count(*) AS n WHERE ${CLEANUP} AND ward = ${ward} GROUP BY civic_league LIMIT 200`, { tool: 'match civic league (litter work orders)', name: 'Work Orders' })
          : [],
        ctx.socrata.query('qzfe-wj25', `SELECT date_extract_y(created_datetime) AS y, count(*) AS n, sum(total_cost) AS cost WHERE ${CLEANUP} GROUP BY y ORDER BY y LIMIT 20`, { tool: 'litter and debris pickup citywide, by year', name: 'Work Orders' }),
      ]);
      const want = leagueKey(a.facts.civic_league);
      const name = leagues.find((r) => r.civic_league && leagueKey(r.civic_league) === want)?.civic_league || null;
      const byYear = (rows) => rows.map((r) => ({ year: num(r.y), work_orders: num(r.n), cost_usd: Math.round(num(r.cost)) }));
      let league = null;
      if (name) {
        const rows = await ctx.socrata.query('qzfe-wj25', `SELECT date_extract_y(created_datetime) AS y, count(*) AS n, sum(total_cost) AS cost WHERE ${CLEANUP} AND civic_league = ${soqlString(name)} GROUP BY y ORDER BY y LIMIT 20`, {
          tool: 'litter and debris pickup in the civic league, by year',
          name: 'Work Orders',
        });
        league = { civic_league_matched: name, by_year: byYear(rows) };
      } else if (a.facts.civic_league) {
        league = { error: `I found no litter or debris work orders under a civic league matching "${a.facts.civic_league}" in ward ${ward}.` };
      }
      return {
        tasks_counted: CLEANUP_TASKS,
        civic_league: league,
        citywide_by_year: byYear(city),
        note: 'City crews\' litter and debris pickup in the Landscape and Streets areas. Stormwater debris clearing is left out because it mixes in leaves and storm debris. The current year is partial.',
      };
    });

    const [nearby, stretches, litterIndex, pickup] = await Promise.all([survey, segments, index, cleanup]);
    return {
      address: a.address,
      survey_near_you: nearby,
      nearest_surveyed_stretches: stretches,
      litter_index: litterIndex,
      cleanup_spending: pickup,
      about_the_data: [
        "The litter items come from one survey: Keep Norfolk Beautiful's 2022 Litterati City Fingerprint Project, which walked 244 chosen locations from April to September 2022. It is a baseline, not a census: places it didn't walk have no data.",
        'Brands were almost never recorded, so brand counts are not meaningful.',
        'Cleanup work orders are what city crews logged; cleanups by volunteers or contractors may not appear.',
      ],
    };
  },
});
