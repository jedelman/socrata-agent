#!/usr/bin/env node
// Provenance or it doesn't ship: re-fetch every source in data/cases/*.json
// and check that each finding's quote is really there (and that an `absent`
// name really isn't). PDFs go through pdftotext (poppler-utils). Findings
// marked `unverified` are reported, never served as fact.
//
//   node scripts/verify-cases.js            check every case file
//   node scripts/verify-cases.js --write    also stamp `checked` dates on passes
//
// Exit code 1 if any quote is missing, a source is gone (404/410), or a
// source has been unreachable for longer than STALE_DAYS since its quote was
// last verified. A source that refuses this machine (a network error, 403,
// 429, 5xx: some sites block data-center IPs such as CI runners) only warns
// while its last successful check is recent: unreachable isn't disproved.

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

export const STALE_DAYS = 30;

class Unreachable extends Error {}

/** What to do with one finding's check: 'ok', 'warn' or 'fail'. */
export function judge({ found, absentOk = true, unreachable = false, checked, now = Date.now() }) {
  if (unreachable) {
    const age = checked ? (now - Date.parse(checked)) / 864e5 : Infinity;
    return age <= STALE_DAYS ? 'warn' : 'fail';
  }
  return found && absentOk ? 'ok' : 'fail';
}

const cache = new Map();
async function get(url) {
  try {
    return await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
  } catch (err) {
    throw new Unreachable(err.message);
  }
}
async function text(url) {
  if (cache.has(url)) return cache.get(url);
  let res;
  try {
    res = await get(url);
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
    res = await get(url); // one retry; a second failure is Unreachable
  }
  if (res.status === 404 || res.status === 410) throw new Error(`HTTP ${res.status}: the source is gone`);
  if (!res.ok) throw new Unreachable(`HTTP ${res.status}`);
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
let warned = 0;
const main = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
for (const file of main ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []) {
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
      if (judge({ found, absentOk }) === 'ok') {
        console.log(`  ok ${f.id}`);
        if (write) f.checked = today;
      } else {
        failed++;
        console.log(`  XX ${f.id}: ${found ? `"${f.absent}" appears on the page` : `quote not found: "${f.quote}"`}`);
      }
    } catch (err) {
      if (err instanceof Unreachable && judge({ unreachable: true, checked: f.checked }) === 'warn') {
        warned++;
        console.log(`  ?? ${f.id}: unreachable from here (${err.message}); last verified ${f.checked}, within ${STALE_DAYS} days`);
      } else {
        failed++;
        console.log(`  XX ${f.id}: could not read ${f.source.url} (${err.message})${err instanceof Unreachable ? `; last verified ${f.checked || 'never'}, over ${STALE_DAYS} days ago` : ''}`);
      }
    }
  }
  if (write) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}
if (main) {
  const note = warned ? ` ${warned} source(s) unreachable from here but verified within ${STALE_DAYS} days.` : '';
  console.log(failed ? `\n${failed} finding(s) failed.${note}` : `\nAll quotes found.${note}`);
  process.exit(failed ? 1 : 0);
}
