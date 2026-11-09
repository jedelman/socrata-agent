// The repo as the gap tests read it: the real files, except the case files,
// which come from a pinned copy (test/fixtures/gaps-cases/, copied from
// data/cases on 2026-11-07). A steward marking a cited finding unverified,
// or a case file moving on, is a normal state of the repo (docs/gaps.md
// §5.3.9) and must not fail npm test, which gates the deploy. Refresh the
// copy by hand when a test needs newer case files.
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
export const readRepo = (p) => readFileSync(new URL(p, root), 'utf8');

export function pinnedRepo(p) {
  const m = /^data\/cases\/([a-z0-9-]+\.json)$/.exec(p);
  return m ? readFileSync(new URL(`./gaps-cases/${m[1]}`, import.meta.url), 'utf8') : readRepo(p);
}

/** The pinned case files by id, as src/gaps/cases.js bundles the real ones. */
export const PINNED_CASES = Object.freeze({ 'norfolk-trees': JSON.parse(pinnedRepo('data/cases/norfolk-trees.json')) });

/**
 * The Norfolk gap file replayed from its stored responses against the
 * pinned case files, dated the day of the stored build: all 13 gaps on the
 * board, whatever state the committed file is in.
 */
export async function replayedGaps() {
  const { buildGaps, Recorder } = await import('../../scripts/build-gaps.js');
  const trace = JSON.parse(readRepo('data/gaps/norfolk.trace.json'));
  return (await buildGaps({ recorder: new Recorder({ responses: trace.responses }), today: trace.built, repo: pinnedRepo })).file;
}
