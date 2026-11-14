# GIS skills: areas, street segments, homes

Siren's place tools: `area_lookup`, `street_segment` and `housing_count`, sharing `plugins/gis.js`. They started from Jason's challenge question, from a Siren conversation (2026-11-13): "What proportion of Ghent's housing is on Graydon between Colley and Colonial?" He is looking into Graydon as a pedestrian street.

Jason's calls (2026-11-14) on the design PR (#54):
- **Which Ghent:** "all three ghents! siren can ask clarifying questions and this is a great one."
- **What's on the street:** "touching parcels should count, intuitively."
- **Apartment units:** "per-building unit counts are what i was after."
- **Build order:** yes to `street_segment` and `housing_count` first, with `area_lookup` alongside.

## What the tools answer (read live 2026-11-14)

Graydon between Colley and Colonial is its **500, 600 and 700 blocks**, addresses 502–755. Each block is a divided road with one centerline per direction, 20 mph, road class "minor".

- **Parcels:** 67 touch it. 61 are residential: 59 addressed on Graydon, plus 2 corner buildings addressed on Colley and Colonial.
- **Homes:** 193 (96 counted exactly, 97 estimated apartment units), in 31 houses, 5 duplexes, 5 triplexes, 3 fourplexes, 28 condominium units and 12 apartment properties.

| Graydon's 500–700 blocks as a share of | Residential parcels | Homes | Share of parcels | Share of homes |
|---|---|---|---|---|
| Ghent Neighborhood League | 853 | 3,171 (2020 Census: 3,283) | 7.2% | 6.1% |
| All three Ghent civic leagues | 1,887 | 5,146 (2020 Census: 5,243) | 3.2% | 3.8% |

These replace the first build's figures (60 parcels, 194 homes; 7.1% and 6.1%; 3.2% and 3.8%), which counted building rows rather than properties and computed lot centers less precisely; an independent review caught both.

"Ghent" also matches several planning districts, North Ghent and West Ghent among them, so Siren asks which is meant.

## The tools

All three follow one rule: **the model chooses, code computes.** The model picks an area by name or a street between two cross streets. Code makes every query, does every join and every division, and never hands the model a coordinate. Shares come from `housing_count`, and the prompt tells Siren to give that figure rather than work one out.

### `area_lookup` `{ name, kinds? }`

- **What it searches:** the City's civic leagues, planning districts, wards, super wards and ZIP codes (OpenData Maps and Planning services). Only the one field that names each area is ever requested; the Civic Leagues layer also carries a private person's name, mailing address and email.
- **What it returns:** every match.
- **Ambiguity:** with more than one match, it tells Siren to ask which is meant, offering all of them together.

### `street_segment` `{ street, from, to }`

- **Finding the blocks:** it reads the City's street centerlines (OpenData Public_Works, layer 1) and walks them. A cross street meets the street where one of its vertices lies within 3 m of a centerline piece's end; pieces of the street join where their ends lie within 12 m. From the crossings with one cross street it takes the shortest connected way to a crossing with the other. Where that way crosses a cross street's line within 60 m of the cross street and goes on (it reached the crossing by a frontage road beyond it, as on E Virginia Beach Boulevard at Anna Street), it's cut back to that line. It then adds the other carriageway of a divided road: the same street, within 40 m of the walked one all the way, not past either end; median crossovers belong to neither. Block numbers come from the pieces kept, never from a numeric range, so a piece of the same street across town numbered in between isn't included, and stubs under 15 m inside an intersection add no block.
- **Which street:** each full name (Llewellyn Avenue, Llewellyn Mews) is walked on its own. A name as written is matched exactly first ("North Shore" is NORTH SHORE), then without a leading direction or type word ("W Little Creek" is LITTLE CREEK, "Avenue I" is I); a type or direction given narrows the match. Where the City's centerlines have a real gap between the cross streets, the tool says the street doesn't run unbroken there. North Shore Road, for one, is four separate pieces.
- **Per block:** the address range and the centerline's own fields: speed limit, traffic (two-way, one-way, or one way on a divided road), road class, length and the number of carriageways.
- **What it returns:** the blocks, the stretch's length along one carriageway, and how many parcels touch it, how many of those are residential, and how many are addressed on the street itself.
- **What touching means:**
  - a parcel's shape comes within 15 m of a carriageway's centerline;
  - the center of its lot isn't past either cross street: more than 2 m on the far side of the cross street's line where it meets the street. The street's direction there is taken 40 m along it, leaving out median crossovers; where a cross street runs within 30 degrees of the street, the line is cut square to the street instead. Each end's cut applies only to lots whose nearest place on the stretch is within 40 m of that end, so a curving street (Mayflower Road) or a walk ending on a crossover (Hampton Boulevard at Richmond Crescent) never loses its own frontage;
  - corner buildings addressed on a cross street count.
