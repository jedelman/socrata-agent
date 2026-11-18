# Watches and civic-league feeds

Jason, 2026-11-16: "I'd like for people to be able to ask something like 'let
me know if planning commission or City Council take up any items affecting
short term rentals' and get an email." And, of the public per-street feeds he
had approved: "Let's shift from per street to per neighborhood league."

Two features share one daily read of the City's posted agendas:

- **Watches** (`WATCHES = "true"`): a signed-in member keeps up to five
  watches. A watch is topics from the city's reviewed list, phrases of their
  own, a street, a civic league, or a mix, over any of City Council, the
  Planning Commission, the Board of Zoning Appeals and the Architectural
  Review Board. When a newly posted agenda item matches, the member gets one
  email that day.
- **Civic-league feeds** (`LEAGUE_FEEDS = "true"`): a public Atom feed per
  civic league, plus one for every item, at `/feeds`.

Both are off by default. With both off, no route, page, prompt, tool list or
session body changes (`test/watches-worker.test.js`, and the free tier's
flag-off snapshot), and the cron does nothing new.

## Names: in content, never as a watch's key

Jason, 2026-11-18: "Let's keep the name guard on watches but allow names
through in content - titles and descriptions. This is mostly an
anti-harassment precaution, for the record; if that risk is cleared in another
way we can adjust." A public agenda item is a public record.

