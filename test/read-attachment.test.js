// read_attachment (plugins/read-attachment.js; Jason, 2026-11-18: "If the
// reader works quickly, can we just make it a tool call for Siren instead of
// making her request the source?"): a legislative record's attached
// documents, read in the answer, cited by page, never correspondence, never a
// URL the model gives. The City is faked here; the PDFs are written by
// test/fake-pdf.js and the names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { readable, termsOf, passagesOf } from '../plugins/read-attachment.js';
import { parseAttachments } from '../src/adapters/iqm2.js';
import { pluginContext, tracedHttp } from '../src/plugins.js';
import { Trace } from '../src/trace.js';
import { getCity } from '../src/cities/index.js';
import { makePdf } from './fake-pdf.js';

const BASE = 'https://norfolkcityva.iqm2.com';
const page = (links) => `<html><h4>Attachments</h4><div id="divSnapshotDropdown"></div><ol class="UndecoratedList LegiFileSectionContents">${links.map(([id, title, host = 'https://NorfolkCityVA.iqm2.com']) => `<li class="snapShotListItem"><a id='lnkDownload' href='${host}/Citizens/FileOpen.aspx?Type=4&ID=${id}' target='_blank'>${title}</a></li>`).join('')}</ol></div><div class="LegiFileSection" id="divBody"><h4>Council Transmittal Letter</h4><a href='FileOpen.aspx?Type=4&ID=999'>not in the list</a></div></html>`;

const AGREEMENT = [
  ['COOPERATION AGREEMENT', 'C. The Authority has requested that the City advance to the Authority Two Hundred Thousand', 'Dollars ($200,000.00) (the "Funding Advance").', '1. The City agrees to advance the Funding Advance to the Authority.'],
  ['2. Authority Obligations; Reimbursement. Upon receipt of the Grant funds, the Authority will', 'reimburse City for the full amount of the Funding Advance.', '3. Term. This Agreement ends when the Funding Advance is repaid.'],
];

async function setup({ links, files = {}, headers = {} }) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    if (url === `${BASE}/Citizens/Detail_LegiFile.aspx?ID=5949`) return new Response(page(links), { headers: { 'Content-Type': 'text/html' } });
    const m = /FileOpen\.aspx\?Type=4&ID=(\d+)$/.exec(url);
    if (m && files[m[1]]) return new Response(files[m[1]], { headers: { 'Content-Type': 'application/pdf', ...headers } });
    return new Response('not faked', { status: 404 });
  };
  const trace = new Trace();
  const records = [];
  const ctx = pluginContext({ city: getCity('norfolk'), trace, http: tracedHttp(trace, fetchImpl), resources: { addRecord: (r) => records.push(r), addLink() {} }, socrata: {} });
  return { ctx, calls, trace, records };
}

test('what is read: instruments yes, correspondence from the public never', () => {
  for (const t of ['Exhibit A to Ordinance-Cooperation Agreement-VBRSP Grant FY26-v.3', 'Exhibit B - Lease', 'Staff Report', 'Letter of Intent', 'Development Agreement', 'Site Plan', 'Presentation']) assert.equal(readable(t), true, t);
  for (const t of ['Letter of Opposition from Jane Example', 'Letter of Support', 'Petition in Support', 'Public Comments', 'Minutes', 'Correspondence', 'Emails Received', 'Speaker Sign-In Sheet', 'Neighbor Responses', 'Letters']) assert.equal(readable(t), false, t);
  // Word starts: "repayment" finds "repay", "advance" finds "advanced", "reimbursement" finds "reimburse".
  assert.deepEqual(termsOf('What does it say about repayment of the advance?'), ['repay', 'advan']);
  assert.deepEqual(termsOf('reimbursement'), ['reimburse']);
});

test('the attachments list: only the page\'s own Attachments list, iqm2 attachment files only', () => {
  assert.deepEqual(parseAttachments(page([['25519', 'Exhibit A &amp; Schedule'], ['25520', 'Letter of Opposition']])), [{ id: '25519', title: 'Exhibit A & Schedule' }, { id: '25520', title: 'Letter of Opposition' }]);
  assert.deepEqual(parseAttachments('<html>no list</html>'), []);
});

test('reads the one attachment: passages cited by page, the file in the hand-off, every request traced', async () => {
  const { ctx, calls, trace, records } = await setup({ links: [['25519', 'Exhibit A - Cooperation Agreement']], files: { 25519: await makePdf(AGREEMENT) } });
  const out = await plugin.run(ctx, { legislation_id: '5949', query: 'repayment or reimbursement' });
  assert.equal(out.attachment.pages, 2);
  assert.equal(out.attachment.url, `${BASE}/Citizens/FileOpen.aspx?Type=4&ID=25519`);
  assert.ok(out.passages.length >= 1);
  assert.ok(out.passages.some((p) => p.page === 2 && /reimburse City for the full amount of the Funding Advance/.test(p.text)), JSON.stringify(out.passages));
  assert.match(out.how, /give its page, and link the attachment/);
  assert.deepEqual(records, [{ kind: 'document', title: 'Exhibit A - Cooperation Agreement (attached to legislative record 5949)', url: `${BASE}/Citizens/FileOpen.aspx?Type=4&ID=25519` }]);
  assert.deepEqual(trace.steps.map((s) => s.tool), ["list the record's attachments", 'read attachment']);
  assert.equal(calls.length, 2);
  // One page in full.
  const p2 = await plugin.run(ctx, { legislation_id: '5949', page: 2 });
  assert.equal(p2.page, 2);
  assert.match(p2.text, /^2\. Authority Obligations; Reimbursement\./);
  assert.match((await plugin.run(ctx, { legislation_id: '5949', page: 9 })).error, /It has 2 pages/);
  // Nothing matched: the first page, said so.
  const none = await plugin.run(ctx, { legislation_id: '5949', query: 'zebra' });
  assert.deepEqual(none.passages, []);
  assert.match(none.note, /No passage matched/);
  assert.match(none.first_page, /COOPERATION AGREEMENT/);
});

