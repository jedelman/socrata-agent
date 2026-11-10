# Bluesky endorsements on the public request list

The public list of source requests (`https://ask-siren.jason-edelman.org/requests`
for Siren) can be
endorsed by anyone with a Bluesky account. An endorsement says "I want this
source added too". It helps the steward choose what to add next. It is not a
vote.

An endorsement is a record in the endorser's own atproto repository, written
and deleted by their browser. Siren reads and counts these records through
Constellation, a public index of links on the network. Siren's server never
signs anyone in, never sees a token, sets no Bluesky cookie and stores nothing
about who endorsed. The list of endorsers is public, with bots and moderated
accounts flagged, by Jason's public-first direction (2026-11-09).

The feature is off until `BLUESKY_LOGIN = "true"` is set. With it off, the
public list and the steward's tools behave as before, and nothing calls
Constellation, the AppView, any PDS or D1.

Decisions marked **default, pending Jason** below were taken from the design
spec's recommendations and wait for his call; they are listed at the end.

## What an endorsement is, and isn't

- **A signal for the steward, not a vote.** The public list still sorts by how
  many people asked. Endorsements only break ties, and a count that couldn't
  be read ties.
- **Counted per account, not per person.** One person can hold many accounts,
  so the page says "endorsements", never "people". The count is the number of
  distinct accounts whose repo links to the request.
- **Every account counts** (D6, default, pending Jason). Flags are shown next
  to the account, never used to leave it out.
- **Only listed requests show endorsements.** Anyone can write a record for
  any id; that's the open network, outside Siren. Siren counts and lists
  records only for requests on its public list, and only for random request
  ids (see "Request ids" below).
- **A Bluesky sign-in grants endorsing and nothing else.** It doesn't let
  anyone ask Siren, skip the invite, or touch an email account. Endorsing
  needs no invite.
- **The record is the endorsement.** A record with the same collection and
  subject written by any other tool counts too; Siren's page is one way to
  write it.

## The record

The Lexicon ships in `lexicons/org/jason-edelman/siren/endorsement.json`:

```json
{
  "lexicon": 1,
  "id": "org.jason-edelman.siren.endorsement",
  "defs": {
    "main": {
      "type": "record",
      "key": "any",
      "record": {
        "type": "object",
        "required": ["subject", "createdAt"],
        "properties": {
          "subject": { "type": "ref", "ref": "#requestRef" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    },
    "requestRef": {
      "type": "object",
      "required": ["uri", "id"],
      "properties": {
        "uri": { "type": "string", "format": "uri", "maxLength": 512 },
        "id": { "type": "string", "maxLength": 64 },
        "title": { "type": "string", "maxLength": 300, "maxGraphemes": 200 }
      }
    }
  }
}
```

- **The NSID** is `org.jason-edelman.siren.endorsement` (settled by Jason,
  2026-11-09, until a domain for Cairn is chosen). It is one constant,
  `ENDORSE_NSID` in `worker/endorse-config.js`, with everything built from
  it: the OAuth scope, the Constellation source, the record builder. A test
  fails if the string appears in any other source file.
- **The subject** is the request's own page,
  `https://ask-siren.jason-edelman.org/requests/<id>`, built by one function
  (`endorseSubject`): from `PUBLIC_ORIGIN` and `BASE_PATH`, never the Host
  header; lowercase; no trailing slash, query or fragment. Constellation
  matches it exactly (a trailing slash is a different target), so nothing
  else may build it. The page answers 404 for an id that isn't on the public
  list.
- **The subject is fixed from here on.** It moved once, on 2026-11-10, with
  Siren itself (from `https://jason-edelman.org/ask-siren/requests/<id>`),
  before any endorsement existed, so the move cost nothing. Changing
  `PUBLIC_ORIGIN` or `BASE_PATH` once records exist would strand them: they
  would point at the old subject, and Constellation matches the subject
  string exactly, so a redirect carries nothing over. A later move is a
  migration like the NSID's ("Moving the NSID": count both subjects for a
  window, and let people move their own records).
- **The record key is the request id**, so one account has at most one
  record per request from Siren's page, "have I endorsed this?" is one
  unauthenticated read, and a delete is idempotent. Siren never uses
  `putRecord`, so it never asks for `update`.
