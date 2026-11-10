# The free tier: ask in public with Bluesky

Status: built 2026-11-10, behind `PUBLIC_ASK` (off by default; unset in
`wrangler.toml`). Migration 0004 is not applied, and the question Lexicon is
not published: both are rollout steps ("Flags and rollout"). Where the build
made a call this spec didn't settle, "Built as" says which.

## Jason's decisions (2026-11-10)

- "Let's move to atproto sign in, i.e. free tier, next. We should clearly
  state that all questions and answers are public."
- Answers live on **Siren's site only**: a public page per question, held in
  Siren's database. Not records in a Siren repo, not Bluesky posts.
- **An invite is still required** during beta: Bluesky sign-in plus an invite
  code. Questions are still public.
- **Email sign-in stays the private tier** (invite, conversations private for
  7 days; the future paid tier, no payments yet).
- **Follow-ups, as threaded replies** (later the same day, replacing "no
  follow-ups in v1"): "Let's also allow follow up questions from other users
  as threaded replies. It might not be a bad idea to just use atproto at
  some point, once we give siren a DID." See "Threads" and "Later: Siren's
  own DID".

Earlier, still binding: public-first for the free tier ("pay for secrecy
makes more sense anyway. Public first also keeps people honest", 2026-11-09);
harassment risk accepted ("I'm counting on Bluesky's T&S team"); flags are
shown, never used to exclude; the Worker never holds a Bluesky token.

## What a person sees

Two doors, told apart before anyone signs in:

- **Private** (the chat page, `/`): email sign-in and an invite. Conversations
  are private to the account and kept 7 days. Unchanged.
- **Public** (`/questions`): Bluesky sign-in and an invite. Everything is
  public. The page lists every public question that starts a thread, with its
  answer and how many follow-ups it has, newest first; each question has its
  own page at `/q/<id>`, which shows the whole thread it belongs to.

### The notice (exact copy; a test pins it)

At the top of `/questions` and `/q/<id>`, always shown:

> Everything here is public. Each question, Siren's answer, how she found it,
> and the asker's Bluesky handle can be read by anyone.

In the ask panel, before sign-in:

> **Ask in public.** Sign in with Bluesky and an invite to ask. Your
> question, Siren's answer, how she found it and your Bluesky handle will be
> public on this site, and your question is saved as a record in your own
> Bluesky account, public on the network like a post. You can delete it at
> any time, here or in your account, and Siren takes its page down; copies
> other people made may remain. For a private question, use email sign-in on
> the main page.

Beside the ask button once signed in:

> Public: anyone can read this question and its answer, with your handle
> @&lt;handle&gt;.

On the private chat page, one line: "Want to ask in public instead? Sign in
with Bluesky at the public questions page." (linked). The footer's data note
(questions go to Anthropic, 30 days) shows on the public pages too.

## How a question is asked

The Worker never holds a Bluesky token. Who asked is proven by a record in
the asker's own repo, the way endorsements are.

1. The browser signs in through the existing OAuth client
   (`worker/endorse-client.js`, `atproto-oauth.js`). The scope adds one
   repo permission: `repo:org.jason-edelman.siren.question?action=create&action=delete`.
   `QUESTION_NSID` lives in `worker/endorse-config.js` beside
   `ENDORSE_NSID`, and nowhere else (the existing test extends to it). The
   granted scope is checked as today: asking needs the question scope,
   endorsing the endorsement scope; a session missing one is told to sign in
   again.
2. The browser writes the question record to the asker's PDS
   (`com.atproto.repo.createRecord`, record key a TID):
   `{ $type, text, city, createdAt }`, and for a follow-up `reply: { root,
   parent }` ("Threads"). `text` at most 600 characters (the chat's
   `MAX_QUESTION`), `city` a city id. Lexicon:
   `lexicons/org/jason-edelman/siren/question.json`. The page stamps
   `createdAt` with Siren's clock (from `/api/public/session`), so a browser
   whose clock is off doesn't write a record Siren refuses.
3. The browser posts `{ uri, cid }` to `POST /api/public/ask`, with the invite
   cookie.
4. The Worker, before any model call:
   - checks the invite exactly as `/api/ask` does (`currentInvite`, the same
     per-invite and per-visitor limits, the same daily budget);
   - parses the AT-URI (DID, collection must be `QUESTION_NSID`, record key);
   - resolves the DID to its PDS through `atproto-identity.js` (the hardened
     resolver endorsements use) and fetches the record with
     `com.atproto.repo.getRecord` at that `cid`;
   - checks the record's shape, that `createdAt` is within the last 10
     minutes and not in the future (no replaying an old record), and that the
     question text passes the chat's input checks;
   - resolves the handle from the DID document, verified both ways, as the
     endorser list does;
   - claims the question in D1 (unique on the AT-URI). An answered one
     returns its stored page; one being answered returns 409.
   These fetches go through the answer's counting fetch
   (`src/request-budget.js`).
5. The Worker runs the same agent as the private chat, on the record's text
   (never the POST body's), with Siren's deployment config. Then it stores
   the public Q&A and returns `{ id, url, answer, record }`.

Working notes don't stream on the public page (v2): the public answer is one
JSON response, under `waitUntil` so a reader who leaves doesn't stop it.

**Built as** (calls the spec didn't settle, each the more private or more
conservative option):

- **The invite is the cookie only.** `/api/public/ask` reads the invite
  cookie with `currentInvite` and never the email account cookie, so the
  email account is never read on a public route. Someone whose invite is
  bound to their email account enters their code once on the public page
  (`POST /api/public/redeem`, which always sets the cookie; that spends a
  use unless this browser already holds the code). `GET /api/public/session`
  says whether this browser holds one, so the page asks for it before anyone
  writes a record.
- **The daily count is counted before the work**, as `/api/ask` counts it,
  on the same key (`inv-day:<day>:<invite>`), so a refused record costs one
  of the invite's questions too. Its expiry is a day boundary, not 48 hours
  from the question, so the key doesn't carry a public question's time.
  `checked_ms` is kept to ten-minute steps for the same reason.
- **A second client.** The ask client has its own client_id
  (`/question-client-metadata.json`, served only with the flag on) and its
  own redirect (`/questions`), so the endorse client's metadata never
  changes. A fresh sign-in on the public page asks for the question
  permission alone; it asks for the endorsement permission too only when the
  browser's live session for the same account already holds it, so signing
  in to ask doesn't take endorsing away. The session (one, shared with the
  requests page, as before) keeps the scope it was granted, and each page's
  action checks its own permission; a session without it re-authorizes.
- **A refused or failed ask deletes the record.** The page deletes the
  record it just wrote when Siren refuses it or the answer fails, and says
  so. A dropped connection keeps it: the answer may still be stored.
- **A handle that doesn't verify** both ways is stored as none, and the page
  links the account by its DID.
- **Clock skew:** a record up to a minute in the future is accepted.
- **Rate limits:** the site-wide breaker `BSKY_SITE_RL` is charged before any
  outbound fetch (keys `ask`, `withdraw`, `recheck`, `questions`); the
  invite's daily count covers each asker.
- **The steward's page** is `/admin/questions` (strict CSP, its own script),
  linked from `/admin` with the flag on; `/admin` itself is unchanged.

## What is stored, and what isn't

D1 (`SIREN_DB`), migration `0004_public_questions.sql`, one row per question:

| column | |
|---|---|
| `seq` | integer primary key, for newest-first order |
| `id` | random public id, 16 base32 characters, unique |
| `question_uri`, `question_cid` | the record, unique on the URI |
| `did`, `handle` | the asker, handle as verified at answer time |
| `city`, `question` | the record's city and text |
| `answer`, `record` | the answer and the same bounded record the chat keeps under an answer (`answerRecord`: trace, hand-off, voice check, model, steps, cost, suggestions) |
| `status` | `answering`, `answered`, `withdrawn`, `hidden` |
| `day` | the day answered, never finer |
| `checked_ms` | when the record was last confirmed present (internal, never shown), in ten-minute steps |
| `root_uri`, `parent_uri` | a follow-up's thread root and parent, by AT-URI (null on a root); `withdrawn:<id>` once that question is withdrawn |
| `depth` | 0 for a root |
| `tools` | the answer's tool results, trimmed as a private conversation keeps them, for follow-ups (internal, never served) |

Never stored or logged together with a DID or handle: the invite, the visitor
hash, an email account, a conversation. The request carries the invite cookie
and the question's author at once; the Worker checks each and keeps neither
with the other.

Two CLAUDE.md invariants were written for endorsements and are narrowed, in
CLAUDE.md, to say exactly this:
- "Nothing Bluesky goes in KV or D1" stays true of endorsements. A public
  question is the one exception: its row holds the asker's DID and handle,
  because publishing them is what the asker chose.
- "Never link a Bluesky identity to an invite, email account or
  conversation" becomes: never store or log one beside the other. The free
  tier reads both in one request, for the invite gate, and keeps neither
  with the other.

Working notes are never stored, as today. A failed answer deletes its row; the
record stays in the asker's repo for them to delete (the page deletes it for
them when it can).

## Public pages

- `GET /questions` and `GET /q/<id>`: pages with the same strict CSP as the
  requests pages, scripts from this origin and the CDN files the chat page
  already pins (marked, DOMPurify) plus the analytics beacon. The answer is
  rendered as the chat page renders it (DOMPurify, `FORBID_ATTR: ['style']`);
  every other remote string is escaped.
- `GET /api/questions` (thread roots, newest first, 20 per page, a cursor,
  each with its reply count) and `GET /api/q/<id>` (the question and its
  whole thread): JSON. Withdrawn and hidden rows are absent from the list.
  On its own page a withdrawn row says only "The asker withdrew this
  question." (the rest of its thread stays); a hidden one has no page.
- Each entry shows the handle (linked to its Bluesky profile), the same flags
  as the endorser list (bot self-label, Bluesky moderation labels, account
  under 30 days, no profile), the day, the question, the answer, the trace
  and the hand-off. The flags are read live from the public AppView, each
  profile cached five minutes; when they can't be read the page says so.
- `X-Robots-Tag: noindex` on these pages and their JSON for now. Public, but
  not put in search engines, until Jason decides otherwise.

## Withdrawing, and the steward

- **The asker withdraws:** the browser deletes the record (the delete scope),
  then `POST /api/public/withdraw { uri }`. The Worker confirms the record is
  gone from the DID's PDS, then sets `withdrawn` and empties every column
  but `id`, `day`, the status and its place in the thread (`root_uri`,
  `parent_uri`, `depth`, which name only other questions): `question_uri`,
  `question_cid`, `did`, `handle`, `city`, `question`, `answer`, `record`
  and `tools`. Every other row naming its URI names `withdrawn:<id>`
  instead, so its replies stay and the asker's DID goes with it.
- **Deleted elsewhere:** `/q/<id>` re-checks the record when `checked_ms` is
  over 10 minutes old (one getRecord, counted) and withdraws on a clear
  RecordNotFound. Not on an unreachable PDS: that is "couldn't check", and the
  page stays.
- **The steward:** hides or unhides a question at `/admin/questions` (linked
  from `/admin`) and with `node scripts/invites.js question-hide <id>` /
  `question-unhide <id>` (one UPDATE through `wrangler d1 execute`).
  Questions publish at once, with no review first (public-first); hiding is
  the remedy.

## Threads (follow-ups)

Jason, 2026-11-10: "Let's also allow follow up questions from other users as
threaded replies."

- **Anyone may follow up.** Any signed-in Bluesky user with an invite can ask
  a follow-up on any answered public question, theirs or anyone else's.
- **The record names its thread.** A follow-up's record carries `reply: {
  root, parent }`, each a `com.atproto.repo.strongRef` (`uri` and `cid`) to an
  earlier question record, the same shape as an `app.bsky.feed.post` reply.
  It is in the Lexicon (`#replyRef`).
