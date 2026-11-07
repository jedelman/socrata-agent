#!/usr/bin/env node
// socrata-agent CLI. Bring your own OpenRouter key for `ask`; `tool` needs no
// key at all and is what the Claude Code skill drives.

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { cities, getCity } from '../src/cities/index.js';
import { ask, createContext, DEFAULT_MODEL, apiKeyFromEnv } from '../src/agent.js';
import { toolsFor, runTool } from '../src/tools.js';
import { applyConfig, definePlugin } from '../src/plugins.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// SUBREQUEST_BUDGET for `ask`: unset means no cap; anything set must be a
// whole number of at least 10 (the Worker's floor). A typo must never quietly
// mean unbounded, or a cap too small to leave room for the answer.
function cliSubrequestBudget(value) {
  if (value === undefined || value === '') return undefined;
  if (!/^\d+$/.test(value.trim()) || Number(value) < 10) {
    throw new Error(`SUBREQUEST_BUDGET must be a whole number of at least 10 (got "${value}"); unset it for no cap.`);
  }
  return Number(value);
}

const HELP = `socrata-agent: ask a city's open data what's on your block, and who decided it.

Usage
  socrata-agent ask "<question>" [--city norfolk] [--model ${DEFAULT_MODEL}] [--json]
  socrata-agent tool <name> '<json args>' [--city norfolk]
  socrata-agent tools [--city norfolk]
  socrata-agent cities

Options
  --city <id|domain>   norfolk (default), seattle, chicago, or any Socrata domain
  --config <file>      a deployment config (plugins, notes, contacts); see deployments/

Examples
  socrata-agent ask "What's going on at 111 Pennsylvania Ave?"
  socrata-agent tool block_report '{"address":"111 Pennsylvania Ave"}'
  socrata-agent tool get_legislation '{"legislation_id":"5832"}'
  socrata-agent tool query_dataset '{"dataset_id":"qzfe-wj25","soql":"SELECT area, count(*) AS n GROUP BY area ORDER BY n DESC"}' --city norfolk
  socrata-agent ask "Which neighborhoods have the most potholes reported this year?" --city chicago

Environment
  OPENROUTER_API_KEY   required for "ask" with OpenRouter models (https://openrouter.ai/keys)
  ANTHROPIC_API_KEY    required for "ask" with claude-* models, e.g. --model claude-haiku-5-5
                       (https://console.anthropic.com); --effort low|medium|high sets their effort
  SOCRATA_APP_TOKEN    optional; raises Socrata's rate limits
  SOCRATA_AGENT_MODEL  optional default model
  SUBREQUEST_BUDGET    optional cap on outbound requests per answer for "ask", 10 or more (default: none)
`;

async function loadIndexes(city) {
  if (!city.meetings?.index) return {};
  try {
    const raw = await readFile(new URL(`../data/${city.meetings.index}.json`, import.meta.url), 'utf8');
    return { [city.meetings.index]: JSON.parse(raw) };
  } catch {
    console.error(`warning: data/${city.meetings.index}.json not found; run scripts/build-norfolk-legislation.js`);
    return {};
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    city: { type: 'string' },
    config: { type: 'string' },
    model: { type: 'string' },
    effort: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

async function loadDeployment() {
  if (!values.config) return { city: getCity(values.city || 'norfolk'), plugins: [], model: undefined };
  const mod = await import(pathToFileURL(resolve(values.config)).href);
  const config = mod.default || {};
  const city = applyConfig(getCity(values.city || config.city || 'norfolk'), config);
  return { city, plugins: (config.plugins || []).map(definePlugin), model: config.model };
}

const [cmd, ...rest] = positionals;
if (!cmd || values.help) {
  console.log(HELP);
  process.exit(0);
}

try {
  if (cmd === 'cities') {
    for (const c of Object.values(cities)) {
      const level = c.address ? 'block report + legislation' : 'catalog, query, downloads';
      console.log(`${c.id.padEnd(10)} ${c.name.padEnd(14)} ${c.domain.padEnd(26)} ${level}`);
    }
    console.log('\nAny other Socrata domain also works in generic mode: --city data.example.gov');
  } else if (cmd === 'tools') {
    const { city, plugins } = await loadDeployment();
    for (const t of toolsFor(city, plugins)) console.log(`${t.function.name}\n  ${t.function.description}\n  args: ${JSON.stringify(t.function.parameters.properties)}\n`);
  } else if (cmd === 'tool') {
    const [name, json = '{}'] = rest;
    const { city, plugins } = await loadDeployment();
    if (!toolsFor(city, plugins).some((t) => t.function.name === name)) throw new Error(`${city.name} has no tool "${name}". Run: socrata-agent tools --city ${city.id}${values.config ? ` --config ${values.config}` : ''}`);
    const ctx = createContext({ city, indexes: await loadIndexes(city), appToken: process.env.SOCRATA_APP_TOKEN, plugins });
    const result = await runTool(ctx, name, JSON.parse(json));
    // outbound_requests: every fetch the tool made, retries included (what
    // it would cost against SUBREQUEST_BUDGET in the Worker).
    console.log(JSON.stringify({ result, trace: ctx.trace.toJSON(), resources: ctx.resources.toJSON(), outbound_requests: ctx.requests.used }, null, 2));
  } else if (cmd === 'ask') {
    const question = rest.join(' ').trim();
    if (!question) throw new Error('ask needs a question');
    const { city, plugins, model: configModel } = await loadDeployment();
    const model = values.model || configModel || process.env.SOCRATA_AGENT_MODEL || DEFAULT_MODEL;
    const out = await ask({
      question,
      city,
      plugins,
      indexes: await loadIndexes(city),
      apiKey: apiKeyFromEnv(model, process.env),
      appToken: process.env.SOCRATA_APP_TOKEN,
      model,
      effort: values.effort,
      // Unset: no cap (the count still runs and is reported).
      subrequestBudget: cliSubrequestBudget(process.env.SUBREQUEST_BUDGET),
      onEvent: (e) => {
        if (values.json) return;
        if (e.type === 'tool') console.error(`  → ${e.name} ${JSON.stringify(e.args)}`);
        if (e.type === 'rewrite') console.error(`  → voice check: rewriting (${e.violations.length} "there is")`);
      },
    });
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`\n${out.answer}\n`);
      if (out.requestBudget.note) console.log(`${out.requestBudget.note}\n`);
      if (!out.voice.ok) {
        const how = out.voice.rewritten ? ' after rewrite' : out.voice.rewriteSkipped ? ' (no rewrite: the request budget was used up)' : '';
        console.log(`⚠ Voice check failed${how}: ${out.voice.violations.join(' | ')}\n`);
      }
      console.log(`## Resources\n${out.markdown.resources}\n`);
      console.log(`## Trace\n${out.markdown.trace}\n`);
      const r = out.requestBudget;
      console.log(`_${out.model} · ${out.steps} tool steps · ${r.used} outbound requests${r.limit ? ` of ${r.limit}` : ''} · $${out.cost.toFixed(4)}_`);
    }
  } else {
    console.log(HELP);
    process.exit(1);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
