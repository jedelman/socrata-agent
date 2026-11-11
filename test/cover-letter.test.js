// get_legislation's cover letter (src/adapters/iqm2.js parseTransmittal).
// Jason, 2026-11-11, "Yes": Siren reads the City's cover letter to Council,
// the Description, Analysis and Financial Impact (and a planning item's
// Request), never the Applicant section, with a person's name withheld.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLegiFile, parseTransmittal } from '../src/adapters/iqm2.js';

const fixture = readFileSync(new URL('./fixtures/iqm2-legifile.html', import.meta.url), 'utf8');
const page = (letter) => `<h4>Council Transmittal Letter</h4><div class='LegiFileSectionContents'><div>${letter}</div></div><h4>Meeting History</h4>`;

test('the kept sections only: request and description from the fixture, nothing from Applicant or Payment of Taxes', () => {
  const r = parseTransmittal(fixture);
  assert.equal(r.request, 'To amend the existing proffers and allow a kennel at 111 Pennsylvania Avenue.');
  assert.match(r.description, /^The site is located on the southeast corner of Omohundro and Pennsylvania Avenues/);
  assert.ok(!JSON.stringify(r).includes('current on all taxes'), 'Payment of Taxes (it names the owner) is left out');
  assert.ok(!JSON.stringify(r).includes('Meowkins'), 'the Applicant section is left out');
  assert.equal(parseLegiFile(fixture).cover_letter.request, r.request, 'get_legislation carries it as cover_letter');
});

test("an applicant who isn't plainly an organization is withheld wherever named, and so is a name after a courtesy title", () => {
  const r = parseTransmittal(page(`<p>I. Recommendation: Adopt Ordinance</p><p>II. Applicant: Jane Q. Doe 123 Example Street Norfolk, VA 23510</p><p>III. Description: Jane Q. Doe requests a permit for a short-term rental.</p><p>IV. Analysis: Mr. John Smith spoke in favor. The use fits the plan.</p><p>V. Financial Impact: None.</p>`));
  assert.equal(r.description, 'the applicant requests a permit for a short-term rental.');
  assert.equal(r.analysis, '[name withheld] spoke in favor. The use fits the plan.');
  assert.equal(r.financial_impact, 'None.');
  assert.equal(r.applicant_name_withheld, true);
  assert.ok(!JSON.stringify(r).includes('Doe') && !JSON.stringify(r).includes('Smith') && !JSON.stringify(r).includes('Example Street'));
});

test('an organization applicant stays named; the money and analysis come through', () => {
  const r = parseTransmittal(page(`<p>I. Recommendation: Adopt Ordinance</p><p>II. Applicant: 25 Hospitality LLC MacArthur Center 300 Monticello Avenue</p><p>III. Description: An ordinance authorizing a First Amendment to Lease with 25 Hospitality LLC.</p><p>IV. Analysis: The City is taking steps to address existing lease obligations in the mall.</p><p>V. Financial Impact: The City shall provide $1,500,000 to the tenant.</p><p>VI. Environmental: None.</p>`));
  assert.match(r.description, /25 Hospitality LLC/);
  assert.match(r.financial_impact, /\$1,500,000/);
  assert.equal(r.applicant_name_withheld, undefined);
  assert.ok(!('environmental' in r));
});

test('the older letter format keeps the body between the salutation and the sign-off, even split by markup', () => {
  const r = parseTransmittal(page(`<p>Re: FY'24 Budget Amendment</p><p>Dear Ladies and Gentlemen:</p><p>This ordinance amends the budget. </p><p>Re<span>spectfully</span>,</p><p>A City Attorney</p>`.replace('Re<span>spectfully</span>', 'Re spectfully')));
  assert.deepEqual(r, { letter: 'This ordinance amends the budget.' });
});

test('no letter, no field; a long section is cut and marked', () => {
  assert.equal(parseTransmittal('<html>no letter here</html>'), null);
  assert.equal(parseLegiFile('<html></html>').cover_letter, undefined);
  const r = parseTransmittal(page(`<p>I. Request: ${'word '.repeat(400)}</p><p>II. Description: short.</p>`));
  assert.ok(r.request.length <= 1210 && r.request.endsWith('…'));
});
