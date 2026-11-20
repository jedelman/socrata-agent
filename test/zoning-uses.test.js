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
  assert.match(shelter.partial, /candidates only, with no marks/);
  assert.deepEqual(shelter.matches, []);
  assert.deepEqual(shelter.unexplained, ['homeless']);
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
  assert.match(ev.matches[0].rows[0].means, /definition's call/);
  assert.deepEqual(ev.not_listed.uses, [{ use: 'Electric vehicle charging station', standards: row('3.3.9', 'Electric vehicle charging station').standards }]);
  assert.match(ev.not_listed.means, /first read the use's definition/);
});

test('zoning_uses: the specific use wins over a generic word; partial and everyday-word matches say so (second review of #74)', async () => {
  const marksOf = async (use, district) => Object.fromEntries((await plugin.run(ctx(), { use, district })).matches.map((m) => [m.name, m.rows.map((r) => r.mark)[0]]));
  assert.deepEqual(await marksOf('tattoo shop', 'C-C'), { 'Tattoo parlor': 'C' });
  assert.deepEqual(await marksOf('pawn shop', 'C-N'), { Pawnshop: 'blank (prohibited)' });
  assert.deepEqual(Object.keys(await marksOf('thrift store', 'C-N')).sort(), ['Consignment shop', 'Used merchandise sales']);
  assert.ok('Establishment for the sale of distilled spirits for off-premises consumption' in (await marksOf('liquor store', 'C-N')));
  assert.equal((await marksOf('home daycare', 'SF-6'))['Family day home'], 'P/C');
  assert.deepEqual(matchUses('group home').names, [], 'no "Funeral home" for a group home');
  assert.deepEqual(matchUses('shop').names.includes('Retail goods establishment'), true);
  const truck = await plugin.run(ctx(), { use: 'food truck', district: 'D-MU' });
  assert.match(truck.via.note, /read the definition to confirm/);
  const solar = await plugin.run(ctx(), { use: 'solar panels', district: 'SF-6' });
  assert.ok(solar.partial);
  assert.deepEqual(solar.matches, [], 'a partial match never reads as "prohibited"');
  assert.equal('not_listed' in solar, false);
  assert.deepEqual(solar.candidates.map((x) => x.use), ['Solar energy collection facility (large-scale)']);
  const vr = await plugin.run(ctx(), { use: 'vacation rental' });
  assert.ok(vr.not_in_tables.uses.find((u) => u.use === 'Short-term rental unit (vacation rental)').not_in.includes('Table 3.6.11'));
  assert.match((await plugin.run(ctx(), { district: 'C-N', mark: 'X' })).error, /mark is one of/);
});

test('zoning_uses: overlays govern only what Table 3.9.23 lists; a district without a column says what governs it', async () => {
  const pco = await plugin.run(ctx(), { use: 'airbnb', district: 'PCO-Colley' });
  assert.deepEqual(pco.not_listed.uses.map((u) => u.use), ['Short-term rental unit (vacation rental)']);
  assert.match(pco.not_listed.means, /prohibited in the PCO-Colley overlay whatever the base district allows/);
  assert.match(pco.matches[0].rows[0].means, /prohibited in the overlay whatever the base district allows/);
  const imu = await plugin.run(ctx(), { district: 'IMU-O' });
  assert.equal(imu.no_use_table, true);
  assert.equal(imu.section, '3.9.21');
  assert.match(imu.note, /call again with the base district/);
  assert.match((await plugin.run(ctx(), { district: 'PD' })).note, /master plan/);
  assert.equal((await plugin.run(ctx(), { district: 'HO-N&W' })).section, '3.9.8');
  const list = await plugin.run(ctx(), { district: 'PCO-Riverview' });
  assert.match(list.overlay, /column controls over the base district/);
  // A hotel in PCO-Colley: Visitor Accommodation is "Not permitted" in the overlay table, though C-C allows hotels.
  const hotel = await plugin.run(ctx(), { use: 'hotel', district: 'PCO-Colley' });
  assert.deepEqual(hotel.not_listed.uses.map((u) => u.use), ['Hotel or motel']);
  assert.match(hotel.not_listed.means, /prohibited in the PCO-Colley overlay/);
  assert.deepEqual(tables.overlay.not_permitted_categories.map((c) => c.category), ['4.2.3.D(3)', '4.2.3.F(9)', '4.2.3.G(1)']);
  // Umbrella codes point to their columns; names as the parcel lookup gives them resolve.
  assert.deepEqual((await plugin.run(ctx(), { district: 'PCO' })).columns, ['PCO-Colley', 'PCO-21st Street', 'PCO-Riverview', 'PCO-35th Street', 'PCO-Lafayette']);
  assert.deepEqual((await plugin.run(ctx(), { district: 'TOD' })).columns, ['TOD-C', 'TOD-S']);
  assert.equal(districtCode('Colley Avenue Pedestrian Commercial Overlay'), 'PCO-Colley');
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
  const lines = siren.prompt.split('\n').filter((l) => l.includes('zoning_uses'));
  assert.equal(lines.filter((l) => !l.includes('parcel_inventory')).length, 1);
  // The parcel lookup's line sends use questions here, not to a case file (fourth review of #74).
  assert.ok(lines.some((l) => l.includes('parcel_inventory')));
  assert.ok(!siren.prompt.includes('for what a use such as a restaurant needs'));
});

