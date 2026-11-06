#!/usr/bin/env node
// Make and manage pre-alpha invite codes, and export the waitlist. Runs
// wrangler against the deployment's LIMITS KV namespace.
//
//   node scripts/invites.js create --label "Wetlands Watch staff" --uses 5
//   node scripts/invites.js list
//   node scripts/invites.js revoke SIREN-ABCDE-FGHJK      (or the hash from list)
//   node scripts/invites.js waitlist > ~/siren-waitlist.csv
//   node scripts/invites.js waitlist-remove someone@example.org
//   node scripts/invites.js endorsements                 (Bluesky endorsement counts)
//   node scripts/invites.js endorsements-clear <id>      (delete one request's endorsements)
//
// Options: --env <name> (default siren), --local (wrangler dev's local KV
// instead of the deployed one), --config <file> (another wrangler config),
// --dry-run (print the wrangler commands only).
//
// Each browser or device that redeems a code uses one of its --uses (default
// 3). Codes are stored only as hashes, so a lost code can't be looked up
// again: revoke it by the hash `list` prints, and make a new one. Keep the
// waitlist CSV private and outside the repository; it holds people's email
// addresses.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newCode, inviteKey, sha256hex, csvField as csv } from '../worker/invites.js';
import { withStatus, publicId, freezeAtDecision } from '../worker/requests.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const env = opt('env', 'siren');
const where = flag('local') ? '--local' : '--remote';
const dry = flag('dry-run');

