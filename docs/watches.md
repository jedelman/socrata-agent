# Watches and civic-league feeds

Jason, 2026-11-16: "I'd like for people to be able to ask something like 'let
me know if planning commission or City Council take up any items affecting
short term rentals' and get an email." And, of the public per-street feeds he
had approved: "Let's shift from per street to per neighborhood league."

Two features share one daily read of the City's posted agendas:

- **Watches** (`WATCHES = "true"`): a signed-in member keeps up to five
  watches. A watch is topic terms, a civic league, or both, over City Council
  and/or the Planning Commission. When a newly posted agenda item matches, the
  member gets one email that day.
- **Civic-league feeds** (`LEAGUE_FEEDS = "true"`): a public Atom feed per
  civic league, plus one for every item, at `/feeds`.

Both are off by default. With both off, no route, page, prompt, tool list or
session body changes (`test/watches-worker.test.js`, and the free tier's
flag-off snapshot), and the cron does nothing new.

## How a watch starts

1. The member asks in a conversation ("let me know if the Planning Commission
   takes up short-term rentals"). With watches on, a signed-in member's answer
   can call `offer_watch` (`src/tools.js`). The model gives terms as agenda
   titles word them, the City's synonyms included ("short-term rental",
   "vacation rental", "homestay", "bed and breakfast"), and/or a civic league.
2. Code checks the watch (`checkWatch` in `src/watches.js`) and the answer
   gets a card. The model can't start a watch; it is told never to say one is
   set up.
3. On the card the member edits the terms and types the email they signed in
   with. The Worker checks that address against the account: the account id is
   HMAC(INVITE_SECRET, "user:" + email), so only the address that signed in
   can be watched, and no confirmation email is needed.
4. The watch is stored (`watch:<id>` in KV). The response lists what's already
   on a posted agenda; the first email lists those items too.

The Watches page (`/watches`) lists a member's watches, starts new ones, renews
one for a year, or stops one.

## The daily read

The cron runs every ten minutes. Once a day, at 11:00 UTC or later (or at once
when there is no snapshot yet), `runWatchJob` (`worker/watches.js`) does this:

1. Reads the Public Meeting Notices (`dszu-h9cf`) for the next 21 days of the
   bodies in the city profile's `meetings.watchBodies`.
2. Fetches each meeting's iqm2 page, whose agenda items are titled links.
   Agendas appear about a week before a meeting; a meeting with nothing posted
   yet has no items, and is read again the next day.
