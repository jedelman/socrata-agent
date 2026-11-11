// Case files added since the snapshots were taken. A new case file joins
// case_file's description and topic enum and the /api/cases list, so the
// snapshot scenarios (web-search-off, public-ask-off) leave the added ones
// out: the comparison still covers everything else, and adding a case file,
// which the case-file routine does on its own (docs/case-file-routine.md),
// never needs a snapshot retaken. Leave this list as it is: it names the
// case files the snapshots were taken with.
import { CASES } from '../../plugins/case-file.js';

export const CASES_AT_SNAPSHOT = Object.freeze(['norfolk-trees', 'norfolk-litter', 'norfolk-zoning-restaurant-ghent']);

const added = () => Object.values(CASES).filter((c) => !CASES_AT_SNAPSHOT.includes(c.id));

// case_file's description lists each topic as `"<id>" (<title>)`, joined by "; ".
export const stripAddedCases = (s) =>
  added().reduce((t, c) => {
    const entry = `"${c.id}" (${c.title})`;
    return t.split(`; ${entry}`).join('').split(`${entry}; `).join('');
  }, s);

// For a JSON.stringify replacer: the topic enum without the added ids.
export const enumAtSnapshot = (v) => (Array.isArray(v) ? v.filter((x) => !added().some((c) => c.id === x)) : v);

// GET /api/cases as it read at the snapshot (the Worker sends JSON.stringify
// of { cases }, so filtering and stringifying again gives the same bytes).
export function casesListAtSnapshot(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return text;
  }
  if (!Array.isArray(doc?.cases)) return text;
  return JSON.stringify({ ...doc, cases: doc.cases.filter((c) => CASES_AT_SNAPSHOT.includes(c.id)) });
}
