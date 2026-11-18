// A small PDF writer for tests: real PDF syntax in the shapes the City's
// agenda files use (checked 2026-11-18), so src/pdf.js is tested without
// committing a real agenda and the names in it. Lines are drawn one text
// object each, at fixed glyph widths (500 thousandths), so the reader's
// spacing can be checked: a run that continues a word sits exactly where the
// last one ended; a word gap is one space wide.

const enc = new TextEncoder();
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

export async function deflate(text) {
  const data = typeof text === 'string' ? bytesOf(text) : text;
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
// A simple font's strings are WinAnsi bytes: the dashes and quotes have their own codes there.
const WIN = { '\u2013': 0x96, '\u2014': 0x97, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2022': 0x95, '\u2026': 0x85 };
const winAnsi = (s) => [...s].map((c) => String.fromCharCode(WIN[c] ?? (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f))).join('');

/**
 * pages: [[line]], a line a string or an array of runs { text, dx (from the
 * last run's end, in glyph widths), dy (baseline shift), size }.
 * opts: { cid: Identity-H font with a ToUnicode map, objectStream: dicts in
 * an object stream with cross-reference streams (no "trailer"), linearized:
 * a second cross-reference stream at the end with no Root, encrypted }.
 */
export async function makePdf(pages, { cid = false, objectStream = false, linearized = false, encrypted = false } = {}) {
  const objects = []; // { num, dict, stream (bytes) }
  let next = 1;
  const add = (dict, stream = null) => {
    const num = next++;
    objects.push({ num, dict, stream });
    return num;
  };
  const catalog = add('');
  const pagesNum = add('');
  // The font, and for CID a glyph code per character with a ToUnicode map.
  const glyphs = new Map();
  const codeOf = (ch) => {
    if (!glyphs.has(ch)) glyphs.set(ch, glyphs.size + 3);
    return glyphs.get(ch);
  };
  const show = (text) => (cid ? `<${[...text].map((ch) => codeOf(ch).toString(16).padStart(4, '0')).join('')}> Tj` : `(${esc(winAnsi(text))}) Tj`);
  const pageNums = [];
  const fontSize = 10;
  const advance = 0.5 * fontSize;
  const contents = [];
  for (const lines of pages) {
    let y = 720;
    let ops = '';
    for (const line of lines) {
      const runs = typeof line === 'string' ? [{ text: line }] : line;
      let x = 72;
      for (const r of runs) {
        x += (r.dx || 0) * advance;
        const size = r.size || fontSize;
        ops += `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y + (r.dy || 0)} Tm ${show(r.text)} ET\n`;
        x += [...r.text].length * 0.5 * size;
      }
      y -= 14;
    }
    contents.push(ops);
  }
  let fontNum;
  if (cid) {
    const map = [...glyphs].map(([ch, code]) => `<${code.toString(16).padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`);
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n${map.length} beginbfchar\n${map.join('\n')}\nendbfchar\nendcmap end end`;
    const toUnicode = add(`/Length LEN /Filter /FlateDecode`, await deflate(cmap));
    const descendant = add(`/Type /Font /Subtype /CIDFontType2 /BaseFont /Calibri /DW 500 /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>`);
    fontNum = add(`/Type /Font /Subtype /Type0 /BaseFont /Calibri /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R`);
  } else {
    fontNum = add(`/Type /Font /Subtype /TrueType /BaseFont /ArialMT /FirstChar 32 /LastChar 255 /Widths [${Array(224).fill(500).join(' ')}] /Encoding /WinAnsiEncoding`);
  }
  for (const ops of contents) {
    const content = add(`/Length LEN /Filter /FlateDecode`, await deflate(ops));
    pageNums.push(add(`/Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${content} 0 R`));
  }
  objects.find((o) => o.num === catalog).dict = `/Type /Catalog /Pages ${pagesNum} 0 R`;
  objects.find((o) => o.num === pagesNum).dict = `/Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length}`;

  const parts = [bytesOf('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')];
  const write = (num, dict, stream) => {
    if (stream) {
      parts.push(enc.encode(`${num} 0 obj\n<< ${dict.replace('LEN', String(stream.length))} >>\nstream\n`), stream, enc.encode('\nendstream\nendobj\n'));
    } else parts.push(enc.encode(`${num} 0 obj\n<< ${dict} >>\nendobj\n`));
  };
  const encrypt = encrypted ? ' /Encrypt << /Filter /Standard /V 1 /R 2 >>' : '';
  if (objectStream) {
    const packed = objects.filter((o) => !o.stream);
    const bodies = packed.map((o) => `<< ${o.dict} >>`);
    let offset = 0;
    const header = packed.map((o, i) => {
      const h = `${o.num} ${offset}`;
      offset += bodies[i].length + 1;
      return h;
    }).join(' ');
    const data = `${header}\n${bodies.join('\n')}`;
    const objStm = next++;
    if (linearized) write(next++, `/Type /XRef /Root ${catalog} 0 R /Size ${next + 2} /W [1 2 1] /Length LEN /Filter /FlateDecode${encrypt}`, await deflate('\x00\x00\x00\x00'));
    for (const o of objects.filter((x) => x.stream)) write(o.num, o.dict, o.stream);
    write(objStm, `/Type /ObjStm /N ${packed.length} /First ${header.length + 1} /Length LEN /Filter /FlateDecode`, await deflate(data));
    const last = next++;
    write(last, `/Type /XRef${linearized ? '' : ` /Root ${catalog} 0 R`} /Size ${next} /W [1 2 1] /Length LEN /Filter /FlateDecode${linearized ? '' : encrypt}`, await deflate('\x00\x00\x00\x00'));
    parts.push(enc.encode('startxref\n0\n%%EOF\n'));
  } else {
    for (const o of objects) write(o.num, o.dict, o.stream);
    parts.push(enc.encode(`trailer\n<< /Root ${catalog} 0 R /Size ${next}${encrypt} >>\nstartxref\n0\n%%EOF\n`));
  }
  const size = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
