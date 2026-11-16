#!/usr/bin/env node
// Builds data/common-names.json: the most common US surnames and first names,
// lower case, from the Census Bureau's public lists. Watches use it to refuse
// a free-text phrase made only of common names (worker/watches.js): a watch
// follows topics and words in agenda titles, not people.
//   node scripts/build-common-names.js
// Sources (public domain, read 2026-11-16):
//   https://www2.census.gov/topics/genealogy/2010surnames/Names_2010Census_Top1000.xlsx
//   https://www2.census.gov/topics/genealogy/1990surnames/dist.male.first
//   https://www2.census.gov/topics/genealogy/1990surnames/dist.female.first
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const SURNAMES = 'https://www2.census.gov/topics/genealogy/2010surnames/Names_2010Census_Top1000.xlsx';
const FIRST = ['https://www2.census.gov/topics/genealogy/1990surnames/dist.male.first', 'https://www2.census.gov/topics/genealogy/1990surnames/dist.female.first'];
const TOP_FIRST = 1000; // per list

// One file out of a zip (an .xlsx is a zip), without a dependency.
function unzipEntry(buf, name) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    let p = buf.readUInt32LE(i + 16);
    const n = buf.readUInt16LE(i + 10);
    for (let k = 0; k < n; k++) {
      const method = buf.readUInt16LE(p + 10);
      const size = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extra = buf.readUInt16LE(p + 30);
      const comment = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      const entry = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (entry === name) {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + size);
        return method === 8 ? inflateRawSync(data).toString('utf8') : data.toString('utf8');
      }
      p += 46 + nameLen + extra + comment;
    }
  }
  throw new Error(`${name} not found`);
}

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const xml = unzipEntry(await get(SURNAMES), 'xl/sharedStrings.xml');
const surnames = [...xml.matchAll(/<t[^>]*>([^<]+)<\/t>/g)].map((m) => m[1].trim()).filter((s) => /^[A-Z][A-Z' -]+$/.test(s)).map((s) => s.toLowerCase());
const given = [];
for (const url of FIRST) {
  const lines = (await get(url)).toString('utf8').split('\n').filter(Boolean).slice(0, TOP_FIRST);
  for (const l of lines) given.push(l.trim().split(/\s+/)[0].toLowerCase());
}
const out = {
  note: 'The most common US surnames (Census 2010, top 1,000) and first names (Census 1990, top 1,000 of each list), lower case. Used only to refuse a watch phrase made only of common names. Never rendered.',
  sources: [SURNAMES, ...FIRST],
  built: new Date().toISOString().slice(0, 10),
  surnames: [...new Set(surnames)].sort(),
  given: [...new Set(given)].sort(),
};
writeFileSync(new URL('../data/common-names.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log(`surnames ${out.surnames.length}, first names ${out.given.length}`);
