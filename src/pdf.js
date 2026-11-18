// A small PDF text reader with no dependencies (CLAUDE.md: one runtime
// dependency, by Jason's choice), for the City's own files: first the Board
// of Zoning Appeals and Architectural Review Board agendas, which iqm2 posts
// as a PDF and not as items (Jason, 2026-11-18: "add a file reader for the
// BZA and ARB items - it'll come in handy later"). It reads what those files
// are made of, checked 2026-11-18: Power PDF Create and Microsoft Word output,
// PDF 1.5 to 1.7, Flate-compressed streams, object streams, TrueType fonts in
// WinAnsi encoding, and Word's Identity-H fonts with a ToUnicode map. It is
// not a general PDF engine: an encrypted file, a font it can't map, or a
// filter other than Flate gives less text or none, never a guess.
//
// pdfText(bytes) returns { pages: [text], unreadable } where `unreadable`
// counts the strings in fonts it couldn't map. Runs in Node and Workers
// (DecompressionStream, no Node APIs).

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

/** Bytes as a Latin-1 string, one char per byte. */
export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
}

/** Inflate a zlib stream, keeping what came out before any error (a truncated stream still gives its text). */
export async function inflate(bytes) {
  const tryFormat = async (format, data) => {
    let reader;
    try {
      reader = new Blob([data]).stream().pipeThrough(new DecompressionStream(format)).getReader();
    } catch {
      return null; // a runtime without this format
    }
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
    } catch {
      if (!size) return null;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  return (await tryFormat('deflate', bytes)) || (bytes.length > 2 ? await tryFormat('deflate-raw', bytes.subarray(2)) : null);
}

// ---- the object syntax ----

class Ref {
  constructor(n, g) {
    this.n = n;
    this.g = g;
  }
}
class Str {
  constructor(s) {
    this.s = s;
  }
}
class Op {
  constructor(op) {
    this.op = op;
  }
}

/** A lexer over a Latin-1 string: PDF objects, and content-stream operators. */
export class Lexer {
  constructor(s, pos = 0) {
    this.s = s;
    this.pos = pos;
  }

  skip() {
    const s = this.s;
    for (;;) {
      while (this.pos < s.length && WS.has(s.charCodeAt(this.pos))) this.pos++;
      if (s[this.pos] !== '%') return;
      while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
    }
  }

  word() {
    const s = this.s;
    const start = this.pos;
    while (this.pos < s.length && !WS.has(s.charCodeAt(this.pos)) && !DELIM.has(s.charCodeAt(this.pos))) this.pos++;
    return s.slice(start, this.pos);
  }

  literal() {
    const s = this.s;
    let depth = 1;
    let out = '';
    this.pos++;
    while (this.pos < s.length) {
      const c = s[this.pos++];
      if (c === '\\') {
        const e = s[this.pos++];
        const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[e];
        if (esc !== undefined) out += esc;
        else if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && s[this.pos] >= '0' && s[this.pos] <= '7') oct += s[this.pos++];
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (e === '\r') {
          if (s[this.pos] === '\n') this.pos++;
        } else if (e !== '\n') out += e;
      } else if (c === '(') {
        depth++;
        out += c;
      } else if (c === ')') {
        if (--depth === 0) break;
        out += c;
      } else out += c;
    }
    return new Str(out);
  }

  hex() {
    const s = this.s;
    const end = s.indexOf('>', this.pos);
    const h = s.slice(this.pos + 1, end < 0 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
    this.pos = end < 0 ? s.length : end + 1;
    let out = '';
    for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt((h[i] + (h[i + 1] || '0')), 16));
    return new Str(out);
  }

  name() {
    this.pos++;
    return `/${this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))}`;
  }

  /** The next object; `ops` returns operators as Op instead of stopping at them. */
  value(ops = false) {
    this.skip();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos];
    if (c === '/') return this.name();
    if (c === '(') return this.literal();
    if (c === '<' && s[this.pos + 1] === '<') {
      this.pos += 2;
      const dict = {};
      for (;;) {
        this.skip();
        if (s[this.pos] === '>' && s[this.pos + 1] === '>') {
          this.pos += 2;
          return dict;
        }
        if (this.pos >= s.length) return dict;
        const k = this.value();
        if (typeof k !== 'string' || k[0] !== '/') {
          // Not a name where a key should be: skip a byte so a broken dict can't loop forever.
          this.pos++;
          continue;
        }
        dict[k.slice(1)] = this.value();
      }
    }
    if (c === '<') return this.hex();
    if (c === '[') {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skip();
        if (s[this.pos] === ']') {
          this.pos++;
          return arr;
        }
        if (this.pos >= s.length) return arr;
        const before = this.pos;
        const v = this.value(ops);
        if (this.pos === before) this.pos++;
        else arr.push(v);
      }
    }
    if (c === ']' || c === '>' || c === ')' || c === '{' || c === '}') {
      this.pos++;
      return ops ? new Op(c) : null;
    }
    const w = this.word();
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) {
      const num = Number(w);
      // "12 0 R" is a reference.
      if (/^\d+$/.test(w)) {
        const save = this.pos;
        this.skip();
        const g = this.word();
        this.skip();
        if (/^\d+$/.test(g) && s[this.pos] === 'R' && (this.pos + 1 >= s.length || WS.has(s.charCodeAt(this.pos + 1)) || DELIM.has(s.charCodeAt(this.pos + 1)))) {
          this.pos++;
          return new Ref(num, Number(g));
        }
        this.pos = save;
      }
      return num;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (!w) {
      this.pos++;
      return null;
    }
    return ops ? new Op(w) : null;
  }
}