- **`title`** is a snapshot of the request's source text, so the record reads
  on its own in someone's repo. Siren never displays a record's title or any
  other record text: only `createdAt`, as a day, once it parses as an RFC
  3339 date not in the future.
- **No `validate` field** is sent. A PDS can't resolve an unpublished Lexicon,
  and optimistic validation (the default) accepts the record with
  `validationStatus: unknown`. With `validate: true` the reference PDS refuses
  an unknown type.

### Publishing the Lexicon (D1, settled: from Jason's account)

Jason decided (2026-11-09) that the Lexicon is published from his own
account, `did:plc:zz4wcje4a2nbbtc7pdoth3f2` (handle `jason-edelman.org`).
Nothing in this repo publishes it. Publishing is good practice, not a
requirement: PDSes accept the records and Constellation indexes them either
way. The steps (atproto.com/specs/lexicon, read 2026-11-09):

1. **DNS.** A TXT record on the zone `jason-edelman.org`:
   - name: `_lexicon.siren.jason-edelman.org`
   - value: `did=did:plc:zz4wcje4a2nbbtc7pdoth3f2`

   The name is `_lexicon.` plus the NSID's authority reversed, without the
   final name segment (`org.jason-edelman.siren` -> `siren.jason-edelman.org`).
   Resolvers don't walk up or down DNS, so a record on `jason-edelman.org`
   itself wouldn't do. Check: `dig +short TXT _lexicon.siren.jason-edelman.org`.
2. **The schema record**, in that account's repo:
   - collection: `com.atproto.lexicon.schema`
   - record key: `org.jason-edelman.siren.endorsement`
   - value: the Lexicon JSON above, with `"$type": "com.atproto.lexicon.schema"`
     added, and its `id` equal to the record key.

   Any tool that can create a record in that repo will do, such as Bluesky's
   `goat` CLI signed in as jason-edelman.org (check its current help for the
   command; not run here). Check it with an unauthenticated
   `com.atproto.repo.getRecord?repo=did:plc:zz4wcje4a2nbbtc7pdoth3f2&collection=com.atproto.lexicon.schema&rkey=org.jason-edelman.siren.endorsement`
   on that account's PDS.
3. Later, a permission set `org.jason-edelman.siren.authEndorse` (a Lexicon of
   type `permission-set`, published the same way) would give the consent
   screen a nicer title (`include:` scopes). Not needed now; the direct
   `repo:` scope works without it.

### Moving the NSID

A move to, say, `org.cairn-civic.siren.endorsement` is a migration, not an
edit:

1. Publish the new Lexicon.
2. Declare **both** scopes in the client metadata for a transition window;
   the client requests only the new one.
3. Count over both sources (two Constellation calls, union of DIDs), for a
   window Jason sets.
4. Offer "move my endorsements" on the page: the browser lists the old
   records with an unauthenticated `listRecords`, creates new ones and
   deletes the old ones (create on the new NSID and delete on the old one,
   requested together for that one flow).
5. After the window, stop counting the old NSID and drop it from the metadata.

Old records stay in people's repos until they delete them; Siren can't touch
them.

## Request ids

Public request ids are random: 16 base32 characters (80 bits), minted when a
request is first raised (Jason's decision D12, 2026-11-09, made before any
endorsement existed). The old id was the first 12 hex of a hash of the source
text, so anyone could confirm a guessed source against it. Endorsement
records point at the id, so the change had to come before launch.

Requests from before random ids keep their legacy id until the steward runs
`node scripts/invites.js request-ids` (a dry run) and then
`request-ids --apply`, once. Legacy ids are never counted and get no Endorse
button. Run the migration before turning the flag on (Rollout, step 1).

## The browser flow

The requests page is the OAuth public client (`worker/endorse-client.js`,
with `worker/atproto-oauth.js`, `worker/atproto-identity.js` and
`worker/endorse-config.js`, served to the browser as module text):

