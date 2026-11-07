#!/usr/bin/env node
// Make and manage pre-alpha invite codes, and export the waitlist. Runs
// wrangler against the deployment's LIMITS KV namespace.
//
//   node scripts/invites.js create --label "Wetlands Watch staff" --uses 5
//   node scripts/invites.js list
//   node scripts/invites.js revoke SIREN-ABCDE-FGHJK      (or the hash from list)
//   node scripts/invites.js waitlist > ~/siren-waitlist.csv
//   node scripts/invites.js waitlist-remove someone@example.org
//   node scripts/invites.js requests [--status new]
//   node scripts/invites.js request-accept|request-decline <request id> [--note "..."]
//   node scripts/invites.js request-fulfilled <request id> --by <PR or commit link>
//   node scripts/invites.js request-reopen <request id>
//   node scripts/invites.js request-note <request id> <note id> approve|delete
//
// Once a request or note has been synced to GitHub, declining or deleting it
// doesn't erase it there: the old title stays in the issue's timeline and old
// bodies in its edit history. For text that names a person or a home, delete
// the issue by hand (a repo admin step; nothing here deletes issues).
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
import { newCode, inviteKey, sha256hex, csvField as csv } from '../worker/invites.js';
import { withStatus, withNoteReview, normalizeRecord, publicId, deletedKey, decisionKey, decisionOf, stewardView, withDeleted } from '../worker/requests.js';

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


// An invite by its code, its 64-character hash, or invite:<hash>.
async function keyFor(arg) {
  const a = String(arg || '').trim();
  if (/^invite:[0-9a-f]{64}$/.test(a)) return a;
  if (/^[0-9a-f]{64}$/.test(a)) return `invite:${a}`;
  return inviteKey(a);
}

// The names of the keys that start with `prefix`, from one `kv key list`.
// Optional keys are found this way, never by a `get` that might miss: a
// missing key is just not listed, in local and remote mode alike, so no
// error text is parsed (remote `get` of a missing key exits 1 with "404: Not
// Found"; local prints "Value not found"). Any failure of the list throws.
// The list is as eventually consistent as KV itself: a side key written in
// the last minute elsewhere may not be listed yet (see worker/requests.js on
// two steward actions inside the propagation window).
function keyNames(prefix) {
  if (dry) return new Set();
  return new Set((JSON.parse(wrangler(['list', '--prefix', prefix]) || '[]') || []).map((k) => k.name));
}

// The side keys of one request that exist: its tombstone and its decision.
const sideKeysOf = (key) => new Set([...keyNames(deletedKey(key)), ...keyNames(decisionKey(key))]);

// A request record as the Worker reads it: deleted notes dropped and the
// stored decision laid over it (see worker/requests.js). `sides` is the set
// of side keys that exist (sideKeysOf, or one listing for every request);
// only those are read, and a failed read throws, so a failed read never
// stands in for an empty tombstone that a delete would overwrite.
function readRequest(key, sides = sideKeysOf(key)) {
  const r = JSON.parse(wrangler(['get', key, '--text']) || '{}');
  const deleted = readOptionalJson(deletedKey(key), sides);
  const decision = readOptionalJson(decisionKey(key), sides);
  return { r: stewardView(r, Array.isArray(deleted) ? deleted : [], decision), deleted: Array.isArray(deleted) ? deleted : [] };
}
function readOptionalJson(key, sides) {
  if (dry || !sides.has(key)) return null;
  const out = wrangler(['get', key, '--text']).trim();
  return out ? JSON.parse(out) : null;
}

