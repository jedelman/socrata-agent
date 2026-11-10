// The endorsement record's one constant, its Lexicon, the subject URL and the
// record builder and validator (worker/endorse-config.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDORSE_NSID, ENDORSE_SCOPE, OAUTH_SCOPE, ENDORSE_SOURCE, endorseSubject, buildEndorsement, validEndorsement, endorses, endorsedDay, capText,
} from '../worker/endorse-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON = JSON.parse(readFileSync(join(ROOT, 'lexicons/org/jason-edelman/siren/endorsement.json'), 'utf8'));

test('the NSID is valid atproto NSID syntax, and the Lexicon names it', () => {
  // atproto.com/specs/nsid: domain segments a-z0-9- (no edge hyphens), a
  // final name segment of letters and digits not starting with a digit, at
  // least three segments, at most 317 characters.
  const parts = ENDORSE_NSID.split('.');
  assert.ok(parts.length >= 3 && ENDORSE_NSID.length <= 317);
  for (const p of parts.slice(0, -1)) assert.match(p, /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
  assert.match(parts.at(-1), /^[a-zA-Z][a-zA-Z0-9]{0,62}$/);
  assert.equal(LEXICON.id, ENDORSE_NSID);
  assert.equal(LEXICON.defs.main.type, 'record');
  assert.equal(LEXICON.defs.main.key, 'any');
  assert.equal(ENDORSE_SCOPE, `repo:${ENDORSE_NSID}?action=create&action=delete`);
  assert.equal(OAUTH_SCOPE, `atproto ${ENDORSE_SCOPE}`);
  assert.ok(!OAUTH_SCOPE.includes('transition:'), 'never transition:generic');
  assert.equal(ENDORSE_SOURCE, `${ENDORSE_NSID}:subject.uri`);
});

function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.git', 'lexicons', 'docs', 'data', 'eval'].includes(f)) return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('the NSID string appears in exactly one source file', () => {
  const hits = files(ROOT)
    .filter((p) => /\.(js|mjs|html|toml|json|css)$/.test(p) && !p.endsWith('package-lock.json'))
    .filter((p) => readFileSync(p, 'utf8').includes(ENDORSE_NSID))
    .map((p) => relative(ROOT, p));
  assert.deepEqual(hits, ['worker/endorse-config.js']);
});

test('the subject URL is canonical: one shape, from PUBLIC_ORIGIN only', () => {
  const id = 'abcdefghijklmnop';
  // Siren's subjects since 2026-11-10: its own origin, no base path.
  assert.equal(endorseSubject('https://ask-siren.jason-edelman.org', '', id), `https://ask-siren.jason-edelman.org/requests/${id}`);
  assert.equal(endorseSubject('https://example.org', '/ask-siren', id), `https://example.org/ask-siren/requests/${id}`);
  assert.equal(endorseSubject('http://127.0.0.1:8787', '', id), `http://127.0.0.1:8787/requests/${id}`);
  for (const [origin, base, i] of [
    ['https://Jason-Edelman.org', '/ask-siren', id],
    ['https://jason-edelman.org/', '/ask-siren', id],
    ['https://jason-edelman.org', '/ask-siren/', id],
    ['https://jason-edelman.org', '/Ask-Siren', id],
    ['http://jason-edelman.org', '/ask-siren', id],
    ['https://jason-edelman.org', '/ask-siren', 'abcdefabcdef'],
    ['https://jason-edelman.org', '/ask-siren', `${id}/`],
    ['https://jason-edelman.org', '/ask-siren?x', id],
    ['https://ask-siren.jason-edelman.org', '/', id],
    ['https://ask-siren.jason-edelman.org/', '', id],
    ['https://ask-siren.jason-edelman.org', undefined, id],
  ]) assert.equal(endorseSubject(origin, base, i), null, `${origin} ${base} ${i}`);
  for (const [origin, base] of [['https://ask-siren.jason-edelman.org', ''], ['https://example.org', '/ask-siren']]) {
    const u = new URL(endorseSubject(origin, base, id));
    assert.equal(u.href, endorseSubject(origin, base, id), 'already normalized');
  }
});

// A small validator for the Lexicon's own shapes, so the builder is checked
// against the JSON file, not just against validEndorsement.
function checkLexicon(value, def, defs) {
  if (def.type === 'ref') return checkLexicon(value, defs[def.ref.slice(1)], defs);
  if (def.type === 'object') {
    assert.equal(typeof value, 'object');
    for (const k of def.required || []) assert.ok(k in value, `missing ${k}`);
    for (const [k, v] of Object.entries(value)) if (def.properties[k]) checkLexicon(v, def.properties[k], defs);
    return;
  }
  if (def.type === 'string') {
    assert.equal(typeof value, 'string');
    if (def.maxLength) assert.ok(value.length <= def.maxLength);
    if (def.maxGraphemes) assert.ok([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length <= def.maxGraphemes);
    if (def.format === 'datetime') assert.ok(Number.isFinite(Date.parse(value)) && /Z$|[+-]\d\d:\d\d$/.test(value));
    if (def.format === 'uri') assert.ok(new URL(value));
  }
}

test('the record builder validates against the Lexicon; hostile records do not', () => {
  const subject = endorseSubject('https://ask-siren.jason-edelman.org', '', 'abcdefghijklmnop');
  const long = '👩‍👩‍👧‍👦'.repeat(250);
  const rec = buildEndorsement({ subject, id: 'abcdefghijklmnop', title: `Tree inventory\u0000 ${long}`, now: Date.parse('2026-11-09T12:00:00Z') });
  assert.equal(rec.$type, ENDORSE_NSID);
  const { $type, ...body } = rec;
  checkLexicon(body, LEXICON.defs.main.record, LEXICON.defs);
  assert.ok(validEndorsement(rec));
  assert.ok(endorses(rec, subject));
  assert.ok(!rec.subject.title.includes('\u0000'));
  assert.equal(endorsedDay(rec, Date.parse('2026-11-10T00:00:00Z')), '2026-11-09');
  assert.equal(capText('ab👩‍👩‍👧‍👦c', 3), 'ab👩‍👩‍👧‍👦');
  for (const bad of [
    null, [], {}, { ...rec, $type: 'app.bsky.feed.post' }, { ...rec, createdAt: '2026-11-09' }, { ...rec, createdAt: 'yesterday' },
    { ...rec, subject: { ...rec.subject, uri: 'x'.repeat(600) } }, { ...rec, subject: { ...rec.subject, id: 5 } },
    { ...rec, subject: { ...rec.subject, title: 'x'.repeat(301) } }, { ...rec, subject: 'https://x' },
  ]) assert.equal(validEndorsement(bad), false, JSON.stringify(bad)?.slice(0, 80));
  assert.equal(endorses(rec, `${subject}/`), false, 'exact match only');
  assert.equal(endorsedDay({ ...rec, createdAt: '2099-01-01T00:00:00Z' }), null, 'not in the future');
});
