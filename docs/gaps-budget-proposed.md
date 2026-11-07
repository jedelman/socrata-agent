# Proposed budget gaps: Norfolk

**PROPOSED, not in the catalog.** Built 2026-11-06 by `scripts/build-gaps-proposed.js` from `src/gaps/proposed/norfolk-budget.js`. Generated: edit the proposal module, not this page.

Catalog entries go public when merged, and every new one needs Jason’s approval (docs/gaps.md §4). These entries are drafts for that review. Nothing under `src/` or `worker/` imports the proposal module, `scripts/build-gaps.js` never reads it, and no gap here reaches Siren’s answers, the board or the bundled gap file. To approve one, move its entry and actions into `src/gaps/norfolk.js` and `src/gaps/actions-norfolk.js`, dropping the review-only keys (`proposed`, `why`, `context`, `related`, `sources`), copy with it the source constants and helpers it calls from the proposal module, and rebuild the catalog.

Dates are America/New_York calendar dates, as the catalog builder writes them (docs/gaps.md §5.3); read times are UTC.

Each entry was measured live against data.norfolk.gov through the catalog’s own builder: the fixed measure menu at GENERIC access, through the traced client, under the positional identifier rule. Every statement, short line, title, question, consequence line and action passed `gapTextViolations` and `publicTextViolations` with the City’s street list, and so did the prose below. Every request and response is in `data/gaps/proposed-norfolk-budget.trace.json`, with the built records in the catalog’s schema under `file`.

## Candidates tested

| Candidate | Outcome | Why |
|---|---|---|
| 1. Forestry spending inside park upkeep | kept as norfolk.budget.forestry-in-park-unit | The budget book’s description of the program enters as reviewer context only, with its URL and page, because I opened it and found the words; the statement stands on the dataset alone. |
| 2. Three fiscal years in the open data | kept as norfolk.budget.three-fiscal-years | The part about earlier years living only in the budget books is left out: the catalog search “budget” lists capital plans for earlier years, though none for spending lines or revenue, and the entry states only what the open records hold, with that search in its evidence. |
| 3. Contractual spending not tied to work | kept as norfolk.budget.contractual-no-link, spending side only | The work-order side, where contractor cost half-answers which tree work was paid for, is an approved catalog entry, linked from this one; this entry keeps the contracts question only, and leaves the line’s amounts out of the statement. |
| 4. Pruning in the performance measures | split into norfolk.budget.no-pruning-measure and norfolk.budget.trees-planted-no-yearly-values | The checked quote holds only the measure’s name, so the FY2021 through FY2023 percentages and the target stay out; the empty year columns of the trees-planted measure are a different gap, so they are their own entry. |
| 5. Capital projects with no ward | kept as norfolk.budget.cip-no-ward | Measured live with coordinates and the location field too, and the count matches the one in the request; the free-text location half-answers both questions. |
| 6. Revenue and spending units | reshaped as norfolk.budget.parks-revenue-units | I found every department name in Annual Revenues also in Annual Expenditures, so the mismatch is narrowed to unit names under Parks and Recreation, compared within each fiscal year, where I found it. |
| 7. Only the amended budget published | kept as norfolk.budget.no-amendment-history | Scoped to Annual Expenditures, since its description says its budget reflects amendments, and Annual Revenues describes its budget as the adopted one; Siren’s agenda index holds the titles of the ordinances amending the annual appropriations, so the question of when a budget changed is answered there in part. |

## No unit or field for Forestry spending alone (Annual Expenditures)

`norfolk.budget.forestry-in-park-unit` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found 1 unit with “Forestry” in its name in the City's Annual Expenditures records (mdwe-dquf), “Park and Forestry Operations”, as I read them on 2026-11-06. I found none of the 40 expense line names under it naming forestry, trees or pruning, as I read them on 2026-11-06. I found no column for an activity or service within a unit among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06.

**Short:** I found “Forestry” in one unit name in the City's Annual Expenditures, “Park and Forestry Operations”, and no expense line under it naming trees, measured 2026-11-06.

**Shape**

- where: spending lines of units with Forestry in their name; Annual Expenditures (mdwe-dquf); citywide
- columns_absent /activit|service|task|forest|tree/i over mdwe-dquf (8 columns), read 2026-11-07T04:09:50.225Z
- values of mdwe-dquf.object_name: 40; none matched, read 2026-11-07T04:09:50.106Z

**Questions it leaves unanswered, with consequence lines**

- How much does the City spend on street-tree work each year? (only in part; half-answered by mdwe-dquf.unit_name, qzfe-wj25.total_cost)  
  With the City's Annual Expenditures records (mdwe-dquf) I can answer this only in part: I found “Forestry” in the name of one unit, “Park and Forestry Operations”, and none of its 40 expense line names mentions forestry, trees or pruning, measured 2026-11-06, so I can give that unit's spending but not the part spent on trees; Forestry work orders in the City's Work Orders records (qzfe-wj25) carry a total_cost column.

**Proposed actions**

- `a-budget-proposal-activity` dataset proposal: Publish an activity or service field below the unit in Annual Expenditures, so spending on street trees can be read apart from the rest of its unit.
- `a-budget-meeting-forestry` meeting question: How much of the Park and Forestry Operations budget goes to street-tree work each year, and where is that recorded? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

Annual Expenditures holds spending by department, unit and expense line. I found “Forestry” in one unit name, and that name covers park operations as well, and I found no field or expense line that splits the Forestry part out. The entry states what the records hold and leave out, and claims nothing about what the City spends on trees.

**Reviewer context (not evidence on the board):** The City’s FY2027 budget book, which I opened and checked on 2026-11-06, describes the program on PDF page 176 (printed page 300), in its words: “The Parks and Forestry Operations program maintains the beautification of the city by providing mowing, landscape maintenance, litter control, turf installation, emptying refuse receptacles, applying fertilizer and herbicide, and maintaining/repairing irrigation.” The same page, in its words: “The program maintains all trees on City property including street trees through pruning, removal, and planting services”. The book is not evidence on the board: it enters only as a case-file finding, checked by verify-cases, through a case-file PR.

