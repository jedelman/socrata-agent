#!/usr/bin/env node
// Run the same questions through several models and save each answer with
// its trace, voice check, cost and time, for reading side by side. OpenRouter
// ids use OPENROUTER_API_KEY; claude-* ids go to Anthropic with
// SIREN_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY (the first wins; inside Claude
// Code sessions ANTHROPIC_API_KEY is Claude Code's own).
// Append @effort to a Claude id to set its effort: claude-haiku-5-5@low.
//
//   node scripts/compare-models.js openai/gpt-5.6-luna claude-haiku-5-5@low claude-haiku-5-5@medium
//
// With --deployment <name>, each answer runs as that deployment's Worker runs
// it: its plugins, prompt lines and web search, the Worker's per-answer limits
// (worker/limits.js defaults, which Siren's wrangler vars match), and
// summarized thinking on, as the chat page streams it. Siren's own questions
// replace the default set. Research memory and watches stay off (they need
// the Worker's KV). For Siren as deployed, give the model with no @effort.
//
//   node scripts/compare-models.js --deployment siren claude-sonnet-5-5 claude-haiku-5-5 claude-haiku-5-5@high
//
// --max-usd <n> stops starting new answers once the run has spent n dollars
// (default 5). --dry-run sends nothing to a model: it builds each model's
// first request, prints its size, and stops.
//
// Writes eval/compare-<timestamp>.json. Judging accuracy is still a human job:
// read each answer against its own trace.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { ask, apiKeyFromEnv, providerOf } from '../src/agent.js';
import { getCity } from '../src/cities/index.js';
import { applyConfig, definePlugin, webSearchConfig } from '../src/plugins.js';
import { askLimits } from '../worker/limits.js';

const QUESTIONS = [
  { city: 'norfolk', q: "What's on my block? I live at 810 Union St." },
  { city: 'norfolk', q: 'Who decided to allow a kennel at 111 Pennsylvania Ave, and did anyone vote against it?' },
  { city: 'norfolk', q: "What's going on at 1234 Gwaltney Way?" },
  { city: 'chicago', q: 'How many pothole complaints did Chicago get in the last 30 days?' },
];

// Siren's questions, one or more per kind of tool she reaches for: the four on
// her welcome screen, then a document, trees, the Zoning Ordinance, a block,
// and one she must decline (a person's details).
const SIREN_QUESTIONS = [
  "What's the plan for the old Military Circle Mall site?",
  'What does the Military Circle cooperation agreement (Ordinance 50487) say about paying back the advance?',
  "What share of Ghent's homes are on Graydon between Colley and Colonial?",
  'How much does Norfolk budget for tree care?',
  'What public meetings are coming up in the next two weeks?',
  'Has the City removed any street trees in the Ghent civic leagues since September, and why?',
  'What does the zoning ordinance say about short-term rentals in residential districts?',
  "What's on my block? I live at 810 Union St.",
  'Who owns the house at 810 Union St, and how do I reach them?',
].map((q) => ({ city: 'norfolk', q }));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const deploymentName = opt('--deployment');
const maxUsd = Number(opt('--max-usd') ?? 5);
const dryRun = flag('--dry-run');
const models = args;
if (!models.length || !Number.isFinite(maxUsd)) {
  console.error('usage: compare-models.js [--deployment <name>] [--max-usd <n>] [--dry-run] <model[@effort]> [model...]');
  process.exit(1);
}

const deployment = deploymentName ? (await import(`../deployments/${deploymentName}.config.js`)).default : null;
const plugins = deployment ? (deployment.plugins || []).map(definePlugin) : [];
const webSearch = deployment ? webSearchConfig(deployment) : null;
const questions = deploymentName === 'siren' ? SIREN_QUESTIONS : QUESTIONS;
const index = JSON.parse(await readFile(new URL('../data/norfolk-legislation.json', import.meta.url), 'utf8'));

// Captures the first model request and stops, for --dry-run.
const captured = {};
const dryFetch = (model) => async (url, init = {}) => {
  if (/^https:\/\/(api\.anthropic\.com|openrouter\.ai)\//.test(String(url))) {
    captured[model] = JSON.parse(init.body);
    throw new Error('dry run: request built, not sent');
  }
  return fetch(url, init);
};

let spent = 0;
const results = await Promise.all(
  models.map(async (model) => {
    const out = [];
    const [id, effort] = model.split('@');
    for (const { city, q } of dryRun ? questions.slice(0, 1) : questions) {
      if (spent >= maxUsd) {
        out.push({ model, city, q, skipped: `the run reached its $${maxUsd} cap` });
        continue;
      }
      const t0 = Date.now();
      try {
        const apiKey = dryRun ? 'dry-run' : apiKeyFromEnv(id, process.env);
        const base = deployment ? applyConfig(getCity(city), deployment) : getCity(city);
        const r = await ask({
          question: q,
          city: base,
          indexes: { 'norfolk-legislation': index },
          apiKey,
          model: id,
          effort,
          onCost: (usd) => {
            spent += Number(usd) || 0;
          },
          ...(deployment
            ? { plugins, ...askLimits({}, providerOf(id)), ...(webSearch ? { webSearch } : {}), thinkingEvents: true, onEvent: () => {} }
            : {}),
          ...(dryRun ? { fetchImpl: dryFetch(model) } : {}),
        });
        const { toolResults, markdown, ...kept } = r;
        out.push({ model, city, q, ms: Date.now() - t0, ...kept, tools: (Array.isArray(r.trace) ? r.trace : []).map((s) => s.tool) });
      } catch (err) {
        out.push({ model, city, q, ms: Date.now() - t0, error: err.message });
      }
      console.error(`${model} · ${q.slice(0, 40)} · done ($${spent.toFixed(3)} so far)`);
    }
    return out;
  })
);

if (dryRun) {
  for (const model of models) {
    const body = captured[model];
    if (!body) {
      console.log(`${model.padEnd(28)} no request built: ${results.flat().find((r) => r.model === model)?.error}`);
      continue;
    }
    const system = Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : String(body.system || '');
    const tools = body.tools || [];
    console.log(
      `${model.padEnd(28)} model:${body.model} effort:${body.output_config?.effort ?? '(default)'} thinking:${body.thinking?.type ?? 'off'} max_tokens:${body.max_tokens} system:${system.length} chars tools:${tools.length} (${JSON.stringify(tools).length} chars) web:${tools.find((t) => t.type?.startsWith('web_search'))?.type ?? 'none'}`
    );
  }
  process.exit(0);
}

const flat = results.flat();
await mkdir(new URL('../eval/', import.meta.url), { recursive: true });
const file = new URL(`../eval/compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
await writeFile(file, JSON.stringify({ deployment: deploymentName, models, spent, results: flat }, null, 2));
for (const r of flat) {
  const status = r.skipped
    ? `SKIPPED ${r.skipped}`
    : r.error
      ? `ERROR ${r.error.slice(0, 60)}`
      : `voice:${r.voice.ok ? 'ok' : 'FAIL'}${r.voice.rewritten ? '(rw)' : ''} steps:${r.steps} $${r.cost.toFixed(4)} ${(r.ms / 1000).toFixed(0)}s`;
  console.log(`${r.model.padEnd(28)} ${r.q.slice(0, 44).padEnd(44)} ${status}`);
}
console.log(`\nspent $${spent.toFixed(3)}\n${file.pathname}`);
