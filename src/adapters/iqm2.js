// iqm2 (Granicus) meeting portal adapter. Norfolk publishes every Council,
// Planning Commission, BZA and board meeting here; each legislative file page
// carries the status, department and the full roll-call history.
// Parsers are pure functions over HTML so they can be tested offline.

import { networkFetch } from '../request-budget.js';

const decode = (s) =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#13;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const span = (html, id) => {
  const m = html.match(new RegExp(`id="ContentPlaceholder1_${id}"[^>]*>([\\s\\S]*?)</(?:span|h1|a|div)>`));
  return m ? decode(m[1]) : null;
};

const field = (html, label) => {
  const m = html.match(new RegExp(`<strong>${label}</strong>:</th><td>([\\s\\S]*?)</td>`));
  return m ? decode(m[1]) || null : null;
};

// The City's cover letter to Council (the "Council Transmittal Letter" on a
// legislative file's page), where the substance is: what the item does, the
// analysis, the money (Jason, 2026-11-11, "Yes" to Siren reading it). Only
// the sections that describe the item are kept: Request, Description,
// Analysis and Financial Impact in the numbered format, or the letter's body
// in the older "Dear Ladies and Gentlemen" format. The Applicant section and
// the rest (payment of taxes names an owner; outreach, coordination and
// signatures add nothing) are left out. An applicant that isn't plainly an
// organization is a person, and their name is withheld wherever it appears;
// so is a name after a courtesy title.
const LETTER_KEEP = { request: /^request$/, description: /^description$/, analysis: /^analysis$/, financial_impact: /^financial impact$/ };
const ORG = /\b(?:llc|l\.l\.c|inc|incorporated|corp|corporation|company|co\.|lp|llp|ltd|trust|association|church|ministries|university|college|school|foundation|partners|partnership|group|hospital|bank|authority|commission|department|city of|county|commonwealth|board|council|society|club|center|centre|properties|holdings|ventures|realty|development|enterprises|services|restaurant|cafe|hotel|museum)\b/i;
const LETTER_MAX = 1200;
const letterText = (s) =>
  decode(s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))))
    .replace(/\u00a0/g, ' ')
    .replace(/[\u00b7\u2022]\s*/g, '; ')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (s) => (s.length <= LETTER_MAX ? s : `${s.slice(0, LETTER_MAX).replace(/\s+\S*$/, '')} …`);

