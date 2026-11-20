// zoning_uses and its data (Jason, 2026-11-20: "Can we make that into a tool
// since it's such a weird custom way to do zoning?"). The use tables are read
// from the City's PDF by word position (scripts/build-use-tables.js); the
// facts below were checked against images of the pages they cite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import tables from '../data/documents/norfolk-zoning-use-tables.json' with { type: 'json' };
import ordinance from '../data/documents/norfolk-zoning-ordinance.json' with { type: 'json' };
import plugin, { matchUses, districtCode, districtOf } from '../plugins/zoning-uses.js';
import { parsePage, districtsOf, districtFor, categoryRefOf, AS_PRINTED } from '../scripts/build-use-tables.js';
import { filterAnswerLinks, handoffUrls } from '../src/answer-links.js';
import siren from '../deployments/siren.config.js';

const row = (section, use) => tables.tables.find((t) => t.section === section).rows.find((r) => r.use === use);
const ctx = () => {
  const records = [];
  return { records, resources: { addRecord: (r) => records.push(r) } };
};

test('the data: seven tables from the same PDF edition as the ordinance text, every row checked against it', () => {
  assert.equal(tables.source.cid, ordinance.source.cid);
  assert.equal(tables.current_through, ordinance.current_through);
  assert.deepEqual(tables.tables.map((t) => t.section), ['3.2.12', '3.3.9', '3.4.11', '3.5.7', '3.6.11', '3.7.13', '3.9.23']);
  const rows = tables.tables.reduce((n, t) => n + t.rows.length, 0);
  assert.equal(tables.checked.rows, rows);
  assert.equal(tables.checked.unchecked, 0);
  const codes = new Set(districtsOf().map((d) => d.code));
  for (const t of tables.tables) {
    for (const d of t.districts) assert.ok(codes.has(d), `${d} is in Table 3.1.2`);
    for (const r of t.rows) {
      assert.ok(/^[A-Z0-9]/.test(r.use), r.use);
      assert.match(r.standards, /^4\.\d\.\d/);
      assert.ok(r.category_standards, `${r.use} has a category reference`);
      for (const [d, m] of Object.entries(r.cells)) {
        assert.ok(t.districts.includes(d), `${r.use}: ${d} is a column of ${t.section}`);
        assert.match(m, /^(?:P|C|P\/C)$/);
      }
      assert.ok(r.page >= t.pages[0] && r.page <= t.pages[1]);
    }
  }
  for (const k of ['P', 'C', 'P/C', 'blank', 'unlisted']) assert.ok(tables.legend[k]);
});

test('facts checked against the page images', () => {
  // p199, Table 3.2.12.
  assert.deepEqual(row('3.2.12', 'Dwelling, live-work').cells, { 'SF-T': 'P/C', 'R-C': 'P/C', 'MF-NS': 'P/C', 'MF-AC': 'P/C', 'MF-HR': 'P/C' });
  assert.deepEqual(row('3.2.12', 'Dwelling, single-family detached').cells, { 'SF-2': 'P', 'SF-4': 'P', 'SF-6': 'P', 'SF-10': 'P', 'SF-T': 'P', 'R-C': 'P/C', 'MF-NS': 'P', 'MF-HR': 'P' });
  // p325, Table 3.7.13: narrow columns, where the text extraction runs marks together.
  assert.deepEqual(row('3.7.13', 'Banquet hall').cells, { IN: 'C', 'IN-C': 'C', A: 'P/C', 'TOD-C': 'C' });
  assert.equal(Object.keys(row('3.7.13', 'Restaurant').cells).length, 9);
  // p445, Table 3.9.23: two-line overlay headers.
  assert.deepEqual(row('3.9.23', 'Consignment shop').cells, { 'PCO-Colley': 'P', 'PCO-21st Street': 'P', 'PCO-Lafayette': 'P' });
  assert.ok(row('3.9.23', 'Establishment for the sale of distilled spirits for off-premises consumption'), 'a name wrapped onto two lines');
  // Tables that don't list vacation rentals: prohibited there.
  assert.equal(row('3.6.11', 'Short-term rental unit (vacation rental)'), undefined);
  assert.equal(row('3.5.7', 'Short-term rental unit (vacation rental)'), undefined);
});

test('rows the City prints inconsistently keep what is printed, with a note', () => {
  assert.equal(AS_PRINTED.length, 4);
  const r = row('3.2.12', 'All other uses, not permitted');
  assert.equal(r.standards, '4.2.3.E(4)(i)');
  assert.equal(r.also, 'Utility facility, minor');
  assert.match(r.note, /every other use table/);
  assert.match(row('3.6.11', 'Utility facility, minor').note, /4\.2\.3\.E\(4\)\(a\) is Airport/);
});

