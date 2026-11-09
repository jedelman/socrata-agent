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
  whatever a deployment's purpose. The one list of people Siren shows is the
  public endorser list on each source request's page: accounts that
  published a public endorsement of that public request, on that request's
  page only, with no search, sort or filter by person and no "what did this
  account endorse" view (docs/bluesky-endorsements.md). Don't add one.
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
(`src/cities/norfolk.js`). A PR that edits any of them, `src/gaps/` or a
proposal module reruns

```bash
node scripts/build-gaps.js --offline
node scripts/build-gaps-proposed.js --offline
npm run check:gaps && node scripts/build-gaps-proposed.js --check
```

and commits `data/gaps`, `docs/gaps-norfolk.md`, `docs/gaps-budget-proposed.md`
and `docs/gaps-inventory.md` with the change. The CI job `check-gaps` fails
until it does. It runs outside `npm test`, which gates the Workers Builds
deploy and only skips its replay test, naming the fix, when the gap file
trails its inputs. When two branches touch those inputs, whichever merges
second reruns it before merging. A change to a measure needs a live build
(`node scripts/build-gaps.js`, read-only against the portal).

### The gap refresh is automated

Jason decided on 2026-11-09: "yes, we should automate the gap refresh." Three
workflows keep the gap files current (`docs/gaps.md` §5.4):

- `refresh-gaps.yml`, Tuesdays 10:23 UTC: `verify-cases` read-only, then live
  `build-gaps` and `build-gaps-proposed`, `npm test` and both `--check` runs,
  then `scripts/gap-refresh.js`. The build reads each finding's verification
  from the case files, so the `verify-cases` result is only reported in the
  summary.
- `refresh-norfolk.yml`, Mondays: when the legislation index changed, both
  `--offline` rebuilds and their checks, then `gap-refresh`. The index and the
  gap files land together, on main or on one branch with a PR. If the gap
  rebuild fails, the index commits alone and the run fails, with the reason
  in its summary: rerun the two offline builds above and commit them.
- `archive-case-sources.yml`, monthly: when case files changed, both
  `--offline` rebuilds join the case-file PR, with `gap-refresh`'s summary in
  its body. A failed rebuild leaves them out, and the body says so.

The two refresh jobs share one `concurrency:` group, so they never run at once.

`gap-refresh` compares the gap files before and after (the catalog's built
file and each proposal set's built records) and decides:

- **Commit to main** when only measured numbers moved, each within ±25% of the
  number before (25% exactly is within), and dates.
- **Open a PR** for anything else: a state change, a gap moving on or off the
  board, an id added or removed, a measured number beyond ±25% (zero to
  nonzero, or any number to zero, included), a failed measure (on the board
  with its last good measurement, or off it), evidence turning unverified (a
  gap off the board for want of it, or a finding gone from a gap's evidence),
  any other change in `how_much`, code-written text that changed beyond its
  numbers and dates, or a change to a gap's catalog fields or the file's own.
- **No commit** when nothing changed.

The measured numbers are listed in `MEASURED_NUMBERS` in `scripts/gap-refresh.js`
(`part`, `whole`, the series, window, by-status and all-time counts, columns read
per dataset, the backlog counts and median age, problem-code counts, catalog
result counts, the count of values read); a test holds every integer in the
schema's `how_much` to that list or to `NOT_MEASURED` (`policy.line`, compared
exactly). Dates are every `read`, `window.from`, `published.rows_updated`,
`backlog.median_created`, `measured`, `last_good` and the span's ends.

#### Handling a gap-refresh pull request

The branch is `bot/gap-refresh-<date>` (weekly) or `bot/legislation-refresh-<date>`
(index and gap files together). The body is the summary: "Why it needs review"
lists each reason with its gap and rule, then each file shows what moved per
gap, then the `verify-cases` signal. Check the reasons against the portal
(each gap's evidence carries its query URL), then:

- **A jump beyond ±25%**: if the records really moved, merge. If the portal
  published a partial table, close the PR; next week re-measures.
- **A state change**: `closing` means a re-measure met the gap's closing test;
  a steward confirms before it closes (`docs/gaps.md` §12). Merge once checked.
- **A failed measure**: the portal was down, a column changed, or the text
  failed its checks; the build output in the run's log names it. On the board
  the gap keeps its last good measurement with a notice. Fix the measure in
  `src/gaps/` (a catalog change, for Jason's review) or merge to show the
  notice; a measure that keeps failing opens a PR every week until it's fixed.
- **Evidence unverified**: a cited finding is marked unverified, or its last
  check is more than 30 days old. Usually the monthly archive PR, which renews
  the checks, is waiting: merge it, and the next refresh brings the gap back.
  Otherwise fix the finding by case-file PR.
- **An id, catalog field, wording, shape or file change**: these come from a
  code or catalog change, or a source whose own description changed. Review
  them like a catalog change.
- **`verify-cases` failed**: a finding's quote wasn't found. Fix the finding,
  or mark it unverified, by case-file PR.

A newer refresh PR rebuilds from main, so it supersedes an older one: close
the older. Don't edit the generated files on a bot branch; rerun the builds.
Pushes and PRs made with the workflow's token start no other workflow, CI
included, so the refresh jobs run the same checks before they commit. Opening
a PR needs the repository setting "Allow GitHub Actions to create and approve
pull requests"; without it the branch is pushed and the run fails, naming it.

To see the decision locally (read-only against the portal for a live build):

```bash
node scripts/gap-refresh.js snapshot /tmp/gaps-before
node scripts/build-gaps.js --offline        # or node scripts/build-gaps.js
node scripts/build-gaps-proposed.js --offline
node scripts/gap-refresh.js decide --before /tmp/gaps-before
```

### The gap inventory

`data/gaps/inventory.json` (schema-checked) and `docs/gaps-inventory.md` list
every gap Siren knows of and its state: the approved catalog's entries (open,
closing, closed, on the board with a last measurement, or off it with the
reason), the proposed entries awaiting Jason's approval (kept apart, never on
the board), retired ids and what is not a gap, with counts by state and topic
and what changed since the build before the last state change. Code builds it
from the committed gap files (`scripts/gaps-inventory.js`); never edit it by
hand. Both `build-gaps.js` and `build-gaps-proposed.js` rewrite it after a
live or offline build, and both fail `--check` when it trails those files, so
the refresh workflows above keep it current, and a PR that changes the inputs
runs both offline builds as shown above.

`scripts/find-gaps.js` records no committed candidate count, so the inventory
carries none.
