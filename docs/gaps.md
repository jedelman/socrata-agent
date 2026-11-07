# Siren's gap board: what the records can't show, the questions that leaves unanswered, and the actions that would close it

**Status.** Rev 2, 2026-11-06. It revises rev 1 after three reviews (privacy-abuse, truth-voice, engineering). Every blocking issue is applied, and so is each major one, some only in part; §21 and the issue lists name what was declined and why. This is read-only work: nothing has been built, edited, committed or pushed.

**Code base.**
- Every `file:line` refers to `ccr-159a72f4-joafbc` at cb64aa2, read with `git show`. `worker/requests.js`, `worker/requests.html` and `scripts/sync-request-issues.js` are the same on `origin/main` (df54d00).
- The **traces branch** (2ac9db9, checked out in `/home/user/socrata-agent`) adds `answerRecord` (`worker/conversations.js:39-58` there) and a `record` per saved turn (:69-80 there).
- The **endorse branch** adds `worker/endorsements.js` and `worker/public-list.js`, and changes `requests.js`, `requests.html` and `admin.html` (endorse spec §2).

**Evidence levels.**
- **Code:** read in this pass.
- **Live (rev 2):** queries I re-ran against data.norfolk.gov and the Socrata catalog on 2026-11-06, about 22:00 to 22:12Z. The SoQL is in §4.4. Every number in §1, §4 and §6.1 is from these runs unless marked otherwise.
- **Live (rev 1):** rev 1's 21:20Z runs, which I didn't repeat. Marked where used.
- **Docs:** the four Va. Code § 2.2-3704 quotes, fetched by rev 1 on 2026-11-06. I didn't re-fetch them.
- **Scratch check:** `/tmp/claude-0/-home-user/1a06cb6c-e084-57b5-a3f7-072243d3ae4a/scratchpad/gaprev3/check.mjs` implements §6.2's rules A to C literally, plus `voiceViolations` copied from cb64aa2. Every §6.1 string and label passes it, and the six strings that must fail do. `/tmp/claude-0/-home-user/1a06cb6c-e084-57b5-a3f7-072243d3ae4a/scratchpad/gaprev3/pt.mjs` tries the §6.3 street patterns with a sample street list. Both are scratch; Inc 2 holds the real tests.
- **ASSUMPTION A#:** settled by none of the above. All are listed in §19.

**Speculation is out.** Jason, 2026-11-06: "Let's drop speculation - the gaps speak for themselves as long as we can define their shape and their consequences. Connect them to unanswered questions."
- A gap has a shape and consequences, and nothing else. Nothing here writes a cause, a hypothesis, a prediction or a "may".
- Rev 1 still had two hypotheses, and both are gone:
  - the contract statement "work done under separate contracts may not appear" (§1.1);
  - reading "how much notice" from created dates (§1.8).
- I reuse four things from the dropped speculation spec: statistics computed by code, finding ids read straight from case files, its people and grain word lists, and its `assigned_crew` finding.

**What changed from rev 1, in short.**
- **Today's request list goes first (§16).** It breaks its own promises in three ways:
  - a note added after a request is accepted is public at once;
  - raise times are published to the millisecond;
  - a raise reveals the counts of items the steward hasn't reviewed.
- **Catalog.**
  - Trunk size is retired. It was Siren's own bug, not a gap in the records.
  - Contract work is reshaped into "no column links a work order to a contract".
  - "No future start date" becomes "no column for a planned date".
  - Notice gets its own entry.
  - Removal measures count status "Complete", with a breakdown by status.
- **Text rules.** Rule 3 is scoped, so the spec's own strings pass. Hedges are banned in code-written text. Labels are written as reports. Every number carries its date.
- **Attaching gaps.**
  - Gaps attach through predicates on what the turn actually ran, not through any touch of a dataset.
  - A raise counts toward a gap's demand only when the gap bit that turn.
  - Counts show where each link came from.
- **Residents' words.**
  - Raised questions get random ids, so nobody can test a guess against them.
  - Place tokens stop a raise from naming the asker's own street, ward or civic league.
  - Street-name patterns, intersections and "block of" are blocked.
  - The raise route answers the same way for every target.
- **v1 raising is narrower.** It offers picks of general questions, and free text only under answers that have a gap attached. Caps apply per visitor and site-wide. Unreviewed items expire, and the steward's queue is bounded.
- **Storage depends on the plan.** KV list and write operations, not item counts, are the limit. On the free plan the board needs D1 before it goes public. On the paid plan, a materialized public snapshot in KV.
- **Answers and closings.**
  - An answer is shown as its quote; the claim is labeled as the steward's summary.
  - A finding answers or closes something only after a second reader has reviewed its claim and it has been re-verified in the same build.
  - A records reply hosted by the project is labeled as hosted.
- **GitHub mirror.** Only code-written text is mirrored, and withdrawn items are closed.
- **Siren's answers when gaps are on.** The answer gets a world-claim check, and `deployments/siren.config.js:20` must be replaced before gaps turn on.

---

## 0. The loop

```
datasets · case files · bundled indexes
   │  fixed measures, run by code at GENERIC access, dated, traced
   ▼
GAP     shape = kind · where (source, scope incl. status, area, span) · how much (code statistic + dates) · evidence (query + result, or quote re-verified this build)
   │  consequences (code-rendered, scoped to the datasets checked)
   ▼
UNANSWERED QUESTIONS   general (catalog PR; blocks part|all, checked by code) + raised through Siren (person-confirmed; pooled; counted by link provenance)
   │  what would close it
   ▼
ACTIONS   source request · records-request (FOIA) draft · meeting question · dataset proposal · watch (private pointer)
   │  people act; Siren only drafts
   ▼
OUTCOME   merged PR · FOIA reply · minutes · new dataset ──► finding (quote verified, claim second-read) or code re-measure
   └──► question answered / gap closing ──► steward confirms by PR ──► case file
```

**Who does what.**
- **Code** measures, renders and drafts.
- **Residents** raise questions through Siren and endorse with Bluesky.
- **Stewards** decide what goes public. Each decision carries a reason code and lands in a public log.
- **Contributors and civic leagues** claim actions and do them.
- **Siren** never sends, files, posts or claims anything on its own.

**Research to analysis.** A case file then reads in three parts: what's verified, what the records Siren reads can't show, and what would close it.

---

## 1. Corrections to the frame (live, rev 2)

W = `area = 'Forestry' AND primary_task_description = 'Removal'`. C = W `AND status_code = 999`, which the City labels “Complete”.

1. **Contract work: a missing link, not "may not appear".**
   - The finding `contract-removal` claims "Not all tree work is in the work-order data" (`data/cases/norfolk-trees.json:197`). Its quote says only "The contract is used to remove decaying or diseased trees" (:202), so the claim outruns its quote.
   - Its "$254,807" figure sits only in the claim.
   - What the records do show:
     - `contractor_cost` is defined as "Cost of contractor labor and materials in completing the work order" (qzfe-wj25 metadata);
     - 563 of 2,378 C rows (24%) carry it above zero;
     - among C rows created 2021-07-01 to 2022-06-30, 36 of 325 carry it, summing to $4,734.83;
     - among the 32 columns, none links a work order to a contract or invoice.
   - The gap is that missing column (§4, `no-contract-link`).
2. **Dominion: nothing verified says line clearance is missing from work orders.**
   - The quote supports only "Nearly all of our neighborhood power lines are cleared on a four year cycle" (:277). The claim at :272 goes past it.
   - What Siren can state is its own reach:
     - The catalog search "line clearance" returns resultSetSize 0.
     - The search "Dominion" returns 4, all open to Siren: kdpy-v28a Street Light Outages, 5qpt-tdve Streetlights and Outages Reports, 9v4p-ntch Municipal Building Energy Use, ere7-kake Address Information.
     - Forestry work orders carry 18 `problem_description` values, and none matches utility, power line, line clearance or Dominion.
3. **Denominators: removal questions get C, and the status breakdown is shown.**

   | Forestry removal work orders, by status | n | no street | contractor cost > 0 | end date set |
   |---|---|---|---|---|
   | 999 “Complete” | 2,378 | 582 | 563 | 2,378 |
   | 2 “New Work Order” | 336 | 79 | 12 | 41 |
   | 4 “On-Going” | 17 | 6 | 5 | 9 |
   | 957 “Duplicate Work Order” | 21 | 7 | 0 | 21 |
   | 940 “Delete WO”, 947, 951, 953, 956 | 18 | 9 | 0 | 10 |
   | all | 2,770 | 683 | 580 | |

4. **No street.**
   - All time, 582 of 2,378 C rows (24%) have no street. They were created 2020-08-05 through 2026-10-30.
   - By created year (C): 2020 21/205 · 2021 44/315 · 2022 101/499 · 2023 134/407 · 2024 149/343 · 2025 112/363 · 2026 21/246.
   - Created since 2025-11-06 (C): 24 of 272 (9%). Of those 24, 22 have no ward and no civic league either.
   - New Work Order and On-Going: 85 of 353 (24%).
   - Of the 582 C rows with no street, 469 name a civic league and 483 a ward.
   - The board shows these numbers. It doesn't explain them.
5. **"Created on or after its end date"** (rev 1 called it "recorded late").
   - C rows with an end date from 2025-11-06 through 2026-11-05: 115 of 360 (32%). 22 end before the order was created and 93 on the same day. This matches the brief.
   - All time: 868 of 2,378 (Live, rev 1).
   - The label never says "after the work" (notifications §8.3).
6. **Survey date.** The inventory (cmvv-agyb) describes itself in two sentences, quoted whole:
   - "The original inventory of these trees was conducted in the late 1990s/early 2000s by the Norfolk Master Gardeners."
   - "No official re-inventory has been conducted since then by City officials or ISA Certified Arborists, however, tree records in this dataset have been and are being updated over time by City Staff."

   Its rows were republished 2026-11-06 at 12:27Z. None of its 13 data columns dates a tree's record. Use "late 1990s/early 2000s", never "about 2000".
7. **No condition column.**
   - None of cmvv-agyb's 13 data columns names condition, health or risk. Neither do the columns of jz6u-9g3c Significant Trees or u85v-sad9 Tree Planting Program.
   - Work orders do carry the City's problem codes: “Dead Tree” 770, “Diseased” 127, “Damaged Tree” 258, across all Forestry tasks. A condition question is therefore answerable `part`, not `all`.
8. **No planned date.**
   - `start_date` is "Date the work on the work order began" (qzfe-wj25 metadata), so a start_date never falling in the future is expected. The gap is that no column holds a planned or scheduled date.
   - Backlog: 353 with status “New Work Order” or “On-Going”, of which 50 carry an end date. Their median created date is 2024-04-09, 941 days before 2026-11-06.
   - Rev 1's "open" read meaning into status codes, against `src/prompt.js:10`. It is dropped.
   - Created dates aren't notice to residents, so the notice question moves to its own columns_absent entry.
9. **Trunk size: not a gap.**
   - cmvv-agyb has `trunk_diameter`, a number, described as "The approximate trunk diameter of the tree. Since trees grow over time, the current diameter may be larger than what data shows." It also has `trunk_diameter_range`.
   - Of 93,997 city trees: 65,858 have no range, 25,174 no diameter, and 6,918 (7%) neither a range nor a diameter above zero.
   - The plugin reads only the range (`plugins/trees-on-my-block.js:97`, :104-105). It tells the model "most trees have no trunk size recorded" (:179, and its comment at :11).
   - That is Siren's bug (Inc 5). The 7% is offered as an optional entry.
10. **311 is out of Siren's reach by Siren's own rule.** The rule is at `src/cities/norfolk.js:38`. Reviewed plugins and core may read restricted datasets with the aggregation inside the query (:30-33); open-ended tools may not.
11. **No requester or approver column (32 checked).**
    - `department`, `area`, `priority`, `problem_description` and `reason` exist. `reason` is described as "Source of the problem to be remedied; used for work orders associated with storms."
    - A department isn't a decider (`src/prompt.js:17`).
