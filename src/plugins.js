// Plugins and deployment config: how a group customizes the agent without
// forking the core.
//
// A plugin tool is { name, description, parameters, cities?, run(ctx, args) }.
// `run` gets a context with:
//   ctx.city, ctx.socrata (traced), ctx.resources, ctx.lookupAddress(address),
//   ctx.http.json(url, info) / ctx.http.text(url, info)  (traced),
//   ctx.cite({ tool, url, rows, note })  (a traced step with no request)
// It never gets a raw fetch. The voice check, dataset exclusions and the
// trace stay in core, so a plugin or a custom prompt can't turn them off.
// ctx.http refuses Socrata hosts and paths: Socrata reads go through
// ctx.socrata, under the dataset policy. ctx.resources takes links and
// records only; datasets are registered by ctx.socrata itself.
// test/conformance.js checks a plugin against fakes before it is upstreamed.
// It catches mistakes, not malice: a plugin is code, and review is the gate.

import { lookupAddress } from './block.js';
import { ACCESS } from './socrata.js';
import { deepFreeze } from './cities/index.js';

const NAME = /^[a-z][a-z0-9_]{2,48}$/;
export const USER_AGENT = 'socrata-agent (+https://github.com/jedelman/socrata-agent)';

export function definePlugin(p) {
  if (!p || typeof p !== 'object') throw new Error('A plugin must be an object.');
  if (!NAME.test(p.name || '')) throw new Error(`Plugin name "${p.name}" must be snake_case, 3–49 characters.`);
  if (!p.description) throw new Error(`Plugin ${p.name} needs a description.`);
  if (typeof p.run !== 'function') throw new Error(`Plugin ${p.name} needs a run(ctx, args) function.`);
  const parameters = p.parameters || { type: 'object', properties: {}, additionalProperties: false };
  return Object.freeze({ ...p, parameters });
}

export function pluginsFor(plugins = [], city) {
  return plugins.filter((p) => !p.cities || p.cities.includes(city.id));
}

export function pluginToolDefs(plugins, city) {
  return pluginsFor(plugins, city).map((p) => ({
    type: 'function',
    function: { name: p.name, description: p.description, parameters: p.parameters },
  }));
}

// Traced HTTP for plugins. Every call lands in the trace, success or failure.
export function tracedHttp(trace, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const get = async (url, info, parse) =>
    trace.record({ tool: info?.tool || 'plugin request', ...(info?.dataset ? { dataset: info.dataset } : {}), url }, async () => {
      if (!/^https:\/\//.test(url)) throw new Error('Plugins may only fetch https URLs.');
      // Some public servers (FEMA's flood maps among them) refuse requests with
      // no User-Agent, which is what Cloudflare Workers send by default.
      const init = { headers: { 'User-Agent': USER_AGENT, ...(info?.headers || {}) } };
      let res = await doFetch(url, init);
      // One retry on a server error: FEMA's map service times out now and then.
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, info?.retryDelayMs ?? 1000));
        res = await doFetch(url, init);
      }
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      const result = parse(body);
      return { result, rows: Array.isArray(result) ? result.length : null };
    });
  return {
    json: (url, info) => get(url, info, (b) => JSON.parse(b)),
    text: (url, info) => get(url, info, (b) => b),
  };
}

// Socrata hosts and API paths, on any host (portals can sit behind custom
// domains). A plugin that needs Socrata data uses ctx.socrata instead.
const SOCRATA_PATH = /^\/(resource|api\/(views|id|v3|catalog|odata|geospatial|migrations))(\/|$)/i;
function hostOf(url) {
  return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
}
export function guardPluginUrl(city, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const cityHosts = [city.domain, city.portal && hostOf(city.portal)].filter(Boolean).map((h) => h.toLowerCase());
  if (cityHosts.includes(host) || host === 'socrata.com' || host.endsWith('.socrata.com') || SOCRATA_PATH.test(u.pathname) || /\/rows\.(csv|json|xml)/i.test(u.pathname)) {
    throw new Error('Plugins read Socrata data through ctx.socrata, so the dataset rules apply; ctx.http refuses Socrata hosts and paths.');
  }
  return url;
}

export function pluginContext(ctx) {
  const city = ctx.city;
  const http = Object.freeze({
    json: async (url, info) => ctx.http.json(guardPluginUrl(city, url), info),
    text: async (url, info) => ctx.http.text(guardPluginUrl(city, url), info),
  });
  return Object.freeze({
    city: deepFreeze(city),
    // A plugin's dataset `name` is a display label only: the real name is
    // always looked up for the exclusion check.
    socrata: Object.freeze({
      // Plugins always run at plugin access: they can't raise it, or name a dataset.
      query: (id, soql, opts = {}) => ctx.socrata.query(id, soql, { tool: opts.tool, label: opts.name, access: ACCESS.PLUGIN }),
      describe: (id) => ctx.socrata.describe(id, { access: ACCESS.PLUGIN }),
      searchCatalog: (q, limit) => ctx.socrata.searchCatalog(q, limit),
    }),
    // Links and public records only. A link can't point at Socrata data (a
    // full-table CSV would undo a restricted dataset's aggregation), and
    // contacts come only from the address dataset or the city profile.
    resources: Object.freeze({
      addLink: (l) => ctx.resources.addLink({ ...l, url: guardPluginUrl(city, l.url) }),
      addRecord: (r) => ctx.resources.addRecord({ ...r, url: guardPluginUrl(city, r.url) }),
    }),
    http,
    lookupAddress: (address) => lookupAddress(ctx, address),
    // Record a step that didn't hit the network, such as reading a prebuilt
    // file, so the trace still shows where an answer came from.
    cite: ({ tool, url, rows = null, note }) =>
      ctx.trace.record({ tool, url, ...(note ? { soql: note } : {}) }, async () => ({ result: null, rows })),
  });
}

function toPattern(p) {
  if (p instanceof RegExp) return p;
  if (typeof p === 'string' && p) return new RegExp(p, 'i');
  throw new Error(`excludedNamePatterns entries must be RegExps or strings, not ${JSON.stringify(p)}.`);
}

// Apply a deployment config to a city profile: extra contacts and links, and
// the operator's notes for the prompt. Config can add policy (exclusions,
// restricted datasets, withheld columns, suppressed rows); it can't remove
// any. The result is a new, frozen profile.
export function applyConfig(city, config = {}) {
  const restricted = [...(city.restricted || [])];
  for (const r of config.restricted || []) if (!restricted.some((x) => x.id === r.id)) restricted.push({ ...r });
  const deniedColumns = { ...(city.deniedColumns || {}) };
  for (const [id, cols] of Object.entries(config.deniedColumns || {})) deniedColumns[id] = [...new Set([...(deniedColumns[id] || []), ...cols])];
  const suppressedRows = { ...(city.suppressedRows || {}) };
  for (const [id, pred] of Object.entries(config.suppressedRows || {})) suppressedRows[id] = suppressedRows[id] ? `(${suppressedRows[id]}) OR (${pred})` : pred;
  return deepFreeze({
    ...city,
    contacts: [...(city.contacts || []), ...(config.contacts || [])],
    links: [...(city.links || []), ...(config.links || [])],
    excluded: [...(city.excluded || []), ...(config.excluded || [])],
    excludedNamePatterns: [...(city.excludedNamePatterns || []), ...(config.excludedNamePatterns || []).map(toPattern)],
    restricted,
    deniedColumns,
    suppressedRows,
    deploymentNotes: config.prompt || city.deploymentNotes,
    deploymentName: config.name || city.deploymentName,
  });
}