1. **Resolve** the account in the browser: the handle over DNS-over-HTTPS
   (Cloudflare's resolver allows CORS) and the HTTPS well-known, then the DID
   document. Custom-domain handles whose well-known has no CORS can't be
   resolved from a page; the browser then asks the Worker's
   `POST /api/bsky/resolve` for the DID only (public data, nothing stored,
   rate-limited), and still reads and checks the DID document itself: its
   handle must match, and the PDS comes from the browser's own read.
2. **The PDS's authorization server** (RFC 9728 protected-resource metadata,
   exactly one AS, a plain https origin) and its metadata: issuer match, PAR
   required, PKCE S256, DPoP ES256, the RFC 9207 `iss` parameter, client
   metadata documents, `none` auth, and the `fragment` response mode. Every
   endpoint must be on the issuer's origin.
3. **PAR** with PKCE, a random state, `login_hint`, `response_mode=fragment`
   and scope `atproto repo:org.jason-edelman.siren.endorsement?action=create&action=delete`,
   with a DPoP proof from a fresh P-256 key generated **non-extractable**
   (it can sign; it can never be exported). The flow (state, verifier, DID,
   issuer, endpoints, nonce, key) is kept in IndexedDB for 10 minutes. Then
   the browser goes to the AS.
4. **The return** lands on `/requests#state=…&iss=…&code=…`. The code is in
   the fragment, so it never reaches the Worker or `wrangler tail`. The page
   clears the fragment at once. There must be exactly one stored flow for the
   state, unexpired, and `iss` must equal its issuer before the error or the
   code is read. Then the token request (DPoP, the PAR nonce carried
   forward, one retry on `use_dpop_nonce`).
5. **Checks on the token:** DPoP-bound; `sub` equals the DID; the scope
   carries `atproto` **and** a `repo:` permission covering create and delete
   on the collection. A server may grant less than asked without saying so
   (the reference AS drops scopes it doesn't know, and the user can remove
   them on the consent screen); then the token is revoked and the page says
   "Your Bluesky server can't grant the narrow permission Siren needs". The
   DID is re-resolved with no cache, and its PDS must still name the same AS.
6. **The session** (DID, handle, PDS, issuer, access token, key, the AS and
   PDS nonces kept apart) is kept in IndexedDB for at most 24 hours, with no
   refresh token (D2, default, pending Jason). When the access token expires,
   the next action re-authorizes with `login_hint` = the DID; the AS skips
   its consent screen when the person's session there and earlier consent
   are live. **Sign out** revokes the token (RFC 7009, with DPoP) and deletes
   the session.
7. **Endorse:** `com.atproto.repo.createRecord` on the person's own PDS, with
   `Authorization: DPoP <token>` and a proof carrying `ath` (the base64url
   SHA-256 of the token), its own PDS nonce, one retry on
   `use_dpop_nonce`. A record already under that key counts as success once
   an unauthenticated `getRecord` shows it's this endorsement.
8. **Withdraw:** `deleteRecord` under the request id, then an unauthenticated
   `listRecords` of the person's own collection (at most 10 pages of 100) to
   delete any other tool's record of the same subject. **Remove all my
   endorsements** deletes every record in the collection with `applyWrites`,
   50 at a time.
9. **"Have I endorsed this?"** is one unauthenticated `listRecords` of the
   person's own collection, read from their own PDS, never sent to the Worker.

**No `transition:generic` fallback** (D3, default, pending Jason). That scope
would let the page create, change or delete anything in the person's repo:
posts, follows, profile, other apps' records. A server that won't grant the
narrow scope gets a clear message instead, and its users can't endorse until
it supports granular scopes. Offering the fallback would have to be declared
in the client metadata from day one.

**What a person's server shows.** The reference consent UI shows a non-Bluesky
`repo:` scope as a "Repository" card ("Publish changes") with a row for
`org.jason-edelman.siren.endorsement` and Create and Delete ticked. Other AS
software may show the raw scope string.

**A second client, for the free tier** (`docs/free-tier.md`, behind
`PUBLIC_ASK`). The public questions page is another client of the same
module, with its own client_id (`/question-client-metadata.json`, served only
with that flag on), its own redirect (`/questions`) and the question
permission. This page's client_id, metadata and scope are unchanged. The two
pages share the one session in IndexedDB, which now keeps the scope it was
granted; an action whose permission the session lacks re-authorizes (the
requests page already does that for an expired token).

