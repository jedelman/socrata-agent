// The rollout's preconditions, checked against the files the rollout uses:
// the flag ships off, the retired bindings and cron are gone, migration 0003
// drops every table the old design made, and the doc's checklist names the
// commands that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('wrangler.toml: the flag off, three limiters, only the free tier\'s sweep cron, SIREN_DB still bound (D9)', () => {
  const toml = read('wrangler.toml');
  assert.ok(!/^\s*BLUESKY_LOGIN\s*=/m.test(toml), 'the flag flips in its own PR, after the live probe');
  assert.ok(!/^\s*PUBLIC_ASK\s*=/m.test(toml), 'the free tier flips in its own PR too');
  for (const gone of ['BSKY_ACCOUNT_RL', 'BSKY_D1_RL']) assert.ok(!toml.includes(gone), gone);
  for (const kept of ['BSKY_VISITOR_RL', 'BSKY_INPUT_RL', 'BSKY_SITE_RL']) assert.match(toml, new RegExp(`name = "${kept}"`));
  assert.match(toml, /binding = "SIREN_DB"/);
  assert.match(toml, /next one applied also\n# applies 0003/, 'applying any later migration applies 0003 too');
  // The old endorsement purge cron is gone; the one cron is the free tier's
  // sweep, and the scheduled handler does nothing but that (a no-op with
  // PUBLIC_ASK off: test/public-ask-off.test.js).
  assert.deepEqual([...toml.matchAll(/^crons = (.*)$/gm)].map((m) => m[1]), ['["*/10 * * * *"]']);
  assert.equal((toml.match(/\[env\.siren\.triggers\]/g) || []).length, 1);
  const index = read('worker/index.js');
  assert.match(index, /export default \{\n  async fetch/);
  const scheduled = index.slice(index.indexOf('  async scheduled(event, env, ctx) {'));
  assert.match(scheduled, /^  async scheduled\(event, env, ctx\) \{\n    if \(!publicAskOn\(env\)\) return;/);
  assert.deepEqual([...scheduled.matchAll(/await |sweepQuestions\(|handle[A-Z]\w*\(/g)].map((m) => m[0]).filter((x) => x !== 'await '), ['sweepQuestions(']);
});

test('migration 0003 drops every table and trigger 0001 and 0002 made', () => {
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).sort();
  // 0004 is the free tier's (docs/free-tier.md), checked in test/public-ask.test.js.
  assert.deepEqual(files, ['0001_bluesky_endorsements.sql', '0002_d1_budget.sql', '0003_endorsements_move_to_repos.sql', '0004_public_questions.sql']);
  const made = files.slice(0, 2).map((f) => read(`migrations/${f}`)).join('\n');
  const drops = read('migrations/0003_endorsements_move_to_repos.sql');
  for (const [, kind, name] of made.matchAll(/CREATE (TABLE|TRIGGER) (\w+)/g)) {
    const dropped = new RegExp(`DROP ${kind} IF EXISTS ${name};`).test(drops) || new RegExp(`DROP ${kind} IF EXISTS ${name};`).test(made);
    assert.ok(dropped, `${kind} ${name}`);
  }
});

test('the doc\'s rollout names commands that exist, in order', () => {
  const doc = read('docs/bluesky-endorsements.md');
  const rollout = doc.slice(doc.indexOf('## Rollout'), doc.indexOf('## Local development'));
  const steps = ['request-ids --apply', 'bsky-probe.js', '_lexicon', 'live probe', '0003', 'BLUESKY_LOGIN = "true"'].map((s) => rollout.indexOf(s));
  assert.ok(steps.every((i) => i >= 0), JSON.stringify(steps));
  assert.match(read('scripts/invites.js'), /cmd === 'request-ids'/);
  assert.match(read('scripts/invites.js'), /cmd === 'endorsements'/);
  const probe = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('../scripts/bsky-probe.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(read('scripts/bsky-probe.js'), /legacy ids/);
  assert.match(doc, /did=did:plc:zz4wcje4a2nbbtc7pdoth3f2/);
  assert.match(doc, /_lexicon\.siren\.jason-edelman\.org/);
  // Siren has its own origin, and the chat page carries a strict CSP: the doc says so (D4, settled).
  assert.match(doc, /Siren has its own origin, `https:\/\/ask-siren\.jason-edelman\.org` \(D4, settled/);
  assert.match(doc, /\*\*The chat page carries a strict CSP too\*\*/);
  assert.doesNotMatch(doc, /Recommendation, before the flag goes on:/);
  assert.doesNotMatch(doc, /no strict CSP \(it carries none today\)/);
});

test('every decision built as a default is marked pending Jason, in the doc and in code', () => {
  const doc = read('docs/bluesky-endorsements.md');
  for (const d of ['D2', 'D3', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D13']) assert.match(doc, new RegExp(`\\*\\*${d}\\*\\*`), d);
  const code = ['worker/endorse-client.js', 'worker/atproto-oauth.js', 'worker/index.js', 'worker/constellation.js', 'worker/endorse-config.js', 'worker/admin.js', 'worker/requests.js', 'worker/bluesky.js', 'worker/public-list.js', 'worker/endorsers.js', 'wrangler.toml'].map(read).join('\n');
  for (const d of ['D2', 'D3', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D13']) assert.match(code, new RegExp(`\\(${d}[,:][^)]*?default,[\\s*#/-]*pending[\\s*#/-]*Jason`), d);
  // D4 is settled (Jason, 2026-11-10: Siren's own origin): no longer listed as pending anywhere.
  assert.doesNotMatch(doc, /\*\*D4\*\*/);
  assert.doesNotMatch(code, /\(D4[,:][^)]*?pending/);
  assert.match(code, /D4, settled by Jason, 2026-11-10/);
});
