# Extending socrata-agent for your group

A campaign, a civic league or a nonprofit can run its own copy with its own
focus, its own tools and its own model budget, without forking the core. When
something you build turns out to be useful to everyone, it comes back upstream.

The worked example is a Norfolk "sponge city" deployment:
[`deployments/sponge-city-norfolk.config.js`](../deployments/sponge-city-norfolk.config.js)
plus its plugin, [`plugins/water-on-my-block.js`](../plugins/water-on-my-block.js).

## 1. A deployment config

```js
// deployments/our-group.config.js
import waterOnMyBlock from '../plugins/water-on-my-block.js';

export default {
  name: 'Our group',
  city: 'norfolk',
  model: 'anthropic/claude-sonnet-5.5',      // optional; the operator pays for it
  plugins: [waterOnMyBlock],
  prompt: 'People here care about drainage and trees.',
  contacts: [{ role: 'Our organizer', name: '...', email: '...' }],
  links: [{ title: 'Our campaign page', url: 'https://...' }],
  excluded: [],                               // more datasets to keep out (optional)
};
```

Run it locally with your own key:

```bash
OPENROUTER_API_KEY=... node bin/socrata-agent.js ask "Does my street flood?" --config deployments/our-group.config.js
node bin/socrata-agent.js tool water_on_my_block '{"address":"111 Pennsylvania Ave"}' --config deployments/our-group.config.js
```

For the web app, add your file to `deployments/index.js` and set the Worker's
`DEPLOYMENT` var to its name (see `[env.siren]` in `wrangler.toml` for a full
example, including serving under a path on an existing site with `BASE_PATH`).
A deployment's `city` takes precedence over the `CITIES` setting.

**What a config can do:** add tools, contacts, links and exclusions, and give
the agent focus notes. Notes go into the prompt *after* the rules, marked as
the operator's, with the instruction that they never override them.

**What it can't do:** remove a city's exclusions, replace a core tool, skip the
trace, or switch off the voice check. All of those live in core and run after
your code.

## 2. A plugin tool

```js
import { definePlugin } from '../src/plugins.js';

export default definePlugin({
  name: 'my_tool',                     // snake_case
  cities: ['norfolk'],                 // optional; omit for every city
  description: 'What it answers, so the model knows when to call it.',
  parameters: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'], additionalProperties: false },
  async run(ctx, { address }) {
    const found = await ctx.lookupAddress(address);              // core address lookup
    const rows = await ctx.socrata.query('abcd-1234', 'SELECT ...', { tool: 'what this query is', name: 'Dataset Name' });
    const other = await ctx.http.json('https://other.gov/api?...', { tool: 'what this request is' });
    return { /* plain JSON for the model */ };
  },
});
```

What `run` gets:

| | |
|---|---|
| `ctx.socrata` | The traced Socrata client. Queries land in the trace and the dataset lands in the resources list, with its CSV links. |
| `ctx.http.json / .text` | Traced HTTPS requests to anything else (FEMA, a state API). |
| `ctx.lookupAddress(address)` | The city's address lookup: parcel, ward, civic league, coordinates, tract, contacts. |
| `ctx.resources` | Add links and records for the operator (`addLink`, `addRecord`). |
| `ctx.city` | The city profile, with your config applied. |

It does **not** get a raw `fetch`. JavaScript can't truly sandbox a plugin, so
this is enforced by review: the conformance test fails any plugin that calls
`fetch` itself.

Write plugins the way core is written:

- Return what the records say, and say what each number is matched on ("this
  parcel", "this census tract", "this civic league").
- Put caveats in the result (`note`) so the model passes them on. For example,
  FEMA claims are anonymized to the census tract, and a tide gauge can go quiet.
- When a source fails, return `{ error }` for that part and keep going.
- Verify every dataset id and field name live, and note the date in a comment.

## 3. Access control

The web app counts limits per visitor (hashed IP) by default. For a group, put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of the Worker: free for up to 50 users, with sign-in by a one-time
code sent to an email address. Then set:

```toml
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD = "<application audience tag>"
PER_USER_DAILY = "40"
```

With these set, the Worker refuses any request without a valid Access token,
and counts limits per person by verified email. It checks the signed token
(`Cf-Access-Jwt-Assertion`) against your team's public keys. It never trusts
the plain email header, which anyone can send.

The daily dollar budget (`DAILY_BUDGET_USD`) still applies across everyone.
Give the OpenRouter key its own credit limit too.

## 4. Sending it back upstream

1. Run the conformance check in a test (see `test/plugins.test.js`):

   ```js
   import { checkPlugin } from '../test/conformance.js';
   await checkPlugin(myPlugin, { city, args: { address: '...' }, respond: (url) => fakeBody });
   ```

   It fails if the plugin calls `fetch` itself, if any request is missing from
   the trace, if a Socrata dataset it queried is missing from the resources, or
   if the result isn't plain JSON.
2. Open a PR with the plugin, its test, and a line in the README.
3. City profile fixes (a corrected field name, a new parcel-keyed dataset) are
   the most valuable contributions and the easiest to review.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for what upstream will and won't take.