## Constellation: the counts

Counts come from Constellation (microcosm,
https://constellation.microcosm.blue/, read 2026-11-09), which walks every
record on the firehose and indexes anything that looks like a link, by
target, collection and JSON path. It handles record deletion and account
deactivation and deletion.

- **The call:** `GET /xrpc/blue.microcosm.links.getBacklinkDids?subject=<the subject URL>&source=org.jason-edelman.siren.endorsement:subject.uri&limit=1`,
  reading `total`, the number of distinct accounts.
- **Untrusted input.** The total must be a whole number from 0 to 10^9; DIDs
  must be valid did:plc or hostname did:web, and are deduplicated; lists are
  capped at the limit asked for; a cursor must be short and URL-safe;
  responses over 64 KB or slower than 4 seconds are failures.
- **Its terms, in its own words:** "api is unstable and likely to change";
  the public instance "runs on a little raspberry pi in my house …
  best-effort uptime, no commitment to not breaking the api for now, and
  possible rate-limiting"; "Please do not build the torment nexus"; please
  name the project and a contact in the User-Agent. Siren's User-Agent names
  the project, its public URL and the repo, and no personal contact (D5,
  default, pending Jason). The code is AGPL, which matters only if Siren
  self-hosts it.
- **Load:** one call per listed request, six at a time, behind one charge of
  the site breaker `BSKY_SITE_RL` (key `counts`), and the whole counted list
  is cached 60 seconds per Cloudflare location. Viewers' browsers never call
  Constellation: their addresses stay off a volunteer's machine.
- **Failure:** a count that can't be read is never shown as 0. The last good
  count (kept up to 24 hours per location in the Cache API, with the time it
  was read) is served with `endorsements_as_of`, and the page says "as of
  HH:MM UTC". With none, the item carries `endorsements: null` and
  `endorsements_unavailable: true`, and the page says "Endorsement count
  unavailable right now".
- **Switching instances:** `CONSTELLATION_URL` (a bare https origin) points
  at a self-hosted instance (D11: the public one for now, default, pending
  Jason).
- **KV operations:** reading the request pool costs one KV list per 1,000
  keys and four gets per request (record, tombstone, decision, id). A Worker
  invocation may make at most 1,000 operations to bindings, KV reads
  included (https://developers.cloudflare.com/kv/platform/limits/, checked
  2026-11-09: "Operations/Worker invocation: 1000" on Free and Paid), so the
  public list, the admin list and the endorser route's list check fail past
  about 249 requests of all statuses. The pool is far smaller today; before
  it nears that, switch `requestRows` to KV's bulk get (100 keys count as
  one operation).
- **Subrequests:** a counted list costs N Constellation calls, at most once a
  minute per location. Workers Paid allows far more subrequests per
  invocation than Siren's list will reach; recheck the current number in
  Cloudflare's docs and date it here before the list grows past a few
  hundred requests (not rechecked 2026-11-09).
- **Fulfilled requests** show the count frozen at the decision and the live
  count (D7, default, pending Jason): records stay in people's repos after a
  decision.

## The endorser list

`GET <base>/api/requests/<id>/endorsers?cursor=`, for an id on the public
list only (accepted or fulfilled); anything else is a 404. It answers
`{endorsers: [{did, handle, displayName?, endorsed, flags}], total, cursor, dropped, as_of}`:

1. `getBacklinkDids` with `limit=25` and the cursor passed through (refused
   before any call if it isn't short and URL-safe).
2. `app.bsky.actor.getProfiles` for those DIDs (at most 25, the AppView's own
   limit) on the public AppView (`APPVIEW_URL`, default
   `https://public.api.bsky.app`), with `atproto-accept-labelers` naming
   Bluesky's moderation labeler. Handles must be valid; display names are
   stripped of control and bidi characters and capped at 64 graphemes. The
   page escapes everything.
3. **Verification**, for each DID: its PDS from its DID document (cached an
   hour), then an unauthenticated `getRecord` under the request id, then one
   page of `listRecords` for records other tools wrote under another key. An
   account whose record isn't there is dropped from the page and counted in
   `dropped` ("index out of date"). The record's `createdAt` is the day
   shown.
4. **A budget per page.** The hosts are the endorsers' own choice, so one
   page may make at most `PAGE_BUDGET` (60) outbound requests on a cache
   miss, Constellation and the AppView included, and verification stops at a
   10-second deadline. Each DID is charged to the site breaker (key
   `verify`) before anything is fetched for it. DIDs left unchecked are
   dropped from the page and counted (`dropped`, and `unchecked` for those
   not checked at all). A DID whose PDS can't be found is remembered for
   five minutes, so it isn't looked up on every page.
5. Cached five minutes per (id, cursor); behind `BSKY_VISITOR_RL` per visitor
   and the site breaker (key `endorsers`) before any outbound call. The
   route takes cursors of at most 64 URL-safe characters, since each is its
   own cache key.

Constellation's order (newest first) is kept. There is no search, sort or
filter by person, no route that takes a DID or handle, and no "endorsements
by this account" view anywhere in Siren; a test checks that the only query
parameters any route reads are a conversation id (private to its account)
and this cursor. The page shows each endorser's handle linked to their
Bluesky profile, display name, the day endorsed and flags with reasons; no
avatars (they would load images from Bluesky's CDN on Siren's page).

### Flags

Shown, never used to exclude (Jason, 2026-11-09):

| kind | When | Reason shown |
|---|---|---|
| `bot` | a label `val: "bot"` whose `src` is the account's own DID (Bluesky's bot self-label, shipped 2026-03-19) | "Marked as a bot by the account (Bluesky's bot label)" |
| `moderation` | a label from `did:plc:ar7c4by46qjdydhdevvrndac` (Bluesky's moderation labeler) with `val` in spam, inauthentic, engagement-farming, impersonation, scam (D13, default, pending Jason) | "Labelled '<val>' by Bluesky moderation" |
| `new` | the AppView's `createdAt` less than `ENDORSE_YOUNG_DAYS` (30) days ago | "Account created N days ago" |
| `age-unknown` | no usable `createdAt` | "Account age unknown" |
| `no-profile` | the DID is missing from `getProfiles` (deactivated, taken down, or never had a profile) | "No Bluesky profile found" |

A negated label (`neg: true`) doesn't flag. The list's header says how many
of the accounts shown are flagged; the steward's page has a "flag breakdown"
of the first page. Not confirmed: whether the public AppView applies
Bluesky's moderation labels without the `atproto-accept-labelers` header, so
Siren always sends it.

## What Siren keeps

Nothing about endorsers. Only caches:

- the counted list (60 seconds) and endorser pages (5 minutes), in the Cache
  API per location;
- last-good counts per request, 24 hours;
- each listed DID's PDS, one hour.

No logs are kept (no `[observability]`). Live tail sees request URLs, and
with the code in the fragment, never an OAuth code. The browser keeps the
pending sign-in (10 minutes) and the session (24 hours at most) in IndexedDB
on Siren's origin, deleted on sign out.

### Deletion

Withdrawing deletes the record from the person's repo. Siren's counts and
list follow when Constellation processes the delete, usually within seconds
to minutes, and Siren's caches expire within five minutes. Copies others took
while it was public (indexes, archives, firehose consumers) are outside
Siren's control: "Record deletion is supported without leaving a trace or
'tombstone' of previous contents" in the repo itself
(atproto.com/specs/repository), but the firehose has already carried it.
Deleting a Bluesky account removes it from Constellation's index.

### What stays private

- Conversations on the paid web app, as before. The Bluesky identity never
  reaches `/api/ask` or the conversation routes: there's no Bluesky cookie,
  and the browser sends nothing Bluesky to the Worker.
- Requests and notes awaiting review.
- Steward notes the steward hasn't made public.
- Invite and email account data.
- A person's IP and browser: the browser talks to their own PDS and AS, and
  to Siren for the page and the lists, never to Constellation.

## Where the endorsing page runs

Siren has its own origin, `https://ask-siren.jason-edelman.org` (D4, settled
by Jason, 2026-11-10: "let's move to ask-siren.jason-edelman.org"). Until
then it lived at `jason-edelman.org/ask-siren`, on the same origin as Jason's
root site. That address now answers only with redirects to the same path and
query on the new origin, minus `/ask-siren` (301 for GET and HEAD, 308
otherwise; `MOVED_FROM`, `worker/moved.js`). IndexedDB, cookies and a CSP's
`'self'` are per origin, so no script on `jason-edelman.org` or on any other
subdomain can read the endorsement session or use its token, and each page's
policy covers Siren's files alone.

Both requests pages are served with:

```
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https:;
img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

with no inline script, style or handler. `connect-src https:` is needed
because the browser talks to whatever PDS each person uses.

**The chat page carries a strict CSP too** (since 2026-11-10; before that it
had none). The chat page (`worker/ui.html`, served at `<base>/`) renders
model output on the same origin as the endorsing pages, so a script that got
onto it, through a rendering bug or injected output, could have read the
endorsement session. It is now served with (for the Siren skin):

```
default-src 'none';
script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js;
style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;
connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

Its script and style moved out of the page into `worker/chat-page.js` and
`worker/chat.css`, served under `<base>/assets/<hash>/` the way the requests
page's are, and the page has no inline script, style attribute or handler.
The two scripts from the CDN are allowed by their exact URLs, not the whole
CDN, and keep their subresource integrity. The fonts are the Siren skin's: a
skin names the servers it loads from in `worker/skins.js`, and the plain skin
adds none. `connect-src 'self'`: the chat page talks to nothing but Siren.
`img-src data:` is for the favicon and the masthead's wave. Model output is
still rendered through marked and DOMPurify; under this policy, markup that
gets past them can't run script or load anything from elsewhere, and a
`style` attribute in it is ignored.

**What's left.** The steward's page, `<base>/admin`, still has inline script
and style, with only `frame-ancestors 'none'` for a policy. It escapes every
string it renders and is useful only to a signed-in steward, but it is on
the same origin; moving its script out under the same kind of policy is the
next step here. And whatever the policy, a script that got onto any Siren
page could use a live session: the narrow scope limits that to creating or
deleting the person's Siren endorsements while the token lives.

**What the move changed for endorsing.** The client_id is now
`https://ask-siren.jason-edelman.org/endorse-client-metadata.json`, the
redirect URI `https://ask-siren.jason-edelman.org/requests`, and the subjects
`https://ask-siren.jason-edelman.org/requests/<id>`. None of the old ones was
ever used (the flag was off and no endorsement existed), so no server holds
a session or a record for them. The subjects are fixed from here on ("The
record").

## Configuration

Secrets: none for Bluesky. `IP_SALT` keys the visitor and typed-account keys
for the rate limits. `INVITE_SECRET` no longer keys anything Bluesky (it
still keys invites and accounts).

| Var | Default | Meaning |
|---|---|---|
| `BLUESKY_LOGIN` | unset | `"true"` turns on counts, the endorser list, the resolver, the permalinks and the page's endorse panel (D8: name kept, default, pending Jason) |
| `PUBLIC_ORIGIN` | unset | The origin the client_id, redirect URI and subject URLs are built from, never the Host header: `https://host`, or in local dev only `http://127.0.0.1:<port>` |
| `CONSTELLATION_URL` | `https://constellation.microcosm.blue` | Another Constellation instance (a bare https origin) |
| `APPVIEW_URL` | `https://public.api.bsky.app` | Another AppView (a bare https origin) |
| `ENDORSE_YOUNG_DAYS` | 30 | Accounts younger than this are flagged `new` |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS for the resolver fallback |
| `PLC_URL` | `https://plc.directory` | The PLC directory |

Rate Limiting bindings under `env.siren` (approximate, per Cloudflare
location; [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
checked 2026-11-06): `BSKY_VISITOR_RL` (60/min per visitor: the resolver,
the endorser list), `BSKY_INPUT_RL` (3/min per account typed into the
resolver) and `BSKY_SITE_RL` (300/min site-wide breakers: `resolve`,
`counts`, `endorsers`). The old `BSKY_ACCOUNT_RL` and `BSKY_D1_RL` are gone;
namespaces 2611063 and 2611065 are free.

`blueskyReady` needs the flag, `LIMITS`, `IP_SALT`, the three bindings and a
valid `PUBLIC_ORIGIN`. With the flag on and any missing, the resolver answers
503 and logs which; the other routes answer 404, and the list is served
without counts. The client metadata (`<base>/endorse-client-metadata.json`)
needs only a valid, non-loopback `PUBLIC_ORIGIN`, so the rollout can check it
before the flag.

### D1

The `SIREN_DB` database was made for the first, server-side design. Nothing
in the Worker touches it now. Migration `0003_endorsements_move_to_repos.sql`
drops its tables and is **not applied** (Rollout, step 5). The binding stays
for the planned public board (D9, default, pending Jason). D1 Time Travel
keeps 30 days of history on Workers Paid
(https://developers.cloudflare.com/d1/platform/limits/, checked 2026-11-06),
so dropped rows stay restorable that long.

## Steward tools

- **`/admin`** shows each listed request's live count (or "unavailable"),
  the count frozen at decision, a link to its public endorser list, and a
  "flag breakdown" of the first page by kind. There's no clear button and no
  per-account tool: endorsements are other people's records, and nobody here
  can remove one.
- **Decisions** (decline, fulfil) freeze the live count into
  `endorsements_at_decision`. If Constellation can't answer, the decision
  goes through without a frozen count and says so (D10, default, pending
  Jason). With the flag off, nothing is counted or frozen.
- **CLI:** `node scripts/invites.js endorsements <id>` prints the live count
  and the endorser list's URL. `request-decline` and `request-fulfilled`
  freeze the count when the target env sets `BLUESKY_LOGIN` (with `--local`,
  `.dev.vars` counts too); `--no-endorsements` skips it.
- **Brigading** is answered by showing it: flags are public, the steward
  reads the list, endorsements only break ties, and the steward can still
  decline a request.

## Risks

| Risk | Mitigation | Remaining |
|---|---|---|
| Constellation down, slow, rate-limiting or changing its API | 4 s timeouts, last-good with "as of", "unavailable" never 0, `CONSTELLATION_URL`, a polite User-Agent, cached calls | Counts can be missing for hours; a breaking API change needs a code change; self-hosting is the fallback (D11) |
| Constellation miscounting (missed events, a stale index) | Counts are distinct accounts; endorser pages verify each record on its own PDS and drop stale ones | Counts themselves aren't verified; only listed pages are |
| A server that doesn't grant the narrow scope | The granted scope is checked; the token is revoked; a plain message | Its users can't endorse unless Jason allows `transition:generic` (D3) |
| A PDS or AS without CORS | A plain message; the resolver fallback covers handle lookup | Some self-hosted users can't endorse from the web page |
| Token theft by XSS on Siren's origin | Siren's own origin, apart from jason-edelman.org's other pages (D4); strict CSPs with no inline script on the requests pages and the chat page, which renders model output; the narrow scope, a non-extractable key, a 24 h cap, sign out revokes | While the token lives, a script that got onto a Siren page can create or delete that person's Siren endorsements; `/admin` has no strict CSP yet |
| Sybil and bot endorsing | A public list with flags; counts break ties only | Many established accounts held by one person still count, and everyone can see them |
| Harassment of endorsers, now that handles are listed | That's the point of public-first, and the copy says so plainly before sign-in. Jason accepted this risk (2026-11-09): "I'm counting on Bluesky's T&S team, because it beats publishing people's emails." Flags and the steward's ability to decline a request are the only extra mechanisms | Endorsing is a public act |
| Records for unlisted ids, or crafted fields | Only listed ids are queried; record text isn't displayed; dates parsed and bounded | |
| Guessable request ids | Random 80-bit ids since 2026-11-09 (D12); the steward's one-time migration covers older requests | A request migrated after it was public keeps its old id as its GitHub issue marker (already public there) |
| An NSID move strands old records | The documented dual-read window and in-page move | Records whose authors never return stay under the old NSID |
| Servers caching client metadata | A new client_id URL for the new scope | Changing the scope again needs the same care |

## Rollout

1. **Request ids.** `node scripts/invites.js request-ids` (dry run), then
   `request-ids --apply`, then run the issue sync once
   (docs/request-sync-routine.md) so issue bodies show the new ids.
   `node scripts/bsky-probe.js --account <handle>` reports any legacy id
   still on the public list.
2. **Publish the Lexicon** and the `_lexicon` TXT ("Publishing the Lexicon").
3. **Deploy with the flag off** and check the metadata URL,
   `https://ask-siren.jason-edelman.org/endorse-client-metadata.json`: 200,
   JSON, `client_id` equal to the URL, the scope equal to the constant
   (`scripts/bsky-probe.js` checks all three and sends one PAR).
4. **A live probe with a real bsky.social account,** from a local
   `wrangler dev` with the flag on (see "Local development") or a preview
   with the flag on: sign in, and confirm the session is created (the page
   refuses a token whose granted scope lacks the repo permission, so a
   successful sign-in is the proof). Repeat on one self-hosted PDS if
   available. Then endorse a test request; Constellation should show it
   within a minute; the endorser list should show it, verified; withdraw;
   it disappears. Record the result and the date here.
5. **D1.** Check that the old tables are empty:
   `npx wrangler d1 execute SIREN_DB --env siren --remote --command "SELECT (SELECT count(*) FROM endorsements), (SELECT count(*) FROM bsky_rate_counts), (SELECT count(*) FROM siren_d1_budget)"`,
   record the result here, then apply `0003`:
   `npx wrangler d1 migrations apply SIREN_DB --env siren --remote`.
6. **Flip the flag:** a PR adding `BLUESKY_LOGIN = "true"` under
   `[env.siren.vars]`.
7. Date every platform number in this doc.

Not tested before this change: a live OAuth sign-in against bsky.social (the
tests run offline against fakes of the AS, the PDS, Constellation and the
AppView), whether bsky.social grants the granular scope today (its metadata
can't list parameterised scopes), and the browser's IndexedDB code (Node has
none; the same interface runs in memory in the tests).

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
   Without `--local-upstream`, wrangler rewrites `request.url` to the env's
   route origin.
3. Open `http://127.0.0.1:8787/requests`, not `localhost`: the
   authorization server sends you back to `127.0.0.1`, and IndexedDB is per
   origin.
4. With a loopback origin, the client is the atproto localhost client:
   `http://localhost?redirect_uri=<the 127.0.0.1 requests page>&scope=<the scope, encoded>`.
   Servers synthesize its metadata, so the metadata route returns 404.
5. Counts and endorser lists call the real Constellation and AppView; with
   no records for `127.0.0.1` subjects, they're 0.
6. Tests need none of this: `npm test` uses fakes of the atproto network
   (DNS, PLC, the AS, the PDS's reads and writes, Constellation and the
   AppView), KV, the limiters and the cache (`test/fake-atproto.js`), and
   runs the browser client in Node against an in-memory store.

## Decisions for Jason

Settled 2026-11-09: the NSID; counting through a plain Constellation call;
endorsing in the browser only; Bluesky's bot self-label plus account age;
flag, never exclude; public-first; the paid tier keeps the private chat;
endorsing needs only a Bluesky sign-in. D1 (publish from
`did:plc:zz4wcje4a2nbbtc7pdoth3f2`), D12 (random ids now) and the harassment
risk are settled too. D4 was settled on 2026-11-10: Siren moved to its own
origin, `ask-siren.jason-edelman.org` ("Where the endorsing page runs").

Built as **default, pending Jason**:

- **D2** No refresh token; a 24-hour session cap.
- **D3** No `transition:generic` fallback; a clear message instead.
- **D5** Constellation's User-Agent names the project and its public URL
  only, no personal contact.
- **D6** Count every account.
- **D7** Fulfilled requests show the frozen count and the live count.
- **D8** Keep the flag name `BLUESKY_LOGIN`.
- **D9** Keep the `SIREN_DB` binding for the planned board; migration 0003
  drops the old tables, unapplied.
- **D10** Allow deciding while Constellation is down, without a frozen count.
- **D11** The public Constellation instance for now.
- **D13** Moderation labels that flag: spam, inauthentic, engagement-farming,
  impersonation, scam.
