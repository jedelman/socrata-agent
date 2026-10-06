#!/usr/bin/env node
// Build the Norfolk legislation index: every agenda item from every meeting
// listed in the Public Meeting Notices dataset, with the street addresses in
// its title. The agent matches an address against this index to answer
// "who decided that?", then reads the live record for status and votes.
//
//   node scripts/build-norfolk-legislation.js [--since 2023-01-01]
//
// Writes data/norfolk-legislation.json. Safe to re-run; it rebuilds from scratch.

import { readFile, writeFile } from 'node:fs/promises';
import { parseMeeting, extractAddresses, normalizeAddress } from '../src/adapters/iqm2.js';
import norfolk from '../src/cities/norfolk.js';

const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : '2000-01-01';
const CONCURRENCY = 4;
const headers = process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {};

async function fetchText(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      // The app token is for Socrata only; never send it to the meeting portal.
      const res = await fetch(url, { headers: url.startsWith(`https://${norfolk.domain}/`) ? headers : {} });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

const soql = `SELECT date_and_time, organization, meeting_link WHERE date_and_time >= '${since}T00:00:00' AND date_and_time <= '${new Date().toISOString().slice(0, 10)}T23:59:59' ORDER BY date_and_time DESC LIMIT 50000`;
const notices = JSON.parse(
  await fetchText(`https://${norfolk.domain}/resource/${norfolk.meetings.noticesDataset}.json?$query=${encodeURIComponent(soql)}`)
);

const meetings = new Map();
for (const n of notices) {
  const id = n.meeting_link?.url?.match(/Detail_Meeting\.aspx\?ID=(\d+)/i)?.[1];
  if (id && !meetings.has(id)) meetings.set(id, { id, body: n.organization, date: n.date_and_time.slice(0, 10) });
}
console.error(`${notices.length} notices → ${meetings.size} meetings since ${since}`);

const items = new Map();
const queue = [...meetings.values()];
let done = 0;
let failed = 0;
async function worker() {
  while (queue.length) {
    const mt = queue.shift();
    try {
      const html = await fetchText(`${norfolk.meetings.iqm2}/Citizens/Detail_Meeting.aspx?ID=${mt.id}`);
      const parsed = parseMeeting(html);
      for (const it of parsed.items) {
        const cur = items.get(it.id) || {
          id: it.id,
          text: it.text.slice(0, 400),
          addresses: extractAddresses(it.text).map(normalizeAddress),
          meetings: [],
        };
        cur.meetings.push({ id: mt.id, body: mt.body, date: mt.date });
        items.set(it.id, cur);
      }
    } catch (err) {
      failed++;
      console.error(`meeting ${mt.id}: ${err.message}`);
    }
    if (++done % 100 === 0) console.error(`${done}/${meetings.size}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const all = [...items.values()].sort((a, b) => (b.meetings[0]?.date || '').localeCompare(a.meetings[0]?.date || ''));
const out = {
  built: new Date().toISOString(),
  source: `${norfolk.meetings.iqm2} via ${norfolk.portal}/d/${norfolk.meetings.noticesDataset}`,
  meetings: meetings.size,
  failed_meetings: failed,
  items: all,
};
if (failed > meetings.size * 0.05) {
  console.error(`${failed} of ${meetings.size} meetings failed to load; not writing a partial index.`);
  process.exit(1);
}
const file = new URL('../data/norfolk-legislation.json', import.meta.url);
const prev = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
if (prev && JSON.stringify(prev.items) === JSON.stringify(out.items)) {
  console.error('No new agenda items; leaving the index as it is.');
  process.exit(0);
}
await writeFile(file, JSON.stringify(out));
console.error(`${all.length} items (${all.filter((i) => i.addresses.length).length} with addresses), ${failed} meetings failed`);