// Whether a key exists, by listing it (see keyNames). Any failure throws.
function exists(key) {
  if (dry) return true;
  return keyNames(key).has(key);
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
    // Source requests for the steward, most wanted first. Every note is
    // listed with its id: [pending] notes wait for request-note approve or
    // delete; [private] notes (sent before requests were public) are shown
    // here but never on the public list, even if approved.
    const keys = JSON.parse(wrangler(['list', '--prefix', 'request:']) || '[]');
    // Every request's side keys from two listings, not two reads per request.
    const sides = new Set([...keyNames('request-deleted:'), ...keyNames('request-decision:')]);
    const rows = keys.map(({ name }) => [name, normalizeRecord(readRequest(name, sides).r)]).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
    const only = opt('status', '');
    for (const [name, r] of rows) {
      if (only && (r.status || 'new') !== only) continue;
      console.log(`${publicId(name)}  ${String(r.status || 'new').padEnd(9)} ${String(r.count).padStart(4)}  ${r.source}${r.url ? `  <${r.url}>` : ''}  (last ${r.last || ''})`);
      // Only public notes need a decision, as on the admin page.
      for (const n of r.needs) console.log(`        ${n.id}  ${n.day || ''}  ${n.public && n.review !== 'ok' ? '[pending] ' : ''}${n.public ? '' : '[private] '}${n.text}`);
    }
    if (!rows.length) console.error('No source requests yet.');
  } else if (['request-accept', 'request-decline', 'request-fulfilled', 'request-reopen'].includes(cmd)) {
    // Steward decisions. Accepting puts a request on the public list and, at
    // the next sync, on GitHub; --note is shown publicly with it. Its notes
    // stay pending until each is approved with request-note. Declining a
    // request that was public lists it as withdrawn in the feed; its issue is
    // closed by a sync run with --with-withdrawn, or directly with a token
    // (docs/request-sync-routine.md), and until then by hand.
    const id = String(argv[1] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6,64}$/.test(id)) throw new Error('Give the request id from `requests` (the first column).');
    const matches = JSON.parse(wrangler(['list', '--prefix', `request:${id}`]) || '[]');
    if (matches.length !== 1) throw new Error(matches.length ? 'That id matches more than one request; use more of it.' : 'No request has that id.');
    const key = matches[0].name;
    const cur = readRequest(key).r;
    const status = { 'request-accept': 'accepted', 'request-decline': 'declined', 'request-fulfilled': 'fulfilled', 'request-reopen': 'accepted' }[cmd];
    const next = withStatus(cur, status, { steward_note: opt('note', ''), fulfilled_by: cmd === 'request-fulfilled' ? opt('by', '') : '' });
    if (cmd === 'request-fulfilled' && !next.fulfilled_by) throw new Error('Give --by <link to the merged PR or commit>.');
    // The decision first, which raises never write, so a stale raise can't undo it.
    wrangler(['put', decisionKey(key), JSON.stringify(decisionOf(next))]);
    wrangler(['put', key, JSON.stringify(next)]);
    console.error(`${cur.source}: ${cur.status || 'new'} -> ${status}.`);
  } else if (cmd === 'request-note') {
    // Review one note: approve shows it publicly (if written under the public
    // notice) once the request is accepted; delete removes it from storage.
    // A note already synced to GitHub stays in the issue's edit history; for
    // text that names a person or a home, delete the issue by hand.
    const id = String(argv[1] || '').trim().toLowerCase();
    const noteId = String(argv[2] || '').trim().toLowerCase();
    const action = String(argv[3] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6,64}$/.test(id)) throw new Error('Give the request id from `requests` (the first column).');
    if (!/^[0-9a-z-]{1,24}$/.test(noteId)) throw new Error('Give the note id from `requests` (the first column under the request).');
    const matches = JSON.parse(wrangler(['list', '--prefix', `request:${id}`]) || '[]');
    if (matches.length !== 1) throw new Error(matches.length ? 'That id matches more than one request; use more of it.' : 'No request has that id.');
    const key = matches[0].name;
    const { r: cur, deleted } = readRequest(key);
    const next = withNoteReview(cur, noteId, action);
    // The tombstone first, so a raise that read a stale copy can't bring the note back.
    if (action === 'delete') wrangler(['put', deletedKey(key), JSON.stringify(withDeleted(deleted, noteId))]);
    wrangler(['put', key, JSON.stringify(next)]);
    console.error(`${cur.source}: note ${noteId} ${action === 'delete' ? 'deleted' : 'approved'}.`);
  } else if (cmd === 'waitlist-remove') {
    const email = String(argv[1] || '').trim().toLowerCase();
    if (!email.includes('@')) throw new Error('Give the email address to remove.');
    const key = `waitlist:${await sha256hex(email)}`;
    if (!exists(key)) throw new Error('That email is not on the waitlist. Nothing was removed.');
    wrangler(['delete', key]);
    console.error('Removed from the waitlist.');
  } else {
    console.error('Usage: node scripts/invites.js create --label "..." [--uses N] | list | revoke <code or hash> | waitlist | waitlist-remove <email> | requests [--status new] | request-accept <id> [--note "..."] | request-decline <id> [--note "..."] | request-fulfilled <id> --by <url> | request-reopen <id> | request-note <id> <note id> approve|delete  [--env siren] [--local] [--config file] [--dry-run]');
    process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
