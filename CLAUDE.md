# CLAUDE.md — socrata-agent

Civic tech: an agent that answers "what's on my block, and who decided it?"
from a city's Socrata open data portal and public meeting records. Norfolk, VA
is the full implementation; Seattle, Chicago, and any Socrata domain run in
generic mode.

## Non-negotiables

- **Voice contract.** The agent says "I found" / "I see", never "there is" /
  "there are" / "nobody" / "no one". `src/voice.js` enforces it; don't weaken
  the check to make an answer pass. A question the records can't settle (a
  plan, an intention, what will happen) but that the tools found something
  about is answered with what was found, led by exactly "I can't say that for
  sure, but here's what I found:" and closed with an offer to summarize that
  carries "AI can make mistakes" (Jason, 2026-11-10; `PARTIAL_LEAD`,
  `SUMMARY_OFFER`, `SUMMARY_CAVEAT` in `src/prompt.js`, pinned by
  `test/prompt-partial.test.js`). An answer links the words a fact comes
  from, inline (`LINK_LINE`), and code keeps a link only when its URL is in
  that answer's own hand-off (`src/answer-links.js`, run in `ask()` after any
  voice rewrite and the web hand-off: trimmed, one trailing slash off, query
  and case untouched; anything else becomes its text, bare URLs and emails
  included, images dropped, raw `<a>`/`<img>` removed, code spans left alone
  where marked is sure they're code). The record keeps how many links were
  kept and dropped (`answerLinks`, capped at 999), never the dropped URLs.
  The chat page and the public page check every rendered link against the
  hand-off again (a DOMPurify `afterSanitizeAttributes` hook: unknown links
  lose their href, the rest get `target="_blank" rel="noopener noreferrer"`).
  Siren never says she didn't read a source (Jason, 2026-11-10): for one her
  tools returned she calls `offer_followup` (`src/followups.js`; `FOLLOWUP_LINE`
  beside `SUGGEST_LINE`, which stays byte-identical), and the answer gets a
  button reading exactly "Would you like me to look into that?" that asks her
  question (at most 2, 200 characters, voice- and public-text-checked; only a
  hand-off record or dataset page, or a web page her search returned and the
  answer hands off; never a contact, CSV or deployment link). On the chat
  page the button sends it as the next message; on the public page it fills
  that question's follow-up box, and the asker still signs and asks. For one she
  can't reach, the tool says to call `suggest_data_source`, whose card stays
  the not-available path.
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
  Web search (Claude models only) runs only behind the deployment's
  `webSearch.allowedDomains`, sent as the tool's `allowed_domains` and
  enforced by the API; only Jason widens that list (Siren's is in
  `deployments/siren.config.js`). No list may cover the city's open data
  portal, whose data goes only through the dataset policy, and none has a
  blocklist form. The prompt's "never to look up a person, a business's
  owner or an address's residents" is behaviour, not enforcement; the list
  is the enforcement. Keep it to sites with no pages naming private people
  (police news, hearing packets with owners' names, public comments, wanted,
  missing-person, clemency or debarment lists), by subdomain or path where
  a site mixes them: a probe on 2026-11-10 found such pages on www.norfolk.gov,
  the iqm2 portal, EPA, HUD, NOAA, FEMA, Town Hall and regulations.gov, so
  they are off (reasons in the config, refusals in the test). Of the City's
  site only `/FormCenter`, `/CivicSend` (newsletters) and `/DocumentCenter`
  are listed; the last holds Planning staff reports naming land-use
  applicants, which Jason accepted for the PDF forms (2026-11-10), and the
  prompt asks Siren not to repeat a private person's name from a page.
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
    executors (core tools: the dataset tools, the address and meeting tools,
    `suggest_data_source`, `note_unanswered` with gaps on, `offer_followup`);
    `answer-links.js` holds the answer's links to its hand-off and
    `followups.js` the follow-up offers; `block.js` is the block report and legislation matching;
    `socrata.js` is the SODA client; `adapters/iqm2.js` parses Norfolk's
    meeting portal; `cities/` holds the profiles.
- `src/plugins.js` defines plugin tools and deployment configs. Plugins get a
  traced context (`ctx.socrata`, `ctx.http`, `ctx.lookupAddress`), never a raw
  fetch; `test/conformance.js` enforces it. Configs can add but not remove
  exclusions.
- `plugins/` holds plugin tools; `deployments/` holds configs (the sponge-city
  example is the reference).
