// sponge_site_screen: where rain gardens, bioswales and tree planting would do
// the most good in Norfolk. Reads the prebuilt screen (data/norfolk-sponge-screen.json,
// built by scripts/build-sponge-screen.js from several hundred traced queries)
// and cites it in the trace with its build date and query count.

import { definePlugin } from '../src/plugins.js';
import screen from '../data/norfolk-sponge-screen.json' with { type: 'json' };

const REPO = 'https://github.com/jedelman/socrata-agent/blob/main';
const KINDS = ['rain_garden', 'bioswale', 'tree'];

const site = (s) => ({
  location: s.location,
  gpin: s.gpin,
  civic_league: s.civic_league,
  acres: s.acres,
  owner: s.owner,
  score: s.score,
  need: s.need,
  map: `https://www.google.com/maps/search/?api=1&query=${s.lat.toFixed(6)},${s.lon.toFixed(6)}`,
  measures: {
    league_flood_work_orders_per_1k_addresses: s.league_flood_wo_per_1k_addresses,
    tract_rain_claims_per_1k_households: s.tract_rain_claims_per_1k_households,
    tract_median_income: s.tract_median_income,
    league_net_tree_loss_per_1k_addresses: s.league_net_tree_loss_per_1k_addresses,
    league_small_tree_share: s.league_small_tree_share,
  },
  feasibility: s.feasibility,
  verdict: s.verdict,
});

export default definePlugin({
  name: 'sponge_site_screen',
  cities: ['norfolk'],
  description:
    'Ranked places in Norfolk for rain gardens (city-owned vacant lots, checked for flood zone, storm surge, soils, nearby drains and existing BMPs), bioswales (streets with the most recorded blockage/flooding) and tree planting (city-owned vacant lots and streets losing trees). Use for "where should we put rain gardens / bioswales / trees" questions. A screen of where to look first, not a design.',
  parameters: {
    type: 'object',
    properties: {
      intervention: { type: 'string', enum: KINDS },
      civic_league: { type: 'string', description: 'Optional: limit to one civic league (partial name is fine).' },
      include_ruled_out: { type: 'boolean', description: 'Rain gardens only: also list high-need lots ruled out by flood zone or surge.' },
      limit: { type: 'integer', description: 'How many results, default 10, max 25.' },
    },
    required: ['intervention'],
    additionalProperties: false,
  },

  async run(ctx, { intervention, civic_league, include_ruled_out = false, limit = 10 }) {
    if (!KINDS.includes(intervention)) return { error: `intervention must be one of ${KINDS.join(', ')}` };
    const n = Math.min(Math.max(Number(limit) || 10, 1), 25);
    const want = civic_league ? String(civic_league).toLowerCase() : null;
    const inLeague = (s) => !want || String(s.civic_league || '').toLowerCase().includes(want);

    await ctx.cite({
      tool: 'read sponge-city screen',
      url: `${REPO}/data/norfolk-sponge-screen.json`,
      note: `built ${screen.built.slice(0, 10)} from ${screen.counts.queries} queries (each one is in the file's trace)`,
    });
    ctx.resources.addLink({ title: 'Sponge-city screen: report, method and caveats', url: `${REPO}/docs/sponge-screen-norfolk.md` });
    ctx.resources.addLink({ title: 'Sponge-city screen: full data and query trace (JSON)', url: `${REPO}/data/norfolk-sponge-screen.json` });
    ctx.resources.addLink({ title: 'City of Norfolk GIS open data (parcels, flood, stormwater layers)', url: 'https://gisshare.norfolk.gov/pubserver/rest/services/OpenData' });

    const base = {
      built_by: 'socrata-agent, from public City of Norfolk, FEMA and USDA data. This is not a City of Norfolk analysis or plan.',
      built: screen.built.slice(0, 10),
      counts: screen.counts,
      caveats: screen.caveats,
    };
    if (intervention === 'bioswale') {
      return { ...base, method: screen.method.bioswales, streets: screen.bioswale_streets.filter(inLeague).slice(0, n) };
    }
    if (intervention === 'tree') {
      return {
        ...base,
        method: { lots: screen.method.tree_need, streets: screen.method.tree_streets, score: screen.method.score },
        lots: screen.tree_sites.filter(inLeague).slice(0, n).map(site),
        streets_losing_trees: screen.tree_streets.filter(inLeague).slice(0, n),
      };
    }
    const all = screen.rain_gardens.filter(inLeague);
    return {
      ...base,
      method: { need: screen.method.rain_garden_need, score: screen.method.score, feasibility: screen.method.feasibility },
      checked: all.length,
      ruled_out_count: all.filter((s) => !s.verdict.ok).length,
      sites: all.filter((s) => s.verdict.ok).slice(0, n).map(site),
      ...(include_ruled_out ? { ruled_out: all.filter((s) => !s.verdict.ok).slice(0, n).map(site) } : {}),
    };
  },
});
