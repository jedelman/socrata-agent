// Durable findings: content IDs, quote selectors, archive fallbacks, and the
// Web Annotation export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawCid, quoteSelector, checkFinding, Unreachable, Gone, ARCHIVE_FRESH_DAYS } from '../scripts/verify-cases.js';
import { toAnnotations, theRecord } from '../plugins/cases.js';

const today = '2026-11-04';
const now = Date.parse('2026-11-04T12:00:00Z');
const page = (s) => Buffer.from(`<html><body><p>${s}</p></body></html>`);
const QUOTE = 'Forestry has been unable to adopt a pro-active tree maintenance program';
const finding = (extra = {}) => ({ id: 'f1', quote: QUOTE, source: { title: 'Audit', url: 'https://example.gov/audit' }, checked: '2026-10-20', ...extra });

function fakeNet({ live, snapshots = {}, saveTo = null, archiveDown = false }) {
  const calls = { save: 0, raw: 0 };
  return {
    calls,
    live: async () => {
      if (live instanceof Error) throw live;
      return page(live);
    },
    archive: {
      lookup: async () => {
        if (archiveDown) throw new Unreachable('ECONNRESET');
        const ts = Object.keys(snapshots).sort().at(-1);
        return ts ? { url: `https://web.archive.org/web/${ts}/https://example.gov/audit`, timestamp: ts } : null;
      },
      raw: async (_url, ts) => {
        calls.raw++;
        if (archiveDown) throw new Unreachable('ECONNRESET');
        if (!(ts in snapshots)) throw new Unreachable('no such snapshot');
        return page(snapshots[ts]);
      },
      save: async () => {
        calls.save++;
        if (!saveTo) return null;
        snapshots[saveTo.ts] = saveTo.text;
        return { url: `https://web.archive.org/web/${saveTo.ts}/https://example.gov/audit`, timestamp: saveTo.ts };
      },
    },
  };
}

test('DASL raw CIDs match the published vectors', () => {
  assert.equal(rawCid(Buffer.from('hello')), 'bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq');
  assert.equal(rawCid(Buffer.alloc(0)), 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
});

test('a TextQuoteSelector carries the text around the quote', () => {
  const sel = quoteSelector('The audit found that   Forestry has been unable to adopt a pro-active tree maintenance program, given staffing.', QUOTE);
  assert.equal(sel.type, 'TextQuoteSelector');
  assert.equal(sel.exact, QUOTE);
  assert.match(sel.prefix, /audit found that $/);
  assert.match(sel.suffix, /^, given/);
  assert.equal(quoteSelector('nothing here', QUOTE), null);
});

test('live page holds the quote: ok, with evidence and a selector', async () => {
  const r = await checkFinding(finding(), { net: fakeNet({ live: `Draft. ${QUOTE}.` }), workDir: '/tmp', today, now });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.via, 'live');
  assert.equal(r.patch.checked_via, 'live');
  assert.match(r.patch.evidence.cid, /^bafkrei[a-z2-7]{52}$/);
  assert.equal(r.patch.selector.exact, QUOTE);
});

test('the live page changed but a snapshot holds the quote: warn, served as archived', async () => {
  const net = fakeNet({ live: 'A revised page.', snapshots: { '20260401000000': `Draft. ${QUOTE}.` } });
  const r = await checkFinding(finding(), { net, workDir: '/tmp', today, now });
  assert.equal(r.outcome, 'warn');
  assert.equal(r.via, 'archive');
  assert.match(r.message, /no longer shows the quote; the snapshot from 2026-04-01/);
  assert.equal(r.patch.source.archive.timestamp, '20260401000000');
  assert.equal(r.patch.checked_via, 'archive');
});

test('blocked from here but a snapshot holds the quote: ok via the archive', async () => {
  const r = await checkFinding(finding(), { net: fakeNet({ live: new Unreachable('fetch failed'), snapshots: { '20260501000000': QUOTE } }), workDir: '/tmp', today, now });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.via, 'archive');
});

test('the source is gone but a snapshot holds the quote: warn; with no snapshot: fail', async () => {
  const kept = await checkFinding(finding(), { net: fakeNet({ live: new Gone('HTTP 404'), snapshots: { '20260501000000': QUOTE } }), workDir: '/tmp', today, now });
  assert.equal(kept.outcome, 'warn');
  assert.match(kept.message, /the source is gone/);
  const lost = await checkFinding(finding(), { net: fakeNet({ live: new Gone('HTTP 404') }), workDir: '/tmp', today, now });
  assert.equal(lost.outcome, 'fail');
});

