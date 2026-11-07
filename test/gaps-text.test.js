// Gap text: rules A to C, the public-text checks, the copied helpers, and the
// bot text (docs/gaps.md §6, §10.3, §15 item 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripQuoted, normalize } from '../src/gaps/text-utils.js';
import { normalize as verifyNormalize } from '../scripts/verify-cases.js';
import { KINDS, PANEL_TITLE, QUESTIONS_HEADING, T, gapTextViolations, gapCheck, worldClaimViolations, botText, ruleA } from '../src/gaps/kinds.js';
import { publicTextViolations, publicTextFlags, publicTextMessage, compileStreets } from '../src/public-text.js';
import { GAPS } from '../src/gaps/norfolk.js';
import { replayedGaps } from './fixtures/gaps-pinned.js';

// Replayed against the pinned case files: a gap off the board or unmeasured
// in the committed file is a normal state, not a failure of these checks.
const BUILT = await replayedGaps();
const NORFOLK_STREETS = JSON.parse(readFileSync(new URL('../data/gaps/norfolk-streets.json', import.meta.url), 'utf8')).streets;

// The original stripQuoted isn't exported (src/voice.js stays unchanged), so
// the test lifts its source.
function originalStripQuoted() {
  const src = readFileSync(new URL('../src/voice.js', import.meta.url), 'utf8');
  const body = src.match(/function stripQuoted\(text\) \{([\s\S]*?)\n\}/)[1];
  return new Function('text', body);
}

const CORPUS = [
  'There is a "quoted thing" here.',
  'A 6" pipe and "then a quote" and “curly quotes” too.',
  '> A block quote\nand a line after',
  'Code `there is` and ```\nthere are\n```',
  'Soft­hyphen, non breaking, “smart” ‘quotes’ – dashes — and &amp; &nbsp; &#39;x&#39; &quot;y&quot;',
  'Mixed   whitespace\n\tand CASE.',
  '',
];

test('the copied stripQuoted and normalize behave like their originals', () => {
  const orig = originalStripQuoted();
  for (const s of CORPUS) {
    assert.equal(stripQuoted(s), orig(s), JSON.stringify(s));
    assert.equal(normalize(s), verifyNormalize(s), JSON.stringify(s));
  }
});

const D = '2026-11-06';
const WO = { id: 'qzfe-wj25', phrase: "the City's Work Orders records" };
const INV = { id: 'cmvv-agyb', phrase: 'the City Tree Inventory', pronoun: 'it' };

// The spec's §6.1 rows, rendered from the templates with large and small values.
function rendered(n) {
  return {
    share: T.share({ part: 582 * n, whole: 2378 * n, scope: 'Forestry removal work orders', status: ['Complete'], absent: 'with no street', source: WO, span: { from: '2020-08-05', through: '2026-10-30' }, read: D }),
    window: T.windowLine({ whole: 272 * n, part: 24 * n, status: ['Complete'], since: '2025-11-06', absent: 'no street', also: { part: 22 * n, absent: 'no ward or civic league' }, read: D }),
    status: T.statusLine({ whole: 353 * n, part: 85 * n, status: ['New Work Order', 'On-Going'], absent: 'no street', read: D }),
    columns: `${T.columnsAbsent({ concept: 'for a planned or scheduled date', count: 32, source: WO, read: D })} ${T.fieldQuote({ field: 'start_date', quote: 'Date the work on the work order began.' })}`,
    topic: T.columnsAbsentTopic({ concept: 'for notice to residents', datasets: ['cmvv-agyb', 'qzfe-wj25'], topic: 'tree', read: D }),
    backlog: T.backlog({ whole: 353 * n, scope: 'Forestry removal work orders', status: ['New Work Order', 'On-Going'], with_end: 50 * n, median_days: 941, read: D }),
    late: T.createdOnOrAfterEnd({ whole: 360 * n, scope: 'Forestry removal work orders', status: ['Complete'], from: '2025-11-06', through: '2026-11-05', part: 115 * n, before: 22 * n, same: 93 * n, source: WO, read: D }),
    stale: `${T.stale({ owner: "The City Tree Inventory's", source: INV, read: D, quote: 'No official re-inventory has been conducted since then.' })} I found no column dating each record among its 13 data columns, as I read them on ${D}.`,
    contract: `${T.partOf({ what: 'a contractor cost above zero', part: 563 * n, whole: 2378 * n, scope: 'of its Forestry removal work orders', status: ['Complete'], read: D })} ${T.findingQuote({ who: "The City's FY2024 adopted budget", quote: 'The contract is used to remove decaying or diseased trees', checked: '2026-11-04' })}`,
    catalog: T.catalogSearch({ portal: "Norfolk's open data", searches: [{ q: 'line clearance', result_set_size: 0, open: 0, names: [] }, { q: 'Dominion', result_set_size: 4 * n, open: 4 * n, names: ['Street Light Outages'] }], read: D }),
    values: T.valuesAbsent({ count: 18 * n, what: 'problem descriptions on Forestry work orders', source: WO, terms: ['utility', 'Dominion'], read: D }),
    restricted: T.restricted({ name: 'MyNorfolk 311 requests', id: 'nbyu-xjez', read: D, reason: 'MyNorfolk 311 requests are not available to open-ended queries.' }),
    index: T.index({ part: 681 * n, whole: 1437 * n, what: 'agenda items', absent: 'no street address', index: "Siren's agenda index", built: '2026-11-02', from: '2023-07-11', through: '2026-10-22', consequence: "I can't match them to a block" }),
    part: T.consequencePart({ source: WO, finding: `I found ${582 * n} of ${2378 * n} with no street`, measured: D, tail: "so a street search can't find them" }),
    all: T.consequenceAll({ concept: 'for a planned or scheduled date', datasets: ['cmvv-agyb', 'qzfe-wj25'], topic: 'tree', measured: D }),
    restrictedQ: T.consequenceRestricted({ name: 'MyNorfolk 311 requests', read: D }),
    unmeasured: T.unmeasured({ today: '2026-11-13', last: D }),
  };
}

