// Checks on an answer, by code, against what this answer's tools returned
// (Jason, 2026-11-20: "Rewrite the way the voice check works. Build 1 and 2."
// after the Haiku trial, whose slips were in how answers described their own
// parts: figures no tool returned, a citation on the wrong link, a contacts
// card said to hold offices it didn't). Each check returns findings in plain
// words, which the check stage (src/agent.js) puts in its one rewrite; none
// of them is ever the trace, and none changes the answer by itself.
//
// - figures: dollar amounts and numbers of four or more digits (not years)
//   must appear in the evidence (tool results, the hand-off, the question),
//   allowing an answer's own rounding ("$13.1 million" for 13,139,514).
// - links: link text naming an ordinance, table, section, work order or
//   record must name the record its link goes to.
// - contacts: a sentence that sends the reader to the contacts card may only
//   name offices and people the card holds.

const MAX_FINDINGS = 6;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** The answer as it reads: link URLs out (their text stays), escapes undone. */
const readable = (answer) => String(answer ?? '').replace(/\\([\\`*_{}[\]()#+\-.!:|>~])/g, '$1').replace(/(!?)\[([^\]]*)\]\([^)]*\)/g, (m, img, text) => (img ? '' : text));

// --- figures --------------------------------------------------------------

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d,]*\d)(?:\s?(million|billion|thousand)\b|\s?([mbk])\b)?/gi;
const BIG = /(?<![\d.,-])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)(?![\d,]*\d)(?:\s?(million|billion|thousand)\b)?/gi;
const SCALE = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, b: 1e9 };
const toNumber = (s) => Number(String(s).replace(/,/g, ''));
const isYear = (s, scale) => !scale && /^(19|20)\d{2}$/.test(s);
const ID_WORDS = 'Ordinances?|Ord\\.|Resolutions?|Res\\.|No\\.|Nos\\.|Numbers?|records?|IDs?|items?|files?|cases?|projects?|accounts?|ZIP(?:\\s+codes?)?|Tables?|sections?|pages?|pp?\\.|GPINs?|parcels?|orders?|permits?|dockets?|applications?|Wards?|Districts?|Routes?|Suite|Unit|Room|Forms?|Bills?|HB|SB|Chapters?|Codes?';
const ID_BEFORE = new RegExp(`(?:\\b(?:${ID_WORDS})\\s*(?:No\\.?\\s*)?|[#§]\\s*)(?:[\\d.-]+(?:,\\s*|\\s+(?:and|or|&|through|to)\\s+))*$`, 'i');
const STREET_AFTER = /^\s+(?:[NSEW]\.?\s+)?(?:[A-Z0-9][\w'’.-]*\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace|Hwy|Highway|Sq|Square)\b/;

/**
 * Every number in a text, as values: with a scale word after it ("$57
 * million", "$750K") also at that scale; a comma run like "1200,3400" (a JSON
 * array) also as its pieces.
 */
export function numbersIn(text) {
  const out = new Set();
  const add = (v) => Number.isFinite(v) && out.add(v);
  for (const m of String(text ?? '').matchAll(/(\d[\d,]*(?:\.\d+)?)(?:\s?(million|billion|thousand)\b|\s?([mbk])\b)?/gi)) {
    const digits = m[1].replace(/,$/, '');
    const v = toNumber(digits);
    add(v);
    const scale = SCALE[String(m[2] || m[3] || '').toLowerCase()];
    if (scale) add(Math.round(v * scale * 100) / 100);
    if (digits.includes(',')) for (const piece of digits.split(',')) if (piece) add(toNumber(piece));
  }
  return out;
}

/**
 * The precision a figure is written at: its last decimal place, its scale
 * word ("$11 million": a million), or a whole number's trailing zeros ("about
 * 1,200": a hundred).
 */
function unitOf(value, decimals, scale) {
  if (decimals > 0) return scale * 10 ** -decimals;
  if (scale !== 1) return scale;
  const zeros = (String(Math.trunc(value)).match(/0+$/) || [''])[0].length;
  return 10 ** Math.min(zeros, 6);
}
/** Whether `v` is within the figure's own precision of `e`: "more than $11 million" for 11,536,917; "about 1,200" for 1,247. */
const near = (v, unit, e) => e === v || Math.abs(e - v) < unit;

/**
 * Figures in the answer that no evidence number gives. A figure is grounded
 * when some number in the evidence is within its own precision of it, or when
 * it is a sum or difference of grounded figures in the same answer ("$1,923.39
 * together ($422.22 plus $1,501.17)").
 */
export function checkFigures(answer, evidenceText) {
  const evidence = numbersIn(evidenceText);
  const text = readable(answer);
  const figures = [];
  const consider = (raw, digits, word) => {
    const scale = SCALE[String(word || '').toLowerCase()] || 1;
    if (isYear(digits, word)) return;
    const value = toNumber(digits);
    if (!Number.isFinite(value) || value === 0 || (scale === 1 && value < 1000 && !raw.includes('$'))) return;
    const decimals = (digits.split('.')[1] || '').length;
    const v = Math.round(value * scale * 100) / 100;
    const unit = unitOf(value, decimals, scale);
    figures.push({ key: raw.replace(/\s+/g, ' ').trim(), v, unit, ok: [...evidence].some((e) => near(v, unit, e)) });
  };
  for (const m of text.matchAll(MONEY)) consider(m[0], m[1], m[2] || m[3]);
  for (const m of text.matchAll(BIG)) {
    // A dollar figure was already considered; a number inside an id (26-031969)
    // or a date, a number an id word names (Ordinance 50487, ZIP 23510, Table
    // 3.2.12, record 5949 and 5950) and a house number are left alone.
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (/\$\s?$/.test(before) || /[-/]$/.test(before) || ID_BEFORE.test(before) || STREET_AFTER.test(after)) continue;
    consider(m[0], m[1], m[2]);
  }
  // Sums and differences of the grounded ones (pairs and threes, and all of them).
  const good = figures.filter((f) => f.ok).map((f) => f.v).slice(0, 20);
  const computed = new Set();
  if (good.length > 1) computed.add(good.reduce((a, b) => a + b, 0));
  for (let i = 0; i < good.length; i++) {
    for (let j = i + 1; j < good.length; j++) {
      computed.add(good[i] + good[j]);
      computed.add(Math.abs(good[i] - good[j]));
      for (let k = j + 1; k < good.length; k++) computed.add(good[i] + good[j] + good[k]);
    }
  }
  const out = [];
  for (const f of figures) {
    if (f.ok || [...computed].some((c) => near(f.v, Math.max(f.unit, 0.01), Math.round(c * 100) / 100))) continue;
    if (!out.includes(f.key)) out.push(f.key);
  }
  return out.slice(0, MAX_FINDINGS);
}

// --- links ----------------------------------------------------------------

// Each kind of id a link's text can name: [pattern, kind]. A section or table
// is a page of a document that may hold several, so it is checked only on a
// link that isn't a document page.
const IDS = [
  [/\b(?:Ordinance|Ord\.)\s*(?:No\.\s*)?(\d{4,6})\b/gi, 'ordinance'],
  [/\bTable\s+(\d+\.\d+\.\d+)\b/gi, 'section'],
  [/§\s*(\d+(?:\.\d+)+(?:\.[A-Z](?:\(\w+\))*)?)/g, 'section'],
  [/\b(\d{2}-\d{5,6})\b/g, 'case'],
  [/\b(?:legislative record|record|legislation)\s+(\d{3,6})\b/gi, 'record'],
];
// A section id may name a subsection of the one a title gives (§ 3.9.3.A on §3.9.3's page).
const parentsOf = (id) => {
  const out = [id];
  for (let s = id; /[.(]/.test(s); ) {
    s = s.replace(/(?:\.[^.()]+|\([^()]*\))$/, '');
    out.push(s);
  }
  return out;
};

/** Links whose text names something (an ordinance, a table, a work order) the record they go to doesn't. */
export function checkLinks(answer, resources = {}) {
  // Every title seen for a URL (a record and a link can share one).
  const titles = new Map();
  const norm = (u) => String(u || '').trim().replace(/\/$/, '');
  const add = (url, title) => {
    const k = norm(url);
    titles.set(k, [...(titles.get(k) || []), String(title || '')]);
  };
  // Links that are the thing an ordinance or record number names: the legislation record itself, a contact, a dataset.
  const identity = new Set();
  for (const r of resources.records || []) if (r?.url) add(r.url, r.title);
  for (const l of resources.links || []) if (l?.url) add(l.url, l.title);
  for (const d of resources.datasets || []) if (d?.page) { add(d.page, `${d.name || ''} ${d.id || ''}`); identity.add(norm(d.page)); }
  for (const c of resources.contacts || []) if (c?.url) { add(c.url, `${c.role || ''} ${c.name || ''}`); identity.add(norm(c.url)); }
  const isIdentity = (url) => identity.has(norm(url)) || /Detail_LegiFile\.aspx/i.test(url);
  const out = [];
  const md = String(answer ?? '').replace(/\\([\\`*_{}[\]()#+\-.!:|>~])/g, '$1');
  for (const m of md.matchAll(/(?<!!)\[([^\]]{1,300})\]\(\s*<?([^)\s>]+)>?\s*\)/g)) {
    const [, label, url] = m;
    const seen = titles.get(norm(url));
    if (!seen) continue;
    const title = seen.join(' | ');
    const page = /#page=\d/i.test(url);
    const missing = [];
    for (const [re, kind] of IDS) {
      for (const hit of label.matchAll(re)) {
        const id = hit[1];
        if (kind === 'section' && page) continue;
        // A meeting, news item, attachment or document page can name an ordinance without being it.
        if ((kind === 'ordinance' || kind === 'record') && !isIdentity(url)) continue;
        // A case or work-order number is checked only against a record keyed by numbers of its shape.
        if (kind === 'case' && !/\b\d{2}-\d{5,6}\b/.test(title)) continue;
        const ids = kind === 'section' ? parentsOf(id) : [id];
        if (!ids.some((x) => title.includes(x) || url.includes(x))) missing.push(id);
      }
    }
    if (missing.length) out.push(`The link "${clip(label, 80)}" names ${missing.join(', ')}, but it goes to "${clip(seen[0], 120)}".`);
  }
  return out.slice(0, MAX_FINDINGS);
}

// --- contacts -------------------------------------------------------------

// "the contacts below", "the contacts card", "listed in the contacts": the card, never the verb "contact".
const POINTS_TO_CARD = /\b(?:the|these|those) contacts?\b[^.!?\n]{0,60}\b(?:below|card|under (?:this|the) answer)\b|\bcontacts? (?:card|below)\b|\b(?:listed|included|named) (?:in|among|under) the contacts(?: (?:below|card))?\b(?! (?:on|at|of|for) )/i;
// "I found no Zoning Administrator among the contacts below": a negated pointer claims nothing.
const NEGATED = /\b(?:no|not|none|isn'?t|aren'?t|without|neither|nor|doesn'?t|don'?t)\b/i;
const LEAD = /^(?:(?:The|Your|Our|Call|Ask|Reach|Phone|Email|E-mail|Contact|Write|Text|Try|See|Visit|Message|Councilmember|Councilman|Councilwoman|Council Member|Mayor|Vice Mayor|Delegate|Del\.|Senator|Sen\.|State Senator|Congresswoman|Congressman|Representative|Rep\.|U\.S\. Representative|Mr\.?|Ms\.?|Mrs\.?|Dr\.?)\s+)+/;
// Words a card needn't hold for a phrase to name it.
const GENERIC_CONTACT = new Set(['the', 'and', 'for', 'city', 'norfolk', 'office', 'offices', 'department', 'your', 'our', 'their', 'member', 'members', 'staff']);
const OFFICE = /((?:(?:[A-Z][\w'’.-]*|&)\s+){1,5}(?:[Oo]ffice|[Dd]epartment|[Dd]irector|[Cc]lerk|[Mm]anager|[Cc]ouncil(?:member|man|woman)?|[Cc]ommission|[Aa]uthority|[Bb]oard|[Dd]ivision|[Bb]ureau))\b/g;
const NAMEISH = /\b([A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z'’-]+){1,3})\b/g;
const SKIP = new Set(['The', 'This', 'These', 'I', 'You', 'Your', 'For', 'If', 'AI', 'Norfolk', 'City', 'Virginia']);

/** Offices and people a sentence says the contacts card holds, that it doesn't. */
export function checkContacts(answer, contacts = []) {
  const tokens = (t) => (t.toLowerCase().replace(/['’]s\b/g, '').match(/[a-z][a-z'’-]+/g) || []);
  const words = new Set(tokens(contacts.map((c) => `${c.role || ''} ${c.name || ''} ${c.note || ''}`).join(' ')));
  // Whole, or sharing a start of five letters or more ("senator" and the card's "senate").
  const same = (w, h) => w === h || (w.length >= 5 && h.length >= 5 && w.slice(0, 5) === h.slice(0, 5));
  const present = (phrase) => {
    const ws = tokens(phrase).filter((w) => w.length > 2 && !GENERIC_CONTACT.has(w));
    return ws.length === 0 || ws.every((w) => [...words].some((h) => same(w, h)));
  };
  const out = [];
  const text = readable(answer);
  const namesIn = (clause) => {
    const named = new Set();
    const core = (n) => n.trim().replace(LEAD, '').trim();
    for (const m of clause.matchAll(OFFICE)) if (core(m[1])) named.add(core(m[1]));
    for (const m of clause.matchAll(NAMEISH)) {
      const n = core(m[1]);
      if (n && !SKIP.has(n.split(/\s+/)[0])) named.add(n);
    }
    return named;
  };
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (!POINTS_TO_CARD.test(sentence)) continue;
    // Only the clause that points to the card ("both listed in the contacts below" points back to the one before).
    const clauses = sentence.split(/,\s+|;\s+/);
    const at = clauses.findIndex((c) => POINTS_TO_CARD.test(c));
    if (NEGATED.test(clauses[at] ?? sentence)) continue;
    let named = namesIn(clauses[at] ?? sentence);
    if (!named.size && at > 0 && /\b(?:both|either|each|all|them|they|these|those|which|who|whom)\b/i.test(clauses[at])) named = namesIn(clauses[at - 1]);
    for (const n of named) {
      if ([...named].some((o) => o !== n && o.includes(n))) continue;
      if (!present(n)) out.push(`The answer says the contacts below include "${clip(n, 80)}", but the contacts card doesn't list it.`);
    }
  }
  return [...new Set(out)].slice(0, MAX_FINDINGS);
}

/** All code checks: { figures, links, contacts }. */
export function codeChecks(answer, { evidenceText = '', resources = {} } = {}) {
  return {
    figures: checkFigures(answer, evidenceText),
    links: checkLinks(answer, resources),
    contacts: checkContacts(answer, resources.contacts || []),
  };
}

/** The rewrite note for code findings, or ''. */
export function codeFindingsNote({ figures = [], links = [], contacts = [] } = {}, { figuresAdvisory = false } = {}) {
  const parts = [];
  if (figures.length && !figuresAdvisory) parts.push(`These figures don't appear in what your tools returned: ${figures.join('; ')}. Keep a figure only if a tool returned it or you computed it from figures a tool returned (then say how, in a few words); otherwise take it out.`);
  if (links.length) parts.push(`${links.join(' ')} Link each name to its own record, or drop the link.`);
  if (contacts.length) parts.push(`${contacts.join(' ')} Mention only contacts the card lists.`);
  return parts.join(' ');
}
