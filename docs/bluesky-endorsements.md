# Bluesky endorsements on the public request list

The public list of source requests (`/ask-siren/requests` for Siren) can be
endorsed by anyone with a Bluesky account. An endorsement says "I want this
source added too". It helps the steward choose what to add next. It is not a
vote.

The feature is off until `BLUESKY_LOGIN = "true"` is set. With it off, the
list behaves as it did before (the page and `/admin` only gain anti-framing
headers), and Siren makes no call to the endorsement database at all.
Endorsements live in a D1 database bound as `SIREN_DB`
([Setting up the database](#setting-up-the-database)); with the flag on and
no database bound, every Bluesky route answers 503 and the log says why, and
the admin page refuses declines and fulfils (503) until the database is
bound.

## What an endorsement is, and isn't

- **A signal for the steward, not a vote.** The public list still sorts by how
  many people asked. Endorsements only break ties.
- **Counted per account, not per person.** One person can hold many accounts,
  so the page says "endorsements", never "people".
- **Only accepted requests can be endorsed**, once per account, and an
  endorsement can be withdrawn at any time.
- **By default the public number counts established accounts only**: did:plc
  accounts at least `ENDORSE_YOUNG_DAYS` (30) days old. did:web accounts have
  no creation date, so they count as "unknown age". The steward sees every
  endorsement, split into young and unknown age. `ENDORSE_PUBLIC=all` counts
  every endorsement publicly. An endorsement made while an account was young
  (or while its creation date couldn't be looked up) is rewritten as
  established once the account is old enough: the next time that account
  loads the requests page, or endorses the same request again.
- **A Bluesky sign-in grants endorsing and nothing else.** It doesn't let anyone
  ask Siren, skip the invite, or touch an email account.

## What Siren keeps, and for how long

| What | Where | How long |
|---|---|---|
| Per endorsement, one row: `HMAC(INVITE_SECRET, request + account)`, the request's public id, one flag (young, established or unknown age) and its expiry | D1 `endorsements` | Until the request is decided (rows written around the decision are swept within minutes, where the public list is computed), and in any case until the start of the month 12 to 13 months after it was made (`ENDORSE_RETENTION_MONTHS`) |
| Per request with endorsements: the count, and how many are young or of unknown age | D1 `endorsement_counts`, kept by triggers | As long as the request has endorsements |
| Rate counters: one row per day and keyed hash, holding a number. The hashes are of the account (day-scoped), the network address, and for servers not in `ENDORSE_OPEN_ISSUERS` the account's server and its domain (day-scoped). None names a request or holds any part of an endorsement id, so a withdrawal leaves nothing request-specific behind. Signing in writes nothing to D1 | D1 `bsky_rate_counts` | Expire about a day after they're made; deleted by the next daily cleanup, so within about a day and a half (longer only while the day's upkeep budget is spent; see below) |
| Siren's daily D1 budget: per UTC day and pot (`visitor`, `upkeep`, `list`), how many calls and rows written were charged. No hash, request or visitor | D1 `siren_d1_budget` | Expires an hour after its day ends; deleted by the next daily cleanup |
| The pending sign-in (state, PKCE verifier, DPoP key, nonce, the account and its server) | A sealed cookie in your browser, scoped to `/ask-siren/oauth/` | 10 minutes |
| Your sign-in (a keyed id for your account, your handle, its creation day, its server) | A sealed browser-session cookie, scoped to `/ask-siren/api/bsky/` | Until you close the browser, and at most 24 hours |

Nothing else, and nothing Bluesky in KV. The database never holds a DID, a
handle, a token, an authorization server, a pending sign-in, or the
account's creation day. Your sealed session cookie also carries, once known,
the ids of the listed requests you've endorsed, so the page needn't ask the
database again during the session. The keyed id for your account
(`HMAC(INVITE_SECRET, "endorser:" + DID)`) lives only inside your sealed
cookie, and each endorsement id mixes in the request, so one account's
endorsements on different requests have nothing in common. Every table is
`WITHOUT ROWID`, so none keeps an insertion order that could pair rows
written together, and every row of one kind and period shares one expiry. (A
history of the database can still pair rows written at the same moment; see
the threat model.) A plain hash of the DID would not do: every did:plc DID
can be listed from plc.directory.

"Until" means the row is deleted. An expired endorsement is never reported
to its endorser and can be made again; the public number reads the per-request
tallies, so it includes an expired endorsement until the cleanup deletes it
(subtracting expired rows on every count would read each of them every time).
A daily cron (`17 7 * * *` UTC, `scheduled` in `worker/index.js`) does the
deleting whether or not anyone visits, which is what the promises on the
requests page rest on, so the rollout turns it on with the flag. Nothing else
purges: not the public list, not the admin page, not a person's own action.
Each round deletes at most 200 rows of each kind, and the cron repeats it
(at most 12 rounds). Every round is charged first to the day's upkeep budget
(see "Siren's worst case on the account's D1"); when that's spent, the rest
waits for the next day. A month's cohort of endorsements, which share one
expiry, can be large: at most about 480 endorsements a day fit the upkeep
budget, so a cohort of a few thousand takes several days to go, still counted
publicly meanwhile. With the flag off the Worker makes no D1 call, so none of
this runs; the steward keeps the promise with
`node scripts/invites.js endorsements-purge` (see "Turning the flag off").

Neither a login start nor the callback makes any D1 call: their limits are
the Rate Limiting bindings below, and the callback keeps no single-use marker
(see "The flow, in short" for why it doesn't need one). Only the signed-in
routes and the public list touch D1, every call behind a limiter that runs
first, and every write charged to a daily budget before it happens, so nobody
can spend D1 rows without first completing a Bluesky sign-in, and nobody can
spend more than the budget.

D1 keeps a restorable history of the database (Time Travel): 7 days on the
Workers Free plan, 30 on Paid ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
checked 2026-11-06). A deleted row stays recoverable from that history, by
someone with access to the Cloudflare account, for up to 7 more days. That
history also pairs rows written in one transaction: restoring the moment
before and after an endorsement shows its row together with the counters it
bumped, which ties the request to that day's account hash, the network
address hash (which anyone holding `IP_SALT`, the same operator, can reverse
for IPv4 by trying every address), and for servers not in
`ENDORSE_OPEN_ISSUERS` the server and domain hashes. (The day's budget row
moves at the same moment, by an amount that says whether the server was an
open one, which the counters already show.) The requests page says both:
deleted entries are recoverable, and the history can show the network and
server an endorsement came from.

When a request is decided (fulfilled or declined), its count is frozen into
the request's decision (`endorsements_at_decision`, kept in the
`request-decision:` key that raises never write, and in the record) and the
per-account rows are deleted. Rows that slip past
that delete (written by a location still serving the old list) are swept the
next time the public list (`/api/requests`) or the admin page is computed:
one statement per sweep (one D1 query, however many requests are orphaned),
at most 100 rows and 99 requests, so they last minutes (a large brigade over
a few sweeps). Each sweep and each clear is charged to the day's upkeep
budget first; when it's spent, they wait. The endorse, unendorse and `me`
routes never sweep orphans, so a person's own action never carries a sweep's
writes. A fulfilled request shows its frozen number; a reopened one starts
again from live endorsements.

The sign-in tokens are revoked (refresh token, then access token) and thrown
away inside the callback. They are never stored, logged, or sent to the
browser. Siren asks only for the `atproto` scope: no permission to post or
read anything.

## Who learns what

- **The public and the steward** see counts. The steward also sees the young
  and unknown-age split, and the count at decision.
- **The operator**, who holds `INVITE_SECRET`, could work out which accounts
  endorsed each request: every did:plc DID can be listed from plc.directory's
  export, and the endorsement key is two HMACs of the DID and the request, so
  running the key over that list against the `endorsements` table names
  every did:plc endorser, offline. Endorsers are pseudonymous to the public and the admin
  page, not to the key holder. The page and the admin note say so. On Siren the
  steward and the key holder are the same person.
- **Your Bluesky server** (your PDS's authorization server) records that you
  authorized the client `https://jason-edelman.org/ask-siren/oauth-client-metadata.json`.
  It doesn't learn what you endorsed. Its consent screen shows that client_id
  URL; servers don't show names or logos for clients they don't trust.
- **plc.directory, your PDS, and your handle's own domain** (for a custom
  handle) receive lookups when you sign in, and a DNS-over-HTTPS resolver
  (`DOH_URL`, Cloudflare's by default) sees the `_atproto` TXT lookup.
- **Logs** get the failure code of a failed sign-in, and the server's host
  only for large open servers (`ENDORSE_OPEN_ISSUERS`), because a self-hosted
  server's host identifies its person. A cancelled sign-in isn't logged at all.
  Nothing is kept in logs (`wrangler.toml` has no `[observability]` block),
  but anyone watching live request logs (`wrangler tail`, or the dashboard's
  real-time logs) sees each request's URL, including the callback's `iss`
  (which can name a self-hosted server) and its one-time `code`.

## The flow, in short

1. `POST /api/bsky/login {account}`. The input is parsed before any limit is
   charged. Then the limits (per visitor, per account typed, and a site-wide
   breaker; Rate Limiting bindings only, no D1 call), all before any outbound
   request. Siren resolves the
   handle itself (DNS over HTTPS and the HTTPS well-known, DNS winning a
   conflict), fetches the DID document, checks the handle both ways, finds the
   PDS, checks its protected-resource metadata (RFC 9728, `resource` must be
   the PDS), and checks the authorization server's metadata. Then PAR
   (RFC 9126) with PKCE S256 and a fresh DPoP key (ES256, RFC 9449). The
   pending flow is sealed (AES-256-GCM, key from HKDF) into an HttpOnly cookie.
2. The browser goes to the server's authorize page and comes back to
   `GET /oauth/callback`. Siren needs exactly one flow cookie that opens and
   hasn't expired, a matching `state`, and `iss` equal to the bound server
   (RFC 9207), before it reads `code`. The token response must be DPoP-bound,
   carry `atproto`, and name the bound DID in `sub`. Then Siren re-resolves
   the account with no cache, and its PDS must still name the same server.
   Both tokens are revoked, and the session cookie is set. The callback makes
   no D1 call. A replay of the same cookie and callback URL needs no
   single-use marker: PKCE and DPoP bind the code to this flow's verifier and
   key, which only the sealed cookie holds; the cookie expires in 10 minutes;
   the authorization server must refuse a code used twice (OAuth 2.1), and
   one that doesn't only re-proves the DID it already proved; and each
   replay is charged to `BSKY_VISITOR_RL` and `BSKY_SITE_RL` before its one
   POST, which goes only to the issuer's own origin. (An earlier version
   wrote a marker to D1 before the token exchange, which let anyone running
   their own identity and authorization server spend D1 writes; written
   after the exchange it would guard nothing.)
3. `GET /api/bsky/me`, `POST /api/bsky/endorse`, `/unendorse`, `/forget` and
   `/logout` read only that session cookie. `me` reads D1 at most once per
   session: the answer goes back into the sealed cookie, and endorse and
   unendorse keep it current, so later loads read the cookie. (Another
   device's session reads D1 once for itself; an endorsement made elsewhere
   shows up there when its session starts again.)

The session cookie never reaches `/api/ask` or the conversation routes, so
your Bluesky identity and your questions never arrive on the same request.

## Limits on who can sign in

- **No non-default ports.** PDSes and authorization servers on a port other than
  443 (for example `:8443`) can't sign in. The spec allows them; refusing them
  keeps Siren's outbound requests on 443.
- **Authorization server endpoints must share the issuer's origin**: the
  authorize, PAR, token and revocation endpoints, each at most 256 characters.
  Siren only POSTs to the host that served the server's metadata. A
  revocation endpoint elsewhere is dropped, and that server gets no revoke.
- Hostnames only: no IP literals, no `localhost`, and none of the TLDs the
  handle spec disallows.

## Configuration

Secrets: none new. `INVITE_SECRET` keys the endorser and endorsement hashes,
the per-account and per-server rate hashes, and the sealed-cookie keys.
`IP_SALT` keys the visitor hashes. Every use is domain-separated.

| Var | Default | Meaning |
|---|---|---|
| `PUBLIC_ORIGIN` | unset (feature off) | The origin the client_id and redirect_uri are built from, never the Host header. `https://host` with no port or path; or, in local dev only, `http://127.0.0.1:<port>` |
| `BLUESKY_LOGIN` | unset | `"true"` turns on login, callback, endorse, unendorse, forget, logout and the signed-in part of `me` |
| `ENDORSE_PER_DID_DAILY` | 30 | Endorse and unendorse actions per account per day (repeats are free, except that two endorses of the same request landing at the same instant can both be charged; the count stays right) |
| `ENDORSE_PER_VISITOR_DAILY` | 200 | The same, per hashed visitor |
| `ENDORSE_PER_ISSUER_DAILY` | 20 | New endorsements per day from each server (issuer host) not in `ENDORSE_OPEN_ISSUERS`. A withdraw and a re-endorse count again |
| `ENDORSE_PER_DOMAIN_DAILY` | 60 | The same, for all such servers under one registrable domain together: the last two labels, or three under a listed multi-label suffix (`co.uk`, `com.au`, and shared hosting such as `github.io` or `fly.dev`, whose tenants are unrelated). So `a1.abc.dev`, `a2.abc.dev` and a wildcard farm under one domain share 60 a day, while `pds1.github.io` and `pds2.github.io` don't share anything |
| `ENDORSE_OPEN_ISSUERS` | `https://bsky.social` | Comma-separated server origins exempt from that cap. Add large community servers here, since everyone on one shares its 20 a day |
| `ENDORSE_PUBLIC` | `established` | `all` counts every endorsement publicly |
| `ENDORSE_YOUNG_DAYS` | 30 | Accounts younger than this are "young" |
| `ENDORSE_MIN_ACCOUNT_DAYS` | 0 (off) | Above 0, younger or unknown-age accounts can't endorse at all |
| `ENDORSE_RETENTION_MONTHS` | 12 | Endorsements expire 12 to 13 months after they're made |
| `ENDORSE_D1_CALLS_DAILY` | 300 (at most 350) | D1 calls a day for every signed-in visitor together (`me`, endorse, unendorse, forget), each charged before it runs. Past it, those answer 503 `over_budget` until 00:00 UTC |
| `ENDORSE_D1_WRITES_DAILY` | 2400 (at most 2400) | Rows those calls may write a day, each call charged the most it can write before it runs. The upkeep pot (cron, sweeps, clears) has its own fixed 2,200 and the public list's counts their own fixed 400. The ceilings keep Siren within 5% of the Free plan's daily D1 writes whatever the config says |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS JSON endpoint (a Worker has no raw DNS) |
| `PLC_URL` | `https://plc.directory` | The PLC directory |

Rate Limiting bindings (wrangler config, not packages), under `env.siren`.
Their counts are approximate and per Cloudflare location, the period is 10
or 60 seconds, and each `namespace_id` is an integer unique on the account
([Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
checked 2026-11-06):
`BSKY_VISITOR_RL` (60/min per visitor: login starts, callbacks, and the
first `me` of a session and `forget` under their own keys; the only
per-visitor limit on login starts, which keep no daily count),
`BSKY_INPUT_RL` (3/min per account typed), `BSKY_ACCOUNT_RL` (30/min per
signed-in account: me, endorse, unendorse, forget), `BSKY_SITE_RL`
(300/min breakers for login, callback and endorse) and `BSKY_D1_RL`
(2/min site-wide breakers in front of every D1 call a visitor can cause:
key `list` for computing the counts, key `signed` for `me`, endorse,
unendorse and forget). Endorse and unendorse
also charge `BSKY_VISITOR_RL` per visitor (key `end:<visitor hash>`), and a
new endorsement from a non-open server charges `BSKY_INPUT_RL` per domain
(key `iss:<day-scoped domain hash>`, 3/min), both before the daily counts
are read from D1. The callback charges its breaker only after its checks that need no
I/O (one flow cookie that opens, state, iss), so requests without a genuine
sealed flow can't trip it. Their counts are per
Cloudflare location and approximate, so a breaker can lock out one location
for a minute at most, never the whole site for a day. (The daily D1 budget
can, on purpose: see "Siren's worst case on the account's D1".) The daily caps are
counter rows in D1, read before and incremented with each action in one
transaction; two actions in the same instant can both pass a cap's last
slot, so a cap can be exceeded by the few that land together.

`blueskyReady` needs the flag, `SIREN_DB`, `LIMITS` (the request records),
`INVITE_SECRET`, `IP_SALT`, all five bindings and a valid `PUBLIC_ORIGIN`.
With the flag on and any of them missing, the Bluesky routes answer 503
("isn't set up yet") and log which by name; with the flag off they answer
404 as if they didn't exist. The client metadata route needs only a valid,
non-loopback `PUBLIC_ORIGIN`, so the rollout can probe before the flag.

## Setting up the database

Endorsements, their rate counters and the daily D1 budget are in one D1
database, `SIREN_DB`, which the planned public board will share. The schema
is in `migrations/` (wrangler's D1 migrations format). Every statement Siren
runs is prepared with bound values (`SQL` in `worker/endorsements.js`), and
the actions that write several rows write them in one batch: one
transaction, all or nothing.

Once, from a laptop logged in to the Cloudflare account:

```
npx wrangler d1 create siren --env siren
npx wrangler d1 migrations apply SIREN_DB --env siren --remote
```

(`--env siren` makes `create` use the env's `account_id`. Apply needs the
binding block first, so: create, add the block below with the printed
`database_id`, apply, then open the PR.) The block, in
`wrangler.toml` under the Siren env:

```toml
[[env.siren.d1_databases]]
binding = "SIREN_DB"
database_name = "siren"
database_id = "<the id `wrangler d1 create siren` printed>"
migrations_dir = "migrations"
```

`wrangler.toml` carries this commented out: a block with a placeholder id
would fail the Workers Builds deploy. Workers Builds doesn't apply
migrations, so apply any new one before merging the change that needs it.
The daily cron (`[env.siren.triggers] crons = ["17 7 * * *"]`, also
commented out there) is turned on with the flag in rollout step 5.

**Why D1 and not KV.** Platform facts, from Cloudflare's docs, checked
2026-11-06 ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
Jason's account is on the Workers Free plan. KV there allows 1,000 writes and
1,000 list operations a day, shared with every question Siren answers, and
the first version counted endorsements by listing KV keys. D1 on Free allows
5,000,000 rows read and 100,000 rows written a day, resets at 00:00 UTC, and
since 2026-09-01 fails queries past either limit until then; it also allows
50 queries per Worker invocation (a batch counts as one) and 100 bound
parameters per statement. Free accounts get 5 cron triggers. Past a D1 daily
limit Siren answers 503 on Bluesky routes, and serves the public list without
counts (cached for 60 seconds, as long as a counted list, so the outage
costs no more KV lists than a normal day). If the account moves to Paid, these numbers change; recheck them.

**The D1 daily limits are per account, not per database.** The same account
runs `scout-harness`, whose D1 database (`scout-harness-telemetry`) holds
Scout's kill switch, routing registry, memory commits and journal, and other
D1 databases besides (live Cloudflare API read, 2026-11-06: the `siren` and
`scout-harness` Workers and 8 D1 databases on the account). If anything spends
the day's 100,000 written rows or 5,000,000 read rows, every D1 query on the
account fails until 00:00 UTC: Scout's journal and memory commits fail, and
its kill switch reads as halted (Scout's own database hit the read limit on
2026-11-05, and Scout halted). So Siren has a stated, enforced worst case on
the account's D1: see [Siren's worst case on the account's D1](#sirens-worst-case-on-the-accounts-d1).
**Before rollout step 5, Jason decides**: accept sharing the Free limits with
Scout on those terms, or put `SIREN_DB` on a separate account or the Paid
plan.

Row costs, measured on local D1 (wrangler 4.147 through `getPlatformProxy`,
whose results carry `meta.rows_read` and `rows_written`; only
`wrangler d1 execute --local --json` leaves them out), 2026-11-06. An index
adds a written row for each write that touches its column. The table
predates three changes made since (the count no longer subtracts expired
rows, `me` is one SELECT with an UPDATE only when an age flag needs it, and
the sign-in marker is gone), so its count and `me` rows are upper bounds now.
Each charge to the daily budget adds one written row and about two reads.

Measured again on local D1 with this version (wrangler 4.147, 2026-11-07),
rows written against what was charged: a new endorsement from a capped
server with four new counters 13 (charged 14); from an open server 9 (10);
a repeat 1 (10); a withdrawal 5 (10); `me` over 21 accepted requests reads
24 rows and writes 1, or 4 with one age rewrite (charged 4); forget over 21
requests reads 51; the counts over 21 requests read 21; a refused charge
reads 2 and writes 0. Every write came in at or under its charge.

| Action | Rows read | Rows written |
|---|---|---|
| New endorsement, server capped, four new counters | 4 | 12 |
| New endorsement, server capped, counters already there | 8 | 8 |
| New endorsement, open server (two counters) | 4 | 6 |
| Withdrawal | 7 | 5 |
| Counts for the public list or admin page, 19 requests with endorsements | 21 (N + 2) | 0 |
| A purge with nothing expired | 12 | 0 |
| `me` for 20 accepted requests (account established / young) | 75 / 37 | 0 |
| Reading 4 rate counters | 4 | 0 |

What a route reads and writes at most, and what bounds it each day, is in
the next section. Measure once after setup with `--remote --json` (its
`meta` has the same fields) and date the result here. Indexes keep every
lookup to the rows it needs (a test checks each statement's query plan).

## Siren's worst case on the account's D1

The target (2026-11-07): whatever anyone does, Siren's D1 use stays within
5% of each of the Free plan's daily limits, so at most **250,000 rows read
and 5,000 rows written a day**, and can't starve Scout. Facts behind it,
checked 2026-11-06/07: the account is on Workers Free; it runs Siren,
Scout's production Worker (`scout-harness`) and 8 D1 databases; D1's Free
limits (5,000,000 rows read and 100,000 written a day) are per account,
across all databases, and past either every query fails until 00:00 UTC;
Scout's kill-switch read fails closed, so when the account's D1 reads run
out, Scout halts.

**How it's enforced.**

1. Nothing before a finished sign-in touches D1: the login start and the
   callback make no D1 call (a test drives every callback exit, failing and
   succeeding, against a database that throws on any call).
2. Every D1 call a visitor can cause sits behind Rate Limiting bindings that
   run first: `BSKY_D1_RL` (2 a minute per location, key `list` for the
   counts and key `signed` for `me`, endorse, unendorse and forget), plus the
   per-visitor and per-account limits. A refused request makes no D1 call.
3. Every D1 write Siren makes is charged first to today's row in
   `siren_d1_budget` (`chargeD1` in `worker/endorsements.js`), in one
   conditional UPSERT that grants the charge only if the day's caps still
   hold. D1 runs one statement at a time, so two charges can't both take the
   last of a cap. A refused charge reads about two rows, writes nothing, and
   the action stops there. Each call is charged the most it can write
   (`ROWS`: an endorsement 5 rows, a counter 2, an age rewrite 2, the budget
   row 1, at or above the measured costs above), so what's written never
   exceeds what was charged. There are three pots: `visitor` (`me`, endorse,
   unendorse, forget: `ENDORSE_D1_CALLS_DAILY` calls and
   `ENDORSE_D1_WRITES_DAILY` rows), `upkeep` (the cron's purge, the orphan
   sweep, the steward's clears: a fixed 2,200 rows) and `list` (the public
   list's counts: a fixed 400 computations a day), so visitors can't spend
   the budget the cleanup needs, and a busy list can't spend either.
4. Each computation of the public list that asks D1 for counts is charged
   first to the `list` pot (after `BSKY_D1_RL` `list`), so the counts are read
   at most 400 times a day across the account. Past that, the list is served
   without counts until 00:00 UTC. This bound doesn't depend on KV: the list
   still reads the request records from KV first and asks D1 only after that
   succeeds, but the account's KV list operations running out is not what
   holds the D1 reads down (that would also stop Scout; see
   [below](#the-public-list-and-the-accounts-kv-list-operations)).
5. `me` reads D1 at most once per session (the endorsed set rides in the
   sealed cookie), in one SELECT over at most 99 requests.

Why writes need a count in D1 and reads don't: a Rate Limiting binding
counts per location over 10 or 60 seconds, so its floor is one a minute,
1,440 a day, per location. One new endorsement writes up to 13 rows, so a
single location could write about 19,000 rows a day through the tightest
limiter. Only a daily count can hold writes to 5,000, and the only shared
daily counter Siren has is D1 itself (KV's 1,000 writes a day are shared
with every question).

**Assumptions.** Rate Limiting counts are local to each Cloudflare location
and approximate ([Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
checked 2026-11-06), so the reads below let each location through twice its
limit (A = 2) and assume L = 5 locations driven at full rate all day. N is
the number of requests with endorsements, at most 99 below (`me` looks at no
more than the first 99 accepted requests). Defaults throughout.

**Writes per UTC day** (independent of L and N):

| Source | Bound | Rows |
|---|---|---|
| `me`, endorse, unendorse, forget | the visitor pot, `ENDORSE_D1_WRITES_DAILY` (ceiling 2,400) | ≤ 2,400 |
| The cron's purge, orphan sweeps, the steward's clears on the admin page | the upkeep pot, fixed | ≤ 2,200 |
| Public list counts | the list pot, fixed: 400 computations, each charged its budget row | ≤ 400 |
| Login start, callback, admin page loads | no writes | 0 |
| **Total** | | **≤ 5,000 (5% of 100,000)** |

**Reads per UTC day** (L = 5, A = 2, N ≤ 99):

| Source | Bound | Rows |
|---|---|---|
| Public list counts | `BSKY_D1_RL` `list`: 2 a minute × 1,440 × A × L = 28,800 attempts, each a charge to the list pot reading about two rows (57,600); the pot grants 400 a day, each then one statement reading N + 1 rows (40,000) | ≤ 97,600 |
| Signed-in calls refused by the budget | `BSKY_D1_RL` `signed`: 2 a minute × 1,440 × A × L = 28,800 attempts, about two rows each | ≤ 57,600 |
| Signed-in calls granted | `ENDORSE_D1_CALLS_DAILY` 300 × at most 2 × 99 + 2 rows (the largest: `me`'s SELECT, its age UPDATE, each of forget's two steps, all measured nearer 1.1 to 2.5 rows per request; an endorse reads about 10) | ≤ 60,000 |
| Upkeep | the cron's counts (12 rounds × about 403 rows = 4,836), about 4 reads per row written within the 2,200-row upkeep budget (8,800), and a refused charge per granted list computation that finds orphans (≤ 400 × 2) | ≤ 14,500 |
| **Total** | | **≤ 229,700 (4.6% of 5,000,000)** |

Not in the tables: the steward's own admin page loads (N + 1 rows each) and
the steward CLI (`wrangler d1 execute`, run by hand, not charged to the
budget). Both are Jason's own actions.

**Where the numbers move.**

- *More locations.* Each extra location driven all day adds 11,520 refused
  reads on each of `BSKY_D1_RL`'s two keys, 23,040 in all. With N = 99 the
  reads stay within 250,000 up to 5 locations; with N = 50 (granted list
  reads ≤ 20,400, granted calls ≤ 30,600) up to 8. Writes don't depend on
  locations.
- *More requests with endorsements.* The list's reads grow by 400 per
  extra request. Past 99, `me` still looks at the first 99, but forget reads
  every tally row (about N, then 2N).
- *The Paid plan.* Paid's D1 limits are far larger. Recheck this section
  then.
- *Raising a limit.* `ENDORSE_D1_CALLS_DAILY` (ceiling 350, where N = 99
  reaches about 239,700) adds up to 200 rows read per call; `BSKY_D1_RL`'s
  limit scales the refused rows on both keys (each step of one a minute is
  28,800 rows per key at L = 5); the list pot (`LIST` in
  `worker/endorsements.js`, fixed) adds N + 1 rows read and one written per
  computation, and its writes come out of the same 5,000. Change them with
  this section.

**What it costs.** Anyone with a signed-in Bluesky account can spend the
visitor pot (300 calls, or 2,400 rows) in minutes; endorsing, withdrawing and
the first `me` of a session then answer 503 `over_budget` until 00:00 UTC,
and the list keeps showing counts. Scout is unaffected. The list pot runs
out on its own schedule: a location with a view at least once a minute all
day computes the list about once a minute (the cache), so one such location
spends the 400 a little under 7 hours into the UTC day, and five in about
80 minutes. After that the list is served without counts until 00:00 UTC.
`BSKY_D1_RL` lets 2 signed-in D1 calls a minute through per location, so a
room of people endorsing at once sees "Lots of endorsements right now" and
retries a minute later. The cleanup can't be starved by visitors (its own pot), but a large
month's cohort of expiring endorsements takes days to delete within 2,200
rows a day.

### The public list and the account's KV list operations

Not solved here; a decision for Jason. Each computation of the public list
starts with one KV list of the request records (`requestRows` in
`worker/requests.js`), out of the account's 1,000 KV list operations a day on
Free. Scout needs that same quota: every Scout run lists its memory namespace
(`describeHarness` → `listMemoryKeys` in scout-harness `src/pipeline.ts`,
read 2026-11-07) with no fallback, and the run fails if that throws. So once
the account's KV list operations are gone, every Scout run fails until
00:00 UTC.

Siren's D1 bound above no longer rests on this (the list pot holds it
whatever KV does). But nothing caps Siren's KV lists a day. With the flag
on, the 60-second cache holds one location to about 1,440 list computations
a day, more than the whole account's 1,000, and more locations multiply
that. A list without counts is cached as long as a counted one, so a D1
outage (even one Scout causes, as on 2026-11-05) adds none; a failed KV read
is remembered for 30 seconds. With the flag off it is worse, and it
predates this branch: on `main`, every `/api/requests` view that reaches the
Worker lists KV, with only a browser cache (`max-age=300`) in front.

The options, for Jason to choose among (none is built):

- a site-wide daily gate on list computations, checked before the KV list;
- a longer cache, served stale while one request refreshes it;
- moving the request records to D1, so the list costs no KV list
  operation at all.

## Rollout

1. **Merge with the flag off.** The PR sets `PUBLIC_ORIGIN` and the rate-limit bindings.
   After the deploy, the client metadata is live; login routes return 404,
   `/api/bsky/me` says unavailable, and the page shows no panel.
   `/api/requests` is served exactly as before; `/requests` (and `/admin`)
   gain `frame-ancestors 'none'` and `X-Frame-Options: DENY`.
2. **Check the metadata.**
   `curl -si https://jason-edelman.org/ask-siren/oauth-client-metadata.json`
   should return 200 with `application/json`, no redirect, and `client_id`
   exactly equal to that URL.
3. **Probe the server.** `node scripts/bsky-probe.js --account <a real handle>`
   from a laptop. It runs the login's resolution and checks against the live
   server with the production client_id, sends one PAR, and prints its status
   and `expires_in`. It never gets a code or tokens; the pending request
   expires by itself. Expect 201. If the server rejects `grant_types` without
   `refresh_token`, add it (it is still never used) and probe again. Servers
   may cache client metadata for an unknown time, so change it rarely.
4. **Set up the database** ([Setting up the database](#setting-up-the-database)):
   create it, apply the migrations, and merge the PR that adds the
   `[[env.siren.d1_databases]]` block. Still nothing changes for visitors.
5. **Flip the flag and turn on the cleanup**, in one PR: add
   `BLUESKY_LOGIN = "true"` to `[env.siren.vars]` (a dashboard-only var is
   overwritten on the next deploy) and uncomment
   `[env.siren.triggers] crons = ["17 7 * * *"]`. Check that the
   Rate Limiting `namespace_id`s (2611061 to 2611065) aren't used by another
   Worker on the account (scout-harness's `wrangler.toml`). The cron takes one of the
   account's 5 Free cron triggers (Jason's call which; with none free, the
   deploy fails, so check the dashboard first). Without it, deletion of
   expired rows depends on visits, and the requests page's retention promise
   doesn't hold on a quiet week. This step also needs Jason's decision on the
   shared D1 limits (see "Why D1 and not KV"): the Free plan's daily rows are
   the whole account's, Scout's included.
   Then check by hand, once: sign in, endorse, unendorse, forget, sign out; the
   cookie's Path is `/ask-siren/api/bsky/`, it has no Max-Age, and the main
   page's requests don't carry it; the admin counts look right, and deciding a
   test request freezes its count; and
   `npx wrangler d1 execute SIREN_DB --env siren --remote --command "SELECT * FROM endorsements LIMIT 5"`
   shows only hashes, and
   `npx wrangler kv key list --prefix bsky --binding LIMITS --env siren --remote`
   shows nothing.

## Local development

1. In `.dev.vars` (gitignored):

   ```
   ALLOW_UNLIMITED=true
   INVITE_SECRET=<any long random string>
   IP_SALT=<any string>
   BLUESKY_LOGIN=true
   PUBLIC_ORIGIN=http://127.0.0.1:8787
   ```

2. With the `[[env.siren.d1_databases]]` block in `wrangler.toml`, create the
   local tables once: `npx wrangler d1 migrations apply SIREN_DB --env siren --local`.
3. Run
   `npx wrangler dev --env siren --ip 127.0.0.1 --port 8787 --local-upstream 127.0.0.1:8787 --upstream-protocol http`.
   Without `--local-upstream`, wrangler infers the origin from the env's
   routes and rewrites `request.url` to `https://jason-edelman.org/...`, and
   the login's origin check refuses every local login. (From wrangler
   4.147's source, `origin.hostname` is `args.host ?? args.localUpstream`;
   not yet run against a live wrangler dev.) Never loosen the production
   check to work around it.
4. Open `http://127.0.0.1:8787/ask-siren/requests`, not `localhost`: the
   server sends you back to `127.0.0.1`, and a flow cookie set on `localhost`
   wouldn't come back.
5. With a loopback origin, the client is the atproto localhost client:
   `http://localhost?redirect_uri=<the 127.0.0.1 callback>&scope=atproto`.
   Servers synthesize its metadata, so the metadata route returns 404.
6. The cookies are `Secure`. Browsers that treat `http://127.0.0.1` as a
   secure context keep them, as the invite and account cookies already need.
   If yours drops them, the callback fails with `flow_expired`.
7. Tests need none of this: `npm test` uses a fake atproto network, KV,
   limiter and cache (`test/fake-atproto.js`), and a fake D1 over Node's
   `node:sqlite` that runs the real migrations and SQL (`test/fake-d1.js`).
   Where `node:sqlite` is missing (Node before 22.5), the tests that need a
   database skip and say why.

## Steward tools

- **`/admin`** shows each request's live count with the young and unknown-age
  split, the count frozen at decision, and a "Clear endorsements" button for
  brigading. Decisions freeze counts and clear rows. Clears are charged to
  the day's upkeep budget; when it's spent, the button answers 503 and
  deletes nothing, and a decision's clear is left to the orphan sweep (the
  count is frozen either way). With the flag on, a
  decline or fulfil is refused (503, with the reason) when the count can't
  be read (or SIREN_DB isn't bound), rather than losing it. To decide anyway
  (D1 past its daily limit, say), use the CLI with `--no-endorsements`: the
  count isn't frozen, and the orphan sweep deletes the request's rows once
  D1 answers again.
- **`node scripts/invites.js endorsements`** lists per-request totals. It
  deletes expired endorsements first (one statement), so it is a write.
- **`node scripts/invites.js endorsements-purge`** deletes expired
  endorsements, rate counters and past days' budget rows, as the daily cron
  does (500 rows of each kind per statement, repeated until done). `--all`
  deletes every Bluesky row, printing the per-request totals it deletes,
  and refuses while the env's wrangler config still sets the flag. Both
  need only the binding. The steward CLI's deletes aren't charged to the
  Worker's daily budget: they're run by hand and print what they delete.
- **`node scripts/invites.js endorsements-clear <id>`** deletes one request's
  endorsements. `request-decline` and `request-fulfilled` freeze and clear,
  like the admin page, by the Worker's rule: only when the target env's
  wrangler config sets `BLUESKY_LOGIN = "true"` (with `--local`, `.dev.vars`
  counts too) and binds `SIREN_DB`. Otherwise they write the decision and
  make no D1 call. With the flag on and D1 failing, they refuse before
  writing anything. `--endorsements` freezes and clears whenever SIREN_DB is
  bound, whatever the flag; `--no-endorsements` never touches D1. They run
  `wrangler d1 execute SIREN_DB`, and none of them needs the secret.
- **Turning the flag off** with endorsements live: with it off the Worker
  makes no D1 call, so it doesn't freeze or clear on a decision, and **no
  purge runs**: not the cron. Rows already stored would outlive what the
  requests page promises (endorsements within about 13 months, counters
  within about a day and a half). And when the flag comes back on, the orphan sweep deletes a
  decided request's rows without freezing them (a fulfilled request would
  show 0). So, in order:
  1. Decide, or freeze, first: make any decision you want counted while the
     flag is still on (the admin page), or later with the CLI's
     `--endorsements`.
  2. Deploy with the flag off.
  3. Purge: `node scripts/invites.js endorsements-purge --all` to delete
     every Bluesky row (accepted requests' live counts go with them), or,
     to keep endorsements for when the flag returns, run
     `endorsements-purge` at least daily while it is off.
  Purging after the flip, not before, means no location still running with
  the flag on can write a row the purge missed.
- **No per-account tools.** There's no block and no "remove this handle's
  endorsements". The steward can't see endorsers, so such a tool could act
  only on outside information about a named person, and its effect on counts
  would reveal what that person endorsed. Adding one needs a separate
  conversation with Jason.

## Rotating `INVITE_SECRET`

Rotating it already signs everyone out and orphans email accounts. It also
changes every endorsement id, so one account could endorse a request twice.
Delete every endorsement when you rotate it:
`npx wrangler d1 execute SIREN_DB --env siren --remote --command "DELETE FROM endorsements"`
(the tallies follow).

## Threat model

| Threat | Control | What's left |
|---|---|---|
| A malicious server authenticates a DID it doesn't serve | Siren resolves the DID, the PDS (checking `resource`) and the server itself; binds the issuer; checks `iss` and `sub`; and re-resolves the DID with no cache at the callback | Trusts plc.directory's current document (the audit log isn't verified) |
| Code injection or replay | PKCE and the DPoP key binding (the verifier and key live only in the sealed flow cookie, 10 minutes); the authorization server refuses a reused code (OAuth 2.1). No D1 marker: a marker written before the token exchange let anyone spend D1 writes, and one written after guards nothing | A server that accepts a code twice only re-proves the DID it already proved: the same eid, a second session |
| The callback as an outbound POST relay | Callback limits (`BSKY_VISITOR_RL`, then `BSKY_SITE_RL` once the cookie, state and iss check out), server endpoints on the issuer's origin | A replay within the flow cookie's 10 minutes sends one more token POST to the issuer the replayer chose, which refuses the spent code |
| Login CSRF and planted cookies | The flow is sealed to the browser that started it, SameSite=Lax, the state check. Two values of a cookie mean signed out: Siren then clears every other copy (Domain= the host and each domain above it, and host-only, at every path the request could carry), keeping its own session cookie, so the visitor recovers and is never handed the planted one. Sign out and "Remove all my endorsements" clear every copy, Siren's included | A sibling subdomain of jason-edelman.org (or a dangling CNAME) can plant a lone session cookie in a browser that has none. "Signed in as @handle" shows it, and sign out removes it. Until then the visitor's endorsements go to the planter's account, and the planter, signing in as themself, can list them through `me` |
| Flow tampering | AES-GCM, and the re-resolution | |
| Token leakage | Never stored, logged or sent to the browser; both revoked at once | Revocation is best effort |
| SSRF | The hardened fetch (https, port 443, hostnames only, disallowed TLDs, re-checked redirects, size caps, timeouts, no-store) and same-origin server endpoints | DNS rebinding to private address space can't be ruled out from inside a Worker |
| DoS through login fetches | Input parsed first; per-visitor, per-input and site limits; a 12 s deadline; the HTTPS lookup aborted once DNS answers | |
| Lockout through site-wide limits | Breakers are per location and per minute; daily caps are per account, visitor and server | The daily D1 budget is site-wide: anyone signed in can spend the visitor pot and pause endorsing, withdrawing and `forget` until 00:00 UTC. Accepted, so that Siren can't starve Scout; the list keeps its counts and the cleanup has its own pot |
| Sybil endorsing | Public number counts established accounts; per-server and per-domain daily caps, and a per-domain burst limit, for non-open servers; per-account and per-visitor caps; the steward's young and unknown split; per-request clear; "signal, not vote" | Many established bsky.social accounts held by one person still count. Tenants of a shared-hosting suffix missing from the list share one domain's 60 a day and 3 a minute |
| Identifying endorsers from a database dump | Per-request keyed ids, no reverse index, no DID, handle, server or token in D1 or KV; counters in their own keyed domains with their own visitor hashes and bucketed expiries, and no request or endorsement id in any counter; `WITHOUT ROWID` tables, so no insertion order; email sign-in's counters hardened too | Without `INVITE_SECRET`, nothing. With it (the operator, or anyone who gets the secret and a dump), every did:plc endorser of every request, by running the key over plc.directory's export |
| Linking one account's endorsements by timing | Nothing in a single dump links them | Repeated dumps (or watching counts change on the admin page or the public list) can link one account's endorsements made close together in time, including the burst when "Remove all my endorsements" runs or when `me` upgrades an aged account's flags |
| Pairing through D1's history (Time Travel: 7 days on Free, 30 on Paid) | Nothing; disclosed on the requests page | Someone with access to the Cloudflare account can restore any moment in the window. Comparing the moments before and after an endorsement pairs its row with the counters bumped in the same transaction: the request, that day's account hash, the network address hash and, for non-open servers, the server and domain hashes. With `IP_SALT` (held by the same operator) the network hash gives up an IPv4 address by trying all of them, so for 7 days the history can tie a network address to an endorsement of a named request. The account still can't be named without `INVITE_SECRET`, and whoever holds that can already list did:plc endorsers; what's new is the network and, for did:web or self-hosted endorsers, the server. Dropping the per-visitor daily counter (relying on `BSKY_VISITOR_RL`) would remove the address link; that's Jason's call |
| Locking one person out of sign-in | | `BSKY_INPUT_RL` is keyed by the account typed (3/min per location), so someone in the same Cloudflare location who types that account three times a minute keeps its owner getting "busy" there. Accepted: the limit is what stops Siren flooding one account's server |
| Withdrawing while an age flag is rewritten | The rewrite is one conditional UPDATE, so a withdrawn row stays deleted | |
| Orphaned endorsements after a decision | The decision clears rows; the public-list and admin computations sweep any left for decided or missing requests, 100 rows at a time in one statement | A request reopened within the last minute can look decided to a location whose KV read of the request is still stale, which may then sweep an endorsement made just after the reopen |
| Running out of the Free plan's daily D1 rows, which are the account's, shared with scout-harness (kill switch, routing registry, memory commits, journal) and every other D1 database there | A stated worst case of 5,000 rows written and 229,700 read a day ([Siren's worst case](#sirens-worst-case-on-the-accounts-d1)): no D1 call before a finished sign-in (login start and callback); `BSKY_D1_RL` and the per-visitor and per-account limits before every D1 call a visitor can cause; every write charged first to a daily budget whose ceilings can't be configured past 5%; the public list's counts charged first to their own daily pot (400 a day), which doesn't depend on KV; `me` once per session | The read bound assumes 5 locations driven all day and N ≤ 99 (more locations add 23,040 reads each). Past 400 list computations in a day the list is served without counts until midnight UTC. Anyone signed in can spend the visitor pot and pause endorsing until midnight UTC; Scout is unaffected. If something else on the account spends D1's limits, Siren's Bluesky routes answer 503, the list is served without counts, and the admin page refuses declines and fulfils (the CLI's `--no-endorsements` decides without freezing). Jason decides before rollout step 5 whether to share the limits on these terms or move `SIREN_DB` |
| The steward as a lookup oracle | No per-account steward tools; the admin page shows counts only | |
| Probing unreviewed requests | `endorse` looks ids up only on the public list; `unendorse` answers the same for every well-formed id | |
| Cross-site actions and framing | JSON-only POSTs, the Origin check, SameSite, no CORS on POSTs or `me`, `frame-ancestors 'none'` and `X-Frame-Options` on `/requests` and `/admin`; steward POSTs that carry an `Origin` must name this site | |
| Bluesky identity meeting questions | The session cookie is scoped to `/api/bsky/` | |
| Shared computers | A browser-session cookie capped at 24 h, the visible handle, sign out, `me` lists only public requests | |
| Logs identifying self-hosted people | The failure code only; the server host only for open servers; cancellations not logged | |
| Storage cost and growth | `/api/requests` through the Cache API (60 s); tallies kept by triggers; expired rows deleted by the daily cron within the upkeep budget; freeze and delete at decision; per-server caps | |
| KV failing behind the public list (on Free, past its 1,000 list operations a day) | The list reads KV before D1; a failure is a JSON 503, remembered for 30 seconds per location under its own cache key, with no D1 call | The page says the list couldn't be loaded |
| Siren using up the account's KV list operations, which Scout's runs need (each run lists its memory namespace and fails if that throws) | Each list computation is one KV list; the 60-second cache (also for a list without counts) holds a location to about 1,440 a day | Not capped: one busy location can pass the account's 1,000 a day, and then every Scout run fails until 00:00 UTC. Predates this branch (on `main` every `/api/requests` view lists KV). A decision for Jason ([options](#the-public-list-and-the-accounts-kv-list-operations)) |
| Key-prefix collisions with steward tools | Nothing new under `request:`, and a test for it | |
