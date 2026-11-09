# What Siren can safely offer in Norfolk

A map of every dataset on data.norfolk.gov (105, as of 2026-11-02), plus City
GIS, the meeting portal and state and federal sources. It sorts each into what
Siren can safely advertise, what needs a build first, and what she must never
do. It was produced by a research workflow: seven assessors checked each
dataset's live metadata and a three-row sample, and a red-teamer per batch
then looked for re-identification and harm. No personal values were recorded.

Read it with `CLAUDE.md`'s non-negotiables: no people-finding, the voice
contract, a trace written by code. (The public endorser list on a source
request's page is not people-finding: it shows only Bluesky accounts that
published an endorsement of that public request, on that request's page,
with no lookup by person; docs/bluesky-endorsements.md.)

## 0. Before advertising anything: close the gaps in what ships today

Siren's exclusions work per dataset, not per column, and only warrants and
arrests are excluded. Checked live on 2026-11-02, the generic
`query_dataset` tool can today:

- look up owners by name in the assessment rolls (`qva7-tzrf` and FY19–FY26:
  `owner`, `grantor`, `grantee`);
- look up people by name in Delinquent Property Taxes (`7qie-z5gv`:
  `owner_name`);
- find where a vehicle was towed or ticketed by plate (Towing `4dwc-v3t8`:
  `license_plate`, `vin_number`; Parking Citations `ei2q-6g8n`:
  `vehicle_plate_number`);
- return short-term-rental hosts' names and phone numbers (`7mjv-xiqs`);
- return per-household flood-insurance payouts by grouping NFIP claims
  (`suf7-r643`) finely enough.

The block report also shows right-of-way permit `contractor` names
(`mi4h-8pn3`). About half of them are private individuals: driveways,
dumpsters, temporary parking.

Fixes, all in core:

1. **Exclude now:** `7qie-z5gv` (delinquent taxes), `4dwc-v3t8` (towing),
   `ei2q-6g8n` (parking citations), `jf3j-u4s7` (Fire-Rescue inspections:
   stale, and lists sensitive occupancies by unit), and `fcqe-uvnb` (police use
   of force and complaints: per-incident demographics).
2. **Column denylist per dataset**, enforced in `Socrata.query`. Refuse any
   SoQL that selects, filters, groups or orders by a denied column, and expand
   `SELECT *` to the allowed columns. First entries:
   - assessment rolls: owner, grantor, grantee, legal description;
   - short-term rentals: contact name and number;
   - right-of-way permits: applicant and contractor;
   - business licenses: primary owner and mailing address;
   - Address Information: civic-league president and email, outside the
     contacts path;
   - crashes: document number;
   - rail crossings: free-text comments;
   - storm reports: user and comment fields;
   - litter: image URL.
3. **A restricted tier (plugin-only).** The generic tools refuse these
   datasets, and only named plugins can query them, with aggregation inside the
   SoQL itself:
   - NFIP claims;
   - police incidents (`r7bn-2egr`);
   - micromobility trips (`wqxq-hhe6`);
   - MyNorfolk 311 (`nbyu-xjez`);
   - employee salaries and demographics;
   - business licenses;
   - the animal shelter (`vfm4-5wv6`);
   - foster care and adoptions.

   For these, the hand-off gives the dataset page and the aggregate query's
   CSV, never the full-table CSV.
4. **Row suppression in code:**
   - complaint and violation subtypes that point at a household ("Residing in…",
     interior housing conditions on single-unit rentals);
   - gas and fire red tags, as yearly counts by civic league, minimum 5;
   - group-home and assisted-living use groups on residential parcels.
5. **The block report drops `contractor`.**
6. **The Mason Creek tide gauge has flatlined** but still sends fresh
   timestamps, so it passes the 30-day staleness rule. Count a gauge as live
   only if its 7-day range moves.

**Status, 2026-11-02:** items 1–6 are done in code (`src/socrata.js`,
`src/cities/norfolk.js`, `plugins/water-on-my-block.js`), with tests in
`test/privacy.test.js` and live checks against the portal. Still open:
interior housing-condition complaints and violations on single-unit rentals
(they need a join to property class), and the speed-study house numbers
(`t9wi-yikh` `street_location`), which can't be dropped as a column.

