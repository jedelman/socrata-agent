// capital_projects: the projects in one of Norfolk's adopted Capital
// Improvement Plans, by ward or department, with each project's location as
// the City published it. One dataset per adopted plan, registered with its
// columns in the city profile's `budget.capitalPlans`; all checked live on
// data.norfolk.gov on 2026-11-06. On that day 41 of the
// FY2027 plan's 93 projects had no ward and 39 had no coordinates, so a ward
// filter never shows the whole plan; the result counts what it leaves out.
//
// The model supplies a plan year, a ward and a department name. The year must
// be a registered plan, the ward an integer the plan's own data uses, and the
// department a name the plan's own data returned (a traced query); only those
// values reach the fixed SoQL below.
//
// Amounts are labelled by what the plan's own columns say. FY2025 on give a
// five-year column and a first-year column. FY2024 gives one `amount` column
// whose description doesn't say which it is (its figures look like
// single-year amounts; see the profile comment), so it is
// reported as amount_usd, never as a five-year amount. FY2024 also splits a
// project into subproject lines, so it counts lines and distinct projects.

import { definePlugin } from '../src/plugins.js';
import { soqlString } from '../src/socrata.js';
import { matchName, fromDescription, fromColumn, fit, TOP } from './budget-for.js';

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};
const usd = (x) => Math.round(num(x));
const DESCRIPTION_CHARS = 200;
// The column summed for a plan: its five-year total, or (FY2024) its one amount column.
const amountColumn = (plan) => plan.total || plan.amount;
// A plan whose rows are subprojects of a master project (FY2024).
const hasSubprojects = (plan) => plan.project.length > 1;

const QUOTES = [
  'The inclusion of a project beyond the current budget does not guarantee it will be funded in the future.',
  'This dataset will not be updated, however, a new dataset will be created each fiscal year for the new CIP.',
  'Capital funding is limited to the cost of the project and may be expended over several fiscal years until the project is completed.',
];

