#!/usr/bin/env node
// Run the same questions through several OpenRouter models and save each
// answer with its trace, voice check, cost and time, for reading side by side.
//
//   OPENROUTER_API_KEY=... node scripts/compare-models.js model-a model-b ...
//
// Writes eval/compare-<timestamp>.json. Judging accuracy is still a human job:
// read each answer against its own trace.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { ask } from '../src/agent.js';
import { getCity } from '../src/cities/index.js';

const QUESTIONS = [
  { city: 'norfolk', q: "What's on my block? I live at 810 Union St." },
  { city: 'norfolk', q: 'Who decided to allow a kennel at 111 Pennsylvania Ave, and did anyone vote against it?' },
  { city: 'norfolk', q: "What's going on at 1234 Gwaltney Way?" },
  { city: 'chicago', q: 'How many pothole complaints did Chicago get in the last 30 days?' },
];

const models = process.argv.slice(2);
if (!models.length) {
  console.error('usage: compare-models.js <model> [model...]');
  process.exit(1);
}
const index = JSON.parse(await readFile(new URL('../data/norfolk-legislation.json', import.meta.url), 'utf8'));

const results = await Promise.all(
  models.map(async (model) => {
    const out = [];
    for (const { city, q } of QUESTIONS) {
      const t0 = Date.now();
      try {
        const r = await ask({ question: q, city: getCity(city), indexes: { 'norfolk-legislation': index }, apiKey: process.env.OPENROUTER_API_KEY, model });
        out.push({ model, city, q, ms: Date.now() - t0, answer: r.answer, voice: r.voice, cost: r.cost, steps: r.steps, trace: r.trace });
      } catch (err) {
        out.push({ model, city, q, ms: Date.now() - t0, error: err.message });
      }
      console.error(`${model} · ${q.slice(0, 40)} · done`);
    }
    return out;
  })
);

const flat = results.flat();
await mkdir(new URL('../eval/', import.meta.url), { recursive: true });
const file = new URL(`../eval/compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
await writeFile(file, JSON.stringify(flat, null, 2));
for (const r of flat) {
  console.log(
    `${r.model.padEnd(32)} ${r.q.slice(0, 44).padEnd(44)} ${r.error ? `ERROR ${r.error.slice(0, 60)}` : `voice:${r.voice.ok ? 'ok' : 'FAIL'}${r.voice.rewritten ? '(rw)' : ''} steps:${r.steps} $${r.cost.toFixed(4)} ${(r.ms / 1000).toFixed(0)}s`}`
  );
}
console.log(`\n${file.pathname}`);
