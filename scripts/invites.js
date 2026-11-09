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
//   node scripts/invites.js requests [--status new]
//   node scripts/invites.js request-accept|request-decline <request id> [--note "..."]
//   node scripts/invites.js request-fulfilled <request id> --by <PR or commit link>
//   node scripts/invites.js request-reopen <request id>
//   node scripts/invites.js request-note <request id> <note id> approve|delete
//   node scripts/invites.js request-ids [--apply]       (one-time: give every legacy request a random public id)
//   node scripts/invites.js endorsements                 (Bluesky endorsement counts; deletes expired endorsements first)
//   node scripts/invites.js endorsements-clear <id>      (delete one request's endorsements)
//   node scripts/invites.js endorsements-purge           (delete expired Bluesky rows, as the daily cron does)
//   node scripts/invites.js endorsements-purge --all     (delete every Bluesky row; only with the flag off)
//
// Once a request or note has been synced to GitHub, declining or deleting it
// doesn't erase it there: the old title stays in the issue's timeline and old
// bodies in its edit history. For text that names a person or a home, delete
// the issue by hand (a repo admin step; nothing here deletes issues).
//
// Options: --env <name> (default siren), --local (wrangler dev's local KV
// and D1 instead of the deployed ones), --config <file> (another wrangler config),
// --dry-run (print the wrangler commands only).
//
// D1 follows the Worker's rule (worker/endorsements.js endorseDb): the
// decisions (request-decline, request-fulfilled) freeze and clear Bluesky
// endorsements only when the target env sets BLUESKY_LOGIN = "true" (with
// --local, .dev.vars counts too) and binds SIREN_DB. Otherwise they write the
// decision and touch no database, as before endorsements existed. With the
// flag on and D1 failing, they refuse before writing anything.
// --endorsements freezes and clears whenever SIREN_DB is bound, whatever the
// flag says (for endorsements left from before the flag was turned off);
// --no-endorsements never touches D1. `endorsements`, `endorsements-clear`
// and `endorsements-purge` need only the binding: with the flag off the
// Worker deletes nothing, so `endorsements-purge` is how the retention
// promised on the requests page keeps holding (docs/bluesky-endorsements.md,
// "Turning the flag off").
//
// The env's config is read through wrangler's unstable_readConfig and
// unstable_getVarsForDev. If a wrangler upgrade breaks them, decisions fail
// before writing anything; --no-endorsements (no D1) or --endorsements (D1
// whenever wrangler finds SIREN_DB) decide without them.
//
// Each browser or device that redeems a code uses one of its --uses (default
// 3). Codes are stored only as hashes, so a lost code can't be looked up
// again: revoke it by the hash `list` prints, and make a new one. Keep the
// waitlist CSV private and outside the repository; it holds people's email
// addresses.

import { execFileSync } from 'node:child_process';
import { newCode, inviteKey, sha256hex, csvField as csv } from '../worker/invites.js';
import { withStatus, withNoteReview, normalizeRecord, publicId, deletedKey, decisionKey, decisionOf, stewardView, withDeleted, freezeAtDecision, idKey, pidKey, idsOf, newPublicId, PUBLIC_ID_RE } from '../worker/requests.js';

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

class ConfigReadError extends Error {
  constructor(cause) {
    super(`Couldn't read env "${env}" from the wrangler config (${String(cause?.message || cause).split('\n')[0]}). Nothing was written. `
      + "If wrangler's config API changed in an upgrade, decide with --no-endorsements (no D1) or --endorsements (freeze and clear through `wrangler d1 execute`).");
  }
}

// Where the target env stands on endorsements, from its wrangler config:
// { flag, bound }. Read with wrangler's own config reader, so env
// inheritance and JSON configs work as they do for deploys.
let endorseConfig;
async function endorsementConfig() {
  if (endorseConfig) return endorseConfig;
  let wranglerApi;
  try {
    wranglerApi = await import('wrangler');
  } catch {
    throw new Error("Can't read the wrangler config: run `npm install` first (wrangler is a dev dependency).");
  }
  try {
    const { unstable_readConfig: readConfig, unstable_getVarsForDev: varsForDev } = wranglerApi;
    const config = readConfig({ config: opt('config'), env }, { hideWarnings: true });
    let vars = config.vars || {};
    if (where === '--local') {
      const dev = varsForDev(config.configPath, undefined, vars, env, true);
      vars = Object.fromEntries(Object.entries(dev).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v]));
    }
    endorseConfig = {
      flag: vars.BLUESKY_LOGIN === 'true',
      bound: (config.d1_databases || []).some((d) => d.binding === 'SIREN_DB'),
    };
  } catch (err) {
    throw new ConfigReadError(err);
  }
  return endorseConfig;
}

