// trees_on_my_block: the City's trees near an address, and what the City
// does to them: pruning, removal, stump grinding, planting. On the street, in
// the civic league, and citywide for comparison. Sources checked live on
// 2026-11-04:
//   - City Tree Inventory (cmvv-agyb): 94,357 city-managed trees. The
//     inventory's own description: "The original inventory of these trees was
//     conducted in the late 1990s/early 2000s by the Norfolk Master Gardeners.
//     No official re-inventory has been conducted since then by City officials
//     or ISA Certified Arborists, however, tree records in this dataset have
//     been and are being updated over time by City Staff." It records no tree
//     condition, and 66,204 trees have no trunk-size range.
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
        ctx.socrata.query('cmvv-agyb', `SELECT trunk_diameter_range AS r, count(*) AS n WHERE ${circle} AND ${CITY_TREE} GROUP BY r LIMIT 20`, { tool: `trunk sizes within ${NEAR_M} m`, name: 'City Tree Inventory' }),
      ]);
      const total = species.reduce((s, r) => s + num(r.n), 0);
      return {
        within_m: NEAR_M,
        city_trees: total,
        species: species.slice(0, 8).map((r) => ({ name: r.common_name || '(not recorded)', count: num(r.n) })),
        trunk_size: sizes.filter((r) => r.r).map((r) => ({ range: r.r, count: num(r.n) })),
        no_size_recorded: num(sizes.find((r) => !r.r)?.n),
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
        "The inventory's own description says it was first taken in the late 1990s/early 2000s by the Norfolk Master Gardeners and that no official re-inventory has been done since by City officials or ISA Certified Arborists, though City staff update records over time. It records no tree condition, and most trees have no trunk size recorded.",
        'Work orders are what city crews logged. One work order can cover more than one tree, and work done under separate contracts may not appear here.',
        'The pruning-pace figure divides inventoried trees by pruning work orders per year. It is a pace, not a schedule: if one work order covered several trees, the real cycle is shorter.',
        'Reasons ("problem") are the City\'s own codes; "General Maintenance" is the City\'s label, not an explanation.',
        'Stump grinding usually follows a removal, so it is counted separately, not added to removals.',
        'Inventory rows labeled "PRIVATE TREES" are left out of every count. About 42% of the inventoried trees are crape myrtles, small ornamentals with different pruning needs from large shade trees.',
      ],
    };
  },
});
