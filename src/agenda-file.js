// Items out of an agenda that is posted as a file: the Board of Zoning
// Appeals' and the Architectural Review Board's (checked 2026-11-18), whose
// iqm2 pages list no items. The file's text (src/pdf.js) is a numbered or
// lettered list under roman-numeral sections:
//   BZA: "1. <APPLICANT> – for a variance from … on property located at 2612 Munson St, zoned …"
//   ARB: "a. COA #26-00439 – 719 Yarmouth Street – Replace non-historic windows with new windows."
// An item runs from its number or letter to the next one, a section heading,
// or the page's own header and footer lines. Items that are only a date
// (minutes to approve) or the meeting's own procedure (roll call, comments
// from commissioners) are dropped. Pure; the text is the City's.

const START = /^(\d{1,2}|[a-z])\.\s*(\S.*)$/;
const ROMAN = /^[IVXL]+\.\s*\S/;
const LETTER_HEAD = /^[A-Z]\.\s*\S/;
// The file's own furniture: headers, footers and notices on every page.
const FURNITURE = /^(?:next two .* meetings|city hall\b|ph\.|information concerning|a public meeting|all interested|additional information|page \d+)/i;
// Procedure, not business: a meeting's own steps.
const PROCEDURE = /^(?:call to order|roll call|approval of (?:the )?(?:meeting )?minutes|adjourn|comments? from|public comments?|staff updates?|new business|old business|discussion|future meeting|next meeting|election of officers|.{0,40}\bpublic hearing preview)\b/i;
const DATE_ONLY = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\.?$/i;

const isHeading = (line) => ROMAN.test(line) || LETTER_HEAD.test(line) || FURNITURE.test(line) || (/[A-Z]{2}/.test(line) && !/[a-z]/.test(line) && !START.test(line));

/** [{ n, text }]: the agenda's items, in order, each as one line of text. */
export function agendaFileItems(text) {
  const items = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const t = cur.lines.join(' ').replace(/\s+/g, ' ').replace(/\s+([.,;:)])/g, '$1').trim();
    if (t && !DATE_ONLY.test(t) && !PROCEDURE.test(t) && t.split(' ').length >= 3) items.push({ n: items.length + 1, text: t.slice(0, 2000) });
    cur = null;
  };
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const m = START.exec(line);
    if (m) {
      close();
      cur = { lines: [m[2]] };
    } else if (isHeading(line)) close();
    else if (cur) {
      // "Neighborhood-" then "Scale)": a word broken across lines.
      const last = cur.lines.length - 1;
      if (/[A-Za-z]-$/.test(cur.lines[last]) && /^[A-Za-z]/.test(line)) cur.lines[last] += line;
      else cur.lines.push(line);
    }
  }
  close();
  return items;
}
