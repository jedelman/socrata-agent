# Gaps in the records Siren reads: Norfolk

Built 2026-11-06 by `scripts/build-gaps.js` from `src/gaps/norfolk.js`. Generated: edit the catalog, not this page.

Each gap is measured by code against the live portal, at the same access the open-ended tools have, and dated. A gap has a shape and consequences: what the records Siren reads hold or leave out, and the questions that leaves unanswered. It never gives a cause. The spec is `docs/gaps.md`; every request behind these numbers is in `data/gaps/norfolk.trace.json`.

## The trees topic

Topic-wide checks read cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9. The catalog search “tree” is checked for datasets placed neither in nor out.

- Outside the topic: STORM | System to Track, Organize, Record, and Map (mrv3-rcpc). Its description, as read 2026-11-06, in its words: “STORM, an acronym for System to Track, Organize, Record and Map, captures data collected by residents and city staff during and after inclement weather events. The app captures incidents such as flooded streets, damaged trees, disabled vehicles, downed cable lines, etc.” STORM records incidents reported during and after weather events, damaged trees among them. Those reports are not the City Tree Inventory’s records or Forestry work orders, so the topic-wide column checks leave STORM out. Placed outside the tree topic in the Inc 4 catalog PR; Jason approved the catalog, entries and placements, on 2026-11-06 (A16).

## MyNorfolk 311 requests: out of Siren’s reach by rule

`norfolk.311.restricted` · Out of Siren's reach by rule · state: open · measured 2026-11-09

I don't query MyNorfolk 311 requests (nbyu-xjez) for open-ended questions. Siren's rule, read from its city profile on 2026-11-09, in its words: “MyNorfolk 311 requests are not available to open-ended queries: some request types point at a single household.”

**Where:** MyNorfolk 311 requests; MyNorfolk 311 requests (nbyu-xjez); citywide.

**Questions these records can’t answer, or answer only in part**

- How many tree requests reached MyNorfolk 311 in my ward last year? (can’t answer)  
  I can't answer this: I don't query MyNorfolk 311 requests for open-ended questions, by Siren's rule as read on 2026-11-09.

**What would close it**

- source request: A reviewed plugin that counts MyNorfolk 311 tree requests citywide and by ward, from an exact list of request types, showing “fewer than 5” for small counts as docs/gaps.md I17 requires.

## Agenda items with no street address in their titles

`norfolk.legislation.no-address` · Partial coverage (in the records I read) · state: open · measured 2026-11-09

I found no street address in the titles of 681 of 1,437 agenda items (47%) in Siren's agenda index (built 2026-11-02, meetings 2023-07-11 through 2026-10-22), so I can't match them to a block.

**Where:** agenda items in public meetings; Siren's agenda index; citywide; meetings.date 2023-07-11 through 2026-10-22.

**Questions these records can’t answer, or answer only in part**

- Did the Council act on anything that affects my block? (only in part)  
  With Siren's agenda index (norfolk-legislation) I can answer this only in part: I found no street address in the titles of 681 of 1,437 agenda items (47%) in the index built 2026-11-02, measured 2026-11-09, so I can't match them to a block.

**What would close it**

- source request: List citywide agenda items beside block matches, so agenda items with no street address in their titles still show.

## No field for tree condition (City Tree Inventory)

`norfolk.tree-inventory.no-condition` · Absent or empty field (in the records I read) · state: open · measured 2026-11-06

I found no column for tree condition, health or risk in any of the 4 tree datasets I read (cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9), as I read them on 2026-11-06. I found problem codes such as “Dead Tree” on 770, “Diseased” on 127 and “Damaged Tree” on 258 Forestry work orders in the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06.

**Where:** city-managed trees; City Tree Inventory (cmvv-agyb), Work Orders (qzfe-wj25); citywide.

**Questions these records can’t answer, or answer only in part**