**Bypass hunt, 2026-11-02/03.** Adversarial agents then attacked those guards
and confirmed 22 bypasses, several live: `SELECT DISTINCT *`, double-quoted
strings and comments that hid `owner` from the column check, a `|>` pipeline
or a single-stage alias (`'x' AS subtype`; SoQL's WHERE sees aliases) that
defeated row suppression, filtered views (`6tg2-ftte` on 311) that dodged the
id-keyed policy, plugin `ctx.http` straight to `/resource/`, a mutable city
profile, `--city data.norfolk.gov` loading no policy, full-table CSVs in the
hand-off, and Chicago's Relocated Vehicles (plates). All are fixed in code
with regression tests in `test/privacy.test.js` and re-run live. The same
hunt found that Code Enforcement Cases (`mxtv-99gh`) and Violations
(`agip-sqwc`) carry the suppressed subtypes and rooming-house and
occupancy-limit ordinances; both are now suppressed. It also found that the
old predicate silently dropped 465 complaints with no subtype; the
suppression is now NULL-safe.

## 1. Advertise now (works today, once section 0 is done)

| Capability | Data | Conditions |
|---|---|---|
| What's on my block | Permits, plan reviews, inspections, complaints, violations, code enforcement, work orders, right-of-way permits, Address Information | No contractor or applicant names; household-revealing subtypes collapsed |
| Who decided it | Meeting portal legislation and roll calls | As shipped |
| Upcoming public meetings | Public Meeting Notices | As shipped |
| Water on my block | FEMA flood zone, NFIP claims by tract (suppress cells under 3), working tide gauges, stormwater inspections | NFIP through the plugin only; dead and flatlined gauges never reported as current |
| Sponge-city site screen | Public vacant parcels, GIS, soils | As shipped (public owners only) |
| My nearest library and what it offers | Address Information `nearest_library`, Library Programs | Normalize branch names; "past schedule", not upcoming |
| How busy 911 and Fire-Rescue are | Emergency Communications call volume, Fire-Rescue calls (station and citywide aggregates) | Aggregates only |
| Blocked rail crossings | `bguc-8iwd` | Never quote comments; count "reports", not events |
| The city's own energy use and climate pledge | Municipal building energy, Better Buildings | Building-level; no account numbers |
| What the treatment plants' tests show | Water Quality Test Results | Never "your tap": plant samples only, with tap lead depending on service lines |

## 2. Small builds (a plugin or a block-report section each)

**Property and place:**
- **Property facts and value history:** assessment FY19–27, no owner names.
  Only public owners are named; everyone else is "privately owned". A sale
  price is shown only above a nominal floor ("a recorded transfer with no sale
  price").
- **Lead service line check** (`62wx-9fci`): quote the inventory's own label
  and its basis (for example, a predictive model). Make no health claim; link
  the Department of Utilities. High value.
- **Short-term rentals near me:** permit facts only. No host contacts; lapsed
  registrations marked as lapsed; "I found N registered".
- **Vacant, boarded, derelict, demolition status** (Special Programs): per
  address for structure status only; red tags as counts by civic league.
- **What's being built or closed within a short walk:** permits by radius,
  no names; utility work described by permit kind.
- **Zoning rules for my lot** (City GIS): explicit `outFields`; no CUP
  applicant; home-based uses only as counts, by allowlist with default deny.
- **Capital projects near me** (CIP FY26–27): say that about 42% have no
  location, and never imply nothing is planned nearby. Built 2026-11-06 as
  `capital_projects` (CIP FY2024–FY2027 by ward or department, the largest
  projects with location as published, totals by department and ward); a
  ward filter reports how many of the plan's projects have no ward. No
  address lookup yet.

**Services and streets:**
- **Who represents me, and where do I go:** wards, polling place (with the
  state elections link), schools, police sector. League contact only through
  the contacts path, and never a president's home address.
- **City services on my street:** trash day; sweeping only where signed (the
  schedule contradicts its own quarterly-rotation note); sidewalk trip hazards
  phrased as "phase 1 survey, partial".
- **Streetlights out near me:** outage list; never the reporter.
- **Traffic safety on my street:** crashes as counts by severity over 3+
  years; no report numbers or times; speed studies without the requester's
  house number.
- **Storm history near me** (STORM 2010–20): street conditions by block;
  damaged buildings as counts only.
- **Trees on my block:** built 2026-11-04 as `trees_on_my_block` (species and
  size within 100 m; Forestry work on the street, in the civic league and
  citywide; removals per planting; the pruning pace). Significant Trees not
  included.
- **Litter on my street:** built 2026-11-04 as `litter_on_my_street` (the 2022
  Litterati survey within 500 m, the nearest surveyed stretches per meter, the
  ward's Litter Index 2010–2019, and cleanup work orders and cost).
- **Rain and tide, now and on a flood day:** the airport's daily rainfall
  plus a live gauge, with impossible readings filtered.
- **Mosquito activity:** fixed areas only (wards or a ~2 km grid), never trap
  locations; positives with their denominator and the pending count.
- **Parks, public art and mermaids near me:**
  - parks: flag school sites;
  - mermaids: an allowlist by parcel use, since a keyword filter misses those
    at homes, and no sponsors;
  - public art: "budget recorded", never "city paid".
- **What's polluting near me** (EPA ECHO/TRI, DEQ): facilities by name; no
  operator contacts; pollution reports as counts.

**City-wide numbers:**
- **Follow the city's money:** revenues, expenditures, ARPA, performance.
  The latest closed year labeled unaudited; individual ARPA recipients never
  named. Built 2026-11-06 as `budget_for` (Annual Expenditures `mdwe-dquf`,
  Annual Revenues `id3i-2az4`, Performance Measures `7jsp-eyjg`): budget vs
  actual by fiscal year for a department, unit or the whole City. The
  datasets hold FY2025–FY2027 only, and their metadata doesn't say whether
  a year is closed or audited, so the tool says that rather than labeling a
  year unaudited. ARPA not included.
- **My tract at a glance** (ACS, CDC PLACES, HUD):
  - tract level only, labeled as estimates;
  - flag group-quarters tracts;
  - SNAP and poverty only on request, never in the default summary;
  - voucher counts suppressed under 11.
- **My ward's voice** (2024/2022 resident surveys): sum the ward ×
  superward slices; show n; label unweighted.
- **Safety-net trends, citywide only:** SNAP, TANF, the housing-crisis
  hotline (calls, not unique callers), the point-in-time count versus
  McKinney-Vento (different definitions, never summed).
- **Animal shelter outcomes:** aggregate only, merged across the 2023
  system migration.
- **Library branch use:** deduplicated; "accounts active in the last 3
  years".

## 3. Larger builds: don't advertise yet

- **Neighborhood incident picture** (police incidents): after the restricted
  tier exists.
  - planning district or precinct, never census tract;
  - sensitive offenses by calendar year, with counts under 5 suppressed;
  - no full-table CSV.
- **311 requests on my block:** an exact-type allowlist covering
  infrastructure, plus water mains, hydrants and streetlights.
  - no enforcement, billing or encampment types at block level;
  - no "days to close", because there's no close date.
- **Boards and commissions:** metadata only by default. Summaries only for
  land-use and policy bodies, with personal contacts stripped from packets.
  BZA, ARB and Wetlands cases indexed by address, never by person.
- **Who owns the block:** public, company, or individual, as counts at
  civic-league level computed in code. No owner string ever leaves the
  classifier.
- **New businesses on my block:** counts by industry group, with a
  sensitive-industry denylist (group homes, home day care, home health) and a
  trade-name rule that never shows a sole proprietor's name.
- **City jobs and pay:** decide the principle first (Virginia FOIA
  treatment of public pay; verify). Demographics use complementary
  suppression.

## 4. Never

- Look up, list or locate a private person by name, plate, VIN, phone or
  email, in any dataset or plugin.
- Owners of private property, tax delinquents, short-term-rental hosts,
  permit applicants, 311 or complaint reporters, or crash report numbers.
- Health, disability, benefits, child-welfare, homelessness or crime-victim
  information at any geography that could point to a household: per address,
  per block, or in small cells.
- Mosquito trap locations, storm-damage reports at private homes, or Fire/EMS
  calls by address.
- Present stale or estimated data as current or exact: dead or flatlined
  gauges, a sweeping schedule that contradicts itself, ACS estimates without
  their vintage.
