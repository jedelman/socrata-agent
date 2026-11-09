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

**The gap build is run by hand** until Jason decides whether to automate it.
No workflow runs it or checks it: rerun `build-gaps --offline` yourself after
the weekly legislation refresh commits a new index, after the monthly archive
PR changes case files, and after any edit to the inputs above. `npm test`,
which gates the deploy, never fails because the committed gap file trails its
inputs: its replay test only skips, naming the fix. Review what the rebuild
changed before committing it, and treat a gap that moves on or off the board,
or changes state, as a change for review (`docs/gaps.md` §5.4):

```bash
cp data/gaps/norfolk.json /tmp/gaps-before.json
node scripts/build-gaps.js --offline
node scripts/build-gaps.js --same-states /tmp/gaps-before.json
```

A live build (`node scripts/build-gaps.js`, read-only against the portal) is
also by hand, and so are the spec's weekly re-measure and its PR rules.

### The gap inventory

`data/gaps/inventory.json` (schema-checked) and `docs/gaps-inventory.md` list
every gap Siren knows of and its state: the approved catalog's entries (open,
closing, closed, on the board with a last measurement, or off it with the
reason), the proposed entries awaiting Jason's approval (kept apart, never on
the board), retired ids and what is not a gap, with counts by state and topic
and what changed since the build before the last state change. Code builds it
from the committed gap files (`scripts/gaps-inventory.js`); never edit it by
hand. Both `build-gaps.js` and `build-gaps-proposed.js` rewrite it after a
live or offline build, and both fail `--check` when it trails those files. So
after the inputs above change, run both offline builds:

```bash
node scripts/build-gaps.js --offline
node scripts/build-gaps-proposed.js --offline
node scripts/build-gaps.js --check && node scripts/build-gaps-proposed.js --check
```

`scripts/find-gaps.js` records no committed candidate count, so the inventory
carries none.

**Proposed automation, for Jason to decide** (drafted on the gaps branch and
taken out of it, since the brief allowed only read-only weekly steps):

1. A `check-gaps` job in `ci.yml`, outside `npm test`, running
   `npm run check:gaps` on every push and PR. It fails when the committed gap
   file trails its inputs, without stopping the Workers Builds deploy.
2. In `refresh-norfolk.yml`, after the index build and only when the index
   changed: `build-gaps --offline` and `build-gaps-proposed --offline` (which
   also rebuild the gap inventory), then `--same-states` against the file
   before it. With no state change, the gap file commits with the index.
   Otherwise the rebuild is set aside and opened as a PR (the workflow would
   need `pull-requests: write`). A failed rebuild never stops the index commit.
3. In `archive-case-sources.yml`, when case files changed: `build-gaps
   --offline` and `build-gaps-proposed --offline`, with `data/gaps`,
   `docs/gaps-norfolk.md`, `docs/gaps-budget-proposed.md` and
   `docs/gaps-inventory.md` added to the archive PR, so the gap file's finding evidence changes beside its sources.
4. The spec's weekly live re-measure (`refresh-gaps.yml`, `docs/gaps.md`
   §5.4): numbers within ±25% to main, anything else to a PR. Not drafted.
