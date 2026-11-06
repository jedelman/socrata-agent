# Bluesky endorsements on the public request list

The public list of source requests (`/ask-siren/requests` for Siren) can be
endorsed by anyone with a Bluesky account. An endorsement says "I want this
source added too". It helps the steward choose what to add next. It is not a
vote.

The feature is off until `BLUESKY_LOGIN = "true"` is set. With it off, the
list behaves as it did before (the page and `/admin` only gain anti-framing headers).

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
| Per endorsement: `endorsement:<request id>:<HMAC(INVITE_SECRET, request + account)>`, plus one flag: young, established or unknown age | KV | Until the request is decided (keys written around the decision are swept within minutes, where the public list is computed), and in any case until the start of the month 12 to 13 months after it was made (`ENDORSE_RETENTION_MONTHS`) |
| Rate events: one key per action, named by a random uuid under a day-scoped keyed hash of the account, a keyed hash of the network address, or (for servers not in `ENDORSE_OPEN_ISSUERS`) a day-scoped keyed hash of the account's server and of its domain. None names a request, so a withdrawal leaves nothing request-specific behind | KV | About a day |
| A single-use marker for each finished sign-in (a hash of its random state) | KV | Up to two hours |
| The pending sign-in (state, PKCE verifier, DPoP key, nonce, the account and its server) | A sealed cookie in your browser, scoped to `/ask-siren/oauth/` | 10 minutes |
| Your sign-in (a keyed id for your account, your handle, its creation day, its server) | A sealed browser-session cookie, scoped to `/ask-siren/api/bsky/` | Until you close the browser, and at most 24 hours |

Nothing else. KV never holds a DID, a handle, a token, an authorization
server, a pending sign-in, or the account's creation day. The keyed id for
your account (`HMAC(INVITE_SECRET, "endorser:" + DID)`) lives only inside your
sealed cookie, and each endorsement key mixes in the request, so one account's
endorsements on different requests have no key material in common. (Someone
who lists KV over and over can still pair keys written close together in
time; see the threat model.) A plain hash of the DID
would not do: every did:plc DID can be listed from plc.directory.

When a request is decided (fulfilled or declined), its count is frozen into
the request record and the per-account keys are deleted. Keys that slip past
that delete (written in the minute before the decision, when KV listings
lag, or by a location still serving the old list) are swept the next time
the public list (`/api/requests`) or the admin page is computed, at most 100
deletes per sweep, so they last minutes (a large brigade over a few sweeps).
The endorse and `me` routes never sweep, so a person's own action never
shares its KV operations with one. A fulfilled request
shows its frozen number; a reopened one starts again from live endorsements.

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
  running the key over that list against a KV listing names every did:plc
  endorser, offline. Endorsers are pseudonymous to the public and the admin
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
   charged. Then the limits (per visitor, per hour, per account typed, and a
   site-wide breaker), all before any outbound request. Siren resolves the
   handle itself (DNS over HTTPS and the HTTPS well-known, DNS winning a
   conflict), fetches the DID document, checks the handle both ways, finds the
   PDS, checks its protected-resource metadata (RFC 9728, `resource` must be
   the PDS), and checks the authorization server's metadata. Then PAR
   (RFC 9126) with PKCE S256 and a fresh DPoP key (ES256, RFC 9449). The
   pending flow is sealed (AES-256-GCM, key from HKDF) into an HttpOnly cookie.
2. The browser goes to the server's authorize page and comes back to
   `GET /oauth/callback`. Siren needs exactly one flow cookie that opens and
   hasn't expired, a matching `state`, and `iss` equal to the bound server
   (RFC 9207), before it reads `code`. A single-use marker refuses a replay.
   The token response must be DPoP-bound, carry `atproto`, and name the bound
   DID in `sub`. Then Siren re-resolves the account with no cache, and its PDS
   must still name the same server. Both tokens are revoked, and the session
   cookie is set.
3. `GET /api/bsky/me`, `POST /api/bsky/endorse`, `/unendorse`, `/forget` and
   `/logout` read only that session cookie.

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
| `BSKY_LOGIN_PER_VISITOR_HOURLY` | 60 | Login starts per hashed visitor per hour |
| `ENDORSE_PER_DID_DAILY` | 30 | Endorse and unendorse actions per account per day (repeats are free) |
| `ENDORSE_PER_VISITOR_DAILY` | 200 | The same, per hashed visitor |
| `ENDORSE_PER_ISSUER_DAILY` | 20 | New endorsements per day from each server (issuer host) not in `ENDORSE_OPEN_ISSUERS`. A withdraw and a re-endorse count again |
| `ENDORSE_PER_DOMAIN_DAILY` | 60 | The same, for all such servers under one registrable domain together: the last two labels, or three under a listed multi-label suffix (`co.uk`, `com.au`, and shared hosting such as `github.io` or `fly.dev`, whose tenants are unrelated). So `a1.abc.dev`, `a2.abc.dev` and a wildcard farm under one domain share 60 a day, while `pds1.github.io` and `pds2.github.io` don't share anything |
| `ENDORSE_OPEN_ISSUERS` | `https://bsky.social` | Comma-separated server origins exempt from that cap. Add large community servers here, since everyone on one shares its 20 a day |
| `ENDORSE_PUBLIC` | `established` | `all` counts every endorsement publicly |
| `ENDORSE_YOUNG_DAYS` | 30 | Accounts younger than this are "young" |
| `ENDORSE_MIN_ACCOUNT_DAYS` | 0 (off) | Above 0, younger or unknown-age accounts can't endorse at all |
| `ENDORSE_RETENTION_MONTHS` | 12 | Endorsements expire 12 to 13 months after they're made |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS JSON endpoint (a Worker has no raw DNS) |
| `PLC_URL` | `https://plc.directory` | The PLC directory |