/** Cut a description at a word boundary, marked so no one reads it as whole. */
export function shorten(s, n = DESCRIPTION_CHARS) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20)).trim()} …`;
}

// Words that say nothing about which project is meant.
const STOP = new Set(['the', 'and', 'for', 'of', 'a', 'an', 'in', 'at', 'to', 'on', 'with', 'project', 'projects', 'plan', 'cip', 'capital']);
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
export const MAX_PROJECTS = 5;
const PROJECT_DESCRIPTION_CHARS = 900;

/**
 * Projects whose names hold the words asked for, from the plan's own list of
 * names: those with every word first, then those with at least one, ranked by
 * how many they hold. A word that's in a quarter or more of the names (Improve,
 * Construct) can't match a project on its own. Returns the City's spellings
 * only, so nothing the model typed reaches the SoQL.
 */
export function matchProjects(query, names) {
  const want = [...new Set(words(query))];
  const list = [...new Set(names.filter((x) => typeof x === 'string' && x))];
  if (!want.length || !list.length) return { matches: [], words: want };
  const have = new Map(list.map((n) => [n, new Set(words(n))]));
  const df = new Map(want.map((w) => [w, list.filter((n) => have.get(n).has(w)).length]));
  const common = new Set(want.filter((w) => df.get(w) >= Math.max(3, list.length / 4)));
  // Rarer words count for more: "MacArthur Center" finds the MacArthur projects before every "... Center".
  const weight = (hit) => hit.reduce((a, w) => a + 1 / df.get(w), 0);
  const all = list
    .map((name) => ({ name, hit: want.filter((w) => have.get(name).has(w)) }))
    .filter(({ hit }) => hit.length === want.length || hit.some((w) => !common.has(w)))
    .sort((a, b) => (b.hit.length === want.length) - (a.hit.length === want.length) || weight(b.hit) - weight(a.hit) || a.name.localeCompare(b.name));
  return { matches: all.slice(0, MAX_PROJECTS), more: Math.max(0, all.length - MAX_PROJECTS), words: want };
}

export const SOQL = {
  projectNames: (plan) => `SELECT ${plan.project[0]} AS p, count(*) AS n GROUP BY ${plan.project[0]} ORDER BY ${plan.project[0]} LIMIT 500`,
  projectLines: (plan, names, s) =>
    `SELECT project_id, department, ${plan.project.join(', ')}, description, location, ward, latitude, longitude, ${amountColumn(plan)}${plan.firstYear ? `, ${plan.firstYear}` : ''} WHERE ${[`${plan.project[0]} IN (${names.map(soqlString).join(', ')})`, ...SOQL.filter(s)].join(' AND ')} ORDER BY ${plan.project[0]}, ${amountColumn(plan)} DESC, project_id LIMIT 60`,
  names: 'SELECT department AS d, ward AS w, count(*) AS n GROUP BY department, ward ORDER BY department, ward LIMIT 500',
  filter: ({ ward, department }) => [...(ward != null ? [`ward = ${Number(ward)}`] : []), ...(department ? [`department = ${soqlString(department)}`] : [])],
  sums: (plan) => `count(*) AS n${hasSubprojects(plan) ? ', count(distinct project_id) AS p' : ''}, sum(${amountColumn(plan)}) AS total${plan.firstYear ? `, sum(${plan.firstYear}) AS first` : ''}`,
  where: (f) => (f.length ? ` WHERE ${f.join(' AND ')}` : ''),
  totals: (plan, s) => `SELECT ${SOQL.sums(plan)}, sum(case(latitude IS NULL, 1, true, 0)) AS no_coords, sum(case(ward IS NULL, 1, true, 0)) AS no_ward${SOQL.where(SOQL.filter(s))} LIMIT 1`,
  by: (plan, s, col) => `SELECT ${col} AS k, ${SOQL.sums(plan)}${SOQL.where(SOQL.filter(s))} GROUP BY ${col} ORDER BY total DESC LIMIT 100`,
  projects: (plan, s, top) =>
    `SELECT project_id, department, ${plan.project.join(', ')}, description, location, ward, latitude, longitude, ${amountColumn(plan)}${plan.firstYear ? `, ${plan.firstYear}` : ''}${SOQL.where(SOQL.filter(s))} ORDER BY ${amountColumn(plan)} DESC, project_id LIMIT ${Number(top)}`,
};

export default definePlugin({
  name: 'capital_projects',
  cities: ['norfolk'],
  description:
    "Projects in one of Norfolk's adopted Capital Improvement Plans (the latest by default; the result lists the other plans registered): buildings, roads, water, sewer, stormwater, parks and other infrastructure, with each project's adopted amounts as the plan's own columns label them (five-year and first-year where the plan gives both), its department, ward and location as published. Filter by ward (an integer the plan uses) and/or department (matched against the plan's own names; on a miss it returns the closest). Gives totals by department and by ward, the largest projects, and how many projects have no ward or no location. With project (words from a project's name, such as \"MacArthur\" or \"Chrysler Hall\"), it looks the project up instead: every line of each matching project, across departments and funds, with its full description and the project's total. Use for questions about planned construction, a named project, capital spending in a ward, or a department's capital projects. For operating budgets use budget_for.",
  parameters: {
    type: 'object',
    properties: {
      plan_year: { type: 'integer', description: 'The adopted plan, by its first fiscal year, e.g. 2026. Leave out for the latest; the result lists the plans registered.' },
      ward: { type: 'integer', description: 'A City Council ward number, e.g. 2.' },
      department: { type: 'string', description: 'A department as the plan names it, e.g. "Public Works" or "Parks and Recreation".' },
      project: { type: 'string', description: 'Words from a project\'s name, e.g. "MacArthur" or "Chrysler Hall". Matched against the plan\'s own project names; the result says which words each match holds.' },
    },
    additionalProperties: false,
  },

  async run(ctx, args = {}) {
    const plans = [...ctx.city.budget.capitalPlans].sort((p, q) => q.year - p.year);
    const years = plans.map((p) => p.year);
    if (args.plan_year != null && !Number.isInteger(args.plan_year)) return { error: `plan_year must be a whole number: one of ${years.join(', ')}.` };
    const plan = args.plan_year == null ? plans[0] : plans.find((p) => p.year === args.plan_year);
    if (!plan) return { error: `I found no adopted Capital Improvement Plan for FY${args.plan_year} on the portal; the plans registered are ${years.map((y) => `FY${y}`).join(', ')}.` };
    if (args.ward != null && !Number.isInteger(args.ward)) return { error: 'ward must be a whole number, e.g. 2.' };
    if (args.department != null && (typeof args.department !== 'string' || args.department.length > 120)) return { error: 'department must be a name of at most 120 characters.' };
    if (args.project != null && (typeof args.project !== 'string' || args.project.length > 120)) return { error: 'project must be words of at most 120 characters.' };
    const opts = (tool) => ({ tool, name: plan.name });

    try {
      const meta = await ctx.socrata.describe(plan.id);
      const names = await ctx.socrata.query(plan.id, SOQL.names, opts(`CIP FY${plan.year}: departments and wards`));
      const wards = [...new Set(names.map((r) => r.w).filter((w) => w != null).map(Number))].sort((a, b) => a - b);
      const s = {};
      if (args.ward != null) {
        if (!wards.includes(args.ward)) return { error: `Ward ${args.ward} is not used in the FY${plan.year} plan; its projects carry wards ${wards.join(', ')} (or none).`, wards_in_plan: wards };
        s.ward = args.ward;
      }
      if (args.department?.trim()) {
        const m = matchName(args.department, names.map((r) => r.d));
        if (m.miss) return { error: `I found no department matching "${args.department}" in the FY${plan.year} plan.`, closest_departments: m.closest, hint: 'Ask again with one of these names.' };
        s.department = m.name;
      }

      if (args.project?.trim()) return await projectLookup(ctx, plan, plans, meta, s, args.project, opts);

      const [totals, byDept, byWard, top] = await Promise.all([
        ctx.socrata.query(plan.id, SOQL.totals(plan, s), opts(`CIP FY${plan.year}: totals`)),
        s.department ? null : ctx.socrata.query(plan.id, SOQL.by(plan, s, 'department'), opts(`CIP FY${plan.year}: by department`)),
        s.ward != null ? null : ctx.socrata.query(plan.id, SOQL.by(plan, s, 'ward'), opts(`CIP FY${plan.year}: by ward`)),
        ctx.socrata.query(plan.id, SOQL.projects(plan, s, TOP), opts(`CIP FY${plan.year}: largest projects`)),
      ]);

      const t = totals[0] || {};
      const firstKey = `FY${plan.year}_usd`;
      const sumCol = amountColumn(plan);
      const totalKey = plan.total ? `${plan.span}_usd` : `${sumCol}_usd`;
      const amounts = (r) => ({ [totalKey]: usd(r.total), ...(plan.firstYear ? { [firstKey]: usd(r.first) } : {}) });
      const col = (field) => (meta.columns || []).find((c) => c.field === field)?.about;
      const sub = hasSubprojects(plan);
      // In a plan with subprojects, a row is a project line, not a project.
      const counts = (r) => (sub ? { project_lines: num(r.n), projects: num(r.p) } : { projects: num(r.n) });
      const count = num(t.n);
      const noun = sub ? 'project lines' : 'projects';

      const build = (n) => {
        const groups = (rows, label) => {
          if (!rows) return undefined;
          const shown = rows.slice(0, n).map((r) => ({ [label]: r.k == null ? '(none recorded)' : label === 'ward' ? Number(r.k) : r.k, ...counts(r), ...amounts(r) }));
          return rows.length > n ? { rows: shown, and_more: `and ${rows.length - n} more` } : { rows: shown };
        };
        const projects = top.slice(0, n).map((r) => ({
          project_id: r.project_id ?? null,
          name: plan.project.map((f) => r[f]).filter(Boolean).join(': '),
          department: r.department,
          ...(plan.firstYear ? { [firstKey]: usd(r[plan.firstYear]) } : {}),
          [totalKey]: usd(r[sumCol]),
          ward: r.ward == null ? null : Number(r.ward),
          location: r.location || null,
          coordinates: r.latitude && r.longitude ? [Number(r.latitude), Number(r.longitude)] : null,
          description: shorten(r.description),
        }));
        const out = {
          plan: { fiscal_year: plan.year, covers: plan.span, dataset: meta.name, published_by: meta.department, rows_last_updated: meta.updated?.slice(0, 10) || null },
          filter: { ...(s.ward != null ? { ward: s.ward } : {}), ...(s.department ? { department: s.department } : {}), ...(args.department && s.department && args.department !== s.department ? { department_asked: args.department } : {}) },
          totals: { ...counts(t), ...amounts(t) },
          by_department: groups(byDept, 'department'),
          by_ward: groups(byWard, 'ward'),
          largest_projects: projects,
          ...(count > projects.length ? { [sub ? 'more_lines' : 'more_projects']: `and ${count - projects.length} more ${noun}` } : {}),
          about_the_data: [
            ...QUOTES.map((q) => fromDescription(meta, q)),
            ...(col(sumCol) ? [fromColumn(meta, sumCol, col(sumCol))] : []),
            ...(plan.firstYear && col(plan.firstYear) ? [fromColumn(meta, plan.firstYear, col(plan.firstYear))] : []),
            ...(plan.total ? [] : [`The FY${plan.year} plan's dataset has one amount column and no first-year column. The dataset doesn't say whether ${sumCol} is FY${plan.year}'s appropriation or the five-year total, so it is given as ${totalKey}.`]),
            ...(sub
              ? [`The FY${plan.year} plan splits some projects into subprojects, one line each: project_lines counts lines and projects counts distinct project ids. largest_projects ranks lines, so a project split into subprojects ranks by its largest line, not its total.`]
              : []),
            s.ward != null
              ? `This counts only ${noun} the plan assigns to ward ${s.ward}. Of the whole FY${plan.year} plan, ${names.filter((r) => r.w == null).reduce((a, r) => a + num(r.n), 0)} of ${names.reduce((a, r) => a + num(r.n), 0)} ${noun} have no ward, so a citywide or unlocated project that serves this ward is not in these numbers.`
              : `${num(t.no_ward)} of these ${count} ${noun} have no ward and ${num(t.no_coords)} have no coordinates.`,
            `Descriptions are shortened to about ${DESCRIPTION_CHARS} characters (marked …); the full text is on the dataset page and in the CSV.`,
            "The dataset doesn't name its funds (the fund column holds a number only), and doesn't say how much of a project has been spent; it records what was adopted, not what was built.",
            'Amounts are rounded to whole dollars.',
            `Other plans: ${plans.filter((p) => p !== plan).map((p) => `FY${p.year}`).join(', ')}. A project can appear in more than one plan, so don't add plans together.`,
          ],
        };
        return JSON.parse(JSON.stringify(out));
      };
      return fit(build);
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  },
});

