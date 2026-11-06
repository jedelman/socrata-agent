#!/usr/bin/env node
// Make and manage pre-alpha invite codes, and export the waitlist. Runs
// wrangler against the deployment's LIMITS KV namespace, and, for Bluesky
// endorsements, its SIREN_DB D1 database.
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
// and D1 instead of the deployed ones), --config <file> (another wrangler config),
// --dry-run (print the wrangler commands only).
//
// Each browser or device that redeems a code uses one of its --uses (default
// 3). Codes are stored only as hashes, so a lost code can't be looked up
// again: revoke it by the hash `list` prints, and make a new one. Keep the
// waitlist CSV private and outside the repository; it holds people's email
// addresses.

import { execFileSync } from 'node:child_process';
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

// `wrangler d1 execute SIREN_DB --command <sql> --json`: the endorsement
// tables (migrations/). -> one results array per statement. wrangler's
// --command takes no bound parameters, so the only values ever written into
// this SQL are a 12-hex request id and a whole number of seconds, each
// checked by sqlId / sqlInt first; nothing typed reaches it unchecked.
const sqlId = (id) => {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error(`Not a request id: ${id}`);
  return `'${id}'`;
};
const sqlInt = (n) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Not a whole number: ${n}`);
  return String(n);
};
function d1(sql) {
  const full = ['wrangler', 'd1', 'execute', 'SIREN_DB', '--command', sql, '--json', '--yes', '--env', env, where, ...(opt('config') ? ['--config', opt('config')] : [])];
  if (dry) {
    console.error(`npx ${full.map((a) => (/[\s"'{}();*=<>]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' ')}`);
    return [];
  }
  const out = JSON.parse(execFileSync('npx', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }) || '[]');
  return (Array.isArray(out) ? out : [out]).map((r) => r.results || []);
}

// Bluesky endorsement tallies, after deleting rows past their expiry:
// Map(id -> { n, young, unknown }), for one request or all.
function endorsementTally(id) {
  const now = sqlInt(Math.floor(Date.now() / 1000));
  const where = id ? ` WHERE request_id = ${sqlId(id)}` : '';
  const [, rows = []] = d1(`DELETE FROM endorsements WHERE exp <= ${now}; SELECT request_id, n, young, unknown FROM endorsement_counts${where}`);
  return new Map(rows.map((r) => [r.request_id, { n: Number(r.n) || 0, young: Number(r.young) || 0, unknown: Number(r.unknown) || 0 }]));
}

// Delete every endorsement on one request (the tallies follow by trigger).
function clearEndorsements(id) {
  d1(`DELETE FROM endorsements WHERE request_id = ${sqlId(id)}`);
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
    // write), then deletes the per-account endorsement rows, as the Worker does.
    // --no-endorsements skips both, for a deployment without SIREN_DB.
    const { key, cur } = requestById(argv[1]);
    const status = { 'request-accept': 'accepted', 'request-decline': 'declined', 'request-fulfilled': 'fulfilled', 'request-reopen': 'accepted' }[cmd];
    const decided = status === 'declined' || status === 'fulfilled';
    const tally = decided && !flag('no-endorsements') ? (endorsementTally(publicId(key)).get(publicId(key)) || { n: 0, young: 0, unknown: 0 }) : null;
    const next = withStatus(cur, status, { steward_note: opt('note', ''), fulfilled_by: cmd === 'request-fulfilled' ? opt('by', '') : '' });
    if (cmd === 'request-fulfilled' && !next.fulfilled_by) throw new Error('Give --by <link to the merged PR or commit>.');
    const live = tally ? { n: tally.n, young: tally.young, unknown: tally.unknown } : undefined;
    const frozen = freezeAtDecision(cur, status, live);
    if (frozen) next.endorsements_at_decision = frozen;
    wrangler(['put', key, JSON.stringify(next)]);
    if (tally && tally.n) clearEndorsements(publicId(key));
    console.error(`${cur.source}: ${cur.status || 'new'} -> ${status}.${tally ? ` ${tally.n} endorsement${tally.n === 1 ? '' : 's'} frozen and cleared.` : ''}`);
  } else if (cmd === 'endorsements') {
    // Per-request Bluesky endorsement totals. Nothing here can say who endorsed.
    const counts = endorsementTally();
    for (const [id, c] of [...counts].sort((a, b) => b[1].n - a[1].n)) console.log(`${id}  ${String(c.n).padStart(4)}  (${c.young} young, ${c.unknown} unknown age)`);
    if (!counts.size) console.error('No Bluesky endorsements.');
  } else if (cmd === 'endorsements-clear') {
    // For brigading: delete every endorsement on one request.
    const { key, cur } = requestById(argv[1]);
    const c = endorsementTally(publicId(key)).get(publicId(key));
    clearEndorsements(publicId(key));
    console.error(`${cur.source}: ${c?.n || 0} endorsement${c?.n === 1 ? '' : 's'} cleared.`);
  } else if (cmd === 'waitlist-remove') {
    const email = String(argv[1] || '').trim().toLowerCase();
    if (!email.includes('@')) throw new Error('Give the email address to remove.');
    const key = `waitlist:${await sha256hex(email)}`;
    if (!exists(key)) throw new Error('That email is not on the waitlist. Nothing was removed.');
    wrangler(['delete', key]);
    console.error('Removed from the waitlist.');
  } else {
    console.error('Usage: node scripts/invites.js create --label "..." [--uses N] | list | revoke <code or hash> | waitlist | waitlist-remove <email> | requests [--status new] | request-accept <id> [--note "..."] | request-decline <id> [--note "..."] | request-fulfilled <id> --by <url> | request-reopen <id> | endorsements | endorsements-clear <id>  [--no-endorsements] [--env siren] [--local] [--config file] [--dry-run]');
    process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