function wrangler(args) {
  const full = ['wrangler', 'kv', 'key', ...args, '--binding', 'LIMITS', '--env', env, where, ...(opt('config') ? ['--config', opt('config')] : [])];
  if (dry) {
    console.error(`npx ${full.map((a) => (/[\s"'{}]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ')}`);
    return '';
  }
  return execFileSync('npx', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

// `wrangler kv bulk delete <file>`: wrangler() above runs only `kv key`
// commands. The file is a JSON array of key names.
function wranglerBulkDelete(names) {
  if (!names.length) return;
  const dir = mkdtempSync(join(tmpdir(), 'siren-kv-'));
  const file = join(dir, 'keys.json');
  writeFileSync(file, JSON.stringify(names));
  const full = ['wrangler', 'kv', 'bulk', 'delete', file, '--force', '--binding', 'LIMITS', '--env', env, where, ...(opt('config') ? ['--config', opt('config')] : [])];
  try {
    if (dry) console.error(`npx ${full.join(' ')}  # ${names.length} keys`);
    else execFileSync('npx', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Bluesky endorsements by listing (wrangler's listing includes metadata):
// Map(id -> { n, young, unknown, names }).
function endorsementTally(prefix = 'endorsement:') {
  const keys = JSON.parse(wrangler(['list', '--prefix', prefix]) || '[]');
  const counts = new Map();
  for (const k of keys) {
    const m = /^endorsement:([0-9a-f]{12}):[0-9a-f]{32}$/.exec(k.name);
    if (!m) continue;
    const c = counts.get(m[1]) || { n: 0, young: 0, unknown: 0, names: [] };
    c.n++;
    if (k.metadata?.y === 1) c.young++;
    else if (k.metadata?.y == null) c.unknown++;
    c.names.push(k.name);
    counts.set(m[1], c);
  }
  return counts;
}

// One request by the id `requests` prints, with the same exactly-one check
// the Worker uses: { key, cur }.
function requestById(arg) {
  const id = String(arg || '').trim().toLowerCase();
  if (!/^[0-9a-f]{6,64}$/.test(id)) throw new Error('Give the request id from `requests` (the first column).');
  const matches = JSON.parse(wrangler(['list', '--prefix', `request:${id}`]) || '[]');
  if (matches.length !== 1) throw new Error(matches.length ? 'That id matches more than one request; use more of it.' : 'No request has that id.');
  const key = matches[0].name;
  return { key, cur: JSON.parse(wrangler(['get', key, '--text']) || '{}') };
}

// An invite by its code, its 64-character hash, or invite:<hash>.
async function keyFor(arg) {
  const a = String(arg || '').trim();
  if (/^invite:[0-9a-f]{64}$/.test(a)) return a;
  if (/^[0-9a-f]{64}$/.test(a)) return `invite:${a}`;
  return inviteKey(a);
}

function exists(key) {
  if (dry) return true;
  try {
    const out = wrangler(['get', key, '--text']).trim();
    return Boolean(out) && !/value not found/i.test(out);
  } catch {
    return false;
  }
}

async function main() {
  if (cmd === 'create') {
    const label = opt('label', '');
    if (!label) throw new Error('Give the invite a --label saying who it is for.');
    const uses = Number(opt('uses', '3'));
    if (!Number.isInteger(uses) || uses < 1) throw new Error('--uses must be a whole number of 1 or more.');
    const code = newCode();
    const record = { label, max_uses: uses, created: new Date().toISOString() };
    wrangler(['put', await inviteKey(code), JSON.stringify(record)]);
    console.log(code);
    console.error(`Invite for "${label}", good for ${uses} ${uses === 1 ? 'browser' : 'browsers or devices'}. Codes are stored only as hashes: save it now.`);
  } else if (cmd === 'revoke') {
    const key = await keyFor(argv[1]);
    if (!key) throw new Error('Give the code to revoke (SIREN-ABCDE-FGHJK) or the hash from `list`.');
    if (!exists(key)) throw new Error('No invite matches that (check for a typo). Nothing was revoked.');
    wrangler(['delete', key]);
    console.error('Revoked. Anyone using it is signed out on their next question.');
  } else if (cmd === 'list') {
    const keys = JSON.parse(wrangler(['list', '--prefix', 'invite:']) || '[]');
    for (const { name } of keys) {
      const rec = JSON.parse(wrangler(['get', name, '--text']) || '{}');
      console.log(`${name.slice(7)}  ${rec.label || '(no label)'}  max ${rec.max_uses ?? '∞'}  created ${rec.created || '?'}`);
    }
    if (!keys.length) console.error('No invites yet.');
  } else if (cmd === 'waitlist') {
    const keys = JSON.parse(wrangler(['list', '--prefix', 'waitlist:']) || '[]');
    console.log(['email', 'name', 'org', 'note', 'source', 'at'].join(','));
    for (const { name } of keys) {
      const e = JSON.parse(wrangler(['get', name, '--text']) || '{}');
      console.log([e.email, e.name, e.org, e.note, e.source, e.at].map(csv).join(','));
    }
    console.error(`${keys.length} on the waitlist.`);
  } else if (cmd === 'requests') {
    // Source requests for the steward, most wanted first. Private notes are
    // shown here (marked) but never on the public list.
    const keys = JSON.parse(wrangler(['list', '--prefix', 'request:']) || '[]');
    const rows = keys.map(({ name }) => [name, JSON.parse(wrangler(['get', name, '--text']) || '{}')]).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
    const only = opt('status', '');
    for (const [name, r] of rows) {
      if (only && (r.status || 'new') !== only) continue;
      console.log(`${publicId(name)}  ${String(r.status || 'new').padEnd(9)} ${String(r.count).padStart(4)}  ${r.source}${r.url ? `  <${r.url}>` : ''}  (last ${String(r.last || '').slice(0, 10)})`);
      for (const n of (r.needs || []).slice(-3)) console.log(`        - ${n.public ? '' : '[private] '}${n.text}`);
    }
    if (!rows.length) console.error('No source requests yet.');
  } else if (['request-accept', 'request-decline', 'request-fulfilled', 'request-reopen'].includes(cmd)) {
    // Steward decisions. Accepting puts a request on the public list and, at
    // the next sync, on GitHub; --note is shown publicly with it. Declining or
    // fulfilling freezes the Bluesky endorsement count into the request (one
    // write), then deletes the per-account endorsement keys, as the Worker does.
    const { key, cur } = requestById(argv[1]);
    const status = { 'request-accept': 'accepted', 'request-decline': 'declined', 'request-fulfilled': 'fulfilled', 'request-reopen': 'accepted' }[cmd];
    const decided = status === 'declined' || status === 'fulfilled';
    const tally = decided ? endorsementTally(`endorsement:${publicId(key)}:`).get(publicId(key)) : null;
    const next = withStatus(cur, status, { steward_note: opt('note', ''), fulfilled_by: cmd === 'request-fulfilled' ? opt('by', '') : '' });
    if (cmd === 'request-fulfilled' && !next.fulfilled_by) throw new Error('Give --by <link to the merged PR or commit>.');
    const live = tally ? { n: tally.n, young: tally.young, unknown: tally.unknown } : undefined;
    const frozen = freezeAtDecision(cur, status, live);
    if (frozen) next.endorsements_at_decision = frozen;
    wrangler(['put', key, JSON.stringify(next)]);
    if (tally) wranglerBulkDelete(tally.names);
    console.error(`${cur.source}: ${cur.status || 'new'} -> ${status}.${tally ? ` ${tally.n} endorsement${tally.n === 1 ? '' : 's'} frozen and cleared.` : ''}`);
  } else if (cmd === 'endorsements') {
    // Per-request Bluesky endorsement totals. Nothing here can say who endorsed.
    const counts = endorsementTally();
    for (const [id, c] of [...counts].sort((a, b) => b[1].n - a[1].n)) console.log(`${id}  ${String(c.n).padStart(4)}  (${c.young} young, ${c.unknown} unknown age)`);
    if (!counts.size) console.error('No Bluesky endorsements.');
  } else if (cmd === 'endorsements-clear') {
    // For brigading: delete every endorsement on one request.
    const { key, cur } = requestById(argv[1]);
    const c = endorsementTally(`endorsement:${publicId(key)}:`).get(publicId(key));
    wranglerBulkDelete(c?.names || []);
    console.error(`${cur.source}: ${c?.n || 0} endorsement${c?.n === 1 ? '' : 's'} cleared.`);
  } else if (cmd === 'waitlist-remove') {
    const email = String(argv[1] || '').trim().toLowerCase();
    if (!email.includes('@')) throw new Error('Give the email address to remove.');
    const key = `waitlist:${await sha256hex(email)}`;
    if (!exists(key)) throw new Error('That email is not on the waitlist. Nothing was removed.');
    wrangler(['delete', key]);
    console.error('Removed from the waitlist.');
  } else {
    console.error('Usage: node scripts/invites.js create --label "..." [--uses N] | list | revoke <code or hash> | waitlist | waitlist-remove <email> | requests [--status new] | request-accept <id> [--note "..."] | request-decline <id> [--note "..."] | request-fulfilled <id> --by <url> | request-reopen <id> | endorsements | endorsements-clear <id>  [--env siren] [--local] [--config file] [--dry-run]');
    process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