// A named project: every line of each matching project (one per department or
// fund), the full description, and the project's total across its lines. The
// City splits one project across funds (MacArthur's redevelopment is a City
// Manager line, a Water Fund line and a Wastewater Fund line), so the largest-
// projects list alone shows only its biggest line.
async function projectLookup(ctx, plan, plans, meta, s, project, opts) {
  const names = await ctx.socrata.query(plan.id, SOQL.projectNames(plan), opts(`CIP FY${plan.year}: project names`));
  const m = matchProjects(project, names.map((r) => r.p));
  const firstKey = `FY${plan.year}_usd`;
  const sumCol = amountColumn(plan);
  const totalKey = plan.total ? `${plan.span}_usd` : `${sumCol}_usd`;
  const planInfo = { fiscal_year: plan.year, covers: plan.span, dataset: meta.name, published_by: meta.department, rows_last_updated: meta.updated?.slice(0, 10) || null };
  const others = `Other plans: ${plans.filter((p) => p !== plan).map((p) => `FY${p.year}`).join(', ')}. A project can appear in more than one plan, so don't add plans together.`;
  if (!m.matches.length) {
    return { plan: planInfo, project_asked: project, matches: [], note: `I found no project in the FY${plan.year} plan whose name holds ${m.words.length ? m.words.map((w) => `"${w}"`).join(' or ') : 'those words'}. Try other words from its name, or another plan year.`, about_the_data: [others] };
  }
  const rows = await ctx.socrata.query(plan.id, SOQL.projectLines(plan, m.matches.map((x) => x.name), s), opts(`CIP FY${plan.year}: lines of the matching projects`));
  const byName = new Map(m.matches.map((x) => [x.name, []]));
  for (const r of rows) byName.get(r[plan.project[0]])?.push(r);
  const projects = m.matches.map(({ name, hit }) => {
    const lines = byName.get(name) || [];
    return {
      name,
      matched_words: hit.length === m.words.length ? 'all' : `${hit.length} of ${m.words.length}: ${hit.join(', ')}`,
      total: { [totalKey]: lines.reduce((a, r) => a + usd(r[sumCol]), 0), ...(plan.firstYear ? { [firstKey]: lines.reduce((a, r) => a + usd(r[plan.firstYear]), 0) } : {}), lines: lines.length },
      lines: lines.map((r) => ({
        project_id: r.project_id ?? null,
        department: r.department,
        ...(plan.project.length > 1 ? { subproject: plan.project.slice(1).map((f) => r[f]).filter(Boolean).join(': ') || null } : {}),
        ...(plan.firstYear ? { [firstKey]: usd(r[plan.firstYear]) } : {}),
        [totalKey]: usd(r[sumCol]),
        ward: r.ward == null ? null : Number(r.ward),
        location: r.location || null,
        description: shorten(r.description, PROJECT_DESCRIPTION_CHARS),
      })),
    };
  });
  return JSON.parse(JSON.stringify({
    plan: planInfo,
    project_asked: project,
    ...(Object.keys(s).length ? { filter: s } : {}),
    matches: projects,
    ...(m.more ? { more_matches: `and ${m.more} more projects whose names hold some of these words; use more specific words to narrow it` } : {}),
    about_the_data: [
      ...QUOTES.map((q) => fromDescription(meta, q)),
      `A project's total adds up its lines in this plan (one per department or fund). Projects with every word asked for come first; matched_words says which words a looser match holds, so check the name and description before treating it as the project asked about.`,
      `Descriptions longer than about ${PROJECT_DESCRIPTION_CHARS} characters are shortened (marked …); the full text is on the dataset page and in the CSV.`,
      "The dataset doesn't name its funds (the fund column holds a number only), and doesn't say how much of a project has been spent; it records what was adopted, not what was built.",
      'Amounts are rounded to whole dollars.',
      others,
    ],
  }));
}