- **What the Worker checks**, after the record itself and before any model
  call: the parent and the root are both public questions in D1 with status
  `answered`; the record's `root` is the parent's root (or the parent itself,
  when the parent is a root); both CIDs match what D1 holds; the city is the
  thread's; and the thread is under its caps, 25 questions (of any status,
  the root included; checked in the claim's own statement) and a depth of 10
  (a root is 0). Each refusal says which.
- **Context.** The model gets the chain from the root down to the parent,
  oldest first, as history before the new question, no siblings: the way the
  private chat feeds a conversation's earlier turns (`historyFrom` in
  `worker/conversations.js`), each answer's tool results coming back as data.
  Those results are kept in the row's internal `tools` column, never served,
  trimmed as a conversation keeps them. The context counts against the
  chat's bounds: at most 8 turns (the root and the nearest after it, with a
  note in place of the ones left out) and the same 40,000 characters of
  carried data. No asker's DID or handle goes into it.
- **Withdrawn or hidden questions in a thread** show as placeholders ("The
  asker withdrew this question." / "Hidden by the steward."), and their
  replies stay. A withdrawn question's text and answer never go into a
  follow-up's context: the chain skips it, and a note in its place says so.
  **Built as:** a hidden one is skipped the same way. A thread whose root is
  withdrawn or hidden takes no new follow-ups (the root must be answered),
  and leaves the list; its replies keep their pages.
- **Display.** `/q/<id>` shows the whole thread the question belongs to: root
  first, replies nested under their parents, the current one highlighted.
  Each question keeps its own page; the list shows roots with a reply count.
  Every entry shows its own asker's handle and flags. An "Ask a follow-up"
  button opens the ask panel for it (the notices as for any question).
- **Built as:** the ancestors' records aren't re-checked at ask time: their
  D1 status decides (a record deleted elsewhere is noticed when its page is
  next viewed, as for any question).

## Later: Siren's own DID

Not built. Jason: "It might not be a bad idea to just use atproto at some
point, once we give siren a DID." Once Siren has a DID and a repo of her own,
each answer could become a record there (say an `answer` record), pointing at
its question record by strongRef, the way a follow-up points at its parent.
The page on Siren's site would then render records from both repos, and an
answer would be as portable as the question.

The D1 schema keeps that open: each question's record is stored by AT-URI and
CID (a strongRef, ready to point at), and each answer and the record shown
under it are plain data (markdown and JSON), with nothing in them that only
Siren's database could resolve. A move would write one answer record per
answered row, from its `answer` and `record`, and keep the row as an index.

## Flags and rollout

- `PUBLIC_ASK` unset: nothing new is served (`/questions` 404s, the private
  page shows no public link), and no D1 or Bluesky call happens for it. With
  it set but `BLUESKY_LOGIN` or `SIREN_DB` missing, the routes fail closed
  (503, reason logged).
- Rollout rides the endorsement rollout: publish the question Lexicon from
  Jason's account beside the endorsement one (the schema record's key is the
  question NSID; the same `_lexicon` TXT record covers it), apply migration
  0004 (`npx wrangler d1 migrations apply SIREN_DB --env siren --remote`,
  which applies 0003 too: check the old tables are empty first), then set
  `PUBLIC_ASK` once a live sign-in, ask, follow-up, withdraw and steward hide
  have been tried, from a local `wrangler dev` with the flag on (the
  endorsements doc's "Local development", plus `PUBLIC_ASK=true` and
  `INVITE_REQUIRED=true` in `.dev.vars`, and the migrations applied to the
  local D1 first: `npx wrangler d1 migrations apply SIREN_DB --env siren
  --local`). Nothing here has been tried against the live network.
