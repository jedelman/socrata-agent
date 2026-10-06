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
  full CSV, the exact-query CSV, and API docs. Contacts come from the address
  dataset or from city pages verified on a stated date. Never invent a contact.
- **No people-finding.** Warrants and arrests are excluded per city, and
  name-pattern exclusions apply everywhere. Don't add tools that search people
  by name, in core or in plugins. See CONTRIBUTING.md.
- **Verify against the live portal.** Dataset ids, field names and status codes
  in a city profile must be checked live, with the date noted in a comment.

## Layout

- `src/` runs unchanged in Node and Cloudflare Workers. No runtime dependencies.
  - `agent.js` is the OpenRouter loop; `tools.js` holds tool schemas and
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
- `.claude/skills/socrata-agent/` is the Claude Code skill.
- `data/norfolk-legislation.json` is built by
  `scripts/build-norfolk-legislation.js` and refreshed weekly by an Action.

## Checks before pushing

```bash
npm test
node bin/socrata-agent.js tool block_report '{"address":"810 Union St"}' > /dev/null
```

Model comparisons (`scripts/compare-models.js`) spend real money; keep them
small and commit their output to `eval/`.
