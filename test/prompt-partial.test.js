// The partial-answer rule (Jason, 2026-11-10, after "What's the plan for
// MacArthur Mall?"): lead with an exact sentence, give what was found, then
// (2026-11-11: "automatically summarize instead of prompting the user for it")
// a summary under its own lead, closed by the "AI can make mistakes" caveat.
// The sentences are pinned here, they pass the voice check, and every
// deployment's prompt carries them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemPrompt, PARTIAL_LEAD, SUMMARY_LEAD, SUMMARY_CAVEAT, PARTIAL_PROMPT } from '../src/prompt.js';
import { voiceViolations } from '../src/voice.js';
import { getCity } from '../src/cities/index.js';
import { applyConfig } from '../src/plugins.js';
import siren from '../deployments/siren.config.js';

test("the partial-answer sentences are exactly Jason's, and pass the voice check", () => {
  assert.equal(PARTIAL_LEAD, "I can't say that for sure, but here's what I found:");
  assert.equal(SUMMARY_LEAD, 'What this might add up to:');
  assert.match(SUMMARY_CAVEAT, /^AI can make mistakes/);
  for (const s of [PARTIAL_LEAD, SUMMARY_LEAD, SUMMARY_CAVEAT]) assert.deepEqual(voiceViolations(s), [], s);
});

test('every prompt carries the rule, before the suggest-a-source line, and quotes the sentences exactly', () => {
  for (const city of [getCity('norfolk'), applyConfig(getCity('norfolk'), siren), getCity('seattle'), getCity('chicago')]) {
    const p = systemPrompt(city, '2026-11-10');
    assert.ok(p.includes(PARTIAL_PROMPT), city.name);
    assert.ok(p.includes(`"${PARTIAL_LEAD}"`) && p.includes(`"${SUMMARY_LEAD}"`) && p.includes(`"${SUMMARY_CAVEAT}"`));
    // The summary is given, never offered (Jason, 2026-11-11).
    assert.match(PARTIAL_PROMPT, /without asking/);
    assert.match(PARTIAL_PROMPT, /Don't offer a summary or ask whether to give one\./);
    assert.doesNotMatch(p, /Want me to summarize|If they ask for that summary/);
    assert.ok(p.indexOf(PARTIAL_PROMPT) < p.indexOf("When the records you can reach don't answer the question"), 'partial findings come before the no-answer fallback');
    assert.match(p, /try the other names the City may record it under/);
  }
  // With gaps on, the suggest line is swapped for the gaps line; the rule stays.
  assert.ok(systemPrompt(getCity('norfolk'), '2026-11-10', { gaps: true }).includes(PARTIAL_PROMPT));
});