- The asset hash changed with this build, as with any deploy that changes a
  served file: the shared modules the browser client is built from
  (`endorse-config.js`, `atproto-oauth.js`, `endorse-client.js`) now carry
  the ask client too. Every other byte of every existing route is unchanged
  with the flag off (`test/public-ask-off.test.js`).

## Tests the build must add

- The notice copy, exactly, on both pages and in the ask panel; the private
  chat page's link appears only with the flag on.
- A forged, replayed (older than 10 minutes), future-dated, wrong-collection,
  wrong-cid or missing record is refused before any model call; the answer
  uses the record's text even when the POST body says otherwise.
- No invite: refused, as `/api/ask` refuses.
- One answer per record; a second POST returns the stored page.
- Nothing stores an invite or visitor hash beside a DID (a test reads every
  D1 statement and KV key the public routes write).
- Withdraw requires the record gone at the asker's PDS and the same DID;
  someone else's DID can't withdraw it. Withdrawn rows keep no text.
- Threads: a follow-up from a second DID works; forged, mismatched,
  unanswered, hidden or over-cap parents are refused before any model call;
  the chain reaches the model in order, and a withdrawn ancestor is left out;
  a withdrawal keeps the replies.
- Hidden and withdrawn rows are absent from `/api/questions`.
- Flag off: byte-identical behaviour on every existing route.
- Strict CSP and escaping on the new pages, as the requests pages' tests do.