test('zoning_uses: every word asked must be accounted for before a mark is given (third review of #74)', async () => {
  const names = (q) => matchUses(q).names;
  const marksOf = async (use, district) => Object.fromEntries((await plugin.run(ctx(), { use, district })).matches.map((m) => [m.name, m.rows.map((r) => r.mark)[0]]));
  // The finding: a generic word stood in for the specific use ("weed shop" became Retail goods, P/C in D-MU).
  assert.deepEqual(await marksOf('weed shop', 'D-MU'), { 'Cannabis dispensing facility': 'blank (prohibited)' });
  assert.deepEqual(names('marijuana store'), ['Cannabis dispensing facility'], 'a store is the dispensary, not cultivation');
  assert.deepEqual(names('marijuana'), ['Cannabis dispensing facility', 'Cannabis cultivation or manufacturing facility']);
  // A word nothing explains: candidates to confirm, never marks.
  const odd = await plugin.run(ctx(), { use: 'kombucha shop', district: 'D-MU' });
  assert.deepEqual(odd.matches, []);
  assert.ok(!JSON.stringify(odd).includes('"mark"'));
  assert.deepEqual(matchUses('used car lot').names, ['Automobile sales']);
  // Generic words alone read through their generic names; beside an explained word they don't block it.
  assert.deepEqual(names('shop'), ['Retail goods establishment']);
  assert.deepEqual(names('bar'), ['Sale of alcoholic beverages, on-premises', 'Restaurant', 'Nightclub']);
  assert.deepEqual(names('smoothie shop'), ['Restaurant']);
  assert.equal(matchUses('house').via.length, 0, 'a bare "house" is never a confident match');
  assert.ok(matchUses('home').partial || !matchUses('home').names.length);
  // Everyday words the third review found missing.
  assert.deepEqual(names('sex shop'), ['Novelty store or theater, adult']);
  assert.deepEqual(names('vape shop'), ['Smoke or vape shop', 'Sale of smoking or vaping products']);
  assert.deepEqual(names('tattoo and piercing studio'), ['Tattoo parlor']);
  assert.deepEqual(names('live music'), ['Live entertainment']);
  assert.deepEqual(names('dance club'), ['Nightclub']);
  assert.deepEqual(names('movie theater'), ['Cinema or theater']);
  assert.deepEqual(names('laundromat'), ['Personal service business']);
  assert.deepEqual(names('used bookstore')[0], 'Used books/media');
  assert.deepEqual(names('massage'), ['Therapeutic massage facility'], 'massage alone isn\'t a personal service business');
  assert.deepEqual(names('thrift store'), ['Used merchandise sales', 'Consignment shop'], 'the likelier use first');
  assert.ok(names('body shop').includes('Automobile repair and maintenance, major'));
  // Accents, plurals and the person's own words naming the use.
  assert.deepEqual(names('cafés'), ['Restaurant']);
  assert.deepEqual(names('churches'), ['Religious institution']);
  assert.deepEqual(names('can I open a restaurant with outdoor seating').sort(), ['Outdoor seating (as accessory to an eating and drinking use)', 'Restaurant']);
  assert.deepEqual(names('car wash'), ['Car wash'], 'the table\'s own name alone');
  assert.equal(names('park').includes('Parking facility'), false, 'a four-letter word never matches as the start of another');
  // Rows say which category they're in (an accessory use is not the principal use).
  const ev = await plugin.run(ctx(), { use: 'EV charger', district: 'C-C' });
  assert.deepEqual(new Set(ev.matches.flatMap((m) => m.rows.map((r) => r.classification))), new Set(['COMMERCIAL USES', 'ACCESSORY USES']));
  // Districts: a name three districts share is a question, not the first of them; a code with a street word resolves.
  const ghent = await plugin.run(ctx(), { use: 'restaurant', district: 'Ghent Historic and Cultural Conservation' });
  assert.match(ghent.error, /more than one district \(HC-G1, HC-G2, HC-G3\)/);
  assert.equal(districtCode('PCO Colley Ave'), 'PCO-Colley');
  assert.equal(districtCode('PCO Lafayette Blvd'), 'PCO-Lafayette');
  assert.equal(districtCode('PCO'), 'PCO');
});

