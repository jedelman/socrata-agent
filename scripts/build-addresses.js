#!/usr/bin/env node
// Build a city's address list for watches: every house number on every
// street of the City's address list (Norfolk: Address Information,
// ere7-kake), with its civic league. Jason, 2026-11-16: "How do we know we're
// not getting false positives on names, since so many streets are named
// after people? (A trie whitelist built from the address db is my answer)".
// Watches use it three ways (src/watches.js, docs/watches.md):
// - an agenda item's address reaches a description only when that house
//   number is on that street in this list, so a title's words that only look
//   like an address ("5 Years With Robert Street") never do;
// - an item's civic league comes from here, so the daily job asks the portal
//   nothing per address;
// - a member's phrase that is a street's name ("hampton", which the
//   common-names guard refuses) is watched as a street: it matches items
//   whose listed address is on that street, never title text, so it can't
//   follow a person of that name.
//
//   node scripts/build-addresses.js [--city norfolk]      read the portal, write the file
//   node scripts/build-addresses.js --compare <earlier.json> [--result <out.json>]
//                                                         say what changed against an
//                                                         earlier file (no network); the
//                                                         weekly refresh uses it to decide
//
// Writes data/<city>-addresses.json: the leagues, and per street (the City's
// own spelling) its house numbers, each with the index of its league ("120:7"),
// or none ("120"). Reads two columns only, full_address and civic_league,
// through the traced Socrata client at GENERIC access; never a name, an
// owner, a parcel or the league president's contact. Grouped, so the many
// rows one address has (units, parcels) are one.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createContext } from '../src/agent.js';
import { getCity } from '../src/cities/index.js';
import { ACCESS } from '../src/socrata.js';
import { cityAddressParts, NO_LEAGUE } from '../src/watches.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 500;
const MAX_PAGES = 400;
const SHRINK = 0.02;

export const addressesPath = (cityId) => `data/${cityId}-addresses.json`;

/**
 * Read the City's address list and build the file's object. `rows` (tests)
 * stands in for the portal: [{ full_address, civic_league }].
 */
export async function buildAddresses({ cityId = 'norfolk', appToken, fetchImpl, today = new Date().toISOString().slice(0, 10), rows = null } = {}) {
  const city = getCity(cityId);
  const cfg = city.address;
  if (!cfg?.fields?.full || !cfg.fields.league) throw new Error(`${cityId} has no address list with a league column.`);
  const full = cfg.fields.full;
  const league = cfg.fields.league;
  let read = rows;
  if (!read) {
    const ctx = createContext({ city, appToken, fetchImpl });
    read = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await ctx.socrata.query(
        cfg.dataset,
        `SELECT ${full}, ${league}, count(*) AS n WHERE ${full} IS NOT NULL GROUP BY ${full}, ${league} ORDER BY ${full}, ${league} LIMIT ${PAGE} OFFSET ${page * PAGE}`,
        { tool: 'address list for watches', access: ACCESS.GENERIC, name: cfg.name }
      );
      read.push(...got.map((r) => ({ full_address: r[full], civic_league: r[league] })));
      if (got.length < PAGE) break;
      if (page === MAX_PAGES - 1) throw new Error(`More than ${MAX_PAGES * PAGE} addresses: raise MAX_PAGES after checking why.`);
    }
  }
  const leagueNames = [...new Set(read.map((r) => String(r.civic_league ?? '').trim()).filter((l) => l && !NO_LEAGUE.test(l)))].sort();
  const li = new Map(leagueNames.map((l, i) => [l, i]));
  const streets = new Map();
  let skipped = 0;
  for (const r of read) {
    const p = cityAddressParts(r.full_address);
    if (!p) {
      skipped++;
      continue;
    }
    if (!streets.has(p.street)) streets.set(p.street, new Map());
    const nums = streets.get(p.street);
    if (!nums.has(p.num)) nums.set(p.num, new Set());
    const l = li.get(String(r.civic_league ?? '').trim());
    if (l != null) nums.get(p.num).add(l);
  }
  const byNumber = (a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
  const out = {};
  let addresses = 0;
  let twoLeagues = 0;
  for (const street of [...streets.keys()].sort()) {
    const nums = streets.get(street);
    out[street] = [...nums.keys()].sort(byNumber).map((n) => {
      addresses++;
      const ls = [...nums.get(n)].sort((a, b) => a - b);
      if (ls.length > 1) twoLeagues++;
      return ls.length ? `${n}:${ls.join(',')}` : n;
    }).join(' ');
  }
  return {
    city: cityId,
    built: today,
    source: { dataset: cfg.dataset, name: cfg.name, fields: [full, league] },
    note: "Every house number on every street of the City's address list, with the index of its civic league (\"120:7\"; none for \"120\"). Used only to check that an agenda item's address is a City address, to tag its civic league, and to recognize a street's name in a watch. Holds no names.",
    counts: { addresses, streets: streets.size, leagues: leagueNames.length, in_two_leagues: twoLeagues, skipped },
    leagues: leagueNames,
    streets: out,
  };
}

