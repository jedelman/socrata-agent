// The repo as the gap tests read it: the real files, except the case files,
// which come from a pinned copy (test/fixtures/gaps-cases/, copied from
// data/cases on 2026-11-07). A steward marking a cited finding unverified,
// or a case file moving on, is a normal state of the repo (docs/gaps.md
// §5.3.9) and must not fail npm test, which gates the deploy. Refresh the
// copy by hand when a test needs newer case files.
import { readFileSync } from 'node:fs';
import { STALE_DAYS } from '../../scripts/verify-cases.js';

const root = new URL('../../', import.meta.url);
export const readRepo = (p) => readFileSync(new URL(p, root), 'utf8');

export function pinnedRepo(p) {
  const m = /^data\/cases\/([a-z0-9-]+\.json)$/.exec(p);
  return m ? readFileSync(new URL(`./gaps-cases/${m[1]}`, import.meta.url), 'utf8') : readRepo(p);
}

/** The pinned case files by id, as src/gaps/cases.js bundles the real ones. */
export const PINNED_CASES = Object.freeze({ 'norfolk-trees': JSON.parse(pinnedRepo('data/cases/norfolk-trees.json')) });

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The last day every verified finding in the pinned case files is fresh (checked within STALE_DAYS). */
export const PINNED_FRESH_THROUGH = addDays(
  Object.values(PINNED_CASES)
    .flatMap((c) => c.findings.filter((f) => !f.unverified && f.checked).map((f) => f.checked))
    .sort()[0],
  STALE_DAYS
);

/**
 * The day a replay computes its repo-file parts as of (buildGaps' repoToday):
 * the stored build's own day while the pinned case files are fresh on it, and
 * after that the last day they are. The weekly live refresh
 * (refresh-gaps.yml) moves the stored build's day on and the pinned copy
 * stays put, so a replay dated past its freshness would take every
 * finding-backed gap off the board in tests that aren't about staleness.
 */
export const pinnedRepoToday = (built) => (built <= PINNED_FRESH_THROUGH ? built : PINNED_FRESH_THROUGH);

/**
 * The Norfolk gap file replayed from its stored responses against the
 * pinned case files: live measures dated the day of the stored build, repo
 * parts as of pinnedRepoToday. All 13 gaps on the board, whatever state the
 * committed file is in.
 */
export async function replayedGaps() {
  const { buildGaps, Recorder } = await import('../../scripts/build-gaps.js');
  const trace = JSON.parse(readRepo('data/gaps/norfolk.trace.json'));
  return (await buildGaps({ recorder: new Recorder({ responses: trace.responses }), today: trace.built, repoToday: pinnedRepoToday(trace.built), repo: pinnedRepo })).file;
}
