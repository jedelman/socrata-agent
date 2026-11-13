# GIS skills: areas, street segments and measures

A design proposal, not built yet.

Jason's challenge question, from a Siren conversation (2026-11-13): "What proportion of Ghent's housing is on Graydon between Colley and Colonial?" He is looking into Graydon as a pedestrian street.

Siren can't answer it today. `parcel_inventory` asks the City's map services about one point. This question needs four things it doesn't have:
- a named area as a shape;
- a street between two cross streets;
- a count of homes inside each;
- the arithmetic between them, done in code.

The question can be answered from public records with basic scripting. The worked answer below came from a throwaway script, using only sources Siren already reads or could read under her existing rules.

## The worked answer (read 2026-11-13)

**Graydon between Colley and Colonial is its 500, 600 and 700 blocks** (addresses 500–799). The City's street centerlines (`gisshare.norfolk.gov`, OpenData/Public_Works, layer 1, Street Centerline) show:
- Colonial Avenue meets Graydon at the east end of the 500 block;
- Colley Avenue meets it where the 700 block becomes the 800 block.

**"Ghent" is not one shape.** The City's Civic Leagues layer (OpenData/Maps, layer 12) has three Ghent leagues: Ghent Neighborhood League, West Ghent, and Ghent Square Community Association. All of Graydon's 500–700 blocks fall inside the Ghent Neighborhood League's boundary.

**Homes come from the FY27 assessment roll** (`qva7-tzrf`; owner and deed fields are denied to Siren and weren't read).
- Each row is a property, and each condominium unit is its own row.
- Its class code gives units for most homes: detached, attached and NRHA residential 1; duplex 2; triplex 3; fourplex 4; "S/F w Add'l Dwelling Unit" 2; each condo row 1.
- Apartment buildings come only as bands (5–11, 12–48, 49+), and "Retail/Apartment Over" carries no count. So unit totals are a low and a high.
- Rows were matched to a boundary through the parcel layer (OpenData/Parcels, layer 1): a parcel belongs to the area whose shape contains its center.
- Each parcel's GPIN links it to the roll.

| | Residential parcels | Housing units (low–high) |
|---|---|---|
| Graydon, 500–799 | 59 | 163–295 |
| Ghent Neighborhood League | 849 | 2,486–4,286 |
| All three Ghent civic leagues | 1,871 | 4,153–6,613 |

**So:**

- **Share of the Ghent Neighborhood League's residential parcels:** 6.9%.
- **Share of its housing units:** about 6.6–6.9%, if the apartment bands err the same way on Graydon as across Ghent. At the extremes, the share runs from 3.8% to 11.9%.
  - Seven buildings in the league are in the "49+ units" band. Each is counted at 49, so the league's total is understated and Graydon's share is probably a little lower.
- **Share of all three Ghent leagues:** 3.2% of residential parcels and about 3.9–4.5% of units.

**The choices behind those numbers, which an answer must state:**
- which Ghent is meant;
- that "on Graydon" means a property's address is on Graydon, so a corner building addressed on Colley or Colonial isn't counted;
- that apartment units are bands, not counts.

## What the question needs, as tools

The principle is the one the gaps catalog uses (`src/gaps/measures.js`): **the model chooses, code computes.**
- The model picks an area and measures from fixed menus.
- Code makes every query, does every join and every division, and writes the trace.
- The model never handles coordinates, never joins tables, and never does the percentage arithmetic.

### 1. `area_lookup`

`{ name, kinds? }` returns the named areas that match, each with the layer it comes from, its acreage, and a handle that later calls use.

- **Kinds:** civic league, neighborhood service area, planning district, ward, super ward, census tract, ZIP code, school zone, zoning district (by code), park.
- **Ambiguity:** with several matches, as "Ghent" has, it returns them all and the answer says which one it used.
- **Privacy:** the Civic Leagues layer carries a private person's name, mailing address and email (its president fields). These are dropped, as `parcel_inventory` already drops them.

### 2. `street_segment`

`{ street, from, to }` (for example Graydon, Colley, Colonial) finds where the two cross streets meet the street, using the centerline layer. It returns the blocks between them and their address range.

- **Per block, from the centerline's own fields:** length, right-of-way width (`ROW`), speed limit, one-way, and road class.
- **Also:** the areas the segment lies in, and a handle.
- **Why the street fields matter:** for a pedestrian-street study they are most of the profile.
- **Refusal:** when the cross streets don't meet the street, it says so.

### 3. `measure`

`{ handle, measures, share_of? }` runs fixed measures over an area or a segment. With `share_of` (a second handle), it also returns the first handle's share of the second, computed in code.

**First measures:**
- **Residential parcels:** an exact count.
- **Housing units:** low and high, by class.
- **Land-use mix:** parcels by class.
- **Zoning mix:** parcels or acres by district (OpenData/Planning, layer 1).
- **Flood exposure:** parcels by FIRM zone (OpenData/Environmental, layer 4).
- **CBPA and AICUZ exposure.**
- **Nearby facilities:** parks, schools, libraries and light rail within a distance.

**The housing-units measure must always say:**
- which areas and which roll year it used;
- how many apartment buildings fell in each band;
- that "on a street" means by address.

**Sharing a range:** when `share_of` applies to a range, it gives the matched-band share and the extremes, as above.

## Rules these tools keep

- **The trace is written by code.**
  - Every ArcGIS and Socrata call goes through the plugin context's traced `ctx.http` and `ctx.socrata`, and counts on the answer's request budget.
  - Ghent's count took 1 parcel query and 7 roll queries (150 GPINs each).
  - An area over a parcel cap (about 4,000) is refused with the reason, rather than spending the budget.
- **No people-finding.**
  - Outputs are counts and shares, never lists of addresses or parcels.
  - The roll's owner and deed fields stay denied.
  - The Conditional Use Permit layer's `APPLICANT` field is dropped by the same person-column rule `parcel_inventory` uses.
  - A measure over fewer than 5 residential parcels is refused. That prevents describing one household's property by drawing a tiny area around it.
- **Coordinates never reach the model.** Handles are opaque. The model sees names, layers, acres and block numbers.
- **The City's map layers are a guide.** Answers keep `parcel_inventory`'s note: these are open-data layers, not legal determinations. The Official Zoning Map is the final authority (Zoning Ordinance §1.6.1).

## What it costs

No model calls, no new dependency, and no stored data. Each measure is a handful of public GIS and Socrata reads, so its cost is part of the answer's request budget, not money.

## Open questions for Jason

1. **Which Ghent should a bare "Ghent" mean?** Say all matches and answer for each, or default to the Ghent Neighborhood League and name the others?
2. **Is "on Graydon" by address right for the pedestrian-street work?** Counting parcels that touch the segment instead would add corner buildings addressed on cross streets.
3. **Apartment units.** Ranges are honest but wide; most of the 163–295 spread is Graydon's 12 apartment buildings. Narrowing it would need a unit count per building:
   - Census 2020 block counts, which don't follow street frontage;
   - the City's rental inspection or permit records, if they carry units;
   - a records request.

   Worth pursuing, or are ranges enough?
4. **Build order.** I'd build `street_segment` and `measure` (with housing units and the street fields) first, since together they answer this question and serve the pedestrian-street study. `area_lookup` would come next, for "which Ghent".