Rate Limiting bindings (wrangler config, not packages), under `env.siren`:
`BSKY_VISITOR_RL` (60/min per visitor: login starts, callbacks),
`BSKY_INPUT_RL` (3/min per account typed), `BSKY_ACCOUNT_RL` (30/min per
signed-in account: me, endorse, unendorse, forget) and `BSKY_SITE_RL`
(300/min breakers for login, callback and endorse). Endorse and unendorse
also charge `BSKY_VISITOR_RL` per visitor (key `end:<visitor hash>`), and a
new endorsement from a non-open server charges `BSKY_INPUT_RL` per domain
(key `iss:<day-scoped domain hash>`, 3/min), both before the daily KV counts,
which lag. The callback charges its breaker only after its checks that need no
I/O (one flow cookie that opens, state, iss), so requests without a genuine
sealed flow can't trip it. Their counts are per
Cloudflare location and approximate, so a breaker can lock out one location
for a minute at most, never the whole site for a day. The daily caps are KV
listings and can lag about a minute.

`blueskyReady` needs the flag, `LIMITS`, `INVITE_SECRET`, `IP_SALT`, all four
bindings and a valid `PUBLIC_ORIGIN`. The client metadata route needs only a
valid, non-loopback `PUBLIC_ORIGIN`, so the rollout can probe before the flag.

## Rollout

1. **Merge with the flag off.** The PR sets `PUBLIC_ORIGIN` and the bindings.
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
4. **Flip the flag** with a one-line PR adding `BLUESKY_LOGIN = "true"` to
   `[env.siren.vars]` (a dashboard-only var is overwritten on the next deploy).
   Then check by hand, once: sign in, endorse, unendorse, forget, sign out; the
   cookie's Path is `/ask-siren/api/bsky/`, it has no Max-Age, and the main
   page's requests don't carry it; the admin counts look right, and deciding a
   test request freezes its count; and
   `npx wrangler kv key list --prefix endorse --binding LIMITS --env siren --remote`
   shows only hashes.

## Local development

1. In `.dev.vars` (gitignored):

   ```
   ALLOW_UNLIMITED=true
   INVITE_SECRET=<any long random string>
   IP_SALT=<any string>
   BLUESKY_LOGIN=true
   PUBLIC_ORIGIN=http://127.0.0.1:8787
   ```

2. Run
   `npx wrangler dev --env siren --ip 127.0.0.1 --port 8787 --local-upstream 127.0.0.1:8787 --upstream-protocol http`.
   Without `--local-upstream`, wrangler infers the origin from the env's
   routes and rewrites `request.url` to `https://jason-edelman.org/...`, and
   the login's origin check refuses every local login. (From wrangler
   4.147's source, `origin.hostname` is `args.host ?? args.localUpstream`;
   not yet run against a live wrangler dev.) Never loosen the production
   check to work around it.
3. Open `http://127.0.0.1:8787/ask-siren/requests`, not `localhost`: the
   server sends you back to `127.0.0.1`, and a flow cookie set on `localhost`
   wouldn't come back.
4. With a loopback origin, the client is the atproto localhost client:
   `http://localhost?redirect_uri=<the 127.0.0.1 callback>&scope=atproto`.
   Servers synthesize its metadata, so the metadata route returns 404.
5. The cookies are `Secure`. Browsers that treat `http://127.0.0.1` as a
   secure context keep them, as the invite and account cookies already need.
   If yours drops them, the callback fails with `flow_expired`.
6. Tests need none of this: `npm test` uses a fake atproto network, KV,
   limiter and cache (`test/fake-atproto.js`).

## Steward tools

- **`/admin`** shows each request's live count with the young and unknown-age
  split, the count frozen at decision, and a "Clear endorsements" button for
  brigading. Decisions freeze counts and clear keys.
- **`node scripts/invites.js endorsements`** lists per-request totals.
- **`node scripts/invites.js endorsements-clear <id>`** deletes one request's
  endorsements. `request-decline` and `request-fulfilled` freeze and clear,
  like the admin page. None of these needs the secret.
- **No per-account tools.** There's no block and no "remove this handle's
  endorsements". The steward can't see endorsers, so such a tool could act
  only on outside information about a named person, and its effect on counts
  would reveal what that person endorsed. Adding one needs a separate
  conversation with Jason.

