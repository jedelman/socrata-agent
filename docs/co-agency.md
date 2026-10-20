# Co-agency: bring your own agent (plan, 2026-10-20)

Status: plan only. Nothing here is built. Jason liked the architecture
(2026-10-20); the cross-project version is in
`claude-memory/patterns/bring-your-own-agent.md`.

## The idea

Today Siren runs its own model (`POST /api/ask`, OpenRouter, a daily budget).
Co-agency moves the conversation to the person's own chat agent (ChatGPT,
Gemini, claude.ai, free tiers included), and Siren keeps its judgment in code.

- **Their agent holds the person:** the conversation, what they care about,
  where they live. Siren never needs that context, and what it doesn't hold it
  can't leak.
- **Siren holds the city:** what it found, from which dataset and query, the
  trace, the hand-off links and contacts. On its own domain, Siren is the
  authority on "what I found."

Siren's side needs no model. The tools already run without one
(`socrata-agent tool block_report '{"address":"810 Union St"}'` takes no key),
and its judgment is already in code: `voice.js`, the exclusions,
`Trace.record`. Inference moves to the person's own tier. The hosted chat stays
as an optional fallback.

## Shape

- **Read endpoints:** `GET /tool/<name>?<params>` on the worker, the same tools
  the CLI's `tool` command runs, with the same per-city exclusions and plugins.
  Read-only, keyed by place, never by person. Cache Socrata responses; they
  change slowly.
- **The same URL in a browser** renders a readable report with no model
  involved. That page is the backstop when an agent can't fetch, and the record
  of what Siren actually said when an agent paraphrases.
- **Each response, in order:**
  1. A short summary written by code from templates, in Siren's voice
     ("Siren found 2 open work orders on this block…"), marked "quote this as
     written."
  2. The trace: every query, with row counts and rerun links.
  3. The hand-off: dataset pages, full CSVs, exact-rows CSVs, API docs, and
     contacts.
- **Siren asks back.** An ambiguous address returns a question ("810 Union St
  matches two parcels: …") for the person's agent to put to them, not a guess.
- **Siren declines.** A people-finding request returns a refusal with the
  reason. Because the tools can't do it, no prompt can route around it.
- **Disagreements are checkable.** "I found no permit for this address in
  [dataset] as of [date]; here's the query, check it yourself." That makes a
  disagreement between the person's agent and Siren a fact anyone can look up.

## The voice contract under co-agency

`voice.js` checks Siren's own model today. Under co-agency, someone else's
model does the talking, and nothing checks its words. A weak model can flatten
"I found no records" into "nothing's happening on your block." The
mitigations: Siren's summary is written in code, so it passes the voice check
by construction; it's short and attributed, so it survives being quoted; and
the browser page is there for anyone to check against. The contract becomes
something Siren offers, not something it can enforce. Say so in the docs.

## Unknowns (test first)

- Which free agents will fetch a URL they built themselves. Some fetch tools
  only open URLs the user pasted or that came back from a search. If an agent
  won't fetch, it can still print the link for the person to open.
- Which free tiers allow a custom MCP connector. MCP would be the richer
  protocol for asking back.
- How well agents relay a summary marked "quote as written."

## Open questions (Jason's)

1. Is the person's agent Siren's main surface, with the hosted chat as the
   fallback, or the reverse? If it's the main one, the template summary has to
   stand on its own.
2. Rate limits: reads are cheap and cacheable, and agent traffic comes from
   the providers' shared servers. Is a per-IP limit useful here, or only a
   global one?
