# socrata-agent

Ask your city's open data two questions: **what's on my block, and who decided it?**

It reads a city's Socrata open data portal and its public meeting records, and
answers in plain language. Every answer comes with:

- **the trace**: every query it ran, in order, with row counts and a link to rerun it,
- **the data**: each dataset it touched, as a dataset page, a full CSV download,
  the exact rows it used as CSV, and the API docs,
- **the people**: your council members, civic league, state and federal
  representatives, and the city's service line.

When the agent reaches the edge of what it can do, those links are where you
pick up.

## How it talks

The agent reports what its queries returned, never what is true on the ground.
It says **"I found 2 open work orders"**, never "there are 2 open work orders".
An empty result reads "I found no complaints for this parcel", because a query
that finds nothing is not proof that nothing exists.

Code enforces this, not the prompt alone. After each answer, a check looks for
"there is / there are / nobody / no one". If it finds any, the model rewrites
the answer once. If it still fails, the answer is flagged.

The trace is written by code as each request runs. The model never writes it, so
it can't make one up.

## Three ways to use it

### 1. The web app (for everyone)

A Cloudflare Worker serving a chat page. One shared model key, with limits per
visitor and per day. See [Deploy](#deploy-the-web-app).

### 2. The CLI (bring your own key)

```bash
export OPENROUTER_API_KEY=sk-or-...          # https://openrouter.ai/keys
npx -y github:jedelman/socrata-agent ask "What's on my block? 810 Union St"
npx -y github:jedelman/socrata-agent ask "How many pothole complaints did Chicago get in the last 30 days?" --city chicago
```

Or clone it and run `node bin/socrata-agent.js ask "..."`. Add `--json` for
machine-readable output, or `--model anthropic/claude-sonnet-5.5` for a stronger
model.

`tool` runs a single tool with no model and no key, and prints the result, the
trace and the resources as JSON:

```bash
node bin/socrata-agent.js tool block_report '{"address":"111 Pennsylvania Ave"}'
node bin/socrata-agent.js tool get_legislation '{"legislation_id":"5832"}'
node bin/socrata-agent.js tools --city norfolk     # list tools
```

### 3. The Claude Code skill

Open this repo in Claude Code and the skill in `.claude/skills/socrata-agent/`
loads automatically: Claude becomes the agent, drives `socrata-agent tool`, and
follows the same contract. To use it in other projects, copy that folder to
`~/.claude/skills/`. It calls the CLI through `npx`, so no clone is needed.

## Cities

| City | Portal | What works |
|---|---|---|
| Norfolk, VA | data.norfolk.gov | Everything: block report, contacts, legislation and roll-call votes, upcoming meetings, any dataset |
| Seattle, WA | data.seattle.gov (API at cos-data.seattle.gov) | Search, describe and query any dataset, with download links |
| Chicago, IL | data.cityofchicago.org | Search, describe and query any dataset, with download links |
| Any other Socrata city | `--city data.example.gov` | Same as Seattle and Chicago |

Adding the block report and "who decided" for another city means writing a
city profile, not code. See [docs/adding-a-city.md](docs/adding-a-city.md).

## What it covers in Norfolk, and what it doesn't

**Block report** (`block_report`), all checked against the live portal:

- The address resolves through *Address Information* (`ere7-kake`) to a parcel id
  (GPIN), ward and superward, civic league, precinct, schools, trash day, and
  every representative with their contact details.
- Matched by parcel: Permits, Plan Reviews, Complaints, Violations, Code
  Enforcement Cases, Inspections.
- Matched by street: Work Orders, on the same street in the same ward. This
  dataset has no house numbers, so "your street" is as close as it gets. Open
  work orders are fetched on their own, so an old open order isn't buried under
  recent closed ones.
- Matched by hundred block: right-of-way permits and closures.
- Agenda items that name the address or another address on its hundred block.

**Who decided it** (`get_legislation`) reads the city's iqm2 record for each
item: status, the department that brought it, and every body that voted, with
the result and names for ayes, nays, abstentions and absences. Records from
draft minutes are flagged.

**Known limits:**

- The legislation index (`data/norfolk-legislation.json`) covers agenda items
  with a legislative record from meetings listed in the Public Meeting Notices
  dataset. That dataset starts in July 2023, and in practice the index holds
  City Council and Planning Commission items. Board of Zoning Appeals and
  Architectural Review Board agendas don't publish linked records, so they
  aren't matched yet.
- Agenda items are matched by the street address written in their title.
  Citywide ordinances, budgets, and items that name only a business won't match
  an address. `find_legislation` searches titles by keyword.
- Decisions made inside a department (a permit issued, a complaint closed) are
  not votes. The agent names the department on the record, which is not always
  the person who decided.
- *Plan Reviews* contains test rows (for example "1234 Gwaltney Way", GPIN
  `12345678`).
- Police warrants and arrest reports are **excluded**, as is any dataset whose
  name suggests records searchable by personal name. The agent will not look
  people up.

## Make it your group's own

A campaign or nonprofit can run its own copy with its own tools, focus and model
budget, then send what works back upstream. Two pieces:

- **A deployment config** in `deployments/` adds plugins, contacts, links,
  exclusions and focus notes. It can't remove exclusions or switch off the
  trace or the voice check.
- **Plugin tools** in `plugins/` get a traced context and never a raw `fetch`.
  `test/conformance.js` checks them before they are merged.

The worked example is a Norfolk sponge-city deployment. Its plugin,
`water_on_my_block`, returns, for any address:

- the FEMA flood zone at the parcel and the evacuation zone;
- flood insurance claims in the census tract, by cause (rain versus tide);
- stormwater inspections and work orders in the civic league;
- tree removals versus plantings;
- the nearest tide gauge that is still reporting.

```bash
node bin/socrata-agent.js ask "Does my block flood?" --config deployments/sponge-city-norfolk.config.js
```

The deployment also carries a city-wide **sponge-city screen**: where rain
gardens, bioswales and trees would do the most good. It ranks city-owned vacant
lots by recorded flooding, rain-caused flood claims, tree loss and income, then
checks the top candidates on five things: flood zone, storm surge, soils, nearby
drains, and existing stormwater projects. Bioswale candidates are ranked by
street. Read the [report](docs/sponge-screen-norfolk.md); rebuild it with
`node scripts/build-sponge-screen.js` (about 680 traced queries). The
`sponge_site_screen` plugin serves the results to the agent.

For groups, the web app can sit behind Cloudflare Access, which counts limits
per verified person. The Worker checks the signed token; it never trusts the
email header. See [docs/extending.md](docs/extending.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Siren

The public deployment is **Siren**, at
[jason-edelman.org/ask-siren](https://jason-edelman.org/ask-siren/). The name
does three jobs: Norfolk is the Mermaid City; the greater siren is a salamander
of Virginia's coastal-plain swamps; and a siren is an alarm. Its config is
`deployments/siren.config.js`, and `[env.siren]` in `wrangler.toml` routes the
path. A Worker route runs before the site's Custom Domain, so only
`/ask-siren` reaches this Worker; the rest of the site is untouched.

```bash
npx wrangler kv namespace create LIMITS --env siren   # paste the id into [[env.siren.kv_namespaces]]
npx wrangler secret put OPENROUTER_API_KEY --env siren
npx wrangler secret put IP_SALT --env siren
npx wrangler deploy --env siren
```

## Deploy the web app

```bash
npm install
npx wrangler kv namespace create LIMITS      # paste the id into wrangler.toml and uncomment the block
npx wrangler secret put OPENROUTER_API_KEY   # use a dedicated key with its own credit limit
npx wrangler secret put IP_SALT              # any random string
npx wrangler deploy
```

Limits, set in `wrangler.toml`:

| Setting | Default | What it does |
|---|---|---|
| `PER_IP_DAILY` | 20 | Questions per visitor per day. IPs are hashed with `IP_SALT` and never stored raw. |
| `DAILY_BUDGET_USD` | 2 | Model spend per day across all visitors, read from OpenRouter's reported cost |
| `MAX_STEPS` / `MAX_TOKENS` | 6 / 1200 | Tool rounds and answer length per question |
| `MODEL` | `openai/gpt-5.6-luna` | The model everyone shares |
| `CITIES` | `norfolk,seattle,chicago` | Cities offered in the picker |

Without the KV binding the Worker refuses questions rather than run unlimited.
KV counts are eventually consistent, so a burst can overshoot by a few
requests: give the OpenRouter key its own credit limit as the hard ceiling.

For local development, put `ALLOW_UNLIMITED=true` and your key in `.dev.vars`,
then run `npm run dev`.

## Cost

These are from `scripts/compare-models.js` on 2026-10-06: four questions per
model (an address report, a "who decided" question, an address that doesn't
exist, and a Chicago count). Raw output is in `eval/`.

| Model | Cost per answer | Notes |
|---|---|---|
| `openai/gpt-5.6-luna` (default) | $0.0002–0.003 | Accurate on all four; terse |
| `deepseek/deepseek-v4.1-flash` | $0.001–0.006 | Thorough, but repeats queries; needed one voice rewrite |
| `google/gemini-3.8-flash` | $0.009–0.024 | Good; needed one voice rewrite |
| `anthropic/claude-sonnet-5.5` | $0.02–0.065 | Most careful about what it didn't check; slowest |

At the default model, the $2 daily budget covers several hundred questions.

## Keeping Norfolk's index fresh

```bash
npm run build:norfolk     # about 5 minutes; rebuilds data/norfolk-legislation.json
```

A weekly GitHub Action does this and commits the result.

## Develop

```bash
npm test                   # offline: parsers, voice check, limits, a full agent turn against fakes
node scripts/compare-models.js openai/gpt-5.6-luna anthropic/claude-sonnet-5.5
```

No runtime dependencies. The same `src/` runs in Node and in Cloudflare Workers.

## License

MIT