## Rotating `INVITE_SECRET`

Rotating it already signs everyone out and orphans email accounts. It also
changes every endorsement id, so one account could endorse a request twice.
Delete every `endorsement:` key when you rotate it:
`node scripts/invites.js endorsements-clear <id>` for each request, or a bulk
delete of the `endorsement:` prefix.

## Threat model

| Threat | Control | What's left |
|---|---|---|
| A malicious server authenticates a DID it doesn't serve | Siren resolves the DID, the PDS (checking `resource`) and the server itself; binds the issuer; checks `iss` and `sub`; and re-resolves the DID with no cache at the callback | Trusts plc.directory's current document (the audit log isn't verified) |
| Code injection or replay | PKCE, the DPoP key binding, the single-use marker | Parallel replays across locations are best effort, bounded by the limits |
| The callback as an outbound POST relay | The single-use marker, callback limits, server endpoints on the issuer's origin | |
| Login CSRF and planted cookies | The flow is sealed to the browser that started it, SameSite=Lax, the state check. Two values of a cookie mean signed out: Siren then clears every other copy (Domain= the host and each domain above it, and host-only, at every path the request could carry), keeping its own session cookie, so the visitor recovers and is never handed the planted one. Sign out and "Remove all my endorsements" clear every copy, Siren's included | A sibling subdomain of jason-edelman.org (or a dangling CNAME) can plant a lone session cookie in a browser that has none. "Signed in as @handle" shows it, and sign out removes it. Until then the visitor's endorsements go to the planter's account, and the planter, signing in as themself, can list them through `me` |
| Flow tampering | AES-GCM, and the re-resolution | |
| Token leakage | Never stored, logged or sent to the browser; both revoked at once | Revocation is best effort |
| SSRF | The hardened fetch (https, port 443, hostnames only, disallowed TLDs, re-checked redirects, size caps, timeouts, no-store) and same-origin server endpoints | DNS rebinding to private address space can't be ruled out from inside a Worker |
| DoS through login fetches | Input parsed first; per-visitor, per-input and site limits; a 12 s deadline; the HTTPS lookup aborted once DNS answers | |
| Lockout through site-wide limits | Breakers are per location and per minute; daily caps are per account, visitor and server | |
| Sybil endorsing | Public number counts established accounts; per-server and per-domain daily caps, and a per-domain burst limit, for non-open servers; per-account and per-visitor caps; the steward's young and unknown split; per-request clear; "signal, not vote" | Many established bsky.social accounts held by one person still count. Tenants of a shared-hosting suffix missing from the list share one domain's 60 a day and 3 a minute |
| Identifying endorsers from a KV dump | Per-request keyed ids, no reverse index, no DID, handle, server or token in KV; counters in their own keyed domains with their own visitor hashes and bucketed expirations, and no request in any counter; email sign-in's counters hardened too | Without `INVITE_SECRET`, nothing. With it (the operator, or anyone who gets the secret and a dump), every did:plc endorser of every request, by running the key over plc.directory's export |
| Linking one account's endorsements by timing | Nothing in a single dump links them | Repeated KV listings (or watching counts change on the admin page or the public list) can link one account's endorsements made close together in time, including the burst when "Remove all my endorsements" runs or when `me` upgrades an aged account's flags. They still can't name the account without `INVITE_SECRET` |
| Locking one person out of sign-in | | `BSKY_INPUT_RL` is keyed by the account typed (3/min per location), so someone in the same Cloudflare location who types that account three times a minute keeps its owner getting "busy" there. Accepted: the limit is what stops Siren flooding one account's server |
| Withdrawing while an age flag is rewritten | The rewrite reads the key again just before its put and leaves a withdrawn key deleted | KV has no compare-and-set: a withdrawal landing between that read and the put (milliseconds) is undone, and the endorsement counts again until withdrawn again |
| Orphaned endorsements after a decision | The decision clears keys; the public-list and admin computations sweep any left for decided or missing requests, 100 deletes at a time | A request reopened within the last minute can look decided to a location whose KV read is still stale, which may then sweep an endorsement made just after the reopen |
| The steward as a lookup oracle | No per-account steward tools; the admin page shows counts only | |
| Probing unreviewed requests | `endorse` looks ids up only on the public list; `unendorse` answers the same for every well-formed id | |
| Cross-site actions and framing | JSON-only POSTs, the Origin check, SameSite, no CORS on POSTs or `me`, `frame-ancestors 'none'` and `X-Frame-Options` on `/requests` and `/admin`; steward POSTs that carry an `Origin` must name this site | |
| Bluesky identity meeting questions | The session cookie is scoped to `/api/bsky/` | |
| Shared computers | A browser-session cookie capped at 24 h, the visible handle, sign out, `me` lists only public requests | |
| Logs identifying self-hosted people | The failure code only; the server host only for open servers; cancellations not logged | |
| KV list cost and keyspace growth | `/api/requests` through the Cache API (60 s); retention expiry; freeze and delete at decision; per-server caps | |
| Key-prefix collisions with steward tools | Nothing new under `request:`, and a test for it | |