test('every template passes the voice check and rules A and B, with large and small values', () => {
  for (const n of [1, 1000]) {
    for (const [k, s] of Object.entries(rendered(n))) assert.deepEqual(gapCheck(s, k === 'part' || k === 'all' || k === 'restrictedQ' ? 'consequence' : 'statement'), [], `${k}: ${s}`);
  }
});

test('labels, titles, headers and the panel title are noun phrases', () => {
  for (const s of [...Object.values(KINDS), PANEL_TITLE, QUESTIONS_HEADING, ...GAPS.map((g) => g.title)]) assert.deepEqual(gapCheck(s, 'title'), [], s);
});

test('world claims, hedges, predictions and undated numbers fail', () => {
  const mustFail = [
    'The tree inventory has not been re-surveyed since about 2000.',
    'There will be more removals next month.',
    'Contract removals may not appear in these records, and the City probably does not log them.',
    "Work done under separate contracts may not appear in the City's Work Orders records (qzfe-wj25).",
    'The City does not record a planned date.',
    'I found 582 of 2,378 removals with no street.',
    'Removals are missing from the records, as I read them on 2026-11-06.',
    '582 removals have no street (2026-11-06).',
    // A sentence that starts with a digit, a quote or a lowercase word gets no
    // frame or date from the sentence before it.
    'I found 582 of 2,378 removals with no street, as I read them on 2026-11-06. 24 have no ward.',
    'I found 5 removals, as I read them on 2026-11-06. “Complete” covers 22 with no ward.',
    'I found 5 removals, as I read them on 2026-11-06. and 22 have no ward.',
    // Rule A's negation, at a sentence's start or in capitals.
    'Does not include contract work. I found 5, as I read them on 2026-11-06.',
    'The City DOES NOT record it.',
  ];
  for (const s of mustFail) assert.ok(gapCheck(s, 'statement').length, s);
  assert.deepEqual(ruleA("I don't query it. Siren doesn't send requests; you do."), []);
  assert.ok(ruleA('The City didn’t record it.').length, 'curly apostrophes count');
  assert.deepEqual(ruleA('It says: “Trees may be removed.”'), [], 'quotes are stripped first');
  // Abbreviations don't end a sentence.
  assert.deepEqual(gapCheck('Under Va. Code § 2.2-3704, I found 5 requests, as I read them on 2026-11-06.', 'statement'), []);
});

