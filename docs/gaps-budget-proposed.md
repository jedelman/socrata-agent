# Proposed budget gaps: Norfolk

**PROPOSED, not in the catalog.** Built 2026-11-06 by `scripts/build-gaps-proposed.js` from `src/gaps/proposed/norfolk-budget.js`. Generated: edit the proposal module, not this page.

Catalog entries go public when merged, and every new one needs Jason’s approval (docs/gaps.md §4). These entries are drafts for that review. Nothing under `src/` or `worker/` imports the proposal module, `scripts/build-gaps.js` never reads it, and no gap here reaches Siren’s answers, the board or the bundled gap file. To approve one, move its entry and actions into `src/gaps/norfolk.js` and `src/gaps/actions-norfolk.js` (dropping `proposed`, `why`, `context` and `related`) and rebuild the catalog.

Dates are America/New_York calendar dates, as the catalog builder writes them (docs/gaps.md §5.3); read times are UTC.

Each entry was measured live against data.norfolk.gov through the catalog’s own builder: the fixed measure menu at GENERIC access, through the traced client, under the positional identifier rule. Every statement, short line, title, question, consequence line and action passed `gapTextViolations` and `publicTextViolations` with the City’s street list, and so did the prose below. Every request and response is in `data/gaps/proposed-norfolk-budget.trace.json`, with the built records in the catalog’s schema under `file`.

## Candidates tested

| Candidate | Outcome | Why |
|---|---|---|
| 1. Forestry spending inside park upkeep | kept as norfolk.budget.forestry-in-park-unit | The budget book’s description of the program enters as reviewer context only, with its URL and page, because I opened it and found the words; the statement stands on the dataset alone. |
| 2. Three fiscal years in the open data | kept as norfolk.budget.three-fiscal-years | The part about earlier years living only in the budget books is left out of the statement: it is about documents outside the records, and the entry states only what the open records hold. |
| 3. Contractual spending not tied to work | kept as norfolk.budget.contractual-no-link, spending side only | The work-order side is an approved catalog entry, linked from this one, and this entry measures only Annual Expenditures and the catalog. |
| 4. Pruning in the performance measures | reshaped as norfolk.budget.no-pruning-measure | The checked quote holds only the measure’s name, so the FY2021 through FY2023 percentages and the target stay out; the entry adds what the dataset holds for trees planted. |
| 5. Capital projects with no ward | kept as norfolk.budget.cip-no-ward | Measured live with coordinates too, and the count matches the one in the request. |
| 6. Revenue and spending units | reshaped as norfolk.budget.parks-revenue-units | I found every department name in Annual Revenues also in Annual Expenditures, so the mismatch is narrowed to unit names under Parks and Recreation, where I found it. |
| 7. Only the amended budget published | kept as norfolk.budget.no-amendment-history | Scoped to Annual Expenditures, since its description says its budget reflects amendments, and Annual Revenues describes its budget as the adopted one. |

## No unit or field for Forestry spending alone (Annual Expenditures)

`norfolk.budget.forestry-in-park-unit` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found 1 unit with “Forestry” in its name in the City's Annual Expenditures records (mdwe-dquf), “Park and Forestry Operations”, as I read them on 2026-11-06. I found none of the 40 expense line names under it naming forestry, trees or pruning, as I read them on 2026-11-06. I found no column for a program or activity among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06.

**Short:** I found “Forestry” in one unit name in the City's Annual Expenditures, “Park and Forestry Operations”, and no expense line under it naming trees, measured 2026-11-06.

**Shape**

- where: spending lines of units with Forestry in their name; Annual Expenditures (mdwe-dquf); citywide
- columns_absent /program|activit|project|function|forest/i over mdwe-dquf (8 columns), read 2026-11-07T03:46:46.553Z
- values of mdwe-dquf.object_name: 40; none matched, read 2026-11-07T03:46:46.464Z

**Questions it leaves unanswered, with consequence lines**

