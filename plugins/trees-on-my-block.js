// trees_on_my_block: the City's trees near an address, and what the City
// does to them: pruning, removal, stump grinding, planting. On the street, in
// the civic league, and citywide for comparison. Sources checked live on
// 2026-11-04 (tree counts re-checked live 2026-11-06):
//   - City Tree Inventory (cmvv-agyb): 94,361 rows, 93,997 of them not labeled
//     "PRIVATE TREES". The inventory's own description: "The original
//     inventory of these trees was conducted in the late 1990s/early 2000s by
//     the Norfolk Master Gardeners. No official re-inventory has been
//     conducted since then by City officials or ISA Certified Arborists,
//     however, tree records in this dataset have been and are being updated
//     over time by City Staff." It records no tree condition. Trunk size sits
//     in two columns: trunk_diameter_range (text, e.g. '6" to 12"') and
//     trunk_diameter (a number; its description gives no unit and says "Since
//     trees grow over time, the current diameter may be larger than what data
//     shows."). Checked live 2026-11-06, of the 93,997 city trees: 65,858 have
//     no range; 25,174 have no diameter and 4,080 a diameter of 0 or less
//     (29,254 with none above zero); 6,918 (7%) have neither a range nor a
//     diameter above zero. A diameter of 0 or less is reported as unrecorded;
//     the data doesn't say why it was entered that way.
//   - Work Orders (qzfe-wj25), area 'Forestry', from 2020-08-05: city crews'
//     work orders with task, reason ("problem") and cost. Inventory and work
//     orders spell civic leagues the same way; Address Information doesn't.

import { definePlugin } from '../src/plugins.js';
import { soqlString } from '../src/socrata.js';
import { leagueKey } from './water-on-my-block.js';
import { theRecord } from './cases.js';
import treesCase from '../data/cases/norfolk-trees.json' with { type: 'json' };

export const NEAR_M = 100;
// 364 inventory rows are labeled "PRIVATE TREES" (2026-11-04). They aren't
// the City's to prune or remove, so they're left out of every count.
const CITY_TREE = "(common_name IS NULL OR common_name != 'PRIVATE TREES')";
const TASKS = ['Pruning', 'Tree Maintenance', 'Removal', 'Stump Grinding', 'Plantings'];
const TASK_LIST = TASKS.map(soqlString).join(', ');

const settle = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: String(err?.message || err) };
  }
};
const num = (x) => Number(x || 0);
const usd = (x) => Math.round(num(x));

/** Work orders per task, plus the ratios a reader needs. */
export function summarize(rows, { trees = null, years = null } = {}) {
  const by = Object.fromEntries(TASKS.map((t) => [t, { work_orders: 0, cost_usd: 0 }]));
  for (const r of rows) if (by[r.t]) by[r.t] = { work_orders: num(r.n), cost_usd: usd(r.cost) };
  const removals = by.Removal.work_orders;
  const plantings = by.Plantings.work_orders;
  const pruning = by.Pruning.work_orders;
  const takingOut = by.Removal.cost_usd + by['Stump Grinding'].cost_usd;
  const out = {
    by_task: by,
    removals_per_planting: plantings ? Math.round((removals / plantings) * 10) / 10 : null,
    spent_removing_vs_pruning: by.Pruning.cost_usd ? Math.round((takingOut / by.Pruning.cost_usd) * 10) / 10 : null,
  };
  if (trees != null) out.city_trees_in_inventory = trees;
  if (trees && years && pruning) {
    out.pruning_work_orders_per_year = Math.round(pruning / years);
    out.years_to_prune_every_tree_once_at_this_pace = Math.round(trees / (pruning / years));
  }
  return out;
}

const rangeStart = (r) => Number(String(r).match(/\d+/)?.[0] ?? Infinity);

/**
 * Trunk sizes from rows of { r: trunk_diameter_range, d: trunk_diameter, n }.
 * A diameter that is empty, 0 or less counts as unrecorded. A tree has no size
 * recorded only when it has neither a range nor a diameter above zero.
 */