test('zoning_uses: a name with words of its own beyond those asked is a different use, never a match (fourth review of #74)', async () => {
  const run = (use, district) => plugin.run(ctx(), { use, district });
  const marks = (out) => Object.fromEntries(out.matches.map((m) => [m.name, m.rows.map((r) => r.mark)[0]]));
  // The finding: a longer name holding every word asked won confidently.
  assert.deepEqual(marks(await run('retail sales', 'BC-O')), { 'Retail goods establishment': 'blank (prohibited)' }, 'never the industrial accessory row\'s P');
  assert.deepEqual((await run('retail sales', 'BC-O')).related.uses, ['Retail sales (as accessory to an industrial use)']);
  assert.deepEqual(Object.keys(marks(await run('auto sales', 'C-C'))), ['Automobile sales']);
  assert.ok(!('Commercial vehicle repair and maintenance' in marks(await run('car repair', 'C-C'))));
  assert.deepEqual(Object.keys(marks(await run('vehicle storage', 'O'))), ['Automobile storage']);
  for (const use of ['health care', 'accessory structure', 'garage', 'dock', 'residential', 'shelter', 'truck', 'private event']) {
    const out = await run(use, 'C-C');
    assert.deepEqual(out.matches, [], `${use}: candidates, never marks`);
    assert.ok(out.partial, use);
  }
  // Alternatives name a use by themselves; parentheticals don't come free.
  const names = (q) => matchUses(q).names;
  assert.deepEqual(names('hotel'), ['Hotel or motel']);
  assert.deepEqual(names('museum'), ['Cultural facility, museum, or library']);
  assert.deepEqual(names('bank'), ['Bank or other financial institution']);
  assert.deepEqual(names('live-work'), ['Dwelling, live-work']);
  // The table's exact name returns that use alone; a phrase beats a word inside it.
  assert.deepEqual(names('Office'), ['Office']);
  assert.deepEqual(names('Day care center, child'), ['Day care center, child', 'Day care center, child (as an accessory use)'], 'with its accessory twin, its own row');
  assert.deepEqual(names('Dwelling, single-family detached'), ['Dwelling, single-family detached']);
  assert.deepEqual(names('home office'), ['Home occupation']);
  assert.deepEqual(names('art studio'), ['Artist studio/school/gallery']);
  assert.deepEqual(names('apartment in my house'), ['Accessory dwelling unit']);
  // Drink and club words add their names beside another use; home and house never vanish.
  assert.ok(names('restaurant and bar').includes('Sale of alcoholic beverages, on-premises'));
  assert.ok(names('bar with live music').includes('Nightclub'));
  assert.ok(names('home bakery').includes('Home occupation'));
  assert.ok(matchUses('group home').names.length === 0 || matchUses('group home').partial);
  // A cut list says so.
  const storage = await run('storage', 'C-C');
  assert.match(storage.more, /more uses? hold these words/);
});

