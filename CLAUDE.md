# CLAUDE.md — socrata-agent

Civic tech: an agent that answers "what's on my block, and who decided it?"
from a city's Socrata open data portal and public meeting records. Norfolk, VA
is the full implementation; Seattle, Chicago, and any Socrata domain run in
generic mode.

## Non-negotiables

- **Voice contract.** The agent says "I found" / "I see", never "there is" /
  "there are" / "nobody" / "no one". `src/voice.js` enforces it; don't weaken
  the check to make an answer pass.
- **The trace is written by code.** Every outbound request goes through
  `Trace.record` (`src/trace.js`). Never let model output become the trace.
- **Hand-off.** Every dataset touched is registered in `Resources` with page,
  the exact-query CSV, API docs, and the full CSV only when no policy applies
  (restricted, withheld columns or suppressed rows drop it). Contacts come from
  the address dataset or from city pages verified on a stated date. Never
  invent a contact.
- **No people-finding.** Enforced in code by `src/socrata.js` access levels
  (generic for the open-ended tools, plugin, core) and each city profile's
  policy: `excluded` (never queried), `restricted` (plugins and core only, no
  full-table CSV), `deniedColumns` (no select, filter, group, sort or SEARCH
  outside core; `SELECT *` and `DISTINCT *` skip them; `PERSON_COLUMNS` adds
  person-named columns in every dataset; a result carrying one is refused)
  and `suppressedRows` (dropped in a first stage Siren writes, NULL-safe).
  The SoQL scanner refuses double quotes, comments, pipes and set operators;
  filtered views are refused below core; profiles are deep-frozen and Socrata
  snapshots the policy. Don't add tools that search people by name, in core
  or in plugins, and don't pass `access: 'core'` from anything a model or
  plugin controls. See CONTRIBUTING.md and docs/capabilities-norfolk.md.
