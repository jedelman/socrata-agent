# Resident reports: photos and observations as a public corpus (design, not built)

Jason, 2026-11-19: "let's figure out _public_ data submissions: images and
citizen reports. Start building our own corpus. They're cutting trees in Ghent
with no permits - I'm tired of the City just acting with impunity."

Siren reads what the City records. A resident's report records what the City
didn't. Put the two side by side, one cut at a time, and each one either
lines up or leaves a gap. The gaps are what the corpus is for.

## What the records already say about a cut tree (checked 2026-11-19)

- **Who needs a permit** (verified case file `norfolk-trees`, City Code ch. 45):
  - Only the City's parks and forestry staff may remove a City tree, including
    one in the strip between curb and sidewalk. Anyone else needs a permit.
    Doing it without one is a class 1 misdemeanor, each day a new violation,
    and the director may require replacement or a payment in lieu.
  - The City's own removals need no permit: its crews and its tree-care
    contractor work from Forestry work orders.
  - A private tree on private land needs a permit only in the Chesapeake Bay
    Preservation Area's resource protection and intensely developed areas.
- **What's published:**
  - **Forestry work orders** (`qzfe-wj25`, current to 2026-11-18): since Sept
    1, 6 completed removals in the three Ghent civic leagues, 2 more open, and
    6 stump grindings waiting. The streets are Raleigh, Spotswood, Boissevain,
    Stockley (2), Maury, Graydon and Mowbray. Reasons: dead, diseased,
    damaged, and "General Maintenance". The location is a street name only,
    with no house number.
  - **The City Tree Inventory** (`cmvv-agyb`): 94,362 points with species and
    trunk size. It has no status column and is republished in full daily
    (every row stamped 2026-11-19). It's unknown whether a removed tree's row
    is deleted.
  - **Significant Trees** (`jz6u-9g3c`).
  - **Right-of-way permits** (`mi4h-8pn3`): none of the 40 most common types is
    a tree permit.
- **What isn't published:** the chapter 45 permits for anyone else to touch a
  City tree, and anything about Dominion Energy's line clearance. A cut by
  either leaves no public record.

So for any cut, the questions are whether it was a City tree, whether there's
a Forestry work order for that street around that date, and, if not, who cut
it. A dated photo at a point answers what the records can't.

## A report

A **report** is a resident's own observation of something in the public realm:
what they saw, where, when, with up to four photos. Version 1 covers trees
only: removed, damaged, or being cut right now.

```
org.jason-edelman.siren.report   (an atproto record in the reporter's own repo)
  category    "tree-removed" | "tree-damaged" | "tree-work"
  observedAt  when they saw it (datetime)
  location    { lat, lng }: a pin they place, on a public street or sidewalk
  note        up to 1,000 characters, their words
  images      up to 4 × { image: blob (JPEG, ≤1 MB), alt: string }
  license     "CC-BY-4.0"
  createdAt
```

### Why the reporter's own repo (atproto), as the free tier does

- **Public by the reporter's choice, under their name.** That's the
  accountability a public corpus needs, and the same deal as public questions.
- **The corpus belongs to its authors, not to Siren.** Anyone can read and
  index it from the network. A journalist, a council member or another tool
  can build on it. That's the commons argument made in code.
- **Deletion is the author's.** The existing machinery (the Jetstream watcher
  and the sweep) takes a deleted record off Siren within seconds.
- **Siren holds no token.** The browser writes the record and its photos, as
  it writes questions and endorsements now. The scope becomes
  `repo:<REPORT_NSID>?action=create&action=delete`, plus atproto's permission
  to upload image blobs (its exact scope string to be checked against the
  permission spec when building).

What this costs: only people with a Bluesky (atproto) account can report.
Siren-hosted reports would let anyone report, but Siren would then be the
publisher and keeper of every photo.

## Photos

- **Cleaned on the phone before upload.** The browser resizes each photo (2,048
  px at most) and re-encodes it as JPEG, which drops every EXIF field: GPS,
  camera serial, timestamps. The location comes only from the pin the
  reporter places. It's prefilled from the photo's own GPS only if they say
  so, and read on the device.
- **Held for review before Siren shows them** (Jason, 2026-11-18: "a little
  friction to protect people"). A steward checks for faces, licence plates and
  someone's home as the subject before a photo appears on Siren. The report's
  text and its records check show at once.
  - The photo is already public on the network the moment the reporter posts
    it. Review only decides whether Siren displays it.
- **Served from Siren's own origin.** Siren fetches an approved photo from the
  reporter's server (`com.atproto.sync.getBlob`), checks its type and size, and
  serves it under the strict CSP. The pages never load images from strangers'
  hosts.

## The records check (code, not the model)

Each tree report gets a check, computed by code from the pin and the date and
written in Siren's voice:

1. **Was it a City tree?** Inventory points within 15 m of the pin (species,
   trunk size), and Significant Trees within 15 m.
2. **Is there a City work order?** Forestry work orders on that street from 60
   days before to 14 days after the date seen (removal, stump grinding,
   pruning), each with its date, status and reason.
3. **What rule applies?** Whether the pin falls in the Chesapeake Bay
   Preservation Area (the private-tree permit rule), from the layer
   `parcel_inventory` already reads.
4. **Any right-of-way permit** on that hundred block in the same window.

For example: "A City tree was inventoried within 15 m of this spot (willow oak,
24–30 in). I found a Forestry removal work order on this street dated 2026-10-15,
reason Dead Tree." Or: "I found no Forestry work order on this street between
2026-09-20 and 2026-12-03."