test('zoning_uses: a neighborhood\'s name or a stray word is never an overlay (fourth review of #74)', async () => {
  for (const d of ['Riverview', 'Lafayette', 'Colley', '21st', '21st street', 'downtown', 'review', 'river', 'costs', 'pier', 'source']) assert.equal(districtOf(d), null, d);
  assert.equal(districtCode('PCO-21st'), 'PCO-21st Street');
  assert.equal(districtCode('pco riverview'), 'PCO-Riverview');
  assert.equal(districtCode('SF-6 district'), 'SF-6');
  assert.match((await plugin.run(ctx(), { use: 'ADU', district: 'Riverview' })).error, /isn't a zoning district/);
});

test('zoning_uses: home, park and twin rows answer the use asked (fifth review of #74)', async () => {
  const run = (use, district) => plugin.run(ctx(), { use, district });
  const marks = (out) => Object.fromEntries(out.matches.map((m) => [m.name, m.rows.map((r) => r.mark)[0]]));
  // 4.3.3 bars these as home occupations: the use answers, with the rule quoted.
  for (const [use, district] of [['home salon', 'HC-G2'], ['tattoo shop in my house', 'HC-G1'], ['auto repair at my house', 'SF-6'], ['massage out of my home', 'SF-6']]) {
    const out = await run(use, district);
    assert.ok(!('Home occupation' in marks(out)), use);
    assert.match(out.home_occupation.excluded, /specifically prohibited as home occupations: \(A\) Personal service businesses/, use);
    assert.equal(out.home_occupation.section, '4.3.3');
  }
  assert.ok(!('Home occupation' in marks(await run('airbnb in my house', 'HC-G3'))), 'a short-term rental has its own row');
  assert.ok(!('Home occupation' in marks(await run('daycare in my home', 'HC-G2'))));
  const ho = await run('home bakery', 'SF-6');
  assert.equal(marks(ho)['Home occupation'], 'P/C');
  assert.match(ho.matches[0].rows[0].rules.sales, /On-site sales of merchandise to the general public is prohibited/);
  // A one-word name inside a longer phrase is related, never the answer.
  for (const [use, district] of [['park and ride', 'SF-6'], ['food truck park', 'SF-6']]) assert.ok(!('Park' in marks(await run(use, district))), use);
  for (const use of ['business park', 'office park', 'retail warehouse']) assert.deepEqual((await run(use, 'C-C')).matches, [], use);
  assert.deepEqual(Object.keys(marks(await run('vet clinic', 'D-SP'))), ['Veterinary hospital or clinic']);
  assert.deepEqual(Object.keys(marks(await run('martial arts studio', 'HC-G3'))), ['Music, dance, or martial arts studio/school']);
  assert.ok(!('Warehouse' in marks(await run('warehouse store', 'C-R'))));
  assert.ok(!('Nightclub' in marks(await run('fitness club', 'C-C'))));
  assert.ok(!('Nightclub' in marks(await run('restaurant with a bar', 'C-N'))));
  assert.deepEqual(Object.keys(marks(await run('beer and wine store', 'C-N'))), ['Sale of alcoholic beverages, off-premises']);
  // The exact name brings its temporary or accessory twin, which can differ.
  assert.deepEqual(marks(await run('farmers market', 'PCO-Colley')), { 'Farmer’s market': 'blank (prohibited)', 'Farmer’s market (as a temporary use)': 'P' });
  assert.deepEqual(marks(await run('kennel', 'PCO-Colley')), { Kennel: 'blank (prohibited)', 'Kennel (as an accessory use)': 'C' });
  // District framing words.
  assert.equal(districtCode('the C-C district'), 'C-C');
  assert.equal(districtCode('zoned C-C'), 'C-C');
  assert.deepEqual(districtOf('(C) C-C'), { code: 'C-C', conditional: true });
  assert.equal(districtCode('Lafayette Pedestrian Commercial Overlay'), 'PCO-Lafayette');
});

test('zoning_uses: galleries, construction, place phrases, home uses, trade schools (sixth review of #74)', async () => {
  const run = (use, district) => plugin.run(ctx(), { use, district });
  const marks = async (use, district) => Object.fromEntries((await run(use, district)).matches.map((m) => [m.name, m.rows.map((r) => r.mark)[0]]));
  // 4.2.3 names art galleries under retail goods and cultural facilities too.
  assert.deepEqual(await marks('gallery', 'G-1'), { 'Artist studio/school/gallery': 'blank (prohibited)', 'Retail goods establishment': 'P/C', 'Cultural facility, museum, or library': 'P' });
  // A contractor's yard isn't the temporary construction row.
  assert.deepEqual((await run('construction yard', 'SF-6')).matches, []);
  assert.deepEqual(Object.keys(await marks('construction trailer', 'SF-6')), ['Construction-related office/yard']);
  // Where a use is isn't a second use.
  assert.deepEqual(Object.keys(await marks('hotel near the airport', 'C-C')), ['Hotel or motel']);
  assert.ok(!('Park' in await marks('bar near a park', 'SF-6')));
  assert.deepEqual(Object.keys(await marks('concerts in the park', 'C-C')), ['Live entertainment']);
  assert.deepEqual(Object.keys(await marks('apartments in a warehouse', 'C-C')), ['Dwelling, multi-family']);
  assert.deepEqual(Object.keys(await marks('warehouse apartments', 'C-C')), ['Dwelling, multi-family']);
  assert.deepEqual(Object.keys(await marks('church office', 'C-C')), ['Office']);
  // In my house: Home occupation answers, unless the use has its own accessory or temporary row.
  assert.deepEqual(Object.keys(await marks('can I have an office in my house?', 'SF-6')), ['Home occupation']);
  assert.deepEqual(Object.keys(await marks('cafe in my house', 'SF-6')), ['Home occupation']);
  assert.ok(!('Home occupation' in await marks('can I put an EV charger at my house', 'SF-6')));
  assert.ok(!('Home occupation' in await marks('kennel at my house', 'SF-6')));
  assert.ok(!('Home occupation' in await marks('car wash at my house', 'SF-6')), '4.3.3(F): vehicle service');
  assert.deepEqual(Object.keys(await marks('can I open a daycare in my house', 'SF-6')), ['Family day home']);
  // A trade school, not a college or a salon.
  assert.deepEqual(Object.keys(await marks('beauty college', 'G-1')), ['School, vocational or trade']);
  assert.deepEqual(Object.keys(await marks('barber college', 'C-N')), ['School, vocational or trade']);
  // Alternatives that never matched; bars only beside drink hosts; store after a service.
  assert.deepEqual(Object.keys(await marks('credit union', 'C-C')), ['Bank or other financial institution']);
  assert.deepEqual(Object.keys(await marks('smoothie bar', 'C-C')), ['Restaurant']);
  for (const use of ['beauty bar', 'college bar', 'beauty store']) assert.deepEqual((await run(use, 'C-C')).matches, [], use);
  // Recreation by the use types 4.2.3 lists; misspellings; modifiers.
  assert.deepEqual(Object.keys(await marks('bowling alley', 'C-C')), ['Recreation facility, indoor']);
  assert.deepEqual(Object.keys(await marks('mini golf', 'C-C')), ['Recreation facility, outdoor']);
  assert.deepEqual(Object.keys(await marks('resturant', 'C-C')), ['Restaurant']);
  assert.deepEqual(Object.keys(await marks('mexican restaurant', 'C-C')), ['Restaurant']);
  assert.deepEqual(Object.keys(await marks('antique store', 'C-C')), ['Retail goods establishment']);
  assert.equal(districtOf('PCO-3'), null, 'never PCO-35th Street');
});
