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
// checkPluginSource(source) reads the plugin's code and fails on the ways out
// a fake network can't see: importing core modules (a Socrata client built at
// core access), a fetch saved before the check runs, node: modules.
//
// Conformance catches mistakes, not malice. A plugin is code that runs with
// the agent's privileges, so human review is the real gate.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    requests.map((u) => u.match(/\/(?:resource|api\/views)\/([a-z0-9]{4}-[a-z0-9]{4})(?:[./?]|$)/)?.[1]).filter(Boolean)
  );
  const registered = new Set(ctx.resources.toJSON().datasets.map((d) => d.id));
  for (const id of socrataIds) assert.ok(registered.has(id), `Dataset ${id} queried but not in resources`);
  assert.doesNotThrow(() => JSON.stringify(result), 'Plugin result must be JSON-serializable');
  return { result, trace: ctx.trace.toJSON(), resources: ctx.resources.toJSON(), requests };
}

// What a plugin may import from core: the plugin API, the SoQL quoting helper,
// and the document readers (pure functions over a document the plugin holds).
const ALLOWED_CORE = { 'plugins.js': null, 'socrata.js': ['soqlString'], 'documents.js': ['searchSections', 'readSection', 'pageLink', 'findDepartment'] };

export function checkPluginSource(source, file = 'plugin') {
  const problems = [];
  for (const m of source.matchAll(/import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, what, from] = m;
    if (from.startsWith('node:')) problems.push(`imports ${from}`);
    const core = from.match(/(?:^|\/)src\/(.+)$/);
    if (!core) continue;
    if (!(core[1] in ALLOWED_CORE)) {
      problems.push(`imports core module src/${core[1]}`);
      continue;
    }
    const allowed = ALLOWED_CORE[core[1]];
    const names = (what.match(/\{([^}]*)\}/)?.[1] || '').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    if (allowed && (/^\s*\*|^\s*\w+\s*(,|$)/.test(what) || names.some((n) => !allowed.includes(n)))) problems.push(`imports more than ${allowed.join(', ')} from src/${core[1]}`);
  }
  for (const [re, what] of [
    [/\bfetch\b/, 'mentions fetch'],
    [/\bglobalThis\b/, 'uses globalThis'],
    [/\bXMLHttpRequest\b|\bWebSocket\b/, 'opens its own connection'],
    [/\bprocess\b/, 'uses process'],
    [/\bimport\s*\(|\brequire\s*\(/, 'imports dynamically'],
  ]) if (re.test(source)) problems.push(what);
  assert.deepEqual(problems, [], `${file}: ${problems.join('; ')}`);
}

export function checkPluginFile(path) {
  checkPluginSource(readFileSync(path, 'utf8'), path);
}
