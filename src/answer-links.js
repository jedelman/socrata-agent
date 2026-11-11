// Links in an answer's own words (Jason, 2026-11-10: "we have our source
// links as footnotes - can we link the relevant text in the answer itself?").
// The prompt asks the model to link the words a fact comes from; this module
// is what holds it to that. A link stays only when its URL is one this answer
// handed off (src/resources.js): a record or web page, a dataset's page, CSV,
// query or API docs, a contact's site or email, a deployment link. Anything
// else becomes its plain text, whatever the model wrote and whatever a
// question asked it to write. The footnote lists under the answer stay.
//
// Markdown is read the way the pages read it (marked 12, GFM): inline links
// with their titles and angle-bracket URLs, reference-style links (unlinked;
// definitions are disarmed so none can resolve), images (dropped), angle
// autolinks, bare URLs and emails that marked would link (kept as autolinks
// when known, otherwise left as text marked won't link), raw <a> and <img>
// tags (removed) and other raw tags that could start an HTML block or embed
// something (escaped). Code spans are left alone where marked is sure to
// read them as code. Every change can uncover another link ("[" + "[x](u)" +
// "](v)"), so the pass repeats until nothing changes. What's left is written
// so that a reading that differs from this one (a blockquote, a table cell, a
// strikethrough) still can't make a new link: every other bracket is
// escaped, and a kept link's URL is written with its "://" escaped (marked
// shows it as "://"), so it can't turn into a bare-URL link. The pages also
// check every rendered link against the hand-off (worker/chat-page.js,
// worker/questions-page.js).
//
// Provider-neutral and pure: no network, no model.

/**
 * A URL as both sides are compared: trimmed, and one trailing slash taken off
 * the path. The query string, the fragment and the case are never touched.
 */