12. **The voice check misses world claims and hedges.** `voiceViolations` (`src/voice.js:5`) returns `[]` for "The tree inventory has not been re-surveyed since about 2000." and for "Contract removals may not appear in these records, and the City probably does not log them." Gap text gets its own rules (§6.2), and `src/voice.js` stays unchanged.
13. **Today's request list breaks its own promises** (privacy review; confirmed in code).
    - `addRequest` keeps the request's status and appends notes with `public: body?.public === true` (`worker/requests.js:34-41`). The UI always posts `public: true` (`worker/ui.html:303`).
    - `publicView` shows the last 5 public notes of any accepted request (`requests.js:66`), and the sync copies them to GitHub (`scripts/sync-request-issues.js:47-49`). So a note added after acceptance is public at once, unreviewed. That breaks `requests.js:8-11`, `requests.html:36` and `ui.html:294`.
    - Timestamps are ISO to the millisecond (`requests.js:33`, :62-63).
    - The raise response returns a count whatever the status (`requests.js:45`, `worker/index.js:325`).
    - Fixed first: §16, Inc 1.
14. **One oddity, for find-gaps.** A C row has an end_date after the read date: the maximum end_date is 2026-11-10. It's a candidate, not catalogued.

---

## 2. Invariants

| # | Holds | Enforced by |
|---|---|---|
| I1 | Code computes every gap number from a query, metadata or a bundled file, with its dates. No person or model types one. | builder + `--check` + test |
| I2 | Gaps come only from the catalog (`src/gaps/<city>.js`): reviewed by PR, checked live, dated. The model can name a gap that's attached; it can't create one. | code + test |
| I3 | Every code-written or steward-written public string passes `voiceViolations` and `publicTextViolations`, plus the `gapTextViolations` rules for its string type (§6.2). `src/voice.js` is unchanged. | code + test |
| I4 | No gap gives a cause. The schema has no free-text cause field, and unknown keys fail. | schema + test |
| I5 | No board record holds who raised or endorsed anything: no uid, visitor hash, IP, conversation id or conversation text. Raise dates are days. No public id or log entry is a hash anyone can recompute from resident text. | code + KV-dump test + log test |
| I6 | Conversations reach the board only through the person's own Add click, carrying text they edited. Board code never reads `conv:` keys. Raise tokens and drafts are never saved in a conversation. | code + grep test + conv-dump test |
| I7 | Board text is citywide in v1. Code refuses house numbers, a number followed by a street name, intersections, "block of", the asker's own street, ward and civic league (place tokens) and people-pointing phrases. Beyond those checks, residents' words rely on the steward. `assigned_crew` is never selected or shown, and the board never links the full Work Orders CSV. | code + test, then the steward |
| I8 | Siren never acts outward. Actions are drafts and pointers; people send, file, ask and claim. | design + test |
| I9 | No access level rises. Measures run at `ACCESS.GENERIC` (`src/socrata.js:18`), and nothing on the board path passes `access: 'core'`. | code + test |
| I10 | Restricted datasets get policy evidence and aggregate-only actions. A turn that hit a restricted refusal offers only picks of code-written questions. Excluded datasets never appear. | code + test |
| I11 | A question is answered, or a gap closed, only by a code re-measure or by a finding that meets three conditions: its quote is re-verified in this build, a second reader has reviewed its claim, and the board renders its quote. A steward confirms by PR. | code + test |
| I12 | Every steward decision carries a reason code and lands in an append-only public log. The log holds no declined text, logs declined items under a random per-entry id, and gives declines template notes only. | code + test |
| I13 | Counts are information. No status changes because of a count. | code + test |
| I14 | With every flag off, `toolsFor`, `systemPrompt`, `theRecord`, `ask()`'s return keys and every route stay byte-identical to the merge base. The one exception is Inc 1's deliberate fixes to `/api/requests`. | test |
| I15 | A gap's demand counts only raises that code linked to it, because the gap bit that turn. Links the asker or a steward made are shown separately. | code + test |
| I16 | Every rendered sentence that holds a number also holds a date. | test |
| I17 | Small counts: below the city, each count and its complement must be at least 5, or the board shows "fewer than 5". No series goes below ward level. | `--check` + test |
| I18 | The board can't use up what `/api/ask` needs. Board writes have a daily ceiling and fail closed for the board only. | code + test |

---

## 3. A gap's shape

### 3.1 Kinds

| `kind` | Label (J24) | What's missing | Evidence it needs | Measure |
|---|---|---|---|---|
| `no_records` | I found no records (sources checked) | A verified source shows an activity happens, and the sources Siren reads hold no record of it | the finding's quote (never its claim), plus code checks: raw catalog counts with names, and a values check on the closest field | `catalog_search` · `values_absent` |
| `missing_field` | Absent or empty field (in the records I read) | No column for something, a column left empty on some rows, or no forward date | `columns_absent` over the topic's datasets; a null share; sibling columns cleared | `columns_absent` · `share` |
| `partial_coverage` | Partial coverage (in the records I read) | Rows cover only part of something | a share over a bundled index, or a verified finding | `share` · `index_count` |
| `stale` | Survey date stated by the source | The source dates its own observations, in its own words. The publishing date is shown separately. | whole-sentence metadata quotes, plus `rowsUpdatedAt` | `description_quote` · `age` |
| `created_on_or_after_end` | Created on or after its end date | A record's own dates put its creation on or after its end date | a field comparison over a fixed trailing window | `window` |
| `restricted` | Out of Siren's reach by rule | Siren's policy keeps the dataset from open-ended use | the profile entry (file:line), with no query | `policy` |
| `not_online` | Not found at the pages checked | A document a verified source names, which none of the checked pages holds | a finding with `absent`, checked live (`scripts/verify-cases.js:33-34`, :151) | `absent_on_page` |
| `no_decision_record` | No field naming who decided (in the records I read) | No field Siren reads names who requested or approved something | `columns_absent` | `columns_absent` |

The key `recorded_late` is renamed `created_on_or_after_end` everywhere: ids, issues and code.

### 3.2 The built record (`data/gaps/<city>.json`)

```
{ id: 'norfolk.work-orders.removal-no-street',        // permanent; never reused; retired ids stay listed
  public_id: sha256('gap\n'+id).slice(0,12), kind: 'missing_field',
  title: 'Forestry removals with no street (Work Orders)', label: '<kind label>',
  where: { sources:[{type:'dataset', id:'qzfe-wj25', name:'Work Orders'}], scope:'Forestry removal work orders',
           status:{field:'status_code', values:[999], as_recorded:['Complete']}, area:'citywide',
           span:{field:'created_datetime', from:'2020-08-05', through:'2026-10-30'} },
  topic: { name:'trees', datasets:['cmvv-agyb','qzfe-wj25','jz6u-9g3c','u85v-sad9'], search:'tree',
           not_in_topic:[{id:'mrv3-rcpc', reason:'<reviewer>'}], checked_live:'2026-11-06' },
  how_much: { part:582, whole:2378, read:'2026-11-06T22:05Z', series:[{k:'2024', part:149, whole:343}, …],
              window:{from:'2025-11-06', part:24, whole:272, also:{no_ward_or_league:22}},
              by_status:[{as_recorded:['New Work Order','On-Going'], part:85, whole:353}] }
          | { columns_absent:{pattern:'/plan|sched|due|target/', datasets:{'qzfe-wj25':32, …}, siblings_cleared:[{column, by, date}]} }
          | { unmeasured:'no_count_in_records' },
  evidence: [ {type:'query', dataset, soql, url, result, read, trace_n}
            | {type:'metadata', dataset, field, quote|columns, read}
            | {type:'finding', case, id, url, quote, selector, checked, reverified}      // never the claim
            | {type:'catalog_search', q, result_set_size, open_to_siren:[{id,name}], read}
            | {type:'values', dataset, field, values:[…], pattern, matched:[] , read}
            | {type:'policy', dataset, reason, file, line} | {type:'index', file, built, counted, of} ],
  statement:'<code>', short:'<≤200 chars, code>',
  questions:[{ qid:'q1', text:'Was a city tree removed on my street?', blocks:'part',
               answered_in_part_by:[{dataset:'qzfe-wj25', column:'street'}], consequence:'<code>' }],
  actions:['a-…'],
  touches:[{dataset:'qzfe-wj25', where_includes:["area = 'Forestry'"]}, {tool:'trees_on_my_block'}, {case:'norfolk-trees'}],
  bites_when:[{tool:'trees_on_my_block', field:'on_your_street', ok:true}, {dataset:'qzfe-wj25', where_includes:['street =']}],
  closed_when:{share_at_most:0.01, over:'window'} | {finding:true} | {column_present:'<pattern>', null_share_at_most:0.05},
  state:'open'|'closing'|'closed'|'unmeasured_today'|'evidence_unverified', last_good?, reverified:'<date>', hand_off }
```

**Field rules** (in `test/gaps.test.js`):
- `additionalProperties: false` everywhere, so a `why` or `cause` field fails.
- **Finding evidence** must meet both:
  - `!f.unverified && f.checked` (`plugins/cases.js:26`);
  - re-verified in this build's read-only verify-cases pass (§5.4), or `checked` within `STALE_DAYS` (30, `scripts/verify-cases.js:47`).
- **`blocks: 'all'`** needs a recorded `columns_absent` over every dataset in `topic.datasets` for that question's concept pattern. Otherwise `blocks` is `'part'` and `answered_in_part_by` names the half-answering columns. `describe` checks every column named there.
- **`topic.datasets`** must cover every hit of `topic.search` in the live catalog, or list it in `not_in_topic` with a reviewer's reason. A reviewer has to place `mrv3-rcpc` STORM (A16).
- **`missing_field` siblings.** A `missing_field` measure lists every sibling column whose name matches the concept (for size: `trunk|diameter|dbh|size`). A reviewer clears each by PR, so a derived column can't stand in for the record.
- **What a gap never holds:** a street, address, parcel or person, or text from a conversation or a model.

---

## 4. The v1 Norfolk catalog (drafts for J1)

### 4.1 Entries (live, rev 2)