- What condition are the street trees on my block in? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found problem codes such as “Dead Tree” on 770, “Diseased” on 127 and “Damaged Tree” on 258 Forestry work orders, measured 2026-11-06, and I found no column for condition in the City Tree Inventory (cmvv-agyb).
- Which street trees are at risk of failing? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found problem codes such as “Dead Tree” on 770, “Diseased” on 127 and “Damaged Tree” on 258 Forestry work orders, measured 2026-11-06, and I found no column for condition in the City Tree Inventory (cmvv-agyb).

**What would close it**

- dataset proposal: Add tree condition to the City Tree Inventory.
- meeting question: Does the City record the condition of its street trees, and where can residents read it?

<details><summary>How this was measured</summary>

- `SELECT problem_description AS v, count(*) AS n WHERE area = 'Forestry' GROUP BY problem_description ORDER BY n DESC, problem_description LIMIT 200` on qzfe-wj25, read 2026-11-07T01:01:58.974Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20problem_description%20AS%20v%2C%20count(*)%20AS%20n%20WHERE%20area%20%3D%20'Forestry'%20GROUP%20BY%20problem_description%20ORDER%20BY%20n%20DESC%2C%20problem_description%20LIMIT%20200))

</details>

## City trees with no usable trunk size

`norfolk.tree-inventory.no-usable-size` · Absent or empty field (in the records I read) · state: open · measured 2026-11-06 · optional entry

I found 6,918 of 93,997 city trees (7%) with neither a trunk-size range nor a trunk diameter above zero in the City Tree Inventory (cmvv-agyb), leaving out rows labeled “PRIVATE TREES”, as I read it on 2026-11-06. Its description of trunk_diameter, in its words: “The approximate trunk diameter of the tree. Since trees grow over time, the current diameter may be larger than what data shows.”

**Where:** city trees; City Tree Inventory (cmvv-agyb); citywide.

**Questions these records can’t answer, or answer only in part**

- How big are the trees on my block? (only in part)  
  With the City Tree Inventory (cmvv-agyb) I can answer this only in part: I found 6,918 of 93,997 city trees (7%) with neither a trunk-size range nor a trunk diameter above zero, measured 2026-11-06, so I can't give their size.

**What would close it**

- dataset proposal: Fill the trunk size on every city tree record.

<details><summary>How this was measured</summary>

