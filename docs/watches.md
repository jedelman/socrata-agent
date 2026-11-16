# Watches and civic-league feeds

Jason, 2026-11-16: "I'd like for people to be able to ask something like 'let
me know if planning commission or City Council take up any items affecting
short term rentals' and get an email." And, of the public per-street feeds he
had approved: "Let's shift from per street to per neighborhood league."

Two features share one daily read of the City's posted agendas:

- **Watches** (`WATCHES = "true"`): a signed-in member keeps up to five
  watches. A watch is topics from the city's reviewed list, a civic league, or
  both, over City Council and/or the Planning Commission. When a newly posted
  agenda item matches, the member gets one email that day.
- **Civic-league feeds** (`LEAGUE_FEEDS = "true"`): a public Atom feed per
  civic league, plus one for every item, at `/feeds`.

Both are off by default. With both off, no route, page, prompt, tool list or
session body changes (`test/watches-worker.test.js`, and the free tier's
flag-off snapshot), and the cron does nothing new.

## Private people: describe, never repeat

Agenda titles can name private people: the buyer of a City lot ("Conveyance
to … of That Certain Parcel"), a tenant, a person granted an encroachment, a
Planning Commission applicant. An earlier version of this PR tried to withhold
names from titles. Two independent reviews found it leaking in shape after
shape:
- names that are ordinary words (Will Price, Hope Wells);
- Title Case titles;
- mixed-case applicants;
- "Easement From … Over".

So the design changed. **Siren never repeats an agenda title, and never keeps
one.** Each item is described from parts code extracts (`src/watches.js`):

- **the kind of action**: one of a fixed list of labels ("Conditional Use
  Permit", "Sale of City property", "Rezoning", "Lease", …);
- **the topics it matches**: from the city's reviewed list;
- **the addresses** its title names: property locations, as the address
  tools already take;
- **its ordinance or resolution number**;
- **a link to the City's own page** for the item, which has the full text.

For example: "Conditional Use Permit: Short-term rentals, at 1210 Virgilina
Avenue". A test runs over all 1,452 titles in the legislation index. It checks
that every word of every description is a word of a fixed label, a count, or a
word of an address the title names. Nothing else can get through, so no name
can (`test/watches.test.js`).

**Watches follow topics, never free words.** A watch picks from the city
profile's `meetings.watchTopics`, 27 topics for Norfolk, each with the phrases
it matches. "Short-term rentals" matches short-term rental, vacation rental,
homestay and bed and breakfast, which is 159 titles since July 2023. So no
watch can be keyed to a person's name. If someone asks for a topic that isn't
on the list, Siren says a watch can't follow that yet. Adding a topic is a
reviewed change to the list: never a phrase that could be someone's name.

## How a watch starts

1. The member asks in a conversation ("let me know if the Planning Commission
   takes up short-term rentals").
   - With watches on, a signed-in member's answer can call `offer_watch`
     (`src/tools.js`).
   - It takes topic ids from the list (an enum) and/or a civic league, never
     free words.
2. The answer gets a card showing the chosen topics as checkboxes. The model
   can't start a watch; it is told never to say one is set up.
3. On the card the member types the email they signed in with. The Worker
   checks that address against the account: the account id is
   HMAC(INVITE_SECRET, "user:" + email), so only the address that signed in can
   be watched, and no confirmation email is needed.
4. The watch is stored as `watch:<id>` in KV. The response lists what's already
   on a posted agenda, described; the first email lists those items too.

The Watches page (`/watches`) lists a member's watches, starts new ones (every
topic as a checkbox), renews one for a year, or stops one.

## The daily read

The cron runs every ten minutes. `runWatchJob` (`worker/watches.js`) runs once
a day: at 11:00 UTC or later, or at once when there is no snapshot yet. It:

1. Reads the Public Meeting Notices (`dszu-h9cf`) for the next 21 days of the
   bodies in `meetings.watchBodies`.
2. Fetches each meeting's iqm2 page, whose agenda items are titled links.
   Agendas appear about a week before a meeting.
3. Describes each item as above: its kind, number, topics and addresses. The
   title is not kept.
4. Tags each item with the civic league of each address, from the City's
   address list (`ere7-kake`):
   - It reads the `civic_league` column only, at plugin access, so the
     league president's name and email are refused in code.
   - Many commercial addresses (much of Granby Street, Newtown Road, East
     Virginia Beach Boulevard) are in no civic league in the City's own list.
     Their items are in the citywide feed only.
   - Lookups are cached 90 days per address.
5. Keeps the result as `agenda-snapshot:<city>` for four days. Each item keeps
   when it was first seen. A meeting whose page can't be read that day keeps
   the day before's items, so an outage doesn't empty the feeds.
6. With watches on, mails each watch the items it matches and hasn't been sent:
   - **one digest a day per watch**, with a `List-Unsubscribe` one-click stop
     (RFC 8058);
   - **watches at their end go first**: each gets a note if the day's cap
     allows, and is deleted, with its email, either way;
   - **re-read before mailing and before writing**: a stop or a renewal made
     while the run is going wins, and a stopped watch is never written back;
   - **one write per key per run**: KV refuses a second write to a key within
     a second. Each watch is written at most once a run, the day's mail count
     once at the end, and the run lock once. The lock lasts fifteen minutes,
     judged by its own expiry, and is never deleted.
   - **Resend busy or down** (429, 5xx, a timeout): the round stops; the rest
     wait for tomorrow, unsent and unmarked;
   - **Resend refuses** (another 4xx): nothing is marked on the watch, since a
     revoked key or an unverified domain looks the same. Three refusals in a
     row stop the round.

A live run on 2026-11-16 took 5 seconds and 11 requests: five meetings, one of
them with a posted agenda of 19 items. A short-term-rental watch matched both
of that hearing's short-term-rental items. 13 of the 19 got a civic league.

## What is kept, and where

- **The member's email:** in each watch, AES-GCM encrypted with a key derived
  from INVITE_SECRET and bound to the watch's id. A watch stops when:
  - the member stops it, on the Watches page or by its stop link;
  - it reaches a year without being renewed.

  Then the watch is deleted, and the email with it. The email is never logged,
  returned or shown. It is the one thing watches keep that sign-in doesn't;
  the chat page's privacy line says so while watches are on.
- **The watch:** its topics, league, bodies, dates, how many emails, the last
  400 item keys sent, and the account id (`u`, already an HMAC).
- **The snapshot:** for each item, its kind, number, topics, addresses,
  leagues, link and meeting. No title.

## What it can miss

- **Titles only.** It matches topics in titles. An item can affect a topic
  without naming it: a Zoning Ordinance text amendment touching short-term
  rentals may say only "text amendment". The email says so.
- **Near misses.** A topic phrase can catch an item that's beside the point: a
  commercial recreation center under Parks. The link shows what it really is.
- **Same-day agendas.** An agenda posted and heard within one day could be
  missed. In practice agendas go up days ahead.
- **Addresses in no league.** Their items are only in the citywide feed, and
  only a watch without a league finds them.

## Limits

- **Per member:** 5 watches (`MAX_PER_ACCOUNT`), 1 to 8 topics each. A watch
  runs 365 days unless renewed.
- **Site-wide:** `WATCH_MAX` watches (default 200) and `WATCH_DAILY_EMAILS`
  emails a day (default 100). Set the email cap under the Resend plan's daily
  limit, with room for sign-in links. `"0"` pauses mail; `WATCH_MAX = "0"`
  takes no new watches.
- **Requests:** about 11 requests a day, counted on their own budget of 300.
- **Known gap:** the per-member cap and the duplicate check read a KV listing,
  which can lag a few seconds. Two starts in quick succession could pass
  either.

## Turning it on

1. Email sign-in must already work (RESEND_API_KEY, LOGIN_FROM, INVITE_SECRET)
   and PUBLIC_ORIGIN must be set. Siren has all four.
2. Set `WATCHES = "true"` and/or `LEAGUE_FEEDS = "true"` in `[env.siren.vars]`
   and deploy. Within ten minutes the cron builds the first snapshot. Until
   then `/feeds` answers 503 and a league watch is refused, with a reason.

## Decisions taken as defaults (Jason's to change)

- **Storing the email**, encrypted, while a watch exists. Without it there are
  no email watches.
- **Who can watch:** members only, meaning signed in with a bound invite.
- **Which bodies:** City Council and the Planning Commission. The Board of
  Zoning Appeals and the Architectural Review Board would be one line each.
- **The topic list:** 27 topics drawn from the legislation index's own wording,
  in `src/cities/norfolk.js`.
- **The numbers:** 5 watches, 365 days, 100 emails a day, one digest a day,
  three weeks ahead.
