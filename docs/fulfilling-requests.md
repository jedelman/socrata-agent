# Fulfilling a source request

When the agent can't answer a question from the records it reaches, it names
the source that would, and people can ask for it. A steward reviews each
request; accepted ones appear on the public list (`/ask-siren/requests` for
Siren) and, after the nightly sync, as GitHub issues labeled
[`source-request`](https://github.com/jedelman/socrata-agent/issues?q=label%3Asource-request).

To fulfill one is to teach the agent that source, in a pull request that
anyone can check.

## 1. Pick a request

Any open `source-request` issue. Bluesky endorsements on the public list
show demand from established accounts; use them to pick one if you like.
Say in the issue that you're working on it,
so effort isn't duplicated, but nobody holds a request exclusively: the first
pull request that passes review fulfills it. Work on what you choose; nobody
assigns it.

## 2. Choose the form

- **Findings for a case file** (`data/cases/`), for documents: ordinances,
  plans, audits, budgets, reports. Each finding is one claim, the source's
  title and URL, the exact quote that supports it, a stance (`confirms`,
  `weakens`, `context`, `who_decides` or `rules`), and `found_by`. Claim no
  more than the quote supports. Findings that weaken a case are as welcome as
  ones that confirm it.
- **A plugin** (`plugins/`), for data the agent should query live. Plugins get
  a traced context and nothing else; see `docs/extending.md`, and pass
  `test/conformance.js` (`checkPlugin` and `checkPluginFile`) with an offline
  test.
- **A dataset in a city profile** (`src/cities/`), checked against the live
  portal, with the date in a comment.

`found_by` is your name or handle. If an agent did the work, say so and name
the person who ran it: "Claude agent run by @handle". Credit follows the
finding wherever it goes.

## 3. Run the checks

```bash
npm test
npm run verify:cases -- --write   # re-fetches every source; a missing quote fails; records evidence and selectors
node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null
```

In the pull request, say how you checked the source (opened it, on what date)
and paste the verifier's output for your findings.

## 4. Review

Three layers, and all three must pass:

1. **The mechanical gate.** CI runs the tests, the bundle, and (for case
   files) the quote verifier.
2. **Adversarial review.** A reviewer, human or agent, tries to break the
   change: a quote that doesn't say what the claim says, a claim that goes
   past its quote, an outdated or unofficial source passed off as current, a
   plugin that reaches personal data or skips the trace. Reviewers report
   what they tried, not just what failed.
3. **The steward accepts it**, citing the rule if not.

Nobody reviews their own work, and that includes a second agent run by the
same person.

## What isn't accepted

- Anything that finds or profiles people (see CONTRIBUTING.md: this line
  doesn't move).
- Findings from a source you haven't opened yourself.
- Summaries without a quote, or quotes of a paywalled source at length.
- Sources that can't be re-checked by someone else.

## Licenses and money

Findings are licensed CC BY 4.0 (credit to `found_by`); code is MIT.

There is no payment yet. When bounties come, they will be paid through a
fiscal host on a public ledger, on merge, for work that survives review. The
plan is in the project's notes; nothing here commits anyone to it.