- `SELECT count(*) AS whole, sum(case(trunk_diameter_range IS NULL,1,true,0)) AS no_range, sum(case(trunk_diameter IS NULL,1,true,0)) AS no_dia, sum(case((trunk_diameter IS NULL OR trunk_diameter <= 0) AND trunk_diameter_range IS NULL,1,true,0)) AS no_usable WHERE (common_name IS NULL OR common_name != 'PRIVATE TREES') LIMIT 100` on cmvv-agyb, read 2026-11-07T01:01:59.269Z ([run it yourself](https://data.norfolk.gov/resource/cmvv-agyb.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(trunk_diameter_range%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_range%2C%20sum(case(trunk_diameter%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_dia%2C%20sum(case((trunk_diameter%20IS%20NULL%20OR%20trunk_diameter%20%3C%3D%200)%20AND%20trunk_diameter_range%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_usable%20WHERE%20(common_name%20IS%20NULL%20OR%20common_name%20!%3D%20'PRIVATE%20TREES')%20LIMIT%20100))

</details>

## Survey date stated by the City Tree Inventory

`norfolk.tree-inventory.survey-date` · Survey date stated by the source · state: open · measured 2026-11-06

The City Tree Inventory's own description (cmvv-agyb), as I read it on 2026-11-06, says: “The original inventory of these trees was conducted in the late 1990s/early 2000s by the Norfolk Master Gardeners. No official re-inventory has been conducted since then by City officials or ISA Certified Arborists, however, tree records in this dataset have been and are being updated over time by City Staff.” I found no column dating when each tree's record was surveyed or updated among its 13 data columns, as I read them on 2026-11-06.

**Where:** city-managed trees; City Tree Inventory (cmvv-agyb); citywide.

**Questions these records can’t answer, or answer only in part**

- How many street trees does Norfolk have now? (only in part)  
  With the City Tree Inventory (cmvv-agyb) I can answer this only in part: I found no column dating when each tree's record was surveyed or updated among its 13 data columns, measured 2026-11-06, so I can count its records but not date them.
- How current is the City's record of the trees on my block? (only in part)  
  With the City Tree Inventory (cmvv-agyb) I can answer this only in part: I found no column dating when each tree's record was surveyed or updated among its 13 data columns, measured 2026-11-06, so I can count its records but not date them.

**What would close it**

- meeting question: Does the City plan a re-inventory of its street trees?

## Utility line clearance in the sources checked

`norfolk.utility.line-clearance` · I found no records (sources checked) · state: open · measured 2026-11-06

I found 0 datasets in Norfolk's open data catalog for the search “line clearance”, and 4 for “Dominion”, all open to Siren: Streetlights and Outages Reports, Municipal Building Energy Use, Address Information, Street Light Outages (searched 2026-11-06). I found 18 problem descriptions on Forestry work orders in the City's Work Orders records (qzfe-wj25), none matching “utility”, “power line”, “line clearance” or “Dominion”, as I read them on 2026-11-06. Dominion Energy's page says: “Nearly all of our neighborhood power lines are cleared on a four year cycle” (quote checked 2026-11-06).

**Where:** tree work near utility lines; data.norfolk.gov, Work Orders (qzfe-wj25); citywide.

**Questions these records can’t answer, or answer only in part**

- Which tree work near me was utility line clearance? (can’t answer)  
  I found no column for utility line clearance in any of the 4 tree datasets I read (cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9), measured 2026-11-06, so I can't answer this from them.

**What would close it**

- meeting question: Does the City keep a record of utility line-clearance tree work on City streets, and where can residents read it? (City only)

## Removal orders created on or after their end date

`norfolk.work-orders.created-on-or-after-end` · Created on or after its end date · state: open · measured 2026-11-06

Of 360 Forestry removal work orders with status “Complete” and an end date from 2025-11-06 through 2026-11-05, I found 115 (32%) with an end date on or before the day they were created (22 before it, 93 the same day), in the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06.

**Where:** Forestry removal work orders; Work Orders (qzfe-wj25); status as recorded: Complete; citywide; end_date 2025-11-06 through 2026-11-05.

**Questions these records can’t answer, or answer only in part**

- Can I find out before a street tree near me is removed? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found 115 of 360 Forestry removal work orders with status “Complete” and an end date from 2025-11-06 through 2026-11-05 (32%) created on or after the day of their end date, measured 2026-11-06, so a search of these records made before their end date finds no order for them.

**What would close it**

- meeting question: Does the City give residents notice before it removes a street tree, and where is that notice recorded?
- watch: A private watch on your own street, once Siren offers watches. (not offered yet)

<details><summary>How this was measured</summary>

- `SELECT count(*) AS whole, sum(case(date_trunc_ymd(end_date) < date_trunc_ymd(created_datetime),1,true,0)) AS before, sum(case(date_trunc_ymd(end_date) = date_trunc_ymd(created_datetime),1,true,0)) AS same WHERE area = 'Forestry' AND primary_task_description = 'Removal' AND status_code = 999 AND end_date >= '2025-11-06T00:00:00' AND end_date < '2026-11-06T00:00:00' LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:57.861Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(date_trunc_ymd(end_date)%20%3C%20date_trunc_ymd(created_datetime)%2C1%2Ctrue%2C0))%20AS%20before%2C%20sum(case(date_trunc_ymd(end_date)%20%3D%20date_trunc_ymd(created_datetime)%2C1%2Ctrue%2C0))%20AS%20same%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20AND%20status_code%20%3D%20999%20AND%20end_date%20%3E%3D%20'2025-11-06T00%3A00%3A00'%20AND%20end_date%20%3C%20'2026-11-06T00%3A00%3A00'%20LIMIT%20100))
- `SELECT count(*) AS whole, sum(case(date_trunc_ymd(end_date) < date_trunc_ymd(created_datetime),1,true,0)) AS before, sum(case(date_trunc_ymd(end_date) = date_trunc_ymd(created_datetime),1,true,0)) AS same WHERE area = 'Forestry' AND primary_task_description = 'Removal' AND status_code = 999 AND end_date IS NOT NULL LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:57.982Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(date_trunc_ymd(end_date)%20%3C%20date_trunc_ymd(created_datetime)%2C1%2Ctrue%2C0))%20AS%20before%2C%20sum(case(date_trunc_ymd(end_date)%20%3D%20date_trunc_ymd(created_datetime)%2C1%2Ctrue%2C0))%20AS%20same%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20AND%20status_code%20%3D%20999%20AND%20end_date%20IS%20NOT%20NULL%20LIMIT%20100))