So emails, feeds and the watch pages quote each item as the City posted it
(`quoteItem` in `src/watches.js`): its title, and the City's description of
it (the request and description of an item page's cover letter; an agenda
file's item is all title). Each quote is credited to the City, with a link to
the City's page and the source annotation, and has Siren's summary under it
(below). The analysis and financial-impact sections, and the cover letter's
applicant section, aren't shown; attachments are never read.

What stays is the guard on what a watch can follow: a phrase made only of
common names, or a name beside anything but ordinary words, is refused (below).
That's the anti-harassment precaution: with names in the emails, a watch keyed
on a name would be a standing alert on a person. A rare surname alone still
passes (the guard's stated limit).

The cover-letter reader (`parseTransmittal`, shared with chat's
`get_legislation`) still puts "the applicant" in place of a private
applicant's name: Jason's 2026-11-11 call, not changed here.

Two limits on what is read for matching, from the sixth review:
- **A cover letter stops where its end matter starts** ("V.
  Communications/Outreach", "Staff contact", "Attachments", "Proponents and
  Opponents"). Before, a section could run on into the hearing's list of
  speakers, with their names and home addresses (item 5878 on the Oct 27
  Council agenda). That list is kept nowhere now, in watches or in chat's
  `get_legislation`.
- **A phrase never matches the applicant's name that leads a BZA entry or a
  land-use title** ("JANE DOE – for a variance …"; `withoutApplicant`). BZA
  applicants are almost all homeowners, so a rare surname can't follow one.
  The name is still quoted, as the City posted it.

### Siren's summary, and the history behind it

Until 2026-11-18 titles were never repeated, and this summary was all an item
showed. The reasoning then:

Agenda titles can name private people: the buyer of a City lot ("Conveyance
to … of That Certain Parcel"), a tenant, a person granted an encroachment, a
Planning Commission applicant. An earlier version of this PR tried to withhold
names from titles. Two independent reviews found it leaking in shape after
shape:
- names that are ordinary words (Will Price, Hope Wells);
- Title Case titles;
- mixed-case applicants;
- "Easement From … Over".

So the design changed then: Siren never repeated an agenda title. Each item is
described from parts code extracts (`src/watches.js`), and that description is
now the summary under the City's words:

- **the kind of action**: one of a fixed list of labels ("Conditional Use
  Permit", "Sale of City property", "Rezoning", "Lease", …);
- **the topics it matches**: from the city's reviewed list;
- **the addresses** the item names (its title, the request in its cover
  letter, or an agenda file's entry), and only those on the City's address
  list: that house number on that street (`titlePlaces`, below). Money comes
  out of the title first. A title's "$5,000 From Mary Lane" or "$5,000 Betty
  Lane Scholarship" isn't an address; the third and fourth reviews showed the
  plain extractor would have let these through;
- **its ordinance or resolution number**;
- **a link to the City's own page** for the item, which has the full text.

For example: "Conditional Use Permit: Short-term rentals, at 1210 Virgilina
Avenue". A test runs over all 1,452 titles in the legislation index. It checks
that every address shown is on the City's address list, and that every word
of every description is a word of a fixed label, a number, or a word of the
street that address was found on. It runs the reviewers' probes too
(`test/watches.test.js`).

## Streets named for people: the address list

Jason, 2026-11-16: "How do we know we're not getting false positives on
names, since so many streets are named after people? (A trie whitelist built
from the address db is my answer)". Measured that day, the false positives ran
both ways:

- **Names read as addresses.** Checking a title's address against the list of
  street *names* let through a number followed by any street's name: 17 of the
  877 addresses descriptions showed weren't addresses on the City's list. None
  of the 17 was a person's name, but the check couldn't promise that.
- **Streets read as names.** The phrase guard refused 576 of the City's 1,941
  street names ("hampton", "washington", "duke") as people's names.

So watches carry the City's own address list, `data/norfolk-addresses.json`,
built by `scripts/build-addresses.js` from Address Information (`ere7-kake`).
It holds every house number on every street, 78,552 on 2,209 streets, each with
its civic league (118 of them). It's two columns of the City's list,
`full_address` and `civic_league`, and holds no names. It weighs 645 KB, 197 KB
gzipped, and compiles in about 17 ms the first time an isolate uses it.

- **An address reaches a description only when that house number is on that
  street in the list** (`compileAddresses` and `titlePlaces` in
  `src/watches.js`). Street, then number: the trie Jason proposed. Abbreviations,
  apostrophes and "St." for Saint are matched the way the list spells them.
  The direction is the only thing allowed to differ:
  - "628 West 35th Street" is 628 35TH STREET on the list, which has no West
    35th Street. A direction is let go only when the list has no street of
    that direction: "102 North Blake Road" isn't 102 BLAKE ROAD, since NORTH
    BLAKE ROAD is a street of its own.
  - "482 Main Street" is 482 E MAIN STREET, because only the East side has a
    482. When both sides have the number, nothing is guessed.
- **A description shows at most the first 12 listed addresses**, and an item's
  streets and civic leagues come from those 12 only.
- **An item's civic league comes from the list**, so the daily job asks the
  portal nothing per address.
- **A street's name is watched as that street.** Some phrases are refused for
  reading as a name or for holding a number. When one of those is a street of
  the list ("hampton", "21st street"), it becomes a street watch instead:
  - It matches items whose listed address is on that street, never words in a
    title. So "hampton" catches 1209 Hampton Boulevard and can never catch a
    lease with someone named Hampton.
  - A word that is both a common surname and a street ("church", "park") was
    refused before the list; now it watches that street. Its label says
    "(street)".
- **A phrase the guard passes stays a phrase**, matched in titles ("granby"
  still catches a Granby Street streetscape item that names no address).
  - One that names a street with its type ("hampton boulevard", "colley ave")
    also matches by listed address, so a title's "1209 Hampton Blvd." is
    caught too.
  - One without a type doesn't: "granby" never matches an item just for its
    Granby Street address.

Measured on 2026-11-16, over the 883 addresses the indexed titles name:
- **On the list:** 860 are shown.
- **Not on the list:** 23 are dropped. They're typos ("Berkeley Avenue"),
  streets outside the city ("Nansemond Parkway"), the extractor's misreads
  ("20 Foot Lane"), and numbers the list doesn't carry.

Of the 1,941 street names, 553 are now watched as streets and 1,365 as phrases.
The other 23 are also the names of civic leagues ("Bayview", "Ocean View"), and
a league's name is taken as the league to watch (Jason, 2026-11-18: "a pretty
common ask").

Tests check every street name and every indexed title against the list
(`test/watches.test.js`), and the builder (`test/build-addresses.test.js`).

**Keeping it current.** `.github/workflows/refresh-addresses.yml` rebuilds the
list every Thursday. `scripts/build-addresses.js --compare` then decides where
it goes:
- **To main**, after the watch tests pass against the new list, when only
  addresses came, went or changed league.
- **To a pull request** when a civic league was added, removed or renamed.
  That changes a feed's address, and a watch on a removed league stops
  matching. Also when more than 2% of the addresses are gone, which looks more
  like a short read from the portal than the City's list.

To refresh it by hand, run `node scripts/build-addresses.js`.

**Watches follow topics, and a member's own phrases.**
- **Topics:** a watch can pick from the city profile's `meetings.watchTopics`,
  27 topics for Norfolk, each with the phrases it matches. "Short-term
  rentals" matches short-term rental, vacation rental, homestay and bed and
  breakfast, which is 159 titles since July 2023. A test refuses any topic
  phrase made only of common names; "ADU" and "flood" were dropped for this.
- **Streets:** a phrase refused as a name or for a number, that is a street's
  name, is watched as that street, by listed address (above). Phrases and
  streets together are at most five.
- **Phrases:** a watch belongs to one signed-in member and mails only them.
  Jason, 2026-11-16: "Free text for signed in and private conversations feels
  like the right shape." So a member can add up to five phrases of their own
  ("dog park"), matched against the title and the City's description of the
  item. A phrase is refused when it (unless
  it is a street's name, above):
  - is made only of common first names and surnames, plurals included
    (Census lists, `data/common-names.json`, built by
    `scripts/build-common-names.js`): "John Smith", "price", "smiths";
  - has a common name beside anything but ordinary words: "john zelinski",
    "jason edelman", "j smith". Ordinary words are the ones the City's books
    use in lower case;
  - has a common name beside a title or an entity word: "mr smith",
    "smith llc", "estate of smith";
  - holds a number, an address or contact details.

  Without the name list, the vocabulary or the text check, no phrase is
  accepted.

  A civic league's name is never refused, whatever its length, and needs none
  of those lists: it's on the City's own list of leagues, and it becomes the
  watch's league. That narrows the watch rather than adding to it ("norview"
  with "dog park" is dog park items in Norview), so the confirmation, the card
  and the model's tool result say so. When the league's name is also a
  street's ("bayview"), they say to write the street with its type to follow
  the street instead. Two leagues in one watch are refused; start one watch
  for each.

  This is a guard, not a wall. A rare surname alone ("zelinski") gets through.
  It then works as a search of upcoming titles (the new watch shows what's
  already posted) and as alerts for a year: what `find_legislation` already
  does in a private conversation, made standing. That's the cost of free text
  (Jason's call). Feeds never use phrases.

## How a watch starts

1. The member asks in a conversation ("let me know if the Planning Commission
   takes up short-term rentals").
   - With watches on, a signed-in member's answer can call `offer_watch`
     (`src/tools.js`).
   - It takes topic ids from the list (an enum), and phrases when no topic
     fits, and/or a civic league.
2. The answer gets a card with the chosen topics as checkboxes and the
   phrases in a box the member can edit. The model can't start a watch; it is
   told never to say one is set up.
3. On the card the member types the email they signed in with. The Worker
   checks that address against the account: the account id is
   HMAC(INVITE_SECRET, "user:" + email), so only the address that signed in can
   be watched, and no confirmation email is needed.
4. The watch is stored as `watch:<id>` in KV. The response lists what's already
   on a posted agenda, described; the first email lists those items too.

The Watches page (`/watches`) lists a member's watches, starts new ones (every
topic as a checkbox, and a phrases box), renews one for a year, or stops one.

## The daily read

The cron runs every ten minutes. `runWatchJob` (`worker/watches.js`) runs once
a day: at 11:00 UTC or later, or at once when there is no snapshot yet. It:

1. Reads the Public Meeting Notices (`dszu-h9cf`) for the next 21 days of the
   bodies in `meetings.watchBodies`.
2. Fetches each meeting's iqm2 page, whose agenda items are titled links.
   Agendas appear about a week before a meeting.
3. Reads the full agenda, not just titles (Jason, 2026-11-18: "Titles are
   often not descriptive at all"):
   - **Council and Planning Commission items:** each item's own page, four at
     a time. That page has the full title and the City's cover letter
     (request, description, analysis, financial impact; `parseTransmittal`
     leaves out the applicant section and withholds a private applicant's
     name). Attachments are never read: their titles can name letter writers.
     On the Oct 27 Council agenda, 14 of 15 items had a cover letter; a
     title like "Ordinance No. 50537: An Ordinance Approving and Authorizing
     the City Manager to …" gets "a utility easement … over the property
     located at 150 Park Avenue" from it.
   - **BZA and ARB:** their iqm2 pages list no items; the agenda is a posted
     PDF ("Agenda", never the "Agenda Packet", which runs past 100 MB). It is
     read by `src/pdf.js`, a PDF text reader with no dependencies, and split
     into items by `src/agenda-file.js` (numbered or lettered entries under
     roman-numeral sections; procedure such as roll call is dropped). On
     three real agendas it matched pdftotext word for word, but for line-break
     hyphens. It reads page by page, so the page's own header and footer are
     skipped when an item runs across the break, and a line that only looks
     like a heading doesn't end an item mid-sentence ("on property located
     at 7418" / "N. Military Highway"). A line starting with a citation
     ("3.2.9.B of the …") or "e.g." starts nothing, a lettered sub-item
     stays with its numbered item, and an entry with no number is kept when
     it reads as one (an applicant's "– for …", or a case number). Rewrapping
     the real items at every width from 50 to 110 characters changes none of
     them. A file item is keyed by the City's case number when it has one
     ("COA #26-00439"), else by a hash of its letters and digits, so a
     rewrap or a new page break doesn't make it new.
4. Describes each item as above: its kind and number from its title; its
   topics from its title and from the description, less what describes the
   property's zoning district or cites the ordinance (`topicText`: "zoned
   MF-NS (Multi-Family – …)" is not multi-family housing); its addresses from
   both, through the address list. The title, the description and the full
   text are kept in internal fields, for phrases; nothing serves them.
5. Notes each item's source: `{ publisher: "City of Norfolk", record:
   "public", document: "agenda item page" | "agenda file", url, read }`
   (Jason, 2026-11-18: keep sources annotated by what's public). Feeds show it.
6. Tags each item with the civic league of each address, from the address
   list the Worker carries (above), so no address is looked up:
   - The list holds the `civic_league` column only, never the league
     president's name and email.
   - The list's own "No Civic League" value counts as no league, not as a
     league with a feed.
   - Many commercial addresses (much of Granby Street, Newtown Road, East
     Virginia Beach Boulevard) are in no civic league in the City's own list.
     Their items are in the citywide feed only.
5. Keeps the result as `agenda-snapshot:<city>` for four days. Each item keeps
   when it was first seen. A meeting whose page can't be read that day keeps
   the day before's items, placed again against the current address list, so
   an outage doesn't empty the feeds.
6. With watches on, mails each watch the items it matches and hasn't been sent:
   - **one digest a day per watch**, with a `List-Unsubscribe` one-click stop
     (RFC 8058);
   - **watches at their end go first**: each gets a note if the day's cap
     allows, and is deleted, with its email, either way;
   - **the job never writes a watch**: what a watch has been sent goes in its
     own key (`watch-sent:<id>`). KV reads are cached at each location for
     about a minute, so the job could be holding a stale copy; with a separate
     key, that copy can't be written back to undo a stop or a renewal made
     elsewhere. A stop clicked within that minute before the run may still
     see one more email;
   - **every watch key expires** a week after the watch ends. The watch and
     its email go even if the job never runs again. A sent key lasts until
     the watch's end plus a week, or a month from its last write, whichever
     is later, so a renewal can't lose what's been sent;
   - **an ended watch is re-read before it's deleted**, so a renewal made just
     before the run survives;
   - **one write per key per run**: KV refuses a second write to a key within
     a second. Each sent key is written once a run. The day's mail count is
     written at most every two seconds, and once at the end. The run lock is
     written once: it lasts fifteen minutes, is judged by its own expiry, and
     is never deleted;
   - **a new order each day**, so no fixed set of watches always comes first;
   - **the idempotency key comes from the items sent**, so the same items to
     the same watch are one mail to Resend for a day, even across runs. A 409
     (Resend already has that key) is recorded as sent;
   - **Resend busy or down** (429, 5xx, a timeout): the round stops; the rest
     wait for tomorrow, unsent and unmarked;
   - **Resend refuses** (another 4xx): nothing is marked on the watch, since a
     revoked key or an unverified domain looks the same. Three refusals before
     any mail goes through stop the round, since that's the setup, not an
     address.

A live run on 2026-11-16, before the address list, took 5 seconds and 11
requests: five meetings, one of them with a posted agenda of 19 items. A
short-term-rental watch matched both of that hearing's short-term-rental items.
13 of the 19 got a civic league. The address lookups in those 11 requests are
gone now: a run is the notices query and one page per meeting.

## What is kept, and where

- **The member's email:** in each watch, AES-GCM encrypted with a key derived
  from INVITE_SECRET and bound to the watch's id. A watch stops when:
  - the member stops it, on the Watches page or by its stop link;
  - it reaches a year without being renewed.

  Then the watch is deleted, and the email with it. The email is never logged,
  returned or shown. It is the one thing watches keep that sign-in doesn't;
  the chat page's privacy line says so while watches are on.
- **The watch:** its topics, phrases, league, bodies, dates, and the account
  id (`u`, already an HMAC). Its sent key holds how many emails and the last
  400 item keys sent.
- **The snapshot:** for each item, its kind, number, topics, listed addresses
  and their streets, leagues, link and meeting, its source, and the City's
  title and description (quoted in emails and feeds) and full text (for
  phrases only).

## What it can miss

- **What the City wrote.** It matches topics in titles and the City's
  descriptions. An item can affect a topic without naming it; the email says
  so. A Planning Commission item's page may add nothing: on the Nov 19
  hearing every page's title was the agenda's link, which already carries a
  "The purpose of this request is …" sentence, while on the Oct 22 hearing 9
  of 10 items had a cover letter. An agenda file gives only its one entry per
  item.
- **A file it can't read.** An encrypted PDF, a scanned one (no text), or a
  font with no map to Unicode gives no items, or fewer; nothing is guessed.
- **Near misses.** A topic phrase can catch an item that's beside the point: a
  commercial recreation center under Parks. The link shows what it really is.
- **Same-day agendas.** An agenda posted and heard within one day could be
  missed. In practice agendas go up days ahead.
- **Addresses in no league.** Their items are only in the citywide feed, and
  only a watch without a league finds them.
- **Addresses the extractor misses.** Some title shapes defeat it: ", and"
  lists, "2706 Through 2722 …", a street whose suffix is dropped ("3411
  Sewells Point"). Those items get no address and no league.
- **Addresses not on the City's list.** A typo, a street outside the city or a
  number the list doesn't carry gets no address and no league (23 of 883
  measured), and so does an address whose direction the title leaves out when
  both sides of the street have that number.

## Limits

- **Per member:** 5 watches (`MAX_PER_ACCOUNT`), up to 8 topics and 5
  phrases each. A watch runs 365 days unless renewed.
- **Site-wide:** `WATCH_MAX` watches (default 200) and `WATCH_DAILY_EMAILS`
  emails a day (default 100). Set the email cap under the Resend plan's daily
  limit, with room for sign-in links. `"0"` pauses mail; `WATCH_MAX = "0"`
  takes no new watches.
- **Requests:** the notices query, one page per meeting, one page per Council
  and Planning Commission item (at most 600) and one request per agenda file,
  counted on their own budget of 800. A full three weeks is about 200.

## Reads, and the City's caching rules

Jason, 2026-11-18: "caching reads ... and respecting invalidation". Siren uses
plain `fetch`, which keeps no HTTP cache in Node, and in Workers Cloudflare
caches a subrequest by its URL's file extension (an `.aspx` link isn't one).
So `src/http-cache.js` applies the HTTP rules itself:
- **Validators:** what was made of a file (its items, never its bytes) is kept
  with its `ETag` and `Last-Modified`, which go back as `If-None-Match` and
  `If-Modified-Since`. A 304 reuses it with no body sent.
- **Freshness:** a `max-age` or a future `Expires` means no request until it
  passes, less any `Age` the response already spent in caches.
- **`no-store`:** nothing is kept, and every read is a full GET. A response
  with neither validators nor a lifetime drops what was kept.
- **The reader's version** is part of the key, so a change to `src/pdf.js` or
  `src/agenda-file.js` reads every file again rather than waiting for the City
  to change it.
- **Size:** a body is refused past the cap (5 MB for an agenda file), before
  reading it when its `Content-Length` says so, and as it arrives when it
  doesn't.

This is one request whether or not the file changed. A HEAD and then a GET
would be two whenever it had, and Cloudflare's cache may send a HEAD on as a
GET anyway.

What the City sends, checked 2026-11-18:
- iqm2's agenda files send `Last-Modified` and answer a conditional GET with a
  304. A live run read the Planning Commission's file at 200, then at 304.
- Its meeting and item pages send `no-cache, no-store` and no validators, so
  they are read every day.
- A Socrata query's `ETag` never comes back 304, so the notices query is read
  every day too.
- **Known gap:** the per-member cap and the duplicate check read a KV listing,
  which can lag a few seconds. Two starts in quick succession could pass
  either.

## Turning it on

1. Email sign-in must already work (RESEND_API_KEY, LOGIN_FROM, INVITE_SECRET)
   and PUBLIC_ORIGIN must be set. Siren has all four.
2. Set `WATCHES = "true"` and/or `LEAGUE_FEEDS = "true"` in `[env.siren.vars]`
   and deploy. Within ten minutes the cron builds the first snapshot. Until
   then `/feeds` answers 503.

## Decisions

Confirmed by Jason, 2026-11-18: "Encrypted at rest email is the right shape"
and "Numbers look good."

- **Storing the email**, encrypted, while a watch exists. Without it there are
  no email watches.
- **Who can watch:** members only, meaning signed in with a bound invite.
- **Which bodies:** City Council, the Planning Commission, the Board of Zoning
  Appeals and the Architectural Review Board (the last two from their agenda
  files, Jason 2026-11-18).
- **Phrases:** free text for a member's own watches, with the common-names
  guard (Jason, 2026-11-16), and a street's name watched as that street, from
  the address list (Jason's trie, the same day).
- **The topic list:** 27 topics drawn from the legislation index's own wording,
  in `src/cities/norfolk.js`.
- **The numbers:** 5 watches, 365 days, 100 emails a day, one digest a day,
  three weeks ahead.
