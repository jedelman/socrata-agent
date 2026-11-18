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

// ---- hostile files (review 6): each finishes fast and small, or throws a catchable error ----

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const latin = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192));
  return s;
};
// objs: [[num, dict, streamBytes?]]
function rawPdf(objs) {
  let out = '%PDF-1.5\n';
  for (const [n, d, st] of objs) out += st ? `${n} 0 obj\n<< ${d.replace('LEN', st.length)} >>\nstream\n${latin(st)}\nendstream\nendobj\n` : `${n} 0 obj\n${d}\nendobj\n`;
  return enc(`${out}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);
}
const PAGE = [[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>']];
const range = (k) => Array.from({ length: k }, (_, i) => i);

test('hostile PDFs: a billion-object stream, a self-drawing form, giant font maps, an endless inline image, a run of digits', async () => {
  const cases = {
    objectStream: rawPdf([...PAGE.slice(0, 1), [2, '<< /Type /Pages /Kids [] /Count 0 >>'], [9, '/Type /ObjStm /N 1000000000 /First 4 /Length LEN /Filter /FlateDecode', await deflate('1 0 <<>>')]]),
    selfDrawingForm: rawPdf([...PAGE,
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources 6 0 R >>'],
      [4, '/Length LEN', enc('/X Do '.repeat(80) + 'BT /F1 10 Tf (x) Tj ET')],
      [5, '/Type /XObject /Subtype /Form /Resources 6 0 R /Length LEN', enc('/X Do '.repeat(80) + 'BT /F1 10 Tf (x) Tj ET')],
      [6, '<< /XObject << /X 5 0 R >> /Font << /F1 7 0 R >> >>'],
      [7, '<< /Type /Font /Subtype /TrueType /BaseFont /Arial /FirstChar 32 /Widths [500] >>']]),
    toUnicode: rawPdf([...PAGE,
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
      [4, '/Length LEN', enc('BT /F1 10 Tf <0041> Tj ET')],
      [5, '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>'],
      [6, '<< /Type /Font /Subtype /CIDFontType2 /DW 500 >>'],
      [7, '/Length LEN', enc(`1 begincodespacerange <0000> <FFFF> endcodespacerange\n60 beginbfrange\n${range(60).map((k) => `<${(k * 65536).toString(16).padStart(8, '0')}> <${(k * 65536 + 65535).toString(16).padStart(8, '0')}> <0041>`).join('\n')}\nendbfrange`)]]),
    cidWidths: rawPdf([...PAGE,
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'],
      [4, '/Length LEN', enc('BT /F1 10 Tf <0041> Tj ET')],
      [5, '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [6 0 R] >>'],
      [6, `<< /Type /Font /Subtype /CIDFontType2 /DW 500 /W [${range(60).map((k) => `${k * 65536} ${k * 65536 + 65535} 500`).join(' ')}] >>`]]),
    inlineImage: rawPdf([...PAGE,
      [3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>'],
      [4, '/Length LEN /Filter /FlateDecode', await deflate('EI BI ' + '0 '.repeat(100000))]]),
    digits: enc(`%PDF-1.5\n${'1'.repeat(160000)} `),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const t0 = performance.now();
    const out = await pdfText(bytes).catch((e) => e);
    const ms = performance.now() - t0;
    assert.ok(ms < 3000, `${name} took ${ms.toFixed(0)} ms`);
    assert.ok(out instanceof Error || Array.isArray(out.pages), name);
  }
});

test('a Flate bomb stops at the stream limit instead of inflating it all', async () => {
  const z = await deflate(' '.repeat(40 * 1024 * 1024));
  const out = await inflate(z, 1024 * 1024);
  assert.ok(!out || out.length <= 1024 * 1024, `inflated ${out?.length} bytes`);
});

test('agenda files: page breaks, direction initials, names in capitals, citations, sub-items, procedure', () => {
  const H = ['Next two ARB meetings: December 7, 2026 & January 11, 2027', 'City Hall Building, City Council Chamber 11th floor / 810 Union St, Norfolk, Virginia 23510', 'Ph. (757) 664-4752 / Fax (757) 441-1569'];
  const texts = (pages) => agendaFileItems(pages.map((p) => p.join('\n'))).map((i) => i.text);
  // An item across a page break: the next page's header is skipped, the item runs on.
  assert.deepEqual(texts([[...H, 'IV. Consent Agenda', 'a. COA #26-00439 – 719 Yarmouth Street – Replace non-historic windows with new'], [...H, 'windows and a new door at 721 Yarmouth Street.', 'b. COA #26-00438 – 419 Colonial Avenue – Installation of prefabricated shed.']]), [
    'COA #26-00439 – 719 Yarmouth Street – Replace non-historic windows with new windows and a new door at 721 Yarmouth Street.',
    'COA #26-00438 – 419 Colonial Avenue – Installation of prefabricated shed.',
  ]);
  // A footer and a header in capitals, repeated on each page.
  assert.deepEqual(texts([['BOARD OF ZONING APPEALS', 'I. Public Hearing', '1. JANE EXAMPLE – for a variance from the side yard setback of Table 3.2.9.B of the Norfolk Zoning', 'Page 1'], ['BOARD OF ZONING APPEALS', 'Ordinance on property located at 2612 Munson St, zoned R-8 (Single-Family).', 'Page 2']]), [
    'JANE EXAMPLE – for a variance from the side yard setback of Table 3.2.9.B of the Norfolk Zoning Ordinance on property located at 2612 Munson St, zoned R-8 (Single-Family).',
  ]);
  // A heading at the top of a page after a finished item still starts a new section.
  assert.deepEqual(texts([[...H, 'IV. Consent Agenda', 'a. COA #26-00439 – 719 Yarmouth Street – Replace windows.'], [...H, 'B. Design Review', 'a. DC #26-00440 – 301 S Newtown Road – New tower.']]).length, 2);
  const one = (lines) => texts([lines]);
  assert.deepEqual(one(['I. Public Hearing', '1. EXAMPLE HOLDINGS, LLC – for a special exception on property located at 7418', 'N. Military Highway, zoned C-C (Community Commercial).', '2. JOHN ROE – for a variance at 228 W 27th St.']), [
    'EXAMPLE HOLDINGS, LLC – for a special exception on property located at 7418 N. Military Highway, zoned C-C (Community Commercial).',
    'JOHN ROE – for a variance at 228 W 27th St.',
  ]);
  assert.deepEqual(one(['I. Public Hearing', '1. THE TRUSTEES OF THE EXAMPLE CHURCH OF NORFOLK AND', 'ITS SUCCESSORS, INC.', '– for a special exception on property located at 2612 Munson St.']), [
    'THE TRUSTEES OF THE EXAMPLE CHURCH OF NORFOLK AND ITS SUCCESSORS, INC. – for a special exception on property located at 2612 Munson St.',
  ]);
  assert.deepEqual(one(['I. Public Hearing', '1. JANE EXAMPLE – for a variance from the minimum side yard setback of Table', '3.2.9.B of the Norfolk Zoning Ordinance on property located at 2612 Munson St.', '2. JOHN ROE – for a variance to allow sheds and garages,', 'e.g. a detached garage, at 228 W 27th St.']), [
    'JANE EXAMPLE – for a variance from the minimum side yard setback of Table 3.2.9.B of the Norfolk Zoning Ordinance on property located at 2612 Munson St.',
    'JOHN ROE – for a variance to allow sheds and garages, e.g. a detached garage, at 228 W 27th St.',
  ]);
  // Sub-items stay with their item; a number far out of turn is a wrapped line.
  assert.deepEqual(one(['I. Public Hearing', '1. JANE EXAMPLE – for variances on property located at 2612 Munson St:', 'a. minimum side yard setback;', 'b. maximum lot coverage.', '2. JOHN ROE – for a variance on property known as Lot', '12. Block 3, at 228 W 27th St.']), [
    'JANE EXAMPLE – for variances on property located at 2612 Munson St: a. minimum side yard setback; b. maximum lot coverage.',
    'JOHN ROE – for a variance on property known as Lot 12. Block 3, at 228 W 27th St.',
  ]);
  // An entry with no number is kept when it reads as one; "Discussion of …" is business, "Discussion" alone is procedure.
  assert.deepEqual(one(['I. Public Hearing', 'JANE EXAMPLE – for a variance on property located at 2612 Munson St.', 'IX. Discussion', 'a. Discussion of the demolition of the structure at 2612 Munson St.', 'X. New Business', 'a. Discussion', 'b. Public comments from the floor']), [
    'JANE EXAMPLE – for a variance on property located at 2612 Munson St.',
    'Discussion of the demolition of the structure at 2612 Munson St.',
  ]);
});
