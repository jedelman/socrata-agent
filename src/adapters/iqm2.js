// iqm2 (Granicus) meeting portal adapter. Norfolk publishes every Council,
// Planning Commission, BZA and board meeting here; each legislative file page
// carries the status, department and the full roll-call history.
// Parsers are pure functions over HTML so they can be tested offline.

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
  const re = new RegExp(
    `\\b((?:\\d+[A-Z]?(?![\\w])(?:\\s*(?:-|–|through|thru)\\s*\\d+)?\\s*(?:,|and|&)?\\s*)+)((?:[NSEW]\\.?\\s+)?(?:[A-Z0-9][\\w'.]*\\s+){1,4}?(?:${SUFFIX}))\\b\\.?`,
    'g'
  );
  for (const m of text.matchAll(re)) {
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
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
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