</details>

## No field naming a requester or approver (Work Orders)

`norfolk.work-orders.no-approver` · No field naming who decided (in the records I read) · state: open · measured 2026-11-06

I found no column naming a requester or approver of a work order among the 32 columns of the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06.

**Where:** Work Orders columns; Work Orders (qzfe-wj25); citywide.

**Questions these records can’t answer, or answer only in part**

- Which City office approves street-tree removals, and on what criteria? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found no column naming a requester or approver of a work order among its 32 columns, measured 2026-11-06, so I can name only the department, priority and problem code the records hold.

**What would close it**

- meeting question: Which City office approves street-tree removals, and on what criteria?
- foia draft: Records-request draft: waits for a records_to_request entry for removal policy, criteria, the approving position and counts by request source with names left out, added to data/cases/norfolk-trees.json by case-file PR.

## No field linking a work order to a contract

`norfolk.work-orders.no-contract-link` · Absent or empty field (in the records I read) · state: open · measured 2026-11-06

I found no column linking a work order to a contract or invoice among the 32 columns of the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06. I found a contractor cost above zero on 563 of 2,378 of its Forestry removal work orders with status “Complete” (24%), as I read them on 2026-11-06. The City's FY2024 adopted budget says: “Technical adjustment to support a $250,000 contractual increase in expenses and increased utilization of the city's tree care maintenance contract. The contract is used to remove decaying or diseased trees throughout the city.” (quote checked 2026-11-06).

**Where:** Forestry removal work orders; Work Orders (qzfe-wj25); status as recorded: Complete; citywide.

**Questions these records can’t answer, or answer only in part**

- Does every contracted tree removal have a work order in these records? (can’t answer)  
  I found no column linking a work order to a contract or invoice in any of the 4 tree datasets I read (cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9), measured 2026-11-06, so I can't answer this from them.
- How many trees did City contractors remove last year? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found a contractor cost above zero on 563 of 2,378 Forestry removal work orders with status “Complete” (24%), measured 2026-11-06, which counts orders, not trees.

**What would close it**

- foia draft: All tree-care contracts and invoices from FY2020 to now, with trees pruned, removed and stump-ground per invoice.
- dataset proposal: Mark on each work order whether a City crew or a contractor did the work.

<details><summary>How this was measured</summary>