- `src/web-search.js` is web search, off unless a deployment sets `webSearch:
  { allowedDomains, maxUses }` (checked by `webSearchConfig` in
  `src/plugins.js`, at startup and in `test/web-search.test.js`). Anthropic
  runs the search; code writes a trace step per search (query, result count,
  results, "run by Anthropic") and `kind: 'web'` hand-off records (the pages
  the answer cites, or every result when it cites none) from the API's
  response blocks, never from model text. Priced at $10 per 1,000 searches on
  top of tokens. A paused turn (`pause_turn`) is resumed as its own model
  call, a step and a counted request, never with `tool_choice: none` (nor a
  call after a server tool the API has yet to run); a client tool asked for
  past the cap isn't run. Web titles and URLs are escaped in markdown, and a
  web result never replaces a record. With it off, requests are byte-identical
  (`test/fixtures/web-search-off-snapshot.json`).
- `worker/access.js` verifies Cloudflare Access JWTs for per-person limits.
  Never trust the plain email header.
- `bin/socrata-agent.js` is the CLI (`ask` with your own key; `tool` with no key).
- `worker/` is the Cloudflare chat app (`index.js` plus `ui.html`, whose
  script and style are `chat-page.js` and `chat.css`, served under
  `<base>/assets/<hash>/` so the page carries a strict CSP: no inline script,
  style attribute or handler, and nothing that needs one). Siren is at
  `https://ask-siren.jason-edelman.org`, its own origin (a Workers Custom
  Domain, `BASE_PATH` empty, since 2026-11-10); `moved.js` answers its old
  address, `jason-edelman.org/ask-siren` (`MOVED_FROM`), over http or https,
  with redirects only, carrying a cookie-held invite to `/carry-invite` with a
  two-minute token signed under its own label (no use spent), and sends
  plain http on the new host to https. At the root the session cookies are
  `__Host-siren_user` and `__Host-siren_invite` (plain names under a
  `BASE_PATH`, where `__Host-` can't be used).
  Links the Worker sends out (sign-in emails, annotation ids, endorsement
  subjects, the client_id) come from `PUBLIC_ORIGIN`, never the Host header.
  `invites.js` holds invite codes and the waitlist; `accounts.js` holds email
  sign-in by magic link (Resend), which binds an invite to an account;
  `conversations.js` holds each account's conversations (KV), kept until the
  account deletes one or all of them (Jason, 2026-11-10: "store indefinitely
  on behalf of the user, since there's no discovery; deletion is on
  request"; `CONVERSATION_DAYS` sets an expiry for other deployments). Up to
  50 turns are kept; the last 8 come back to the model, with their tool
  results as data for follow-ups. Each key's metadata carries the list's
  title, so listing never opens every conversation. The list pages newest
  updated first (`GET /api/conversations?limit=&cursor=`: 20 a page, 50 at
  most; the cursor is the last `(updated, id)`, since that order isn't key
  order). Search (`/api/conversations/search`: the page POSTs `{q}` so the
  query is never in a URL; `GET ?q=` also works) reads the account's own
  conversations only, the 300 newest by `updated`, and matches each turn's
  question and answer as they read on the page (NFKC, case, whitespace,
  markdown marks dropped), never tool results or records: at most 20
  matches, three per conversation, with a notice when the 300 bound cut it
  short. The query and results are never logged, stored or cached
  (`no-store`; a failure logs one fixed line). Searches are limited to 100
  per account per UTC day, counted under `search-rate:<day>:<HMAC(day, uid)>`
  so the counter can't be joined to the account; a search the counter can't
  record (KV takes one write a second per key) isn't run. Each turn also keeps
  the record shown under its answer (trace, hand-off, voice check, model,
  steps, cost, suggestions, follow-up offers, link counts; bounded by
  `answerRecord`), so a reopened
  conversation shows how each answer was found; the model never sees it. Conversations are
  private to their account and never feed the case files, with two exceptions
  (research memory, `docs/research-memory.md`; Jason 2026-11-11: research
  counts from "Public, shared, and within the account"): the account's own
  `prior_research` reads its own earlier conversations' sources, never
  another account's; and a person can share one saved answer's sources with
  the "Share these sources" click, which keeps only their titles, links,
  kinds and days, never who shared, the question or the answer, and drops
  anything that could point at an address or a person.
  `research.js` is research memory's storage and routes; the tool is
  `src/prior-research.js` (`prior_research`, a core tool declared only when
  the Worker passes `priorResearch` to `ask()`). It gives back where earlier
  answers looked (sources with the day read, `recheck` past 30 days), never
  an earlier answer's text; the model re-reads or dates what it uses. Scopes:
  every one opt-in. `account` (signed-in accounts, only with
  `PRIOR_RESEARCH = "true"`; `"off"` turns the tool off everywhere), `public`
  (answered free-tier questions passing the public-text checks, with
  `PUBLIC_ASK`; the day, the `/q/<id>` link and the sources only, never the
  question's text), `shared` (D1 `shared_sources`, migration 0005, unapplied,
  keyed by `normalizeUrl`, behind `SHARED_RESEARCH`; with it off its paths are
  404s and the session and answer body carry nothing new). With every flag
  off, a member's request to the model is what it was before. A public
  answer never gets `account`, and its trace step never shows the words
  searched. A query naming a person or an address is refused; two searches
  an answer. Stored tool results (`saveTurn`, `keptTools`) keep no earlier
  question's text (`storedResearchResult`), so a deleted conversation's or a
  withdrawn question's words never live on in another turn. Shared and
  public sources drop anything whose title or whole decoded URL (fragment
  included) points at an address, a person, an email or coordinates, and
  every legislation or meeting page from a conversation or public thread
  that looked up an address. Returned sources join the hand-off as
  `kind: 'earlier'` records (at most 10, with `read`), shown apart as
  "Earlier research". Shared sources are public at `GET /api/research` (last
  shared first); an answer is shared once (`share-turn:<HMAC>`). The steward
  removes one at `/admin/research`: it leaves the list and every scope at
  once, and re-sharing, by either spelling, never revives it.
  `ask-stream.js` streams `POST /api/ask` as NDJSON when the page sends `Accept: application/x-ndjson` (working notes: the model's summarized thinking, live only, capped at 20,000 characters, never saved, traced, voice-checked or fed back as text; code-written tool lines; then a `final` line with exactly the JSON body); `WORKING_NOTES = "off"` turns it off.
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
  cached briefly; nothing Bluesky goes in KV or D1. That stays true of
  endorsements. A public question (the free tier, below) is the one
  exception: its row holds the asker's DID and handle, because publishing
  them is what the asker chose. Constellation is a stated,
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
  in the re-resolved DID document. The requests pages, the chat page and the
  free tier's pages carry a strict CSP with no inline script or style (the
  steward's `/admin` page doesn't yet); their scripts come from this origin,
  the chat page's two pinned CDN files, and Cloudflare's Web Analytics beacon
  (`CF_BEACON` in `index.js`, Jason 2026-11-10); every remote string is
  escaped. The subject URL is fixed
  since the move: changing `PUBLIC_ORIGIN` or `BASE_PATH` once endorsements
  exist strands them. Never store or log a Bluesky identity beside an
  invite, a visitor hash, an email account or a conversation. The free tier
  reads both in one request, for the invite gate, and keeps neither with the
  other. `SIREN_DB` holds the free tier's public questions and nothing else
  reads it; migration 0003 (unapplied) drops the old endorsement tables. With
  `BLUESKY_LOGIN` unset, nothing calls Constellation, the AppView, a PDS or
  D1. Never key anything new under `request:`.
  The free tier (`docs/free-tier.md`, behind `PUBLIC_ASK`, off; Jason
  2026-11-10): Bluesky sign-in plus an invite, and every question and answer
  is public, on Siren's site only: a row in D1 `SIREN_DB` (`questions.js`,
  migration 0004, unapplied) and a page at `/q/<id>`, listed at `/questions`.
  Email sign-in stays the private tier. The browser (the ask client of
  `endorse-client.js`: its own client_id `/question-client-metadata.json`,
  redirect `/questions`, and the scope `repo:<QUESTION_NSID>?action=create&action=delete`)
  writes a question record to the asker's own repo and posts its AT-URI and
  CID to `POST /api/public/ask` with the invite cookie; `public-ask.js`
  checks the invite as `/api/ask` does (the cookie only, the same daily
  count and budget; the email account is never read there), reads the
  record itself from the PDS the re-resolved DID document names, refuses a
  replayed (over 10 minutes), future-dated, wrong-collection, wrong-CID or
  malformed record before any model call, answers the record's text (never
  the POST body's) with the agent the chat runs, and counts every fetch on
  the answer's own budget (`ask()` takes it as `budget`). The record is the
  only proof of who asked; the Worker holds no Bluesky token.
  `QUESTION_NSID` lives in `worker/endorse-config.js` beside `ENDORSE_NSID`
  and nowhere else (the same test). Follow-ups are threaded replies (the
  record's `reply: {root, parent}` strongRefs; the parent and root answered
  here at those CIDs; 25 questions and depth 10 per thread); the answer gets
  the chain root to parent as history, as a conversation's turns, with
  their tool results from the row's internal `tools` column (never served),
  and never a withdrawn or hidden question's text (earlier questions wrapped
  in `<thread_question>` as other people's words; the claim and the stored
  answer both conditional on the parent and root still answered at their
  CIDs). Withdrawing (the record gone from the asker's PDS) empties the row
  but its id, day, status and place in the thread, and rewrites references
  to it as `withdrawn:<id>`. A record deleted in the asker's own account is
  taken down within seconds by the Jetstream watcher (`question-watcher.js`,
  the Durable Object `QuestionWatcher`, binding `QUESTION_WATCHER`, migration
  `v1-question-watcher` in `[env.siren]`, exported from `index.js`; Jason
  2026-11-10: one instance holds a WebSocket to Jetstream v2, `kinds=commit`
  in `QUESTION_NSID`'s collection, `JETSTREAM_URL` overriding the public
  pair; a delete only names a record to look at: a held one is withdrawn
  through `takedownIfGone`, the withdraw path, after its PDS says it's gone,
  and a forged or replayed event writes nothing; the saved cursor is a
  witnessed time that never passes a deletion still waiting, resumed 60 s
  early, at most a day back; the upgrade times out at 10 s and never follows
  a redirect, the alarm is set before each connect; backoff, failover,
  10-minute retries after repeated 4xx; per-DID, lookup and check caps a
  minute so strangers' deletions can't crowd out held ones; every fetch
  counted, no DID logged, trouble logged once per change; about 324,000 GB-s
  a month, inside Workers Paid's 400,000). Its deploy is a rollback barrier
  (a Durable Object lifecycle change): no earlier Siren version can be
  rolled back to. The backstop is the sweep (a Cron Trigger every ten
  minutes, `scheduled` in `index.js`, which also pings the watcher, both
  no-ops with `PUBLIC_ASK` off and the object never reached: at most 40
  questions unchecked for an hour, so 240 an hour, counted, behind the
  breaker, re-verifying handles) and a page's re-check of its thread. Every
  re-check withdraws only on a clear RecordNotFound, or when the PDS the
  re-resolved DID document names answers `sync.getRepoStatus` with
  RepoNotFound (the account deleted; getRecord's "Could not find repo" also
  covers deactivated accounts, which stay).
  The steward hides at `/admin/questions` or with `question-hide` /
  `question-unhide`. The pages (`questions-page.js`, `questions.html`,
  `admin-questions.js`) carry the strict CSP; answers render through marked
  and DOMPurify with no style or data attributes, form controls or dialogs
  (the chat page's `md()` too: answers are model output a public question
  can steer), and the public page ignores clicks inside an answer; the new
  pages and their JSON send `X-Robots-Tag: noindex`. With `PUBLIC_ASK`
  anything but `"true"`, every existing route answers byte for byte as
  before and nothing new is served (`test/public-ask-off.test.js`, against a
  snapshot taken before the free tier, retaken with each later change to the
  chat page's files applied to that base; only the asset hash, the text of
  the three client modules it extends and the chat script's sanitizer line
  differ); set but missing Bluesky sign-in, `SIREN_DB` or invite mode, its
  routes answer 503. The operator could still match a public question to an
  invite through exact times kept elsewhere (`redeemed:` keys), and D1 Time
  Travel keeps withdrawn rows recoverable for 30 days: the spec says so.
  `plugins/case-file.js` serves a
  case file for questions with no address. No payments: bounties are tabled until after beta (Jason).
- `plugins/budget-for.js` (`budget_for`) and `plugins/capital-projects.js`
  (`capital_projects`) read the budget datasets registered in the Norfolk
  profile's `budget` block. Names the model gives are matched against each
  dataset's own list (a traced query) and only the City's spelling reaches
  fixed SoQL; a miss returns the closest names. Caveats are quoted from the
  live metadata or computed from the queries.
- `plugins/city-news.js` (`city_news`) reads the City's own announcements
  from its News Flash and Alert Center RSS feeds (`www.norfolk.gov/rss.aspx`).
  Police and prosecutor news stays out in code. A frozen allowlist of
  categories (`NEWS_FEEDS`, read live 2026-11-10): Police-34,
  Commonwealths-Attorney-65 and every `All-` feed are refused at load and by
  `test/city-news.test.js`, and since the server reads only the number at the
  end of a CID ("Community-34" serves Police) and serves every category for a
  CID with none, the rule is on the number (News Flash 34 and 65 never); a
  feed is read only if its own title names the category asked for. A
  cross-post check: those two feeds are read for their links only, and an
  allowed item sharing a link is dropped (if they can't be read, items still
  come back with the check marked incomplete). And a broad crime-and-court
  wording check on titles and summaries. A call reads up to 6 category feeds
  (home page, spotlight and emergency alerts always, the rest by the query's
  words) plus the 2 link feeds, the link feeds first, each with one retry as
  its own traced step (`tracedHttp`'s `retry: false`). Only `www.norfolk.gov`
  links are kept. Fire-Rescue alerts stay off until one has been read and
  names no one.
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