export function trunkSizes(rows) {
  const ranges = new Map();
  const diameters = [];
  let noDiameter = 0;
  let noSize = 0;
  for (const row of rows) {
    const n = num(row.n);
    const d = row.d == null || row.d === '' ? NaN : Number(row.d);
    const hasD = Number.isFinite(d) && d > 0;
    if (row.r) ranges.set(row.r, (ranges.get(row.r) || 0) + n);
    if (hasD) diameters.push([d, n]);
    else noDiameter += n;
    if (!row.r && !hasD) noSize += n;
  }
  diameters.sort((x, y) => x[0] - y[0]);
  const count = diameters.reduce((s, [, n]) => s + n, 0);
  const at = (i) => {
    let seen = 0;
    for (const [d, n] of diameters) if ((seen += n) > i) return d;
    return null;
  };
  return {
    trunk_diameter_range: [...ranges].sort((x, y) => rangeStart(x[0]) - rangeStart(y[0])).map(([range, c]) => ({ range, count: c })),
    trunk_diameter: count
      ? { trees: count, min: diameters[0][0], median: (at(Math.floor((count - 1) / 2)) + at(Math.floor(count / 2))) / 2, max: diameters[diameters.length - 1][0] }
      : null,
    no_diameter_recorded: noDiameter,
    no_size_recorded: noSize,
  };
}

// Pick the inventory's or work orders' spelling of the address's civic league.
function matchLeague(rows, name) {
  if (!name) return null;
  const want = leagueKey(name);
  return rows.find((r) => r.civic_league && leagueKey(r.civic_league) === want)?.civic_league || null;
}