test('no archive from here: the 30-day rule still applies, and a down archive is noted, not fatal', async () => {
  const recent = await checkFinding(finding(), { net: fakeNet({ live: new Unreachable('fetch failed'), archiveDown: true }), workDir: '/tmp', today, now });
  assert.equal(recent.outcome, 'warn');
  assert.ok(recent.notes.some((n) => /archive/.test(n)));
  const old = await checkFinding(finding({ checked: '2026-08-01' }), { net: fakeNet({ live: new Unreachable('fetch failed'), archiveDown: true }), workDir: '/tmp', today, now });
  assert.equal(old.outcome, 'fail');
});

test('a finding about something absent is never proven from an old snapshot', async () => {
  const f = finding({ quote: 'Localities where the tax applies', absent: 'Norfolk' });
  const net = fakeNet({ live: new Unreachable('fetch failed'), snapshots: { '20260101000000': 'Localities where the tax applies: Richmond' } });
  const r = await checkFinding(f, { net, workDir: '/tmp', today, now });
  assert.equal(r.via, 'none');
  assert.equal(net.calls.raw, 0);
  const present = await checkFinding(f, { net: fakeNet({ live: 'Localities where the tax applies: Norfolk' }), workDir: '/tmp', today, now });
  assert.equal(present.outcome, 'fail');
});

test('--archive records a snapshot that holds the quote, saving one if needed', async () => {
  const existing = await checkFinding(finding(), { net: fakeNet({ live: QUOTE, snapshots: { '20260301000000': QUOTE } }), workDir: '/tmp', today, now, archiveMode: true });
  assert.equal(existing.patch.source.archive.timestamp, '20260301000000');
  assert.equal(existing.patch.source.archive.verified, today);

  const net = fakeNet({ live: QUOTE, saveTo: { ts: '20261104120000', text: QUOTE } });
  const saved = await checkFinding(finding(), { net, workDir: '/tmp', today, now, archiveMode: true });
  assert.equal(net.calls.save, 1);
  assert.equal(saved.patch.source.archive.timestamp, '20261104120000');

  const fresh = finding({ source: { title: 'A', url: 'https://example.gov/audit', archive: { url: 'u', timestamp: '20261101000000', verified: '2026-11-01' } } });
  const net2 = fakeNet({ live: QUOTE });
  const r = await checkFinding(fresh, { net: net2, workDir: '/tmp', today, now, archiveMode: true });
  assert.equal(r.patch.source, undefined, `a snapshot verified within ${ARCHIVE_FRESH_DAYS} days isn't redone`);
  assert.equal(net2.calls.raw, 0);
});

test('case files export as W3C Web Annotations, verified findings only', () => {
  const doc = {
    id: 'demo', title: 'Demo', license: 'CC-BY-4.0',
    findings: [
      { id: 'a', stance: 'confirms', claim: 'A claim.', quote: QUOTE, source: { title: 'Audit', url: 'https://example.gov/audit', archive: { url: 'https://web.archive.org/web/20260401000000/https://example.gov/audit', timestamp: '20260401000000' } }, checked: today, found_by: 'Someone', selector: { type: 'TextQuoteSelector', exact: QUOTE, prefix: 'p ', suffix: ' s' }, evidence: { cid: 'bafkreiexample', bytes: 10, read: today } },
      { id: 'b', stance: 'context', claim: 'Unverified.', source: { title: 'X', url: 'https://x' }, unverified: true },
    ],
  };
  const out = toAnnotations(doc, 'https://site/ask-siren');
  assert.equal(out.type, 'AnnotationCollection');
  assert.equal(out.total, 1);
  const a = out.first.items[0];
  assert.equal(a.id, 'https://site/ask-siren/api/cases/demo#a');
  assert.equal(a.motivation, 'assessing');
  assert.equal(a.target.selector.type, 'TextQuoteSelector');
  assert.equal(a.target.state.type, 'TimeState');
  assert.equal(a.target.state.sourceDate, '2026-04-01T00:00:00Z');
  assert.equal(a['prov:wasDerivedFrom'].evidenceCid, 'bafkreiexample');
  assert.ok(out['@context'].includes('http://www.w3.org/ns/anno.jsonld'));
});

test('the record links the snapshot and says when a finding stands on the archive', () => {
  const ctx = { cite: () => {}, resources: { addRecord: () => {} } };
  const doc = {
    id: 'demo', title: 'Demo', summary: 's', what_would_help: [], records_to_request: [],
    findings: [{ id: 'a', stance: 'confirms', claim: 'c', quote: 'q', source: { title: 'T', url: 'https://x', archive: { url: 'https://web.archive.org/web/20260401000000/https://x', timestamp: '20260401000000' } }, checked: today, checked_via: 'archive' }],
  };
  const r = theRecord(ctx, doc);
  assert.equal(r.confirms[0].archived, 'https://web.archive.org/web/20260401000000/https://x');
  assert.match(r.confirms[0].note, /archived copy from 2026-04-01/);
});