test('rule C refuses digits and verbs in titles', () => {
  assert.ok(gapTextViolations('582 removals with no street', 'title').length);
  assert.ok(gapTextViolations('The street is missing', 'label').length);
  assert.deepEqual(gapTextViolations('MyNorfolk 311 requests: out of Siren’s reach by rule', 'title'), []);
  assert.throws(() => gapTextViolations('x', 'nonsense'), /Unknown gap text type/);
});

test('steward notes may hold digits only as dates, ids or stored measures', () => {
  assert.deepEqual(gapTextViolations('Measured again on 2026-11-13 for qzfe-wj25: 582 of 2,378.', 'steward_note', { measures: [582, 2378] }), []);
  assert.ok(gapTextViolations('About 600 of them.', 'steward_note', { measures: [582] }).length);
});

test('worldClaimViolations catches world claims and predictions, not hedges addressed to the reader', () => {
  assert.equal(worldClaimViolations('The inventory has not been re-surveyed since about 2000.').length, 1);
  assert.equal(worldClaimViolations('There will be a hearing.').length, 1);
  assert.deepEqual(worldClaimViolations('You may want to call the Clerk. I found 3 work orders.'), []);
});

const STREETS = ['BOLLING', 'COLONIAL', 'COLLEY', 'GRANBY', 'OCEAN VIEW', 'MAIN', 'PARK'];

test('publicTextViolations: the spec examples hold both ways', () => {
  const blocked = {
    '1500 Bolling Ave': 'house_number',
    '1500 BOLLING': 'number_street',
    'corner of Bolling and Colonial': 'intersection',
    'the 1500 block of Bolling Ave': 'block_of',
    'Did 3 Colley Avenue trees get removed?': 'house_number',
    'apt 4 trees?': 'unit',
    'mail me at a@b.org': 'email',
    'call 757-664-4253': 'phone',
    'ask @someone.bsky.social': 'mention',
    'see https://example.com': 'link',
    'parcel 1234567': 'long_number',
    'at 36.85, -76.29': 'coordinates',
    'the tree in my yard': 'parcel_grain',
    'who complained about it?': 'person_pointing',
    'whose tree was it?': 'person_pointing',
    'Mrs. Smith asked': 'named_person',
    'why did the forester do it?': 'role_blame',
  };
  for (const [t, code] of Object.entries(blocked)) assert.ok(publicTextViolations(t, { streets: STREETS }).includes(code), `${t} -> ${code}`);
  const pass = ['683 of 2,770 work orders', 'I found 60 with no street', 'Was a city tree removed on my street?', 'Which streets had city tree removals last year?', 'Did the Council act on anything that affects my block?', 'park and main', 'Between FY2021-FY2024 and 2020-2026?', 'Siren drafted this from public records on 2026-11-06.'];
  for (const t of pass) assert.deepEqual(publicTextViolations(t, { streets: STREETS }), [], t);
  // A year-like house number after of/from/by/the/to is still an address, with or without the street list.
  for (const t of ['from 1950 Granby St', 'by 2001 Colley Ave', 'the 2010 Bolling Ave tree', 'to 1999 W Ocean View Ave']) {
    assert.ok(publicTextViolations(t).includes('house_number'), t);
    assert.ok(publicTextViolations(t, { streets: STREETS }).includes('house_number'), t);
  }
  for (const t of ['since 1950', 'in 2024 the City', 'from 2019 to 2024 the City removed 300 trees']) assert.deepEqual(publicTextViolations(t, { streets: STREETS }), [], t);
  // Numbered streets (Norfolk has many, Ghent's W 21st St among them) need no street list.
  for (const t of ['710 W 21st St', 'the oak at 710 West 21st Street', '1200 E 26th St was cut']) {
    assert.ok(publicTextViolations(t).includes('house_number'), t);
  }
  for (const t of ['I found 3 21st century plans', 'in the 21st century']) assert.ok(!publicTextViolations(t).includes('house_number'), t);
});

test('publicTextViolations normalizes first, and own_place refuses the asker’s own place', () => {
  assert.ok(publicTextViolations('1500 Bol­ling Ave', { streets: STREETS }).includes('house_number'));
  assert.ok(publicTextViolations('ｍｙ ｈｏｕｓｅ', {}).includes('parcel_grain'), 'NFKC');
  const own = (p) => p === 'ghent' || p === 'ward 2';
  assert.ok(publicTextViolations('Are trees in Ghent pruned?', { ownPlace: own }).includes('own_place'));
  assert.deepEqual(publicTextViolations('Are trees pruned citywide?', { ownPlace: own }), []);
});

