# Watches and civic-league feeds

Jason, 2026-11-16: "I'd like for people to be able to ask something like 'let
me know if planning commission or City Council take up any items affecting
short term rentals' and get an email." And, of the public per-street feeds he
had approved: "Let's shift from per street to per neighborhood league."

Two features share one daily read of the City's posted agendas:

- **Watches** (`WATCHES = "true"`): a signed-in member keeps up to five
  watches. A watch is topics from the city's reviewed list, phrases of their
  own, a street, a civic league, or a mix, over City Council and/or the
  Planning Commission. When a newly posted
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

So the design changed. **Siren never repeats an agenda title**, in a feed, an
email or a response. (The snapshot keeps each title in one internal field,
only to match members' phrases against; nothing reads it out.) Each item is
described from parts code extracts (`src/watches.js`):

- **the kind of action**: one of a fixed list of labels ("Conditional Use
  Permit", "Sale of City property", "Rezoning", "Lease", …);
- **the topics it matches**: from the city's reviewed list;
- **the addresses** its title names, and only those on the City's address
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
  street names ("hampton", "colley") as people's names.

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
  The direction is the only thing allowed to differ: "628 West 35th Street" is
  628 35TH STREET on the list, and "482 Main Street" is 482 E MAIN STREET,
  because only the East side has a 482. When both sides have the number,
  nothing is guessed.
- **An item's civic league comes from the list**, so the daily job asks the
  portal nothing per address.
- **A street's name is watched as that street.** A phrase the name guard
  refuses that is a street of the list ("hampton", "21st street") becomes a
  street watch: it matches items whose listed address is on that street,
  never words in a title. So "hampton" catches 4100 Hampton Boulevard and can
  never catch a lease with someone named Hampton. A phrase the guard passes
  stays a phrase matched in titles ("granby" still catches a Granby Street
  streetscape item that names no address).

Measured on 2026-11-16, over the 883 addresses the indexed titles name:
- **On the list:** 860 are shown.
- **Not on the list:** 23 are dropped. They're typos ("Berkeley Avenue"),
  streets outside the city ("Nansemond Parkway"), the extractor's misreads
  ("20 Foot Lane"), and numbers the list doesn't carry.

Of the 1,941 street names, 553 are now watched as streets and 1,365 as phrases.
The 23 still refused are the names of civic leagues ("Bayview", "Ocean View"),
and the refusal says to watch the league.

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
- **Streets:** a phrase that is a street's name and that the name guard
  refuses is watched as that street, by listed address (above). Phrases and
  streets together are at most five.
- **Phrases:** a watch belongs to one signed-in member and mails only them.
  Jason, 2026-11-16: "Free text for signed in and private conversations feels
  like the right shape." So a member can add up to five phrases of their own
  ("dog park"), matched against the title. A phrase is refused when it:
  - is made only of common first names and surnames, plurals included
    (Census lists, `data/common-names.json`, built by
    `scripts/build-common-names.js`): "John Smith", "price", "smiths";
  - has a common name beside anything but ordinary words: "john zelinski",
    "jason edelman", "j smith". Ordinary words are the ones the City's books
    use in lower case;
  - has a common name beside a title or an entity word: "mr smith",
    "smith llc", "estate of smith";
  - holds a number, an address or contact details;
  - is a civic league's name.

  Without the name list, the vocabulary or the text check, no phrase is
  accepted.

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
3. Describes each item as above: its kind, number, topics and City-street
   addresses. It keeps the title in an internal field for phrase matching.
4. Tags each item with the civic league of each address, from the address
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
  and their streets, leagues, link and meeting, and its title for phrase
  matching (never served).

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
- **Requests:** the notices query and one page per meeting each day, counted
  on their own budget of 300.
- **Known gap:** the per-member cap and the duplicate check read a KV listing,
  which can lag a few seconds. Two starts in quick succession could pass
  either.

## Turning it on

1. Email sign-in must already work (RESEND_API_KEY, LOGIN_FROM, INVITE_SECRET)
   and PUBLIC_ORIGIN must be set. Siren has all four.
2. Set `WATCHES = "true"` and/or `LEAGUE_FEEDS = "true"` in `[env.siren.vars]`
   and deploy. Within ten minutes the cron builds the first snapshot. Until
   then `/feeds` answers 503.

## Decisions taken as defaults (Jason's to change)

- **Storing the email**, encrypted, while a watch exists. Without it there are
  no email watches.
- **Who can watch:** members only, meaning signed in with a bound invite.
- **Which bodies:** City Council and the Planning Commission. The Board of
  Zoning Appeals and the Architectural Review Board aren't a config line: their
  iqm2 meeting pages list no agenda items (checked 2026-11-16, three recent
  meetings each), and the agenda is a posted file. Adding them means reading
  those files.
- **Phrases:** free text for a member's own watches, with the common-names
  guard (Jason, 2026-11-16), and a street's name watched as that street, from
  the address list (Jason's trie, the same day).
- **The topic list:** 27 topics drawn from the legislation index's own wording,
  in `src/cities/norfolk.js`.
- **The numbers:** 5 watches, 365 days, 100 emails a day, one digest a day,
  three weeks ahead.