| id (`norfolk.` prefix) | kind | how much | general questions (blocks: what half-answers) | actions |
|---|---|---|---|---|
| `work-orders.removal-no-street` | missing_field (share) | C: 582/2,378 (24%), created 2020-08-05 to 2026-10-30. Since 2025-11-06: 24/272, with 22 of the 24 having no ward or league. New Work Order or On-Going: 85/353. Year series in §1.4. | "Was a city tree removed on my street?" (part: `street`) · "Is a tree removal logged for my street?" (part: `street`) · "Which streets had city tree removals last year?" (part: `street`) | meeting question · dataset proposal ("Record a street on every Forestry work order.") · watch pointer, carrying the street watch's warning |
| `work-orders.created-on-or-after-end` | created_on_or_after_end | C, end dates 2025-11-06 to 2026-11-05: 115/360 (32%): 22 before creation, 93 the same day. All time: 868/2,378 (Live, rev 1). | "Can I find out before a street tree near me is removed?" (part: `created_datetime`, `end_date`) | meeting question · watch pointer |
| `work-orders.no-planned-date` | missing_field (columns) | No planned or scheduled date column in any topic dataset. `start_date` is quoted. Backlog: 353 with status “New Work Order” or “On-Going”, 50 of them with an end date, median 941 days since created. | "When is a logged tree removal on my street planned to happen?" (all) | meeting question · FOIA draft (needs a new `records_to_request` entry by case-file PR) |
| `work-orders.no-notice-field` | missing_field (columns) | No column for notice to residents (`/notice|notif|post/`) in any topic dataset | "How much notice does the City give before removing a street tree?" (all) | meeting question |
| `work-orders.no-contract-link` | missing_field (columns) | No contract or invoice column among 32. C: 563/2,378 with contractor cost above zero. Budget quote, finding `contract-removal`, quote only. | "Does every contracted tree removal have a work order in these records?" (all) · "How many trees did City contractors remove last year?" (part: `contractor_cost`, which counts orders, not trees) | FOIA draft: `records_to_request[0]` verbatim (`norfolk-trees.json:500`) · dataset proposal ("Mark on each work order whether a City crew or a contractor did the work.") |
| `work-orders.no-trees-per-order` | missing_field (columns) | No tree-count column among 32 | "How many street trees did the City remove last year?" (part: the records count orders) | FOIA draft: `records_to_request[1]` (:501), with "priority" struck because the column exists (§9.2) |
| `work-orders.no-approver` | no_decision_record | No requester or approver column among 32 | "Which City office approves street-tree removals, and on what criteria?" (part: `department`, `priority`, `problem_description`) | meeting question · FOIA draft for policy, criteria, the approving position, and counts by request source, with names left out (needs a new `records_to_request` entry by case-file PR) |
| `tree-inventory.survey-date` | stale | Both sentences quoted (§1.6). Rows republished 2026-11-06. No per-row date column among 13. Finding `no-citywide-assessment`, quote only. | "How many street trees does Norfolk have now?" (part: `tree_id`) · "How current is the City's record of the trees on my block?" (part: dataset `rowsUpdatedAt` only) | meeting question ("Does the City plan a re-inventory of its street trees?"). The FOIA action is dropped until a case-file PR adds a re-inventory entry; `records_to_request[3]` (:503) asks for plans and the audit, not a re-inventory. |
| `tree-inventory.no-condition` | missing_field (columns) | No condition, health or risk column in any topic dataset. Work-order problem codes: “Dead Tree” 770, “Diseased” 127, “Damaged Tree” 258. | "What condition are the street trees on my block in?" (part: qzfe-wj25 `problem_description`) · "Which street trees are at risk of failing?" (part: the same) | dataset proposal ("Add tree condition to the City Tree Inventory.") · meeting question |
| `tree-inventory.no-usable-size` (optional) | missing_field (share) | 6,918/93,997 (7%) with neither a range nor a diameter above zero, `PRIVATE TREES` left out (`trees-on-my-block.js:25`). The diameter's own caveat is quoted. | "How big are the trees on my block?" (part: `trunk_diameter`, `trunk_diameter_range`) | dataset proposal ("Fill the trunk size on every city tree record.") |
| `utility.line-clearance` | no_records | Raw catalog counts and names (§1.2); 18 problem codes, none matching; finding `dominion`, quote only | "Which tree work near me was utility line clearance?" (all) | meeting question. The wording and the target are J17, shared with notifications D16. |
| `311.restricted` | restricted | Policy (`norfolk.js:38`), with no query | "How many tree requests reached MyNorfolk 311 in my ward last year?" (all) | source request for a reviewed aggregate plugin under `docs/capabilities-norfolk.md:193-196`, tagged `aggregate_only` |
| `legislation.no-address` | partial_coverage (index) | 681/1,437 (47%) titles with no street address Siren parsed. Index built 2026-11-02, meetings 2023-07-11 to 2026-10-22. | "Did the Council act on anything that affects my block?" (part: `addresses`) | source request (list citywide items beside block matches; fulfilled by a Siren PR) |

**Rev 1 ids not carried forward** stay listed as retired and are never reused: `work-orders.removal-recorded-late`, `work-orders.removal-no-future-date`, `work-orders.contract-work`, `work-orders.trees-per-order`, `work-orders.removal-no-approver`, `tree-inventory.survey-age`, `tree-inventory.no-trunk-size`.

### 4.2 Not a gap: Siren's own bugs (`not_a_gap`)

- **Trunk size** (§1.9). Fixed in Inc 5: read `trunk_diameter`, and report values of 0 or less as unrecorded, without guessing why.
- **`deployments/siren.config.js:20`** tells the model to state "the tree inventory has not been re-surveyed since about 2000" as fact. That's a world claim the voice check misses, and the fix is J25.
- **`plugins/trees-on-my-block.js:180`** says "work done under separate contracts may not appear here", which is a hypothesis. J25 replaces it with the `no-contract-link` statement.

### 4.3 Candidates, not registrable yet

- **Tree Commission annual reports** (`not_online`).
  - The finding `tree-commission` is unverified (`norfolk-trees.json:320-328`), and `records_to_request[4]` (:504) asks for the reports.
  - Registering it needs two things: a finding with `absent`, and a live page check.
- **Pruning measure dropped.** Its only evidence is the unverified finding `measure-dropped` (:34).
- **Litter survey coverage.** It needs a builder query on the survey dataset. The plugin's "244 chosen locations" is code text, not evidence.
- **Old publishing.** Significant Trees (jz6u-9g3c) rows were last updated 2021-03-26, and Tree Planting Program (u85v-sad9) rows 2019-08-20. Each needs its `rowsUpdatedAt` measured against its stated update frequency.
- **End dates after the read date** (§1.14).

### 4.4 Exact queries (rev 2 runs)

All of these go to `data.norfolk.gov/resource/<id>.json?$query=`.

**qzfe-wj25:**
- `SELECT status_code, status_description, count(*) AS n, sum(case(street IS NULL,1,true,0)) AS no_street, sum(case(contractor_cost > 0,1,true,0)) AS cc, sum(case(end_date IS NOT NULL,1,true,0)) AS has_end WHERE W GROUP BY status_code, status_description ORDER BY status_code` → the §1.3 table
- `SELECT count(*) AS d, sum(case(date_trunc_ymd(end_date) < date_trunc_ymd(created_datetime),1,true,0)) AS before, sum(case(date_trunc_ymd(end_date) = date_trunc_ymd(created_datetime),1,true,0)) AS same WHERE C AND end_date >= '2025-11-06T00:00:00' AND end_date < '2026-11-06T00:00:00'` → 360, 22, 93
- `SELECT count(*) AS n, sum(case(street IS NULL,1,true,0)) AS no_street, sum(case(street IS NULL AND ward IS NULL AND civic_league IS NULL,1,true,0)) AS no_loc WHERE C AND created_datetime >= '2025-11-06T00:00:00'` → 272, 24, 22
- `SELECT date_extract_y(created_datetime) AS y, count(*) AS n, sum(case(street IS NULL,1,true,0)) AS k WHERE C GROUP BY y ORDER BY y` → §1.4
- `SELECT min(created_datetime) AS a, max(created_datetime) AS b, max(end_date) AS e WHERE C` → 2020-08-05T08:31:36, 2026-10-30T11:42:52, 2026-11-10
- `SELECT sum(case(civic_league IS NOT NULL,1,true,0)) AS league, sum(case(ward IS NOT NULL,1,true,0)) AS ward WHERE C AND street IS NULL` → 469, 483
- `SELECT count(*) AS n, sum(case(end_date IS NOT NULL,1,true,0)) AS e WHERE W AND (status_code < 800 OR status_code = 941)` → 353, 50
- **Median** (exact, §5.2): `SELECT created_datetime WHERE W AND (status_code < 800 OR status_code = 941) ORDER BY created_datetime, work_order_number LIMIT 1 OFFSET 176` → 2024-04-09T11:28:45, 941 days before 2026-11-06
- `SELECT count(*) AS n, sum(case(contractor_cost > 0,1,true,0)) AS cc, sum(contractor_cost) AS s WHERE C AND created_datetime >= '2021-07-01T00:00:00' AND created_datetime < '2022-07-01T00:00:00'` → 325, 36, 4734.83
- `SELECT problem_description AS p, count(*) AS n WHERE area = 'Forestry' GROUP BY p ORDER BY n DESC LIMIT 50` → 18 values
- `SELECT count(*) AS n, sum(case(priority IS NULL,1,true,0)) AS nopri WHERE C` → 2378, 50

**cmvv-agyb:** `SELECT count(*) AS n, sum(case(trunk_diameter_range IS NULL,1,true,0)) AS no_range, sum(case(trunk_diameter IS NULL,1,true,0)) AS no_dia, sum(case((trunk_diameter IS NULL OR trunk_diameter <= 0) AND trunk_diameter_range IS NULL,1,true,0)) AS no_usable WHERE common_name IS NULL OR common_name != 'PRIVATE TREES'` → 93997, 65858, 25174, 6918.

**Metadata:** `/api/views/<id>.json` for qzfe-wj25 (32 columns), cmvv-agyb (13 data columns), jz6u-9g3c and u85v-sad9.

**Catalog:** `api.us.socrata.com/api/catalog/v1?domains=data.norfolk.gov&only=dataset&q=…`:
- "line clearance" → resultSetSize 0;
- "Dominion" → 4;
- "tree" → 5: jz6u-9g3c, cmvv-agyb, u85v-sad9, qzfe-wj25, mrv3-rcpc.

**Index:** `data/norfolk-legislation.json` at cb64aa2: 681 of 1,437 items with `addresses` empty.

---

## 5. Catalog, builder and verification

### 5.1 Files

| File | What it holds |
|---|---|
| `src/gaps/kinds.js` | Kind keys and labels, formatting, statement templates, `gapTextViolations` (rules A to C), `worldClaimViolations`, `GAP_REWRITE_ADDENDUM`, `botText` |
| `src/gaps/text-utils.js` | Pure copies of `stripQuoted` (`src/voice.js:9-18`) and of verify-cases' `normalize` (`scripts/verify-cases.js:51-66`). That file imports `node:child_process` (:41), so the Worker bundle can't import it. A test holds each copy byte-equal in behavior over a shared corpus. |
| `src/gaps/measures.js` | The fixed measure menu and the positional identifier rule (§5.2) |
| `src/gaps/schema.js` | Record schema |
| `src/gaps/norfolk.js` · `src/gaps/actions-norfolk.js` | Entries with `checked_live`, and action templates |
| `src/public-text.js` | `publicTextViolations`, `publicTextFlags` |
| `scripts/build-gaps.js` | `--live` (default): measures, then writes `data/gaps/<city>.json` (bundled), `<city>.trace.json` (not bundled), `<city>-streets.json` (bundled, §6.3) and `docs/gaps-<city>.md`. `--offline`: recomputes only the parts derived from repo files. `--check`: see §5.3. |
| `scripts/find-gaps.js` | The read-only candidate finder, writing to a gitignored path (§5.5) |
| `src/gaps/proposed/<city>-<set>.js` · `scripts/build-gaps-proposed.js` | Proposed entries awaiting Jason's approval, in the catalog's entry shape and marked `proposed`. Nothing under `src/` or `worker/` imports them and `build-gaps.js` never reads them (`test/gaps-proposed.test.js`). The script measures them with the catalog's own builder and writes `data/gaps/proposed-<city>-<set>.trace.json` (not bundled) and a review page, e.g. `docs/gaps-budget-proposed.md`; `--check` replays it against the current repo files, and `--offline` rewrites the parts that come from repo files (the agenda index, case-file findings) after they change. |

**How the built file is read.** The Worker imports it, as it imports `data/norfolk-legislation.json` (`worker/index.js:14`). The CLI loads it beside `loadIndexes` (`bin/socrata-agent.js:41-50`).

### 5.2 Measures: a fixed menu

| Measure | What it does |
|---|---|
| `count` · `share` | One query row gives both the part and the whole |
| `series` | `GROUP BY` year, citywide only |
| `window` | Trailing days from the build date (§5.3 dates) |
| `span` | First and last date in scope |
| `columns_absent` | `describe` at GENERIC (`src/socrata.js:316-344`) for every topic dataset, checked against the concept pattern, with siblings listed |
| `values_absent` | The distinct values of one categorical field, checked against a pattern, with the list rendered |
| `description_quote` | Whole sentences, normalized as verify-cases does |
| `catalog_search` | A new traced method, `catalogSearchRaw(q)`, beside `searchCatalog` (`socrata.js:296-314`). It keeps the raw `resultSetSize` and marks which results Siren may open; `searchCatalog` itself is unchanged. |
| `median_age` | Exact: `count(*)`, then `ORDER BY <date>, <row id> LIMIT 1 OFFSET floor((n-1)/2)`, plus the next row when n is even. `clampLimit` (`socrata.js:93-99`) would rewrite rev 1's `LIMIT 2000` to 500 with no error. |
| `index_count` · `finding` · `policy` | A count over a bundled file; a verified finding; the profile entry |

