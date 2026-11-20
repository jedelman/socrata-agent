// The second read: a fresh model call that checks an answer against the
// evidence its tools returned (Jason, 2026-11-20: "give a fresh agent fresh
// context - the original question, the conclusion Siren reached"). It gets
// the question, the answer and the tool results, never the answering model's
// reasoning: reasoning would lead it to the same conclusion, and the tool
// results are what the answer has to stand on. Its flags are a model's
// judgment, so they are never the trace and never change an answer unless the
// deployment turns rewriting on (secondRead: 'rewrite'); by default ('shadow')
// they are recorded with the answer and shown under it.

export const SECOND_READ_MODES = Object.freeze(['off', 'shadow', 'rewrite']);
export const EVIDENCE_CHARS = 60000;
const MAX_FLAGS = 5;
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const SECOND_READ_SYSTEM = [
  'You check an answer that a city-records assistant wrote, against the evidence its tools returned. You did not write the answer.',
  'You get the question, the answer, and the evidence: the tool results the assistant read, which are the only evidence. Web pages it found by search are not included; do not flag a claim the answer attributes to a linked web page or news report.',
  'Find claims in the answer that the evidence does not support, or that say more than it does. For example: a fact, figure, date or name that is not in the evidence; a rule stated as allowed when the evidence says a permit may be required; a plan, report or proposal stated as a decision; a sample stated as a total; a source said to say something it does not.',
  'Do not flag wording, tone, missing detail, links or contacts, or claims the answer itself marks as uncertain.',
  'Reply with JSON only: {"flags":[{"claim":"<the answer\'s words, under 120 characters>","problem":"<what the evidence says instead, under 160 characters>"}]}, at most 5 flags. If every claim is supported, reply {"flags":[]}.',
].join('\n');

/** The evidence the second read gets: this answer's tool results (and any carried from earlier turns), in order, within EVIDENCE_CHARS. */
export function evidenceFor({ toolResults = [], carried = [], webPages = [] } = {}, maxChars = EVIDENCE_CHARS) {
  const parts = [
    ...carried.map((c) => ({ head: `Earlier in this conversation, ${c.name}`, body: String(c.content ?? '') })),
    ...toolResults.map((r, i) => ({ head: `Tool result ${i + 1}: ${r.name} ${clip(JSON.stringify(r.args ?? {}), 300)}`, body: String(r.content ?? '') })),
  ];
  const each = parts.length ? Math.max(2000, Math.floor((maxChars - 2000) / parts.length)) : 0;
  let text = parts.map((p) => `## ${p.head}\n${p.body.length > each ? `${p.body.slice(0, each)}… [cut]` : p.body}`).join('\n\n');
  if (webPages.length) text += `\n\n## Web pages the assistant found by search (not included here)\n${webPages.slice(0, 10).map((w) => `- ${clip(w.title, 120)} ${clip(w.url, 200)}`).join('\n')}`;
  return text.slice(0, maxChars) || '(no tool results)';
}

/** The second read's user message. */
export const secondReadMessage = ({ question, answer, evidence }) =>
  `<question>\n${clip(question, 2000)}\n</question>\n\n<answer>\n${String(answer ?? '').slice(0, 12000)}\n</answer>\n\n<evidence>\n${evidence}\n</evidence>`;

/** Flags from the checker's reply: [{ claim, problem }], or null when the reply isn't the JSON asked for. */
export function parseFlags(text) {
  const s = String(text ?? '');
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  let data;
  try {
    data = JSON.parse(s.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.flags)) return null;
  return data.flags
    .filter((f) => f && typeof f.claim === 'string' && typeof f.problem === 'string' && f.claim.trim() && f.problem.trim())
    .slice(0, MAX_FLAGS)
    .map((f) => ({ claim: clip(f.claim, 160), problem: clip(f.problem, 220) }));
}

/** The rewrite note for second-read flags, or ''. */
export const secondReadNote = (flags = []) =>
  flags.length ? `A second read of your answer against the tool results found: ${flags.map((f) => `"${f.claim}": ${f.problem}`).join('; ')}. Fix each where the tool results bear it out; say only what they show.` : '';

/**
 * Run the second read with `provider` (a fresh provider instance for this
 * call): { flags, cost } or { skipped, cost } when the reply couldn't be read.
 */
export async function secondRead(provider, { question, answer, evidence }) {
  provider.init({ systemPrompt: SECOND_READ_SYSTEM, history: [], question: secondReadMessage({ question, answer, evidence }), toolDefs: [] });
  const out = await provider.complete({ allowTools: false, retryTruncated: false });
  const flags = out.refusal || out.truncated ? null : parseFlags(out.text);
  return flags ? { flags, cost: out.cost || 0 } : { skipped: out.refusal ? 'the check was declined' : 'the check\'s reply could not be read', cost: out.cost || 0 };
}
