# Contributing

Thanks for building on this. Forks can do anything; this file is about what
comes back into the shared project, and what the shared web app runs.

## What upstream takes

- **City profiles and fixes**, with every dataset id, field name and status code
  checked against the live portal and the date noted.
- **Plugins** that pass `test/conformance.js` and come with an offline test.
- **Adapters** for meeting systems (a Legistar adapter would unlock "who
  decided" for many cities).
- Bug fixes with a test that fails before the fix.

## What upstream won't take

- **Anything that finds people.** No tools that search or profile individuals by
  name: no voter files, no warrant or arrest lookups, no "who lives here."
  Warrants and arrests stay excluded. This is the one line that doesn't move,
  whatever a deployment's purpose.
- **Persuasion inside the answer.** The answer reports what the records show. A
  group's own framing belongs in its deployment notes or its own UI, labeled as
  its own, never mixed into the record.
- **Weakening the contract.** Changes that let model output become the trace,
  loosen the voice check to make an answer pass, or hand plugins a raw `fetch`.
- Contacts nobody can source. Every contact comes from a dataset or a page
  verified on a stated date.

## Before you open a PR

```bash
npm test
node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null
```

Model comparisons (`scripts/compare-models.js`) cost real money. Keep them small,
and commit the output to `eval/`.