The check always says what the records can't show: work orders give a street,
not a house number; chapter 45 permits for others and Dominion's line work
aren't published. It never says "illegal" or "no permit exists". The reporter's
words are theirs; the check is Siren's, and it says only what Siren found.

## The corpus

- **Pages:** `/reports` (a map and a list, by civic league) and `/r/<id>` for
  each report, showing the reporter's handle, the photos once approved, and
  the check.
- **Exports:** GeoJSON and CSV of every shown report (CC BY 4.0, credited to
  each reporter), so anyone can map, count and cite them.
- **Siren can read them:** a `resident_reports` tool, by place only (civic
  league, street, near an address). Answers keep them apart from records:
  "Two residents reported a removed tree on Stockley Gardens in October; I
  found one Forestry removal work order there."
- **Searchable and alertable by place and topic, never by person.** No route
  or tool takes a reporter's handle, the same rule as endorsements. A
  civic-league feed and a watch can follow tree reports in Ghent; nothing can
  follow a reporter.

## The records side: watching the inventory itself

A daily snapshot of the City Tree Inventory's ids, compared with yesterday's,
would show trees that drop out, if the City deletes a row when a tree comes
down. One week of snapshots will settle whether it does. If so, each cut can
be seen three ways: the inventory losing a tree, a work order (or none), and a
resident's photo. This is the cheapest part (no UI, no submissions) and could
run first.

## What a report can't be

- **About a person:** a neighbour, a worker by name, someone's habits. The
  categories are things that happen to the public realm. The note is checked
  for contact details (email, phone), and the steward can hide any report.
- **A private yard as its subject.** The pin goes on the street or sidewalk.
  A cut on private land is only reportable as what can be seen from the
  public way.
- **Used to find or follow anyone:** no reporter search, no reporter feed.

## Abuse and load

- At most 5 reports a day per account; the steward hides at `/admin/reports`.
- Bluesky's flags (new account, bot label, moderation labels) are shown, as on
  the endorsers list. A report from an account under 30 days old waits for
  review.
- Photos are at most 4 per report and 1 MB each, read only once approved, and
  cached.

## Legal (to settle before launch, with counsel)

Jason's legal notes (claude-memory `cairn/legal.md`, §3 "Duties of a host" and
§4 "Section 230, and what Siren writes") already cover this ground:

- **Whose speech.** Reports are third-party content, the reporters' own.
  Section 230 likely covers hosting them, though the Fourth Circuit reads it
  narrowly (Henderson, 2022). Siren's checks and summaries are Siren's own
  speech, so they claim only what the records show.
- **Serving photos, even proxied, brings host duties:**
  - reporting apparent child sexual abuse material to NCMEC on actual
    knowledge (18 U.S.C. 2258A), which means registering with NCMEC before
    launch;
  - a registered DMCA agent and a repeat-infringer policy, since a photo may
    be someone else's;
  - a published removal process for non-consensual intimate images within 48
    hours (the TAKE IT DOWN Act).

  Holding every photo for review before display keeps knowledge and removal
  in a person's hands.
- **The submit form** says what the reporter is publishing, under what
  licence, and that they saw it themselves. It also says that deleting a
  record removes it from Siren but not from copies elsewhere on the network.
- **Takedown:** the author deletes, or the steward hides; both within minutes.

## Phases

0. **Inventory diff:** daily snapshot and diff of `cmvv-agyb`. After a week we
   know whether removals show up.
1. **Tree reports**, behind `REPORTS` (off): the lexicon, the submit page
   (pin, photos cleaned on the phone, note), the records check, steward photo
   review, `/reports` and `/r/<id>`, the exports, takedown by deletion.
2. **Siren reads them** (`resident_reports`); civic-league feeds and watches by
   place and topic; more categories (flooding, sidewalks, dumping,
   construction without a permit).
3. **Other ways in:** a private tip channel for people without Bluesky,
   reviewed and published without the tipster's identity, if it's wanted.

## Decisions for Jason

1. **Where reports live:** in the reporter's own atproto repo (recommended:
   public, portable, deletable, no token), or hosted by Siren so anyone can
   report?
2. **Photos:** review before Siren shows them (recommended), or show them at
   once and take down on request?
3. **Anonymous tips:** none in version 1 (recommended: a public corpus needs
   accountable authors), or a private channel now?
4. **Licence:** CC BY 4.0, credited to the reporter (recommended), or CC0?
5. **Scope of version 1:** trees only (recommended), or general categories
   from the start?
