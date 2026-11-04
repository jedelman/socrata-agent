#!/usr/bin/env node
// Provenance or it doesn't ship: re-fetch every source in data/cases/*.json
// and check that each finding's quote is really there (and that an `absent`
// name really isn't). PDFs go through pdftotext (poppler-utils). Findings
// marked `unverified` are reported, never served as fact.
//
//   node scripts/verify-cases.js            check every case file
//   node scripts/verify-cases.js --write    also stamp `checked` dates on passes
//
// Exit code 1 if any quote is missing or any source can't be read.

import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { USER_AGENT } from '../src/plugins.js';

const dir = new URL('../data/cases/', import.meta.url);
const write = process.argv.includes('--write');
const today = new Date().toISOString().slice(0, 10);
const work = mkdtempSync(join(tmpdir(), 'cases-'));

export function normalize(s) {
  return String(s)
    .replace(/­/g, '')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
// Layout text breaks lines mid-sentence; compare with all whitespace removed too.
const squash = (s) => normalize(s).replace(/\s+/g, '');

const cache = new Map();
async function text(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let out;
  if (buf.subarray(0, 5).toString() === '%PDF-') {
    const f = join(work, `${cache.size}.pdf`);
    writeFileSync(f, buf);
    // Both layouts: -layout keeps tables in rows; the default reading order
    // keeps multi-column prose together.
    const run = (args) => execFileSync('pdftotext', [...args, f, '-'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    out = `${run(['-layout'])}\n${run([])}`;
  } else {
    out = buf.toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
  cache.set(url, out);
  return out;
}

let failed = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const path = new URL(file, dir);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  console.log(`\n${doc.id}`);
  for (const f of doc.findings) {
    if (f.unverified || !f.quote) {
      console.log(`  -  ${f.id}: unverified, served as unverified`);
      continue;
    }
    try {
      const body = await text(f.source.url);
      const found = normalize(body).includes(normalize(f.quote)) || squash(body).includes(squash(f.quote));
      const absentOk = !f.absent || !new RegExp(`\\b${f.absent}\\b`, 'i').test(body);
      if (found && absentOk) {
        console.log(`  ok ${f.id}`);
        if (write) f.checked = today;
      } else {
        failed++;
        console.log(`  XX ${f.id}: ${found ? `"${f.absent}" appears on the page` : `quote not found: "${f.quote}"`}`);
      }
    } catch (err) {
      failed++;
      console.log(`  XX ${f.id}: could not read ${f.source.url} (${err.message})`);
    }
  }
  if (write) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(failed ? `\n${failed} finding(s) failed.` : '\nAll quotes found.');
process.exit(failed ? 1 : 0);
