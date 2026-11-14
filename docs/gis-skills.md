# GIS skills: areas, street segments, homes

Siren's place tools: `area_lookup`, `street_segment` and `housing_count`, sharing `plugins/gis.js`. They started from Jason's challenge question, from a Siren conversation (2026-11-13): "What proportion of Ghent's housing is on Graydon between Colley and Colonial?" He is looking into Graydon as a pedestrian street.

Jason's calls (2026-11-14) on the design PR (#54):
- **Which Ghent:** "all three ghents! siren can ask clarifying questions and this is a great one."
- **What's on the street:** "touching parcels should count, intuitively."
- **Apartment units:** "per-building unit counts are what i was after."
- **Build order:** yes to `street_segment` and `housing_count` first, with `area_lookup` alongside.

## What the tools answer (read live 2026-11-14)

Graydon between Colley and Colonial is its **500, 600 and 700 blocks**, addresses 502–755. Each block is a divided road with one centerline per direction, 20 mph, road class "minor".

- **Parcels:** 65 touch it. 60 are residential: 58 addressed on Graydon, plus 2 corner buildings addressed on Colley and Colonial.
- **Homes:** 194 (95 counted exactly, 99 estimated apartment units).

| Graydon's 500–700 blocks as a share of | Residential parcels | Homes | Share of parcels | Share of homes |
|---|---|---|---|---|
| Ghent Neighborhood League | 849 | 3,199 | 7.1% | 6.1% |
| All three Ghent civic leagues | 1,871 | 5,158 (2020 Census: 5,243) | 3.2% | 3.8% |

"Ghent" also matches several planning districts, North Ghent and West Ghent among them, so Siren asks which is meant.

## The tools

All three follow one rule: **the model chooses, code computes.** The model picks an area by name or a street between two cross streets. Code makes every query, does every join and every division, and never hands the model a coordinate. Shares come from `housing_count`, and the prompt tells Siren to give that figure rather than work one out.

### `area_lookup` `{ name, kinds? }`

- **What it searches:** the City's civic leagues, planning districts, wards, super wards and ZIP codes (OpenData Maps and Planning services). Only the one field that names each area is ever requested; the Civic Leagues layer also carries a private person's name, mailing address and email.
- **What it returns:** every match.
- **Ambiguity:** with more than one match, it tells Siren to ask which is meant, offering all of them together.

### `street_segment` `{ street, from, to }`

- **Finding the blocks:** it reads the City's street centerlines (OpenData Public_Works, layer 1). It finds where each cross street meets the street, at shared centerline ends within 3 m. From each intersection it takes the block toward the other one, and returns the blocks in between.
- **Per block:** the address range and the centerline's own fields: speed limit, traffic (two-way, one-way, or one way on a divided road), road class, length and the number of carriageways.
- **What it returns:** the blocks, plus how many parcels touch the segment.
- **What touching means:**
  - a parcel's shape comes within 15 m of a carriageway's centerline;
  - the nearest point on the street to the parcel's center isn't a cross street's corner, so a parcel past either cross street is left out;
  - corner buildings addressed on a cross street count.
- **Why 15 m:** at 10 m and 15 m Graydon's 500–700 blocks gave the same 60 residential parcels; at 20 m the count began to take in parcels behind the frontage.
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

**Homes from the FY27 assessment roll** (`qva7-tzrf`). One query per 400 parcels returns rows grouped by parcel, class and street. Owner and deed fields stay denied at plugin access.
- **Counted exactly:**
  - houses count 1;
  - a house with an extra dwelling unit, 2;
  - duplexes 2, triplexes 3, fourplexes 4;
  - each condominium unit is its own row, counted 1.
- **Estimated:** apartment buildings, because the roll gives them only as bands (5–11, 12–48, 49+ units).
- **Also estimated:** shops with apartments over, and public or religious residential property, which the roll gives no count for.
- **Not homes:** vacant lots and boat slips.

**The estimate, per census block:**
1. Take each 2020 Census block's housing count (TIGERweb, 2020 Census Blocks, `HU100`).
2. Subtract the homes the roll counts exactly in that block.
3. Share the remainder among the block's apartment buildings by building area (`commercial_building_area`), keeping each within its band.
4. Where the remainder falls outside the bands, each building sits at its band's floor or ceiling, and the result counts how often that happened.
5. A building put up after 2020, or on a parcel in no block, counts at its band's floor.

**How accurate it is:** against 43 apartment buildings whose units a City assessment layer records (Real_Estate/Submarkets, which covers only part of the city), the estimate's median error was 17%. Band midpoints gave 33%. Summed over the 43, the estimate ran 19% high (midpoints, 39%). One record there, 47,850 units, is plainly an error and was left out.

**Where exact counts live:** the City assessor's table carries `number_units`; the NRHA layer shows it. It isn't in the open-data roll, so publishing it would make every count exact.

**What it fetches:**
- the census blocks that meet the places;
- the parcels in the places' box;
- then only the blocks holding a parcel of either place, with all their parcels, so each block's estimate sees every home in it.

**Refusals:**
- more than 4,000 parcels (a ward is too large);
- fewer than 5 residential parcels, which would describe single households.

**Cost:** the three Ghents with Graydon took 16 requests.

## Rules these tools keep

- **The trace is written by code.**
  - ArcGIS and TIGERweb go through the traced `ctx.http`.
  - The roll goes through `ctx.socrata` at plugin access, and lands in the hand-off.
  - Each request counts on the answer's budget.
- **No people-finding.**
  - Outputs are counts and shares, never parcels, addresses or GPINs.
  - The roll's owner and deed fields stay denied.
  - The Civic Leagues layer is queried for `LEAGUE` only.
- **Coordinates never reach the model.**
- **The City's map layers are a guide, not a legal determination or a survey.**

## Not yet

- **Exact apartment units:** a source request to the City to publish the assessor's `number_units` in the open-data roll.
- **More measures:** zoning mix, flood exposure (FIRM), CBPA and AICUZ along a segment or in an area.