// ---- encodings ----

const WIN_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d,
  0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
const winAnsi = (code) => (code >= 0x80 && code <= 0x9f ? (WIN_HIGH[code] ? String.fromCharCode(WIN_HIGH[code]) : '') : code >= 0x20 || code === 9 ? String.fromCharCode(code) : '');
const standard = (code) => (code === 0x27 ? '’' : code === 0x60 ? '‘' : code < 0x80 ? winAnsi(code) : '');

// Glyph names a /Differences array may use, beyond single letters and uniXXXX.
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',',
  hyphen: '-', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', underscore: '_',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', section: '§', paragraph: '¶', degree: '°', copyright: '©', registered: '®', trademark: '™',
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', nbspace: ' ', sfthyphen: '-',
};
const glyph = (name) => {
  const n = String(name).replace(/^\//, '');
  if (/^[A-Za-z]$/.test(n)) return n;
  if (GLYPHS[n] !== undefined) return GLYPHS[n];
  const u = /^uni([0-9A-Fa-f]{4})$/.exec(n) || /^u([0-9A-Fa-f]{4,6})$/.exec(n);
  return u ? String.fromCodePoint(parseInt(u[1], 16)) : '';
};

/** A ToUnicode CMap: { map: Map(code -> text), lengths: [byte lengths of codes] }. */
export function parseCMap(text) {
  const map = new Map();
  const lengths = new Set();
  const hexes = (s) => [...s.matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1]);
  const utf16 = (h) => {
    let out = '';
    for (let i = 0; i + 3 < h.length + (h.length % 4 ? 4 : 0); i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4).padEnd(4, '0'), 16));
    return out;
  };
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const h of hexes(block[1])) lengths.add(h.length / 2);
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const h = hexes(block[1]);
    for (let i = 0; i + 1 < h.length; i += 2) {
      map.set(parseInt(h[i], 16), utf16(h[i + 1]));
      if (!lengths.size) lengths.add(h[i].length / 2);
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 0xffff);
      if (m[3][0] === '[') {
        const list = hexes(m[3]);
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, utf16(list[c - lo]));
      } else {
        const base = m[3].slice(1, -1);
        const units = utf16(base);
        for (let c = lo; c <= hi; c++) {
          const last = units.charCodeAt(units.length - 1) + (c - lo);
          map.set(c, units.slice(0, -1) + String.fromCharCode(last & 0xffff));
        }
      }
      if (!lengths.size) lengths.add(m[1].length / 2);
    }
  }
  return { map, lengths: [...lengths].filter((n) => n === 1 || n === 2) };
}

// ---- the document ----

