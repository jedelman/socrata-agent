# Case files

Research done once, checked against its sources, and served to every
question Siren answers (see `plugins/cases.js`).

Each finding is one claim with its source URL, the exact quote that supports
it, a stance (`confirms`, `weakens`, `context`, `who_decides`), who found it
(`found_by`), and the date the quote was last checked (`checked`).
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
