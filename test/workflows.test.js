// The workflows that keep the data current (docs/gaps.md §5.4): every
// command they run exists, the gap paths they add and restore are the ones a
// gap rebuild writes, and the two refresh jobs never run at once. GitHub
// Actions itself can't run here; these hold the files to what the scripts
// expect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gapPaths } from '../scripts/gap-refresh.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const DIR = '.github/workflows/';
const FILES = readdirSync(new URL(DIR, ROOT)).filter((f) => f.endsWith('.yml'));
const W = Object.fromEntries(FILES.map((f) => [f, read(DIR + f)]));
const SCRIPTS = JSON.parse(read('package.json')).scripts;

test('every script and npm script a workflow runs exists', () => {
  assert.ok(FILES.includes('refresh-gaps.yml'));
  for (const [f, text] of Object.entries(W)) {
    for (const [, s] of text.matchAll(/node (scripts\/[\w.-]+\.js)/g)) assert.ok(existsSync(new URL(s, ROOT)), `${f} runs ${s}, which isn't there`);
    for (const [, s] of text.matchAll(/npm run ([\w:-]+)/g)) assert.ok(SCRIPTS[s], `${f} runs npm run ${s}, which package.json doesn't define`);
    for (const [, sub] of text.matchAll(/node scripts\/gap-refresh\.js (\w+)/g)) assert.ok(['snapshot', 'decide', 'paths'].includes(sub), `${f}: gap-refresh.js ${sub}`);
  }
});

test('the gap paths each workflow adds and restores are the ones a gap rebuild writes', () => {
  const want = gapPaths().join(' ');
  const using = Object.entries(W).filter(([, t]) => /\$GAP_PATHS/.test(t));
  assert.deepEqual(using.map(([f]) => f).sort(), ['archive-case-sources.yml', 'refresh-gaps.yml', 'refresh-norfolk.yml']);
  for (const [f, t] of using) assert.equal(/^\s*GAP_PATHS: (.+)$/m.exec(t)?.[1], want, f);
});

test('the refresh jobs share one concurrency group, run weekly at their own minute, and write only contents and pull requests', () => {
  const group = (t) => /concurrency:\s*\n\s+group: ([\w-]+)/.exec(t)?.[1];
  assert.ok(group(W['refresh-gaps.yml']));
  assert.equal(group(W['refresh-gaps.yml']), group(W['refresh-norfolk.yml']));
  const crons = Object.entries(W).flatMap(([f, t]) => [...t.matchAll(/cron: '([^']+)'/g)].map((m) => [f, m[1]]));
  const [, mine] = crons.find(([f]) => f === 'refresh-gaps.yml');
  const [minute, hour, dom, , dow] = mine.split(' ');
  assert.notEqual(minute, '0');
  assert.equal(dom, '*');
  assert.match(dow, /^[0-6]$/, 'weekly');
  for (const [f, c] of crons.filter(([f]) => f !== 'refresh-gaps.yml')) assert.notEqual(c.split(' ').slice(0, 2).join(' '), `${minute} ${hour}`, `${f} runs at the same time`);
  for (const f of ['refresh-gaps.yml', 'refresh-norfolk.yml']) assert.match(W[f], /^permissions:\n {2}contents: write\n {2}pull-requests: write\n(?! )/m, f);
});

test('the weekly refresh measures live, checks, then decides; refresh-norfolk and the archive job rebuild offline', () => {
  const order = (t, steps) => {
    let at = -1;
    for (const s of steps) {
      const i = t.indexOf(s, at + 1);
      assert.ok(i > at, `${s} out of order`);
      at = i;
    }
  };
  order(W['refresh-gaps.yml'], ['gap-refresh.js snapshot', 'node scripts/verify-cases.js >', 'node scripts/build-gaps.js\n', 'node scripts/build-gaps-proposed.js\n', 'npm test', 'npm run check:gaps', 'build-gaps-proposed.js --check', 'gap-refresh.js decide', 'bot/gap-refresh-', 'gh pr create']);
  assert.doesNotMatch(W['refresh-gaps.yml'], /verify-cases\.js --write/, 'verify-cases runs read-only');
  assert.match(W['refresh-gaps.yml'], /SOCRATA_APP_TOKEN: \$\{\{ secrets\.SOCRATA_APP_TOKEN \}\}/);
  for (const f of ['refresh-norfolk.yml', 'archive-case-sources.yml']) {
    order(W[f], ['gap-refresh.js snapshot', 'build-gaps.js --offline', 'build-gaps-proposed.js --offline', 'npm run check:gaps', 'build-gaps-proposed.js --check', 'gap-refresh.js decide', 'git checkout HEAD -- $GAP_PATHS']);
  }
  assert.match(W['ci.yml'], /check-gaps:[\s\S]*npm run check:gaps[\s\S]*node scripts\/build-gaps-proposed\.js --check/);
  assert.match(SCRIPTS.test, /^node --test test\/\*\.test\.js$/, 'the gap checks stay outside npm test');
});