test('refusals say what to change and never repeat the text', () => {
  const msg = publicTextMessage(publicTextViolations('1500 Bolling Ave, call 757-664-4253', { streets: STREETS }));
  assert.match(msg, /house numbers/);
  assert.match(msg, /phone/);
  assert.doesNotMatch(msg, /Bolling|757/);
});

test('publicTextFlags hint without blocking', () => {
  const f = publicTextFlags('Does the Ghent Civic League manager know? It will happen.');
  assert.deepEqual(f.map((x) => x.code).sort(), ['capitalized_words', 'person', 'presupposes']);
});

const GAP = { kind: 'missing_field', state: 'open', measured: '2026-11-06', short: 'I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street, measured 2026-11-06.' };

test('botText: the spec example, within 300 graphemes with the link', () => {
  const r = botText(GAP, { raised: 14, as_of: '2026-11-20' }, { today: '2026-11-20', link: 'https://example.org/requests#g1' });
  assert.ok(r.ok, r.reason);
  assert.equal(
    r.text,
    'Gap in the records Siren reads: I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street, measured 2026-11-06. Questions linked to it were raised 14 times through Siren as of 2026-11-20; one person can raise more than once. https://example.org/requests#g1'
  );
  assert.ok(botText({ ...GAP, kind: 'restricted', short: "I don't query MyNorfolk 311 requests for open-ended questions, by Siren's rule as read on 2026-11-06." }, null, { today: '2026-11-07' }).text.startsWith("Out of Siren's reach by rule:"));
});

test('botText refuses stale, non-open, over-long and failing text', () => {
  assert.equal(botText(GAP, null, { today: '2026-11-21' }).ok, false, 'older than 14 days');
  assert.equal(botText({ ...GAP, state: 'closing' }, null, { today: '2026-11-07' }).ok, false);
  assert.equal(botText({ ...GAP, state: 'unmeasured_today' }, null, { today: '2026-11-07' }).ok, false);
  assert.equal(botText(GAP, null, { today: '2026-11-07', link: `https://x.org/${'a'.repeat(200)}` }).ok, false, 'too long with the link');
  assert.equal(botText({ ...GAP, short: 'Removals may not appear in the records.' }, null, { today: '2026-11-07' }).ok, false);
  assert.equal(botText(GAP, { raised: 3 }, { today: '2026-11-07' }).ok, false, 'an undated count');
});

test('botText: every built gap posts with a realistic link, dropping the demand line when it runs over', () => {
  const link = 'https://jason-edelman.org/ask-siren/requests#g1';
  for (const g of BUILT.gaps) {
    const today = g.measured;
    const plain = botText(g, null, { today, link, streets: NORFOLK_STREETS });
    assert.ok(plain.ok, `${g.id}: ${plain.reason}`);
    const withDemand = botText(g, { raised: 3, as_of: today }, { today, link, streets: NORFOLK_STREETS });
    assert.ok(withDemand.ok, `${g.id}: ${withDemand.reason}`);
    if (withDemand.demand_dropped) assert.equal(withDemand.text, plain.text);
    else assert.match(withDemand.text, /raised 3 times through Siren/);
  }
});

test('the street checks build no regex from the street list, and the Worker compiles it at startup', () => {
  // Wall-clock timings don't belong in npm test, which gates the deploy. What
  // keeps a cold check cheap is that the street list becomes a Set, never a
  // regex: count RegExp constructions while compiling and checking.
  const Real = globalThis.RegExp;
  let built = 0;
  globalThis.RegExp = new Proxy(Real, { construct: (T, args) => (built++, new T(...args)), apply: (T, self, args) => (built++, T(...args)) });
  try {
    const streets = compileStreets(NORFOLK_STREETS);
    publicTextViolations('Was the tree at 1500 bolling and Granby & 21st removed?', { streets });
  } finally {
    globalThis.RegExp = Real;
  }
  assert.equal(built, 0);
  const worker = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
  assert.match(worker, /const STREETS = \{ norfolk: compileStreets\(norfolkStreets\.streets\) \}/);
});

