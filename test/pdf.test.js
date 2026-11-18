// The PDF reader (src/pdf.js) and the agenda-file item parser
// (src/agenda-file.js), over PDFs written by test/fake-pdf.js in the shapes
// the City's BZA and ARB agenda files use (checked 2026-11-18 against three
// real ones, which matched pdftotext word for word but for line-break
// hyphens). The names here are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pdfText, inflate, parseCMap } from '../src/pdf.js';
import { agendaFileItems } from '../src/agenda-file.js';
import { makePdf, deflate } from './fake-pdf.js';

const BZA = [
  'PUBLIC HEARING AGENDA FOR THE CITY OF NORFOLK',
  'BOARD OF ZONING APPEALS',
  'I. Public Hearing',
  'REGULAR AGENDA',
  '1. JANE EXAMPLE - for a variance from minimum lot area of Table 3.2.9.B of the Norfolk',
  'Zoning Ordinance on property located at 2612 Munson St, zoned MF-NS (Multi-Family –',
  'Neighborhood-Scale)',
  '2. EXAMPLE HOLDINGS, LLC – for an appeal of Zoning Violation Notices on property located at',
  '7418 N Military Highway, zoned C-C (Community Commercial).',
  'Information concerning the above proposal may be seen at the office of the Department of City Planning',
];

test('reads a simple-font PDF: lines, WinAnsi characters, the page order', async () => {
  const pdf = await makePdf([BZA, ['Second page', 'II. Adjourn']]);
  const { pages, unreadable } = await pdfText(pdf);
  assert.equal(unreadable, 0);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].split('\n'), BZA);
  assert.deepEqual(pages[1].split('\n'), ['Second page', 'II. Adjourn']);
});

test('reads Word\'s shape: an Identity-H font with a ToUnicode map, objects in an object stream, cross-reference streams with no trailer', async () => {
  for (const linearized of [false, true]) {
    const pdf = await makePdf([['a. COA #26-00439 – 719 Yarmouth Street – Replace windows.'], ['b. second page']], { cid: true, objectStream: true, linearized });
    const { pages, unreadable } = await pdfText(pdf);
    assert.equal(unreadable, 0);
    assert.deepEqual(pages, ['a. COA #26-00439 – 719 Yarmouth Street – Replace windows.', 'b. second page'], `linearized ${linearized}`);
  }
});

test('spacing by glyph widths: a run that continues a word gets no space, a word gap does, a superscript stays on its line', async () => {
  const line = [{ text: 'Col' }, { text: 'ley' }, { text: 'Avenue', dx: 1 }, { text: '228 W 27' , dx: 1 }, { text: 'th', dy: 3, size: 7 }, { text: ' St', dy: 0 }];
  const { pages } = await pdfText(await makePdf([[line, 'next line']]));
  assert.deepEqual(pages[0].split('\n'), ['Colley Avenue 228 W 27th St', 'next line']);
});

test('refuses what it can\'t read honestly: not a PDF, an encrypted file', async () => {
  await assert.rejects(pdfText(new TextEncoder().encode('<html>not a pdf</html>')), /not a PDF/);
  await assert.rejects(pdfText(await makePdf([['x']], { encrypted: true })), /encrypted/);
  await assert.rejects(pdfText(await makePdf([['x']], { encrypted: true, objectStream: true })), /encrypted/);
});

test('a truncated stream still gives what came before the cut; a ToUnicode map\'s ranges', async () => {
  const z = await deflate('BT /F1 10 Tf (hello world) Tj ET '.repeat(50));
  const cut = await inflate(z.subarray(0, Math.floor(z.length * 0.6)));
  assert.ok(cut && new TextDecoder().decode(cut).startsWith('BT /F1 10 Tf (hello world)'));
  const { map, lengths } = parseCMap('1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0010> <0012> <0041> endbfrange 1 beginbfrange <0020> <0021> [<0061> <0062>] endbfrange 1 beginbfchar <0030> <00660069> endbfchar');
  assert.deepEqual(lengths, [2]);
  assert.deepEqual([map.get(0x10), map.get(0x12), map.get(0x20), map.get(0x21), map.get(0x30)], ['A', 'C', 'a', 'b', 'fi']);
});

test('agenda files: numbered and lettered items, continuation lines joined, headings and furniture closing an item, minutes dropped', () => {
  const items = agendaFileItems([
    ...BZA,
    'Next two ARB meetings: December 7, 2026 & January 11, 2027',
    'III. Approval of Meeting Minutes:',
    'a. October 19, 2026',
    'IV. Consent Agenda',
    'A. Certificate of Appropriateness',
    'a.COA #26-00429 – 530 Fairfax Avenue – Install new storm door .',
    'b. COA #26-00437 – 520 W 22nd Street – Amendment to COA #25-00330 to modify door and window',
    'openings.',
    'XII. New Business',
    'a. Presentation: West Ghent Historic District National Register Nomination',
  ].join('\n'));
  assert.deepEqual(items.map((i) => i.text), [
    'JANE EXAMPLE - for a variance from minimum lot area of Table 3.2.9.B of the Norfolk Zoning Ordinance on property located at 2612 Munson St, zoned MF-NS (Multi-Family – Neighborhood-Scale)',
    'EXAMPLE HOLDINGS, LLC – for an appeal of Zoning Violation Notices on property located at 7418 N Military Highway, zoned C-C (Community Commercial).',
    'COA #26-00429 – 530 Fairfax Avenue – Install new storm door.',
    'COA #26-00437 – 520 W 22nd Street – Amendment to COA #25-00330 to modify door and window openings.',
    'Presentation: West Ghent Historic District National Register Nomination',
  ]);
});