test('correspondence is neither read nor listed by title; several attachments need a choice; the file URL is built from the city\'s own base', async () => {
  const { ctx, calls } = await setup({
    links: [['1', 'Exhibit A - Cooperation Agreement', 'https://evil.example'], ['2', 'Letter of Opposition from Jane Example'], ['3', 'Exhibit B - Site Map'], ['4', 'Petition in Support']],
    files: { 1: await makePdf(AGREEMENT), 3: await makePdf([['SITE MAP', 'Parcel boundaries of the site.']]) },
  });
  const list = await plugin.run(ctx, { legislation_id: '5949', query: 'repayment' });
  assert.deepEqual(list.attachments, [{ n: 1, title: 'Exhibit A - Cooperation Agreement' }, { n: 2, title: 'Exhibit B - Site Map' }]);
  assert.match(list.withheld, /2 attachments not listed: correspondence from the public/);
  assert.doesNotMatch(JSON.stringify(list), /Jane Example|Opposition|Petition/);
  assert.equal(calls.length, 1, 'no file read without a choice');
  const a = await plugin.run(ctx, { legislation_id: '5949', attachment: 'exhibit a', query: 'repayment' });
  assert.equal(a.attachment.url, `${BASE}/Citizens/FileOpen.aspx?Type=4&ID=1`, 'the page linked evil.example; the file comes from the city\'s base');
  assert.ok(calls.every((u) => u.startsWith(`${BASE}/`)));
  assert.deepEqual(a.other_attachments, [{ n: 2, title: 'Exhibit B - Site Map' }]);
  assert.equal((await plugin.run(ctx, { legislation_id: '5949', attachment: '2' })).attachment.title, 'Exhibit B - Site Map');
  assert.match((await plugin.run(ctx, { legislation_id: '5949', attachment: 'opposition' })).note, /No attachment matches/);
});

test('refusals: no person searches, a numeric id only, PDFs only, no scans, no files past the cap', async () => {
  const { ctx, calls } = await setup({ links: [['1', 'Exhibit A']], files: { 1: await makePdf([[' ']]) } });
  assert.match((await plugin.run(ctx, { legislation_id: '5949', query: 'what does Mr. Smith get' })).error, /topic, not a person/);
  assert.match((await plugin.run(ctx, { legislation_id: '5949', query: 'who owns the lot' })).error, /topic, not a person/);
  assert.match((await plugin.run(ctx, { legislation_id: 'https://evil.example/x' })).error, /numeric id/);
  assert.equal(calls.length, 0);
  assert.match((await plugin.run(ctx, { legislation_id: '5949' })).error, /no text layer/);
  const word = await setup({ links: [['1', 'Exhibit A']], files: { 1: new TextEncoder().encode('PK\u0003\u0004 a Word file') } });
  assert.match((await plugin.run(word.ctx, { legislation_id: '5949' })).error, /isn't a PDF/);
  const big = await setup({ links: [['1', 'Exhibit A']], files: { 1: await makePdf(AGREEMENT) }, headers: { 'Content-Length': String(20 * 1024 * 1024) } });
  await assert.rejects(plugin.run(big.ctx, { legislation_id: '5949' }), /too large/);
  const empty = await setup({ links: [['2', 'Letter of Opposition from Jane Example']] });
  const none = await plugin.run(empty.ctx, { legislation_id: '5949' });
  assert.deepEqual(none.attachments, []);
  assert.match(none.note, /no attachment this tool reads/);
  assert.doesNotMatch(JSON.stringify(none), /Jane/);
});

test('passages: the richest first, never overlapping, within the total', () => {
  const text = `${'filler words here. '.repeat(40)}The Authority will repay the advance in full. ${'more filler text. '.repeat(40)}Repayment is due on receipt of the grant.`;
  const ps = passagesOf([text, 'nothing'], ['repay', 'advance', 'grant']);
  assert.ok(ps.length >= 1 && ps.every((p) => p.page === 1));
  for (let i = 1; i < ps.length; i++) assert.ok(!ps[i].text.replace(/^… /, '').startsWith(ps[i - 1].text.replace(/ …$/, '').slice(-40)), 'no overlap');
  assert.ok(ps.reduce((n, p) => n + p.text.length, 0) <= 4500);
});
