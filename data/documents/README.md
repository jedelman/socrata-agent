# Documents

Norfolk's ordinances, from the PDFs the City publishes, split into numbered
sections so Siren can find a rule and quote it with its section and page
(`plugins/ordinances.js`, tool `ordinance_lookup`).

| File | Document | Current through | Source |
|---|---|---|---|
| `norfolk-zoning-ordinance.json` | Zoning Ordinance (adopted January 23, 2018) | updated October 13, 2026 | [norfolk.gov](https://norfolk.gov/DocumentCenter/View/35581/Adopted-Zoning-Ordinance), fetched 2026-11-04 |

Each file records:

- **What the text is:** title, who enacted it, jurisdiction (an Open Civic
  Data division ID), and "current through", read off the PDF's cover. Text
  amended after that date isn't in the file.
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
  chunk per page and works for any PDF. A document with another numbering
  (the City Code's "Sec. 45-1.") gets its own rule once someone has looked at
  its text.
- A PDF with no text layer (a scan) is refused: it needs OCR first
  (`ocrmypdf`).
- When the City posts a new version, run the same command again. A new CID
  means new bytes, and git keeps the old version.

## Public and private

Enacted law is public. A publisher's copy can still come with terms of use,
so a document from anywhere but the City's own site goes to
`data/documents/private/`, which git ignores, until someone has checked that
it can be republished. Nothing in `private/` is served.
