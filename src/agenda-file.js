// Items out of an agenda that is posted as a file: the Board of Zoning
// Appeals' and the Architectural Review Board's (checked 2026-11-18), whose
// iqm2 pages list no items. The file's text (src/pdf.js) is a numbered or
// lettered list under roman-numeral sections:
//   BZA: "1. <APPLICANT> – for a variance from … on property located at 2612 Munson St, zoned …"
//   ARB: "a. COA #26-00439 – 719 Yarmouth Street – Replace non-historic windows with new windows."
// An item runs from its number or letter to the next one in its list, a
// section heading, or the file's own notices. Lines that only look like a
// heading don't end an item that is still mid-sentence: a street's direction
// ("N. Military Highway"), an applicant's name in capitals running on, or the
// page's own header and footer at a page break, which are skipped. Items that
// are only a date (minutes to approve) or the meeting's own procedure (roll
// call, comments from commissioners) are dropped. Pure; the text is the City's.

// "1. JANE …", "a. COA …", "a.COA …"; never "3.2.9.B of the …" or "e.g. a …".
const START = /^(\d{1,2}|[a-z])\.(?!\d|[a-z]\.)\s*(\S.*)$/;
const ROMAN = /^[IVXL]+\.\s*\S/;
const LETTER_HEAD = /^[A-Z]\.\s*\S/;
// A direction initial before a street's name, as in "7418 / N. Military Highway".
const DIRECTION = /^[NSEW]\.\s+[A-Z0-9]/;
// The file's own furniture: headers, footers and notices.
const FURNITURE = /^(?:next two .* meetings|city hall\b|ph\.|information concerning|a public meeting|all interested|additional information|page \d+(?:\s+of\s+\d+)?$)/i;
// An entry with no number: an applicant's "– for …", or a case number.
const ENTRY = /\s[–—-]\s+for\b|\b(?:COA|DC|DR|BZA|CUP|ZTA|SE|ZV)\s*#?\s*\d{2}-\d/;
// Procedure, not business: a meeting's own steps. Always procedure:
const PROCEDURE = /^(?:call to order|roll call|approval of (?:the )?(?:meeting )?minutes|adjourn|comments? from|public comments?)\b/i;
// Procedure only as the whole item ("Discussion", "New Business"), never "Discussion of the demolition at …":
const PROCEDURE_SHORT = /^(?:staff updates?|new business|old business|discussion|future meetings?|next meeting|election of officers|.{0,40}\bpublic hearing preview)\b/i;
const DATE_ONLY = /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\.?$/i;

const allCaps = (line) => /[A-Z]{2}/.test(line) && !/[a-z]/.test(line);
// A line that ends a sentence or a parenthesis: what an item's last line looks like.
const finished = (line) => /[.;:)\]]["'”’]?$/.test(line);
// A name in capitals that runs on: "… OF NORFOLK AND" / "ITS SUCCESSORS, INC."
const capsRunOn = (prev) => /(?:\b[A-Z][A-Z'&.-]+|[,&–—-])$/.test(prev) && !/[a-z]/.test(prev.split(/\s[–—-]\s/)[0]);
const normal = (line) => line.toLowerCase().replace(/\d+/g, '#');

// Lines at the top or bottom of two or more pages: the page's own header and footer.
function repeatedFurniture(pages) {
  if (pages.length < 2) return new Set();
  const seen = new Map();
  for (const lines of pages) {
    // Never an item or a section heading, which only look alike by chance.
    const edge = new Set([...lines.slice(0, 6), ...lines.slice(-4)].filter((l) => !START.test(l) && !ROMAN.test(l)).map(normal));
    for (const l of edge) seen.set(l, (seen.get(l) || 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n >= 2).map(([l]) => l));
}

// A marker's place in its list: "3." and "c." are both 3.
const ordinal = (marker) => (/\d/.test(marker) ? Number(marker) : marker.charCodeAt(0) - 96);

/**
 * [{ n, text }]: the agenda's items, in order, each as one line of text.
 * `input` is the file's pages (an array of strings) or its whole text, whose
 * pages may be split by form feeds.
 */
export function agendaFileItems(input) {
  const pages = (Array.isArray(input) ? input : String(input ?? '').split('\f'))
    .map((p) => String(p ?? '').split('\n').map((raw) => raw.replace(/\s+/g, ' ').trim()).filter(Boolean));
  const repeated = repeatedFurniture(pages);
  const items = [];
  let cur = null;
  // The list a section's items follow: its marker style ('1' or 'a') and the last marker's place.
  let list = null;
  let inSection = false;
  const close = () => {
    if (!cur) return;
    const t = cur.lines.join(' ').replace(/\s+/g, ' ').replace(/\s+([.,;:)])/g, '$1').trim();
    const words = t.split(' ').length;
    const procedure = PROCEDURE.test(t) || (PROCEDURE_SHORT.test(t) && words <= 6);
    if (t && !DATE_ONLY.test(t) && !procedure && words >= 3) items.push({ n: items.length + 1, text: t.slice(0, 2000) });
    cur = null;
  };
  const heading = () => {
    close();
    list = null;
    inSection = true;
  };
  const append = (line) => {
    // "Neighborhood-" then "Scale)": a word broken across lines.
    const last = cur.lines.length - 1;
    if (/[A-Za-z]-$/.test(cur.lines[last]) && /^[A-Za-z]/.test(line)) cur.lines[last] += line;
    else cur.lines.push(line);
  };
  pages.forEach((lines, p) => {
    const lastPage = p === pages.length - 1;
    lines.forEach((line, i) => {
      const prev = cur?.lines[cur.lines.length - 1] ?? '';
      const open = cur && !finished(prev);
      // The page's own header and footer: skipped, so an item can run across the break.
      if (repeated.has(normal(line))) return;
      if (FURNITURE.test(line)) {
        const atBreak = (p > 0 && i < 6) || (!lastPage && i >= lines.length - 4);
        if (!(open && atBreak)) close();
        return;
      }
      const m = START.exec(line);
      if (m) {
        const style = /\d/.test(m[1]) ? '1' : 'a';
        const at = ordinal(m[1]);
        // In turn, give or take a typo (a repeat, a skip of two): "12." after "2." is a wrapped line.
        if (!list || (style === list.style && (at === 1 || (at >= list.at && at <= list.at + 3)))) {
          close();
          list = { style, at };
          cur = { lines: [m[2]] };
          return;
        }
        // A sub-item ("a." under "1.") or a number out of turn: part of the item it's in.
        if (cur) append(line);
        return;
      }
      if (ROMAN.test(line)) return heading();
      if (cur && DIRECTION.test(line) && open) return append(line);
      if (LETTER_HEAD.test(line) || (allCaps(line) && !(cur && capsRunOn(prev)))) {
        // A heading-like line mid-sentence at a page's top is the page's header: skip it.
        if (open && p > 0 && i < 6) return;
        return heading();
      }
      if (cur) return append(line);
      // An entry with no number of its own, under a section's heading.
      if (inSection && ENTRY.test(line)) cur = { lines: [line] };
    });
  });
  close();
  return items;
}