**Rules for every measure:**
- Every `where`, flag and pattern is a constant in the catalog. Columns must exist in `describe`.
- **The identifier rule is positional,** checked over `stripLiterals(soql)`. `identifiers()` (`socrata.js:138-140`) returns only a flat set, which can't express this.
  - A location identifier may appear only as `<id> IS [NOT] NULL`: `street`, `address`, `street_number`, `gpin`, `parcel*`, `lat*`, `lon*`, `location`, `*_point`, `the_geom`, `census_tract`.
  - It is refused next to `=`, `!=`, `in`, `like`, `within_circle` or `starts_with`, in `GROUP BY` or `ORDER BY`, and as a bare `SELECT` item.
  - `assigned_crew` and every `PERSON_COLUMNS` match (`socrata.js:180-189`) are refused in every position.
  - The rule applies to catalog measures and to find-gaps. The §4.4 queries are its tests in both directions.
- **The street list** (`<city>-streets.json`, distinct Work Orders and Address Information street names) is a separate reviewed builder step, not a measure. It runs one GROUP BY on `street`, and its output is used only in refusal patterns, never rendered.

### 5.3 The builder

1. **Context.** `createContext({ city: applyConfig(getCity('norfolk'), siren), appToken })` (`src/agent.js:31-40`, `src/plugins.js:133-152`).
2. **Queries.** Every query runs as `ctx.socrata.query(id, soql, { tool: 'gap catalog: <id>', access: ACCESS.GENERIC })`, which records the trace (`src/trace.js:12-27`). Resources keeps the full CSV only where no policy applies (`socrata.js:349-353`).
3. **Refused before any network request:** excluded or restricted datasets in a `query` measure (`socrata.js:363`, :370), and §5.2 identifier violations.
4. **Per-gap isolation.** Each gap's statement, title, label, consequence lines and short text are checked (§6.2, §6.3). If any fails, or the measure fails, that gap goes to `unmeasured_today` with `last_good`, or stays off the board when there's none. Every other gap still builds. Only schema errors and identifier-rule violations abort the whole build.
5. **Determinism.** The trace stores `n`, tool, dataset, url, soql, ok and rows, never `ms`. Output is sorted.
6. **Dates.**
   - `read` is the UTC ISO time of the fetch.
   - Windows use the build's America/New_York calendar date, compared against Socrata's floating timestamps, written as `'YYYY-MM-DDT00:00:00'` (A13).
   - Ages are whole days between that date and the row's date.
7. **Live and offline parts.**
   - Live parts are the Socrata measures.
   - Offline parts are derived from repo files: `index_count` over `data/norfolk-legislation.json`, finding evidence from `data/cases/*.json`, and policy file:line.
   - `--offline` recomputes only the offline parts. It runs as a step in `refresh-norfolk.yml` (after :16) and in the archive PR job (`archive-case-sources.yml`), so those parts change in the same commit as their inputs.
8. **`--check`** runs in CI with no network:
   - it recomputes every offline part from current inputs, and every statement from the stored results;
   - it checks that each stored query URL equals what `Socrata.query` builds today against a fake fetch;
   - it fails on any difference.
9. **At render, the Worker filters finding evidence against the bundled `CASES`** (`plugins/case-file.js:10`). A finding marked unverified after the build drops out of the board at once.

### 5.4 Failure and refresh

- **Failure.**
  - A failed measure keeps `last_good`, with the statement "I couldn't measure this on <date>. I show my last measurement, from <date>."
  - A gap left with no verified evidence goes to `evidence_unverified` and stays off the board.
- **Weekly `refresh-gaps.yml`**, using the secret at `refresh-norfolk.yml:18`:
  1. `verify-cases`, read-only (no `--write`). A failure marks that finding unverified for this build.
  2. `build-gaps`.
  3. Numbers-only changes within ±25% commit to main, as `refresh-norfolk.yml:19-26` does.
  4. These open a PR instead, as `archive-case-sources.yml:7-11` does: a state change, a jump beyond ±25%, a failed measure, or evidence turning unverified. The alternative is J8.
- **Concurrency.** `refresh-norfolk.yml` and `refresh-gaps.yml` share one `concurrency:` group.
- **Staleness.** The board marks a measure older than 14 days "due for a re-check".

### 5.5 Finding gaps (Jason's direction 1)

1. **`scripts/find-gaps.js`** profiles the datasets the profile and plugins use, under the §5.2 identifier rule. For each dataset it reports:
   - the null shares of location fields, as `IS NULL` only;
   - how created dates compare with end dates, and dates after the read date;
   - `rowsUpdatedAt` against the stated update frequency;
   - description sentences containing self-limiting phrases ("no official", "not been", "estimate", "pilot", "sample"), quoted whole;
   - the columns against the concepts named in `records_to_request` and `what_would_help`;
   - topic catalog hits that are missing from `topic.datasets`.

   It writes `data/gaps/<city>.candidates.json` with the trace, to a gitignored path. That file is never committed, bundled or served.
2. **Raised questions with no gap** land in the steward's "waiting for a gap" queue. In v1, that is only free text under an answer whose attached gaps the asker unticked (§7.2).
3. **Contributor PRs.** A steward promotes a candidate by PR, with its entry, questions and actions.

---

## 6. Wording and text checks

### 6.1 Statements and consequence lines, rendered with live values (rev 2)

Every string below returned `[]` from `voiceViolations` (cb64aa2) and from rules A to C in `/tmp/claude-0/-home-user/1a06cb6c-e084-57b5-a3f7-072243d3ae4a/scratchpad/gaprev3/check.mjs`.

| Kind | Rendered |
|---|---|
| missing_field (share) | "I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street in the City's Work Orders records (qzfe-wj25), created 2020-08-05 through 2026-10-30, as I read them on 2026-11-06." |
| window line | "Of the 272 with status “Complete” created since 2025-11-06, I found 24 with no street, and 22 of those 24 with no ward or civic league either, as I read them on 2026-11-06." |
| status line | "Of the 353 with status “New Work Order” or “On-Going”, I found 85 with no street, as I read them on 2026-11-06." |
| missing_field (columns, planned date) | "I found no column for a planned or scheduled date among the 32 columns of the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06. Its description of start_date, in its words: “Date the work on the work order began.”" |
| backlog line | "I found 353 Forestry removal work orders with status “New Work Order” or “On-Going” (50 of them with an end date), a median of 941 days since created, as I read them on 2026-11-06." |
| created_on_or_after_end | "Of 360 Forestry removal work orders with status “Complete” and an end date from 2025-11-06 through 2026-11-05, I found 115 (32%) whose end date falls on or before the day the order was created (22 before it, 93 the same day), in the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06." |
| stale | "The City Tree Inventory's own description (cmvv-agyb), as I read it on 2026-11-06, says: “The original inventory of these trees was conducted in the late 1990s/early 2000s by the Norfolk Master Gardeners. No official re-inventory has been conducted since then by City officials or ISA Certified Arborists, however, tree records in this dataset have been and are being updated over time by City Staff.” I found no column dating when each tree's record was surveyed or updated among its 13 data columns, as I read them on 2026-11-06." |
| missing_field (contract link) | "I found no column linking a work order to a contract or invoice among the 32 columns of the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06. I found a contractor cost above zero on 563 of 2,378 of its Forestry removal work orders with status “Complete” (24%), as I read them on 2026-11-06. The City's FY2024 adopted budget says: “The contract is used to remove decaying or diseased trees” (quote checked 2026-11-04)." |
| missing_field (share, size; optional) | "I found 6,918 of 93,997 city trees (7%) with neither a trunk-size range nor a trunk diameter above zero in the City Tree Inventory (cmvv-agyb), leaving out rows labeled “PRIVATE TREES”, as I read it on 2026-11-06. Its description of trunk_diameter, in its words: “The approximate trunk diameter of the tree. Since trees grow over time, the current diameter may be larger than what data shows.”" |
| no_records | "I found 0 datasets in data.norfolk.gov's catalog for the search “line clearance”, and 4 for “Dominion”, all open to Siren: Street Light Outages, Streetlights and Outages Reports, Municipal Building Energy Use, Address Information (searched 2026-11-06). I found 18 problem descriptions on Forestry work orders in the City's Work Orders records (qzfe-wj25), none matching “utility”, “power line”, “line clearance” or “Dominion”, as I read them on 2026-11-06. Dominion Energy's page says: “Nearly all of our neighborhood power lines are cleared on a four year cycle” (quote checked 2026-11-04)." |
| restricted | "I don't query MyNorfolk 311 requests (nbyu-xjez) for open-ended questions. Siren's rule, read from its city profile on 2026-11-06, in its words: “MyNorfolk 311 requests are not available to open-ended queries: some request types point at a single household.”" |
| partial_coverage (index) | "I found no street address in the titles of 681 of 1,437 agenda items (47%) in Siren's agenda index (built 2026-11-02, meetings 2023-07-11 through 2026-10-22), so I can't match them to a block." |
| no_decision_record | "I found no column naming who requested or approved a work order among the 32 columns of the City's Work Orders records (qzfe-wj25), as I read them on 2026-11-06." |
| consequence (part) | "With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street, measured 2026-11-06, so a street search can't find them." |
| consequence (part, condition) | "With the City's Work Orders records (qzfe-wj25) I can answer this only in part: I found problem codes such as “Dead Tree” on 770, “Diseased” on 127 and “Damaged Tree” on 258 Forestry work orders, measured 2026-11-06, and I found no column for condition in the City Tree Inventory (cmvv-agyb)." |
| consequence (all) | "I found no column for a planned or scheduled date in any of the 4 tree datasets I read (cmvv-agyb, qzfe-wj25, jz6u-9g3c, u85v-sad9), measured 2026-11-06, so I can't answer this from them." |
| unmeasured | "I couldn't measure this on 2026-11-13. I show my last measurement, from 2026-11-06." |
| no responsive records (reply) | "The City's reply of <date>, in its words: “<the reply's words>.” Copy hosted by Siren's steward." It is never "I found no". |

**Display rules.**
- Both counts always appear, with a whole-number percentage and no "a quarter".
- Every sentence that holds a number also holds a date (I16): `read`, and `through` for the scope's date field. A read date is never passed off as a data date.
- Statuses are quoted as the City records them (`src/prompt.js:10`).

### 6.2 `gapTextViolations(text, type)` (`src/gaps/kinds.js`)

Quoted spans are stripped first, using the copied `stripQuoted`. Then three rules apply.

- **Rule A, for every type: banned outside quotes.**
  - Absolutes and world claims: `never`, `always`, `no longer`, `has/have not been`, `hasn't/haven't been`, `does/do not exist`, `is/are missing`.
  - Predictions: `will`, `won't`, `going to`, `scheduled to`.
  - Hedges: `may`, `might`, `could`, `likely`, `unlikely`, `probably`, `perhaps`, `possibly`, `suggest(s)`, `appear(s) to`, `seem(s)`.
  - `does/do/did not` and `doesn't/don't/didn't`, unless the subject is "I" or "Siren".
- **Rule B, for statements, consequence lines, absence lines and bot text: a reading frame.**
  - Every sentence that holds a number or the word "no" must contain a frame from this closed list: "I found", "I can't", "I can answer … only in part", "I couldn't", "I don't query", "as I read", "checked", "searched", "measured <date>", "counted by code", "Siren drafted", "through Siren", "Siren's rule". An attributed quote ("says: “…”", "in its words: “…”") also counts.
  - A number is `\b\d[\d,.]*%?` after removing dataset ids (`[a-z0-9]{4}-[a-z0-9]{4}`), ISO dates and times, `FY` years, and names on the allowlist (dataset names from the profile and `describe`, such as "MyNorfolk 311").
  - Every sentence with a number must also hold a date (I16).
- **Rule C, for titles, labels, chips, panel titles and board headers: noun phrases.** No digits outside allowlisted names, and no `is/are/was/were/exist(s)/has/have/had/missing`. Rule A still applies.
- **Steward notes** get `voiceViolations`, `publicTextViolations` and rule A. Digits are allowed only as dates, ids, or numbers equal to a stored measure. Rule B doesn't apply.
- **Model prefills** of a question get rule A. On a hit, the prefill is blanked.
- **Residents' own words and general questions** get rule A only as a `presupposes` hint to the steward (§6.3), never as a block.

The §1.12 sentences and rev 1's contract sentence fail rule A. An undated number fails rule B.