- How much does the City spend on street-tree work each year? (only in part; half-answered by mdwe-dquf.unit_name, qzfe-wj25.total_cost)  
  With the City's Annual Expenditures records (mdwe-dquf) I can answer this only in part: I found “Forestry” in the name of one unit, “Park and Forestry Operations”, and none of its 40 expense line names mentions forestry, trees or pruning, measured 2026-11-06, so I can give that unit's spending but not the part spent on trees; Forestry work orders in the City's Work Orders records (qzfe-wj25) carry a total_cost column.

**Proposed actions**

- `a-budget-proposal-program` dataset proposal: Publish a program or activity field in Annual Expenditures, so spending on street trees can be read apart from the rest of its unit.
- `a-budget-meeting-forestry` meeting question: How much of the Park and Forestry Operations budget goes to street-tree work each year, and where is that recorded? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

Annual Expenditures holds spending by department, unit and expense line. I found “Forestry” in one unit name, and that name covers park operations as well, and I found no field or expense line that splits the Forestry part out. The entry states what the records hold and leave out, and claims nothing about what the City spends on trees.

**Reviewer context (not evidence on the board):** The City’s FY2027 budget book, which I opened and checked on 2026-11-06, describes the program on PDF page 176 (printed page 300), in its words: “The Parks and Forestry Operations program maintains the beautification of the city by providing mowing, landscape maintenance, litter control, turf installation, emptying refuse receptacles, applying fertilizer and herbicide, and maintaining/repairing irrigation.” The same page, in its words: “The program maintains all trees on City property including street trees through pruning, removal, and planting services”. The book is not evidence on the board: it enters only as a case-file finding, checked by verify-cases, through a case-file PR.

