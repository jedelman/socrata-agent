# Block watch

Siren's first forward-looking feature. Everything else she does is analysis:
what was decided, who decided it, what the records show. Block watch is
presence: it tells you what's coming up on your block before it's decided.
(Jason, 2026-11-14: "analysis (backwards looking) and detection/presence
(forwards looking). Symmetric but distinct.")

A signed-in member names an address once. Siren keeps only its hundred block
(the 800 block of Union St). Once a day she reads the agendas of City meetings
in the next two weeks, and emails the member when an agenda item's title names
an address on that block.

Jason, 2026-11-14: "Watch by block gives plausible deniability. Let's build it."

## What's stored

One KV record per account, `watch:<uid>`. The `uid` is the account's keyed hash
(`worker/accounts.js`); the record never holds an email in plain text.

| Field | What it is |
|---|---|
| `blocks` | Up to 5: `{city, street, hundred, label, added}`. The street is its core name (UNION), the hundred is 800. **Never the house number.** |
| `email` | The member's sign-in address, sealed with AES-GCM. The key is derived from the `WATCH_SECRET` secret under its own label. The `uid` is the additional data, so a sealed address opens only in its own record. |
| `sent` | The agenda items already emailed, as `<item id>@<meeting id>`, at most 300. An item that comes back on a later agenda (Planning Commission, then Council) is sent again. |
| `updated` | The day it last changed. |

The address someone types is looked up once in the City's address dataset (a
counted, traced Socrata request), cut to its block, and dropped. It isn't
stored, logged or kept in any trace.

Sign-in still stores no email address. A watch is the one place Siren keeps
one, sealed, because it has to send mail to it. It's kept until the member
removes the last block, presses "Stop all alerts", or uses the unsubscribe
link. Each of those deletes the record.

The scan's daily claim (`watch-run:<day>`) and the lookup counter
(`watch-rate:<day>:<HMAC>`, keyed so it can't be joined to the account's
other keys) expire on their own.

## Who can use it

Signed-in members: an email account bound to an invite, the same as private
conversations. The email typed when adding a block must be the account's own
(its keyed hash must equal the `uid`). So nobody can sign someone else's inbox
up, and no second verification email is needed: the account was signed in by
a link sent to that address.

## The scan

Each scan runs on the existing ten-minute cron. It does nothing until 12:00
UTC (7 or 8 a.m. in Norfolk), then runs once that day, under a claim key
written before any request. With no watches, it makes no request at all.

For each city that has watches (Norfolk for now: the cities whose meetings are
on iqm2):

1. One Socrata query: the Public Meeting Notices dataset, for meetings in the
   next 14 days.
2. Each meeting's agenda page from the meeting portal, at most 20 meetings.
3. Addresses are pulled from each item's title with the same extractor the
   legislation index uses.

All of this goes through one counting fetch (40 requests a city) and
`Trace.record`. A live run on 2026-11-14 read 16 meetings with 17 requests and
found 18 items that name addresses.

An item matches a block when one of its addresses has the block's street and
falls in its hundred, the same rule as `block_report`'s "same block".

For each watcher with new matches, the scan sends one email: a digest grouped
by block, at most 200 a run. It then records the items as sent. It logs one
line of counts (`event: block_watch`: watches, meetings, items, requests,
emails, failures), never an address, block, email or account.

## The email

- Subject: "On an upcoming agenda: the 800 block of Union St".
- Body: for each item, the meeting body, the date and the agenda title, linked
  to its legislative record and the meeting's agenda page.
- **Applicant names are withheld.** A Planning Commission title opens with its
  applicant ("JANE DOE, for a Conditional Use Permit ..."). When that name
  isn't plainly an organization, it becomes "An applicant, for ..."
  (`withholdApplicant` in `src/adapters/iqm2.js`, the same organization test
  the cover letters use). A business can be withheld too, which is the safe
  direction. A name after a courtesy title is withheld as well.
- The voice: "Siren found ...". It says what it can't see: items that name no
  address (citywide ordinances, budgets) aren't matched.
- **Leaving:** a "Manage your blocks" link, and a "Stop these emails" link
  with a signed token. The email also carries `List-Unsubscribe` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so a mail
  provider's unsubscribe button works without a sign-in. A GET of the link
  only shows a button, so a mail scanner that opens it changes nothing. The
  POST, by that button or by the provider's one-click, deletes the watch.

## The page

`/watch`, server-rendered, with no script at all. It's a list of blocks with
Remove buttons, a form to add one (any address on the block, plus your sign-in
email), and "Stop all alerts and delete my email".

The forms post plainly, so these routes sit before the API's JSON-only rule.
Each post must carry this origin's `Origin` header, and the session cookie is
`SameSite=Lax` too.

Messages after a post are fixed codes (`?m=added`) turned into fixed text; the
input is never echoed. The page's policy allows only this origin's
stylesheet, forms posting here, and Cloudflare's beacon.

## Turning it on

Off unless `BLOCK_WATCH = "true"`. With it off:

- every `/watch` path is the Worker's ordinary 404 (a form post gets the
  JSON-only rule's 415, as any form post does);
- the cron doesn't call the scan;
- `watch.css` isn't served.

`test/block-watch.test.js` checks all three, and `test/public-ask-off.test.js`
still passes unchanged.

On, it needs these; with any missing, its paths answer 503 and the cron logs
which one:

- `LIMITS`;
- `INVITE_SECRET` and email sign-in (`RESEND_API_KEY`, `LOGIN_FROM`);
- `PUBLIC_ORIGIN`;
- a new secret: `npx wrangler secret put WATCH_SECRET --env siren`, 32+
  random characters. Rotating it makes every stored address unreadable, which
  stops all alerts until members add their blocks again.

Then a PR adds `BLOCK_WATCH = "true"` to `[env.siren.vars]`. Before that
lands, try it live:

1. add a block;
2. run the scan;
3. check the email, both unsubscribe paths, and the page's Remove and Stop.

## What it doesn't do yet

- **Neighborhoods.** Civic leagues and planning areas need the GIS work in #55
  (`area_lookup`). A watch by area could reuse its polygons.
- **Items with no address.** Citywide ordinances, budgets and rezonings that
  describe land by parcel number instead of a street address are missed. The
  email says so.
- **Tree removals.** These need a record that comes before the cut. On private
  land outside the Chesapeake Bay areas, the ordinance requires no permit
  (`data/cases/norfolk-trees.json`). For City trees, no open dataset of
  removal permits or Forestry work orders has been found yet. That's the next
  thing to check on the live portal.
- **A way in from the chat page.** `/watch` is reached by its URL. A link from
  the chat page means retaking `test/public-ask-off.test.js`'s snapshot, so
  it's a separate change.
