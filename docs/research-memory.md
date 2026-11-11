# Research memory

Jason asked on 2026-11-11: "Does Siren accumulate knowledge yet? So if someone
else asks her about Macarthur she has her existing research to draw on?" The
answer was no: only the hand-built case files carried over. His direction:
research counts from "Public, shared, and within the account."

## What carries over: where to look, never what she concluded

An earlier answer's text is never given back. One misreading would otherwise
become a citation, and then a consensus. What carries over is **where earlier
answers looked**: for each match, the day, the question when it can be shown,
and the sources that answer read (title, link, kind, the day it was read).

The model is told to treat these as pointers. It re-reads any source it relies
on with its own tools, or gives the day the source was read ("as of
2026-11-10"). A source read more than 30 days ago comes marked `recheck`.

## The tool

`prior_research` (`src/prior-research.js`) takes `{query}`: a few keywords naming
a place, project or topic. The words become terms (three letters or more, no
stop words, not the city's own name, six at most). A match needs at least half
of them. A query that names a person or an address (the public-text checks)
is refused, with a message the model can act on, and isn't counted. An answer
may search at most twice. Every result is labelled with its scope:

| Scope | What it reads | When it's on |
|---|---|---|
| `account` | The asking account's own earlier conversations: its 100 newest, never the one being answered | Signed-in accounts, only with `PRIOR_RESEARCH = "true"` |
| `public` | Answered free-tier questions (`public_questions`, status `answered`) | `PUBLIC_ASK` on and ready |
| `shared` | Sources people shared from private answers (`shared_sources`, status `listed`) | `SHARED_RESEARCH = "true"`, `SIREN_DB`, `LIMITS`, `INVITE_SECRET` |

A public answer (the free tier) never gets the `account` scope. `ask()`
refuses it on a public thread, and the Worker never passes an account for one.

Every scope is opt-in. Without the Worker's search, the tool isn't declared
and the prompt has no line for it. With `PRIOR_RESEARCH`, `PUBLIC_ASK` and
`SHARED_RESEARCH` all off, a member's request to the model is what it was
before this change (a test sends the same question with each "off" spelling
and compares). The CLI behaves as before.

### The hand-off

Sources the tool returns join the answer's hand-off as records of kind
`earlier`, at most 10 per answer, each with the day it was read. They are shown
apart from the sources the answer read, under "Earlier research", with a note
that they weren't read again unless the trace shows it. Registering them means
the answer can link the words a pointer supports, and `offer_followup` can offer
to read one ("Would you like me to look into that?").

The record keeps up to 30 read records first and up to 10 pointers after them,
so pointers never crowd out what was read. A pointer is never carried over
again: `earlier` records are left out of every later search and share.

### The trace

Code writes one trace step per call. It names the scopes searched and how many
matches came back. The words searched appear only on a private answer. A
public answer's trace is public, so there the step shows only the scopes and
the count.

## Each scope

**Account** (`worker/conversations.js` `researchInConversations`). Only keys
under `conv:<uid>:` are listed or read. A turn matches on its question, its
answer and its sources' titles. The answer is only searched, never returned.
Results are not filtered for addresses: they go back only to the account that
found them. The person's own question comes back with them, to the model and
live only.

**What's kept.** A conversation turn (`saveTurn`) and a public row
(`keptTools`) store a `prior_research` result without any match's
`question` (`storedResearchResult`): the scopes, days and sources stay for
follow-ups. So when a conversation is deleted, or a public question
withdrawn, its text doesn't live on in another turn. A result cut to size
(no longer valid JSON) is kept as a note only.

**Public** (`worker/research.js` `searchPublic`). Only answered questions whose
text passes the public-text checks (no house number, street address, corner,
"block of", unit, contact, coordinates or named person). Only their sources
that pass the address filter below, and no legislation or meeting page when
any question in the same thread looked up an address (a follow-up carries
its root's results). The question and the answer are searched, never
returned: a match is the day, the question's page (`/q/<id>`) and the
sources.

**Shared** (`worker/research.js` `searchShared`). Listed sources whose titles
hold enough of the terms. Each comes back as its own match, with the day an
answer last read it.

## Sharing: the person's own click

Under a private answer saved to a signed-in account's conversation, with shared
research on, the chat page shows "Share these sources". Siren never asks anyone
to share. The click posts `{conversation, at}` to `POST /api/research/share`. The
Worker then:

1. Reads the sources from **that saved turn** (never from the page), in the
   account's own conversation.
2. Keeps records of the topic kinds (legislation, meeting, document or
   case-file source, City news, web page) and dataset pages. It never keeps a
   dataset's query or full CSV, a contact, a deployment link or an earlier
   pointer.
3. Drops anything that could point at an address or a person:
   - every legislation and meeting page from a turn that looked up an address
     (`block_report` or `lookup_address` among a turn's tools or trace, or
     a question naming an address, in **any turn of that conversation**),
     since `block_report` finds agenda items by address and a later turn can
     follow them;
   - every source whose title fails the public-text checks;
   - every source whose URL fails `urlCarries`: the whole URL past the host,
     fragment included, decoded up to three times, may hold no "@" (an email,
     encoded or not) or mailto, no coordinate pair (a latitude and longitude,
     or a web map's projected position), no query key naming a place or a
     person (address, parcel, lat/lon, owner, email, name…), and, read as
     written and with its separators as spaces, no house number, street
     address, corner, "block of", unit, contact, coordinates or person.
4. Upserts each remaining source by its key (`url_key`, `sourceKey`: scheme
   and host in lower case, no trailing slash, fragment or tracking
   parameters, so one page is one row however its link is spelled) into
   `shared_sources`: title, link, kind, city, the newest day an answer read
   it, the days first and last shared, and a share count. An answer is
   shared once: sharing it again answers `already_shared` and changes
   nothing (`share-turn:<HMAC(uid, conversation, at)>`, kept 400 days).

**What the share-once marker allows.** The marker is an HMAC of the account,
conversation and answer time under `INVITE_SECRET`. Anyone holding that
secret and the KV store (in practice, the operator) can test a given
account's answers against the markers for 400 days and learn which of them
were shared, though not which sources a share wrote. That is narrower than
"nothing about who shared is kept", and it is the price of counting a share
once on the server.

**Never stored:** who shared it (no account, invite, visitor hash or Bluesky
identity), the question, the answer, or any time finer than a day.

**Limits:** 20 shares a day per account, counted under
`share-rate:<day>:<HMAC(day, uid)>`, the conversation search's construction,
so the counter can't be joined to the account. A share that finds nothing to
keep isn't counted.

**Responses:** 409 while the answer is still being saved, 404 for a
conversation the account doesn't have, 401 signed out, 403 from another
origin.

**The public list.** `GET /api/research?city=&limit=&before=` lists the listed
sources, last shared first (then newest row), 50 a page (100 at most), cached
60 seconds. The cursor is `<last_day>.<seq>`; a source shared again between
two pages moves to the top, so paging can miss or repeat it. The
case-file routine reads it to see what people found useful.

**The steward.** `/admin/research` (ADMIN_EMAILS) lists every shared source.
**Remove** takes one off the list at once, and out of every scope of earlier
research from then on (shared, public, and accounts' own conversations,
matched by normalized URL); answers already given keep what they showed.
Sharing it again, by either spelling, doesn't bring it back. **Restore**
undoes that. While shared research is on, a search that can't read the
removals returns nothing.

## Flags and rollout

- `PRIOR_RESEARCH = "true"` turns on the account scope; `"off"` turns the
  tool off everywhere without a code deploy. Unset, only `PUBLIC_ASK` and
  `SHARED_RESEARCH` can declare it.
- `SHARED_RESEARCH` stays off until migration 0005 is applied:
  `npx wrangler d1 migrations apply SIREN_DB --env siren --remote`. That
  command applies every pending migration, 0003 and 0004 included: check
  first, as `wrangler.toml` says.
- With `SHARED_RESEARCH` anything but `"true"`, none of its paths are served:
  each is the 404 every unknown path gets. The session and the answer body
  carry nothing new, and the flag-off snapshot holds every existing route.
  With it `"true"` but not set up, its routes answer 503.

## What this changes in the conversation promise

Conversations were "private to their account and never feed the case files."
That still holds, with two exceptions:

- the account's own `prior_research` reads its own earlier conversations'
  sources;
- the sources a person shares from one answer, by their own click, become
  public.

No other path reads a conversation for anyone but its account.
