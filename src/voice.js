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
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
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

export const REWRITE_INSTRUCTION =
  'Rewrite your last answer. Every sentence that asserts something exists or does not exist ' +
  '("there is", "there are", "there were", "there\'s", "nobody", "no one") must instead report what you found or saw: ' +
  '"I found…", "I see…", "I found no…". Keep every fact, number, date and link exactly as it was. ' +
  'Return only the rewritten answer.';
