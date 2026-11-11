// Telemetry (worker/telemetry.js): one line per answer in Workers Logs, with
// TELEMETRY on. Jason, 2026-11-11: "set up otel logging to Cloudflare now
// that we have workers Paid". The line says how an answer was found, never
// what was asked or who asked it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerEvent, topicTerms, logAnswer, telemetryOn, TELEMETRY_NOTE, MAX_TERMS } from '../worker/telemetry.js';

const QUESTION = 'Jane Smith of 810 Union St wants to know about the MacArthur Mall plan';
const OUT = {
  answer: "I can't say that for sure, but here's what I found: the City plans a mixed-use district.",
  model: 'claude-sonnet-5-5', steps: 4, cost: 0.042137,
  toolResults: [
    { name: 'prior_research', args: { query: 'MacArthur mall redevelopment' }, content: QUESTION },
    { name: 'capital_projects', args: { project: 'MacArthur' } },
    { name: 'find_legislation', args: { text: '810 Union St' } },
    { name: 'budget_book_lookup', args: { query: 'Jane Smith salary' } },
    { name: 'block_report', args: { address: '810 Union St' } },
    { name: 'case_file', args: { topic: 'norfolk-macarthur-center' } },
  ],
  trace: [{ tool: 'web search (run by Anthropic)', query: QUESTION }],
  followups: [{ question: 'Read the ordinance?' }], suggestions: [], answerLinks: { kept: 2, dropped: 1 },
  voice: { ok: true }, requestBudget: { reached: false },
};

test('an answer line: how it was found, never the question, the answer, an address or a person', () => {
  const e = answerEvent(OUT, { tier: 'member', ms: 9123.6, city: 'norfolk' });
  assert.deepEqual(e.tools, { prior_research: 1, capital_projects: 1, find_legislation: 1, budget_book_lookup: 1, block_report: 1, case_file: 1, web_search: 1 });
  assert.equal(e.partial, true);
  assert.deepEqual(e.case_files, ['norfolk-macarthur-center']);
  assert.equal(e.ms, 9124);
  assert.equal(e.cost_usd, 0.0421);
  assert.equal(e.followups, 1);
  assert.equal(e.links_dropped, 1);
  const line = JSON.stringify(e).toLowerCase();
  for (const leak of ['jane', 'smith', '810', 'union', 'mixed-use', 'wants to know']) assert.ok(!line.includes(leak), leak);
  assert.deepEqual(Object.keys(e).sort(), ['budget_reached', 'case_files', 'city', 'cost_usd', 'event', 'followups', 'links_dropped', 'model', 'ms', 'partial', 'refused', 'steps', 'suggested_source', 'terms', 'tier', 'tools', 'v', 'voice_ok'], 'no field for an account, conversation, invite, IP or text');
});

test('topic words: only from topic tools, only text that passes the public-text checks, only words in the City\'s books', () => {
  assert.deepEqual(topicTerms(OUT.toolResults), ['macarthur', 'mall', 'redevelopment', 'salary']);
  // An address in a topic tool's text drops all of that text.
  assert.deepEqual(topicTerms([{ name: 'prior_research', args: { query: 'demolition at 300 Monticello Avenue' } }]), []);
  // A name after a courtesy title drops the text; a bare name drops out as not in the books.
  assert.deepEqual(topicTerms([{ name: 'prior_research', args: { query: 'Mr. Johnson demolition' } }]), []);
  assert.deepEqual(topicTerms([{ name: 'prior_research', args: { query: 'Krystal Okonkwo demolition' } }]), ['demolition']);
  // Tools that aren't topic tools give none (an address lookup least of all).
  assert.deepEqual(topicTerms([{ name: 'block_report', args: { address: 'MacArthur Center' } }, { name: 'query_dataset', args: { soql: 'redevelopment' } }]), []);
  const many = topicTerms([{ name: 'ordinance_lookup', args: { query: 'parking setback height density signage landscaping buffer screening fence lighting' } }]);
  assert.ok(many.length <= MAX_TERMS);
});

test('off: nothing logged; on: one JSON line, and a failure never throws', () => {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(s);
  try {
    logAnswer({}, OUT, { tier: 'member' });
    logAnswer({ TELEMETRY: 'false' }, OUT, { tier: 'member' });
    assert.equal(logs.length, 0);
    logAnswer({ TELEMETRY: 'true' }, OUT, { tier: 'public', ms: 1 });
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0]).event, 'siren.answer');
    assert.doesNotThrow(() => logAnswer({ TELEMETRY: 'true' }, null, {}));
  } finally {
    console.log = orig;
  }
  assert.equal(telemetryOn({ TELEMETRY: 'true' }), true);
  assert.match(TELEMETRY_NOTE('Siren'), /never your question, your account or an address, and keeps that for 7 days/);
});

test('wrangler.toml: Siren keeps Workers Logs without invocation logs or traces, with TELEMETRY on', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[env\.siren\.observability\]\nenabled = true/);
  assert.match(toml, /\[env\.siren\.observability\.logs\]\ninvocation_logs = false/, 'invocation logs record request URLs and headers: sign-in tokens, search words, cookies');
  assert.ok(!/\[env\.siren\.observability\.traces\]\s*\nenabled = true/.test(toml), 'traces record outbound URLs: the addresses people look up');
  assert.match(toml, /^TELEMETRY = "true"$/m);
});
