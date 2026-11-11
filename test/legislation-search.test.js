// find_legislation's matching (src/block.js searchLegislation). Jason,
// 2026-11-11, asking why Siren missed MacArthur: "MacArthur Mall" found the two
// items that say "Mall" and none of the ones that say "MacArthur Center".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchLegislation } from '../src/block.js';

const item = (id, text, date) => ({ id, text, addresses: [], meetings: [{ id: `m${id}`, body: 'City Council', date }] });
const filler = Array.from({ length: 30 }, (_, i) => item(`f${i}`, `Ordinance No. ${i} : An Ordinance Approving a Street Encroachment`, '2024-01-01'));
const index = {
  built: '2026-11-09',
  items: [
    item('1', 'Ordinance No. 49302 : Purchase of Dillard\'s Store Located at Macarthur Mall', '2023-08-29'),
    item('2', 'Ordinance No. 50282 : Lease Termination for Space No. 241 in MacArthur Center', '2026-02-10'),
    item('3', 'Ordinance No. 50170 : First Amendment to Lease, Store Number 147, MacArthur Center', '2025-10-28'),
    item('4', 'Ordinance No. 50460 : Amend the Zoning Ordinance for Small Businesses', '2026-08-25'),
    item('5', 'Ordinance No. 50345 : Appropriation for the Military Circle Mall site', '2026-04-28'),
    item('7', 'Ordinance No. 50100 : Military Circle Mall Demolition Contract', '2025-06-10'),
    item('8', 'Ordinance No. 50101 : Military Circle Mall Security Contract', '2025-06-10'),
    item('6', 'An Ordinance Granting a Conditional Use Permit to Authorize a Short-Term Rental', '2026-10-22'),
    ...filler,
  ],
};
const ids = (q) => searchLegislation(index, q).map((x) => x.id);

test('every word first; then at least half the words, marked, so a name spelled two ways still turns up', () => {
  const r = searchLegislation(index, 'MacArthur Mall');
  assert.equal(r[0].id, '1');
  assert.equal(r[0].matched, undefined);
  // "Mall" is in a tenth of these items (4 of 39), so it can't match on its own: the other malls stay out.
  assert.deepEqual(r.map((x) => x.id), ['1', '2', '3']);
  assert.equal(r[1].matched, '1 of 2 words: macarthur');
  // With fewer malls, "Mall" matches alone too, and being the rarer word here (2 items against 3), it ranks first among partial matches.
  const few = { items: index.items.filter((x) => !['7', '8'].includes(x.id)) };
  assert.deepEqual(searchLegislation(few, 'MacArthur Mall').map((x) => [x.id, x.matched ?? 'all']), [['1', 'all'], ['5', '1 of 2 words: mall'], ['2', '1 of 2 words: macarthur'], ['3', '1 of 2 words: macarthur']]);
});

test('whole words or their start: "Mall" never finds "Small", "Rental" finds "Short-Term Rental"', () => {
  assert.ok(!ids('Mall').includes('4'));
  assert.deepEqual(ids('short term rental'), ['6']);
  assert.deepEqual(ids('rent'), ['6']);
});

test('a word in a tenth or more of the items can\'t match on its own', () => {
  // "Ordinance" and "Street" are everywhere; "Dillard" is not.
  assert.deepEqual(ids('Dillard Street'), ['1']);
  assert.deepEqual(ids('Ordinance Street').length, 15);
  assert.deepEqual(ids('Encroachment Zoning').slice(0, 1), ['4']);
});

test('ties go to the most recent meeting; at most 15 results', () => {
  const r = searchLegislation(index, 'MacArthur Center');
  assert.deepEqual(r.map((x) => x.id), ['2', '3', '1']);
  assert.equal(r[2].matched, '1 of 2 words: macarthur');
  assert.equal(searchLegislation(index, 'encroachment').length, 15);
});