- `SELECT status_code, status_description, count(*) AS whole, sum(case(street IS NULL,1,true,0)) AS no_street, sum(case(contractor_cost > 0,1,true,0)) AS cc, sum(case(end_date IS NOT NULL,1,true,0)) AS has_end WHERE area = 'Forestry' AND primary_task_description = 'Removal' GROUP BY status_code, status_description ORDER BY status_code, status_description LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:56.871Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20status_code%2C%20status_description%2C%20count(*)%20AS%20whole%2C%20sum(case(street%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_street%2C%20sum(case(contractor_cost%20%3E%200%2C1%2Ctrue%2C0))%20AS%20cc%2C%20sum(case(end_date%20IS%20NOT%20NULL%2C1%2Ctrue%2C0))%20AS%20has_end%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20GROUP%20BY%20status_code%2C%20status_description%20ORDER%20BY%20status_code%2C%20status_description%20LIMIT%20100))

</details>

## No field for notice to residents

`norfolk.work-orders.no-notice-field` · Absent or empty field (in the records I read) · state: open · measured 2026-11-06

I found no column for notice to residents in any of the 4 tree datasets I read (cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9), as I read them on 2026-11-06.

**Where:** tree datasets; City Tree Inventory (cmvv-agyb), Work Orders (qzfe-wj25), Significant Trees (jz6u-9g3c), Tree Planting Program (u85v-sad9); citywide.

**Questions these records can’t answer, or answer only in part**

- How much notice does the City give before removing a street tree? (can’t answer)  
  I found no column for notice to residents in any of the 4 tree datasets I read (cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9), measured 2026-11-06, so I can't answer this from them.

**What would close it**

- meeting question: Does the City give residents notice before it removes a street tree, and where is that notice recorded?

## No field for a planned date (Work Orders)

`norfolk.work-orders.no-planned-date` · Absent or empty field (in the records I read) · state: open · measured 2026-11-06

I found no column for a planned or scheduled date among the 32 columns of the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06. Its description of start_date, in its words: “Date the work on the work order began.” I found 353 Forestry removal work orders with status “New Work Order” or “On-Going” (50 of them with an end date), a median of 941 days since created, as I read them on 2026-11-06.

**Where:** Forestry removal work orders; Work Orders (qzfe-wj25); citywide.

**Questions these records can’t answer, or answer only in part**

- When is a logged tree removal on my street planned to happen? (can’t answer)  
  I found no column for a planned or scheduled date in any of the 4 tree datasets I read (cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9), measured 2026-11-06, so I can't answer this from them.

**What would close it**

- meeting question: Does the City keep a planned date for each street-tree removal, and can residents see it?
- foia draft: Records-request draft: waits for a records_to_request entry for planned removal dates, added to data/cases/norfolk-trees.json by case-file PR.

<details><summary>How this was measured</summary>

- `SELECT count(*) AS whole, sum(case(end_date IS NOT NULL,1,true,0)) AS with_end WHERE area = 'Forestry' AND primary_task_description = 'Removal' AND status_code in (2, 4) LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:58.527Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(end_date%20IS%20NOT%20NULL%2C1%2Ctrue%2C0))%20AS%20with_end%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20AND%20status_code%20in%20(2%2C%204)%20LIMIT%20100))
- `SELECT created_datetime WHERE area = 'Forestry' AND primary_task_description = 'Removal' AND status_code in (2, 4) ORDER BY created_datetime, work_order_number LIMIT 1 OFFSET 176` on qzfe-wj25, read 2026-11-07T01:01:58.649Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20created_datetime%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20AND%20status_code%20in%20(2%2C%204)%20ORDER%20BY%20created_datetime%2C%20work_order_number%20LIMIT%201%20OFFSET%20176))

</details>

## No field for trees per work order

`norfolk.work-orders.no-trees-per-order` · Absent or empty field (in the records I read) · state: open · measured 2026-11-06

I found no column for the number of trees on a work order among the 32 columns of the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06.

**Where:** Work Orders columns; Work Orders (qzfe-wj25); citywide.

**Questions these records can’t answer, or answer only in part**

- How many street trees did the City remove last year? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found no column for the number of trees on a work order among its 32 columns, measured 2026-11-06, so I can count removal orders, not trees.

**What would close it**

- foia draft: A Forestry work-order export with the number of trees per order, request source, and whether a City crew or a contractor did the work.

## Forestry removals with no street (Work Orders)

`norfolk.work-orders.removal-no-street` · Absent or empty field (in the records I read) · state: open · measured 2026-11-06

I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street in the City's Work Orders records (qzfe-wj25), created 2020-08-05 through 2026-10-30, as I read them on 2026-11-06. Of the 272 with status “Complete” created since 2025-11-06, I found 24 with no street, and 22 of those 24 with no ward or civic league either, as I read them on 2026-11-06. Of the 353 with status “New Work Order” or “On-Going”, I found 85 with no street, as I read them on 2026-11-06.

**Where:** Forestry removal work orders; Work Orders (qzfe-wj25); status as recorded: Complete; citywide; created_datetime 2020-08-05 through 2026-10-30.