export default definePlugin({
  name: 'trees_on_my_block',
  cities: ['norfolk'],
  description:
    "The City's trees near an address (species, size where recorded) and what the City does to them: Forestry work orders for pruning, removal, stump grinding and planting, with reasons and costs, on the street, in the civic league and citywide. Includes removals per planting, how many years the recorded pruning pace would take to reach every inventoried tree once, and the_record: verified findings from the City's budgets, a draft City Auditor report and other sources on whether Norfolk maintains its trees, with what would help and which records to request. Use for questions about street trees, tree removal, pruning, planting or the urban canopy at an address or in a neighborhood.",
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

    // The span of the work-order record, so "per year" means something.
    const spanP = ctx.socrata.query('qzfe-wj25', "SELECT min(created_datetime) AS first, max(created_datetime) AS last WHERE area = 'Forestry' LIMIT 1", {
      tool: 'forestry work orders: dates covered',
      name: 'Work Orders',
    });

    const near = settle(async () => {
      if (!circle) return { error: 'No parcel coordinates in the address record.' };
      const [species, sizes] = await Promise.all([
        ctx.socrata.query('cmvv-agyb', `SELECT common_name, count(*) AS n WHERE ${circle} AND ${CITY_TREE} GROUP BY common_name ORDER BY n DESC LIMIT 100`, { tool: `city trees within ${NEAR_M} m`, name: 'City Tree Inventory' }),
        ctx.socrata.query('cmvv-agyb', `SELECT trunk_diameter_range AS r, trunk_diameter AS d, count(*) AS n WHERE ${circle} AND ${CITY_TREE} GROUP BY r, d LIMIT 1000`, { tool: `trunk sizes within ${NEAR_M} m`, name: 'City Tree Inventory' }),
      ]);
      const total = species.reduce((s, r) => s + num(r.n), 0);
      return {
        within_m: NEAR_M,
        city_trees: total,
        species: species.slice(0, 8).map((r) => ({ name: r.common_name || '(not recorded)', count: num(r.n) })),
        ...trunkSizes(sizes),
      };
    });

    const street = settle(async () => {
      if (!a.street_name || !Number.isFinite(ward)) return { error: 'The address record has no street name or ward.' };
      const where = `area = 'Forestry' AND street = ${soqlString(a.street_name)} AND ward = ${ward}`;
      const [byTask, recent] = await Promise.all([
        ctx.socrata.query('qzfe-wj25', `SELECT primary_task_description AS t, problem_description AS p, count(*) AS n, sum(total_cost) AS cost WHERE ${where} GROUP BY t, p ORDER BY n DESC LIMIT 50`, {
          tool: 'forestry work on the street',
          name: 'Work Orders',
        }),
        ctx.socrata.query('qzfe-wj25', `SELECT work_order_number, primary_task_description, problem_description, status_description, created_datetime WHERE ${where} ORDER BY created_datetime DESC LIMIT 10`, {
          tool: 'latest forestry work on the street',
          name: 'Work Orders',
        }),
      ]);
      return {
        street: a.street_name,
        ward,
        by_task_and_reason: byTask.map((r) => ({ task: r.t, reason: r.p || '(not recorded)', work_orders: num(r.n), cost_usd: usd(r.cost) })),
        latest: recent.map((r) => ({
          work_order: r.work_order_number,
          task: r.primary_task_description,
          reason: r.problem_description,
          status: r.status_description,
          created: r.created_datetime?.slice(0, 10),
        })),
        matched_on: `work orders whose street is ${a.street_name} in ward ${ward}; the whole street in that ward, not only this block`,
      };
    });

    const [span, nearby, onStreet] = await Promise.all([spanP, near, street]);
    const first = span[0]?.first?.slice(0, 10);
    const last = span[0]?.last?.slice(0, 10);
    const years = first && last ? (Date.parse(last) - Date.parse(first)) / (365.25 * 864e5) : null;

    const league = await settle(async () => {
      if (!a.facts.civic_league) return { error: 'The address record names no civic league for this parcel.' };
      const [woLeagues, invLeagues] = await Promise.all([
        ctx.socrata.query('qzfe-wj25', `SELECT civic_league, count(*) AS n WHERE area = 'Forestry' AND ward = ${ward} GROUP BY civic_league LIMIT 200`, { tool: 'match civic league (work orders)', name: 'Work Orders' }),
        ctx.socrata.query('cmvv-agyb', `SELECT civic_league, count(*) AS n WHERE ward = ${ward} AND ${CITY_TREE} GROUP BY civic_league LIMIT 200`, { tool: 'match civic league (tree inventory)', name: 'City Tree Inventory' }),
      ]);
      const woName = matchLeague(woLeagues, a.facts.civic_league);
      const invName = matchLeague(invLeagues, a.facts.civic_league);
      if (!woName) return { error: `I found no Forestry work orders under a civic league matching "${a.facts.civic_league}" in ward ${ward}.` };
      const rows = await ctx.socrata.query('qzfe-wj25', `SELECT primary_task_description AS t, count(*) AS n, sum(total_cost) AS cost WHERE area = 'Forestry' AND civic_league = ${soqlString(woName)} AND primary_task_description in (${TASK_LIST}) GROUP BY t LIMIT 20`, {
        tool: 'forestry work in the civic league',
        name: 'Work Orders',
      });
      const trees = invName ? num(invLeagues.find((r) => r.civic_league === invName)?.n) : null;
      return { civic_league_matched: woName, ...summarize(rows, { trees, years }) };
    });

    const city = await settle(async () => {
      const [rows, inv] = await Promise.all([
        ctx.socrata.query('qzfe-wj25', `SELECT primary_task_description AS t, count(*) AS n, sum(total_cost) AS cost WHERE area = 'Forestry' AND primary_task_description in (${TASK_LIST}) GROUP BY t LIMIT 20`, {
          tool: 'forestry work citywide',
          name: 'Work Orders',
        }),
        ctx.socrata.query('cmvv-agyb', `SELECT count(*) AS n WHERE ${CITY_TREE} LIMIT 1`, { tool: 'city trees in the inventory', name: 'City Tree Inventory' }),
      ]);
      return summarize(rows, { trees: num(inv[0]?.n), years });
    });

    return {
      address: a.address,
      near_you: nearby,
      on_your_street: onStreet,
      civic_league: league,
      citywide: city,
      the_record: theRecord(ctx, treesCase),
      work_orders_cover: first ? { from: first, to: last, years: Math.round(years * 10) / 10 } : null,
      about_the_data: [
        "The inventory's own description says it was first taken in the late 1990s/early 2000s by the Norfolk Master Gardeners and that no official re-inventory has been done since by City officials or ISA Certified Arborists, though City staff update records over time. It records no tree condition.",
        // Checked live 2026-11-06 against cmvv-agyb (city trees only); see the header.
        'Trunk size is in two inventory columns, a range and a number (trunk_diameter). The number\'s description gives no unit and says "Since trees grow over time, the current diameter may be larger than what data shows." A diameter that is empty, 0 or less is counted as unrecorded. When checked on 2026-11-06, of 93,997 city trees, 65,858 had no range, 29,254 had no diameter above zero, and 6,918 (7%) had neither.',
        // Checked live 2026-11-06: qzfe-wj25 has 32 columns, none naming a contract or invoice (contractor_cost is a cost
        // column); of 2,378 Forestry removal work orders with status_code 999 ("Complete"), 563 have contractor_cost above zero.
        'Work orders are what City crews logged, and one work order can cover more than one tree. None of the 32 Work Orders columns links a work order to a contract or invoice. When checked on 2026-11-06, 563 of the 2,378 Forestry removal work orders marked "Complete" (24%) showed a contractor cost above zero.',
        'The pruning-pace figure divides inventoried trees by pruning work orders per year. It is a pace, not a schedule: if one work order covered several trees, the real cycle is shorter.',
        'Reasons ("problem") are the City\'s own codes; "General Maintenance" is the City\'s label, not an explanation.',
        'Stump grinding usually follows a removal, so it is counted separately, not added to removals.',
        'Inventory rows labeled "PRIVATE TREES" are left out of every count. About 42% of the inventoried trees are crape myrtles, small ornamentals with different pruning needs from large shade trees.',
      ],
    };
  },
});
