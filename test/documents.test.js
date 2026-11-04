// Documents: ordinances split into sections from the City's PDF, searched and
// read by section, with the PDF's CID and "current through" date carried along.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripRunning, tableOfContents, splitSections, searchSections, readSection, pageAt, pageLink, terms } from '../src/documents.js';
import { buildDocument } from '../scripts/ingest-document.js';
import { checkPlugin } from './conformance.js';
import { getCity } from '../src/cities/index.js';
import ordinances, { DOCUMENTS } from '../plugins/ordinances.js';

const R = ' '.repeat(50);
const foot = 'October 2026' + ' '.repeat(40) + 'Norfolk, VA\nAdopted January 23, 2018';
const pages = [
  'Zoning Ordinance\nAdopted January 23, 2018',
  [
    'TABLE OF CONTENTS',
    '  1.1   Title ........................................ 1-1',
    '  1.2   Trees ........................................ 1-1',
    '        1.2.1.  Purpose ............................... 1-1',
    '        1.2.2.  Removal of Healthy Trees on Land Being',
    '                Developed ............................. 1-2',
  ].join('\n'),
  ['Article 1: General Provisions', '1.1   Title', '1.2   Trees', '      1.2.1.   Purpose', '      1.2.2.   Removal of Healthy Trees', '      1.2.3.   Not a heading', foot].join('\n'),
  [`${R}1.1 Title`, '', '1.1 TITLE', '      This Ordinance is the Zoning Ordinance.', '', '1.2 TREES', '', '      1.2.1.   PURPOSE', '               Trees shade the city.', foot].join('\n'),
  [`${R}1.2.1 Purpose`, '               The canopy goal is 30%.', '', '      1.2.2.   REMOVAL OF HEALTHY TREES ON LAND BEING', '               DEVELOPED', '               A healthy tree may be removed only with a permit.', foot].join('\n'),
  [`${R}1.2.2 Removal`, '               Replacement trees shall be planted.', foot].join('\n'),
];

test('running headers and footers come off every page', () => {
  const out = stripRunning(pages).join('\n');
  assert.doesNotMatch(out, /Norfolk, VA/);
  assert.doesNotMatch(out, /Adopted January/);
  assert.doesNotMatch(out, / {40}1\.1 Title/);
  assert.match(out, /1\.1 TITLE/);
});

test('the contents give numbers and clean titles, including a wrapped one', () => {
  const toc = tableOfContents(pages);
  assert.equal(toc.get('1.2').title, 'Trees');
  assert.equal(toc.get('1.2.2').title, 'Removal of Healthy Trees on Land Being Developed');
  assert.equal(toc.get('1.2.2').label, '1-2');
  assert.equal(toc.has('1.2.3'), false);
});

test('sections start at capitalized headings the contents list, with their pages', () => {
  const s = splitSections(pages);
  assert.deepEqual(s.map((x) => x.number), ['1.1', '1.2', '1.2.1', '1.2.2']);
  const purpose = s.find((x) => x.number === '1.2.1');
  assert.deepEqual(purpose.pages, [4, 5]);
  assert.match(purpose.text, /^Trees shade the city\.\nThe canopy goal is 30%\.$/);
  assert.equal(pageAt(purpose, purpose.text.indexOf('canopy')), 5);
  const removal = s.find((x) => x.number === '1.2.2');
  assert.equal(removal.title, 'Removal of Healthy Trees on Land Being Developed');
  assert.doesNotMatch(s.map((x) => x.text).join('\n'), /Not a heading|Article 1/, 'the contents page inside the body is left out');
});

test('search ranks by passage, matches word forms, and names the page of the excerpt', () => {
  const doc = { source: { url: 'https://example.gov/z.pdf' }, sections: splitSections(pages) };
  const r = searchSections(doc, 'removing a tree');
  assert.equal(r[0].number, '1.2.2');
  assert.match(r[0].excerpt, /tree/i);
  assert.deepEqual(terms('Trees and policies'), ['tree', 'policy']);
  assert.equal(searchSections(doc, 'canopy')[0].page, 5);
  assert.deepEqual(searchSections(doc, 'the of and'), []);
  assert.equal(pageLink(doc, 5), 'https://example.gov/z.pdf#page=5');
});

test('reading a section brings its subsections, windowed', () => {
  const doc = { sections: splitSections(pages) };
  const s = readSection(doc, '§1.2');
  assert.deepEqual(s.subsections, ['1.2.1 Purpose', '1.2.2 Removal of Healthy Trees on Land Being Developed']);
  assert.deepEqual(s.pages, [4, 6]);
  assert.match(s.text, /1\.2\.2 Removal[\s\S]*Replacement trees/);
  const part = readSection(doc, '1.2', { max: 20 });
  assert.equal(part.continues, true);
  assert.equal(readSection(doc, '1.2', { offset: part.next_offset, max: 20 }).text, s.text.slice(20, 40));
  assert.equal(readSection(doc, '9.9'), null);
  assert.deepEqual(readSection(doc, '1.2.'), readSection(doc, '1.2'));
});

test('the ingest records the PDF it read and refuses missing tags or a text-less PDF', () => {
  const tags = { id: 'demo-ordinance', title: 'Demo', enacted: 'Council, 2018', 'current-through': 'updated 2026', url: 'https://example.gov/z.pdf' };
  const text = pages.join('\f') + '\f' + ' filler'.repeat(200);
  const doc = buildDocument({ bytes: Buffer.from('hello'), text, tags, extractor: 'pdftotext -layout', retrieved: '2026-11-04T00:00:00Z', retrievedBy: 'test' });
  assert.equal(doc.source.cid, 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq');
  assert.equal(doc.source.pages, 7);
  assert.equal(doc.jurisdiction, 'ocd-division/country:us/state:va/place:norfolk');
  assert.equal(doc.current_through, 'updated 2026');
  assert.throws(() => buildDocument({ bytes: Buffer.from('x'), text, tags: { ...tags, url: undefined } }), /--url is required/);
  assert.throws(() => buildDocument({ bytes: Buffer.from('x'), text, tags: { ...tags, id: 'Bad Id' } }), /--id/);
  assert.throws(() => buildDocument({ bytes: Buffer.from('x'), text: pages.join('\f'), tags }), /scanned PDF/);
});

test('ordinance_lookup finds Norfolk\'s tree rules, cites the page, and traces the read', async () => {
  const zoning = DOCUMENTS['norfolk-zoning-ordinance'];
  assert.match(zoning.source.cid, /^bafkrei[a-z2-7]{52}$/);
  const city = getCity('norfolk');
  const respond = () => {
    throw new Error('no network');
  };
  const found = await checkPlugin(ordinances, { city, args: { document: zoning.id, query: 'tree preservation' }, respond });
  assert.equal(found.result.results[0].section, '§5.6.4');
  assert.match(found.result.results[0].link, /#page=\d+$/);
  assert.equal(found.trace[0].tool, 'search the Zoning Ordinance');
  assert.equal(found.requests.length, 0);
  const read = await checkPlugin(ordinances, { city, args: { document: zoning.id, section: '5.6.1' }, respond });
  assert.match(read.result.text, /minimum aggregate tree canopy of\s+30%/);
  assert.ok(read.resources.records.some((r) => r.url.endsWith(`#page=${read.result.pages[0]}`)));
  const none = await checkPlugin(ordinances, { city, args: { document: zoning.id, section: '99.1' }, respond });
  assert.match(none.result.error, /No section 99\.1/);
  const empty = await checkPlugin(ordinances, { city, args: { document: zoning.id } , respond });
  assert.match(empty.result.error, /Give query/);
});