test('the street checks with the real list: species and ordinary words pass, addresses and corners are refused', () => {
  const streets = NORFOLK_STREETS;
  const pass = [
    'Which species were planted: cherry and dogwood trees?',
    'Records of birch and poplar removals',
    'Records of Birch and Poplar removals',
    'Planting records for the 200 cherry trees along the river',
    'Removals after 2 light poles came down',
    'Are street trees protected citywide?',
    'Under Va. Code § 2.2-3704, what records exist?',
    'Norfolk City Code Sec. 42-15 on street trees?',
    'Zoning Ordinance section 4-2.3?',
    'Ordinance No. 48-512 adopted?',
    // Years before a city name or an ordinary word that is also a street name, mid-phrase.
    'The 2025 Norfolk budget for Forestry',
    'The 2024 Chesapeake tree survey',
    'In 2019 Hampton planted 40 oaks',
    'The 2023 park bond results',
    'In 2020 Norfolk planted 300 trees',
    // Years followed by no street at all.
    'since 1950',
    'in 2024 the City',
    'Removals from 2019 to 2024',
    // Counts, amounts, decimals and times.
    'Were 500 street trees removed last year?',
    'How many of the 2,770 street tree removals had a street?',
    'What did the FY2024 budget spend on tree removal ($1,250,000)?',
    'How many trees were planted in 2.5 miles of the river?',
    'About 300 Granby residents asked for trees',
    'planted 200 dogwood and 30 oak trees',
    'park and main',
    '21st and 22nd of the month',
  ];
  for (const t of pass) assert.deepEqual(publicTextViolations(t, { streets }), [], t);
  const blocked = {
    '1500 BOLLING': 'number_street',
    'Was the tree at 1500 Bolling removed?': 'number_street',
    '1500 W 21st St': 'number_street',
    'Granby St and Brambleton Ave': 'intersection',
    'Granby St. and Brambleton': 'intersection',
    'the corner of Colley Ave & 21st St': 'intersection',
    'call 757-664-4253': 'long_number',
    'Sec. 757-664-4253': 'long_number',
    'parcel 42-15': 'long_number',
    // Lower case, ordinary words that are street names, ordinals and unit letters.
    '1500 bolling': 'number_street',
    'tree removed at 1500 granby?': 'number_street',
    '1500 colley': 'number_street',
    '1500 Church': 'number_street',
    '1500 Main': 'number_street',
    'Tree at 220 W 21st': 'number_street',
    '1500 colley in ghent': 'number_street',
    '1500B Bolling Ave': 'house_number',
    '1500-B Bolling Ave': 'house_number',
    '2024 Granby Street': 'house_number',
    // A year-like number is an address when a street follows, whatever comes
    // before it: the word before is never enough to call it a year.
    'from 1950 Granby St': 'house_number',
    'by 2001 Colley Ave': 'house_number',
    'of 1999 Bolling Ave': 'house_number',
    'Minutes of the 2024 Granby Street streetscape hearing': 'number_street',
    'The 2023 Ocean View beach replenishment report': 'number_street',
    // Chesapeake Bay and Elizabeth River are also Norfolk street names.
    'The 2021 Chesapeake Bay TMDL plan for Norfolk': 'number_street',
    'The 2024 Elizabeth River Project shoreline report': 'number_street',
    'Was the tree from 1950 Colley?': 'number_street',
    'the tree at 2001 Colley in ghent': 'number_street',
    // After a year-like number, any other bare name mid-phrase is a street, as
    // after any number; a landmark that shares a street's name is refused too.
    'The tree in front of 1950 Colley was cut down': 'number_street',
    'The oak by 1950 Granby is gone': 'number_street',
    'tree removed near 1950 Granby, Norfolk': 'number_street',
    'the 1900 Granby block': 'number_street',
    'Was the tree near 2010 Bolling removed last week': 'number_street',
    'what about 2001 Colley, the house with the oak': 'number_street',
    'near 2001 colley av': 'number_street',
    'Results of the 2022 Lafayette River cleanup': 'number_street',
    'granby and brambleton': 'intersection',
    'ocean view and granby': 'intersection',
    'corner of colley & 21st': 'intersection',
    '21st and Colley': 'intersection',
    'Granby and 21st': 'intersection',
    'Was the tree at Granby & 21st removed?': 'intersection',
  };
  for (const [t, code] of Object.entries(blocked)) assert.ok(publicTextViolations(t, { streets }).includes(code), `${t} -> ${code}`);
});