test('the parser: real word positions from three pages, the hard cases', () => {
  const pages = JSON.parse(readFileSync(new URL('./fixtures/use-table-pages.json', import.meta.url), 'utf8'));
  const words = (p) => pages[p].map(([x0, y0, x1, y1, t]) => ({ x0, y0, x1, y1, t }));
  const districts = districtsOf();
  const p445 = parsePage(words(445), { page: 445, districts, classification: 'COMMERCIAL USES' });
  assert.deepEqual(p445.columns, ['PCO-Colley', 'PCO-21st Street', 'PCO-Riverview', 'PCO-35th Street', 'PCO-Lafayette']);
  const r445 = (u) => p445.rows.find((r) => r.use === u);
  assert.deepEqual(r445('Health and fitness facility').cells, { 'PCO-21st Street': 'P', 'PCO-Riverview': 'P', 'PCO-35th Street': 'P', 'PCO-Lafayette': 'P' });
  assert.deepEqual(r445('Kennel').cells, { 'PCO-Riverview': 'C' });
  assert.deepEqual(r445('Establishment for the sale of distilled spirits for off-premises consumption').standards, ['4.2.3.F(6)(k)']);
  // p446: the note under "Tire sales and repair" is not part of its name.
  const p446 = parsePage(words(446), { page: 446, districts, classification: 'COMMERCIAL USES' });
  assert.ok(p446.rows.some((r) => r.use === 'Tire sales and repair'));
  assert.ok(!p446.rows.some((r) => /All other/.test(r.use)));
  // p289: a name wrapped above its marks at the top of a page.
  const p289 = parsePage(words(289), { page: 289, districts, classification: 'TEMPORARY USES AND STRUCTURES' });
  assert.ok(p289.rows.some((r) => r.use === 'Temporary use of an accessory structure as a principal dwelling after a disaster'));
  // Headers are matched to Table 3.1.2, with the superscript dropped.
  assert.equal(districtFor('st PCO-21 Street', districts), 'PCO-21st Street');
  assert.equal(districtFor('O', districts), 'O');
  assert.equal(districtFor('Zebra', districts), null);
  assert.equal(categoryRefOf('4.2.3.D(4)(b)', new Set(['4.2.3.D(3)'])), '4.2.3.D(3)');
  assert.equal(categoryRefOf('4.4.3.B(2)(c)', new Set(['4.4.3.B(2)', '4.3.3'])), '4.4.3.B(2)');
});

test('zoning_uses: a use in a district, in plain words, with the table, page and standards', async () => {
  const c = ctx();
  const out = await plugin.run(c, { use: 'live-work', district: 'c-c' });
  assert.equal(out.district, 'C-C');
  assert.deepEqual(out.matches.map((m) => m.rows.map((r) => [r.table, r.mark, r.standards, r.page])), [[['Table 3.3.9', 'P/C', '4.2.3.D(2)(a)', 219]]]);
  assert.match(out.matches[0].rows[0].means, /Conditional Use Permit may be required/);
  assert.match(out.how, /performance standards decide when/);
  assert.match(out.how, /read it before saying a use is prohibited/);
  assert.deepEqual(c.records, [{ kind: 'document', title: 'Norfolk Zoning Ordinance, Table 3.3.9 (p. 219)', url: `${tables.source.url}#page=219` }]);
  const linked = filterAnswerLinks(`I found it in [Table 3.3.9](${tables.source.url}#page=219).`, handoffUrls({ records: c.records }));
  assert.equal(linked.kept, 1);
});

