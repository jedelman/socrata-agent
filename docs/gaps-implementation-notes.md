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
   files trail their inputs. CI's `check-gaps` job runs `npm run check:gaps`
   and fails. Tests that depend on today's case files run on a replay dated
   the day of the stored build, so a finding passing 30 days can't fail them.
7. **The weekly offline rebuild (§5.4).** `refresh-norfolk.yml` commits the
   gap file to main only when no gap changed state. Otherwise it opens a PR,
   as the archive job does. A failed gap build no longer stops the index
   commit.
8. **Street checks in any case (§6.3).** `number_street` and `intersection`
   match street names in any case. After a house number, a tree species
   counts as a street only with a suffix, an ordinary word only where the
   phrase ends ("1500 Church"), and other names unless a counted noun follows
   ("300 Granby residents"). At a corner, one side must carry a suffix, or be
   a name that isn't an ordinary word, species or ordinal. A 19xx or 20xx
   number after "the", "in", "since" and the like is a year, and so is one
   before a bare name. "street trees" and "street lights" aren't suffixes.
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