- **Why 15 m:** at 10 m and 15 m Graydon's 500–700 blocks gave the same 61 residential parcels; at 20 m, 63, taking in parcels behind the frontage.
- **Right-of-way width:** the centerline's `ROW` field holds a road type ("residential"), not a width, so there isn't one to report.

### `housing_count` `{ place, of? }`

Each place is either `areas` (one or several, counted together) or a street with two cross streets. Returns, for each place:
- residential parcels;
- homes, split into those counted exactly and those estimated;
- homes by kind;
- for areas, the 2020 Census count.

With `of`, it adds the share of residential parcels and of homes.

**Which parcels belong to a place:**
- an area holds a parcel when the area contains the center of its lot;
- a street holds the parcels that touch it.

**Homes from the FY27 assessment roll** (`qva7-tzrf`). The roll has a row per building on a property, so one query per 400 parcels groups by parcel, class and street and counts properties as distinct accounts (`count(distinct lrsn)`), with their building rows, building area and oldest building's year. Owner and deed fields stay denied at plugin access.
- **Counted exactly, per property:**
  - houses count 1;
  - a house with an extra dwelling unit, 2;
  - duplexes 2, triplexes 3, fourplexes 4;
  - each condominium unit is its own property, counted 1.
- **Estimated:** apartment properties, because the roll gives them only as bands (5–11, 12–48, 49+ units).
- **Also estimated:** mobile home parks, cooperatives, shops with apartments over, and public or religious residential property, which the roll gives no count for (from 1 up).
- **Not homes:** vacant lots and boat slips.
- **Reported:** homes by kind (houses, duplexes, condominium units, apartments ...) and properties by kind, separately.

**The estimate, per census block:**
1. Take each 2020 Census block's housing count (TIGERweb, 2020 Census Blocks, `HU100`).
2. Subtract the homes the roll counts exactly in that block, for properties standing in 2020.
3. Share the remainder among the block's apartment properties by building area (`commercial_building_area`; 900 sq ft a unit at the band's floor where none is recorded), keeping each within its band.
4. Where the remainder falls outside the bands, each property sits at its band's floor or ceiling, and the result counts how often that happened.
5. A property whose buildings all went up after 2020, or on a parcel in no block, counts at its band's floor.

**How accurate it is:** `scripts/check-unit-estimate.js` takes the first 60 GPINs, in SHA-256 order, of the apartment properties whose units the City's Real_Estate/Submarkets layers fully record (628 on 2026-11-14; they cover only part of the city). A property with a building row of 0 units that isn't a clubhouse, office, pool or the like is left out as not fully recorded (26 were). It runs the estimate on each one's census block and writes `eval/unit-estimate-<date>.json`. On 2026-11-14 (58 properties; 2 had no apartment class in the FY27 roll): median error 16%, 38 of the 58 within 20%, and summed over the 58 the estimate came within 1%. Band midpoints (49+ at its floor) were off by 33% at the median. For single-building properties the median error was 15% (midpoints 25%); for properties with several buildings, 17% (midpoints 77%). Among the misses is a property the City records at 16 units in a 49+ class.

**Where exact counts live:** the City assessor's table carries `number_units`; the NRHA layer shows it. It isn't in the open-data roll, so publishing it would make every count exact.

**What it fetches:**
- a count of the parcels in the places' box, then the parcels, only if there are at most 12,000;
- the census blocks that meet the box;
- the roll for the parcels of either place;
- then, only for census blocks holding a counted apartment property, the rest of those blocks' parcels and their roll rows, so each apartment estimate sees every home in its block. A block of houses alone needs nothing past the places.

**Refusals:**
- a box of more than 12,000 parcels, before downloading it (a ward is too large), or more than 8,000 parcels to count;
- fewer than 5 parcels, or 5 residential parcels, which would describe single households.

**Cost:** Graydon in the Ghent Neighborhood League took 11 requests; in all three Ghents, 16.

## Rules these tools keep

- **The trace is written by code.**
  - ArcGIS and TIGERweb go through the traced `ctx.http`.
  - The roll goes through `ctx.socrata` at plugin access, and lands in the hand-off.
  - Each request counts on the answer's budget.
- **No people-finding.**
  - Tool results are counts and shares, never parcels, addresses or GPINs. The trace and hand-off show every query exactly, as for every tool, so the parcel query's GPIN list is visible there.
  - The roll's owner and deed fields stay denied.
  - The floor of 5 residential parcels keeps one answer from describing a household. Two overlapping counts can still be subtracted, which yields a property's class and home count: no more than the public assessment roll shows for any address.
  - The Civic Leagues layer is queried for `LEAGUE` only.
- **Coordinates never reach the model.**
- **The City's map layers are a guide, not a legal determination or a survey.**

## Not yet

- **Exact apartment units:** a source request to the City to publish the assessor's `number_units` in the open-data roll.
- **More measures:** zoning mix, flood exposure (FIRM), CBPA and AICUZ along a segment or in an area.
