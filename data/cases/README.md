# Case files

Research done once, checked against its sources, and served to every
question Siren answers (see `plugins/cases.js`).

Each finding is one claim with its source URL, the exact quote that supports
it, a stance (`confirms`, `weakens`, `context`, `who_decides`, `rules`), who
found it (`found_by`), and the date the quote was last checked (`checked`).

A case file's top-level `reviewed` date says when someone last looked for new
developments on its topic, and `pending` lists what is reported but not yet
confirmed in an official record, sources not yet read, and open questions.
Sources are documents people can read (the City's pages and PDFs, Council
legislation, state code, news), never a Socrata API or dataset URL. A name
quoted in a news article may be quoted, attributed to the outlet (Jason,
2026-11-11); from any other source, never name a private person. The plugin
context refuses Socrata URLs, and `test/plugins.test.js` fails on one. A scheduled
Claude Code routine compiles new case files and updates existing ones, one
draft pull request at a time (`docs/case-file-routine.md`); open an issue
labeled `case-file` with a question to ask for one.

Durable findings. When the verifier writes (`--write`), each passing finding
also records:
- `checked_via`: whether the live page or an archived snapshot proved the quote;
- `evidence`: the [DASL CID](https://dasl.ing/cid.html) and size of the exact
  bytes read, so anyone can tell whether a copy is the one we checked;
- `selector`: a W3C Web Annotation `TextQuoteSelector` (the quote with the text
  just before and after it);
- `source.archive`: a Wayback Machine snapshot whose copy holds the quote (with
  `--archive`; GitHub Actions does this monthly and opens a PR).

If the live page later changes, vanishes or blocks the verifier, the snapshot
proves the quote instead, and Siren says the finding stands on the archived
copy. A finding about something *absent* is only ever checked live.

Every case file is also served as W3C Web Annotations (JSON-LD) at
`<base>/api/cases/<id>` (Siren: `https://ask-siren.jason-edelman.org/api/cases`).
`npm run verify:cases` re-fetches every source and fails if a quote is gone,
and a weekly GitHub Action runs it. A source that refuses the machine running
it (some sites block data-center IPs) only warns while its quote was verified
within the last 30 days; after that it fails too. To add a finding, see CONTRIBUTING.md.

## License

The findings in these files are licensed under the
[Creative Commons Attribution 4.0 International license (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
Reuse them anywhere. Credit whoever found each finding: its `found_by` field,
and "Siren case files" with a link to this folder. The quotes belong to their
sources and are cited, not relicensed. The code in this repository is MIT
(see LICENSE).