### 6.3 `publicTextViolations(text, { streets })` (`src/public-text.js`)

It runs on residents' questions and source-request notes, steward notes, general questions, action text and bot text. Bot text is checked before its link is appended. It normalizes first: NFKC, curly quotes mapped, format characters and U+00AD stripped.

**Blocks:**

| Code | Pattern |
|---|---|
| `house_number` | 1 to 6 digits, an optional direction, up to 3 words outside a stoplist (of, the, with, no, work, orders, …), then a street suffix. "1500 Bolling Ave" is blocked; "683 of 2,770 work orders" and "I found 60 with no street" pass. |
| `number_street` | 1 to 6 digits, then a name from `<city>-streets.json`, with or without a suffix ("1500 BOLLING") |
| `intersection` | `<street> (and|&|at) <street>` |
| `block_of` | `\bblock of\b` (v1 is citywide) |
| `unit` | `apt`, `unit`, `suite` or `#`, then a number |
| contact details | `email` · `phone` · `mention` (@name) · `link` |
| `long_number` | 7 or more digits, or dash-grouped digits that aren't ISO dates |
| `coordinates` | decimal latitude and longitude pairs |
| `parcel_grain` | `(my|your|their|his|her|this|that) (house|home|parcel|property|lot|yard|driveway|address|apartment)` |
| `person_pointing` | `who (lives|lived|owns|owned|called|complained|reported|filed|asked|applied|requested|put in)`; `whose`; `which (neighbou?r|resident|household|family)` |
| `named_person` | an honorific (Mr, Mrs, Ms, Mx, Dr, Miss) followed by a capitalized word |
| `role_blame` | `why did (the )?<role noun>`, using the role nouns from speculation rule 10 |

**Raise-time only:** `own_place`. Any 1- to 4-word phrase whose keyed hash is in the raise token's place set (§7.2).

**`publicTextFlags`** give the steward hints and never block:
- the people and role nouns from speculation rule 10;
- two capitalized words in a row outside an allowlist (departments, dataset names, the city name);
- `presupposes`, when the text matches a rule A word.

Civic-league names are not on the allowlist, so a league name gets flagged.

**Known false positive:** "Did 3 Colley Avenue trees get removed?" is blocked, and the person rephrases. Text checks catch mistakes, not malice (A7).

### 6.4 Siren's answers when gaps are on

- `worldClaimViolations(answer)` is a rule A subset: the world-claim and prediction words, plus `there (will|may|might|could|would) be`. Hedges are left out, because answers address the reader ("you may").
- It runs with `voiceViolations` inside the existing single rewrite (`src/agent.js:143-157`). When `ctx.gaps` is set, `REWRITE_INSTRUCTION` gains `GAP_REWRITE_ADDENDUM`.
- With gaps off, nothing changes (I14).
- Turning gaps on requires J25 first: `deployments/siren.config.js:20` instructs the exact sentence this check catches.

---

## 7. Consequences: unanswered questions

### 7.1 General questions

- Each entry has 1 to 4 general questions, written in its PR. Each is at most 160 characters, ends in "?" and passes `publicTextViolations`.
- **Laundering check.** A question must share fewer than 3 content words with any `not_yet_verified` claim (`plugins/cases.js:45`).
- **`blocks`.**
  - `blocks` defaults to `part`, with `answered_in_part_by`.
  - `all` needs the topic-wide `columns_absent` of §3.2.
  - The consequence line is code-rendered and scoped to the datasets checked (§6.1).
- **Board heading:** "Questions these records can't answer, or answer only in part".
- General questions are public whenever their gap is. They need no review, because their text comes from code and PRs.

### 7.2 Raising a question

**v1 scope (P8; J29):**
- Picks of an attached gap's general questions.
- Free text only under answers that have at least one gap attached.
- The "Siren didn't answer this" link under every answer waits until a second steward exists.
- Fallback answers (`src/agent.js:113-119`, flagged by a new `fallback` field when gaps are on) and model refusals (:106-109) get no card.

**Steps:**
1. **Code attaches gaps** (§8.1): up to 3 per answer.
2. **The raise token**, minted only into the `/api/ask` HTTP response when `BOARD_RAISE` is on. It's never saved in a conversation or in `answerRecord`.
   - Format: `b64url({g:[attached gap ids], b:[ids the gap bit], p:[place hashes], c:city, e:dayBoundary(now)+1d, n:16 random bytes}) + '.' + HMAC(INVITE_SECRET, 'board-raise:' + payload)`.
   - `p` holds `HMAC(INVITE_SECRET, 'board-place:' + phrase)` for this turn's street name, full street, house number, `ward N`, superward and civic-league name. Core code collects these from `lookupAddress` (`src/block.js:38`, the fields at :88-90) into `ctx.placeWords`, which `ask()` never returns.
   - Every new HMAC is domain-prefixed. Invite cookies sign the bare payload (`worker/invites.js:68-70`); that's safe because b64url payloads never contain ':', and a test asserts it.
3. **The card**, under the answer:
   - "Add your question to the board";
   - the attached gaps' general questions as picks ("Mine is one of these");
   - when the gap allows free text, a text box, blank or prefilled only from a `note_unanswered` draft that passed rule A and `publicTextViolations`, never from the person's own question;
   - "Did this answer it? Not at all / In part", the asker's own report (A10);
   - gap checkboxes limited to the attached set;
   - the notice (§7.3).
   - When the model also called `suggest_data_source`, the source request is an optional section of this same card, so there's one card and one count.
4. **A restricted-refusal turn** (`ctx.attempted`) offers only that gap's general questions as picks. An excluded or denied-column refusal offers no card (P5).
5. **`POST /api/board/questions {token, answered, picks?, text?, gaps}`.** Every check runs before any write:
   1. JSON only (`worker/index.js:459`);
   2. the invite gate, as `handleRequest` checks it (:318-322);
   3. `BOARD_RAISE`;
   4. the token's signature, expiry and city;
   5. `gaps` ⊆ `token.g`, and every pick's gap ⊆ `token.g`;
   6. single use: `board-tok:<nh32>` must not exist;
   7. the visitor cap: at most 5 events under `board-ev:<day>:<vh32>:` (`vh32` = `HMAC(INVITE_SECRET, 'board-visitor:' + day + ':' + ipHash)`), which joins with nothing else;
   8. the site-wide caps: free-text raises under `board-free:<day>:` at most 25 a day, and all raises under the `BOARD_DAILY_RAISES` ceiling (I18). A full queue gets "The board's queue is full today; try again tomorrow." The Rate Limiting breaker `BOARD_SITE_RL` also applies.
   9. text: 10 to 300 characters and at most 700 UTF-8 bytes, control characters stripped, ending in "?", at least 3 letters after normalization, and no `publicTextViolations`, `own_place` included. A refusal says what to change and never echoes the text.
6. **Uniform response.** Every accepted raise returns `{ok:true}`, plus `public_count` only when the target is already public; general questions always are. New and existing items get the same response and the same writes (§14). A raise that pools into a declined or merged item is counted on the steward side only and never reopens it.

### 7.3 Card notice (draft for J24; voice-checked)

> "Questions are public once a steward reviews them, on Siren's board. Write it as a question about the records for the whole city. Leave out streets, house numbers, your address and anyone's name. Siren keeps the question and a count, not who asked. If you asked in a conversation, that conversation still holds what you typed for 7 days unless you forget it."

GitHub and Bluesky aren't named, because neither carries residents' words by default (J18, J19). If Jason allows either, the notice names it.

The signed-in footer (`worker/ui.html:229`) gains, only when `BOARD_RAISE` is on: "Nothing reaches the public board unless you add a question yourself."

### 7.4 Ids, pooling, records and statuses

**Ids** (12 hex characters, unique across types by test):

| Item | Id |
|---|---|
| gap | `sha256('gap\n'+catalogId)` |
| general question | `sha256('q\n'+gapId+'\nc:'+qid)` |
| raised question | **random** at its first raise |
| catalog action | `sha256('act\n'+actionId)` |
| source request | today's `requestKey` hash (`worker/requests.js:20`), unchanged |

**Pooling.**
- Picks pool into the general question.
- Free text pools through `board:qdedupe:<HMAC(INVITE_SECRET, 'board-q:'+city+':'+norm(text))>` → rid. `norm` is NFKC, lowercase, and `[^\p{L}\p{N}]+` → space, so non-Latin text pools correctly.
- The dedupe key expires with the text. Once text is cleared, the same words start a new item.
- The steward merges paraphrases.

**Record** (`board:q:<rid>`; resident text lives apart in `board:qtext:<rid>`):
```
{ v:2, kind:'general'|'raised', city, ref?:'<gap>#<qid>', count, days, no, partly,
  by_gap:{ <gapId>:{code, person, steward} }, first:'YYYY-MM-DD', last:'YYYY-MM-DD',
  status, reason_code?, steward_note?, merged_into?, merged_counts?, answered_by?:[{case, finding}], answered_in_part?, endorsements_at_decision? }
```
KV metadata carries the public summary (status, kind, count, days, no, partly, code-linked gaps, first and last day, and the text once public), so the public snapshot is built from list pages alone.

**Counts.**
- `days` counts distinct days asked; it rises only when today ≠ `last`.
- `by_gap.<id>.code` rises only when the gap's id is in `token.b`, meaning the gap bit that turn (§8.1).
- `person` counts links the asker ticked. `steward` counts links the steward made, which need a reason code.
- Counts are read-modify-write. They're approximate under contention, and that's said, as `requests.js:42-43` says it. A 429 is retried once.
- **Board text:**
  - "Raised 14 times through Siren on 9 days (askers said: not answered 9 · in part 5)."
  - "Questions people linked to this gap." A gap's demand line uses code links only (I15).
- A count means raises, not people (`requests.js:42-43`). Bluesky endorsements are shown separately and never added in.
- **Sort:** distinct days asked, then oldest open.

**Statuses.**
- General questions are public on their first pick.
- Raised questions go `new` → `public` → `answered` (or answered in part), or → `declined` / `merged`.
- `new` items expire unreviewed after 30 days; the text goes with them. The backlog shows an "expired unreviewed" count.

**Never pooled:** fallback answers and refusals; Siren's own bugs (`not_a_gap` sends a steward-written summary to GitHub, never the resident's words); people-finding questions.

---

## 8. Gaps in Siren's answers

### 8.1 Code attaches gaps (no model involved)

**`matchGaps(ctx)` attaches a gap when any `touches` predicate matches this turn:**
- **A trace step:** `{dataset, where_includes}` must match both the step's dataset and its soql. For example, `area = 'Forestry'` keeps `block_report`'s Work Orders query (`src/cities/norfolk.js:155`, which has no area filter) from attaching the Forestry gaps.
- **A tool:** `{tool}`.
- **A case cite:** `{case}`, matched on the cite step URL `/data/cases/<case>.json` (`plugins/cases.js:29-34`).
- **`ctx.attempted`:** a new set that the loop at `src/agent.js:125-139` fills with refusals and tool names. A restricted refusal throws in `describe` before any trace step (`socrata.js:318`), so the trace alone can't show it.

Steps whose touching calls all errored don't count. `Trace.record` keeps them with `ok:false` (`trace.js:21-22`); a raise on such a turn goes to `not_a_gap`.

**`bites_when`** marks the gaps that had a consequence this turn: an absence line fired, a predicate matched the result, or the query filtered on the gap's field (`street =` for no-street). Those ids go into `token.b`.

**Ranking:** gaps that bit, then gaps the model named, then kind order. At most 3 are shown, and the rest appear as "k more on the board". When any gap shows, one cite step goes into the trace: "read the gap catalog: 2 gaps, measured 2026-11-06". It costs no subrequests, because the catalog is bundled.

A test asserts that an answer built only from `block_report` attaches no Forestry gap.

### 8.2 One gated core tool: `note_unanswered`

**Definition.** `toolsFor(city, plugins, { gaps })` adds it after `suggest_data_source` (`src/tools.js:50-57`), only when gap data is passed. Its schema:
- `question`: "a citywide question: no street, block, ward, civic league or landmark, and no names";
- `answered`: `no` or `partly`;
- `gaps`: at most 2, each an enum of catalog ids (A4).