/** The file as written: one street a line, so a weekly diff reads street by street. */
export function stringify(file) {
  const { streets, ...head } = file;
  const lines = Object.entries(streets).map(([s, v]) => `    ${JSON.stringify(s)}: ${JSON.stringify(v)}`);
  const top = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  return `${top},\n  "streets": {\n${lines.join(',\n')}\n  }\n}\n`;
}

/**
 * What changed from `before` to `after`: { changed, leagues_changed,
 * added_leagues, removed_leagues, addresses_added, addresses_removed,
 * league_moves, shrank, decision }. The weekly refresh commits to main when
 * only addresses came and went or moved league; a league added, removed or
 * renamed changes a feed's address, and more than 2% of addresses gone
 * looks like a short read, so either goes to a pull request.
 */
export function compareAddresses(before, after) {
  const set = (f) => {
    const m = new Map();
    for (const [s, v] of Object.entries(f?.streets || {})) {
      for (const tok of String(v).split(' ').filter(Boolean)) {
        const [n, ls = ''] = tok.split(':');
        m.set(`${n} ${s}`, ls.split(',').filter(Boolean).map((i) => f.leagues[Number(i)]).sort().join('|'));
      }
    }
    return m;
  };
  const a = set(before);
  const b = set(after);
  let added = 0;
  let removed = 0;
  let moves = 0;
  for (const [k, l] of b) {
    if (!a.has(k)) added++;
    else if (a.get(k) !== l) moves++;
  }
  for (const k of a.keys()) if (!b.has(k)) removed++;
  const was = new Set(before?.leagues || []);
  const now = new Set(after?.leagues || []);
  const addedLeagues = [...now].filter((l) => !was.has(l));
  const removedLeagues = [...was].filter((l) => !now.has(l));
  const leaguesChanged = addedLeagues.length > 0 || removedLeagues.length > 0;
  const changed = leaguesChanged || added > 0 || removed > 0 || moves > 0;
  // A short read (a page the portal cut off) would drop addresses wholesale; more than 2% gone waits for a person.
  const shrank = removed > SHRINK * a.size;
  return {
    changed,
    leagues_changed: leaguesChanged,
    shrank,
    added_leagues: addedLeagues,
    removed_leagues: removedLeagues,
    addresses_added: added,
    addresses_removed: removed,
    league_moves: moves,
    decision: !changed ? 'none' : leaguesChanged || shrank ? 'pr' : 'main',
  };
}

export function summary(c, after) {
  if (!c.changed) return 'No change to the address list.';
  const lines = [
    `Addresses: ${after.counts.addresses} on ${after.counts.streets} streets (${c.addresses_added} added, ${c.addresses_removed} removed, ${c.league_moves} moved civic league).`,
  ];
  if (c.added_leagues.length) lines.push(`Civic leagues added: ${c.added_leagues.join(', ')}.`);
  if (c.removed_leagues.length) lines.push(`Civic leagues removed: ${c.removed_leagues.join(', ')}.`);
  if (c.leagues_changed) lines.push('A civic league added, removed or renamed changes a feed address (/feeds/<league>.atom), and a watch naming a removed league stops matching, so this waits for review.');
  if (c.shrank) lines.push(`More than ${SHRINK * 100}% of the addresses are gone, which looks more like a short read from the portal than the City's list, so this waits for review.`);
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs({ options: { city: { type: 'string', default: 'norfolk' }, compare: { type: 'string' }, result: { type: 'string' } } });
  const path = join(ROOT, addressesPath(values.city));
  if (values.compare) {
    const before = JSON.parse(readFileSync(values.compare, 'utf8'));
    const after = JSON.parse(readFileSync(path, 'utf8'));
    const c = compareAddresses(before, after);
    if (values.result) writeFileSync(values.result, JSON.stringify(c, null, 2));
    console.log(summary(c, after));
    return;
  }
  const file = await buildAddresses({ cityId: values.city, appToken: process.env.SOCRATA_APP_TOKEN });
  if (!file.counts.addresses || !file.counts.leagues) throw new Error('The address list came back empty; nothing written.');
  const before = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  writeFileSync(path, stringify(file));
  const c = before ? compareAddresses(before, file) : null;
  console.log(`${addressesPath(values.city)}: ${file.counts.addresses} addresses on ${file.counts.streets} streets, ${file.counts.leagues} civic leagues (${file.counts.in_two_leagues} addresses in two, ${file.counts.skipped} rows with no house number).`);
  if (c) console.log(summary(c, file));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