/** Read a PDF's text. Throws on a file that isn't a PDF or is encrypted. */
export async function pdfText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const s = latin1(b);
  if (!s.startsWith('%PDF-')) throw new Error('not a PDF');
  const objects = new Map(); // number -> { value, stream (Latin-1 raw), at }
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = objRe.exec(s))) {
    const lex = new Lexer(s, m.index + m[0].length);
    const value = lex.value();
    let stream = null;
    lex.skip();
    if (s.startsWith('stream', lex.pos)) {
      let start = lex.pos + 6;
      if (s[start] === '\r') start++;
      if (s[start] === '\n') start++;
      const len = value && typeof value.Length === 'number' ? value.Length : -1;
      // The stated length when "endstream" follows it; else the next "endstream", less its line break.
      let end = len >= 0 && /^\s*endstream/.test(s.slice(start + len, start + len + 16)) ? start + len : -1;
      if (end < 0) {
        end = s.indexOf('endstream', start);
        if (end < 0) end = s.length;
        else if (s[end - 1] === '\n') end -= s[end - 2] === '\r' ? 2 : 1;
        else if (s[end - 1] === '\r') end -= 1;
      }
      stream = s.slice(start, end);
      objRe.lastIndex = end;
    } else objRe.lastIndex = Math.max(objRe.lastIndex, lex.pos);
    objects.set(Number(m[1]), { value, stream, at: m.index });
  }
  const get = (v, depth = 0) => (v instanceof Ref && depth < 32 ? get(objects.get(v.n)?.value, depth + 1) : v);
  const decoded = new Map();
  const streamOf = async (num) => {
    if (decoded.has(num)) return decoded.get(num);
    const o = objects.get(num);
    let out = null;
    if (o?.stream != null) {
      const filters = [].concat(get(o.value?.Filter) ?? []).map(get);
      let data = Uint8Array.from(o.stream, (c) => c.charCodeAt(0));
      for (const f of filters) {
        if (f === '/FlateDecode' || f === '/Fl') data = data && (await inflate(data));
        else data = null;
      }
      out = data ? latin1(data) : null;
    }
    decoded.set(num, out);
    return out;
  };

  // Objects packed in object streams.
  for (const [num, o] of [...objects]) {
    if (get(o.value?.Type) !== '/ObjStm') continue;
    const text = await streamOf(num);
    if (!text) continue;
    const first = get(o.value.First) || 0;
    const head = new Lexer(text);
    const n = get(o.value.N) || 0;
    const pairs = [];
    for (let i = 0; i < n; i++) pairs.push([head.value(), head.value()]);
    for (const [objNum, offset] of pairs) {
      if (typeof objNum !== 'number' || typeof offset !== 'number') continue;
      const held = objects.get(objNum);
      if (held && held.at > o.at) continue;
      objects.set(objNum, { value: new Lexer(text, first + offset).value(), stream: null, at: o.at });
    }
  }

  // The trailer: the last "trailer" dictionary, or the last cross-reference stream's.
  let trailer = null;
  const t = s.lastIndexOf('trailer');
  if (t >= 0) trailer = new Lexer(s, t + 7).value();
  if (!trailer?.Root) {
    // A linearized file's main cross-reference stream may carry no Root; the first-page one does.
    let best = null;
    for (const o of objects.values()) if (get(o.value?.Type) === '/XRef' && o.value.Root && (!best || o.at > best.at)) best = o;
    if (best) trailer = best.value;
  }
  if (trailer?.Encrypt || [...objects.values()].some((o) => get(o.value?.Type) === '/XRef' && o.value.Encrypt)) throw new Error('encrypted PDF');

  // Pages in order, each with its inherited resources.
  const pages = [];
  const walk = (ref, inherited, depth, seen) => {
    const node = get(ref);
    if (!node || depth > 32) return;
    if (ref instanceof Ref) {
      if (seen.has(ref.n)) return;
      seen.add(ref.n);
    }
    const resources = get(node.Resources) || inherited;
    if (get(node.Type) === '/Pages' || Array.isArray(get(node.Kids))) for (const kid of get(node.Kids) || []) walk(kid, resources, depth + 1, seen);
    else pages.push({ node, resources });
  };
  const root = get(trailer?.Root);
  if (root?.Pages) walk(root.Pages, null, 0, new Set());
  if (!pages.length) {
    for (const [, o] of [...objects].sort((a, z) => a[0] - z[0])) if (get(o.value?.Type) === '/Page') pages.push({ node: o.value, resources: get(o.value.Resources) });
  }

  // Fonts, decoded once each.
  const fonts = new Map();
  const fontOf = async (ref) => {
    const key = ref instanceof Ref ? ref.n : null;
    if (key != null && fonts.has(key)) return fonts.get(key);
    const font = get(ref) || {};
    let cmap = null;
    if (font.ToUnicode instanceof Ref) {
      const text = await streamOf(font.ToUnicode.n);
      if (text) cmap = parseCMap(text);
    }
    const type0 = get(font.Subtype) === '/Type0';
    let base = winAnsi;
    const diff = new Map();
    const enc = get(font.Encoding);
    if (!type0) {
      const name = typeof enc === 'string' ? enc : get(enc?.BaseEncoding);
      if (name === '/StandardEncoding' || (!name && get(font.Subtype) === '/Type1')) base = standard;
      if (enc && typeof enc === 'object' && Array.isArray(get(enc.Differences))) {
        let code = 0;
        for (const d of get(enc.Differences)) {
          if (typeof d === 'number') code = d;
          else if (typeof d === 'string') diff.set(code++, glyph(d));
        }
      }
    }
    const bytes = type0 ? (cmap?.lengths.length === 1 ? cmap.lengths[0] : 2) : 1;
    // Glyph widths (thousandths of the font size), to tell a gap between words from a run split mid-word.
    const widths = new Map();
    let fallback = 500;
    if (type0) {
      const cid = get(get(font.DescendantFonts)?.[0]) || {};
      fallback = typeof get(cid.DW) === 'number' ? get(cid.DW) : 1000;
      const w = get(cid.W) || [];
      for (let i = 0; i < w.length;) {
        const first = get(w[i]);
        const next = get(w[i + 1]);
        if (Array.isArray(next)) {
          next.forEach((x, j) => widths.set(first + j, get(x)));
          i += 2;
        } else {
          for (let c = first; c <= next && c - first < 65536; c++) widths.set(c, get(w[i + 2]));
          i += 3;
        }
      }
    } else {
      const first = get(font.FirstChar) || 0;
      (get(font.Widths) || []).forEach((x, j) => widths.set(first + j, get(x)));
      const missing = get(get(font.FontDescriptor)?.MissingWidth);
      if (typeof missing === 'number' && missing > 0) fallback = missing;
    }
    const decoder = {
      readable: !type0 || Boolean(cmap),
      codes(str) {
        const out = [];
        for (let i = 0; i + bytes <= str.length; i += bytes) out.push(bytes === 2 ? str.charCodeAt(i) * 256 + str.charCodeAt(i + 1) : str.charCodeAt(i));
        return out;
      },
      text(code) {
        const mapped = cmap?.map.get(code);
        return mapped !== undefined ? mapped : type0 ? '' : diff.has(code) ? diff.get(code) : base(code);
      },
      width: (code) => (widths.has(code) && typeof widths.get(code) === 'number' ? widths.get(code) : fallback),
      bytes,
    };
    if (key != null) fonts.set(key, decoder);
    return decoder;
  };

  let unreadable = 0;
  const texts = [];
  for (const { node, resources } of pages) {
    const lines = [];
    let line = '';
    const newline = () => {
      if (line.trim()) lines.push(line.replace(/\s+/g, ' ').trim());
      line = '';
    };
    const run = async (content, res, depth) => {
      if (!content || depth > 3) return;
      const lex = new Lexer(content);
      const stack = [];
      let font = null;
      let cmX = 0;
      let cmY = 0;
      const saved = [];
      let tx = 0;
      let ty = 0;
      let lineX = 0;
      let lineY = 0;
      let scale = 1;
      let lastY = null;
      let lastEnd = null;
      let lastSize = 0;
      let fontSize = 0;
      let size = 0;
      let scaleX = 1;
      let charSpace = 0;
      let wordSpace = 0;
      let hScale = 1;
      let space = false;
      let forceLine = false;
      const show = (str) => {
        if (!font) return;
        if (!font.readable) {
          unreadable++;
          return;
        }
        const y = cmY + ty;
        const x = cmX + tx;
        const dy = lastY === null ? 0 : Math.abs(y - lastY);
        // A new line when the baseline moves by most of a line; less is a superscript or a subscript ("27th"), kept on the line without a space.
        const lineGap = 0.7 * Math.max(size, lastSize, 1);
        if (forceLine || dy > Math.max(lineGap, 1)) newline();
        else if (line && !/\s$/.test(line) && (space || (dy <= 1 && lastEnd !== null && x - lastEnd > 0.2 * Math.max(size, 1)))) line += ' ';
        space = false;
        forceLine = false;
        lastY = y;
        lastSize = size;
        for (const code of font.codes(str)) {
          line += font.text(code);
          tx += ((font.width(code) / 1000) * fontSize + charSpace + (font.bytes === 1 && code === 32 ? wordSpace : 0)) * hScale * scaleX;
        }
        lastEnd = cmX + tx;
      };
      for (let guard = 0; guard < 2e6; guard++) {
        const v = lex.value(true);
        if (v === undefined) break;
        if (!(v instanceof Op)) {
          stack.push(v);
          continue;
        }
        const op = v.op;
        const num = (i) => Number(stack[stack.length - i]) || 0;
        switch (op) {
          case 'BI': {
            // An inline image: skip its data to "EI".
            const end = content.indexOf('EI', content.indexOf('ID', lex.pos));
            lex.pos = end < 0 ? content.length : end + 2;
            break;
          }
          case 'q':
            saved.push([cmX, cmY]);
            break;
          case 'Q':
            [cmX, cmY] = saved.pop() || [0, 0];
            break;
          case 'cm':
            cmX = cmX * num(6) + num(2);
            cmY = cmY * num(3) + num(1);
            break;
          case 'BT':
            tx = ty = lineX = lineY = 0;
            scale = scaleX = 1;
            break;
          case 'Tf': {
            fontSize = num(1);
            size = Math.abs(num(1)) * scale;
            const name = stack[stack.length - 2];
            const ref = get(get(res?.Font)?.[String(name).slice(1)]);
            font = ref ? await fontOf(get(res.Font)[String(name).slice(1)]) : null;
            break;
          }
          case 'Tm':
            scale = Math.abs(num(3)) || 1;
            scaleX = Math.abs(num(6)) || 1;
            size = Math.abs(fontSize) * scale;
            tx = lineX = num(2);
            ty = lineY = num(1);
            break;
          case 'Td':
          case 'TD':
            lineX += num(2) * scaleX;
            lineY += num(1) * scale;
            tx = lineX;
            ty = lineY;
            break;
          case 'Tc':
            charSpace = num(1);
            break;
          case 'Tw':
            wordSpace = num(1);
            break;
          case 'Tz':
            hScale = num(1) / 100 || 1;
            break;
          case 'T*':
            forceLine = true;
            break;
          case 'Tj':
            if (stack.at(-1) instanceof Str) show(stack.at(-1).s);
            break;
          case "'":
          case '"':
            forceLine = true;
            if (stack.at(-1) instanceof Str) show(stack.at(-1).s);
            break;
          case 'TJ':
            for (const part of Array.isArray(stack.at(-1)) ? stack.at(-1) : []) {
              if (part instanceof Str) show(part.s);
              else if (typeof part === 'number') {
                tx -= (part / 1000) * fontSize * hScale * scaleX;
                if (part < -180) space = true;
              }
            }
            break;
          case 'Do': {
            const xo = get(get(res?.XObject)?.[String(stack.at(-1)).slice(1)]);
            const ref = get(res?.XObject)?.[String(stack.at(-1)).slice(1)];
            if (get(xo?.Subtype) === '/Form' && ref instanceof Ref) {
              saved.push([cmX, cmY]);
              await run(await streamOf(ref.n), get(xo.Resources) || res, depth + 1);
              [cmX, cmY] = saved.pop() || [0, 0];
            }
            break;
          }
          default:
        }
        stack.length = 0;
      }
    };
    const contents = [].concat(node.Contents ?? []);
    let content = '';
    for (const c of contents.flatMap((x) => (x instanceof Ref && Array.isArray(get(x)) ? get(x) : [x]))) {
      if (c instanceof Ref) content += `${(await streamOf(c.n)) || ''}\n`;
    }
    await run(content, resources, 0);
    newline();
    texts.push(lines.join('\n'));
  }
  return { pages: texts, unreadable };
}
