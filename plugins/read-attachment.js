// read_attachment: a document attached to one of the City's legislative
// records (an exhibit, agreement, contract, lease, plan or report), read in
// the answer that needs it (Jason, 2026-11-18: "If the reader works quickly,
// can we just make it a tool call for Siren instead of making her request the
// source?"). Exhibit A to Ordinance 50487, the Military Circle cooperation
// agreement, is a 137 KB, 4-page PDF that src/pdf.js reads in under 100 ms.
//
// What it reads, and what it never does:
// - Only attachments the record's own iqm2 page lists (FileOpen Type=4), by
//   the record's numeric id: the model never gives a URL, and each file's URL
//   is built from the city profile's iqm2 base, never from the page's link.
// - Correspondence (letters, petitions, comments, testimony) is read like
//   any other attachment, and never made searchable or alertable (Jason,
//   2026-11-18: "it's okay to make correspondence attachments readable -
//   they're public records. As long as they're not searchable and alertable.
//   It's a city - it's okay for citizens to encounter each other in public!").
//   So its hand-off record carries a generic title, never the writer's name,
//   and research memory and shared sources, which keep hand-off titles, never
//   hold one; watches never read attachments at all.
// - PDFs only, at most 10 MB, through the traced, counted fetch and the PDF
//   reader's own limits. A scan with no text layer, an encrypted file or
//   another format is said so, never guessed at.
// - A search can't name a person ("Mr. Smith", "who owns ...").
// Returns the passages that match the question's words, cited by page, or one
// page in full; the attachment joins the answer's hand-off so it can be linked.

import { definePlugin } from '../src/plugins.js';
import { parseAttachments } from '../src/adapters/iqm2.js';
import { pdfText } from '../src/pdf.js';
import { publicTextViolations, publicTextMessage } from '../src/public-text.js';

export const MAX_BYTES = 10 * 1024 * 1024;
const PAGE_CHARS = 6000;
const PASSAGE_CHARS = 900;
const PASSAGES = 6;
const TOTAL_CHARS = 4500;

// Correspondence: the public's own words to the City.
const CORRESPONDENCE = /\b(?:letters?|petitions?|opposition|opposed|(?:letters? of|in) support|support(?:ers?|ing)? letters?|comments?|correspondence|e-?mails?|speakers?|sign[- ]?in(?: sheets?)?|signatures?|testimony|public (?:input|comments?|hearing record)|minutes|complaints?|survey responses?|neighbou?r (?:notices?|responses?))\b/i;
// Instruments that are called letters.
const INSTRUMENT_LETTER = /\b(?:letter of intent|letter agreement|commitment letter|letter of credit)\b/i;
export const isCorrespondence = (title) => CORRESPONDENCE.test(title) && !(INSTRUMENT_LETTER.test(title) && !/\b(?:opposition|petitions?|comments?|testimony|support)\b/i.test(title));

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'does', 'say', 'says', 'about', 'from', 'into', 'are', 'was', 'were', 'how', 'when', 'who', 'which', 'will', 'its', 'any', 'all', 'has', 'have', 'there', 'their', 'them', 'they', 'exhibit', 'agreement', 'document', 'attachment', 'ordinance', 'city', 'norfolk']);
// A word's start, so "repayment" finds "repay" and "reimbursement" finds "reimburse".
const stem = (w) => (w.length > 5 ? w.slice(0, Math.max(5, w.length - 4)) : w);
export function termsOf(query) {
  const words = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w)).map(stem))].slice(0, 12);
}

/** The passages of `pages` richest in `terms`: [{ page, text }], in page order. */
export function passagesOf(pages, terms) {
  if (!terms.length) return [];
  const found = [];
  pages.forEach((p, i) => {
    const text = p.replace(/\s+/g, ' ').trim();
    const lower = text.toLowerCase();
    const hits = [];
    for (const t of terms) {
      const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
      for (const m of lower.matchAll(re)) hits.push(m.index);
    }
    hits.sort((a, b) => a - b);
    let last = -Infinity;
    for (const h of hits) {
      if (h < last) continue;
      // Never overlapping the passage before it.
      let from = Math.max(0, h - 300, last === -Infinity ? 0 : last);
      let to = Math.min(text.length, from + PASSAGE_CHARS);
      // Whole words at both ends.
      if (from > 0) from = text.indexOf(' ', from) + 1 || from;
      if (to < text.length) to = text.lastIndexOf(' ', to) > from ? text.lastIndexOf(' ', to) : to;
      const slice = text.slice(from, to);
      const score = terms.filter((t) => slice.toLowerCase().includes(t)).length;
      found.push({ page: i + 1, at: from, text: `${from > 0 ? '… ' : ''}${slice}${to < text.length ? ' …' : ''}`, score });
      last = to;
    }
  });
  const best = [...found].sort((a, b) => b.score - a.score || a.page - b.page || a.at - b.at).slice(0, PASSAGES);
  let total = 0;
  return best
    .sort((a, b) => a.page - b.page || a.at - b.at)
    .filter((p) => (total += p.text.length) <= TOTAL_CHARS)
    .map(({ page, text }) => ({ page, text }));
}

const HOW =
  "Quote what the passage says, give its page, and link the attachment. This is text read from the City's PDF; the PDF at the link is the authority. A passage is part of a page: read the page (page: n) before saying what the document requires, allows or commits anyone to.";
const CORRESPONDENCE_HOW =
  " This is correspondence from the public to the City, a public record: quote it as written, attributed to its writer as the City posted it. Never use it to find or follow a person, and leave out a writer's home address, email and phone number.";

