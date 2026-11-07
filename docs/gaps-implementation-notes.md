# Gap board: where the code differs from the spec

`docs/gaps.md` is the spec as approved (rev 2), unchanged except for file:line
references. The code differs from it in the places below, each found in review.
Each one is for Jason to accept into the spec, or to send back.

## From the first review (proposed as rev 2.1)

1. **Ward columns (§5.2).** Places below the ward (`civic_league*`,
   `neighborhood*`, `precinct*`, superwards, planning districts, maintenance
   zones, census blocks, zip codes, Socrata computed regions) follow the
   location rule. A ward column may only be tested for null, or name a count
   (`AS ward`), until a check enforces I17's small-count rule.
2. **The street list (§5.2).** It comes only from Address Information's
   `street_name`, with one GROUP BY on that field. Work Orders' free-text
   `street` field isn't read, because it holds house addresses and corners as
   typed. Values with a leading number other than an ordinal, or with `,`,
   `&`, `;`, ` AND ` or ` AT `, are refused.
3. **Public-text checks on code-written text (§5.3 item 4).** The §6.3 checks
   also run on each gap's statement, short, title and consequence lines, so
   the builder and `botText` agree. Three drafts were reworded to pass them:
   "no column naming a requester or approver", "with an end date on or before
   the day they were created" and "Norfolk's open data catalog".
4. **Offline dates (§5.3 item 7).** Parts computed from repo files are dated
   the day they're recomputed (`rebuilt` in the file and the trace). Live
   parts keep the date they were read. A gap measured only from repo files
   carries that date as `measured`.
5. **A16.** `mrv3-rcpc` STORM is placed outside the tree topic. The builder
   reads STORM's description in each build and quotes both sentences the
   placement rests on, "damaged trees" included. Jason approved the catalog,
   its entries and placements, on 2026-11-06.

## From the second review

6. **Where `--check` runs (§5.3 item 8).** `npm test` gates the Workers
   Builds deploy, so its replay test skips, naming the fix, when the committed
   files trail their inputs. Tests that read the gap file's values build it
   from the stored responses and a pinned copy of the case files
   (`test/fixtures/gaps-cases/`), dated the day of the stored build; against
   the committed file they check only what holds in any state the spec
   allows (every catalog entry accounted for, the schema, the identifier
   rule), so a steward marking a finding unverified can't fail them.
7. **No workflow runs the gap build (§5.3 item 7, §5.4).** The spec puts
   `--offline` in `refresh-norfolk.yml` and the archive job, and adds a
   weekly `refresh-gaps.yml`. None of these are in this branch: whether to
   automate the gap build is Jason's call. Until then it's run by hand;
   CONTRIBUTING.md says when, and lists the proposed automation.
8. **Street checks in any case (§6.3).** `number_street` and `intersection`
   match street names in any case. After a house number, a tree species
   counts as a street only with a suffix, an ordinary word only where the
   phrase ends ("1500 Church"), and other names unless a counted noun follows
   ("300 Granby residents"). At a corner, one side must carry a suffix, or be
   a name that isn't an ordinary word, species or ordinal. A 19xx or 20xx
   number is never called a year by the word before it: before a suffix or a
   street name of more than one word it's a house number ("from 1950 Granby
   St", "the 2024 Ocean View report"). Before a bare one-word name it's a
   year mid-phrase ("The 2025 Norfolk budget") and an address after "at" or
   at the end of a phrase ("from 1950 Colley?"). "street trees" and "street lights" aren't suffixes.
   Comma-grouped numbers ("2,770", "$1,250,000") are neither house numbers
   nor long numbers. A house number may carry a unit letter ("1500B",
   "1500-B").
9. **Concept patterns (§4.1).** The planned-date and notice measures use the
   spec's broad patterns (`plan|sched|due|target`, plus `projected`;
   `notice|notif|post`, plus `hanger`). `qzfe-wj25.planning_district` is
   cleared from the planned pattern as a place, not a date, for Jason's
   review.
10. **Touches.** The legislation gap attaches to `block_report` only when
    its value holds `legislation`, so an address miss attaches nothing.
    `note_unanswered` returns statements for gaps that a call so far, or a
    query still to run, touches. A plugin tool still to run isn't enough,
    because it may miss the address. After the loop, the refusal rules apply
    across the whole turn, whatever order the calls ran in.

## From the third review

11. **Errored calls (§8.1).** A step recorded during a tool call that threw
    doesn't count, even when the step itself succeeded (Socrata's "check
    dataset name" read before a failed query). Only steps that ran a query
    or a describe match a dataset predicate.
12. **The identifier rule's select list (§5.2).** A measure needs an
    explicit SELECT list, with a star only inside `count(*)`. A column whose
    Socrata type is location, point, multipoint, line, multiline, polygon or
    multipolygon (or that has no type) is a location column whatever its
    name, read from the dataset's metadata before the query runs.
