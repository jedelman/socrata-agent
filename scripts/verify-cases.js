#!/usr/bin/env node
// Provenance or it doesn't ship: re-fetch every source in data/cases/*.json
// and check that each finding's quote is really there (and that an `absent`
// name really isn't). PDFs go through pdftotext (poppler-utils). Findings
// marked `unverified` are reported, never served as fact.
//
//   node scripts/verify-cases.js                    check every case file
//   node scripts/verify-cases.js --write            also record what was checked
//   node scripts/verify-cases.js --write --archive  also make sure a Wayback
//                                                   Machine snapshot holds each quote
//   ... --archive --no-save                         look up and read snapshots, but
//                                                   don't ask for new ones
//
// Durable findings. With --write, each passing finding records:
//   checked, checked_via   the date, and whether the live page or an archived
//                          snapshot proved the quote
//   evidence               the DASL CID (raw, sha2-256) and size of the exact
//                          bytes read, so anyone can tell if a copy is the one
//                          we checked
//   selector               a W3C Web Annotation TextQuoteSelector: the quote
//                          with the text just before and after it
//   source.archive         a Wayback Machine snapshot whose copy holds the quote
//
// When the live page fails (blocked, changed or gone), the verifier checks the
// archived snapshot instead. Outcomes:
//   ok    the live page holds the quote, or it's unreachable from here and the
//         snapshot holds it
//   warn  the live page changed or vanished but the snapshot holds the quote
//         (served as "as archived"); or unreachable with no snapshot, verified
//         within STALE_DAYS
//   fail  the quote is gone everywhere we can see, or it's been unreachable and
//         unproven for longer than STALE_DAYS
// A finding that says something is absent (`absent`) is only checked live: an
// old snapshot can't show that a thing is still missing.
//
// Some networks can't reach web.archive.org (this project's cloud sessions get
// a connection reset). Archive steps then report and carry on; they never fail
// a run on their own.

import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { USER_AGENT } from '../src/plugins.js';

export const STALE_DAYS = 30;
// A snapshot verified this recently isn't re-checked in --archive mode.
export const ARCHIVE_FRESH_DAYS = 90;

export function normalize(s) {
  return display(s).toLowerCase();
}
// The same cleanup without lowercasing, for quoting text back (selectors).
function display(s) {
  return String(s)
    .replace(/­/g, '')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ');
}
// Layout text breaks lines mid-sentence; compare with all whitespace removed too.
const squash = (s) => normalize(s).replace(/\s+/g, '');

// --- DASL CIDs (https://dasl.ing/cid.html): CIDv1, raw codec, sha2-256, base32.
// A copy of the idea in scout-harness's lib/dasl.mjs, kept separate on purpose.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function rawCid(bytes) {
  const digest = createHash('sha256').update(bytes).digest();
  return `b${base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]))}`;
}

/** A W3C TextQuoteSelector for the quote in this text, or null if it's only found with whitespace removed. */
export function quoteSelector(text, quote, context = 40) {
  const shown = display(text);
  const at = shown.toLowerCase().indexOf(display(quote).toLowerCase());
  if (at < 0) return null;
  const end = at + display(quote).length;
  // Exact slices of the (whitespace-normalized) text, trimmed only at the
  // outer edge so they start and end on a whole word.
  const before = shown.slice(Math.max(0, at - context), at);
  const after = shown.slice(end, end + context);
  return {
    type: 'TextQuoteSelector',
    exact: quote,
    prefix: at - context > 0 ? before.replace(/^\S*\s/, '') : before.replace(/^\s+/, ''),
    suffix: end + context < shown.length ? after.replace(/\s\S*$/, '') : after.replace(/\s+$/, ''),
  };
}

export class Unreachable extends Error {}
export class Gone extends Error {}

/** What to do with one finding's check: 'ok', 'warn' or 'fail'. */
export function judge({ found, absentOk = true, unreachable = false, checked, now = Date.now() }) {
  if (unreachable) {
    const age = checked ? (now - Date.parse(checked)) / 864e5 : Infinity;
    return age <= STALE_DAYS ? 'warn' : 'fail';
  }
  return found && absentOk ? 'ok' : 'fail';
}