export default definePlugin({
  name: 'read_attachment',
  cities: ['norfolk'],
  description:
    "Read a document attached to one of the City's legislative records (an exhibit, agreement, contract, lease, plan or report, or correspondence from the public such as letters and petitions), by the record's numeric id from get_legislation, find_legislation or block_report, and find the passages that answer a question, cited by page. Give query (what to look for, in plain words: \"repayment\", \"term and renewal\", \"parking\") or page (to read one page). With several attachments, give attachment (its number or words from its title); without it you get the list. Never search for a person. Use it when a record points to an attached document that would answer the question (\"Exhibit A\", \"the agreement\", \"the letters\"), before offering a source request or a follow-up.",
  parameters: {
    type: 'object',
    properties: {
      legislation_id: { type: 'string', description: 'The record\'s numeric id.' },
      attachment: { type: 'string', description: 'Which attachment: its number in the list, or words from its title ("Exhibit A").' },
      query: { type: 'string', description: 'What to look for in it, in plain words.' },
      page: { type: 'integer', description: 'A page to read in full instead.' },
    },
    required: ['legislation_id'],
    additionalProperties: false,
  },
  async run(ctx, args = {}) {
    const id = String(args.legislation_id ?? '').trim();
    if (!/^\d{1,9}$/.test(id)) return { error: 'legislation_id must be the record\'s numeric id.' };
    const query = String(args.query ?? '').slice(0, 300);
    // A document is searched for what it says, never for a person.
    const codes = query ? publicTextViolations(query).filter((c) => ['named_person', 'person_pointing', 'email', 'phone'].includes(c)) : [];
    if (codes.length) return { error: `Search the document for a topic, not a person. ${publicTextMessage(codes)}` };
    const base = String(ctx.city?.meetings?.iqm2 || '').replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) return { error: 'This city has no meeting portal to read attachments from.' };
    const recordUrl = `${base}/Citizens/Detail_LegiFile.aspx?ID=${id}`;
    const html = await ctx.http.text(recordUrl, { tool: 'list the record\'s attachments' });
    const list = parseAttachments(html);
    const listed = list.map((a, i) => ({ n: i + 1, title: a.title, ...(isCorrespondence(a.title) ? { correspondence: true } : {}) }));
    if (!list.length) return { record: recordUrl, attachments: [], note: 'This record lists no attachments.' };
    let pick = null;
    const want = String(args.attachment ?? '').trim();
    if (/^\d{1,2}$/.test(want)) pick = list[Number(want) - 1] || null;
    else if (want) {
      const words = want.toLowerCase().match(/[a-z0-9]+/g) || [];
      pick = list.find((a) => words.every((w) => a.title.toLowerCase().includes(w))) || null;
    } else if (list.length === 1) pick = list[0];
    if (!pick) {
      return { record: recordUrl, attachments: listed, note: want ? `No attachment matches "${want.slice(0, 80)}": give its number from this list.` : 'Several attachments: give attachment (its number or words from its title).' };
    }
    const url = `${base}/Citizens/FileOpen.aspx?Type=4&ID=${pick.id}`;
    const { bytes } = await ctx.http.bytes(url, { tool: 'read attachment', maxBytes: MAX_BYTES });
    const head = String.fromCharCode(...bytes.subarray(0, 5));
    if (head !== '%PDF-') return { record: recordUrl, attachment: { title: pick.title, url }, error: 'This attachment isn\'t a PDF, and this tool reads only PDFs. Link it instead.' };
    let pages;
    try {
      ({ pages } = await pdfText(bytes));
    } catch (err) {
      return { record: recordUrl, attachment: { title: pick.title, url }, error: /encrypt/i.test(String(err?.message)) ? 'This PDF is encrypted, so it can\'t be read here. Link it instead.' : 'This PDF couldn\'t be read here. Link it instead.' };
    }
    // Correspondence's record never carries the writer's name: hand-off titles
    // feed research memory and shared sources, and a letter mustn't become searchable by its writer.
    const letter = isCorrespondence(pick.title);
    ctx.resources.addRecord({ kind: 'document', title: (letter ? `Correspondence attached to legislative record ${id}` : `${pick.title} (attached to legislative record ${id})`).slice(0, 200), url });
    const chars = pages.reduce((n, p) => n + p.trim().length, 0);
    const attachment = { title: pick.title, url, pages: pages.length, ...(letter ? { correspondence: true } : {}) };
    const others = listed.filter((a) => a.title !== pick.title);
    const extra = { ...(others.length ? { other_attachments: others } : {}), how: letter ? HOW + CORRESPONDENCE_HOW : HOW };
    if (chars < 40) return { record: recordUrl, attachment, error: 'This PDF has no text layer (most likely a scan), so it can\'t be read here. Link it instead.', ...extra };
    const n = Number(args.page);
    if (Number.isInteger(n) && n >= 1) {
      if (n > pages.length) return { record: recordUrl, attachment, error: `It has ${pages.length} page${pages.length === 1 ? '' : 's'}.`, ...extra };
      const text = pages[n - 1].replace(/[ \t]+/g, ' ').trim();
      return { record: recordUrl, attachment, page: n, text: text.slice(0, PAGE_CHARS), ...(text.length > PAGE_CHARS ? { cut: true } : {}), ...extra };
    }
    const terms = termsOf(query);
    const passages = passagesOf(pages, terms);
    if (!passages.length) {
      return { record: recordUrl, attachment, query, passages: [], first_page: pages[0].replace(/[ \t]+/g, ' ').trim().slice(0, 1500), note: terms.length ? 'No passage matched those words; the first page is shown. Try other words, or read a page.' : 'No query given; the first page is shown.', ...extra };
    }
    return { record: recordUrl, attachment, query, passages, ...extra };
  },
});
