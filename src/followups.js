// Follow-up offers (Jason, 2026-11-10: "rather than saying 'I didn't read
// this source', let's let Siren add a button with a preloaded followup
// question prompt that says 'Would you like me to look into that?' AS LONG AS
// the source is actually available"). The model calls offer_followup for a
// source it mentions but hasn't read; code decides whether the source is one
// Siren's tools can open (a record or dataset page this answer handed off, or
// a web page its search returned) and checks the question as other text
// people see. A source it can't open goes to suggest_data_source instead.

import { normalizeUrl, readableSources, unescapeMarkdown } from './answer-links.js';
import { voiceViolations } from './voice.js';
import { publicTextViolations, publicTextMessage } from './public-text.js';

/** The button's label, exactly (worker/chat-page.js and worker/questions-page.js show it). */
export const FOLLOWUP_LABEL = 'Would you like me to look into that?';
export const MAX_FOLLOWUPS = 2;
export const FOLLOWUP_QUESTION_CHARS = 200;
export const FOLLOWUP_TITLE_CHARS = 200;

export const OFFERED_NOTE = `The person will see a button under your answer reading "${FOLLOWUP_LABEL}" that asks this question for them. In your answer, mention the source without saying you didn't read it.`;
export const NOT_OPENABLE_NOTE = "That url isn't one of the sources your tools returned for this answer, so it can't be offered: you can't open it. If a source would answer the question but your tools can't reach it, call suggest_data_source instead.";

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The sources this answer can offer to read, by normalized URL: the
 * hand-off's records and dataset pages, and the web pages search returned so
 * far (handed off only when the answer is done).
 */
export function offerableSources(ctx) {
  const map = readableSources(ctx.resources.toJSON());
  for (const r of ctx.webResults || []) {
    const key = normalizeUrl(r?.url);
    if (r?.url && !map.has(key)) map.set(key, { title: String(r.title || r.url), url: r.url });
  }
  return map;
}

/** offer_followup's executor. Attaches to ctx.followups; returns what the model is told. */
export function offerFollowup(ctx, args = {}) {
  ctx.followups ||= [];
  const source = offerableSources(ctx).get(normalizeUrl(unescapeMarkdown(args.url)));
  if (!source) return { offered: false, note: NOT_OPENABLE_NOTE };
  if (ctx.followups.some((f) => normalizeUrl(f.url) === normalizeUrl(source.url))) return { offered: true, note: 'This source is already offered.' };
  if (ctx.followups.length >= MAX_FOLLOWUPS) return { offered: false, note: `${MAX_FOLLOWUPS} follow-ups are already offered for this answer.` };
  const question = clean(args.question);
  if (!question) return { offered: false, note: 'Give the question the button will ask.' };
  if (question.length > FOLLOWUP_QUESTION_CHARS) return { offered: false, note: `Keep the question under ${FOLLOWUP_QUESTION_CHARS} characters.` };
  // The question is shown under the answer, and on the public page it goes
  // into a public question: it follows the voice contract and keeps out
  // addresses, contacts and people.
  const voice = voiceViolations(question);
  if (voice.length) return { offered: false, note: 'Rephrase the question without "there is", "there are", "nobody" or "no one".' };
  const codes = publicTextViolations(question, { streets: ctx.gaps?.streets });
  if (codes.length) return { offered: false, note: `Rephrase the question. ${publicTextMessage(codes)}` };
  // The title shown beside the button is the hand-off's own, not the model's.
  ctx.followups.push({ question, source_title: clean(source.title).slice(0, FOLLOWUP_TITLE_CHARS) || clean(args.source_title).slice(0, FOLLOWUP_TITLE_CHARS), url: source.url });
  return { offered: true, note: OFFERED_NOTE };
}

/** The follow-ups whose source is still in the final hand-off (a web page is handed off only if the answer cites it, or cites none). */
export function finalFollowups(followups = [], resources = {}) {
  const sources = readableSources(resources);
  return followups.filter((f) => sources.has(normalizeUrl(f.url)));
}
