# Documents

Norfolk's ordinances and adopted budget books, from the PDFs the City
publishes, split into sections so Siren can quote them with their section and
page. Ordinances are split into numbered sections (`plugins/ordinances.js`,
tool `ordinance_lookup`). Budget books are split by department and the
subheadings each department repeats (`plugins/budget-books.js`, tool
`budget_book_lookup`). Both tools share `plugins/document-lookup.js`.

### Ordinances

| File | Document | Current through | Source |
|---|---|---|---|
| `norfolk-zoning-ordinance.json` | Zoning Ordinance (adopted January 23, 2018) | updated October 13, 2026 | [norfolk.gov](https://norfolk.gov/DocumentCenter/View/35581/Adopted-Zoning-Ordinance), fetched 2026-11-04 |

### Budget books

The "Department Budgets" part of each adopted budget document: each
department's mission or overview, its budget actions and the reasons the City
gave, its expenditure and position summaries, and its performance measures.
These are plans as adopted, not records of spending. Each file's
`identified_by` says how it was confirmed to be the adopted book.

| File | Fiscal year | Part of the book | PDF pages (printed) | Source |
|---|---|---|---|---|
| `norfolk-budget-fy2027-departments.json` | FY 2027, adopted | 09 Department Budgets | 272 (125–396) | [norfolk.gov](https://www.norfolk.gov/DocumentCenter/View/114013/09-Department-Budgets), listed on [2027 Budget Document](https://www.norfolk.gov/6732/2027-Budget-Document), fetched 2026-11-06 |
| `norfolk-budget-fy2026-departments.json` | FY 2026, adopted | 09 Department Budgets | 236 (145–380) | [norfolk.gov](https://www.norfolk.gov/DocumentCenter/View/102264/09-Department-Budgets), listed on [2026 Budget Document](https://www.norfolk.gov/6498/2026-Budget-Document), fetched 2026-11-06 |
| `norfolk-budget-fy2025-departments.json` | FY 2025, adopted | 08 Department Budgets | 240 (137–376) | [norfolk.gov](https://www.norfolk.gov/DocumentCenter/View/88686/08-Department-Budgets), listed on [2025 Budget Document](https://www.norfolk.gov/5997/2025-Budget-Document), fetched 2026-11-06 |
| `norfolk-budget-fy2024-departments.json` | FY 2024, adopted | 10 Department Budgets | 504 (167–668) | [norfolk.gov](https://www.norfolk.gov/DocumentCenter/View/78214/10-Department-Budgets), listed on [2024 Budget Document](https://www.norfolk.gov/5572/2024-Budget-Document), fetched 2026-11-06 |

Sections are numbered in book order: a department is "42", its subheadings
"42.1", "42.2", .... FY 2024 also splits departments into programs, so a
subheading there is "39.2.1" (department 39, program 2). Each section carries
its department, service area and, in FY 2024, its program. `page_labels`
gives the page number printed on each PDF page, so an answer can cite both.

Each file records:

- **What the text is:** title, who enacted it, jurisdiction (an Open Civic
  Data division ID), and "current through", read off the PDF's cover. Text
  amended after that date isn't in the file. A budget book records its fiscal
  year, whether it is adopted or proposed, the book and part it comes from,
  the City page that lists it, and how that was confirmed.
- **Where it came from:** the official URL, when it was retrieved and by whom,
  and the [DASL CID](https://dasl.ing/cid.html) of the exact PDF bytes. Anyone
  holding a copy can check it's the same one: the same bytes give the same CID.
- **How it was read:** the extractor (`pdftotext -layout`, with its version)
  and the section rule.

The PDF is the authority. Siren links each section to its page in the City's
PDF (`#page=N`) so a reader can check the quote there.

## Adding or updating a document

Run the ingest wherever the PDF is. The text is a small fraction of the PDF:
the 18 MB zoning PDF becomes 1.6 MB of JSON.

```bash
# needs pdftotext: brew install poppler, or apt install poppler-utils

# the City's own copy, fetched: the URL is the provenance
npm run ingest -- --fetch https://norfolk.gov/DocumentCenter/View/35581/Adopted-Zoning-Ordinance \
  --id norfolk-zoning-ordinance --title "Zoning Ordinance" \
  --enacted "Norfolk City Council, adopted January 23, 2018" \
  --current-through "updated October 13, 2026 (the PDF's cover)"

# a copy you already have: say where it came from with --url, and who you are
npm run ingest -- ~/Downloads/norfolk-code.pdf \
  --url <the page you downloaded it from> \
  --id norfolk-city-code --title "Norfolk City Code" --enacted "Norfolk City Council" \
  --current-through "<the supplement or date on the PDF's cover>" --supplied-by "<your name>" \
  --sections pages --out data/documents/private/norfolk-city-code.json
```

- `--sections decimal` (the default) fits documents numbered like the zoning
  ordinance ("5.6.1.") with a table of contents. `--sections pages` makes one
  chunk per page and works for any PDF. `--sections budget` (the default with
  `--kind budget-book`) fits Norfolk's Department Budgets PDFs, FY 2024 on. A
  document with another numbering (the City Code's "Sec. 45-1.") gets its own
  rule once someone has looked at its text.
- A PDF with no text layer (a scan) is refused: it needs OCR first
  (`ocrmypdf`).
- When the City posts a new version, run the same command again. A new CID
  means new bytes, and git keeps the old version.

## Adding a budget book

Find the part on the City's budget page for that year
([Budget Documents](https://www.norfolk.gov/908/Budget-Documents) lists them)
and open its first pages before you ingest it: say what it is from what the
page and the PDF say, not from the file name.

```bash
npm run ingest -- --fetch https://www.norfolk.gov/DocumentCenter/View/114013/09-Department-Budgets \
  --kind budget-book --id norfolk-budget-fy2027-departments --title "Department Budgets" \
  --fiscal-year 2027 --status adopted --book "Adopted FY 2027 Budget Document" \
  --part "09 Department Budgets" --listed-on https://www.norfolk.gov/6732/2027-Budget-Document \
  --identified-by "Checked <date>: <how the City's page lists it, and what its pages say>"
```

Then add the file to `plugins/budget-books.js` and to the table above, and
check the split: every section's title and first lines should be on the PDF
page the JSON gives (`pdftotext -layout -f N -l N <pdf> -`). The budget split
reads the department from each page's footer ("City Auditor - 127"), so a
book laid out differently needs its own rule or `--sections pages`. Look for
personal names before committing: the FY 2024 to 2027 books list positions
by title, not staff by name.

## Public and private

Enacted law is public. A publisher's copy can still come with terms of use,
so a document from anywhere but the City's own site goes to
`data/documents/private/`, which git ignores, until someone has checked that
it can be republished. Nothing in `private/` is served.