export function parseTransmittal(html) {
  const at = html.indexOf('Council Transmittal Letter</h4>');
  if (at < 0) return null;
  const rest = html.slice(at + 'Council Transmittal Letter</h4>'.length);
  const end = rest.search(/<h4\b|class=['"]LegiFileSection(?!Contents)|MeetingHistory/);
  const text = letterText(end < 0 ? rest.slice(0, 40000) : rest.slice(0, end));
  if (!text) return null;
  // Numbered sections: "I. Recommendation: … II. Applicant: … III. Description: …"
  const heads = [...text.matchAll(/(?:^|\s)(X{0,3}(?:IX|IV|V?I{0,3}))\.\s+([A-Z][A-Za-z/&' -]{2,60}?)(?::|(?=\s+(?:As of|The|This|By|To|A|An|On|In)\b))/g)].filter((m) => m[1]);
  const sections = {};
  let applicant = null;
  if (heads.length >= 2) {
    heads.forEach((m, i) => {
      const name = m[2].trim().toLowerCase().replace(/\s+/g, ' ');
      const from = m.index + m[0].length;
      const to = i + 1 < heads.length ? heads[i + 1].index : text.length;
      const body = text.slice(from, to).replace(/^[\s:;]+/, '').trim();
      if (name === 'applicant') applicant = body;
      for (const [key, re] of Object.entries(LETTER_KEEP)) if (re.test(name) && body) sections[key] = body;
    });
  } else {
    // Words in these letters are sometimes split by markup ("Re spectfully").
    const loose = (w) => w.split('').map((c) => (c === ' ' ? '\\s+' : `${c}\\s?`)).join('');
    const body = text.match(new RegExp(`${loose('Dear Ladies and Gentlemen')}:\\s*([\\s\\S]*?)\\s*${loose('Respectfully')},`, 'i'))?.[1];
    if (body) sections.letter = body.trim();
  }
  if (!Object.keys(sections).length) return null;
  // The applicant's name, when the applicant isn't plainly an organization:
  // the words before its address (the first number), at most five of them.
  // Judged on the name only, before the address (whose "Norfolk, VA" says nothing).
  const withheld = [];
  if (applicant) {
    const name = applicant.split(/\s\d/)[0].split(/\s+/).slice(0, 5).join(' ').replace(/[,;:]+$/, '').trim();
    if (name.length >= 3 && !ORG.test(name)) withheld.push(name);
  }
  const scrub = (s) => {
    let out = s;
    for (const n of withheld) out = out.split(n).join('the applicant');
    return out.replace(/\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+(?:[A-Z][a-z'-]+\s?){1,3}/g, '[name withheld] ');
  };
  const out = {};
  for (const [k, v] of Object.entries(sections)) out[k] = clip(scrub(v).replace(/^[;\s]+/, '').replace(/\s+;/g, ';')).trim();
  return { ...out, ...(withheld.length ? { applicant_name_withheld: true } : {}) };
}

// An agenda title that opens with its applicant ("JANE DOE, for a conditional
// change in zoning ...", the Planning Commission's style) names a person when
// the applicant isn't plainly an organization. For text Siren sends on its
// own (block watch emails), that opening name is replaced with "An applicant",
// as the cover letters withhold one; a business can be withheld too, the safe
// direction. A name after a courtesy title is withheld as well.
export function withholdApplicant(title) {
  const s = String(title);
  // Up to the first ", for": a name may hold commas ("DOE, JANE", "ACME, LLC")
  // and either apostrophe ("O’BRIEN"); an organization word anywhere in it keeps it.
  const m = s.match(/^([A-Za-z][A-Za-z .,'\u2019&-]{2,80}?),\s+(?=for\b)/i);
  const out = m && !ORG.test(m[1]) ? `An applicant, ${s.slice(m[0].length)}` : s;
  return out.replace(/\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+(?:[A-Z][a-z'-]+\s?){1,3}/g, '[name withheld] ').trim();
}

export function parseLegiFile(html) {
  const history = [];
  const rowRe =
    /<tr class="HeaderRow HistorySection">([\s\S]*?)<\/tr>\s*<tr class="VoteResultRow">([\s\S]*?)<\/tr>\s*(?=<tr class="HeaderRow|<\/table>\s*<\/div>|\s*<\/table>)/g;
  for (const m of html.matchAll(rowRe)) {
    const [, head, body] = m;
    const meetingId = head.match(/Detail_Meeting\.aspx\?ID=(\d+)/)?.[1];
    const date = decode(head.match(/<td class="Date">([\s\S]*?)<\/td>/)?.[1] || '');
    const body_ = decode(head.match(/lblMeetingGroup_\d+"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    const type = decode(head.match(/lblMeetingType_\d+"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '');
    const draft = /class="Draft"[\s\S]*?Draft/.test(head) && /certificate_warning/.test(head);
    const vote = {};
    for (const v of body.matchAll(/<td class='Role'>([^<]+):<\/td><td[^>]*>([\s\S]*?)<\/td>/g)) {
      vote[v[1].trim().toLowerCase()] = decode(v[2]);
    }
    const comments = decode(body.match(/class="Comments">([\s\S]*?)<\/div>/)?.[1] || '');
    history.push({
      date,
      body: body_,
      type,
      meeting_id: meetingId || null,
      minutes_draft: draft,
      result: vote.result || null,
      ayes: vote.ayes ? vote.ayes.split(/,\s*/) : [],
      nays: vote.nays ? vote.nays.split(/,\s*/) : [],
      abstain: vote.abstain ? vote.abstain.split(/,\s*/) : [],
      absent: vote.absent ? vote.absent.split(/,\s*/) : [],
      ...(comments ? { comments } : {}),
    });
  }
  return {
    type: span(html, 'lblLegiFileType'),
    number: span(html, 'lblResNum'),
    status: span(html, 'lblStatus'),
    status_date: span(html, 'lnkDate'),
    title: span(html, 'lblLegiFileTitle'),
    department: field(html, 'Department'),
    sponsors: field(html, 'Sponsors'),
    category: field(html, 'Category'),
    history,
    ...(() => {
      const letter = parseTransmittal(html);
      return letter ? { cover_letter: letter } : {};
    })(),
  };
}

export function parseMeeting(html) {
  const items = [];
  const seen = new Set();
  for (const m of html.matchAll(/href='Detail_LegiFile\.aspx\?[^']*?[?&]ID=(\d+)[^']*'>([\s\S]*?)<\/a>/g)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text: decode(m[2]) });
  }
  return {
    body: span(html, 'lblMeetingGroup'),
    type: span(html, 'lblMeetingType'),
    date: span(html, 'lblMeetingDate'),
    items,
  };
}

const SUFFIX =
  'Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Circle|Cir|Place|Pl|Way|Terrace|Ter|Parkway|Pkwy|Highway|Hwy|Crescent|Square|Trail|Arch|Landing|Point|Quay|Run|Walk';

// Pull street addresses out of an agenda title, e.g.
// "Property Located at 9519 and 9523 22nd Bay Street" -> two addresses.
export function extractAddresses(text) {
  const out = [];
  // One house number (or range), then numbers joined by a comma, "and", "&" or
  // plain space. Each separator is a single alternative so the regex can't
  // split the same whitespace many ways (that backtracked for seconds).
  const NUM = '\\d+[A-Z]?(?!\\w)(?:\\s*(?:-|–|through|thru)\\s*\\d+)?';
  const re = new RegExp(
    `\\b(${NUM}(?:(?:\\s*(?:,|and|&)\\s*|\\s+)${NUM})*)\\s+((?:[NSEW]\\.?\\s+)?(?:[A-Z0-9][\\w'.]*\\s+){1,4}?(?:${SUFFIX}))\\b\\.?`,
    'g'
  );
  for (const m of String(text).slice(0, 1000).matchAll(re)) {
    const street = m[2].replace(/\s+/g, ' ').trim();
    const nums = m[1].match(/\d+[A-Z]?(?!\w)/g) || [];
    for (const n of nums) out.push(`${n} ${street}`);
  }
  return [...new Set(out)];
}

// Normalise an address for matching: upper case, expand common suffixes.
const ABBR = {
  ST: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', BLVD: 'BOULEVARD', RD: 'ROAD', DR: 'DRIVE', LN: 'LANE', CT: 'COURT',
  CIR: 'CIRCLE', PL: 'PLACE', TER: 'TERRACE', PKWY: 'PARKWAY', HWY: 'HIGHWAY', N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST',
};
export function normalizeAddress(a) {
  return String(a)
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBR[w] || w)
    .join(' ');
}

export class Iqm2 {
  constructor({ base, trace, resources, fetchImpl }) {
    this.base = base.replace(/\/$/, '');
    this.trace = trace;
    this.resources = resources;
    // On an answer this is the answer's counting fetch (src/request-budget.js).
    this.fetch = fetchImpl || networkFetch;
  }

  legiUrl(id) {
    return `${this.base}/Citizens/Detail_LegiFile.aspx?ID=${id}`;
  }

  meetingUrl(id) {
    return `${this.base}/Citizens/Detail_Meeting.aspx?ID=${id}`;
  }

  async getHTML(url, tool) {
    return this.trace.record({ tool, url }, async () => {
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { result: await res.text(), rows: null };
    });
  }

  async legislation(id) {
    const url = this.legiUrl(id);
    const rec = parseLegiFile(await this.getHTML(url, 'read legislative record'));
    this.resources.addRecord({ kind: 'legislation', title: `${rec.number || rec.type || 'Record'}: ${rec.title || ''}`.slice(0, 160), url });
    for (const h of rec.history) {
      if (h.meeting_id) this.resources.addRecord({ kind: 'meeting', title: `${h.body} ${h.type}, ${h.date}`, url: this.meetingUrl(h.meeting_id) });
    }
    return { ...rec, url };
  }

  async meeting(id) {
    const url = this.meetingUrl(id);
    const m = parseMeeting(await this.getHTML(url, 'read meeting agenda'));
    this.resources.addRecord({ kind: 'meeting', title: `${m.body} ${m.type}, ${m.date}`, url });
    return { ...m, url, items: m.items.map((i) => ({ ...i, url: this.legiUrl(i.id) })) };
  }
}