**What `runTool` does:**
1. Throws `Unknown tool note_unanswered` unless `ctx.gaps` is set. Today the default branch throws only for names that match no plugin (`src/tools.js:125-128`), and a core `case` would run whatever the model emits.
2. Allows one call per question.
3. Refuses with `{noted:false}` on an excluded or denied-column refusal this turn. On a restricted refusal it notes only `{answered, gaps}`, with no question text.
4. Accepts named gaps whose touches match any call so far, including the rest of the current batch. After the loop, `ctx.unanswered` is re-filtered against the final `matchGaps`.
5. Clips the question to 300 characters, and blanks it on a rule A or `publicTextViolations` hit.
6. Returns `{noted, statements:[{gap, statement, measured}], general_questions, note}`. The note depends on `BOARD_RAISE`:
   - **on:** "The person sees a card to add an edited version of this question to the public board, if they choose. Say plainly what the records you read couldn't answer, using only the statements above for numbers about the gaps. Don't say the question was added, and don't guess at an answer."
   - **off:** the same note without the first sentence.

### 8.3 The prompt

- `systemPrompt(city, today, opts = {})` takes an options object, shared with the notifications spec's `watches`. With `{}` it's byte-identical.
- With `opts.gaps`, line 20 (`src/prompt.js:20`) is replaced by: "When the records you can reach don't answer the question, or answer it only in part, say so, then call note_unanswered with a citywide version of the question: no street, block, ward, civic league or landmark, and no names. For numbers about a gap, use only the statements it returns. If you know a specific source that would answer it (an ordinance, a plan, a report, a dataset), also call suggest_data_source. Don't guess what that source says."
- None of this goes in `deployments/siren.config.js`, whose text reaches every caller (`src/plugins.js:149`).

### 8.4 The case file

- When gaps are on, `theRecord` gains `what_i_couldnt_answer: [{gap, statement, measured}]` for gaps whose touches name the case. It's capped at 3 short statements.
- Plugins read it through a frozen `ctx.gapStatements(caseId)` on `pluginContext` (`src/plugins.js:91-121`), and `test/conformance.js` allows it.
- `theRecord` for norfolk-trees is already 11,613 characters, against the 16,000-character cut (`src/agent.js:17`, :136). A fixture test asserts that `work_orders_cover` and `about_the_data` survive with gaps on.
- `ask()` returns `gaps`, `unanswered` and `fallback` only when gaps are on (I14).

### 8.5 Worker, UI, CLI and conversations

- **Worker** (`handleAsk`): passes `gaps` only when `deployment.gaps.enabled` (in a PR) and built data exist for the city. It mints the token only when `BOARD_RAISE` is on.
- **UI** (`renderGaps`):
  - It renders after the answer and before `renderSuggestions` (`worker/ui.html:471`).
  - It's a `<details>` block titled "What I couldn't answer from the records I read (k)". It starts open when a gap bit or `note_unanswered` was called.
  - Each item shows the kind label, the statement, "measured <date>" (plus "due for a re-check" when stale), and links to the gap's card on the board.
  - Everything goes through `esc()` (:246), never `md()` (:249).
- **Conversations.**
  - `note_unanswered` args are saved as `{answered, gaps}` only. Today args are saved whole (`worker/conversations.js:37`).
  - On the traces branch, `answerRecord` gains only `gaps:[{gap, statement, measured}]`: no token, no nonce, no draft. A conv-dump test checks it.
  - Gap text is never appended to answers, so `historyFrom` (:49-72) is unchanged.
- **CLI.** `loadDeployment` passes `config.gaps` (`bin/socrata-agent.js:64-70`), and `ask` prints `markdown.gaps` after the answer (:118). The CLI gets no card and no token.

### 8.6 Absence lines (private; Inc 8)

- **One adapter, `trees_on_my_block`.** It writes a line only when `on_your_street` has no error and `by_task_and_reason` has no row whose task is “Removal” (`plugins/trees-on-my-block.js:109-135`). `on_your_street` is never empty: it's an object or `{error}`.
- **Pairing.** The adapter pairs only with a gap whose scope equals its query (Forestry removals).
- **No `block_report` adapter.** Its Work Orders query has no area filter and keeps only the most recent rows (`src/block.js:146-153`), so an empty result says nothing about Forestry removals.
- **Example:** "I found no Forestry work orders with task “Removal” on BOLLING in ward 2 in the City's Work Orders records (qzfe-wj25), created through 2026-11-05, as I read them on 2026-11-06. In Siren's gap catalog, measured 2026-11-06, I found no street on 582 of 2,378 Forestry removal work orders with status “Complete” (24%); a street search can't find those."
- **Privacy.** The street name appears only in the person's own answer, never on the board.

---

## 9. Actions

### 9.1 Kinds

| `kind` | What code produces | Who does it | States shown | What comes back |
|---|---|---|---|---|
| `source_request` | Today's request (`worker/requests.js`), linkable to gaps | a contributor, by PR (`docs/fulfilling-requests.md:14-17`) | open · being worked on · fulfilled (`fulfilled_by`, :90-92, :126) | findings, a plugin, or a profile dataset |
| `foia_draft` | A records-request draft (§9.2) | a resident or civic league sends it | open · sent (day) · reply reported (link) · outcome verified (finding) | findings quoting the reply (§12) |
| `meeting_question` | The question, the gap's statement, upcoming meetings, and how to register | a resident or civic league asks it | open · asked (link) · outcome verified | a finding quoting the minutes |
| `dataset_proposal` | The ask that the City publish a field or dataset, with the gap's evidence | a resident or civic league | open · proposed (link) · outcome verified (profile PR plus re-measure) | a re-measure |
| `watch` | A link into the private watch flow | the person, privately | none | nothing |

**State.**
- "Step taken (link reported)" and "outcome verified (finding `<case>#<id>`)" are separate states. Only the second appears under "What would close it" as done.
- A catalog action's state lives in `board:act-state:<id12>`.
- A source request's gap links live in `board:req-gaps:<id12>`, each with its link code.

**Who writes the text.**
- Action text comes only from catalog PRs, case-file `records_to_request` (used verbatim), and residents' source requests that the steward links to gaps.
- Steward-written actions in KV are J16.
- Meeting questions must ask about records or plans. Case-file `what_would_help` items are advocacy (CONTRIBUTING.md:36-38) and stay out of board action text.

### 9.2 The records-request draft

- **Body.** A `records_to_request` entry, used verbatim.
- **Strikes.** The catalog lists explicit strikes, each `{phrase, column}` and checked by `describe` at build. For example, `{phrase:'priority', column:'priority'}` on `[1]` (:501).
- **Line on every draft:** "Please leave out the names and addresses of residents who made requests."
- **Frame:** "Siren drafted this from public records on <date>. Siren doesn't send requests; you do." This matches `plugins/cases.js:49`.
- **Legal wording** comes only from verified `rules` findings: the four § 2.2-3704 quotes, entered by case-file PR and re-checked by verify-cases. No due dates are computed (A2), and there's no legal advice (`src/prompt.js:31`). Legal review is J15.
- **Recipient.** The "To:" line reads "[the City of Norfolk's FOIA officer: Siren has no verified contact for this yet]" until a contact is verified with a date (P1; CLAUDE.md:15-19). The profile holds only Norfolk Cares and the City Clerk (`norfolk.js:185-188`).
- **Charges** fall on the requester. No payments (CLAUDE.md:73).
- **Duplicates.** While a matching request shows "sent", the card says "Sent on <day> by someone using this board" and puts the draft behind a second click.

### 9.3 Meeting questions

- The builder lists meetings from `dszu-h9cf` at GENERIC. `upcoming_meetings` reads it at CORE, with these fields (`src/tools.js:104-124`, :113).
- At render, the list keeps only meetings dated today or later, with "as listed on <build date>; check the City's calendar" and the iqm2 link (`norfolk.js:191`).
- Hearings can't be picked out by field (A3).
- **Contact:** the City Clerk, "register by 3 p.m. the day of the meeting" (`norfolk.js:187`).

### 9.4 Restricted and excluded datasets

- Restricted gaps carry only actions tagged `aggregate_only`. A test refuses any action text that asks for row-level records, a full CSV, or lifting the rule.
- Excluded datasets never appear (CONTRIBUTING.md:32-35).

### 9.5 Watches

- **The board never stores, lists or counts watches** (notifications R5).
- **Caveats** (notifications §8.3) become a view of `data/gaps/norfolk.json` that follows gap state.
  - The contract caveat becomes the `no-contract-link` statement, which is measured and has no "may".
  - If a caveat's gap goes to `evidence_unverified`, it falls back to a code line with no claim ("I can't tell from these records whether every contracted removal has a work order"), or is dropped. Notifications rule 11 is amended to match (§17).
- **A place-free gap watch** waits for notifications D1 to D3 (J22).

### 9.6 Claims (v1)

- Claims are made on the action's GitHub issue, as today (`docs/fulfilling-requests.md:14-17`).
- The steward records a flag: `claimed: {orgs, others, since}`.
- An organization label appears only after the organization confirms through its own published contact, with the date recorded.
- Leagues appear by name only. `civic_league_president` and `civic_league_email` are denied columns (`norfolk.js:65`).
- A claim with no update in 60 days shows as lapsed.
- Bluesky self-claims are J14.

---

## 10. The board

### 10.1 Routes

| Route | What it does |
|---|---|
| `GET /requests` | The board page, with tabs: Gaps · Questions · Actions · Source requests · Decisions (J2). The footer links it (`worker/ui.html:231`), and the endorse callback returns to it. |
| `GET /api/board` | Public JSON with `Access-Control-Allow-Origin: *`, served from the snapshot (§14) |
| `GET /api/board/log` | The decision log, in days |
| `GET /api/requests` | Kept for the nightly sync (`scripts/sync-request-issues.js:91-94`). It changes only by Inc 1's fixes and the endorse PR's counts, and it shares one cached computation with `/api/board`. |

### 10.2 A gap card

A gap card shows:
- the kind label, title and statement;
- **Where:** sources, scope with status, area, span;
- **How much:** the values with their dates, a year table and the status breakdown;
- **"How this was measured":** the SoQL, the result, and a "run it yourself" link from the stored query URL. The queries are citywide, so the link carries nothing personal.
- quotes, with their checked and re-verified dates;
- the dataset page and exact-query CSV links. The full Work Orders CSV is never linked (I7; J28).
- **"Questions these records can't answer, or answer only in part":** each general question with its consequence line and its counts;
- **"Questions people linked to this gap":** public raised questions, people's words in “…”, with link provenance;
- answers, each rendered as the finding's quote with its selector context and the source and checked date, and the claim labeled "steward's summary";
- **"What would close it":** actions with their states and claims, and how to do each;
- endorsement counts, from code-linked items only (§11.5);
- state history.

### 10.3 What's withheld, and the feeds

**Never returned:**
- items in `new`, `declined` or `merged` status, or their text;
- private notes;
- anything finer than a day;
- watches;
- `evidence_unverified` gaps.

**Backlog stats, shown publicly:** items awaiting review by type, the age of the oldest, median days to decision, decisions by reason code this month, and expired-unreviewed counts.

**GitHub mirror** (`scripts/sync-request-issues.js`):
- one issue per public gap (label `records-gap`) and one per open catalog action;
- code-written text only by default: statements, catalog actions, counts and ids (J18). Residents' words, if Jason allows them, wait 7 or more days after acceptance.
- **Tombstones.** The feeds carry `withdrawn:[{id, kind, day}]`. The sync closes those issues with a fixed body ("Removed from the public board by a steward on <day>."), and the runbook deletes earlier body revisions from the issue's edit history (P8).
- The routine prompt, which lives outside the repo, gains `BOARD_URL` and the tombstone handling.

**Bluesky bot.** None exists (`docs/runs-as-messages.md:113-114`). The PR that adds one must:
- post `botText(gap, demand)` only;
- use a per-kind prefix: "Gap in the records Siren reads:", "Out of Siren's reach by rule:", "Not in the records Siren reads:", "Not found at the pages checked:";
- refuse unless the gap's state is `open` and its measure is at most 14 days old;
- stay at most 300 graphemes, with all checks run before the link is appended;
- never post residents' words (J19);
- run with a daily cap and a kill switch.

