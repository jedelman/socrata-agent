// The voice contract: the agent reports what its queries returned, never what
// is true about the world. "There is" claims the world; "I found" claims the
// query. This check is deterministic so it can't be talked out of.

const THERE_IS = /\b(?:there(?:'s|’s| is| are| was| were| isn't| isn’t| aren't| aren’t| exists?| seems?| appears?)|nobody|no one|no-one)\b/gi;

// Remove what the agent is quoting rather than asserting: code spans/blocks,
// quoted strings and block quotes.
function stripQuoted(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    // A quotation opens at the start or after space/brackets, so an inch mark
    // (6") can't swallow the sentences that follow it.
    .replace(/(^|[\s(\[])"[^"\n]*"(?=$|[\s.,;:!?)\]])/g, '$1 ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/^>.*$/gm, ' ');
}

export function voiceViolations(text) {
  const found = [];
  const clean = stripQuoted(text || '');
  for (const m of clean.matchAll(THERE_IS)) {
    const start = Math.max(0, m.index - 40);
    found.push(clean.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim());
  }
  return found;
}

// The voice rule as one fix among others (fixInstruction): the same words as
// REWRITE_INSTRUCTION, which stays as it was for an answer with no other findings.
export const VOICE_FIX =
  'Every sentence that asserts something exists or does not exist ' +
  '("there is", "there are", "there were", "there\'s", "nobody", "no one") must instead report what you found or saw: ' +
  '"I found…", "I see…", "I found no…".';

/** The rewrite instruction when the check stage found something: the voice fix if needed, then each finding. */
export const fixInstruction = ({ voice = false, notes = '' } = {}) =>
  ['Rewrite your last answer, fixing only what follows.', voice ? VOICE_FIX : '', notes, 'Keep everything else (every other fact, number, date and link) exactly as it was. Return only the rewritten answer.'].filter(Boolean).join(' ');

export const REWRITE_INSTRUCTION =
  'Rewrite your last answer. Every sentence that asserts something exists or does not exist ' +
  '("there is", "there are", "there were", "there\'s", "nobody", "no one") must instead report what you found or saw: ' +
  '"I found…", "I see…", "I found no…". Keep every fact, number, date and link exactly as it was. ' +
  'Return only the rewritten answer.';
