# Contributing

Thanks for building on this. Forks can do anything; this file is about what
comes back into the shared project, and what the shared web app runs.

## What upstream takes

- **City profiles and fixes**, with every dataset id, field name and status code
  checked against the live portal and the date noted.
- **Plugins** that pass `test/conformance.js` (`checkPlugin` on fakes, and
  `checkPluginFile` on the source) and come with an offline test. Conformance
  catches mistakes, not malice: a plugin runs with the agent's privileges, so
  review is the real gate. Plugins read Socrata only through `ctx.socrata`
  (`ctx.http` refuses Socrata hosts and paths) and import nothing from `src/`
  but `plugins.js` and `soqlString`.
- **Adapters** for meeting systems (a Legistar adapter would unlock "who
  decided" for many cities).
- Bug fixes with a test that fails before the fix.

- **Findings for a case file** (`data/cases/`), from anyone: a civic league,
  Keep Norfolk Beautiful, a City department, a researcher. A finding is one
  claim, the source URL, the exact quote that supports it, a stance
  (`confirms`, `weakens`, `context`, `who_decides`, or `rules` for what an ordinance or regulation says), and `found_by` (your
  name or organization). Findings that weaken a case are as welcome as ones
  that confirm it; the record is shared, not a brief. Run
  `npm run verify:cases -- --write`: a finding whose quote isn't on the page
  doesn't ship. The steward reviews wording and stance. A records request the
  City answers is a new source: add what it shows.

## What upstream won't take

- **Anything that finds people.** No tools that search or profile individuals by
  name: no voter files, no warrant or arrest lookups, no "who lives here."
  Warrants and arrests stay excluded. This is the one line that doesn't move,
  whatever a deployment's purpose.
- **Persuasion inside the answer.** The answer reports what the records show. A
  group's own framing belongs in its deployment notes or its own UI, labeled as
  its own, never mixed into the record.
- **Weakening the contract.** Changes that let model output become the trace,
  loosen the voice check to make an answer pass, or hand plugins a raw `fetch`.
- Contacts nobody can source. Every contact comes from a dataset or a page
  verified on a stated date.

## Before you open a PR

```bash
npm test
node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null
```

Model comparisons (`scripts/compare-models.js`) cost real money. Keep them small,
and commit the output to `eval/`.

### The gap file and its inputs

`data/gaps/norfolk.json` is built from stored portal responses plus repo files:
the case files (`data/cases/*.json`), the legislation index
(`data/norfolk-legislation.json`) and the Norfolk profile
(`src/cities/norfolk.js`). A PR that edits any of them, or `src/gaps/`, reruns

```bash
node scripts/build-gaps.js --offline
npm run check:gaps
```

and commits `data/gaps` and `docs/gaps-norfolk.md` with the change. When two
branches touch those inputs, whichever merges second reruns it before merging.
CI's `check-gaps` job fails until it's done; `npm test`, which gates the
deploy, only skips that check.