/** Page bytes as searchable text. PDFs through pdftotext, HTML with tags stripped. */
export function textOf(buf, workDir) {
  if (buf.subarray(0, 5).toString() === '%PDF-') {
    const f = join(workDir, `${rawCid(buf)}.pdf`);
    writeFileSync(f, buf);
    // Both layouts: -layout keeps tables in rows; the default reading order
    // keeps multi-column prose together.
    const run = (args) => execFileSync('pdftotext', [...args, f, '-'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return `${run(['-layout'])}\n${run([])}`;
  }
  return buf.toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

const holds = (text, quote) => normalize(text).includes(normalize(quote)) || squash(text).includes(squash(quote));
const ageDays = (date, now) => (date ? (now - Date.parse(date)) / 864e5 : Infinity);
const tsDate = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

/**
 * Check one finding. `net` supplies the network so this runs offline in tests:
 *   live(url) -> Buffer, throws Unreachable or Gone
 *   archive.lookup(url) -> {url, timestamp} | null   (closest snapshot)
 *   archive.raw(url, timestamp) -> Buffer             (the snapshot's original bytes)
 *   archive.save(url) -> {url, timestamp} | null      (ask for a new snapshot)
 * Returns { outcome, via, message, patch, notes } where patch is what --write
 * would set on the finding.
 */
export async function checkFinding(f, { net, workDir, today, archiveMode = false, now = Date.now() }) {
  const notes = [];
  const absentOk = (text) => !f.absent || !new RegExp(`\\b${f.absent}\\b`, 'i').test(text);
  const evidenceOf = (buf, via) => ({ cid: rawCid(buf), bytes: buf.length, read: today, via });

  // An archived copy that holds the quote, if we can find one.
  const fromArchive = async () => {
    if (!net.archive) return null;
    const candidates = [];
    if (f.source.archive?.timestamp) candidates.push(f.source.archive);
    try {
      const closest = await net.archive.lookup(f.source.url);
      if (closest && !candidates.some((c) => c.timestamp === closest.timestamp)) candidates.push(closest);
      if (!closest && !candidates.length) notes.push('no snapshot yet');
    } catch (err) {
      notes.push(`archive lookup failed (${err.message})`);
    }
    for (const snap of candidates) {
      try {
        const buf = await net.archive.raw(f.source.url, snap.timestamp);
        const text = textOf(buf, workDir);
        if (holds(text, f.quote)) return { snap, buf, text };
        notes.push(`snapshot ${snap.timestamp} doesn't show the quote`);
      } catch (err) {
        notes.push(`archive unreachable (${err.message})`);
        return null; // one network failure means the archive is down from here; don't hammer it
      }
    }
    return null;
  };
  const archivePatch = (a) => ({ url: a.snap.url, timestamp: a.snap.timestamp, verified: today });

  let live;
  let liveError;
  try {
    const buf = await net.live(f.source.url);
    live = { buf, text: textOf(buf, workDir) };
  } catch (err) {
    liveError = err;
  }

  if (live) {
    const found = holds(live.text, f.quote);
    const okAbsent = absentOk(live.text);
    if (found && okAbsent) {
      const patch = { checked: today, checked_via: 'live', evidence: evidenceOf(live.buf, 'live') };
      const sel = quoteSelector(live.text, f.quote);
      if (sel) patch.selector = sel;
      if (archiveMode && !f.absent) {
        if (ageDays(f.source.archive?.verified, now) <= ARCHIVE_FRESH_DAYS) {
          // fresh enough
        } else {
          let a = await fromArchive();
          if (!a && net.archive?.save && !notes.some((n) => n.startsWith('archive unreachable'))) {
            try {
              const saved = await net.archive.save(f.source.url);
              if (saved) {
                const buf = await net.archive.raw(f.source.url, saved.timestamp);
                const text = textOf(buf, workDir);
                if (holds(text, f.quote)) a = { snap: saved, buf, text };
                else notes.push(`new snapshot ${saved.timestamp} doesn't show the quote (the page may load it with script)`);
              }
            } catch (err) {
              notes.push(`archive save failed (${err.message})`);
            }
          }
          if (a) patch.source = { ...f.source, archive: archivePatch(a) };
        }
      }
      return { outcome: 'ok', via: 'live', message: 'ok', patch, notes };
    }
    if (!okAbsent) return { outcome: 'fail', via: 'live', message: `"${f.absent}" appears on the page`, patch: null, notes };
    // The live page doesn't show the quote: has it changed since a snapshot?
    const a = f.absent ? null : await fromArchive();
    if (a) {
      return {
        outcome: 'warn', via: 'archive',
        message: `the live page no longer shows the quote; the snapshot from ${tsDate(a.snap.timestamp)} does (served as archived)`,
        patch: { checked: today, checked_via: 'archive', evidence: evidenceOf(a.buf, 'archive'), source: { ...f.source, archive: archivePatch(a) }, ...(quoteSelector(a.text, f.quote) ? { selector: quoteSelector(a.text, f.quote) } : {}) },
        notes,
      };
    }
    return { outcome: 'fail', via: 'live', message: `quote not found: "${f.quote}"`, patch: null, notes };
  }

  // Live failed: blocked from here, or gone.
  const a = f.absent ? null : await fromArchive();
  if (a) {
    const gone = liveError instanceof Gone;
    return {
      outcome: gone ? 'warn' : 'ok', via: 'archive',
      message: gone
        ? `the source is gone (${liveError.message}); the snapshot from ${tsDate(a.snap.timestamp)} holds the quote (served as archived)`
        : `live page unreachable from here (${liveError.message}); the snapshot from ${tsDate(a.snap.timestamp)} holds the quote`,
      patch: { checked: today, checked_via: 'archive', evidence: evidenceOf(a.buf, 'archive'), source: { ...f.source, archive: archivePatch(a) }, ...(quoteSelector(a.text, f.quote) ? { selector: quoteSelector(a.text, f.quote) } : {}) },
      notes,
    };
  }
  if (liveError instanceof Unreachable && judge({ unreachable: true, checked: f.checked, now }) === 'warn') {
    return { outcome: 'warn', via: 'none', message: `unreachable from here (${liveError.message}); last verified ${f.checked}, within ${STALE_DAYS} days`, patch: null, notes };
  }
  return {
    outcome: 'fail', via: 'none',
    message: `could not read ${f.source.url} (${liveError.message})${liveError instanceof Unreachable ? `; last verified ${f.checked || 'never'}, over ${STALE_DAYS} days ago` : ''}, and no snapshot holds the quote`,
    patch: null, notes,
  };
}

// --- The real network.
async function get(url, { timeoutMs = 60000, ...init } = {}) {
  try {
    return await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), ...init });
  } catch (err) {
    throw new Unreachable(err.cause?.code || err.message);
  }
}
const liveCache = new Map();
async function live(url) {
  if (liveCache.has(url)) return liveCache.get(url);
  let res;
  try {
    res = await get(url);
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
    res = await get(url); // one retry; a second failure is Unreachable
  }
  if (res.status === 404 || res.status === 410) throw new Gone(`HTTP ${res.status}`);
  if (!res.ok) throw new Unreachable(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  liveCache.set(url, buf);
  return buf;
}
// The Wayback Machine: https://archive.org/help/wayback_api.php and Save Page Now.
const wayback = {
  async lookup(url) {
    const res = await get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Unreachable(`HTTP ${res.status}`);
    const c = (await res.json())?.archived_snapshots?.closest;
    return c?.available && c.timestamp ? { url: c.url.replace(/^http:/, 'https:'), timestamp: c.timestamp } : null;
  },
  async raw(url, timestamp) {
    // id_ returns the original bytes, without the Wayback toolbar or rewriting.
    const res = await get(`https://web.archive.org/web/${timestamp}id_/${url}`);
    if (!res.ok) throw new Unreachable(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  async save(url) {
    // Save Page Now often takes one to two minutes per capture.
    const res = await get(`https://web.archive.org/save/${url}`, { timeoutMs: 180000 });
    if (!res.ok) throw new Unreachable(`save HTTP ${res.status}`);
    // The final URL (after redirects) or Content-Location names the new snapshot.
    const where = res.headers.get('content-location') || res.url || '';
    const m = where.match(/\/web\/(\d{14})/);
    return m ? { url: `https://web.archive.org/web/${m[1]}/${url}`, timestamp: m[1] } : null;
  },
};

const main = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (main) {
  const dir = new URL('../data/cases/', import.meta.url);
  const write = process.argv.includes('--write');
  const archiveMode = process.argv.includes('--archive');
  const today = new Date().toISOString().slice(0, 10);
  const workDir = mkdtempSync(join(tmpdir(), 'cases-'));
  // Circuit breakers: once reading the archive fails from this machine, stop
  // reading it this run. Saving has its own breaker (a slow capture isn't an
  // outage) and a per-run cap, to stay within Save Page Now's limits.
  const noSave = process.argv.includes('--no-save');
  const MAX_SAVES = 5;
  let archiveDown = null;
  let saveDown = null;
  let saves = 0;
  const guard = (fn) => async (...a) => {
    if (archiveDown) throw new Unreachable(archiveDown);
    try {
      return await fn(...a);
    } catch (err) {
      if (err instanceof Unreachable) archiveDown = `${err.message}; not retried this run`;
      throw err;
    }
  };
  const saveGuarded = async (url) => {
    if (saveDown) throw new Unreachable(saveDown);
    if (saves >= MAX_SAVES) throw new Unreachable(`${MAX_SAVES} saves this run already; the rest wait for next run`);
    saves++;
    try {
      return await wayback.save(url);
    } catch (err) {
      if (err instanceof Unreachable) saveDown = `${err.message}; not retried this run`;
      throw err;
    }
  };
  const net = { live, archive: { lookup: guard(wayback.lookup), raw: guard(wayback.raw), ...(noSave ? {} : { save: saveGuarded }) } };
  let failed = 0;
  let warned = 0;
  let archived = 0;
  for (const file of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const path = new URL(file, dir);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    console.log(`\n${doc.id}`);
    for (const f of doc.findings) {
      if (f.unverified || !f.quote) {
        console.log(`  -  ${f.id}: unverified, served as unverified`);
        continue;
      }
      const r = await checkFinding(f, { net, workDir, today, archiveMode });
      const mark = { ok: 'ok', warn: '??', fail: 'XX' }[r.outcome];
      console.log(`  ${mark} ${f.id}${r.message === 'ok' ? '' : `: ${r.message}`}${r.via === 'archive' && r.outcome === 'ok' ? ' [via archive]' : ''}${r.notes.length ? `  (${[...new Set(r.notes)].join('; ')})` : ''}`);
      if (r.patch?.source?.archive || r.via === 'archive') archived++;
      if (r.outcome === 'fail') failed++;
      if (r.outcome === 'warn') warned++;
      if (write && r.patch) Object.assign(f, r.patch);
    }
    if (write) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
  if (archiveMode || archived) console.log(`\nWayback Machine: ${archived} snapshot(s) checked and holding their quotes this run.`);
  if (archiveMode) console.log(`Saves requested: ${saves}${noSave ? ' (--no-save)' : ''}${saveDown ? `; saving stopped: ${saveDown}` : ''}.`);
  if (archiveDown) console.log(`\nThe Wayback Machine was unreachable from here (${archiveDown}). Archive steps were skipped; nothing failed because of it.`);
  const note = warned ? ` ${warned} finding(s) need a look (see ??).` : '';
  console.log(failed ? `\n${failed} finding(s) failed.${note}` : `\nAll quotes found.${note}`);
  process.exit(failed ? 1 : 0);
}