| Year created | With none | Of |
|---|---|---|
| 2020 | 21 | 205 |
| 2021 | 44 | 315 |
| 2022 | 101 | 499 |
| 2023 | 134 | 407 |
| 2024 | 149 | 343 |
| 2025 | 112 | 363 |
| 2026 | 21 | 246 |

**Questions these records can’t answer, or answer only in part**

- Was a city tree removed on my street? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street, measured 2026-11-06, so a street search can't find them.
- Is a tree removal logged for my street? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street, measured 2026-11-06, so a street search can't find them.
- Which streets had city tree removals last year? (only in part)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street, measured 2026-11-06, so a street search can't find them.

**What would close it**

- meeting question: Does the City plan to record a street on every Forestry work order?
- dataset proposal: Record a street on every Forestry work order.
- watch: A private watch on your own street, once Siren offers watches. (not offered yet)

<details><summary>How this was measured</summary>

- `SELECT status_code, status_description, count(*) AS whole, sum(case(street IS NULL,1,true,0)) AS no_street, sum(case(contractor_cost > 0,1,true,0)) AS cc, sum(case(end_date IS NOT NULL,1,true,0)) AS has_end WHERE area = 'Forestry' AND primary_task_description = 'Removal' GROUP BY status_code, status_description ORDER BY status_code, status_description LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:56.871Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20status_code%2C%20status_description%2C%20count(*)%20AS%20whole%2C%20sum(case(street%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_street%2C%20sum(case(contractor_cost%20%3E%200%2C1%2Ctrue%2C0))%20AS%20cc%2C%20sum(case(end_date%20IS%20NOT%20NULL%2C1%2Ctrue%2C0))%20AS%20has_end%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20GROUP%20BY%20status_code%2C%20status_description%20ORDER%20BY%20status_code%2C%20status_description%20LIMIT%20100))
- `SELECT min(created_datetime) AS min_created_datetime, max(created_datetime) AS max_created_datetime WHERE area = 'Forestry' AND primary_task_description = 'Removal' AND status_code = 999 LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:57.425Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20min(created_datetime)%20AS%20min_created_datetime%2C%20max(created_datetime)%20AS%20max_created_datetime%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20AND%20status_code%20%3D%20999%20LIMIT%20100))
- `SELECT date_extract_y(created_datetime) AS y, count(*) AS whole, sum(case(street IS NULL,1,true,0)) AS part WHERE area = 'Forestry' AND primary_task_description = 'Removal' AND status_code = 999 GROUP BY y ORDER BY y LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:57.592Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20date_extract_y(created_datetime)%20AS%20y%2C%20count(*)%20AS%20whole%2C%20sum(case(street%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20part%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20AND%20status_code%20%3D%20999%20GROUP%20BY%20y%20ORDER%20BY%20y%20LIMIT%20100))
- `SELECT count(*) AS whole, sum(case(street IS NULL,1,true,0)) AS part, sum(case(street IS NULL AND ward IS NULL AND civic_league IS NULL,1,true,0)) AS no_loc WHERE area = 'Forestry' AND primary_task_description = 'Removal' AND status_code = 999 AND created_datetime >= '2025-11-06T00:00:00' LIMIT 100` on qzfe-wj25, read 2026-11-07T01:01:57.709Z ([run it yourself](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(street%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20part%2C%20sum(case(street%20IS%20NULL%20AND%20ward%20IS%20NULL%20AND%20civic_league%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_loc%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Removal'%20AND%20status_code%20%3D%20999%20AND%20created_datetime%20%3E%3D%20'2025-11-06T00%3A00%3A00'%20LIMIT%20100))

</details>

## Retired ids

Never reused: `norfolk.work-orders.removal-recorded-late`, `norfolk.work-orders.removal-no-future-date`, `norfolk.work-orders.contract-work`, `norfolk.work-orders.trees-per-order`, `norfolk.work-orders.removal-no-approver`, `norfolk.tree-inventory.survey-age`, `norfolk.tree-inventory.no-trunk-size`.