- **Request budget.** Every fetch on an answer goes through its one counting
  fetch (`src/request-budget.js`, `SUBREQUEST_BUDGET`, default 120 on Workers Paid;
  45 if ever on Free's 50); don't give a tool, plugin or provider a fetch that skips it.
- **Verify against the live portal.** Dataset ids, field names and status codes
  in a city profile must be checked live, with the date noted in a comment.

## Layout

- `src/` runs unchanged in Node and Cloudflare Workers. One runtime
  dependency, by Jason's choice (2026-11-02): the official `@anthropic-ai/sdk`,
  used only by `providers/anthropic.js`. Add no others without asking.
  - `agent.js` is the provider-neutral tool loop; `providers/anthropic.js`
    serves `claude-*` models through the Messages API (pinned to
    api.anthropic.com; prices in its `PRICES` table; a model with no price is
    refused) and `providers/openrouter.js` serves everything else; `tools.js` holds tool schemas and
    executors; `block.js` is the block report and legislation matching;
    `socrata.js` is the SODA client; `adapters/iqm2.js` parses Norfolk's
    meeting portal; `cities/` holds the profiles.
- `src/plugins.js` defines plugin tools and deployment configs. Plugins get a
  traced context (`ctx.socrata`, `ctx.http`, `ctx.lookupAddress`), never a raw
  fetch; `test/conformance.js` enforces it. Configs can add but not remove
  exclusions.
- `plugins/` holds plugin tools; `deployments/` holds configs (the sponge-city
  example is the reference).
- `worker/access.js` verifies Cloudflare Access JWTs for per-person limits.
  Never trust the plain email header.
- `bin/socrata-agent.js` is the CLI (`ask` with your own key; `tool` with no key).
- `worker/` is the Cloudflare chat app (`index.js` plus `ui.html`).
  `invites.js` holds invite codes and the waitlist; `accounts.js` holds email
  sign-in by magic link (Resend), which binds an invite to an account;
  `conversations.js` holds each account's conversations (KV, 7 days), whose
  earlier tool results come back as data for follow-ups. Each turn also keeps
  the record shown under its answer (trace, hand-off, voice check, model,
  steps, cost, suggestions; bounded by `answerRecord`), so a reopened
  conversation shows how each answer was found; the model never sees it. Conversations are
  private to their account and never feed the case files.
  `requests.js` pools source requests: when the records can't answer, the
  core `suggest_data_source` tool names the source that would, and the person
  can request it (no asker identity kept; export with
  `node scripts/invites.js requests`). The list is public behind a steward
  gate: `request-accept`/`-decline`/`-fulfilled` set status, only accepted
  and fulfilled requests appear at `<base>/requests` and `/api/requests`, and
  only notes written under the "requests are public" notice and approved by
  the steward are shown. Every note is reviewed whatever the request's
  status: new notes are stored `review: 'pending'`, and the steward approves
  or deletes each one at `<base>/admin` or with `request-note`. Legacy notes
  (no `review`) count as reviewed only when written no later than `decided`,
  that decision made the request public, and they were among the last five
  public notes (what the old list showed). Steward state lives in keys raises
  never write, laid over the record on every read: `request-decision:<hash>`
  (status, decided, was_public, steward_note, fulfilled_by, and with
  endorsements the count frozen at decision, endorsements_at_decision) and
  `request-deleted:<hash>` (deleted note ids), so a stale raise can't undo a
  decision or bring a deleted note back. Stored and public dates are days,
  never finer. `POST /api/requests` returns a count only for a request that
  is already public. `GET /api/requests` says nothing about requests or
  notes awaiting review, not even how many, never writes to KV (designed under
  Workers Free's 1,000 writes a day; the account is on Paid since 2026-11-09), and is cached per
  location for five minutes (with `BLUESKY_LOGIN` on, it goes through
  `public-list.js` instead: 60 seconds, with endorsement counts from
  Constellation on listed requests only; with the flag off its body is
  exactly the requests-only list).
  Public request ids are random (16 base32 characters, `request-id:<hash>`
  and the reverse index `request-pid:<id>`, minted at creation, never
  written by reads); requests from before that keep their legacy hex id
  until the steward runs `node scripts/invites.js request-ids --apply`, which
  keeps a public one's old id as `formerly` so the issue mirror matches its
  existing marker. A request never answers to two ids.
  A request accepted once carries `was_public`; if it leaves the list,
  `/api/requests` lists it under `withdrawn: [{id, day}]` for 30 days.
  `scripts/sync-request-issues.js` mirrors the public list to
  `source-request` issues, run nightly by a Claude Code routine
  (`--plan --with-withdrawn`; its prompt is copied in
  `docs/request-sync-routine.md`). Withdrawn entries
  (`create_if_missing: false`, `state_reason: not_planned`) appear only with
  `--plan --with-withdrawn`, which the routine passes (its prompt honors both
  fields since 2026-11-09). When applying directly it also closes any marked
  issue in neither list (only if the feed carries `withdrawn`; closing all of
  them, or more than three, needs `--close-unlisted`). GitHub keeps old titles
  and bodies; only deleting an issue by hand removes them.
  The steward reviews requests at `<base>/admin` (ADMIN_EMAILS secret).
  `docs/fulfilling-requests.md` is the contributor guide.
  Bluesky endorsements (`docs/bluesky-endorsements.md`, behind
  `BLUESKY_LOGIN`; public-first by Jason's direction, 2026-11-09): an
  endorsement is a record in the endorser's own atproto repo, written and
  deleted by the browser, which is the OAuth client (`endorse-client.js`
  with `atproto-oauth.js`, `atproto-identity.js`, `endorse-config.js` and
  `endorse-store.js`, served as module text by `index.js` under
  `<base>/assets/<hash>/`; the page itself is `requests-page.js`).
  `constellation.js` counts them through Constellation, `public-list.js`
  serves the counted list (60 s), `endorsers.js` the public endorser list
  per request with flags, `bluesky.js` the client metadata and the handle
  resolver, `admin.js` the steward API. Endorsing needs only a Bluesky
  sign-in, no invite; the paid tier's conversations stay private.
  Invariants: `ENDORSE_NSID` lives in `worker/endorse-config.js` and nowhere
  else (a test enforces it), and moving it is the documented migration; the
  subject URL is built only by `endorseSubject`, from `PUBLIC_ORIGIN`. The
  scope is `atproto` plus `repo:<ENDORSE_NSID>?action=create&action=delete`,
  never `transition:generic` without Jason, and the granted scope is checked
  (less is revoked and refused). Tokens exist only in the browser (IndexedDB
  on Siren's origin, at most 24 hours, non-extractable DPoP key, the code in
  the URL fragment); the Worker never receives one, and no route reads an
  `Authorization` or `DPoP` header from the page or sets a Bluesky cookie.
  Siren stores no endorsements and nothing about endorsers: counts and lists
  are read live from Constellation, the AppView and each endorser's PDS and
  cached briefly; nothing Bluesky goes in KV or D1. Constellation is a stated,
  untrusted dependency: shapes checked, sizes capped, every listed account
  verified on its own PDS before it's shown, and a count it can't give is
  "unavailable" or the last good one with its time, never 0. Flags (bot
  self-label, Bluesky moderation labels, young or unknown age, no profile)
  are shown, never used to exclude. Only listed requests with random ids show
  endorsements; the endorser list is per request, and no route lists or
  filters endorsements by person (no DID or handle parameter anywhere, no
  "endorsements by this account" view; a test checks the parameters every
  route reads). The steward can't remove anyone's endorsement (it's theirs);
  decisions freeze the live count, and go through without one if
  Constellation is down. The browser's PAR, token and revoke go only to
  endpoints on the issuer's origin, and record writes only to the PDS named
  in the re-resolved DID document. The requests pages carry a strict CSP
  with no inline script or style; every remote string is escaped. Never link
  a Bluesky identity to an invite, email account or conversation. `SIREN_DB`
  stays bound for the planned board but nothing reads it; migration 0003
  (unapplied) drops the old endorsement tables. With `BLUESKY_LOGIN` unset,
  nothing calls Constellation, the AppView, a PDS or D1. Never key anything
  new under `request:`. `plugins/case-file.js` serves a
  case file for questions with no address. No payments: bounties are tabled until after beta (Jason).
- `plugins/budget-for.js` (`budget_for`) and `plugins/capital-projects.js`
  (`capital_projects`) read the budget datasets registered in the Norfolk
  profile's `budget` block. Names the model gives are matched against each
  dataset's own list (a traced query) and only the City's spelling reaches
  fixed SoQL; a miss returns the closest names. Caveats are quoted from the
  live metadata or computed from the queries.
- `.claude/skills/socrata-agent/` is the Claude Code skill.
- `data/norfolk-legislation.json` is built by
  `scripts/build-norfolk-legislation.js` and refreshed weekly by an Action.
- `data/cases/*.json` are case files: research done once and served to every
  question through a plugin's `the_record` (`plugins/cases.js`). Each finding
  has a source URL and an exact quote; `npm run verify:cases` re-fetches every
  source (pdftotext for PDFs) and fails on a missing quote, and `--write`
  stamps the date and the evidence (DASL CID of the bytes read, a W3C
  TextQuoteSelector, how it was proven); `--archive` also records a Wayback
  snapshot that holds the quote, and a finding whose live page changed or
  vanished is proven against that snapshot and served "as archived".
  `.github/workflows/archive-case-sources.yml` does the archiving monthly
  and opens a PR (cloud sessions can't reach web.archive.org).
  `<base>/api/cases/<id>` serves case files as W3C Web Annotations. A
  finding without a checked quote is served only as "not yet verified". Never add a finding you haven't opened the source for.
- `data/documents/*.json` are Norfolk's ordinances (the Zoning Ordinance so
  far) and adopted budget books (the Department Budgets part, FY 2024 to
  2027) from the City's own PDFs, split into sections by `src/documents.js`.
  `plugins/ordinances.js` (`ordinance_lookup`: search, or read a section with
  its subsections, cited by section and PDF page) and `plugins/budget-books.js`
  (`budget_book_lookup`: search across fiscal years or within one, or read a
  department's section, cited by fiscal year, department, section and page)
  share `plugins/document-lookup.js`. A budget book is the adopted plan and
  its narrative, not a record of spending. `npm run ingest`
  (`scripts/ingest-document.js`, `--kind budget-book` for a budget) builds
  one from a PDF, local or fetched, recording the official URL, what the text
  is (current-through date, or fiscal year, status and how it was
  identified), and the PDF's DASL CID. Run it where the PDF is; the text is
  far smaller. A copy from anywhere but the City's site goes to the
  git-ignored `data/documents/private/` until it's cleared for republishing.
  See `data/documents/README.md`.
- **Wire new work into Siren in the same PR.** A new case file goes in `CASES`
  in `plugins/case-file.js`; a new plugin goes in `deployments/siren.config.js`
  with a prompt line saying when to use it. `test/plugins.test.js` fails if
  either is left out (Jason, 2026-11-07).
- `data/norfolk-sponge-screen.json` and `docs/sponge-screen-norfolk.md` are
  built by `scripts/build-sponge-screen.js`; the JSON keeps the full trace.
  It only ever carries public owners' names (city, NRHA, EDA).
- `src/gaps/` is the gap catalog (docs/gaps.md): what the records Siren reads
  can't show. `norfolk.js` holds the entries, `measures.js` the fixed measure
  menu (GENERIC access, the positional identifier rule: location columns only
  as `IS [NOT] NULL`), `kinds.js` the templates and text rules, `answer.js`
  gaps in answers. `scripts/build-gaps.js` writes `data/gaps/norfolk.json`
  (bundled), its trace and `norfolk-streets.json` (Address Information street
  names, used only to refuse addresses in public text); `--offline` recomputes
  the parts from repo files, `--check` replays and must match (`npm test`
  skips its replay when the files trail; the CI job `check-gaps` fails).
  The refresh is automated (Jason, 2026-11-09): `refresh-gaps.yml`
  re-measures live weekly, `refresh-norfolk.yml` and the archive job run
  both `--offline` builds with their inputs, and `scripts/gap-refresh.js`
  sends numbers within ±25% and dates to main and anything else to a pull
  request (docs/gaps.md §5.4, CONTRIBUTING.md). A PR that edits the inputs
  or `src/gaps/` still reruns both `--offline` builds itself.
  `scripts/find-gaps.js` writes gitignored candidates, never committed or
  shipped. `scripts/gaps-inventory.js` builds the running inventory
  (`data/gaps/inventory.json`, `docs/gaps-inventory.md`) from the committed
  gap files; both gap builders rewrite it and check it, and it lists
  proposals apart from the catalog without importing them. Topics: `trees`
  and `budget` (`TOPICS` in `norfolk.js`); the builder checks only the
  topics its entries name. Gaps stay off unless a deployment sets `gaps.enabled`, which waits
  on the trees branch's config fix (J25).

## Checks before pushing

```bash
npm test
node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null
```

Model comparisons (`scripts/compare-models.js`) spend real money; keep them
small and commit their output to `eval/`.
