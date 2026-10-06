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
// test/conformance.js checks a plugin against fakes before it is upstreamed.

import { lookupAddress } from './block.js';

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

export function pluginContext(ctx) {
  return Object.freeze({
    city: ctx.city,
    socrata: ctx.socrata,
    resources: ctx.resources,
    http: ctx.http,
    lookupAddress: (address) => lookupAddress(ctx, address),
    // Record a step that didn't hit the network, such as reading a prebuilt
    // file, so the trace still shows where an answer came from.
    cite: ({ tool, url, rows = null, note }) =>
      ctx.trace.record({ tool, url, ...(note ? { soql: note } : {}) }, async () => ({ result: null, rows })),
  });
}

// Apply a deployment config to a city profile: extra contacts and links, and
// the operator's notes for the prompt. Config can add; it can't remove the
// city's exclusions.
export function applyConfig(city, config = {}) {
  return {
    ...city,
    contacts: [...(city.contacts || []), ...(config.contacts || [])],
    links: [...(city.links || []), ...(config.links || [])],
    excluded: [...(city.excluded || []), ...(config.excluded || [])],
    excludedNamePatterns: [...(city.excludedNamePatterns || []), ...(config.excludedNamePatterns || [])],
    deploymentNotes: config.prompt || city.deploymentNotes,
    deploymentName: config.name || city.deploymentName,
  };
}