// Should a decision freeze and clear endorsements? See the header.
async function decisionTouchesD1() {
  if (flag('no-endorsements')) return false;
  if (flag('endorsements')) {
    let bound;
    try {
      ({ bound } = await endorsementConfig());
    } catch (err) {
      if (!(err instanceof ConfigReadError)) throw err;
      return true; // wrangler d1 execute fails on its own, before any write, if SIREN_DB isn't bound
    }
    if (!bound) throw new Error(`--endorsements: env "${env}" binds no SIREN_DB in its wrangler config. Nothing was decided.`);
    return true;
  }
  const { flag: on, bound } = await endorsementConfig();
  return on && bound;
}

async function needD1() {
  if (!(await endorsementConfig()).bound) throw new Error(`Env "${env}" binds no SIREN_DB in its wrangler config, so there are no Bluesky endorsements to read (docs/bluesky-endorsements.md, "Setting up the database").`);
}

// Bluesky endorsement tallies, after deleting rows past their expiry:
// Map(id -> { n, young, unknown }), for one request or all.
function endorsementTally(id) {
  const now = sqlInt(Math.floor(Date.now() / 1000));
  const where = id ? ` WHERE request_id = ${sqlId(id)}` : '';
  const [, rows = []] = d1(`DELETE FROM endorsements WHERE exp <= ${now}; SELECT request_id, n, young, unknown FROM endorsement_counts${where}`);
  return new Map(rows.map((r) => [r.request_id, { n: Number(r.n) || 0, young: Number(r.young) || 0, unknown: Number(r.unknown) || 0 }]));
}

// Delete Bluesky rows whose expiry is at or before `cutoff` (seconds), as the
// Worker's purgeExpired does: at most PURGE_ROWS of each kind per statement,
// repeated until a round comes up short. The steward's own deletes aren't
// charged to the Worker's daily D1 budget (siren_d1_budget); they're run by
// hand, and print what they delete. Counted by RETURNING, since D1's
// meta.changes also counts the tally triggers. -> rows deleted, by kind
const PURGE_ROWS = 500;
function purgeBefore(cutoff) {
  const t = sqlInt(cutoff);
  const total = { endorsements: 0, rates: 0, budget: 0 };
  for (let round = 0; round < 200; round++) {
    const out = d1([
      `DELETE FROM endorsements WHERE eh IN (SELECT eh FROM endorsements INDEXED BY endorsements_exp WHERE exp <= ${t} LIMIT ${PURGE_ROWS}) RETURNING eh`,
      `DELETE FROM bsky_rate_counts WHERE k IN (SELECT k FROM bsky_rate_counts INDEXED BY bsky_rate_counts_exp WHERE exp <= ${t} LIMIT ${PURGE_ROWS}) RETURNING k`,
      `DELETE FROM siren_d1_budget WHERE exp <= ${t} RETURNING day`,
    ].join('; '));
    const n = [out[0] || [], out[1] || [], out[2] || []].map((r) => r.length);
    total.endorsements += n[0];
    total.rates += n[1];
    total.budget += n[2];
    if (n.every((x) => x < PURGE_ROWS)) break;
  }
  return total;
}

// Delete every endorsement on one request (the tallies follow by trigger).
function clearEndorsements(id) {
  d1(`DELETE FROM endorsements WHERE request_id = ${sqlId(id)}`);
}