- Source opened 2026-11-06: [The City's FY2027 budget book, department budgets](https://www.norfolk.gov/DocumentCenter/View/114013/09-Department-Budgets), PDF page 176 (printed page 300).

<details><summary>Evidence</summary>

- values of mdwe-dquf.unit_name, read 2026-11-07T03:46:46.342Z (trace step 7), pattern /forest/i: “Park and Forestry Operations”; matched “Park and Forestry Operations”
- values of mdwe-dquf.object_name, read 2026-11-07T03:46:46.464Z (trace step 8), pattern /forest|\btrees?\b|prun|arbor/i: 40 values; matched none
- metadata of mdwe-dquf, read 2026-11-07T03:46:46.553Z (trace step 9): 8 columns

</details>

## Fiscal years held in the open spending and revenue records

`norfolk.budget.three-fiscal-years` · proposed · kind `partial_coverage` (Partial coverage (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found fiscal years FY2025, FY2026 and FY2027 in the City's Annual Expenditures records (mdwe-dquf), and the same years in the City's Annual Revenues records (id3i-2az4), as I read them on 2026-11-06. The Annual Expenditures description (mdwe-dquf), as I read it on 2026-11-06, says: “This dataset summarizes the city’s cash outlays and accruals for the cost of goods received or services rendered, by department, department unit/division, and expenditure type, for three years; the current fiscal year and two previous fiscal years.” The Annual Revenues description (id3i-2az4), as I read it on 2026-11-06, says: “The data set includes the current fiscal year and two previous fiscal years.” The Annual Expenditures description of actual_expenses, in its words: “Sum of fiscal year-to-date expenditures for this department/fund/unit/object line”.

**Short:** I found fiscal years FY2025 through FY2027 in the City's Annual Expenditures, and FY2025 through FY2027 in its Annual Revenues, measured 2026-11-06.

**Shape**

- where: fiscal years in the open spending and revenue records; Annual Expenditures (mdwe-dquf), Annual Revenues (id3i-2az4); citywide
- values of mdwe-dquf.fiscal_year: 3; matched: “2025”, “2026”, “2027”, read 2026-11-07T03:46:46.702Z
- description quote from mdwe-dquf, read 2026-11-07T03:46:46.553Z
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

**Reviewer context (not evidence on the board):** The City’s FY2027 budget book, which I opened and checked on 2026-11-06, carries a column headed “FY 2024 Actual” in the Parks and Recreation summaries on PDF page 173 (printed page 297). That column sits outside the open records, and the book is not evidence on the board.

- Source opened 2026-11-06: [The City's FY2027 budget book, department budgets](https://www.norfolk.gov/DocumentCenter/View/114013/09-Department-Budgets), PDF page 173 (printed page 297).

<details><summary>Evidence</summary>

- values of mdwe-dquf.fiscal_year, read 2026-11-07T03:46:46.702Z (trace step 10), pattern /^\d{4}$/: “2026”, “2025”, “2027”; matched “2025”, “2026”, “2027”
- values of id3i-2az4.fiscal_year, read 2026-11-07T03:46:46.919Z (trace step 12), pattern /^\d{4}$/: “2025”, “2026”, “2027”; matched “2025”, “2026”, “2027”
- metadata of mdwe-dquf, read 2026-11-07T03:46:46.553Z (trace step 9): “This dataset summarizes the city’s cash outlays and accruals for the cost of goods received or services rendered, by department, department unit/division, and expenditure type, for three years; the current fiscal year and two previous fiscal years.”
- metadata of id3i-2az4, read 2026-11-07T03:46:47.024Z (trace step 13): “The data set includes the current fiscal year and two previous fiscal years.”
- metadata of mdwe-dquf, read 2026-11-07T03:46:46.553Z (trace step 9): actual_expenses, “Sum of fiscal year-to-date expenditures for this department/fund/unit/object line”

</details>

## No field linking spending lines to a contract or work order (Annual Expenditures)

`norfolk.budget.contractual-no-link` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found no column naming a vendor, contract, invoice, purchase order or work order among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06. Under “Park and Forestry Operations”, as I read them on 2026-11-06, I found the line “Other Contractual Services” for FY2026 with actual expenses of $1,341,543.97 and a current expense budget of $1,200,643. I found 0 datasets in Norfolk's open data catalog for the search “checkbook”, and 1 dataset for “vendor”, open to Siren: Municipal Building Energy Use (searched 2026-11-06).

**Short:** I found no column in the City's Annual Expenditures tying a spending line to a vendor, contract, purchase order or work order, measured 2026-11-06.

**Shape**

- where: spending lines; Annual Expenditures (mdwe-dquf), data.norfolk.gov; citywide
- columns_absent /vendor|payee|supplier|contract|invoice|purchase|work_?order|(^|_)po(_|$)/i over mdwe-dquf (8 columns), read 2026-11-07T03:46:46.553Z
- catalog search “checkbook”: 0, read 2026-11-07T03:46:47.630Z
- catalog search “vendor”: 1 (Municipal Building Energy Use, 9v4p-ntch), read 2026-11-07T03:46:47.691Z

**Questions it leaves unanswered, with consequence lines**

- Which contracts did the City pay from the Park and Forestry Operations contractual services line last year? (can’t answer)  
  I found no column naming a vendor, contract, invoice, purchase order or work order among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), measured 2026-11-06, so I can't answer this from them.
- Which tree work did the City's contractual spending on park and forestry operations pay for? (can’t answer)  
  I found no column naming a vendor, contract, invoice, purchase order or work order among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), measured 2026-11-06, so I can't answer this from them.

**Proposed actions**

- `a-budget-proposal-contract-number` dataset proposal: Publish a contract or purchase order number on each Annual Expenditures line, so contractual spending can be tied to the work it paid for.
- `a-budget-meeting-contracts` meeting question: Which contracts does the Park and Forestry Operations line for other contractual services pay for, and where are they recorded? (ask: City Clerk (to speak at Council))
- `a-budget-foia-contracts` foia draft: records-request draft: waits for a records_to_request entry for the contracts paid from the Park and Forestry Operations contractual services line, added to a case file by case-file PR.

**Why it is a gap, not a finding or a complaint**

The line “Other Contractual Services” records an amount and a budget for a unit and a year. I found no column in Annual Expenditures that ties a line to a contract, a purchase order or a work order, so the work an amount paid for stays out of these records. The entry describes that missing link, and claims nothing about whether any payment was right. The work-order side is an approved catalog entry, linked from this one, and this entry repeats none of it.

**Linked, not repeated:** `norfolk.work-orders.no-contract-link` (approved catalog).

**Reviewer context (not evidence on the board):** I checked the request’s figures for this line against the live read on 2026-11-06: the statement reads the FY2026 actual and budget from the one line they come from, with a check that the line is a single row.

<details><summary>Evidence</summary>

- metadata of mdwe-dquf, read 2026-11-07T03:46:46.553Z (trace step 9): 8 columns
- query on mdwe-dquf, read 2026-11-07T03:46:47.128Z (trace step 14): `SELECT count(*) AS whole WHERE unit_name = 'Park and Forestry Operations' AND object_name = 'Other Contractual Services' AND fiscal_year = 2026 LIMIT 100` → `[{"whole":"1"}]` ([run it](https://data.norfolk.gov/resource/mdwe-dquf.json?$query=SELECT%20count(*)%20AS%20whole%20WHERE%20unit_name%20%3D%20'Park%20and%20Forestry%20Operations'%20AND%20object_name%20%3D%20'Other%20Contractual%20Services'%20AND%20fiscal_year%20%3D%202026%20LIMIT%20100))
- query on mdwe-dquf, read 2026-11-07T03:46:47.250Z (trace step 15): `SELECT min(actual_expenses) AS min_actual_expenses, max(actual_expenses) AS max_actual_expenses, min(current_expense_budget) AS min_current_expense_budget, max(current_expense_budget) AS max_current_expense_budget WHERE unit_name = 'Park and Forestry Operations' AND object_name = 'Other Contractual Services' AND fiscal_year = 2026 LIMIT 100` → `[{"min_actual_expenses":"1341543.9700000000","max_actual_expenses":"1341543.9700000000","min_current_expense_budget":"1200643.0000000000","max_current_expense_budget":"1200643.0000000000"}]` ([run it](https://data.norfolk.gov/resource/mdwe-dquf.json?$query=SELECT%20min(actual_expenses)%20AS%20min_actual_expenses%2C%20max(actual_expenses)%20AS%20max_actual_expenses%2C%20min(current_expense_budget)%20AS%20min_current_expense_budget%2C%20max(current_expense_budget)%20AS%20max_current_expense_budget%20WHERE%20unit_name%20%3D%20'Park%20and%20Forestry%20Operations'%20AND%20object_name%20%3D%20'Other%20Contractual%20Services'%20AND%20fiscal_year%20%3D%202026%20LIMIT%20100))
- catalog search “checkbook”, read 2026-11-07T03:46:47.630Z (trace step 16): 0 (0 excluded)
- catalog search “vendor”, read 2026-11-07T03:46:47.691Z (trace step 17): 1 (0 excluded), open to Siren: Municipal Building Energy Use (9v4p-ntch)

</details>

## Street-tree pruning in the performance measures checked

`norfolk.budget.no-pruning-measure` · proposed · kind `no_records` (I found no records (sources checked)) · state if approved: open · measured 2026-11-06

**Statement**

Of 361 measures in the City's Performance Measures records (7jsp-eyjg), I found none with a description naming pruning, as I read them on 2026-11-06. Under the program “Park and Forestry Operations” I found 2 measures, “Number of Park Ranger incident responses” and “Number of trees planted”, and no value for “Number of trees planted” in FY2022 through FY2025, as I read them on 2026-11-06. The City's FY2024 adopted budget says: “Percent of street tree pruning requests fulfilled” (quote checked 2026-11-04). I found the task “Pruning” on 3,293 Forestry work orders in the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06.

**Short:** Of 361 measures in the City's Performance Measures, I found none naming pruning, measured 2026-11-06.

**Shape**

- where: performance measures; Performance Measures (7jsp-eyjg), Work Orders (qzfe-wj25); citywide
- part 0 of 361 (0%), read 2026-11-07T03:46:47.931Z
- values of 7jsp-eyjg.measure_description: 2; none matched, read 2026-11-07T03:46:48.051Z

**Questions it leaves unanswered, with consequence lines**

- What share of street-tree pruning requests does the City fulfill each year? (only in part; half-answered by qzfe-wj25.primary_task_description)  
  With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found the task “Pruning” on 3,293 Forestry work orders, measured 2026-11-06, which counts orders, not requests received or fulfilled, and I found no pruning measure in the Performance Measures records.
- How many street trees did the City plant in each of the last four fiscal years? (only in part; half-answered by 7jsp-eyjg.fy_2026_projection, 7jsp-eyjg.fy_2027_target)  
  With the City's Performance Measures records (7jsp-eyjg) I can answer this only in part: I found no value for “Number of trees planted” in FY2022 through FY2025, measured 2026-11-06, so I can give only its projection and target.

**Proposed actions**

- `a-budget-proposal-pruning-measure` dataset proposal: Add street-tree pruning requests received and fulfilled to the Performance Measures dataset, with a value for each year.
- `a-budget-meeting-pruning-measure` meeting question: Does the City track the share of street-tree pruning requests it fulfills each year, and where can residents read it? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

The City’s FY2024 adopted budget names a measure for street-tree pruning requests fulfilled, by the quote the case file checked. I found no pruning measure in the open Performance Measures records, and I found no yearly value for the one Forestry measure about trees, so the question stays open in these records. The entry reports what the dataset holds, and claims nothing about the City’s pruning work or about why a measure is published or left out.

**Reviewer context (not evidence on the board):** The request cited the FY2024 book’s pruning percentages and target from the case file. That finding’s checked quote holds only the measure’s name, “Percent of street tree pruning requests fulfilled”, so only the name enters this entry, and the percentages and the target stay out. The case file’s measure-dropped finding is unverified, so it is not cited.

<details><summary>Evidence</summary>

- query on 7jsp-eyjg, read 2026-11-07T03:46:47.931Z (trace step 19): `SELECT count(*) AS whole, sum(case(upper(measure_description) like '%PRUN%',1,true,0)) AS prune WHERE measure_id IS NOT NULL LIMIT 100` → `[{"whole":"361","prune":"0"}]` ([run it](https://data.norfolk.gov/resource/7jsp-eyjg.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(upper(measure_description)%20like%20'%25PRUN%25'%2C1%2Ctrue%2C0))%20AS%20prune%20WHERE%20measure_id%20IS%20NOT%20NULL%20LIMIT%20100))
- values of 7jsp-eyjg.measure_description, read 2026-11-07T03:46:48.051Z (trace step 20), pattern /prun/i: “Number of Park Ranger incident responses”, “Number of trees planted”; matched none
- query on 7jsp-eyjg, read 2026-11-07T03:46:48.180Z (trace step 21): `SELECT count(*) AS whole, sum(case(fy_2022 IS NULL AND fy_2023 IS NULL AND fy_2024 IS NULL AND fy_2025 IS NULL,1,true,0)) AS no_actual WHERE program_name = 'Park and Forestry Operations' AND measure_description = 'Number of trees planted' LIMIT 100` → `[{"whole":"1","no_actual":"1"}]` ([run it](https://data.norfolk.gov/resource/7jsp-eyjg.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(fy_2022%20IS%20NULL%20AND%20fy_2023%20IS%20NULL%20AND%20fy_2024%20IS%20NULL%20AND%20fy_2025%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_actual%20WHERE%20program_name%20%3D%20'Park%20and%20Forestry%20Operations'%20AND%20measure_description%20%3D%20'Number%20of%20trees%20planted'%20LIMIT%20100))
- query on qzfe-wj25, read 2026-11-07T03:46:48.406Z (trace step 23): `SELECT primary_task_description AS v, count(*) AS n WHERE area = 'Forestry' GROUP BY primary_task_description ORDER BY n DESC, primary_task_description LIMIT 200` → `[{"v":"Pruning","n":"3293"},{"v":"Stump Grinding","n":"2995"},{"v":"Removal","n":"2770"},{"v":"Plantings","n":"560"},{"v":"Tree Production Operations","n":"368"},{"v":"Tree Maintenance","n":"357"},{"v":"Inspection","n":"84"},{"v":"Soil Improvement","n":"25"},{"v":"Turf Maintenance","n":"13"},{"v":"Concrete Repair","n":"8"},{"v":"Litter / Debris Removal","n":"8"},{"v":"Athletic Field Maintenance","n":"7"},{"v":"Baseball/Softball Field Marking","n":"7"},{"v":"Bed Maintenance","n":"6"},{"v":"Athletic Field Maintenance - Class A","n":"2"},{"v":"Equipment Winter Overhaul","n":"2"},{"v":"Beach Maintenance/Sanitizing","n":"1"},{"v":"Cleaning/ Debris Removal","n":"1"},{"v":"Football Field Marking","n":"1"},{"v":"Pesticide / Herbicide Applications","n":"1"},{"v":"Safety Surface Maintenance","n":"1"}]` ([run it](https://data.norfolk.gov/resource/qzfe-wj25.json?$query=SELECT%20primary_task_description%20AS%20v%2C%20count(*)%20AS%20n%20WHERE%20area%20%3D%20'Forestry'%20GROUP%20BY%20primary_task_description%20ORDER%20BY%20n%20DESC%2C%20primary_task_description%20LIMIT%20200))
- finding norfolk-trees#pruning-requests-fulfilled, quote “Percent of street tree pruning requests fulfilled”, checked 2026-11-04 ([source](https://www.norfolk.gov/DocumentCenter/View/78214/10-Department-Budgets))

</details>

## Capital projects with no ward or coordinates (adopted capital plan)

`norfolk.budget.cip-no-ward` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found 41 of 93 projects (44%) with no ward in the City's adopted Capital Improvement Plan projects (6tqj-4az3), as I read them on 2026-11-06. Of the same 93, I found 39 with no latitude or longitude, 39 of them with no ward either, as I read them on 2026-11-06. Its description of location, in its words: “Specific address or location name, when available, for the project”.

**Short:** I found 41 of 93 projects (44%) with no ward in the City's adopted Capital Improvement Plan data, measured 2026-11-06.

**Shape**

- where: projects in the adopted capital plan; Capital Improvement Plan (CIP) Projects - FY 2027 (6tqj-4az3); citywide
- part 41 of 93 (44%), read 2026-11-07T03:46:48.626Z

**Questions it leaves unanswered, with consequence lines**

- Which capital projects in the adopted plan are in my ward? (only in part; half-answered by 6tqj-4az3.ward)  
  With the City's adopted Capital Improvement Plan projects (6tqj-4az3) I can answer this only in part: I found 41 of 93 projects (44%) with no ward, measured 2026-11-06, so a search by ward can't find them.
- Which planned capital projects are near me? (only in part; half-answered by 6tqj-4az3.latitude, 6tqj-4az3.longitude)  
  With the City's adopted Capital Improvement Plan projects (6tqj-4az3) I can answer this only in part: I found 39 of 93 projects (42%) with no latitude or longitude, measured 2026-11-06, so a search by distance can't find them.

**Proposed actions**

- `a-budget-proposal-cip-place` dataset proposal: Give every project in the Capital Improvement Plan data a ward, or mark it citywide, and coordinates where it has a site.
- `a-budget-meeting-cip-place` meeting question: How can residents find which capital projects with no ward in the plan data affect their part of the city? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

I found capital projects with no ward and no coordinates in these records, and a search by ward or by distance leaves them out. The entry counts those rows, and claims nothing about whether a project has a site. A project with no ward can be citywide work, and I found no field in these records that marks it so.

**Reviewer context (not evidence on the board):** The request gave a count of projects with no ward from a read on 2026-11-06, and I found the same count when I measured it again.

<details><summary>Evidence</summary>

- query on 6tqj-4az3, read 2026-11-07T03:46:48.626Z (trace step 25): `SELECT count(*) AS whole, sum(case(ward IS NULL,1,true,0)) AS no_ward, sum(case(latitude IS NULL OR longitude IS NULL,1,true,0)) AS no_coord, sum(case(ward IS NULL AND (latitude IS NULL OR longitude IS NULL),1,true,0)) AS neither WHERE project_id IS NOT NULL LIMIT 100` → `[{"whole":"93","no_ward":"41","no_coord":"39","neither":"39"}]` ([run it](https://data.norfolk.gov/resource/6tqj-4az3.json?$query=SELECT%20count(*)%20AS%20whole%2C%20sum(case(ward%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_ward%2C%20sum(case(latitude%20IS%20NULL%20OR%20longitude%20IS%20NULL%2C1%2Ctrue%2C0))%20AS%20no_coord%2C%20sum(case(ward%20IS%20NULL%20AND%20(latitude%20IS%20NULL%20OR%20longitude%20IS%20NULL)%2C1%2Ctrue%2C0))%20AS%20neither%20WHERE%20project_id%20IS%20NOT%20NULL%20LIMIT%20100))
- metadata of 6tqj-4az3, read 2026-11-07T03:46:48.720Z (trace step 26): location, “Specific address or location name, when available, for the project”

</details>

## Parks and Recreation revenue units with no spending unit of the same name

`norfolk.budget.parks-revenue-units` · proposed · kind `partial_coverage` (Partial coverage (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

I found all 49 department names in the City's Annual Revenues records (id3i-2az4) also in the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06. Under “The Department of Parks & Recreation (P&R)”, I found 3 revenue units in Annual Revenues and 9 spending units in Annual Expenditures, as I read them on 2026-11-06. Of the 3 revenue units, I found 1 with no spending unit of the same name, “Recreation Parks Open Space”, as I read them on 2026-11-06.

**Short:** Under Parks and Recreation, I found 1 of 3 revenue units with no spending unit of the same name in the City's budget records, measured 2026-11-06.

**Shape**

- where: units under The Department of Parks & Recreation (P&R); Annual Revenues (id3i-2az4), Annual Expenditures (mdwe-dquf); citywide
- part 1 of 3 (33%), read 2026-11-07T03:46:49.053Z
- values of id3i-2az4.unit_name: 3; matched: “Recreation Parks Open Space”, read 2026-11-07T03:46:49.053Z

**Questions it leaves unanswered, with consequence lines**

- How much of a Parks and Recreation program's cost do its own fees and charges cover? (only in part; half-answered by id3i-2az4.unit_name, mdwe-dquf.unit_name)  
  With the City's Annual Revenues records (id3i-2az4) I can answer this only in part: I found 1 of 3 Parks and Recreation revenue units, “Recreation Parks Open Space”, with no spending unit of the same name in Annual Expenditures, measured 2026-11-06, so I can't set that revenue against a cost.

**Proposed actions**

- `a-budget-proposal-crosswalk` dataset proposal: Use the same unit names for a program in Annual Revenues and Annual Expenditures, or publish a crosswalk between them.
- `a-budget-meeting-crosswalk` meeting question: Which Parks and Recreation spending units do its revenue units support, where their names differ? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

Setting a program’s revenue against its cost from these records takes the same unit in both datasets. I found every department name shared between them, and under Parks and Recreation I found a revenue unit with a name that matches no spending unit, so that revenue has no cost to sit beside in these records. The entry reports the names as recorded, and claims nothing about how the City budgets the program.

**Reviewer context (not evidence on the board):** The request was citywide: revenue and spending units that differ. I found the department names all matching, so the entry narrows to the unit names under Parks and Recreation. A citywide comparison of unit names passes the values measure’s 200-value cap in Annual Expenditures (an exploratory read I checked on 2026-11-06, outside the trace, counted 321 unit names), so the menu can’t measure it whole.

<details><summary>Evidence</summary>

- values of mdwe-dquf.department_name, read 2026-11-07T03:46:48.827Z (trace step 27), pattern /.*/: 64 values; matched 64 values
- values of id3i-2az4.department_name, read 2026-11-07T03:46:48.953Z (trace step 28), pattern /.*/: 49 values; matched 49 values
- values of id3i-2az4.unit_name, read 2026-11-07T03:46:49.053Z (trace step 29), pattern /.*/: “Recreation Parks Open Space”, “Cemeteries”, “Park and Forestry Operations”; matched “Recreation Parks Open Space”, “Cemeteries”, “Park and Forestry Operations”
- values of mdwe-dquf.unit_name, read 2026-11-07T03:46:49.165Z (trace step 30), pattern /.*/: “Park and Forestry Operations”, “Cemeteries”, “Recreation Centers”, “Administrative Support”, “Special Services”, “Youth Development”, “Directors Office”, “Park Planning and Development”, “Financial Reporting”; matched “Park and Forestry Operations”, “Cemeteries”, “Recreation Centers”, “Administrative Support”, “Special Services”, “Youth Development”, “Directors Office”, “Park Planning and Development”, “Financial Reporting”

</details>

## No adopted amount or amendment date beside the current budget (Annual Expenditures)

`norfolk.budget.no-amendment-history` · proposed · kind `missing_field` (Absent or empty field (in the records I read)) · state if approved: open · measured 2026-11-06

**Statement**

The Annual Expenditures description (mdwe-dquf), as I read it on 2026-11-06, says: “The data also contains current budget information. Current budget reflects budget transfers and amendments during the fiscal year that have transpired since City Council adopted the budget prior to the beginning of the current fiscal year.” Its description of current_expense_budget, in its words: “Total annual budgeted expenditures for this department/fund/unit/object line”. I found no column for an adopted amount, an amendment or transfer, or a date it took effect among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), as I read them on 2026-11-06.

**Short:** I found no column for an adopted amount or an amendment date among the 8 columns of the City's Annual Expenditures, measured 2026-11-06.

**Shape**

- where: spending lines; Annual Expenditures (mdwe-dquf); citywide
- columns_absent /adopt|original|amend|transfer|revis|prior|(^|_)date|modif|effective/i over mdwe-dquf (8 columns), read 2026-11-07T03:46:46.553Z
- description quote from mdwe-dquf, read 2026-11-07T03:46:46.553Z
- rows last updated 2026-11-06T12:26:36.000Z

**Questions it leaves unanswered, with consequence lines**

- What did the City Council adopt for a department's budget before any amendments this year? (can’t answer)  
  I found no column for an adopted amount, an amendment or transfer, or a date it took effect among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), measured 2026-11-06, so I can't answer this from them.
- When during the year was a department's budget changed, and by how much? (can’t answer)  
  I found no column for an adopted amount, an amendment or transfer, or a date it took effect among the 8 columns of the City's Annual Expenditures records (mdwe-dquf), measured 2026-11-06, so I can't answer this from them.

**Proposed actions**

- `a-budget-proposal-amendments` dataset proposal: Publish the adopted amount beside the current budget on each Annual Expenditures line, and a dated list of budget transfers and amendments.
- `a-budget-meeting-amendments` meeting question: Where can residents read each budget transfer and amendment the City makes during the fiscal year, with its date? (ask: City Clerk (to speak at Council))

**Why it is a gap, not a finding or a complaint**

The dataset’s own description says its budget figure reflects transfers and amendments made since adoption. I found one budget column and no column for the adopted amount, an amendment or its date, so how a budget changed during the year stays out of these records. The entry reports the columns, and claims nothing about whether or how often an amendment happened.

**Reviewer context (not evidence on the board):** Annual Revenues describes its budget as the one adopted by City Council ahead of each fiscal year, so this entry covers the spending side only.

<details><summary>Evidence</summary>

- metadata of mdwe-dquf, read 2026-11-07T03:46:46.553Z (trace step 9): “The data also contains current budget information. Current budget reflects budget transfers and amendments during the fiscal year that have transpired since City Council adopted the budget prior to the beginning of the current fiscal year.”
- metadata of mdwe-dquf, read 2026-11-07T03:46:46.553Z (trace step 9): current_expense_budget, “Total annual budgeted expenditures for this department/fund/unit/object line”
- metadata of mdwe-dquf, read 2026-11-07T03:46:46.553Z (trace step 9): 8 columns

</details>

## Upcoming meetings, for the meeting questions

As listed on 2026-11-06; check the City's calendar. Read 2026-11-06; calendar: https://norfolkcityva.iqm2.com/Citizens/Calendar.aspx.
