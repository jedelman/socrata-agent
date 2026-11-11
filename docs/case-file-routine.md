# The case-file routine

Case files (`data/cases/`) are research done once and served to every
question. Jason, 2026-11-11: "we should have a routine that compiles and
updates these." A scheduled Claude Code task, "Siren: compile and update case
files", runs twice a week (Mondays and Thursdays, 04:23 America/New_York) in a
fresh session. Each run does at most one piece of work and opens at most one
draft pull request. Jason reviews and merges; the routine never merges.

The prompt lives in the scheduled task, not here, so this file keeps a copy of
it (below): change both together.

## What it works from

- **Updates.** Each case file's `pending` list is its to-do list: things
  reported but not yet confirmed in an official record, sources not yet read,
  and questions still open. A top-level `reviewed` date records when the
  routine (or a person) last looked for new developments; a file without one
  counts as never reviewed. The routine takes the case file reviewed longest
  ago, looks for what has changed since (Council legislation, the City's own
  pages and documents, news), and adds or corrects findings, moves settled
  `pending` items into findings, and rewrites the `summary` so it says what is
  true as of the review, with dates.
- **New case files.** Open issues labeled `case-file` are Jason's queue: file
  one with the question as its title to ask for a case file. When Siren's
  public answers and shared research are on (`docs/free-tier.md`,
  `docs/research-memory.md`), topics asked about more than once with no case
  file count as demand too. It never reads private conversations; it has no
  way to.

Updates come before new files only when a `pending` item names something due
(a vote, a hearing, a report) that may have happened; otherwise the oldest
`case-file` issue comes first, then the stalest review.

## The rules it keeps

Everything in CONTRIBUTING.md and `data/cases/README.md`, and:

- Never add a finding from a source it hasn't opened in this session. Every
  finding quotes its source exactly and claims no more than the quote.
- Sources are documents people can read: the City's pages and PDFs, Council
  legislation pages, state code, news reports. Never a Socrata API or dataset
  URL (`data.norfolk.gov/resource/...`): case files reach the hand-off
  through the plugin context, which refuses Socrata hosts and paths, and
  `test/plugins.test.js` fails on one. For capital-plan numbers, cite the
  adopted Capital Improvement Plan PDF.
- No people-finding. Never name a private person (residents quoted in news,
  applicants, tenants who are individuals). Public officials only in their
  official role, and only when the quote needs it. Businesses that are
  parties to public agreements may be named.
- Stances answer the case file's question: for a "what's the plan" file,
  `confirms` is evidence the plan is set or moving, `weakens` is evidence it
  is unsettled, delayed or contested.
- The snapshot tests ignore case files added after them
  (`test/fixtures/cases-at-snapshot.js`), so a new file needs no snapshot
  work. A new file still goes in `CASES` in `plugins/case-file.js`.

## The prompt (copy)

```text
Twice-weekly job for Jason Edelman's civic agent Siren (repo jedelman/socrata-agent): compile a new case file or update an existing one, and open ONE draft pull request. Jason reviews and merges; you never merge, approve or deploy.

Setup
1. If jedelman/socrata-agent isn't in this session, add it with the add_repo tool (owner jedelman, repo socrata-agent, access "push"). Clone it, check out main, run `npm ci`.
2. Read in full: CLAUDE.md, CONTRIBUTING.md, data/cases/README.md and docs/case-file-routine.md. Their rules bind you, above all: never add a finding from a source you haven't opened yourself in this session; every finding quotes its source exactly and claims no more than the quote; never name a private person; never cite a Socrata API or dataset URL.
3. If you have no GitHub tools for pull requests and issues, stop and report that; change nothing.

Choose ONE piece of work
4. List open pull requests. Skip any case file that an open PR already changes.
5. Read every data/cases/*.json. If a `pending` item names something due that may have happened by now (a Council vote, a hearing, an agreement, a report), take that case file as an update.
6. Otherwise, list open issues labeled `case-file`; take the oldest whose question no case file covers, as a new case file.
7. Otherwise, take the case file whose top-level `reviewed` date is oldest (missing counts as oldest), as an update.
If nothing qualifies, report that in one line and stop.

Research
8. Use primary sources first: the City's own pages and PDFs (norfolk.gov, its DocumentCenter, budget and Capital Improvement Plan documents), Council legislation on norfolkcityva.iqm2.com (`node bin/socrata-agent.js tool find_legislation '{"text":"..."}'` searches data/norfolk-legislation.json, refreshed weekly; `tool upcoming_meetings '{}'` lists coming agendas; for anything newer, open the portal's meeting and agenda pages), and state code (law.lis.virginia.gov). News reports (WHRO, WAVY, WTKR, 13NewsNow, Virginia Business) are acceptable, attributed to the outlet, for what the City has said in interviews. Open every page you cite. To see the text the verifier will read, fetch it the way scripts/verify-cases.js does (its `textOf`).
9. For an update: look for what changed since the file's `reviewed` date; resolve `pending` items where an official record now settles them; correct anything a newer source contradicts (add the newer finding; don't delete a verified older one unless its source is gone, and say why in the PR).

Write
10. A finding: `id`, `stance` (confirms, weakens, context, who_decides, rules), `claim`, `source {title, url}`, an exact `quote`, and `found_by`: "Claude Code routine (Siren: compile and update case files), run by Jason Edelman". Keep a new file to about 20 findings. Give what weakens the case alongside what confirms it. Set the top-level `reviewed` to today. Rewrite `summary` to say what the records show as of today, with dates; keep `pending` to what is still unconfirmed or unread. Add `records_to_request` a resident could send under the Virginia FOIA. A new file follows the existing files' shape (id, title as the question, summary, steward "Jason Edelman (Siren operator)", license "CC-BY-4.0", reviewed, findings, what_would_help, records_to_request, pending) and goes in CASES in plugins/case-file.js.
11. Run, and make all pass:
   - `npm run verify:cases -- --write` must end "All quotes found." Fix or drop a finding that fails; never edit a quote to match. Then `git restore` the other case files the verifier re-stamped, so the PR changes only your file (and plugins/case-file.js for a new one).
   - `npm test`
   - `node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null`
   - `node bin/socrata-agent.js tool case_file '{"topic":"<id>"}' --config deployments/siren.config.js` must print the record.
12. Try to break your own work: have a fresh-context subagent check every new or changed finding against its source (does the quote say what the claim says, is it out of context, is the source official and current, does any text name a private person). Fix or drop what fails. This is a same-operator check, not an independent review; say so in the PR.

Open the PR
13. Commit on a new branch `case-file/<case id>-<YYYY-MM-DD>`. Don't change git user.name or user.email, and don't put model names in commits or the PR. Push it.
14. Open a DRAFT PR to main. Body: what changed and why (the issue or pending item it answers, "Closes #N" for a case-file issue), a table of every new or changed finding (id, stance, source, date opened), the verifier's last line, test results, and the self-check note. State plainly that a Claude Code routine did the work and that it needs Jason's review. End the body with:

    🤖 Generated with [Claude Code](https://claude.com/claude-code)

Never
- Merge, approve, or close anything (a PR's "Closes #N" is for Jason's merge).
- Change worker/, src/socrata.js, the city profiles' policies, deployments' allowedDomains, secrets, deploy settings, or any case file besides the one you chose.
- Write an @mention, or comment on issues other than to link your PR once.
- Do more than one case file.

Finish with a short report: which case file, what changed, the PR link, or why you stopped.
```
