# The free tier: ask in public with Bluesky

Status: spec, 2026-11-10. Behind `PUBLIC_ASK` (off by default).

## Jason's decisions (2026-11-10)

- "Let's move to atproto sign in, i.e. free tier, next. We should clearly
  state that all questions and answers are public."
- Answers live on **Siren's site only**: a public page per question, held in
  Siren's database. Not records in a Siren repo, not Bluesky posts.
- **An invite is still required** during beta: Bluesky sign-in plus an invite
  code. Questions are still public.
- **Email sign-in stays the private tier** (invite, conversations private for
  7 days; the future paid tier, no payments yet).

Earlier, still binding: public-first for the free tier ("pay for secrecy
makes more sense anyway. Public first also keeps people honest", 2026-11-09);
harassment risk accepted ("I'm counting on Bluesky's T&S team"); flags are
shown, never used to exclude; the Worker never holds a Bluesky token.

## What a person sees

Two doors, told apart before anyone signs in:

- **Private** (the chat page, `/`): email sign-in and an invite. Conversations
  are private to the account and kept 7 days. Unchanged.
- **Public** (`/questions`): Bluesky sign-in and an invite. Everything is
  public. The page lists every public question with its answer, newest first;
  each has its own page at `/q/<id>`.

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
   `{ $type, text, city, createdAt }`. `text` at most 600 characters (the
   chat's `MAX_QUESTION`), `city` a city id. Lexicon:
   `lexicons/org/jason-edelman/siren/question.json`.
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

No follow-ups in v1: each public question stands alone. Working notes may
stream as on the chat page if it falls out cheaply; otherwise v2.

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
| `checked_ms` | when the record was last confirmed present (internal, never shown) |

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
record stays in the asker's repo for them to delete.

## Public pages

- `GET /questions` and `GET /q/<id>`: pages with the same strict CSP as the
  requests pages, scripts from this origin and the CDN files the chat page
  already pins (marked, DOMPurify) plus the analytics beacon. The answer is
  rendered as the chat page renders it (DOMPurify, `FORBID_ATTR: ['style']`);
  every other remote string is escaped.
- `GET /api/questions` (newest first, 20 per page, a cursor) and
  `GET /api/q/<id>`: JSON. Withdrawn and hidden rows are absent from the list.
  On its own page a withdrawn row says only "The asker withdrew this question."
- Each entry shows the handle (linked to its Bluesky profile), the same flags
  as the endorser list (bot self-label, Bluesky moderation labels, account
  under 30 days, no profile), the day, the question, the answer, the trace
  and the hand-off.
- `X-Robots-Tag: noindex` on these pages and their JSON for now. Public, but
  not put in search engines, until Jason decides otherwise.

## Withdrawing, and the steward

- **The asker withdraws:** the browser deletes the record (the delete scope),
  then `POST /api/public/withdraw { uri }`. The Worker confirms the record is
  gone from the DID's PDS, then sets `withdrawn` and empties `question`,
  `answer`, `record` and `handle`, keeping only `id`, `day` and the status.
- **Deleted elsewhere:** `/q/<id>` re-checks the record when `checked_ms` is
  over 10 minutes old (one getRecord, counted) and withdraws on a clear
  RecordNotFound. Not on an unreachable PDS: that is "couldn't check", and the
  page stays.
- **The steward:** hides or unhides a question at `/admin` and with
  `node scripts/invites.js question-hide <id>` / `question-unhide <id>`.
  Questions publish at once, with no review first (public-first); hiding is
  the remedy.

## Flags and rollout

- `PUBLIC_ASK` unset: nothing new is served (`/questions` 404s, the private
  page shows no public link), and no D1 or Bluesky call happens for it. With
  it set but `BLUESKY_LOGIN` or `SIREN_DB` missing, the routes fail closed
  (503, reason logged).
- Rollout rides the endorsement rollout: publish the question Lexicon from
  Jason's account beside the endorsement one, apply migration 0004, then
  set `PUBLIC_ASK` once a live sign-in, ask, withdraw and steward hide have
  been tried.

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
- Hidden and withdrawn rows are absent from `/api/questions`.
- Flag off: byte-identical behaviour on every existing route.
- Strict CSP and escaping on the new pages, as the requests pages' tests do.