3. Withholds private people's names from each title (`withholdNames`), in
   three layers, each erring on the side of withholding:
   - **The Planning Commission's applicant**, which opens its titles in capitals
     ("JANE DOE, for a Conditional Use Permit …", or "…, to rezone …"), is
     withheld unless plainly an organization. That is `get_legislation`'s
     rule, judged on every "and"-joined party, so a person named beside an LLC
     is withheld. A revocable, living or family trust, or an estate, counts as
     a person.
   - **The places Council titles name a party**, read from the legislation
     index:
     - a sale or conveyance to;
     - an encroachment granted or permitted to;
     - a lease, license, easement or agreement with;
     - a tenant;
     - a refund;
     - a bidder;
     - a conveyance from someone to the City.

     The party is withheld unless plainly an organization or government, when
     it holds a proper noun.
   - **Anywhere, a person-shaped run:** a name with a middle initial ("Glen L.
     East"), or two or more proper nouns where a title names a party (after
     "to", "and", "by", "with", "Authorizing", "Granting" and the like), with
     "Jr." and the like. A proper noun is a capitalized word the City's books
     never use in lower case that isn't a place or an organization word. A run
     before an organization, institution or program word ("Harrison Opera
     House", "Edward Byrne Memorial Grant"), before a number ("Reordain
     Chapter 34.2"), or in quotes (an establishment's or event's name) is
     kept. So are "N.", "S.", "E." and "W." before a street, read as
     directions. A name after a courtesy title is withheld too.

   A title's "Staff Contact: … email" trailer is dropped.

   Over all 1,452 titles in the legislation index, this withholds 125, nearly
   all of them people: buyers of City lots, tenants, encroachment holders and
   Planning Commission applicants. A few businesses not plainly named as one
   ("PETCO Love", "Flock Safety") are withheld too, which errs on the safe
   side. The name-shaped spans left are organizations, places and programs
   ("Verizon Virginia", "Mowbray Arch", "King's Daughters"). It's a
   heuristic: a name in a form the index doesn't hold yet could get through,
   which is why matching and terms have their own guards (below).
4. Tags each item with the civic league of each address its title names, from
   the City's address list (`ere7-kake`). It reads the `civic_league` column
   only; the league president's name and email in that dataset are never read.
   An address that doesn't match exactly one row gets no league. Many
   commercial addresses (much of Granby Street, Newtown Road, East Virginia
   Beach Boulevard) are in no civic league in the City's list; their items are
   only in the citywide feed. League lookups are cached 90 days per address
   and run at plugin access, so the dataset's denied columns are refused in
   code.
5. Keeps the result as `agenda-snapshot:<city>` (four days), with each item's
   first-seen time carried over. A meeting whose page can't be read that day
   keeps the day before's items, so an outage doesn't empty the feeds.
6. With watches on, mails each watch the items it matches and hasn't been
   sent. It's one email per watch per day, with a `List-Unsubscribe` one-click
   stop (RFC 8058). A watch remembers the last 400 items it sent.
   - **KV writes:** KV refuses a second write to a key within a second, so each
     key is written at most once a run. Each watch is written once, the day's
     mail count once at the end, and the run lock once (it expires in five
     minutes, by its own clock and KV's).
   - **Busy mail service:** if Resend is busy or down (429, 5xx, a timeout), the
     round stops, and the rest wait for tomorrow, unsent and unmarked.
   - **Refused address:** only Resend's refusal of an address (another 4xx)
     counts against a watch. Five in a row stop it.
   - **Watches at their end** get their note before anything else, even when
     their city is no longer served.

A live run on 2026-11-16 took 13 seconds and 10 requests: five meetings, one
of them with a posted agenda of 19 items. Both short-term-rental items matched,
and 13 of 19 items got a civic league; the rest had no address or an address in
no league.

## What is kept, and where

- **The member's email:** in each watch, AES-GCM encrypted with a key derived
  from INVITE_SECRET and bound to the watch's id, until the watch stops. A
  watch stops when the member stops it (on the Watches page or by its stop
  link), when it reaches a year without being renewed, or when Resend refuses
  the address five days running. The email is never logged, returned or
  shown. This is the one thing watches keep that sign-in doesn't; the chat
  page's privacy line says so while watches are on.
- **The watch:** its terms, league, bodies, dates, how many emails, the last
  400 item keys sent, and the account id (`u`, already an HMAC).
- **The snapshot:** public agenda titles with applicants withheld, meeting
  times and places, and civic-league tags. Shared by the feeds and the watches.

## No people-finding

- **Terms:** a term must be ordinary words: words Norfolk's Zoning Ordinance
  and adopted budget books use in lower case (`ordinaryWords` in
  `worker/telemetry.js`), plus a short reviewed list of topics the books only
  capitalize (kennel, brewery, hookah, mural, seawall) and short words.
  - That keeps out names that are only names. The review of #62 found 25 of
    121 common surnames passing the old any-case vocabulary (harris, thomas,
    taylor…). Now 13 pass, all of them also words (white, young, green, wood,
    gray, price, long, foster, west, stone, park, grant, banks).
  - It also keeps out proper-noun streets (granby, colley).
  - A term must pass the public-text checks, and can't be a street with its
    suffix, a house number or a civic league's name.
- **Matching:** items are matched on the title with private people's names
  already withheld. So a watch on a name that is also a word ("park") can't
  match the person: it won't match "JOHN PARK, for a Conditional Use Permit
  …" (`test/watches.test.js`). Feeds and emails carry only withheld titles,
  and the feeds send `X-Robots-Tag: noindex`.
- **Places:** civic leagues, not streets. A short street can be one or two
  houses, while a league is hundreds; the tiny leagues are no smaller than the
  public agenda item itself, which names the property.

## What it can miss

- It matches agenda titles only. An item can affect a topic without naming it.
  A Zoning Ordinance text amendment touching short-term rentals may say only
  "text amendment". The email says so.
- An agenda posted and heard within one day could be missed. In practice
  agendas are posted days ahead.
- An item whose address has no league in the City's list is only in the
  citywide feed, and only a league-less watch finds it.

## Limits

- **Per account:** 5 watches (`MAX_PER_ACCOUNT`). A watch has 1 to 8 terms of
  at most 4 words each, and runs 365 days unless renewed. When it ends, the
  member gets a note.
- **Site-wide:** `WATCH_MAX` watches (default 200), and `WATCH_DAILY_EMAILS`
  emails a day (default 100). Set the email limit under the Resend plan's
  daily limit, with room for sign-in links. Mail past the cap waits for the
  next day.
- **Requests:** the daily read makes about 10 requests, counted on its own
  budget of 300.
- **Zero:** `WATCH_DAILY_EMAILS = "0"` pauses mail, and `WATCH_MAX = "0"` takes
  no new watches.
- **Known gap:** the per-member cap and the duplicate check read a KV listing,
  which can lag a few seconds. Two starts in quick succession could pass
  either check.

## Turning it on

1. Email sign-in must already work (RESEND_API_KEY, LOGIN_FROM,
   INVITE_SECRET) and PUBLIC_ORIGIN must be set. Siren has all four.
2. Set `WATCHES = "true"` and/or `LEAGUE_FEEDS = "true"` in
   `[env.siren.vars]` and deploy. Within ten minutes the cron builds the first
   snapshot. Until then `/feeds` answers 503 and a league watch is refused,
   with a reason.

## Decisions taken as defaults (Jason's to change)

- **Storing the email**, encrypted, while a watch exists. The alternative is no
  email watches at all.
- **Who can watch:** members only, meaning signed in with a bound invite.
  Opening it to waitlisted people would need a double opt-in email instead of
  the account check.
- **Which bodies:** City Council and the Planning Commission, the two Jason
  named. The Board of Zoning Appeals and the Architectural Review Board would
  be one line each in the city profile.
- **The numbers:** 5 watches, 365 days, 100 emails a day, one digest a day,
  three weeks ahead.
