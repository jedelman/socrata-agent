// Plugin conformance: what a plugin must do before it is merged upstream.
//
//   import { checkPlugin } from '../test/conformance.js';
//   await checkPlugin(myPlugin, { city: getCity('norfolk'), args: {...}, respond: (url) => fakeBody });
//
// It runs the plugin against a fake network and fails if:
//   - the plugin reaches the network through anything but its context (raw fetch),
//   - any request it made is missing from the trace,
//   - a Socrata dataset it queried is missing from the resources list,
//   - its result can't be serialized for the model.

import assert from 'node:assert/strict';
import { createContext } from '../src/agent.js';
import { definePlugin, pluginContext } from '../src/plugins.js';

export async function checkPlugin(plugin, { city, args, respond }) {
  const p = definePlugin(plugin);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    const body = await respond(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
  const ctx = createContext({ city, fetchImpl, plugins: [p] });

  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error(`Plugin ${p.name} called fetch directly; use ctx.http or ctx.socrata so the request is traced.`);
  };
  let result;
  try {
    result = await p.run(pluginContext(ctx), args);
  } finally {
    globalThis.fetch = realFetch;
  }

  const traced = new Set(ctx.trace.steps.map((s) => s.url));
  for (const url of requests) assert.ok(traced.has(url), `Request not in trace: ${url}`);
  const socrataIds = new Set(
    requests.map((u) => u.match(/\/resource\/([a-z0-9]{4}-[a-z0-9]{4})\.json/)?.[1]).filter(Boolean)
  );
  const registered = new Set(ctx.resources.toJSON().datasets.map((d) => d.id));
  for (const id of socrataIds) assert.ok(registered.has(id), `Dataset ${id} queried but not in resources`);
  assert.doesNotThrow(() => JSON.stringify(result), 'Plugin result must be JSON-serializable');
  return { result, trace: ctx.trace.toJSON(), resources: ctx.resources.toJSON(), requests };
}