- Source opened 2026-11-06: [The City's FY2027 budget book, department budgets](https://www.norfolk.gov/DocumentCenter/View/114013/09-Department-Budgets), PDF page 176 (printed page 300).

<details><summary>Evidence</summary>

- values of mdwe-dquf.unit_name, read 2026-11-07T04:09:49.978Z (trace step 7), pattern /forest/i: “Park and Forestry Operations”; matched “Park and Forestry Operations”
- values of mdwe-dquf.object_name, read 2026-11-07T04:09:50.106Z (trace step 8), pattern /forest|\btrees?\b|prun|arbor/i: 40 values; matched none
- metadata of mdwe-dquf, read 2026-11-07T04:09:50.225Z (trace step 9): 8 columns

</details>

## Fiscal years held in the open spending and revenue records

`norfolk.budget.three-fiscal-years` · proposed · kind `partial_coverage` (Partial coverage (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found fiscal years FY2025, FY2026 and FY2027 in the City's Annual Expenditures records (mdwe-dquf), and the same years in the City's Annual Revenues records (id3i-2az4), as I read them on 2026-11-06. Of the 10 fiscal years FY2018 through FY2027, I found 3 in both datasets, as I read them on 2026-11-06. The Annual Expenditures description (mdwe-dquf), as I read it on 2026-11-06, says: “This dataset summarizes the city’s cash outlays and accruals for the cost of goods received or services rendered, by department, department unit/division, and expenditure type, for three years; the current fiscal year and two previous fiscal years.” The Annual Revenues description (id3i-2az4), as I read it on 2026-11-06, says: “The data set includes the current fiscal year and two previous fiscal years.” The Annual Expenditures description of actual_expenses, in its words: “Sum of fiscal year-to-date expenditures for this department/fund/unit/object line”. I found 16 datasets in Norfolk's open data catalog for the search “budget”, and none besides these two named for expenditures, revenues or spending (searched 2026-11-06).

**Short:** I found fiscal years FY2025 through FY2027 in the City's Annual Expenditures, and FY2025 through FY2027 in its Annual Revenues, measured 2026-11-06.

**Shape**

- where: fiscal years in the open spending and revenue records; Annual Expenditures (mdwe-dquf), Annual Revenues (id3i-2az4), data.norfolk.gov; citywide
- part 7 of 10 (70%), read 2026-11-07T04:09:50.604Z
- values of mdwe-dquf.fiscal_year: 3; matched: “2025”, “2026”, “2027”, read 2026-11-07T04:09:50.401Z
- catalog search “budget”: 16 (Capital Improvement Plan (CIP) Projects - FY 2025, 6njp-hen5; Capital Improvement Plan (CIP) Projects - FY 2027, 6tqj-4az3; Performance Measures, 7jsp-eyjg; Resident Survey 2024 - Summarized Comments, 8j55-9gjp; Resident Survey 2024, de5p-5xvj; Capital Improvement Plan (CIP) Projects - FY 2026, dpv9-3yq2; Resident Survey 2024 Demographics, ez9d-udp9; Resident Survey 2022 Demographics, f3mt-z6yp; Capital Improvement Projects (CIP) - FY20, fumf-ph9r; Annual Revenues, id3i-2az4; Capital Improvement Plan (CIP) Projects - FY24, jbfz-2t3g; Public Art, k8ry-iqjg; American Rescue Plan Act State and Local Recovery Funds Project Status, kekx-9mip; Annual Expenditures, mdwe-dquf), read 2026-11-07T04:09:51.632Z
- description quote from mdwe-dquf, read 2026-11-07T04:09:50.225Z
- rows last updated 2026-11-06T12:26:36.000Z

**Questions it leaves unanswered, with consequence lines**

- How has Parks and Recreation spending changed over the last ten years? (only in part; half-answered by mdwe-dquf.fiscal_year)  
  With the City's Annual Expenditures records (mdwe-dquf) I can answer this only in part: I found 3 fiscal years in them, FY2025 through FY2027, measured 2026-11-06, so I can show those years only, with FY2027 spending to date.
- How has the City's revenue from fees and taxes changed over the last ten years? (only in part; half-answered by id3i-2az4.fiscal_year)  
  With the City's Annual Revenues records (id3i-2az4) I can answer this only in part: I found 3 fiscal years in them, FY2025 through FY2027, measured 2026-11-06, so I can show those years only, with FY2027 collections to date.

**Proposed actions**

- `a-budget-proposal-years` dataset proposal: Publish earlier fiscal years of Annual Expenditures and Annual Revenues beside the current three.
- `a-budget-meeting-years` meeting question: Does the City plan to publish earlier fiscal years of its spending and revenue data, and where can residents read them now? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

Both datasets describe themselves as holding the current fiscal year and two before it, and I found three fiscal years in each. A question about a longer trend is answered from them only in part. The entry reports the years the open records hold, and says nothing about records kept elsewhere.

**Reviewer context (not evidence on the board):** The City’s FY2027 budget book, which I opened and checked on 2026-11-06, carries a column headed “FY 2024 Actual” in the Parks and Recreation summaries on PDF page 173 (printed page 297). That column sits outside the open records, and the book is not evidence on the board. I found capital plans for earlier years beside the current one in the catalog search “budget” (the evidence names them), searched 2026-11-06; they hold capital projects, not spending lines or revenue, so the entry leaves them out of its years. The spec’s kinds table asks a partial_coverage entry for a share over a bundled index or a verified finding, and this one carries a share over the years read from the two datasets: a difference for Jason to rule on.

- Source opened 2026-11-06: [The City's FY2027 budget book, department budgets](https://www.norfolk.gov/DocumentCenter/View/114013/09-Department-Budgets), PDF page 173 (printed page 297).

<details><summary>Evidence</summary>

- values of mdwe-dquf.fiscal_year, read 2026-11-07T04:09:50.401Z (trace step 10), pattern /^\d{4}$/: “2026”, “2025”, “2027”; matched “2025”, “2026”, “2027”
- values of id3i-2az4.fiscal_year, read 2026-11-07T04:09:50.604Z (trace step 12), pattern /^\d{4}$/: “2025”, “2026”, “2027”; matched “2025”, “2026”, “2027”
- metadata of mdwe-dquf, read 2026-11-07T04:09:50.225Z (trace step 9): “This dataset summarizes the city’s cash outlays and accruals for the cost of goods received or services rendered, by department, department unit/division, and expenditure type, for three years; the current fiscal year and two previous fiscal years.”
- metadata of id3i-2az4, read 2026-11-07T04:09:50.708Z (trace step 13): “The data set includes the current fiscal year and two previous fiscal years.”
- metadata of mdwe-dquf, read 2026-11-07T04:09:50.225Z (trace step 9): actual_expenses, “Sum of fiscal year-to-date expenditures for this department/fund/unit/object line”
- catalog search “budget”, read 2026-11-07T04:09:51.632Z (trace step 14): 16 (0 excluded), open to Siren: Capital Improvement Plan (CIP) Projects - FY 2025 (6njp-hen5), Capital Improvement Plan (CIP) Projects - FY 2027 (6tqj-4az3), Performance Measures (7jsp-eyjg), Resident Survey 2024 - Summarized Comments (8j55-9gjp), Resident Survey 2024 (de5p-5xvj), Capital Improvement Plan (CIP) Projects - FY 2026 (dpv9-3yq2), Resident Survey 2024 Demographics (ez9d-udp9), Resident Survey 2022 Demographics (f3mt-z6yp), Capital Improvement Projects (CIP) - FY20 (fumf-ph9r), Annual Revenues (id3i-2az4), Capital Improvement Plan (CIP) Projects - FY24 (jbfz-2t3g), Public Art (k8ry-iqjg), American Rescue Plan Act State and Local Recovery Funds Project Status (kekx-9mip), Annual Expenditures (mdwe-dquf)

</details>

## No field linking spending lines to a contract or work order (Annual Expenditures)

`norfolk.budget.contractual-no-link` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found no column naming a vendor, contract, invoice, purchase order or work order among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06. Under “Park and Forestry Operations”, I found 1 line named “Other Contractual Services” for FY2026, as I read them on 2026-11-06. I found 0 datasets in Norfolk's open data catalog for the search “checkbook”, 1 dataset for “vendor”, open to Siren: Municipal Building Energy Use, 7 datasets for “contract”, 5 open to Siren: Resident Survey 2024 - Summarized Comments, Resident Survey 2024, Resident Survey 2024 Demographics, Resident Survey 2022 Demographics, Resident Survey 2022, and 2 datasets for “purchase order”, all open to Siren: Work Orders, Better Buildings Challenge Properties (searched 2026-11-06).

**Short:** I found no column in the City's Annual Expenditures tying a spending line to a vendor, contract, purchase order or work order, measured 2026-11-06.

**Shape**

- where: spending lines; Annual Expenditures (mdwe-dquf), data.norfolk.gov; citywide
- columns_absent /vendor|payee|supplier|contract|invoice|purchase|work_?order|(^|_)po(_|$)/i over mdwe-dquf (8 columns), read 2026-11-07T04:09:50.225Z
- catalog search “checkbook”: 0, read 2026-11-07T04:09:51.840Z
- catalog search “vendor”: 1 (Municipal Building Energy Use, 9v4p-ntch), read 2026-11-07T04:09:51.937Z
- catalog search “contract”: 7 (Resident Survey 2024 - Summarized Comments, 8j55-9gjp; Resident Survey 2024, de5p-5xvj; Resident Survey 2024 Demographics, ez9d-udp9; Resident Survey 2022 Demographics, f3mt-z6yp; Resident Survey 2022, qure-5p8r), read 2026-11-07T04:09:52.037Z
- catalog search “purchase order”: 2 (Work Orders, qzfe-wj25; Better Buildings Challenge Properties, ykcq-76im), read 2026-11-07T04:09:52.121Z

**Questions it leaves unanswered, with consequence lines**

- Which contracts did the City pay from the Park and Forestry Operations contractual services line last year? (can’t answer)  
  I found no column naming a vendor, contract, invoice, purchase order or work order among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), measured 2026-11-06, so I can't answer this from them.

**Proposed actions**

- `a-budget-proposal-contract-number` dataset proposal: Publish a contract or purchase order number on each Annual Expenditures line, so contractual spending can be tied to the work it paid for.
- `a-budget-meeting-contracts` meeting question: Which contracts does the Park and Forestry Operations line for other contractual services pay for, and where are they recorded? (ask: City Clerk (to speak at Council))
- `a-budget-foia-contracts` foia draft: records-request draft: waits for a records_to_request entry for the contracts paid from the Park and Forestry Operations contractual services line, added to a case file by case-file PR.

**Why it is a gap, not a finding or a complaint**

The line “Other Contractual Services” records an amount and a budget for a unit and a year. I found no column in Annual Expenditures that ties a line to a contract, a purchase order or a work order, so the work an amount paid for stays out of these records. The entry describes that missing link, and claims nothing about whether any payment was right. The work-order side, with its contractor cost, is an approved catalog entry, linked from this one, and this entry measures only Annual Expenditures and the catalog.

**Linked, not repeated:** `norfolk.work-orders.no-contract-link` (approved catalog).

**Reviewer context (not evidence on the board):** The request gave this line’s actual expenses and budget for FY2026, and the statement leaves both out. I found no amount measure in the measure menu, checked 2026-11-06, and the shape of the gap is the missing column, which needs no amount. The dataset’s description, as I read it on 2026-11-06, says: “Expenditures will reflect the previous fiscal year’s activity until final entries have been made and the accounting period has been closed.”

<details><summary>Evidence</summary>

- metadata of mdwe-dquf, read 2026-11-07T04:09:50.225Z (trace step 9): 8 columns
- query on mdwe-dquf, read 2026-11-07T04:09:51.757Z (trace step 15): `SELECT count(*) AS whole WHERE unit_name = 'Park and Forestry Operations' AND object_name = 'Other Contractual Services' AND fiscal_year = 2026 LIMIT 100` → `[{"whole":"1"}]` ([run it](https://data.norfolk.gov/resource/mdwe-dquf.json?$query=SELECT%20count(*)%20AS%20whole%20WHERE%20unit_name%20%3D%20'Park%20and%20Forestry%20Operations'%20AND%20object_name%20%3D%20'Other%20Contractual%20Services'%20AND%20fiscal_year%20%3D%202026%20LIMIT%20100))
- catalog search “checkbook”, read 2026-11-07T04:09:51.840Z (trace step 16): 0 (0 excluded)
- catalog search “vendor”, read 2026-11-07T04:09:51.937Z (trace step 17): 1 (0 excluded), open to Siren: Municipal Building Energy Use (9v4p-ntch)
- catalog search “contract”, read 2026-11-07T04:09:52.037Z (trace step 18): 7 (1 excluded), open to Siren: Resident Survey 2024 - Summarized Comments (8j55-9gjp), Resident Survey 2024 (de5p-5xvj), Resident Survey 2024 Demographics (ez9d-udp9), Resident Survey 2022 Demographics (f3mt-z6yp), Resident Survey 2022 (qure-5p8r)
- catalog search “purchase order”, read 2026-11-07T04:09:52.121Z (trace step 19): 2 (0 excluded), open to Siren: Work Orders (qzfe-wj25), Better Buildings Challenge Properties (ykcq-76im)

</details>

## Street-tree pruning in the performance measures checked

`norfolk.budget.no-pruning-measure` · proposed · kind `no_records` (I found no records (sources checked)) · state if approved: open · measured 2026-11-06

**Statement**

Of 361 measures in the City's Performance Measures records (7jsp-eyjg), I found none with a description naming pruning or trimming, as I read them on 2026-11-06. Under the program “Park and Forestry Operations” I found 2 measures, “Number of Park Ranger incident responses” and “Number of trees planted”, as I read them on 2026-11-06. I found 1 dataset in Norfolk's open data catalog for the search “pruning”, open to Siren: Work Orders, and 9 datasets for “performance”, 7 open to Siren: Performance Measures, Plan Reviews, Inspections, Permits - Right of Way, Work Orders, Storm Water Asset Inspections, Better Buildings Challenge Properties (searched 2026-11-06). The City's FY2024 adopted budget says: “Percent of street tree pruning requests fulfilled” (quote checked 2026-11-04). I found the task “Pruning” on 3,293 Forestry work orders in the City's Work Orders records (qzfe-wj25), 2,668 of them with status “Complete”, as I read them on 2026-11-06.

**Short:** Of 361 measures in the City's Performance Measures, I found none naming pruning or trimming, measured 2026-11-06.

**Shape**

- where: performance measures; Performance Measures (7jsp-eyjg), Work Orders (qzfe-wj25), data.norfolk.gov; citywide
- part 0 of 361 (0%), read 2026-11-07T04:09:52.335Z
- values of 7jsp-eyjg.measure_description: 2; none matched, read 2026-11-07T04:09:52.451Z
- catalog search “pruning”: 1 (Work Orders, qzfe-wj25), read 2026-11-07T04:09:52.518Z
- catalog search “performance”: 9 (Performance Measures, 7jsp-eyjg; Plan Reviews, dhk3-hr4y; Inspections, ihzr-5x5n; Permits - Right of Way, mi4h-8pn3; Work Orders, qzfe-wj25; Storm Water Asset Inspections, uvc6-r75u; Better Buildings Challenge Properties, ykcq-76im), read 2026-11-07T04:09:52.619Z

**Questions it leaves unanswered, with consequence lines**

- What share of street-tree pruning requests does the City fulfill each year? (only in part; half-answered by qzfe-wj25.primary_task_description, qzfe-wj25.status_description)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found the task “Pruning” on 3,293 Forestry work orders, 2,668 of them with status “Complete”, measured 2026-11-06, which counts work orders and their status as the City records it, not requests, and I found no pruning measure in the Performance Measures records.

**Proposed actions**

- `a-budget-proposal-pruning-measure` dataset proposal: Add street-tree pruning requests received and fulfilled to the Performance Measures dataset, with a value for each year.
- `a-budget-meeting-pruning-measure` meeting question: Does the City track the share of street-tree pruning requests it fulfills each year, and where can residents read it? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

The City’s FY2024 adopted budget names a measure for street-tree pruning requests fulfilled, by the quote the case file checked. I found no pruning or trimming measure in the open Performance Measures records, and the catalog searches I ran name no other measures dataset, so the question stays open in these records. The entry reports what the dataset holds, and claims nothing about the City’s pruning work or about why a measure is published or left out.

**Reviewer context (not evidence on the board):** The request cited the FY2024 book’s pruning percentages and target from the case file. That finding’s checked quote holds only the measure’s name, “Percent of street tree pruning requests fulfilled”, so only the name enters this entry, and the percentages and the target stay out. The case file’s measure-dropped finding is unverified, so it is not cited. The trees-planted measure, with its empty year columns, is its own proposed entry.

<details><summary>Evidence</summary>

- query on 7jsp-eyjg, read 2026-11-07T04:09:52.335Z (trace step 21): `SELECT count(*) AS whole, sum(case(upper(measure_description) like '%PRUN%',1,true,0)) AS prune, sum(case(upper(measure_description) like '%TRIM%',1,true,0)) AS trim WHERE measure_id IS NOT NULL LIMIT 100` → `[{"whole":"361","prune":"0","trim":"0"}]` ([run it](https://data.norfolk.gov/resource/7jsp-eyjg.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(upper(measure_description)%20like%20'%25PRUN%25'%2C1%2Ctrue%2C0))%20AS%20prune%2C%20sum(case(upper(measure_description)%20like%20'%25TRIM%25'%2C1%2Ctrue%2C0))%20AS%20trim%20WHERE%20measure_id%20IS%20NOT%20NULL%20LIMIT%20100))
- values of 7jsp-eyjg.measure_description, read 2026-11-07T04:09:52.451Z (trace step 22), pattern /prun|trim/i: “Number of Park Ranger incident responses”, “Number of trees planted”; matched none
- catalog search “pruning”, read 2026-11-07T04:09:52.518Z (trace step 23): 1 (0 excluded), open to Siren: Work Orders (qzfe-wj25)
- catalog search “performance”, read 2026-11-07T04:09:52.619Z (trace step 24): 9 (0 excluded), open to Siren: Performance Measures (7jsp-eyjg), Plan Reviews (dhk3-hr4y), Inspections (ihzr-5x5n), Permits - Right of Way (mi4h-8pn3), Work Orders (qzfe-wj25), Storm Water Asset Inspections (uvc6-r75u), Better Buildings Challenge Properties (ykcq-76im)
- query on qzfe-wj25, read 2026-11-07T04:09:52.886Z (trace step 26): `SELECT status_code, status_description, count(*) AS whole WHERE area = 'Forestry' AND primary_task_description = 'Pruning' GROUP BY status_code, status_description ORDER BY status_code, status_description LIMIT 100` → `[{"status_code":"2","status_description":"New Work Order","whole":"570"},{"status_code":"4","status_description":"On-Going","whole":"14"},{"status_code":"940","status_description":"Delete WO","whole":"5"},{"status_code":"951","status_description":"WO Cancelled","whole":"10"},{"status_code":"953","status_description":"No Problem Found","whole":"1"},{"status_code":"956","status_description":"Non-Asset Work Complete","whole":"11"},{"status_code":"957","status_description":"Duplicate Work Order","whole":"14"},{"status_code":"999","status_description":"Complete","whole":"2668"}]` ([run it](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20status_code%2C%20status_description%2C%20count(*)%20AS%20whole%20WHERE%20area%20%3D%20'Forestry'%20AND%20primary_task_description%20%3D%20'Pruning'%20GROUP%20BY%20status_code%2C%20status_description%20ORDER%20BY%20status_code%2C%20status_description%20LIMIT%20100))
- finding norfolk-trees#pruning-requests-fulfilled, quote “Percent of street tree pruning requests fulfilled”, checked 2026-11-04 ([source](https://www.norfolk.gov/DocumentCenter/View/78214/10-Department-Budgets))

</details>

## Trees-planted measure with empty year columns (Performance Measures)

`norfolk.budget.trees-planted-no-yearly-values` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

Under the program “Park and Forestry Operations” in the City's Performance Measures records (7jsp-eyjg), I found the measure “Number of trees planted”, and of its 4 fiscal-year value columns, FY2022 through FY2025, I found all 4 empty, as I read them on 2026-11-06. I found the task “Plantings” on 560 Forestry work orders in the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06.

**Short:** I found 4 of 4 year columns empty on the trees-planted measure in the City's Performance Measures, measured 2026-11-06.

**Shape**

- where: the measure “Number of trees planted” under the program “Park and Forestry Operations”; Performance Measures (7jsp-eyjg), Work Orders (qzfe-wj25); citywide
- part 4 of 4 (100%), read 2026-11-07T04:09:53.000Z

**Questions it leaves unanswered, with consequence lines**

- How many trees did the City plant in each of the last four fiscal years? (only in part; half-answered by qzfe-wj25.primary_task_description)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found the task “Plantings” on 560 Forestry work orders, measured 2026-11-06, which counts orders, not trees, and I found 4 of the 4 year columns for “Number of trees planted” empty in the Performance Measures records, measured 2026-11-06.

**Proposed actions**

- `a-budget-proposal-planted-values` dataset proposal: Fill the yearly values of the trees-planted measure in the Performance Measures dataset.
- `a-budget-meeting-planted-values` meeting question: How many trees did the City plant in each fiscal year, and where can residents read the yearly counts? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

The Performance Measures records carry a measure for trees planted, with a column for each fiscal year. I found each of its year columns empty, so how many trees were planted in a year stays out of these records. The entry reports the empty columns, and claims nothing about how many trees the City planted.

**Reviewer context (not evidence on the board):** The measure’s projection and target columns hold values, but they are a forecast and a goal, not a count for a year gone by, so the entry names neither as a half-answer.

<details><summary>Evidence</summary>

- values of 7jsp-eyjg.measure_description, read 2026-11-07T04:09:52.451Z (trace step 22), pattern /^Number of trees planted$/: “Number of Park Ranger incident responses”, “Number of trees planted”; matched “Number of trees planted”
- query on 7jsp-eyjg, read 2026-11-07T04:09:53.000Z (trace step 27): `SELECT count(*) AS whole, sum(case(fy_2022 IS NULL,1,true,0)) AS no_fy_2022, sum(case(fy_2023 IS NULL,1,true,0)) AS no_fy_2023, sum(case(fy_2024 IS NULL,1,true,0)) AS no_fy_2024, sum(case(fy_2025 IS NULL,1,true,0)) AS no_fy_2025 WHERE program_name = 'Park and Forestry Operations' AND measure_description = 'Number of trees planted' LIMIT 100` → `[{"whole":"1","no_fy_2022":"1","no_fy_2023":"1","no_fy_2024":"1","no_fy_2025":"1"}]` ([run it](https://data.norfolk.gov/resource/7jsp-eyjg.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(fy_2022%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_fy_2022%2C%20sum(case(fy_2023%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_fy_2023%2C%20sum(case(fy_2024%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_fy_2024%2C%20sum(case(fy_2025%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_fy_2025%20WHERE%20program_name%20%3D%20'Park%20and%20Forestry%20Operations'%20AND%20measure_description%20%3D%20'Number%20of%20trees%20planted'%20LIMIT%20100))
- query on qzfe-wj25, read 2026-11-07T04:09:53.112Z (trace step 28): `SELECT primary_task_description AS v, count(*) AS n WHERE area = 'Forestry' GROUP BY primary_task_description ORDER BY n DESC, primary_task_description LIMIT 200` → `[{"v":"Pruning","n":"3293"},{"v":"Stump Grinding","n":"2995"},{"v":"Removal","n":"2770"},{"v":"Plantings","n":"560"},{"v":"Tree Production Operations","n":"368"},{"v":"Tree Maintenance","n":"357"},{"v":"Inspection","n":"84"},{"v":"Soil Improvement","n":"25"},{"v":"Turf Maintenance","n":"13"},{"v":"Concrete Repair","n":"8"},{"v":"Litter / Debris Removal","n":"8"},{"v":"Athletic Field Maintenance","n":"7"},{"v":"Baseball/Softball Field Marking","n":"7"},{"v":"Bed Maintenance","n":"6"},{"v":"Athletic Field Maintenance - Class A","n":"2"},{"v":"Equipment Winter Overhaul","n":"2"},{"v":"Beach Maintenance/Sanitizing","n":"1"},{"v":"Cleaning/ Debris Removal","n":"1"},{"v":"Football Field Marking","n":"1"},{"v":"Pesticide / Herbicide Applications","n":"1"},{"v":"Safety Surface Maintenance","n":"1"}]` ([run it](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20primary_task_description%20AS%20v%2C%20count(*)%20AS%20n%20WHERE%20area%20%3D%20'Forestry'%20GROUP%20BY%20primary_task_description%20ORDER%20BY%20n%20DESC%2C%20primary_task_description%20LIMIT%20200))

</details>

## Capital projects with no ward or coordinates (adopted capital plan)

`norfolk.budget.cip-no-ward` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found 41 of 93 projects (44%) with no ward in the City's adopted Capital Improvement Plan projects (6tqj-4az3), as I read them on 2026-11-06. Of the same 93, I found 39 with no latitude or longitude, 39 of them with no ward either, as I read them on 2026-11-06. Of the same 93, I found 0 with the free-text location field empty, as I read them on 2026-11-06. Its description of location, in its words: “Specific address or location name, when available, for the project”.

**Short:** I found 41 of 93 projects (44%) with no ward in the City's adopted Capital Improvement Plan data, measured 2026-11-06.

**Shape**

- where: projects in the adopted capital plan; Capital Improvement Plan (CIP) Projects - FY 2027 (6tqj-4az3); citywide
- part 41 of 93 (44%), read 2026-11-07T04:09:53.334Z

**Questions it leaves unanswered, with consequence lines**

- Which capital projects in the adopted plan are in my ward? (only in part; half-answered by 6tqj-4az3.ward, 6tqj-4az3.location)  
  With the City's adopted Capital Improvement Plan projects (6tqj-4az3) I can answer this only in part: I found 41 of 93 projects (44%) with no ward, measured 2026-11-06, so a search by ward can't find them, and I found the free-text location field filled on 41 of those 41, which I can read but can't search by ward.
- Which planned capital projects are near me? (only in part; half-answered by 6tqj-4az3.latitude, 6tqj-4az3.longitude, 6tqj-4az3.location)  
  With the City's adopted Capital Improvement Plan projects (6tqj-4az3) I can answer this only in part: I found 39 of 93 projects (42%) with no latitude or longitude, measured 2026-11-06, so a search by distance can't find them, and I found the free-text location field filled on 39 of those 39, which I can read but can't search by distance.

**Proposed actions**

- `a-budget-proposal-cip-place` dataset proposal: Give every project in the Capital Improvement Plan data a ward, or a citywide value in the ward field, and coordinates where it has a site.
- `a-budget-meeting-cip-place` meeting question: How can residents find which capital projects with no ward in the plan data affect their part of the city? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

I found capital projects with no ward and no coordinates in these records, and a search by ward or by distance leaves them out. The entry counts those rows, and claims nothing about whether a project has a site. The location column is free text, and the identifier rule keeps a measure from reading it, so I can’t count from code how many of these name a site, several places or the whole city.

**Reviewer context (not evidence on the board):** The request gave a count of projects with no ward from a read on 2026-11-06, and I found the same count when I measured it again. In a reviewer read outside the trace, as I read them on 2026-11-06, I found “Citywide” in the location text of several projects with no ward, and in others text naming facilities across the city, several wards, or sites outside the city. That read is context for Jason, not evidence on the board.

<details><summary>Evidence</summary>

- query on 6tqj-4az3, read 2026-11-07T04:09:53.334Z (trace step 30): `SELECT count(*) AS whole, sum(case(ward IS NULL,1,true,0)) AS no_ward, sum(case(latitude IS NULL OR longitude IS NULL,1,true,0)) AS no_coord, sum(case(ward IS NULL AND (latitude IS NULL OR longitude IS NULL),1,true,0)) AS neither, sum(case(location IS NULL,1,true,0)) AS no_loc, sum(case(ward IS NULL AND location IS NULL,1,true,0)) AS no_ward_no_loc, sum(case((latitude IS NULL OR longitude IS NULL) AND location IS NULL,1,true,0)) AS no_coord_no_loc WHERE project_id IS NOT NULL LIMIT 100` → `[{"whole":"93","no_ward":"41","no_coord":"39","neither":"39","no_loc":"0","no_ward_no_loc":"0","no_coord_no_loc":"0"}]` ([run it](https://data.norfolk.gov/resource/6tqj-4az3.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(ward%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_ward%2C%20sum(case(latitude%20IS%20NULL%20OR%20longitude%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_coord%2C%20sum(case(ward%20IS%20NULL%20AND%20(latitude%20IS%20NULL%20OR%20longitude%20IS%20NULL)%2C1%2Ctrue%2C0))%20AS%20neither%2C%20sum(case(location%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_loc%2C%20sum(case(ward%20IS%20NULL%20AND%20location%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_ward_no_loc%2C%20sum(case((latitude%20IS%20NULL%20OR%20longitude%20IS%20NULL)%20AND%20location%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_coord_no_loc%20WHERE%20project_id%20IS%20NOT%20NULL%20LIMIT%20100))
- metadata of 6tqj-4az3, read 2026-11-07T04:09:53.408Z (trace step 31): location, “Specific address or location name, when available, for the project”

</details>

## Parks and Recreation revenue units with no spending unit of the same name

`norfolk.budget.parks-revenue-units` · proposed · kind `partial_coverage` (Partial coverage (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found all 49 department names in the City's Annual Revenues records (id3i-2az4) also in the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06. For FY2025, under “The Department of Parks & Recreation (P&R)”, I found 1 revenue unit and 8 spending units, with 1 of the revenue units matching no spending unit of the same name, “Recreation Parks Open Space”, as I read them on 2026-11-06. For FY2026, under “The Department of Parks & Recreation (P&R)”, I found 2 revenue units and 9 spending units, with 1 of the revenue units matching no spending unit of the same name, “Recreation Parks Open Space”, as I read them on 2026-11-06. For FY2027, under “The Department of Parks & Recreation (P&R)”, I found 3 revenue units and 8 spending units, with 1 of the revenue units matching no spending unit of the same name, “Recreation Parks Open Space”, as I read them on 2026-11-06.

**Short:** Under Parks and Recreation, for FY2027, I found 1 of 3 revenue units with no spending unit of the same name in the City's budget records, measured 2026-11-06.

**Shape**

- where: units under The Department of Parks & Recreation (P&R), by fiscal year; Annual Revenues (id3i-2az4), Annual Expenditures (mdwe-dquf); citywide
- part 1 of 3 (33%), read 2026-11-07T04:09:53.745Z
- series: 2025 1 of 1 · 2026 1 of 2 · 2027 1 of 3

**Questions it leaves unanswered, with consequence lines**

- How much of a Parks and Recreation program's cost do its own fees and charges cover? (only in part; half-answered by id3i-2az4.unit_name, mdwe-dquf.unit_name)  
  With the City's Annual Revenues records (id3i-2az4) I can answer this only in part: for FY2027, I found 1 of 3 Parks and Recreation revenue units, “Recreation Parks Open Space”, with no spending unit of the same name in Annual Expenditures, measured 2026-11-06, so I can't set that revenue against a cost.

**Proposed actions**

- `a-budget-proposal-crosswalk` dataset proposal: Use the same unit names for a program in Annual Revenues and Annual Expenditures, or publish a crosswalk between them.
- `a-budget-meeting-crosswalk` meeting question: Which Parks and Recreation spending units do its revenue units support, where their names differ? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

Setting a program’s revenue against its cost from these records takes the same unit in both datasets, in the same fiscal year. I found every department name shared between them, and under Parks and Recreation I found revenue units with names that match no spending unit of the same year, so that revenue has no cost to sit beside in these records. The entry reports the names as recorded, and claims nothing about how the City budgets the program.

**Reviewer context (not evidence on the board):** The request was citywide: revenue and spending units that differ. I found the department names all matching, so the entry narrows to the unit names under Parks and Recreation, compared year by year, since the units differ from one fiscal year to the next. I can’t measure a citywide comparison of unit names with the menu: the unit names in Annual Expenditures pass the values measure’s cap, by an exploratory read outside the trace on 2026-11-06. The spec’s kinds table asks a partial_coverage entry for a share over a bundled index or a verified finding, and this one carries a share over the units read from the two datasets: a difference for Jason to rule on.

<details><summary>Evidence</summary>

- query on mdwe-dquf, read 2026-11-07T04:09:53.520Z (trace step 32): `SELECT department_name AS v, count(*) AS n WHERE department_name IS NOT NULL GROUP BY department_name ORDER BY n DESC, department_name LIMIT 200` → `[{"v":"Norfolk Community Services Board","n":"2677"},{"v":"Water","n":"923"},{"v":"Police","n":"785"},{"v":"Public Works","n":"641"},{"v":"The Department of Parks & Recreation (P&R)","n":"640"},{"v":"Human Services","n":"472"},{"v":"The National Maritime Center","n":"422"},{"v":"Libraries","n":"419"},{"v":"Zoological Park","n":"342"},{"v":"Finance Department","n":"311"},{"v":"General Services","n":"310"},{"v":"Transportation","n":"302"},{"v":"Planning and Community Development","n":"293"},{"v":"Cultural Facilities Arts Entertainment","n":"273"},{"v":"Neighborhood Development","n":"263"},{"v":"Storm Water Management","n":"236"},{"v":"Fire-Rescue","n":"222"},{"v":"Housing and Community Development","n":"208"},{"v":"Waste Management","n":"198"},{"v":"Parking Facilities Fund","n":"189"},{"v":"Outside Agencies","n":"179"},{"v":"Wastewater","n":"175"},{"v":"Towing & Recovery Operations Fund","n":"149"},{"v":"Communications and Technology","n":"142"},{"v":"Int Service Fund-Auto Maint","n":"135"},{"v":"Sheriff","n":"128"},{"v":"City Clerk","n":"126"},{"v":"Healthcare Fund","n":"118"},{"v":"The Slover","n":"111"},{"v":"City Manager","n":"110"},{"v":"Commissioner of the Revenue","n":"97"},{"v":"Departmental Support","n":"97"},{"v":"Elections","n":"94"},{"v":"City Real Estate Assessor","n":"93"},{"v":"Human Resources","n":"92"},{"v":"City Treasurer","n":"88"},{"v":"Commonwealths Attorney","n":"88"},{"v":"City Attorney","n":"87"},{"v":"Public Health","n":"85"},{"v":"Budget and Strategic Planning","n":"84"},{"v":"Development","n":"79"},{"v":"City Auditor","n":"74"},{"v":"Office of Resilience","n":"73"},{"v":"Office of Marketing and Communications","n":"70"},{"v":"Circuit Court Judges","n":"69"},{"v":"Diversity, Equity, and Inclusion","n":"67"},{"v":"Emergency Preparedness and Response","n":"66"},{"v":"Cemeteries","n":"52"},{"v":"Clerk of the Circuit Court","n":"50"},{"v":"Office of Citizen Services","n":"49"},{"v":"Military and Community Affairs","n":"46"},{"v":"City Council","n":"44"},{"v":"General District Court","n":"39"},{"v":"Juvenile & Domestic Relations Court","n":"34"},{"v":"Office of Norfolk Arts","n":"31"},{"v":"Probation Services","n":"24"},{"v":"Debt Service","n":"19"},{"v":"Public Amenities","n":"17"},{"v":"Magistrate","n":"12"},{"v":"Golf Operations","n":"5"},{"v":"NOT AVAILABLE","n":"5"},{"v":"Norfolk Public Schools","n":"3"},{"v":"Land Acquisition","n":"2"},{"v":"Tax Increment Financing","n":"1"}]` ([run it](https://data.norfolk.gov/resource/mdwe-dquf.json?$query=SELECT%20department_name%20AS%20v%2C%20count(*)%20AS%20n%20WHERE%20department_name%20IS%20NOT%20NULL%20GROUP%20BY%20department_name%20ORDER%20BY%20n%20DESC%2C%20department_name%20LIMIT%20200))
- query on id3i-2az4, read 2026-11-07T04:09:53.632Z (trace step 33): `SELECT department_name AS v, count(*) AS n WHERE department_name IS NOT NULL GROUP BY department_name ORDER BY n DESC, department_name LIMIT 200` → `[{"v":"Parking Facilities Fund","n":"371"},{"v":"Norfolk Community Services Board","n":"156"},{"v":"Water","n":"99"},{"v":"Commissioner of the Revenue","n":"77"},{"v":"Finance Department","n":"67"},{"v":"City Treasurer","n":"64"},{"v":"Int Service Fund-Auto Maint","n":"50"},{"v":"Public Works","n":"46"},{"v":"Planning and Community Development","n":"45"},{"v":"Police","n":"40"},{"v":"Clerk of the Circuit Court","n":"39"},{"v":"Sheriff","n":"36"},{"v":"Cultural Facilities Arts Entertainment","n":"30"},{"v":"Human Services","n":"28"},{"v":"Storm Water Management","n":"28"},{"v":"The Department of Parks & Recreation (P&R)","n":"25"},{"v":"Development","n":"22"},{"v":"Waste Management","n":"21"},{"v":"Healthcare Fund","n":"19"},{"v":"Wastewater","n":"19"},{"v":"Norfolk Public Schools","n":"18"},{"v":"Neighborhood Development","n":"16"},{"v":"Towing & Recovery Operations Fund","n":"16"},{"v":"Fire-Rescue","n":"12"},{"v":"Office of Marketing and Communications","n":"10"},{"v":"Cemeteries","n":"9"},{"v":"Libraries","n":"9"},{"v":"Public Amenities","n":"9"},{"v":"The National Maritime Center","n":"9"},{"v":"General Services","n":"7"},{"v":"The Slover","n":"7"},{"v":"Zoological Park","n":"7"},{"v":"Communications and Technology","n":"6"},{"v":"General District Court","n":"6"},{"v":"Human Resources","n":"6"},{"v":"Transportation","n":"6"},{"v":"Debt Service","n":"5"},{"v":"Departmental Support","n":"5"},{"v":"Golf Operations","n":"5"},{"v":"City Manager","n":"4"},{"v":"Elections","n":"4"},{"v":"City Real Estate Assessor","n":"3"},{"v":"Commonwealths Attorney","n":"3"},{"v":"Housing and Community Development","n":"3"},{"v":"Juvenile & Domestic Relations Court","n":"3"},{"v":"Land Acquisition","n":"3"},{"v":"Emergency Preparedness and Response","n":"2"},{"v":"Public Health","n":"1"},{"v":"Tax Increment Financing","n":"1"}]` ([run it](https://data.norfolk.gov/resource/id3i-2az4.json?$query=SELECT%20department_name%20AS%20v%2C%20count(*)%20AS%20n%20WHERE%20department_name%20IS%20NOT%20NULL%20GROUP%20BY%20department_name%20ORDER%20BY%20n%20DESC%2C%20department_name%20LIMIT%20200))
- query on id3i-2az4, read 2026-11-07T04:09:53.745Z (trace step 34): `SELECT fiscal_year, unit_name, count(*) AS whole WHERE department_name = 'The Department of Parks & Recreation (P&R)' GROUP BY fiscal_year, unit_name ORDER BY fiscal_year, unit_name LIMIT 100` → `[{"fiscal_year":"2025","unit_name":"Recreation Parks Open Space","whole":"6"},{"fiscal_year":"2026","unit_name":"Cemeteries","whole":"3"},{"fiscal_year":"2026","unit_name":"Recreation Parks Open Space","whole":"6"},{"fiscal_year":"2027","unit_name":"Cemeteries","whole":"3"},{"fiscal_year":"2027","unit_name":"Park and Forestry Operations","whole":"1"},{"fiscal_year":"2027","unit_name":"Recreation Parks Open Space","whole":"6"}]` ([run it](https://data.norfolk.gov/resource/id3i-2az4.json?$query=SELECT%20fiscal_year%2C%20unit_name%2C%20count(*)%20AS%20whole%20WHERE%20department_name%20%3D%20'The%20Department%20of%20Parks%20%26%20Recreation%20(P%26R)'%20GROUP%20BY%20fiscal_year%2C%20unit_name%20ORDER%20BY%20fiscal_year%2C%20unit_name%20LIMIT%20100))
- query on mdwe-dquf, read 2026-11-07T04:09:53.838Z (trace step 35): `SELECT fiscal_year, unit_name, count(*) AS whole WHERE department_name = 'The Department of Parks & Recreation (P&R)' GROUP BY fiscal_year, unit_name ORDER BY fiscal_year, unit_name LIMIT 100` → `[{"fiscal_year":"2025","unit_name":"Administrative Support","whole":"24"},{"fiscal_year":"2025","unit_name":"Directors Office","whole":"18"},{"fiscal_year":"2025","unit_name":"Financial Reporting","whole":"1"},{"fiscal_year":"2025","unit_name":"Park and Forestry Operations","whole":"37"},{"fiscal_year":"2025","unit_name":"Park Planning and Development","whole":"16"},{"fiscal_year":"2025","unit_name":"Recreation Centers","whole":"31"},{"fiscal_year":"2025","unit_name":"Special Services","whole":"25"},{"fiscal_year":"2025","unit_name":"Youth Development","whole":"19"},{"fiscal_year":"2026","unit_name":"Administrative Support","whole":"27"},{"fiscal_year":"2026","unit_name":"Cemeteries","whole":"53"},{"fiscal_year":"2026","unit_name":"Directors Office","whole":"20"},{"fiscal_year":"2026","unit_name":"Financial Reporting","whole":"1"},{"fiscal_year":"2026","unit_name":"Park and Forestry Operations","whole":"40"},{"fiscal_year":"2026","unit_name":"Park Planning and Development","whole":"18"},{"fiscal_year":"2026","unit_name":"Recreation Centers","whole":"32"},{"fiscal_year":"2026","unit_name":"Special Services","whole":"26"},{"fiscal_year":"2026","unit_name":"Youth Development","whole":"22"},{"fiscal_year":"2027","unit_name":"Administrative Support","whole":"26"},{"fiscal_year":"2027","unit_name":"Cemeteries","whole":"52"},{"fiscal_year":"2027","unit_name":"Directors Office","whole":"19"},{"fiscal_year":"2027","unit_name":"Park and Forestry Operations","whole":"39"},{"fiscal_year":"2027","unit_name":"Park Planning and Development","whole":"17"},{"fiscal_year":"2027","unit_name":"Recreation Centers","whole":"31"},{"fiscal_year":"2027","unit_name":"Special Services","whole":"25"},{"fiscal_year":"2027","unit_name":"Youth Development","whole":"21"}]` ([run it](https://data.norfolk.gov/resource/mdwe-dquf.json?$query=SELECT%20fiscal_year%2C%20unit_name%2C%20count(*)%20AS%20whole%20WHERE%20department_name%20%3D%20'The%20Department%20of%20Parks%20%26%20Recreation%20(P%26R)'%20GROUP%20BY%20fiscal_year%2C%20unit_name%20ORDER%20BY%20fiscal_year%2C%20unit_name%20LIMIT%20100))

</details>

## No adopted amount or amendment date beside the current budget (Annual Expenditures)

`norfolk.budget.no-amendment-history` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

The Annual Expenditures description (mdwe-dquf), as I read it on 2026-11-06, says: “The data also contains current budget information. Current budget reflects budget transfers and amendments during the fiscal year that have transpired since City Council adopted the budget prior to the beginning of the current fiscal year.” Its description of current_expense_budget, in its words: “Total annual budgeted expenditures for this department/fund/unit/object line”. I found no column for an adopted amount, an amendment or transfer, or a date it took effect among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06. I found 224 of 1,437 agenda items in Siren's agenda index (built 2026-11-02) with titles amending an annual appropriations ordinance or annual budget, at meetings 2023-07-11 through 2026-10-13, counted 2026-11-06.

**Short:** I found no column for an adopted amount or an amendment date among the 8 columns of the City's Annual Expenditures, measured 2026-11-06.

**Shape**

- where: spending lines; Annual Expenditures (mdwe-dquf), Siren's agenda index; citywide
- columns_absent /adopt|original|amend|transfer|revis|prior|(^|_)date|modif|effective/i over mdwe-dquf (8 columns), read 2026-11-07T04:09:50.225Z
- description quote from mdwe-dquf, read 2026-11-07T04:09:50.225Z
- rows last updated 2026-11-06T12:26:36.000Z

**Questions it leaves unanswered, with consequence lines**

- What operating budget did the City Council adopt for a department, before any amendments this year? (can’t answer)  
  I found no column for an adopted amount, an amendment or transfer, or a date it took effect among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), measured 2026-11-06, so I can't answer this from them.
- When during the year was a department's budget changed, and by how much? (only in part; half-answered by norfolk-legislation.text)  
  With Siren's agenda index (norfolk-legislation) I can answer this only in part: I found 224 agenda items with titles amending an annual appropriations ordinance or annual budget, at meetings 2023-07-11 through 2026-10-13, in the index built 2026-11-02, measured 2026-11-06, which gives each ordinance's meeting date, not each budget line's change, and I found no column for an amendment or its date among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), measured 2026-11-06.

**Proposed actions**

- `a-budget-proposal-amendments` dataset proposal: Publish the adopted amount beside the current budget on each Annual Expenditures line, and a dated list of budget transfers and amendments.
- `a-budget-meeting-amendments` meeting question: Where can residents read each budget transfer and amendment the City makes during the fiscal year, with its date? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

The dataset’s own description says its budget figure reflects transfers and amendments made since adoption. I found one budget column and no column for the adopted amount, an amendment or its date, so how a budget changed during the year stays out of these records. Siren’s agenda index holds the titles of the Council ordinances that amend the annual appropriations, by meeting date, so the question of when a budget changed is answered there in part, ordinance by ordinance, and not line by line. The entry reports the columns and the titles, and claims nothing about whether or how often an amendment happened outside them.

**Reviewer context (not evidence on the board):** Annual Revenues describes its budget as the one adopted by City Council ahead of each fiscal year, so this entry covers the spending side only. The adopted capital plan (6tqj-4az3) carries adopted amounts for capital projects by department, so the first question asks about the operating budget, which among the datasets read only Annual Expenditures holds. I found no amount for a department in the titles of the adopting ordinances in the agenda index, as I read them on 2026-11-06.

<details><summary>Evidence</summary>

- metadata of mdwe-dquf, read 2026-11-07T04:09:50.225Z (trace step 9): “The data also contains current budget information. Current budget reflects budget transfers and amendments during the fiscal year that have transpired since City Council adopted the budget prior to the beginning of the current fiscal year.”
- metadata of mdwe-dquf, read 2026-11-07T04:09:50.225Z (trace step 9): current_expense_budget, “Total annual budgeted expenditures for this department/fund/unit/object line”
- metadata of mdwe-dquf, read 2026-11-07T04:09:50.225Z (trace step 9): 8 columns
- count over data/norfolk-legislation.json, built 2026-11-02T19:30:12.391Z: 224 of 1,437 items

</details>

## Upcoming meetings, for the meeting questions

As listed on 2026-11-06; check the City's calendar. Read 2026-11-06; calendar: https://norfolkcityva.iqm2.com/Citizens/Calendar.aspx.

- 2026-11-09 16:00 · Architectural Review Board (Regular Meeting)
- 2026-11-09 17:30 · E. Little Creek Advisory Committee (Regular)
- 2026-11-10 00:00 · Civil Service Commission (Special Meeting)
- 2026-11-10 16:00 · City Council (Informal Session)
- 2026-11-10 17:30 · Southside Task Force (Regular)
- 2026-11-10 18:00 · City Council (Formal Session)
- 2026-11-11 17:15 · Veterans Affairs Commission (Regular Meeting)
- 2026-11-12 08:30 · City Council (Greater Wards Corner Task Force- 3+ Councilmembers)
- 2026-11-12 08:30 · Greater Wards Corner Task Force (Regular)
- 2026-11-12 09:00 · Norfolk Redevelopment and Housing Authority (Regular Meeting)
- 2026-11-12 12:00 · Norfolk Recreation Commission (Regular Meeting)
- 2026-11-12 16:30 · Norfolk Arts Commission (Regular)
- 2026-11-13 08:30 · Ghent Task Force (Regular)
- 2026-11-13 13:00 · Hampton Roads Disability Services Board (Regular Meeting)
- 2026-11-16 15:00 · Social Services Advisory Commission (Regular Meeting)
- 2026-11-16 16:00 · Mayor's Commission on Housing (Regular)
- 2026-11-17 13:00 · Norfolk Public Library Board (Regular Meeting)
- 2026-11-17 16:00 · Tidewater Community College Board (Regular Meeting)
- 2026-11-17 18:00 · Mayor's Advisory Committee/St. Paul's Area (Regular Meeting)
- 2026-11-18 14:45 · Community Policy and Management Team (Regular Meeting)
- 2026-11-18 17:30 · Norfolk Environmental Commission (Regular Meeting)
- 2026-11-19 10:30 · Hampton Roads Transportation Planning Organization (Regular Meeting)
- 2026-11-19 12:00 · Planning Commission (Regular Meeting)
- 2026-11-19 12:30 · Hampton Roads Planning District Commission (Regular Meeting)
- 2026-11-19 13:00 · Commission for Persons with Disabilities (Regular Meeting)
