// The address list watches check agenda addresses against
// (scripts/build-addresses.js; Jason, 2026-11-16: "A trie whitelist built
// from the address db"): it reads two columns only, the file it writes
// compiles back to the same lookups, and the weekly refresh sends a league
// change or a short read to a pull request.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildAddresses, stringify, compareAddresses } from '../scripts/build-addresses.js';
import { compileAddresses } from '../src/watches.js';
import addressesFile from '../data/norfolk-addresses.json' with { type: 'json' };

const ROWS = [
  { full_address: '4200 COLLEY AVENUE', civic_league: 'Ghent' },
  { full_address: '4200 COLLEY AVENUE', civic_league: 'Ghent' },
  { full_address: '100 COLLEY AVENUE', civic_league: 'No Civic League' },
  { full_address: '1210 GRANBY STREET', civic_league: 'Willoughby' },
  { full_address: '226 E MAIN STREET', civic_league: null },
  { full_address: 'NO ADDRESS', civic_league: 'Ghent' },
];

test('the build reads the full address and the civic league only, grouped, at the open-ended access level', async () => {
  const urls = [];
  const fetchImpl = async (input) => {
    const url = String(input?.url || input);
    urls.push(url);
    if (url.includes('/api/views/ere7-kake.json')) return Response.json({ name: 'Address Information', columns: ['full_address', 'civic_league', 'civic_league_president', 'civic_league_email'].map((fieldName) => ({ fieldName, dataTypeName: 'text' })) });
    // Two rows a page, whatever the query asked for: the build pages by what came back, until a page is empty.
    const offset = Number(/OFFSET\s+(\d+)/.exec(decodeURIComponent(url))?.[1] || 0);
    return Response.json(ROWS.slice(offset, offset + 2).map((r) => ({ ...r, n: '1' })));
  };
  const file = await buildAddresses({ fetchImpl, today: '2026-11-16' });
  const q = decodeURIComponent(urls.find((u) => u.includes('/resource/ere7-kake.json')));
  assert.match(q, /SELECT full_address, civic_league, count\(\*\) AS n WHERE full_address IS NOT NULL GROUP BY full_address, civic_league/);
  assert.doesNotMatch(q, /president|email|owner|gpin/i);
  assert.deepEqual(file.leagues, ['Ghent', 'Willoughby'], '"No Civic League" is no league');
  assert.deepEqual(file.streets, { 'COLLEY AVENUE': '100 4200:0', 'E MAIN STREET': '226', 'GRANBY STREET': '1210:1' });
  assert.equal(file.counts.skipped, 1);
  assert.equal(urls.filter((u) => u.includes('/resource/ere7-kake.json')).length, 4, 'three short pages, then an empty one');
});

test('the file as written compiles back to the same lookups, one street a line', async () => {
  const file = await buildAddresses({ rows: ROWS, today: '2026-11-16' });
  const text = stringify(file);
  assert.match(text, /\n {4}"COLLEY AVENUE": "100 4200:0",\n/);
  const book = compileAddresses(JSON.parse(text));
  assert.deepEqual(book.find('4200', 'Colley Ave'), { street: 'COLLEY AVENUE', leagues: ['Ghent'] });
  assert.deepEqual(book.find('100', 'Colley Avenue'), { street: 'COLLEY AVENUE', leagues: [] });
  assert.equal(book.find('4201', 'Colley Avenue'), null);
  assert.deepEqual(book.find('226', 'Main Street'), { street: 'E MAIN STREET', leagues: [] });
  // The committed file is the builder's own output.
  assert.equal(readFileSync(new URL('../data/norfolk-addresses.json', import.meta.url), 'utf8'), stringify(addressesFile));
  assert.ok(addressesFile.counts.addresses > 70000 && addressesFile.leagues.length > 100);
});

test('the weekly decision: addresses alone go to main; a league change or a short read waits for review', async () => {
  const before = await buildAddresses({ rows: ROWS, today: '2026-11-16' });
  assert.equal(compareAddresses(before, before).decision, 'none');
  const moved = await buildAddresses({ rows: [...ROWS.slice(0, 3), { full_address: '1210 GRANBY STREET', civic_league: 'Ghent' }, { full_address: '1210 GRANBY STREET', civic_league: 'Willoughby' }, ROWS[4], { full_address: '1212 GRANBY STREET', civic_league: 'Willoughby' }], today: '2026-11-23' });
  const c = compareAddresses(before, moved);
  assert.deepEqual([c.decision, c.addresses_added, c.addresses_removed, c.league_moves], ['main', 1, 0, 1]);
  const renamed = await buildAddresses({ rows: ROWS.map((r) => (r.civic_league === 'Willoughby' ? { ...r, civic_league: 'Willoughby Spit' } : r)), today: '2026-11-23' });
  const r = compareAddresses(before, renamed);
  assert.deepEqual([r.decision, r.added_leagues, r.removed_leagues], ['pr', ['Willoughby Spit'], ['Willoughby']]);
  // More than 2% gone: a short read, not the City.
  const big = { leagues: ['A'], streets: { 'X STREET': Array.from({ length: 100 }, (_, i) => `${i + 1}:0`).join(' ') } };
  const short = { leagues: ['A'], streets: { 'X STREET': Array.from({ length: 97 }, (_, i) => `${i + 1}:0`).join(' ') } };
  assert.equal(compareAddresses(big, short).decision, 'pr');
  const two = { leagues: ['A'], streets: { 'X STREET': Array.from({ length: 98 }, (_, i) => `${i + 1}:0`).join(' ') } };
  assert.equal(compareAddresses(big, two).decision, 'main');
});
