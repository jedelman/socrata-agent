#!/usr/bin/env node
// Turn an ordinance PDF into a document Siren can search and quote:
// data/documents/<id>.json, with the sections, the tags that say what the
// text is and how current, and the DASL CID of the exact PDF bytes read.
//
// Run it wherever the PDF is. The text is far smaller than the PDF, so a
// file too big to upload anywhere becomes a JSON you can commit.
//
//   # the city's own copy, fetched (preferred: the URL is the provenance)
//   node scripts/ingest-document.js --fetch https://norfolk.gov/DocumentCenter/View/35581/Adopted-Zoning-Ordinance \
//     --id norfolk-zoning-ordinance --title "Zoning Ordinance" \
//     --enacted "Norfolk City Council, adopted January 23, 2018" --current-through "updated October 13, 2026"
//
//   # a copy you already have (say where it came from with --url)
//   node scripts/ingest-document.js ~/Downloads/code.pdf --url <the page you downloaded it from> \
//     --id norfolk-city-code --title "Norfolk City Code" --enacted "Norfolk City Council" \
//     --current-through "Supplement No. ..., from the PDF's cover" --supplied-by "Your Name" \
//     --sections pages --out data/documents/private/norfolk-city-code.json
//
// Needs pdftotext (poppler): `brew install poppler` or `apt install poppler-utils`.
// --sections decimal (numbered "5.6.1." sections with a table of contents) or
// pages (one chunk per page, for any PDF). data/documents/private/ is not
// committed: put anything there that shouldn't be public yet.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rawCid } from './verify-cases.js';
import { splitSections } from '../src/documents.js';
import { USER_AGENT } from '../src/plugins.js';

const REQUIRED = ['id', 'title', 'enacted', 'current-through', 'url'];

/** The document JSON, from the PDF's bytes, pdftotext's output, and the tags. Pure, for tests. */
export function buildDocument({ bytes, text, tags, extractor, retrieved, retrievedBy }) {
  for (const k of REQUIRED) if (!tags[k]) throw new Error(`--${k} is required`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tags.id)) throw new Error('--id must be lowercase words joined by hyphens');
  const pages = text.split('\f');
  if (pages.at(-1).trim() === '') pages.pop();
  const sections = splitSections(pages, { preset: tags.sections || 'decimal' });
  if (!sections.length) throw new Error('No sections found; try --sections pages.');
  const chars = sections.reduce((n, s) => n + s.text.length, 0);
  if (chars < 1000) throw new Error(`Only ${chars} characters of text: is this a scanned PDF with no text layer? It needs OCR first (ocrmypdf).`);
  return {
    id: tags.id,
    title: tags.title,
    jurisdiction: tags.jurisdiction || 'ocd-division/country:us/state:va/place:norfolk',
    enacted: tags.enacted,
    current_through: tags['current-through'],
    source: {
      url: tags.url,
      retrieved,
      retrieved_by: retrievedBy,
      cid: rawCid(bytes),
      bytes: bytes.length,
      pages: pages.length,
    },
    extracted: { tool: extractor, sections: tags.sections || 'decimal' },
    note: 'Text extracted from the PDF at source.url. The PDF is the authority: check a quote against it, at the page given, before relying on it. Amendments after current_through are not in this text.',
    sections,
  };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || i + 1 >= argv.length ? true : argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  let bytes;
  if (a.fetch) {
    const res = await fetch(a.fetch, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`${a.fetch}: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    a.url ||= a.fetch;
  } else if (a._[0]) {
    bytes = readFileSync(a._[0]);
  } else {
    throw new Error('Give a PDF path, or --fetch <url>.');
  }
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('That is not a PDF.');
  const dir = mkdtempSync(join(tmpdir(), 'ingest-'));
  try {
    const pdf = join(dir, 'doc.pdf');
    writeFileSync(pdf, bytes);
    const text = execFileSync('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 1 << 30 }).toString();
    // pdftotext prints its version on stderr.
    const v = /version ([\d.]+)/.exec(spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).stderr || '')?.[1];
    const tool = `pdftotext -layout${v ? ` (poppler ${v})` : ''}`;
    const doc = buildDocument({
      bytes,
      text,
      tags: a,
      extractor: tool,
      retrieved: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      retrievedBy: a['supplied-by'] || (a.fetch ? 'fetched from the official URL' : 'unnamed'),
    });
    const out = a.out || `data/documents/${doc.id}.json`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(doc, null, 1)}\n`);
    const kb = Math.round(readFileSync(out).length / 1024);
    console.log(`${out}: ${doc.sections.length} sections, ${doc.source.pages} pages, ${kb} KB`);
    console.log(`PDF ${doc.source.bytes} bytes, CID ${doc.source.cid}`);
    const odd = doc.sections.filter((s) => s.heading);
    for (const s of odd) console.log(`check ${s.number}: contents say "${s.title}", the heading says "${s.heading}"`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