// One request by the id `requests` prints, with the same rules the Worker
// uses (worker/requests.js findRequest): a random id through its reverse
// index; a legacy hex id (or a longer prefix of the hash) by key prefix,
// exactly one match, and only while that request has no random id.
// -> { key, cur, deleted, ids }
function requestById(arg) {
  const id = String(arg || '').trim().toLowerCase();
  let key;
  if (PUBLIC_ID_RE.test(id)) {
    if (!exists(pidKey(id))) throw new Error('No request has that id.');
    const hash = dry ? '0'.repeat(64) : wrangler(['get', pidKey(id), '--text']).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('No request has that id.');
    key = `request:${hash}`;
  } else if (/^[0-9a-f]{6,64}$/.test(id)) {
    const matches = JSON.parse(wrangler(['list', '--prefix', `request:${id}`]) || '[]');
    if (matches.length !== 1) throw new Error(matches.length ? 'That id matches more than one request; use more of it.' : 'No request has that id.');
    key = matches[0].name;
  } else {
    throw new Error('Give the request id from `requests` (the first column).');
  }
  // As every reader sees it: the side keys laid over the record.
  const { r: cur, deleted, ids } = readRequest(key);
  if (PUBLIC_ID_RE.test(id) ? ids.id !== id : ids.assigned) {
    throw new Error(ids.assigned ? `That request now has the id ${ids.id}; use that.` : 'No request has that id.');
  }
  return { key, cur, deleted, ids };
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

// The side keys of one request that exist: its tombstone, its decision and its id.
const sideKeysOf = (key) => new Set([...keyNames(deletedKey(key)), ...keyNames(decisionKey(key)), ...keyNames(idKey(key))]);

// A request record as the Worker reads it: deleted notes dropped and the
// stored decision laid over it (see worker/requests.js). `sides` is the set
// of side keys that exist (sideKeysOf, or one listing for every request);
// only those are read, and a failed read throws, so a failed read never
// stands in for an empty tombstone that a delete would overwrite.
function readRequest(key, sides = sideKeysOf(key)) {
  const r = JSON.parse(wrangler(['get', key, '--text']) || '{}');
  const deleted = readOptionalJson(deletedKey(key), sides);
  const decision = readOptionalJson(decisionKey(key), sides);
  const ids = idsOf(key, readOptionalJson(idKey(key), sides));
  return { r: stewardView(r, Array.isArray(deleted) ? deleted : [], decision), deleted: Array.isArray(deleted) ? deleted : [], ids };
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
    const sides = new Set([...keyNames('request-deleted:'), ...keyNames('request-decision:'), ...keyNames('request-id:')]);
    const rows = keys.map(({ name }) => {
      const read = readRequest(name, sides);
      return [name, normalizeRecord(read.r), read.ids];
    }).sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
    const only = opt('status', '');
    for (const [, r, ids] of rows) {
      if (only && (r.status || 'new') !== only) continue;
      console.log(`${ids.id.padEnd(16)}  ${String(r.status || 'new').padEnd(9)} ${String(r.count).padStart(4)}  ${r.source}${r.url ? `  <${r.url}>` : ''}  (last ${r.last || ''})`);
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
    // (docs/request-sync-routine.md), and until then by hand. Declining or
    // fulfilling freezes the Bluesky endorsement count into the decision,
    // then deletes the per-account endorsement rows, as the Worker does, when
    // the env has endorsements switched on (see the header).
    const { key, cur } = requestById(argv[1]);
    const status = { 'request-accept': 'accepted', 'request-decline': 'declined', 'request-fulfilled': 'fulfilled', 'request-reopen': 'accepted' }[cmd];
    const decided = status === 'declined' || status === 'fulfilled';
    const tally = decided && (await decisionTouchesD1()) ? (endorsementTally(publicId(key)).get(publicId(key)) || { n: 0, young: 0, unknown: 0 }) : null;
    const next = withStatus(cur, status, { steward_note: opt('note', ''), fulfilled_by: cmd === 'request-fulfilled' ? opt('by', '') : '' });
    if (cmd === 'request-fulfilled' && !next.fulfilled_by) throw new Error('Give --by <link to the merged PR or commit>.');
    const live = tally ? { n: tally.n, young: tally.young, unknown: tally.unknown } : undefined;
    const frozen = freezeAtDecision(cur, status, live);
    if (frozen) next.endorsements_at_decision = frozen;
    // The decision first, which raises never write, so a stale raise can't undo it.
    wrangler(['put', decisionKey(key), JSON.stringify(decisionOf(next))]);
    wrangler(['put', key, JSON.stringify(next)]);
    if (tally && tally.n) clearEndorsements(publicId(key));
    console.error(`${cur.source}: ${cur.status || 'new'} -> ${status}.${tally ? ` ${tally.n} endorsement${tally.n === 1 ? '' : 's'} frozen and cleared.` : ''}`);
  } else if (cmd === 'endorsements') {
    // Per-request Bluesky endorsement totals. Nothing here can say who endorsed.
    await needD1();
    const counts = endorsementTally();
    for (const [id, c] of [...counts].sort((a, b) => b[1].n - a[1].n)) console.log(`${id}  ${String(c.n).padStart(4)}  (${c.young} young, ${c.unknown} unknown age)`);
    if (!counts.size) console.error('No Bluesky endorsements.');
  } else if (cmd === 'endorsements-clear') {
    // For brigading: delete every endorsement on one request.
    await needD1();
    const { key, cur } = requestById(argv[1]);
    const c = endorsementTally(publicId(key)).get(publicId(key));
    clearEndorsements(publicId(key));
    console.error(`${cur.source}: ${c?.n || 0} endorsement${c?.n === 1 ? '' : 's'} cleared.`);
  } else if (cmd === 'endorsements-purge') {
    // Retention without the Worker: expired rows by default, every Bluesky row
    // with --all (when the feature is being switched off for good, or the
    // flag is off and the steward won't keep purging).
    await needD1();
    let cutoff = Math.floor(Date.now() / 1000);
    if (flag('all')) {
      if ((await endorsementConfig()).flag) throw new Error(`Env "${env}" still sets BLUESKY_LOGIN = "true", so new rows would keep arriving. Deploy with the flag off first, then purge. Nothing was deleted.`);
      const counts = endorsementTally();
      for (const [id, c] of counts) console.log(`${id}  ${String(c.n).padStart(4)}  deleting (${c.young} young, ${c.unknown} unknown age)`);
      cutoff = Number.MAX_SAFE_INTEGER;
    }
    const n = purgeBefore(cutoff);
    console.error(!dry ? `Deleted ${n.endorsements} endorsement${n.endorsements === 1 ? '' : 's'}, ${n.rates} rate counter${n.rates === 1 ? '' : 's'} and ${n.budget} daily budget row${n.budget === 1 ? '' : 's'}${flag('all') ? ': every Bluesky row' : ' past their expiry'}.` : 'Dry run: nothing deleted.');
  } else if (cmd === 'request-note') {
    // Review one note: approve shows it publicly (if written under the public
    // notice) once the request is accepted; delete removes it from storage.
    // A note already synced to GitHub stays in the issue's edit history; for
    // text that names a person or a home, delete the issue by hand.
    const id = String(argv[1] || '').trim().toLowerCase();
    const noteId = String(argv[2] || '').trim().toLowerCase();
    const action = String(argv[3] || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6,64}$/.test(id) && !PUBLIC_ID_RE.test(id)) throw new Error('Give the request id from `requests` (the first column).');
    if (!/^[0-9a-z-]{1,24}$/.test(noteId)) throw new Error('Give the note id from `requests` (the first column under the request).');
    const { key, cur, deleted } = requestById(id);
    const next = withNoteReview(cur, noteId, action);
    // The tombstone first, so a raise that read a stale copy can't bring the note back.
    if (action === 'delete') wrangler(['put', deletedKey(key), JSON.stringify(withDeleted(deleted, noteId))]);
    wrangler(['put', key, JSON.stringify(next)]);
    console.error(`${cur.source}: note ${noteId} ${action === 'delete' ? 'deleted' : 'approved'}.`);
  } else if (cmd === 'request-ids') {
    // One time (Jason, 2026-11-09): every request from before random ids gets
    // one, so no public id is a hash anyone can recompute from a guessed
    // source. Prints the plan; writes only with --apply. A request that has
    // been public keeps its legacy id as `formerly`: that id is already in
    // its GitHub issue's marker, and the sync matches on it, so the issue is
    // updated, not duplicated. Run it before turning on endorsements, since
    // an endorsement points at the id. The Worker's reads never write ids.
    const keys = JSON.parse(wrangler(['list', '--prefix', 'request:']) || '[]');
    const sides = new Set([...keyNames('request-deleted:'), ...keyNames('request-decision:'), ...keyNames('request-id:')]);
    const apply = flag('apply');
    let n = 0;
    for (const { name } of keys) {
      if (sides.has(idKey(name))) continue;
      const { r } = readRequest(name, sides);
      const wasPublic = r.was_public === true || r.status === 'accepted' || r.status === 'fulfilled';
      const id = newPublicId();
      const rec = { id, ...(wasPublic ? { formerly: publicId(name) } : {}) };
      n++;
      console.log(`${publicId(name)} -> ${id}${wasPublic ? '  (was public: the old id stays as its issue marker)' : ''}`);
      if (apply) {
        // The reverse index first: an id record never points at nothing.
        wrangler(['put', pidKey(id), name.slice('request:'.length)]);
        wrangler(['put', idKey(name), JSON.stringify(rec)]);
      }
    }
    console.error(n === 0 ? 'Every request already has a random id. Nothing to do.'
      : apply ? `Gave ${n} request${n === 1 ? '' : 's'} a random id. Run the issue sync (docs/request-sync-routine.md) to put the new ids in the issue bodies.`
        : `Dry run: ${n} request${n === 1 ? '' : 's'} would get a random id. Run again with --apply to write them.`);
  } else if (cmd === 'waitlist-remove') {
    const email = String(argv[1] || '').trim().toLowerCase();
    if (!email.includes('@')) throw new Error('Give the email address to remove.');
    const key = `waitlist:${await sha256hex(email)}`;
    if (!exists(key)) throw new Error('That email is not on the waitlist. Nothing was removed.');
    wrangler(['delete', key]);
    console.error('Removed from the waitlist.');
  } else {
    console.error('Usage: node scripts/invites.js create --label "..." [--uses N] | list | revoke <code or hash> | waitlist | waitlist-remove <email> | requests [--status new] | request-accept <id> [--note "..."] | request-decline <id> [--note "..."] | request-fulfilled <id> --by <url> | request-reopen <id> | request-note <id> <note id> approve|delete | request-ids [--apply] | endorsements | endorsements-clear <id> | endorsements-purge [--all]  [--endorsements | --no-endorsements] [--env siren] [--local] [--config file] [--dry-run]');
    process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