export function normalizeUrl(url) {
  const s = String(url ?? '').trim();
  const cut = s.search(/[?#]/);
  const head = cut < 0 ? s : s.slice(0, cut);
  const tail = cut < 0 ? '' : s.slice(cut);
  return (head.endsWith('/') && !head.endsWith('//') ? head.slice(0, -1) : head) + tail;
}

/** Markdown backslash escapes removed, as marked reads a link's URL. */
export const unescapeMarkdown = (s) => String(s ?? '').replace(UNESCAPE, '$1');

const web = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());

/**
 * Every URL this answer handed off, normalized: records (web pages among
 * them), dataset pages, full and per-query CSVs and API docs, contact sites
 * and emails (as mailto:), and the deployment's links. Only web links count.
 */
export function handoffUrls(resources = {}) {
  const set = new Set();
  const add = (u) => {
    if (web(u)) set.add(normalizeUrl(u));
  };
  for (const r of resources.records || []) add(r?.url);
  for (const d of resources.datasets || []) {
    add(d?.page);
    add(d?.csv);
    add(d?.docs);
    for (const q of d?.queries || []) add(q);
  }
  for (const c of resources.contacts || []) {
    add(c?.url);
    if (typeof c?.email === 'string' && c.email.trim()) set.add(`mailto:${c.email.trim()}`);
  }
  for (const l of resources.links || []) add(l?.url);
  return set;
}

/**
 * The hand-off's sources that Siren's tools can read again, by normalized
 * URL, with their own titles: every record (a legislation or meeting page, a
 * document section, a web page) and every dataset's page. Contacts, CSV and
 * query links, API docs and deployment links aren't sources to read.
 */
export function readableSources(resources = {}) {
  const map = new Map();
  for (const r of resources.records || []) if (web(r?.url) && !map.has(normalizeUrl(r.url))) map.set(normalizeUrl(r.url), { title: String(r.title || r.url), url: r.url });
  for (const d of resources.datasets || []) if (web(d?.page) && !map.has(normalizeUrl(d.page))) map.set(normalizeUrl(d.page), { title: String(d.name || d.id || d.page), url: d.page });
  return map;
}

// ---- marked 12.0.2's inline rules (GFM on, pedantic off), sticky -----------

const LABEL = String.raw`(?:\[(?:\\.|[^\[\]\\])*\]|\\.|` + '`[^`]*`' + String.raw`|[^\[\]\\` + '`' + String.raw`])*?`;
const BLOCK_LABEL = String.raw`(?!\s*\])(?:\\.|[^\[\]\\])+`;
const HREF = String.raw`<(?:\\.|[^\n<>\\])+>|[^\s\x00-\x1f]*`;
const TITLE = String.raw`"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)`;
const LINK = new RegExp(String.raw`!?\[(${LABEL})\]\(\s*(${HREF})(?:\s+(${TITLE}))?\s*\)`, 'y');
const REFLINK = new RegExp(String.raw`!?\[(${LABEL})\]\[(${BLOCK_LABEL})\]`, 'y');
const NOLINK = new RegExp(String.raw`!?\[(${BLOCK_LABEL})\](?:\[\])?`, 'y');
const AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const URL_RE = /((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/iy;
const EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/y;
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const ATTRIBUTE = String.raw`\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>` + '`' + String.raw`]+)?`;
const TAG = new RegExp(String.raw`<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][\w:-]*\s*>|<[a-zA-Z][\w-]*(?:${ATTRIBUTE})*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>`, 'y');
const CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
// After any container markers ("> - "), a link definition's start, and a
// tag's, which would start a raw HTML block.
const CONTAINERS = String.raw`(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*`;
const DEF_START = new RegExp(String.raw`${CONTAINERS}(?=\[${BLOCK_LABEL}\]:)`, 'y');
const HTML_START = new RegExp(String.raw`${CONTAINERS}(?=<[!?/a-zA-Z])`, 'y');
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
const UNESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g;
const LOCAL = /[A-Za-z0-9._+-]/;

// Raw tags left as they are: text formatting, lists, tables, headings. Raw
// <a> and <img> are removed; any other tag is escaped so it shows as text.
const ALLOWED_TAGS = new Set('b strong i em u s del ins sub sup small mark br hr p span div code pre kbd samp var abbr cite table thead tbody tfoot tr th td caption colgroup col ul ol li dl dt dd blockquote h1 h2 h3 h4 h5 h6'.split(' '));

const at = (re, s, i) => {
  re.lastIndex = i;
  return re.exec(s);
};
// marked reads inline markdown a paragraph at a time: for an index that only
// grows, s up to the blank line after it.
function paragraphs(s) {
  const end = /\n[ \t]*(?:\n|$)/g;
  let upTo = -1;
  let text = '';
  return (i) => {
    if (i >= upTo) {
      end.lastIndex = i;
      upTo = end.exec(s)?.index ?? s.length;
      text = s.slice(0, upTo);
    }
    return text;
  };
}

// marked's findClosingBracket.
function closingParen(str) {
  if (!str.includes(')')) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === '(') level++;
    else if (str[i] === ')' && --level < 0) return i;
  }
  return -1;
}

// An inline link or image at i, as marked's link tokenizer reads it:
// { raw, label, href } or null.
function inlineLink(p, i) {
  const cap = at(LINK, p, i);
  if (!cap) return null;
  let raw = cap[0];
  let href = cap[2];
  const trimmed = href.trim();
  if (trimmed.startsWith('<')) {
    if (!trimmed.endsWith('>')) return null;
    const unslashed = trimmed.slice(0, -1).replace(/\\+$/, '');
    if ((trimmed.length - unslashed.length) % 2 === 0) return null;
  } else {
    const last = closingParen(href);
    if (last > -1) {
      const start = raw.startsWith('!') ? 5 : 4;
      raw = raw.substring(0, start + cap[1].length + last).trim();
      href = href.substring(0, last);
    }
  }
  const dest = href.trim();
  const title = raw === cap[0] ? cap[3] || '' : '';
  return { raw, label: cap[1], dest, title, href: (dest.startsWith('<') ? dest.slice(1, -1) : dest).replace(UNESCAPE, '$1') };
}

// What marked's URL autolink keeps of a match: trailing punctuation backs off.
function backpedal(s) {
  let prev;
  let cur = s;
  do {
    prev = cur;
    cur = BACKPEDAL.exec(cur)?.[0] ?? '';
  } while (prev !== cur);
  return cur;
}

// Text marked won't link: the separators a bare URL or email needs are
// escaped (marked shows "\:" as ":"). Doing it twice changes nothing.
const disarm = (s) => s.replace(/(https?|ftp):\/\//gi, '$1\\://').replace(/(www)\./gi, '$1\\.').replace(/(?<!\\)@/g, '\\@');

// `inLink`: s is a kept link's text, where marked links no bare URL.
function scan(s, known, tally, inLink = false) {
  let out = '';
  let i = 0;
  // Code spans are left alone only where marked is sure to read them as
  // code. Up to here, a backtick may sit inside a tag or a longer code span
  // that marked reads first, so nothing is skipped.
  let noCodeUntil = 0;
  const para = paragraphs(s);
  // The email-local run last tried: a run that failed fails from any start.
  let triedRun = -1;
  // Where the run of email-local characters at each index ends: an email can
  // start only where that run meets an "@". Any start counts, not only a
  // run's first character: an escape or a disarmed URL starts a new token.
  const runEnd = new Int32Array(s.length + 1);
  runEnd[s.length] = s.length;
  for (let j = s.length - 1; j >= 0; j--) runEnd[j] = LOCAL.test(s[j]) ? runEnd[j + 1] : j;
  while (i < s.length) {
    if (i === 0 || s[i - 1] === '\n') {
      // A line that starts with a tag would start a raw HTML block, where no
      // markdown escape works: its "<" is escaped so it reads as text (a raw
      // <a> or <img> is removed below instead).
      const h = at(HTML_START, s, i);
      if (h && !at(AUTOLINK, s, i + h[0].length)) {
        out += h[0];
        i += h[0].length;
        const name = (/^<([a-zA-Z][\w:-]*)/.exec(at(TAG, s, i)?.[0] || '')?.[1] || '').toLowerCase();
        if (name !== 'a' && name !== 'img') {
          out += '\\<';
          i += 1;
          continue;
        }
        if (h[0]) continue;
      }
      // A link definition can't resolve once its bracket is escaped.
      const d = at(DEF_START, s, i);
      if (d) {
        out += `${d[0]}\\[`;
        i += d[0].length + 1;
        continue;
      }
    }
    const c = s[i];
    if (c === '\\' && ESCAPABLE.test(s[i + 1] || '')) {
      out += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '`') {
      // With no code span here, marked reads the whole run of backticks and
      // tildes as text.
      const run = /[`~]+/y;
      run.lastIndex = i;
      const r = run.exec(s)[0];
      const span = at(CODE, para(i), i);
      const end = s.indexOf('\n', i);
      const line = s.slice(s.lastIndexOf('\n', i - 1) + 1, end < 0 ? s.length : end);
      // Left alone: a code span on one line, not after a tilde, on a line
      // with no pipe (GFM splits table cells on pipes, even inside code), no
      // tag start, and no emphasis or strikethrough mark (marked's emphasis
      // and strikethrough can swallow a code span's opening). Anywhere else
      // it is read like the rest, which changes it only if it holds a link.
      if (span && i >= noCodeUntil && s[i - 1] !== '~' && !span[0].includes('\n') && !/[|<~*_]/.test(line)) {
        out += span[0];
        i += span[0].length;
        continue;
      }
      if (span) noCodeUntil = Math.max(noCodeUntil, i + span[0].length);
      out += r;
      i += r.length;
      continue;
    }
    if (c === '<') {
      const tag = at(TAG, s, i);
      if (tag) {
        const t = tag[0];
        const name = (/^<\/?([a-zA-Z][\w:-]*)/.exec(t)?.[1] || '').toLowerCase();
        if (name === 'a' || name === 'img') {
          if (!t.startsWith('</')) tally.dropped++;
          i += t.length;
          continue;
        }
        // A formatting tag stays; any other tag, comment, declaration or
        // processing instruction shows as text. Either way what's inside is
        // read on, with no code span skipped.
        noCodeUntil = Math.max(noCodeUntil, i + t.length);
        out += name && ALLOWED_TAGS.has(name) ? '<' : '\\<';
        i += 1;
        continue;
      }
      const auto = at(AUTOLINK, s, i);
      if (auto) {
        const href = auto[2] ? `mailto:${auto[1]}` : auto[1];
        if (known.has(normalizeUrl(href))) {
          out += auto[0];
          tally.kept++;
        } else {
          out += disarm(auto[1]);
          tally.dropped++;
        }
        i += auto[0].length;
        continue;
      }
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      const link = inlineLink(para(i), i);
      if (link) {
        if (image) {
          tally.dropped++;
        } else if (known.has(normalizeUrl(link.href))) {
          // Kept, with what it says read again (marked reads escaped brackets
          // in link text as brackets). Its URL, and any in its text, are
          // written so that if marked ever read this as plain text, they
          // still wouldn't become links.
          const inner = link.label.replace(/\\([[\]])/g, '$1');
          const done = scan(inner, known, tally, true);
          // A link with nothing left to read is no link.
          if (!done.trim()) tally.dropped++;
          else {
            out += `[${done === inner ? link.label : done}](${disarm(link.dest)}${link.title ? ` ${link.title}` : ''})`;
            tally.kept++;
          }
        } else {
          out += link.label;
          tally.dropped++;
        }
        i += link.raw.length;
        continue;
      }
      // Reference-style: "[text][ref]" and "[text][]" become their text; a
      // bare "[ref]" stays as written (no definition is left to resolve it).
      const p = para(i);
      const full = at(REFLINK, p, i);
      const short = full ? null : at(NOLINK, p, i);
      const ref = full || (short && short[0].endsWith('[]') ? short : null);
      if (ref) {
        if (!image) out += ref[1];
        tally.dropped++;
        i += ref[0].length;
        continue;
      }
      // Any other bracket is escaped, so that no reading of the text, marked's
      // in a blockquote, a table cell or a strikethrough included, can open a
      // link or image with it. In a link's text, where marked unescapes
      // brackets, it's written as an entity.
      out += image ? '!' : inLink ? '&#91;' : '\\[';
      i += 1;
      continue;
    }
    if (/[hfw]/i.test(c)) {
      const m = at(URL_RE, s, i);
      if (m) {
        const keep = backpedal(m[0]);
        const href = /^www\./i.test(keep) ? `http://${keep}` : keep;
        if (inLink) {
          // Not a link inside a link's text: written so it never becomes one.
          out += disarm(m[0]);
          i += m[0].length;
        } else if (keep && known.has(normalizeUrl(href)) && !/^www\./i.test(keep)) {
          // Kept, between angle brackets: marked then links exactly this URL,
          // whatever follows it.
          out += `<${keep}>`;
          tally.kept++;
          i += keep.length;
        } else {
          out += disarm(m[0]);
          tally.dropped++;
          i += m[0].length;
        }
        continue;
      }
    }
    if (s[runEnd[i]] === '@' && runEnd[i] > i && runEnd[i] !== triedRun) {
      triedRun = runEnd[i];
      const m = at(EMAIL, s, i);
      if (m) {
        if (inLink) out += disarm(m[0]);
        else if (known.has(`mailto:${m[0]}`)) {
          out += `<${m[0]}>`;
          tally.kept++;
        } else {
          out += disarm(m[0]);
          tally.dropped++;
        }
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

const MAX_PASSES = 12;
const COUNT_CAP = 999;

/**
 * An answer with every link checked against `known` (a Set from
 * handoffUrls). Returns { text, kept, dropped }: the links left in the
 * final text and the links, images and bare URLs taken out, each capped at
 * 999. The dropped URLs themselves are never returned.
 */
export function filterAnswerLinks(text, known = new Set()) {
  let cur = String(text ?? '');
  let dropped = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const tally = { kept: 0, dropped: 0 };
    const next = scan(cur, known, tally);
    dropped += tally.dropped;
    if (next === cur) return { text: cur, kept: Math.min(tally.kept, COUNT_CAP), dropped: Math.min(dropped, COUNT_CAP) };
    cur = next;
  }
  // Nesting deeper than any answer has: every bracket escaped, every link gone.
  let flat = '';
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] === '\\' && i + 1 < cur.length) flat += cur[i] + cur[++i];
    else flat += cur[i] === '[' ? '\\[' : cur[i];
  }
  const tally = { kept: 0, dropped: 0 };
  return { text: scan(flat, new Set(), tally), kept: 0, dropped: Math.min(dropped + tally.dropped + 1, COUNT_CAP) };
}