test('zoning_uses: everyday words find the table\'s own use, and never a bare "prohibited" (fresh review of #74)', async () => {
  const names = (q) => matchUses(q).names;
  assert.deepEqual(names('brewery').sort(), ['Brewery, cidery, distillery, or winery', 'Production of craft beverages']);
  assert.deepEqual(names('vacation rental'), ['Short-term rental unit (vacation rental)', 'Short-term rental unit (homestay)'], 'the person\'s own words first');
  assert.deepEqual(names('church'), ['Religious institution']);
  assert.deepEqual(names('salon'), ['Personal service business']);
  assert.deepEqual(names('gym'), ['Health and fitness facility']);
  assert.deepEqual(names('cafe'), ['Restaurant']);
  assert.deepEqual(names('car dealership'), ['Automobile sales']);
  assert.deepEqual(names('triplex'), ['Dwelling, multi-family']);
  assert.deepEqual(names('outdoor dining'), ['Outdoor seating (as accessory to an eating and drinking use)']);
  assert.deepEqual(names('ADU'), ['Accessory dwelling unit']);
  assert.deepEqual(names('utility facility minor'), ['Utility facility, minor']);
  assert.deepEqual(names('other'), [], 'the printed "All other uses" row is matched only by the name it means');
  // A partial match is flagged, so "homeless shelter" can't quietly become "Animal shelter".
  assert.equal(matchUses('homeless shelter').partial, true);
  const shelter = await plugin.run(ctx(), { use: 'homeless shelter', district: 'C-C' });
  assert.match(shelter.partial, /hold some of them/);
  // The prompt's own example: a brewery in C-C is a C as "Production of craft beverages".
  const brew = await plugin.run(ctx(), { use: 'brewery', district: 'C-C' });
  const marks = Object.fromEntries(brew.matches.map((m) => [m.name, m.rows.map((r) => r.mark)]));
  assert.deepEqual(marks, { 'Production of craft beverages': ['C'], 'Brewery, cidery, distillery, or winery': ['blank (prohibited)'] });
  assert.match(brew.note, /read their definitions to say which applies/);
  // No name matched: where to look, not "prohibited".
  const none = await plugin.run(ctx(), { use: 'zzz qqq', district: 'C-C' });
  assert.deepEqual(none.matches, []);
  assert.match(none.note, /Don't call the use prohibited until you know which use it is/);
  // A blank says to read the definition first (a home EV charger isn't an "Electric vehicle charging station").
  const ev = await plugin.run(ctx(), { use: 'EV charger', district: 'SF-6' });
  assert.match(ev.matches[0].rows[0].means, /read its definition first/);
  assert.deepEqual(ev.not_listed.uses, [{ use: 'Electric vehicle charging station', standards: row('3.3.9', 'Electric vehicle charging station').standards }]);
  assert.match(ev.not_listed.means, /first read the use's definition/);
});

test('zoning_uses: overlays govern only what Table 3.9.23 lists; a district without a column says what governs it', async () => {
  const pco = await plugin.run(ctx(), { use: 'airbnb', district: 'PCO-Colley' });
  assert.deepEqual(pco.not_listed.uses.map((u) => u.use), ['Short-term rental unit (vacation rental)']);
  assert.match(pco.not_listed.means, /the base district's table governs/);
  assert.match(pco.matches[0].rows[0].means, /prohibited in the overlay whatever the base district allows/);
  const imu = await plugin.run(ctx(), { district: 'IMU-O' });
  assert.equal(imu.no_use_table, true);
  assert.equal(imu.section, '3.9.21');
  assert.match(imu.note, /call again with the base district/);
  assert.match((await plugin.run(ctx(), { district: 'PD' })).note, /master plan/);
  assert.equal((await plugin.run(ctx(), { district: 'HO-N&W' })).section, '3.9.8');
  const list = await plugin.run(ctx(), { district: 'PCO-Riverview' });
  assert.match(list.overlay, /govern only the uses Table 3.9.23 lists/);
});

test('zoning_uses: districts by code, name or shorthand; conditional zoning; links to the table\'s first page', async () => {
  assert.equal(districtCode('Community Commercial'), 'C-C');
  assert.equal(districtCode('pco colley'), 'PCO-Colley');
  assert.equal(districtCode('PCO-21st'), 'PCO-21st Street');
  assert.equal(districtCode('sf6'), 'SF-6');
  assert.equal(districtCode('nowhere'), null);
  assert.deepEqual(districtOf('C-C (conditional)'), { code: 'C-C', conditional: true });
  const cond = await plugin.run(ctx(), { use: 'restaurant', district: 'C-C (Conditional)' });
  assert.match(cond.conditional_zoning, /proffered conditions/);
  const c = ctx();
  const list = await plugin.run(c, { district: 'MF-NS', mark: 'C' });
  assert.equal(list.table, 'Table 3.2.12');
  assert.equal(list.link, `${tables.source.url}#page=199`, 'the table\'s first page, not the section\'s');
  assert.ok(list.uses.C.includes('Rooming house'));
  assert.equal(list.counts.C, list.uses.C.length);
  const bad = await plugin.run(ctx(), { district: 'nowhere' });
  assert.match(bad.error, /isn't a zoning district/);
  assert.ok(bad.how);
  assert.match((await plugin.run(ctx(), {})).error, /Give use, district, or both/);
  const all = await plugin.run(ctx(), { use: 'short-term rental unit (vacation rental)' });
  const sf = all.matches[0].rows.find((r) => r.table === 'Table 3.2.12');
  assert.equal(sf.marked['SF-10'], 'C');
  assert.ok(sf.blank_in.includes('MF-AC'));
});

test('Siren declares zoning_uses with one prompt line', () => {
  assert.ok(siren.plugins.some((p) => p.name === 'zoning_uses'));
  assert.equal(siren.prompt.split('\n').filter((l) => l.includes('zoning_uses')).length, 1);
});
