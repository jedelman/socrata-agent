# CLAUDE.md — socrata-agent

Civic tech: an agent that answers "what's on my block, and who decided it?"
from a city's Socrata open data portal and public meeting records. Norfolk, VA
is the full implementation; Seattle, Chicago, and any Socrata domain run in
generic mode.

## Non-negotiables

- **Voice contract.** The agent says "I found" / "I see", never "there is" /
  "there are" / "nobody" / "no one". `src/voice.js` enforces it; don't weaken
  the check to make an answer pass.
- **The trace is written by code.** Every outbound request goes through
  `Trace.record` (`src/trace.js`). Never let model output become the trace.
- **Hand-off.** Every dataset touched is registered in `Resources` with page,
  the exact-query CSV, API docs, and the full CSV only when no policy applies
  (restricted, withheld columns or suppressed rows drop it). Contacts come from
  the address dataset or from city pages verified on a stated date. Never
  invent a contact.
- **No people-finding.** Enforced in code by `src/socrata.js` access levels
  (generic for the open-ended tools, plugin, core) and each city profile's
  policy: `excluded` (never queried), `restricted` (plugins and core only, no
  full-table CSV), `deniedColumns` (no select, filter, group, sort or SEARCH
  outside core; `SELECT *` and `DISTINCT *` skip them; `PERSON_COLUMNS` adds
  person-named columns in every dataset; a result carrying one is refused)
  and `suppressedRows` (dropped in a first stage Siren writes, NULL-safe).
  The SoQL scanner refuses double quotes, comments, pipes and set operators;
  filtered views are refused below core; profiles are deep-frozen and Socrata
  snapshots the policy. Don't add tools that search people by name, in core
  or in plugins, and don't pass `access: 'core'` from anything a model or
  plugin controls. See CONTRIBUTING.md and docs/capabilities-norfolk.md.
- **Verify against the live portal.** Dataset ids, field names and status codes
  in a city profile must be checked live, with the date noted in a comment.

## Layout

- `src/` runs unchanged in Node and Cloudflare Workers. One runtime
  dependency, by Jason's choice (2026-11-02): the official `@anthropic-ai/sdk`,
  used only by `providers/anthropic.js`. Add no others without asking.
  - `agent.js` is the provider-neutral tool loop; `providers/anthropic.js`
    serves `claude-*` models through the Messages API (pinned to
    api.anthropic.com; prices in its `PRICES` table; a model with no price is
    refused) and `providers/openrouter.js` serves everything else; `tools.js` holds tool schemas and
    executors; `block.js` is the block report and legislation matching;
    `socrata.js` is the SODA client; `adapters/iqm2.js` parses Norfolk's
    meeting portal; `cities/` holds the profiles.
- `src/plugins.js` defines plugin tools and deployment configs. Plugins get a
  traced context (`ctx.socrata`, `ctx.http`, `ctx.lookupAddress`), never a raw
  fetch; `test/conformance.js` enforces it. Configs can add but not remove
  exclusions.
- `plugins/` holds plugin tools; `deployments/` holds configs (the sponge-city
  example is the reference).
- `worker/access.js` verifies Cloudflare Access JWTs for per-person limits.
  Never trust the plain email header.
- `bin/socrata-agent.js` is the CLI (`ask` with your own key; `tool` with no key).
- `worker/` is the Cloudflare chat app (`index.js` plus `ui.html`).
  `invites.js` holds invite codes and the waitlist; `accounts.js` holds email
  sign-in by magic link (Resend), which binds an invite to an account;
  `conversations.js` holds each account's conversations (KV, 7 days), whose
  earlier tool results come back as data for follow-ups. Conversations are
  private to their account and never feed the case files.
  `requests.js` pools source requests: when the records can't answer, the
  core `suggest_data_source` tool names the source that would, and the person
  can request it (no asker identity kept; export with
  `node scripts/invites.js requests`). `plugins/case-file.js` serves a case
  file for questions with no address.
- `.claude/skills/socrata-agent/` is the Claude Code skill.
- `data/norfolk-legislation.json` is built by
  `scripts/build-norfolk-legislation.js` and refreshed weekly by an Action.
- `data/cases/*.json` are case files: research done once and served to every
  question through a plugin's `the_record` (`plugins/cases.js`). Each finding
  has a source URL and an exact quote; `npm run verify:cases` re-fetches every
  source (pdftotext for PDFs) and fails on a missing quote, and `--write`
  stamps the date. A finding without a checked quote is served only as
  "not yet verified". Never add a finding you haven't opened the source for.
- `data/norfolk-sponge-screen.json` and `docs/sponge-screen-norfolk.md` are
  built by `scripts/build-sponge-screen.js`; the JSON keeps the full trace.
  It only ever carries public owners' names (city, NRHA, EDA).

## Checks before pushing

```bash
npm test
node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null
```

Model comparisons (`scripts/compare-models.js`) spend real money; keep them
small and commit their output to `eval/`.