Example: "Gap in the records Siren reads: I found 582 of 2,378 Forestry removal work orders with status “Complete” (24%) with no street, measured 2026-11-06. Questions linked to it were raised 14 times through Siren as of 2026-11-20; one person can raise more than once."

---

## 11. Collective governance

### 11.1 Roles

| Role | Who | Identity Siren keeps |
|---|---|---|
| Resident | invite holders (J3) | none |
| Endorser | a Bluesky account | per-item keyed hash only (endorse §1.3) |
| Contributor or claimer | a GitHub user, or a civic league on an issue | their GitHub handle, on GitHub, by their own choice. The board shows confirmed organization labels or a count. |
| Steward | `ADMIN_EMAILS` accounts (`worker/accounts.js:186-196`) | a role label from a `STEWARD_LABELS` secret mapping uid to label, never derived from an email |
| Second reader or reviewer | someone other than the person who wrote or uploaded the thing reviewed (J30) | a role label |

### 11.2 Who can do what

| | Gap | Question | Action |
|---|---|---|---|
| **Raise** | catalog PR | resident, through Siren (§7.2); general questions by PR | catalog PR; residents raise source requests as today |
| **Endorse** | rollup of code-linked items | Bluesky, once per account | Bluesky, once per account |
| **Accept or decline** | PR merge | steward, with a reason code | PR, or the steward for source requests |
| **Claim** | — | — | on the GitHub issue; the steward sets the flag |
| **Fulfil** | `closed_when` met, or a reviewed finding, then the steward confirms by PR | a reviewed finding, then the steward confirms | link reported, then a contributor PR adds findings, then the steward closes |
| **Contest** | facts, settled by a re-measure | an appeal, once a second reviewer exists (§11.6) | the same |

### 11.3 The steward gate

**Reason codes** are required on every decline, merge, redaction, close and gap link: `duplicate` (with target), `already_answered` (with finding), `people_finding`, `private_detail`, `not_about_records`, `not_a_gap`, `out_of_area`, `abusive`, `spam`, `steward_judgment`.

**Notes.**
- Declines and redactions get template notes only, one per code. `steward_judgment` points to the rule in `docs/board-rules.md`.
- Free notes are allowed only on accept, answer and close. They're capped at 300 characters (`requests.js:89`) and pass §6.2's steward-note rules.

**Redaction is deletion.**
- The board shows "[removed by steward]".
- The removed span is kept privately in `board:qred:<rid>` for the 14-day appeal window, then expires.
- The public log carries no character count.
- The steward never adds words, and can't edit code-rendered statements.

**Answers.** `answered_by` takes only finding refs `<case>#<id>` that pass §12's rules. They're checked against the bundled `CASES` (`plugins/case-file.js:10`) both when the steward decides and at render.

### 11.4 The public decision log

- **Storage:** KV `board-log:<ISO second>:<rand8>` → `{at, item, type, decision, reason_code, note?, steward_label}`.
- **What's public:** the feed and the export show days.
  - `item` is the public id for public items.
  - Declined, redacted and merged-away items appear under a random per-entry id, or by type only.
  - Never logged: their text, or anything about askers.
- **Private first.** Entries written before `BOARD_PUBLIC` is on are marked `public:false` and never shown, the way `requests.js:10-12` handles notes.
- **Append-only.** No update or delete path, checked by a grep test.
- **Export.** The weekly Action exports the log to `data/board/log-<city>.jsonl` (J13; A12).

### 11.5 Endorsements are information

- Counts appear as "N Bluesky endorsements". They break ties only (endorse §1.5).
- Board items' counts are recomputed once a day, not every 60 s. On a quiet board, a count that moves soon after a sign-in could otherwise show which item an account endorsed (§17).
- A gap card rolls up endorsements only from items whose link to it is code-measured.
- The rule that declines above E endorsements need a note is dropped until a second steward exists (J21).
- Abuse controls are the endorse spec's: daily caps, per-item clear, and established-account public counts.

### 11.6 Appeals and rule changes

- **Appeals.**
  - Appeals are advertised only once a second reviewer exists (P6). Then: a GitHub issue labeled `board-appeal`, answered within 14 days by someone other than the deciding steward.
  - Until then, the rules page says decisions are final for now and why.
  - A `people_finding` decline can be contested on its facts, never on the principle.
