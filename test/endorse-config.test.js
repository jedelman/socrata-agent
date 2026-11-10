// The endorsement record's one constant, its Lexicon, the subject URL and the
// record builder and validator (worker/endorse-config.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENDORSE_NSID, ENDORSE_SCOPE, OAUTH_SCOPE, ENDORSE_SOURCE, endorseSubject, buildEndorsement, validEndorsement, endorses, endorsedDay, capText,
  QUESTION_NSID, QUESTION_SCOPE, ASK_SCOPE, ASK_CLIENT_SCOPE, MAX_QUESTION_TEXT, buildQuestion, validQuestion, parseRecordUri, TID_RE,
} from '../worker/endorse-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON = JSON.parse(readFileSync(join(ROOT, 'lexicons/org/jason-edelman/siren/endorsement.json'), 'utf8'));
const QUESTION_LEXICON = JSON.parse(readFileSync(join(ROOT, 'lexicons/org/jason-edelman/siren/question.json'), 'utf8'));

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

test('each NSID string appears in exactly one source file: the endorsement\'s and the free tier\'s question\'s', () => {
  for (const nsid of [ENDORSE_NSID, QUESTION_NSID]) {
    const hits = files(ROOT)
      .filter((p) => /\.(js|mjs|html|toml|json|css)$/.test(p) && !p.endsWith('package-lock.json'))
      .filter((p) => readFileSync(p, 'utf8').includes(nsid))
      .map((p) => relative(ROOT, p));
    assert.deepEqual(hits, ['worker/endorse-config.js'], nsid);
  }
});

test('the question NSID is valid NSID syntax beside the endorsement one, and its Lexicon and scopes name it', () => {
  const parts = QUESTION_NSID.split('.');
  assert.ok(parts.length >= 3 && QUESTION_NSID.length <= 317);
  for (const p of parts.slice(0, -1)) assert.match(p, /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
  assert.match(parts.at(-1), /^[a-zA-Z][a-zA-Z0-9]{0,62}$/);
  assert.equal(parts.slice(0, -1).join('.'), ENDORSE_NSID.split('.').slice(0, -1).join('.'), 'the same authority as endorsements');
  assert.equal(QUESTION_LEXICON.id, QUESTION_NSID);
  assert.equal(QUESTION_LEXICON.defs.main.type, 'record');
  assert.equal(QUESTION_LEXICON.defs.main.key, 'tid');
  assert.deepEqual(QUESTION_LEXICON.defs.main.record.required, ['text', 'city', 'createdAt']);
  assert.equal(QUESTION_LEXICON.defs.main.record.properties.text.maxGraphemes, MAX_QUESTION_TEXT);
  assert.equal(MAX_QUESTION_TEXT, 600, "the chat's limit");
  assert.equal(QUESTION_SCOPE, `repo:${QUESTION_NSID}?action=create&action=delete`);
  assert.equal(ASK_SCOPE, `atproto ${QUESTION_SCOPE}`);
  assert.equal(ASK_CLIENT_SCOPE, `atproto ${QUESTION_SCOPE} ${ENDORSE_SCOPE}`);
  for (const s of [ASK_SCOPE, ASK_CLIENT_SCOPE]) assert.ok(!s.includes('transition:'), 'never transition:generic');
});

test('the question record: built and checked against its Lexicon and the chat\'s input checks; hostile records are not', () => {
  const rec = buildQuestion({ text: '  What is on my block?\n', city: 'norfolk', now: Date.parse('2026-11-10T12:00:00Z') });
  assert.deepEqual(rec, { $type: QUESTION_NSID, text: 'What is on my block?', city: 'norfolk', createdAt: '2026-11-10T12:00:00.000Z' });
  const { $type, ...body } = rec;
  checkLexicon(body, QUESTION_LEXICON.defs.main.record, QUESTION_LEXICON.defs);
  assert.ok(validQuestion(rec));
  assert.ok(validQuestion({ ...rec, text: '👩‍👩‍👧‍👦'.repeat(54) }), 'within 600 UTF-16 units');
  for (const bad of [
    null, [], {}, { ...rec, $type: undefined }, { ...rec, $type: ENDORSE_NSID }, { ...rec, text: '' }, { ...rec, text: ' \n ' }, { ...rec, text: 'x'.repeat(601) },
    { ...rec, text: 5 }, { ...rec, city: 'Norfolk' }, { ...rec, city: '../x' }, { ...rec, createdAt: '2026-11-10' }, { ...rec, createdAt: 'now' },
    { ...rec, reply: 'x' }, { ...rec, embed: {} },
  ]) assert.equal(validQuestion(bad), false, JSON.stringify(bad)?.slice(0, 80));
  assert.deepEqual(parseRecordUri(`at://did:plc:abcdefghijklmnopqrstuvwx/${QUESTION_NSID}/3kabcdefghijk`), { did: 'did:plc:abcdefghijklmnopqrstuvwx', collection: QUESTION_NSID, rkey: '3kabcdefghijk' });
  for (const bad of ['', 'at://x', 'https://pds/x/y/z', `at://alice.bsky.social/${QUESTION_NSID}/3kabcdefghijk`, `at://did:plc:a/${QUESTION_NSID}/3k/x`, `at://did:plc:a/${QUESTION_NSID}/${'x'.repeat(600)}`]) assert.equal(parseRecordUri(bad), null, bad);
  // A follow-up: reply {root, parent}, each a strongRef to a question record.
  const ref = { uri: `at://did:plc:abcdefghijklmnopqrstuvwx/${QUESTION_NSID}/3kabcdefghijk`, cid: 'bafyreiabcdefgh' };
  const reply = buildQuestion({ text: 'And then?', city: 'norfolk', now: 0, reply: { root: ref, parent: { ...ref, extra: 1 } } });
  assert.deepEqual(reply.reply, { root: ref, parent: ref }, 'strongRefs only');
  assert.ok(validQuestion(reply));
  assert.ok(validQuestion({ ...reply, reply: { $type: `${QUESTION_NSID}#replyRef`, root: { $type: 'com.atproto.repo.strongRef', ...ref }, parent: ref } }));
  assert.deepEqual(QUESTION_LEXICON.defs.main.record.properties.reply, { type: 'ref', ref: '#replyRef', description: QUESTION_LEXICON.defs.main.record.properties.reply.description });
  assert.deepEqual(QUESTION_LEXICON.defs.replyRef.required, ['root', 'parent']);
  for (const k of ['root', 'parent']) assert.deepEqual(QUESTION_LEXICON.defs.replyRef.properties[k], { type: 'ref', ref: 'com.atproto.repo.strongRef' });
  for (const bad of [
    { root: ref }, { root: ref, parent: ref, other: ref }, { root: ref, parent: { uri: ref.uri } }, { root: ref, parent: { ...ref, extra: 1 } },
    { root: ref, parent: { ...ref, uri: 'at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3kabcdefghijk' } }, { root: ref, parent: { ...ref, cid: 'NOT A CID' } },
    { root: ref, parent: { ...ref, uri: `at://did:plc:abcdefghijklmnopqrstuvwx/${QUESTION_NSID}/self` } }, 'at://x', null, [],
  ]) assert.equal(validQuestion({ ...rec, reply: bad }), false, JSON.stringify(bad)?.slice(0, 80));
  assert.match('3kabcdefghijk', TID_RE);
  for (const bad of ['self', '3kabcdefghij', '1kabcdefghijk', '3KABCDEFGHIJK']) assert.doesNotMatch(bad, TID_RE);
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
