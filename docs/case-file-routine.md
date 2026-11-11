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
  one with the question as its title to ask for a case file. The routine
  also finds topics itself (Jason, 2026-11-11: "The routine should identify
  when a new casefile needs to be created"), from what it can read in public:
  - shared research (`/api/research`, on since 2026-11-11): sources people
    shared, grouped by topic;
  - source requests (`/api/requests`): sources people asked Siren to learn;
  - public questions (`/questions`, once the free tier is on);
  - Council's coming agendas (`upcoming_meetings`) and recent legislation
    (`find_legislation`): a decision of citywide weight (a major project, a
    large appropriation or agreement, a rezoning of a large site) with no
    case file;
  - the City's announcements (`city_news`) and the news sections Siren may
    search (WHRO's local government reporting).
  A topic qualifies when two of those point at it, or when Council is due
  to decide it within 60 days. It never reads private conversations; it has
  no way to.

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
- No people-finding. A name quoted in a news article may be quoted,
  attributed to the outlet (Jason, 2026-11-11: "If a name is quoted in a
  news article it's public info and OK to quote. News orgs have vetting and
  fact checking liabilities that we can gate on."). Anywhere else (City
  pages, hearing packets, staff reports, legislation), never name a private
  person: applicants, owners, tenants who are individuals. Public officials
  by role. Businesses that are parties to public agreements may be named.
  Never build a finding around a person.
- **Vetting pages for Siren's web search** (Jason, 2026-11-11: "Have the
  routine vet them"). When the research relies on a City project page
  (`www.norfolk.gov/<id>/<Page-Name>`) or a news outlet's section that Siren
  can't search yet, the routine vets it and proposes it in the same draft
  PR, in `deployments/siren.config.js` `webSearch.allowedDomains`, with a
  dated comment saying what it read and what the probe returned:
  - a City page: read it; it must name no private person (officials by role
    are fine); list it as `www.norfolk.gov/<id>/<Page-Name>`, never a bare
    id or a parent path;
  - a news section: a web search limited to the section for arrests,
    charges, shootings and missing people must return nothing; list it by
    its section path, never the whole site, and add it to `newsDomains`.
  Jason merging the PR is what widens the list.
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
2. Read in full: CLAUDE.md, CONTRIBUTING.md, data/cases/README.md and docs/case-file-routine.md. Their rules bind you, above all: never add a finding from a source you haven't opened yourself in this session; every finding quotes its source exactly and claims no more than the quote; a name quoted in a news article may be quoted, attributed to the outlet, but never name a private person from any other source; never cite a Socrata API or dataset URL.
3. If you have no GitHub tools for pull requests and issues, stop and report that; change nothing.

Choose ONE piece of work
4. List open pull requests. Skip any case file that an open PR already changes.
5. Read every data/cases/*.json. If a `pending` item names something due that may have happened by now (a Council vote, a hearing, an agreement, a report), take that case file as an update.
6. Otherwise, list open issues labeled `case-file`; take the oldest whose question no case file covers, as a new case file.
7. Otherwise, look for a topic that needs a new case file (docs/case-file-routine.md, "New case files"): read https://ask-siren.jason-edelman.org/api/research (shared sources) and /api/requests, run `node bin/socrata-agent.js tool upcoming_meetings '{"days":60}' --config deployments/siren.config.js` and `tool city_news '{}'`, and skim WHRO's local government reporting (whro.org/local-government). A topic qualifies when two of those point at it, or when Council is due to decide it within 60 days and no case file covers it. Take the strongest one, as a new case file, and say in the PR which signals pointed at it.
8. Otherwise, take the case file whose top-level `reviewed` date is oldest (missing counts as oldest), as an update.
If nothing qualifies, report that in one line and stop.

Research
9. Use primary sources first: the City's own pages and PDFs (norfolk.gov, its DocumentCenter, budget and Capital Improvement Plan documents), Council legislation on norfolkcityva.iqm2.com (`node bin/socrata-agent.js tool find_legislation '{"text":"..."}'` searches data/norfolk-legislation.json, refreshed weekly; `tool upcoming_meetings '{}'` lists coming agendas; for anything newer, open the portal's meeting and agenda pages), and state code (law.lis.virginia.gov). News reports (WHRO, WAVY, WTKR, 13NewsNow, Virginia Business, the Virginian-Pilot) are acceptable, attributed to the outlet with the date, for what the City has said or done that the records don't show yet; names they quote may be quoted. Open every page you cite. To see the text the verifier will read, fetch it the way scripts/verify-cases.js does (its `textOf`).
10. For an update: look for what changed since the file's `reviewed` date; resolve `pending` items where an official record now settles them; correct anything a newer source contradicts (add the newer finding; don't delete a verified older one unless its source is gone, and say why in the PR).

Write
11. A finding: `id`, `stance` (confirms, weakens, context, who_decides, rules), `claim`, `source {title, url}`, an exact `quote`, and `found_by`: "Claude Code routine (Siren: compile and update case files), run by Jason Edelman". Keep a new file to about 20 findings. Give what weakens the case alongside what confirms it. Set the top-level `reviewed` to today. Rewrite `summary` to say what the records show as of today, with dates; keep `pending` to what is still unconfirmed or unread. Add `records_to_request` a resident could send under the Virginia FOIA. A new file follows the existing files' shape (id, title as the question, summary, steward "Jason Edelman (Siren operator)", license "CC-BY-4.0", reviewed, findings, what_would_help, records_to_request, pending) and goes in CASES in plugins/case-file.js.
12. Run, and make all pass:
   - `npm run verify:cases -- --write` must end "All quotes found." Fix or drop a finding that fails; never edit a quote to match. Then `git restore` the other case files the verifier re-stamped, so the PR changes only your file (and plugins/case-file.js for a new one).
   - `npm test`
   - `node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null`
   - `node bin/socrata-agent.js tool case_file '{"topic":"<id>"}' --config deployments/siren.config.js` must print the record.
13. Try to break your own work: have a fresh-context subagent check every new or changed finding against its source (does the quote say what the claim says, is it out of context, is the source official and current, does any text name a private person outside a news quote). Fix or drop what fails. This is a same-operator check, not an independent review; say so in the PR.
   If the research relied on a City project page or a news section Siren can't search yet, vet it as docs/case-file-routine.md says ("Vetting pages for Siren's web search") and add it to deployments/siren.config.js in the same PR, with a dated comment of what you read and what the probe returned; `npm test` must still pass.

Open the PR
14. Commit on a new branch `case-file/<case id>-<YYYY-MM-DD>`. Don't change git user.name or user.email, and don't put model names in commits or the PR. Push it.
15. Open a DRAFT PR to main. Body: what changed and why (the issue or pending item it answers, "Closes #N" for a case-file issue), a table of every new or changed finding (id, stance, source, date opened), the verifier's last line, test results, and the self-check note. State plainly that a Claude Code routine did the work and that it needs Jason's review. End the body with:

    🤖 Generated with [Claude Code](https://claude.com/claude-code)

Never
- Merge, approve, or close anything (a PR's "Closes #N" is for Jason's merge).
- Change worker/, src/socrata.js, the city profiles' policies, secrets, deploy settings, or any case file besides the one you chose. In deployments/siren.config.js, only add vetted allowedDomains/newsDomains entries as above; never remove or widen one.
- Write an @mention, or comment on issues other than to link your PR once.
- Do more than one case file.

Finish with a short report: which case file, what changed, the PR link, or why you stopped.
```