- **Rule changes.** The rules (codes, caps, what's endorsable) live in `docs/board-rules.md`. A change is a PR announced on the board 14 days before it merges, and Jason decides (J23).

### 11.7 Ostrom's principles here

| Principle | Here |
|---|---|
| Boundaries | The resource is the shared record of what the records can and can't answer. People-finding is out of bounds. |
| Congruence | Citywide grain; Virginia FOIA wording from verified findings; Clerk registration |
| Collective choice | Rules change by PR, with notice, and endorsements count as information |
| Monitoring | Weekly re-measure, a public log, backlog stats |
| Graduated responses | (0) a code refusal → (1) a decline with a code → (2) per-item freeze or clear of endorsements → (3) GitHub moderation |
| Conflict resolution | A re-measure for facts, an appeal for judgments, once a second reviewer exists |
| Right to organize | Leagues claim under confirmed names. Forks run their own boards. |
| Nested enterprises | City → deployment → board → case file |

---

## 12. Closing the loop

**Findings point back.** A case-file finding may carry `"board": {"closes": ["<gap id>"], "answers": ["<gap id>#<qid>"]}`.
- Only general questions can be referenced from a case file. Raised questions are marked answered only through the steward's `answered_by`.
- `build-gaps` checks every reference, so verify-cases' checks stay unchanged.

**A finding may answer or close only when all of these hold:**
1. its quote is re-verified in this build, or checked within 30 days;
2. it carries `claim_reviewed: {by, date}` from a second reader, someone other than its `found_by` (J30);
3. the board renders it as its quote, with the claim labeled "steward's summary".

**When things close:**
- A measured gap goes to `closing` when a re-measure meets `closed_when`. `column_present` also needs the new column's null share to be at most the threshold, after which it hands off to a `share` measure.
- A finding-only gap goes to `closing` when a qualifying finding lists it.
- The steward confirms by PR, setting `closed_by: {findings | build, pr}`, and CI requires it.
- A later failure reopens the gap, and the reopening is logged.

**Where outcomes come from:**
- **A records reply.**
  - The claimer reports a link. The steward reviews the reply for personal details (J15).
  - The reply is published where verify-cases can re-fetch it, with `source.hosted_by` ("the City's reply, copy hosted by Siren's steward"), the reply's date, the sending office, and a hash of the original as received, in a public reviewed note.
  - A City-hosted or third-party copy is preferred.
  - A self-hosted reply can answer or close only after a second reviewer.
  - Such sources carry `no_archive: true` until a PR marks them reviewed, so `--archive` never makes a Wayback copy of an unreviewed reply. That's a small verify-cases change.
  - A contributor PR then adds findings quoting it (CONTRIBUTING.md:27-28).
- **"No responsive records" replies and denials** are rendered as the City's attributed words, never as "I found no".
- **Minutes**, quoted from iqm2, with draft minutes flagged.
- **A new dataset** enters the profile by PR, checked live with a date (CLAUDE.md:32-33), and the measure changes.

**Who hears.** Askers and endorsers left no contact, so nobody is notified directly. Outcomes appear on the board, in the log, in the issue closing and in an optional bot post. Gap watches are J22.

---

## 13. Privacy and the non-negotiables

| CLAUDE.md | How this design holds it |
|---|---|
| Voice contract (:10-12) | "I found" templates; rules A to C; `voiceViolations`, plus `worldClaimViolations` with gaps on; residents' words labeled as quotations; `src/voice.js` unchanged |
| The trace is written by code (:13-14) | The builder goes through `Trace.record`. Answers get a code cite step. No model text enters a trace or a statement. |
| Hand-off (:15-19) | Resources registration with a CSV only where no policy applies; on the board, the Work Orders full CSV is never linked; contacts only from the profile; FOIA recipient placeholder |
| No people-finding (:20-31) | <ul><li>Citywide measures at GENERIC, under the positional identifier rule.</li><li>No person columns and no `assigned_crew`.</li><li>Restricted datasets get policy only; excluded datasets never appear; refusal turns are gated.</li><li>No asker identity, random ids, place tokens.</li><li>The no-approver gap is reframed around offices and criteria, and its FOIA text excludes names.</li><li>Replies are redacted before publishing and kept out of the archive until reviewed.</li></ul> |
| Verify against the live portal (:32-33) | `checked_live` per entry, the weekly re-measure, the topic catalog check |
| One runtime dependency (:37-39) | WebCrypto, KV or D1, the Cache API, and Rate Limiting bindings. No package. |
| Conversations never feed the case files (:61) | A grep test that board code never reads `conv:`; tokens never saved |
| No payments (:73) | Charges fall on the requester |
| Unverified findings are labeled (:88) | They never serve as evidence and never answer or close anything |

**Stored:**
- question records with counts and days;
- resident text, in a TTL key;
- dedupe keys, with a TTL;
- redacted spans, kept privately for 14 days;
- action state;
- the log;
- rate events and token markers, expiring at day boundaries;
- gap links for source requests.

**Never stored:** uid, visitor hash in a record, IP, conversation id, DID or handle, email, house number, an unkeyed hash of resident text, or declined text after its TTL (J26).

**Residual.** Rate events hold a day-scoped visitor HMAC. With `INVITE_SECRET` and an IP, someone could tell that an IP raised something that day; they couldn't tell which item. The events expire at the day boundary plus 1 h.

---

## 14. Storage, routes, caps and flags

**Storage depends on the plan (P4; J7).**
- The binding limits are KV operations: on the free plan, 1,000 writes and 1,000 lists a day (A14), plus about 1,000 KV operations per invocation.
- Each ask already lists `spend:` (`worker/limits.js:28-37`) and writes its counter outside any try (`worker/index.js:155`). Once writes run out, every ask fails.
- **On the free plan,** board and endorsement state moves to D1 before `BOARD_PUBLIC`.
- **On the paid plan,** KV with a materialized public snapshot works.

### KV layout (paid plan)

| Key | Value | Expiration |
|---|---|---|
| `board:q:<rid12>` | record; metadata = public summary | none |
| `board:qtext:<rid12>` | resident text | new: 30 d; declined or merged: decision + 30 d; public: none |
| `board:qdedupe:<h32>` | rid | same as its text |
| `board:qred:<rid12>` | redacted span | 14 d |
| `board:act-state:<id12>` · `board:req-gaps:<id12>` | state · links | none |
| `board:public:<city>` | public snapshot, rebuilt on each decision and at most every 15 min, lazily | none |
| `board-log:<ISO>:<rand8>` | decision | none |
| `board-ev:<day>:<vh32>:<uuid>` · `board-free:<day>:<uuid>` | `''` | day boundary + 1 h |
| `board-tok:<nh32>` | `'1'` | the day boundary after the token's expiry |

- No new key starts with `request:` (endorse §7). Rate events are one key per event. Item counts are read-modify-write and approximate (§7.4).
- **Writes:** 4 for a pick (event, token, record, and the site counter), 6 for free text (plus text and dedupe). Free text into an existing item does the same writes, with the expirations unchanged. A decision takes 2 to 4 writes.
- `BOARD_DAILY_RAISES` defaults to 50, which keeps board writes near 300 a day at most. Past the ceiling, the board closes for the day; `/api/ask` is never touched.
- **Snapshot rebuild:** 4 to 6 list pages. Its lists stay about 400 a day or fewer, globally.
- **A fake-KV test** counts the operations for 1,000 items on the snapshot path and the admin path. The admin path uses bulk get in chunks of 100.

### Routes

| Access | Routes |
|---|---|
| Public | `GET /requests` · `/api/board` · `/api/board/log` · `/api/requests` |
| Invite holders | `POST /api/board/questions` |
| Bluesky session | endorse routes, with a generalized lookup (§17) |
| Steward (under `handleAdmin`, `worker/index.js:330-342`) | `GET /api/admin/board` · `POST /api/admin/board/decide` · `POST /api/admin/board/action-state` · `POST /api/admin/requests/note` (Inc 1) |

Every POST is JSON-only (`worker/index.js:459`) with `Cache-Control: no-store`. `scripts/invites.js` gains `board`, `board-decide`, `board-log` and `request-note`.

### Caps

- 5 raises per visitor per day, and 1 POST per answer.
- 25 free-text raises a day site-wide, and `BOARD_DAILY_RAISES` in all.
- 3 gaps per answer.
- Question text 10 to 300 characters (at most 700 bytes).
- Steward notes up to 300 characters.
- The feed pages after 500 items.

### Flags

- `deployment.gaps.enabled` (in a PR) → `gaps.absenceLines` → `BOARD_RAISE` → `BOARD_PUBLIC`.
- With all four off, the app is byte-identical to the merge base after Inc 1.

---

## 15. Tests

All run under `node --test` with fakes (fake KV, fake fetch, fake Rate Limiting, fake clock). CI makes no network calls.

1. **Catalog.**
   - Schema; unknown keys fail; ids unique; retired ids are never reused; every entry has `checked_live`.
   - The topic covers its catalog hits, or lists them in `not_in_topic`. `blocks:'all'` has topic-wide `columns_absent`.
   - Siblings are listed and cleared.
   - Every SoQL passes `checkSingleDataset` (`socrata.js:82-88`) and the positional identifier rule, tested both ways with the §4.4 queries.
   - No restricted dataset appears in a query; no excluded one appears at all. Restricted gaps carry only `aggregate_only` actions.
2. **Builder.**
   - Every request runs at GENERIC and lands in the trace. Resources drop the full CSV where a policy applies.
   - The exact median, including the OFFSET path. A gap whose text fails is isolated from the others.
   - Deterministic output with no `ms`.
   - `--check` equality, and `--offline` against drifting inputs.
   - The refresh split, as a dry run.
3. **Text.**
   - Every template, label, title, chip, header, unmeasured line, FOIA frame, absence line and bot string, rendered with large and small fixtures, returns `[]` from all applicable checks, `publicTextViolations` included.
   - The §1.12 sentences, rev 1's contract sentence and an undated number all fail.
   - The copied `stripQuoted` and `normalize` match their originals on a shared corpus.
   - The `publicTextViolations` examples hold both ways.
   - `botText` stays within 300 graphemes and refuses stale or non-open gaps.
4. **Agent, gaps off.** `toolsFor`, `systemPrompt`, `theRecord` and `ask()` output are byte-identical, and an injected `note_unanswered` throws.
5. **Agent, gaps on.**
   - Touch predicates hold: a `block_report`-only answer attaches no Forestry gap. `ctx.attempted` works.
   - `bites_when` sets `token.b`.
   - Errored steps don't attach gaps.
   - Named gaps are checked against the batch and re-filtered after the loop.
   - A house-number or "will" draft is blanked.
   - A refusal turn is gated.
   - The cite step appears. Scrubbed args hold no question.
   - The world-claim rewrite fires.
   - The 16,000-character fixture holds.
6. **Raise.**
   - Refused: forged, expired or cross-city tokens; gaps or picks outside the token; reuse; a missing "?"; every block code, `own_place` included; the caps; the ceiling.
   - Uniform responses for new, public, declined and merged targets (probing tests modeled on endorse's).
   - Every write happens after every check.
   - KV dump: no visitor hash, IP, uid, conversation id or sub-day time in any `board:` value.
   - No log line or key is a SHA-256 of stored text.
   - A conv-dump holds no token, nonce or draft.
7. **Steward.**
   - Non-stewards get 401 or 403.
   - Reason codes are required; declines get template notes only.
   - Redaction's 14-day private copy, then deletion.
   - `answered_by` refuses findings without a claim review, or stale.
   - Log append-only, checked by grep. The pre-public entries stay private.
8. **Public view.**
   - Only public items appear, and dates are days only.
   - `esc()` everywhere, and `marked` is never called on the board (grep).
   - `/api/requests` deep-equals the merge base except for Inc 1's changes.
   - Tombstones close issues.
9. **Loop.**
   - Unknown refs fail. Raised ids are refused in case files.
   - `closing` comes only from `closed_when` or a qualifying finding. `closed_by` is required. Reopening is logged.
   - A self-hosted reply needs a second reviewer.
10. **Greps.** Board code never reads `conv:`, never imports a watch module, and never writes `data/` outside the builder and the log export.

---

## 16. Today's request list: fixes that come first (Inc 1)

These make the live code match promises it already makes. They need no flag and change no promise.

1. **Notes are reviewed whatever the request's status.**
   - New notes store `review: 'pending'` and a day, not a millisecond.
   - `publicView` shows only notes with `public && review === 'ok'`.
   - Legacy notes, with no `review` field, count as reviewed only when `at <= decided`. Later ones are pending.
   - The steward approves or deletes each note from the admin page or the CLI. `allRequests` already lists notes with their times (`requests.js:109`).
2. **`publicView` emits `first` and `last` as days**, and new writes store days. `requests.html:55` already shows 10 characters, and the sync doesn't read these fields (`sync-request-issues.js:38-59`).
3. **`POST /api/requests` returns `{ok:true}`,** plus `count` only when the request is public. `ui.html:306` shows the count only when it's given.
4. **Withdrawals reach GitHub.**
   - `/api/requests` carries `withdrawn:[{id, day}]` for requests that were public (a `was_public` flag set at acceptance) and no longer are.
   - The sync closes those issues with a fixed body.
   - In direct-apply mode, the sync also closes any labeled issue whose marker is in neither list.
5. **In Inc 2, once `src/public-text.js` exists,** `need` passes `publicTextViolations` at write time. A refusal says what to change and never echoes the text.

---

## 17. Fit with the notifications and endorse specs

**Notifications spec:**
- `watch` is a pointer action, and the board never reads watches (R5).
- Its caveats file becomes a view of the gap build that follows gap state (§9.5), which settles its D15.
- Its rule 11 is amended: an unverified finding drops its caveat to a claim-free code line.
- Its §2 promise drops "logged the same day as the work or after it" for the `created_on_or_after_end` statement (its D8).
- Its contract caveat ("may not appear") becomes the `no-contract-link` statement.
- Its D16 is J17 here. A gap watch depends on its D1 to D3.
- `systemPrompt`'s options object is shared: `{watches, gaps}`.

**Endorse spec, amendments for Inc 13:**
- `endorse()` looks items up in the public snapshot: public questions, open catalog actions and accepted source requests. Today it looks in `publicList.requests` (§8.1).
- `forgetEndorser` computes keys for every public board item and every retired id from the built file. Today it lists only `request:` (§8.3). A retired item's endorsement keys are cleared when it retires.
- `freezeAtDecision` also covers answered, declined and merged questions, and done or withdrawn actions (§8.5).
- **Merges.** The live count goes into the target's `merged_counts`, and the keys are deleted. The label says one account may be counted twice.
- Board items' public counts are recomputed daily.
- Recommended copy amendment for the endorse spec itself (:641): "On a quiet day, when you signed in and a count that changed soon after could show which item you endorsed."
- **Unchanged:** keys, cookies, the OAuth flow, the limits, the `/requests` callback, and §1.6 (a Bluesky sign-in grants only endorsing).

---

## 18. Conflicts resolved

Rev 1's C1 to C24 stand, except for these changes:
- **C3:** touches are predicates, and `bites_when` is new.
- **C5:** the token is single-use per answer, carries place hashes and expires at a day boundary.
- **C9:** claims need organization confirmation.
- **C12:** gap rollups come only from code-linked items.
- **C14:** `no_records` adds the problem-code values check and raw catalog counts.
- **C16:** status “Complete” for removal measures, with the breakdown.
- **C17:** counts carry link provenance and distinct days.
- **C20:** redaction keeps a 14-day private copy for appeals.
- **C24:** both description sentences are quoted.

New in rev 2:
- **C25:** contract work becomes a missing column, not partial coverage.
- **C26:** notice gets its own entry.
- **C27:** trunk size moves to `not_a_gap`.
- **C28:** the request-list fixes ship before any board code.
- **C29:** on the free plan, D1 is needed before going public.

---

## 19. Assumptions

- **A1** GitHub Actions can reach data.norfolk.gov using `SOCRATA_APP_TOKEN`.
- **A2** Due dates aren't computed.
- **A3** No field in `dszu-h9cf` marks budget hearings.
- **A4** Anthropic accepts `enum` and `maxItems` in `input_schema`.
- **A5** The endorse PR ships as rev 2 describes.
- **A6** Catalog counts are stable enough to cite with their date.
- **A7** Text checks catch mistakes, not malice.
- **A8** The GPIN format is unknown, so `long_number` stays generic.
- **A9** The board stays under about 1,000 items.
- **A10** "Not at all" and "in part" are the asker's own report, and are labeled that way.
- **A11** Steward timestamps don't identify askers.
- **A12** Repo history is an adequate durable audit trail.
- **A13** Socrata's floating timestamps on these datasets are Norfolk local time.
- **A14** The KV free plan also caps list operations at 1,000 a day.
- **A15** GitHub lets a user with write access delete earlier revisions from an issue body's edit history (P8).
- **A16** `mrv3-rcpc` STORM has to be placed in or out of the tree topic by a reviewer.
- **A17** The nightly routine applies plan entries by marker, including closing a tombstoned issue, without a prompt change beyond `BOARD_URL`.

---

## 20. Open decisions (Jason only), with defaults

The numbering follows rev 1. J28 to J31 are new, and P4 to P6 are facts only Jason has. Options and recommendations are in the structured list.

- **J1** The v1 catalog: 13 entries, the trunk-size entry optional.
- **J2** The board's name and URL: `/requests`.
- **J3** Who raises questions: invite holders.
- **J4** Count wording: "asked N times through Siren", required on all three surfaces in Inc 12.
- **J5** Place on questions: citywide.
- **J6** Gaps in answers. This waits for J25.
- **J7** Storage, decided by P4.
- **J8** Refresh: the split in §5.4.
- **J9** Steward and steward label.
- **J10** Appeals: once P6 exists.
- **J11** Reason codes in the log: yes, source-request decisions included.
- **J12** Redaction: deletion plus a 14-day private copy.
- **J13** What's endorsable, and the log export.
- **J14** Claims.
- **J15** Records-request drafts: legal review and how replies are hosted.
- **J16** Meetings, and steward-written actions.
- **J17** Dominion wording.
- **J18** GitHub mirror: code-written text only.
- **J19** The bot: code-written text only.
- **J20** A raise token on `POST /api/requests`.
- **J21** The endorsement threshold E: none until a second steward.
- **J22** Gap watches.
- **J23** Rule changes in `docs/board-rules.md`.
- **J24** Final copy.
- **J25** Replace `siren.config.js:20` and `trees-on-my-block.js:180`.
- **J26** Retention.
- **J27** Absence lines.
- **J28 (new)** Add `assigned_crew` to qzfe-wj25's `deniedColumns`. That drops the full Work Orders CSV everywhere and changes `test/privacy.test.js:179` and :188.
- **J29 (new)** The v1 free-text scope and its caps.
- **J30 (new)** The second-reader rule.
- **J31 (new)** Endorse copy and daily counts.

---

## 21. Build path

There are 17 increments, Inc 0 to Inc 16, each its own branch and PR, listed in the structured output. socrata-agent is outside the `claude/` merge authority, so every PR needs Jason's review.

- **The spine:** 1 → 2 → 3 → 4 → 7 → 10 → 11 → 12.
- **Buildable now,** with flags default-off and no change to a promise or to stored data: 0, 1, 2, 3, 5, 7, 8 and 9.
- **Bluesky endorsements plug into Inc 13.** It generalizes the endorse PR's lookup, forget, freeze and counts from source requests to every public board item. The endorse PR itself lands first against the Source requests list, which Inc 12 turns into the board's Source requests tab.
- **Size:** about 6,500 to 7,500 lines over 13 to 15 sessions, plus Phase 0. Inc 10 and Inc 11 are split, because raising and steward review together were the largest piece.