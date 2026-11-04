# Open standards: what Siren and Cairn already reinvent

Status: **research, nothing built.** 2026-11-04. Jason: "take a look at the
open-standards work in scout-harness and let's investigate whether some of this
applies to Siren/Cairn. I see us on the way to reinventing several wheels."

The principle is the one behind Scout's map (`scout-harness/proposals/open-standards.md`,
`open-standards-design.md`): where we've built something an open standard
already specifies, take the standard, so other people's tools work on our
records and our own surface shrinks. Scout's adversarial review added the
honest corollary: adopting a standard rarely shrinks the code at first, because
existing records must keep working. The payoff is that others can use the
records, not a smaller line count.

Marks: **[verified]** checked today against the source; **[memory]** from
prior knowledge, to check before building.

## The map

| What we built | The standard it resembles | How close | Verdict |
|---|---|---|---|
| The trace (`Trace.record`: tool, url, query, rows, ms, ok/error), written by code | **OpenTelemetry** spans with the **GenAI semantic conventions** (`chat`, `execute_tool`, `gen_ai.*`) | close: our steps are spans in all but name | adopt the names now, the same ones Scout adopts; export later |
| Siren's tools (`block_report`, `trees_on_my_block`, `case_file`, …) and the bring-your-own-agent plan (`docs/co-agency.md`, unmerged) | an **MCP server**, stateless (revision 2026-07-28) | exact: our tool definitions are already JSON-Schema tool specs | adopt, read-only, with Scout's pattern |
| Issue #6: plugins from an approved registry, loaded on demand | the **MCP Registry** (`server.json`, streamable-HTTP `remotes`, public `/v0/servers` API) [verified] | close: a registry of remote tools already exists; "approved" is our allowlist on top | adopt for *non-Socrata* sources only (see below) |
| Generic mode: Socrata's Discovery API to find a city's datasets | **DCAT-US v1.1** (Project Open Data `data.json`). data.norfolk.gov publishes one: `conformsTo` project-open-data v1.1, 167 entries [verified]. CKAN and ArcGIS Hub portals publish the same [memory] | close: it's the catalog layer, vendor-neutral | adopt: the way past "Socrata only" |
| A case-file finding's `quote` and `source.url` | **W3C Web Annotation**, `TextQuoteSelector` {`exact`, `prefix`, `suffix`} (W3C Recommendation, 2017) [memory] | exact for the quote; we lack prefix/suffix to disambiguate | adopt as the export shape; add prefix/suffix |
| `found_by`, `checked`, "derived from this source" | **W3C PROV-O** (`wasAttributedTo`, `generatedAtTime`, `wasDerivedFrom`) [memory] | exact in meaning | adopt in the export view (JSON-LD) |
| The verifier re-fetching live pages, and failing when a page vanishes or blocks us (Dominion, Municode) | **Memento** (RFC 7089) and web archives (Internet Archive Save Page Now) [memory]; content addressing with **DASL CIDs** (Scout's lib) | gap, not a duplicate: we have no durable copy of what we quoted | adopt: archive each source at check time and record the snapshot's CID |
| Cairn's trust labels ("Claimed by", "Certified by", "Published by") | **atproto labels** (`com.atproto.label`, served by a labeler such as Ozone) [memory]; for portable certificates, **W3C Verifiable Credentials 2.0** [memory: Recommendation in 2025] | close | labels first (Cairn is atproto); VCs only if institutions need to carry a certificate elsewhere |
| Findings as records in contributors' own repos (the "common memory" plan) | atproto **Lexicon** records with `strongRef` (uri + cid) | exact for the plan | when Cairn's PDS exists; Lexicon NSIDs under a domain we own |
| "Corrections are never removed"; steward decisions that cite rules | a **transparency log** (C2SP checkpoints, signed notes, witnesses) | close: today git history is our log, and it can be rewritten | reuse Scout's tlog when it's built (its step 4); don't build a second one |
| The `iqm2` adapter for Norfolk's meeting portal | **civic-scraper** (Big Local News) | close, but its README says it "is no longer being publicly maintained" [verified] | keep ours |
| Representatives and districts from the address dataset | **Open Civic Data** division IDs (`ocd-division/country:us/state:va/place:norfolk`) [memory] | close for identifiers | adopt the IDs (cheap); skip the rest of OCD/Popolo for now |
| Privacy policy: excluded, restricted, withheld columns, suppressed rows, query rewriting | statistical disclosure control (practice, not a wire standard); **Cedar** for who-may-do-what | partial: Cedar decides access, not query rewriting or cell suppression | keep ours |
| Source requests and bounties | GitHub issues; **Open Collective** (chosen); **CommonGrants** for grant calls (chosen, SkyFund) | already standards | nothing new |
| Email sign-in | atproto OAuth (later, with Cairn's PDS); passkeys | — | keep magic links through beta |
| 311 and permits | **Open311 GeoReport v2**, **BLDS** [memory: both older, uneven adoption] | close in shape | watch; Norfolk's 311 is restricted anyway |

## Adopt soon, in this order

**1. Siren as a read-only MCP server.** Scout's step 2 is the template, and it's
already built (scout-harness #84): `createMcpHandler` from the MCP server SDK,
a fresh server per request, no sessions, a sibling Worker with read-only
bindings, and "record before reveal" (the trace is written before the answer
leaves). For Siren this *is* the co-agency plan: people's own agents (Claude,
ChatGPT, anything MCP) call `block_report`, `case_file`, `trees_on_my_block`.
What makes it Siren's and not generic: each tool result carries its own
code-written trace, hand-off and caveats, so the voice contract and the
provenance survive into someone else's model. The privacy policy is enforced
in our tools, so it holds there too. Auth: the invite and account system we
have, or Cloudflare Access as Scout uses.

**2. DCAT-US catalogs for generic mode.** Today "any city" means "any Socrata
domain". Reading `data.json` lets generic mode discover datasets on CKAN and
ArcGIS Hub portals too. The query layer stays per-vendor (SODA for Socrata;
CKAN's DataStore API; ArcGIS's FeatureServer), with the people-finding policy
applied the same way. Start with discovery only.

**3. Findings that survive their sources.** We hit this today: Dominion's site
refuses CI, and Municode refuses everyone. When the verifier checks a quote,
it should also:
- save a snapshot to the Internet Archive (Save Page Now) and record the
  snapshot URL (Memento);
- record the DASL CID of the bytes it read (Scout's `lib/dasl.mjs`);
- add the quote's `prefix` and `suffix`, so the quote is a W3C
  `TextQuoteSelector`.

Export each case file as Web Annotations with PROV in JSON-LD. Any annotation
tool (Hypothesis, for one) could then show a finding on the page it quotes.

**4. OpenTelemetry GenAI names for the trace.** Rename the fields we already
record to `gen_ai.*`, the same names Scout adopts, so one dashboard reads both
agents. Exporting over OTLP waits, as it does for Scout.

## Later, with Cairn

- **atproto labels** for the trust contract's source labels, from Cairn's own
  labeler.
- **Lexicon** records for findings in contributors' repos, which is the
  collaborative memory Jason described.
- **The transparency log**, shared with Scout, for the commons record and
  steward decisions.
- **MCP Registry for plugins (issue #6), but only for sources outside the
  portal.** A remote MCP server runs code we can't see, so our trace records
  the call but not what the server did inside, and our privacy policy can't
  reach in. So: steward-approved servers only, read-only, never for Socrata
  data (that stays in our client, under our policy), and each answer says
  which outside server it used. For portal data, issue #6's bundled and
  declarative options still hold.

## Don't

- **Cedar for the privacy policy.** It's for access decisions; ours is query
  rewriting and cell suppression.
- **Durable-execution frameworks.** Same reason as Scout: no open standard,
  and the state would live outside our record.
- **civic-scraper** for meetings. Unmaintained.

## The second wheel: Scout and Siren reinventing each other

Scout already has, or is about to have:
- DASL CIDs (`lib/dasl.mjs`, #83);
- a stateless MCP server pattern (#84);
- GenAI span names (its step 3);
- a transparency log (its step 4).

Siren needs each of them. Building them twice is the more immediate
reinvention. The options:
- **a small shared package** (one repo, used by both);
- **vendoring with a pinned upstream** (copy, then note the upstream commit).

Scout's design review warns that independent verifiers should stay independent
(its `replay-log` has its own CID encoder), so a verifier keeps its own copy
whichever we pick.

## Questions for Jason

1. First item: the MCP server (co-agency), DCAT (more cities), or durable
   findings (archive and CIDs)?
2. A shared package with Scout, or copies?
3. A domain for Lexicon NSIDs and labels: `cairn-civic.org`, once it's
   registered?

## Sources

- Scout's map and design: `jedelman/scout-harness`, `proposals/open-standards.md`,
  `proposals/open-standards-design.md`; session logs in `claude-memory`,
  `conversations/2026-11-03-scout-ram-stage2-open-standards.md` and
  `conversations/2026-11-04-scout-step0-cids-mcp.md`.
- Norfolk's DCAT-US catalog: https://data.norfolk.gov/data.json (checked
  2026-11-04: `conformsTo` https://project-open-data.cio.gov/v1.1/schema, 167
  datasets).
- MCP Registry: https://registry.modelcontextprotocol.io/ and its API
  `/v0/servers` (entries use `server.json` schema 2025-12-11, with
  streamable-http `remotes`; checked 2026-11-04).
- civic-scraper: https://github.com/biglocalnews/civic-scraper (README:
  "no longer being publicly maintained"; checked 2026-11-04).
- To check before building: W3C Web Annotation Data Model
  (https://www.w3.org/TR/annotation-model/), PROV-O
  (https://www.w3.org/TR/prov-o/), Memento RFC 7089, Internet Archive Save
  Page Now, W3C VC Data Model 2.0, atproto labels
  (https://atproto.com/specs/label), Open Civic Data division IDs, Open311,
  BLDS.
