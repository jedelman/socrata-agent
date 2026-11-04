# Runs as messages: a conversation is its own record

Status: **proposal, nothing built.** Jason, 2026-11-04: "Take a look at how we do continuations with
Scout (runs as messages). We can and should do the same for Siren, especially for traceability."

Scout's design is in `jedelman/scout-harness`, `proposals/runs-as-messages.md` and its stage specs
(read at commit `a167417`). This copies its ideas, not its code, per Jason's rule for the two agents:
copies now, convergence later.

## What Scout does

A run is a process, and the log is its mailbox. Every event (a model turn, a tool result, a timer,
the end) is an entry, and each entry names the hash of the one before it. A unique index on
`(subject, parent)` makes that chain a program counter: two writers racing on the same step can't
both append, and a step that crashed before appending simply runs again. The loop becomes a pure
reducer, `step(state, event) → effect`, so folding the entries recorded so far gives back the exact
request the run makes next. Tool results are stored as references or hashes, never as other
people's words. Scout's stages: the loop as a reducer (built), the loop writes its mailbox (built),
crash recovery, then one step per invocation, which releases the connection.

## Why Siren needs it

- **Traceability across turns.** Today each answer has its own trace, built in memory. A follow-up
  answer sees earlier results through a `<data>` block and one trace line ("results kept from
  earlier in this conversation"). Nothing ties a sentence in turn 3 to the bytes it came from in
  turn 1. As a chain, every answer names its parent, and every result the model was shown is
  pinned by the CID of its exact bytes.
- **Follow-ups without trimming the record.** `worker/conversations.js` keeps 8 turns, 6,000
  characters per tool result, 40,000 in all. The model still needs a budget, but the record
  shouldn't be cut down to it.
- **Clarifying questions are structural.** The person's reply is the child of Siren's question.
  The server can tell a reply from a new question by the parent, not by guessing, which is what
  "a clarification reply doesn't count against the daily limit" needs.
- **Answers that outlive the request.** Today an answer is one HTTP request held open for 10–30
  seconds, and a closed tab or a dropped connection loses it. With steps, the run finishes
  anyway, and the answer waits in the conversation.
- **The Bluesky bot.** A mention is a message; the reply is the child of the mention. That's
  Scout's channel shape, and a bot needs async runs anyway.

## Where Siren differs from Scout

| | Scout | Siren |
|---|---|---|
| Runs at once | one: "one mind, one thread" | many: one per conversation, in parallel. Within a conversation, one at a time: a follow-up waits for the answer before it. |
| How long the record lasts | permanent; D1 refuses UPDATE and DELETE | a private conversation lasts 7 days, or until the person forgets it. It is append-only while it lives, then deleted whole. |
| What's in a tool result | other people's posts and words | public records, but a query can carry a home address (`$where=address='…'`) and the question usually does |
| Where it lives | one D1 table, `log` | a Durable Object per conversation, with its own SQLite: one writer, no races, and `deleteAll()` ends it atomically, alarm included (compatibility date 2026-09-01 is past the 2026-02-24 change). SQLite Durable Objects are on the Workers Free plan. |

**No permanent record of private conversations.** "Conversations stay private to the user, Siren
only remembers facts into her common memory" (Jason). So nothing from a private conversation
outlives it: no hashes of questions, no query text. A permanent count of runs, steps and cost per
day, with no conversation id, is the most it leaves behind, and that's question 2.

## The design

One Durable Object per conversation, named by the conversation id. It holds two tables:

- **`entries`**: `seq`, `at`, `author` (`person`, `siren`, `code`), `kind`, `parent`, `hash`,
  `body` (JSON). `UNIQUE(parent)`. `hash` = SHA-256 over the stored columns joined by newlines,
  exactly as Scout's `entryHash`, so a verifier hashes what's stored and nothing is re-serialized.
  The first entry's parent is `genesis`.
- **`blobs`**: `cid`, `bytes`. The exact bytes behind each result, by DASL raw CID (Siren
  already computes these for case files). Deleted with the conversation.

| Kind | Author | Body |
|---|---|---|
| `ask.question` | person | the text. Its parent is the entry it answers: the previous answer (a follow-up) or Siren's question (a clarification reply). |
| `ask.turn` | siren | model, the text, the tool calls, usage and cost; the SHA-256 of the exact request body sent; thinking as a hash and length |
| `ask.call` | code | one outbound request, as `Trace.record` writes today: tool, url, query, dataset, ok, rows, ms, error, plus the CID of the response bytes |
| `ask.result` | code | one tool result handed to the model: tool, args, CID and length of the exact string, and the `ask.call` entries it was built from |
| `ask.voice` | code | the voice violations found, and that a rewrite was asked for |
| `ask.clarify` | siren | a question with options, when Siren asks instead of answering (the `clarify` tool) |
| `ask.answer` | siren | the answer text, which turn holds it, the voice result, the hand-off (datasets, records, contacts) |
| `ask.stopped` | code | why a run ended early, and how many entries it wrote |

**The trace is derived from the chain.** The trace under an answer is its `ask.call` entries, so
it can't disagree with the record. It's no longer a parallel array.

**A follow-up's context is a fold.** The history the model sees is built from the entries: earlier
questions and answers, plus the `ask.result` strings behind them, read back from `blobs` by CID.
The model still gets a trimmed view within a budget, as now. But the trim happens when the context
is built, not when the record is written. The answer's record lists the earlier results it was
shown, by CID, replacing the "results kept from earlier" line.

**The person can take the record with them.** `GET /api/conversation?id=…` returns the chain with
its hashes, and a small verifier checks it offline. "Forget this conversation" and the 7-day
expiry both call `deleteAll()`.

**Visitors** (no account) keep today's behavior: the browser sends back the text of recent turns,
and nothing is stored. Question 3.

## The path

Each stage ships on its own and is proven before the next, as Scout's were.

1. **The chain, recorded alongside today's loop.** `ask()` appends entries as it runs. The
   conversation lives in its Durable Object instead of KV, and nothing the model sees changes.
   **Proof:** for every test run, the trace derived from the chain equals today's trace, byte for
   byte; every hash recomputes; a second writer racing a step is refused; forgetting leaves nothing.
2. **Follow-ups folded from the chain.** `historyFrom()` reads entries instead of the KV blob.
   **Proof:** on the existing conversation tests, the folded history equals today's, except that
   results now come back by CID and in full.
3. **The loop as a reducer.** `agent.js`'s loop becomes `step(state, event) → effect`. The
   providers become pure request builders and response parsers, with no message state of their
   own. **Proof:** a differential test against a frozen copy of today's loop, request for request,
   as Scout's stage 1 did, plus the refire property: folding any prefix of the entries gives back
   the exact next request.
4. **One step per alarm.** The Durable Object's alarm drives the run, and the web request returns
   at once with the conversation id. The page streams entries as they land, so each query
   appears in the trace as it runs, and the box below the thread comes with it. A run whose last
   step crashed is re-fired. **Proof:** kill the run at every step boundary; it ends as an
   uninterrupted run does.
5. **The Bluesky bot**, on the same engine, with the public rules (block level only, mentions
   only, daily caps, a kill switch) checked on every send.

Stages 1 and 2 give the traceability. Stage 4 releases the connection, and stage 5 needs it.

## Costs and risks

- **Every step must be safe to run twice** (stage 4). Socrata reads are, and a run writes nothing
  else: `suggest_data_source` only proposes, and the person files the request from the page. A
  write added to a run later needs a guard: make it the child of the turn that asked for it, so
  `UNIQUE(parent)` allows one.
- **Thinking blocks.** The Anthropic provider sends each assistant turn back whole, thinking
  included, and the API checks a thinking block against the conversation that produced it. A
  re-fired step must send exactly the same blocks. So the in-flight messages are kept whole in the
  Durable Object while a run is active and dropped when it ends; only their hashes stay in the
  chain.
- **A Durable Object per conversation** costs a hop and a small amount of storage, deleted at 7
  days. Unmeasured; likely milliseconds against model turns of seconds.
- **Existing KV conversations** expire within 7 days. Let them, rather than migrating them.
- **This is the core loop.** Stage 3 rebuilds `agent.js` and both providers. That's why it comes
  after the record is in place and proven, not before.

**A gap this exposes, named now:** the daily limits are KV counters, read then written. Two
questions sent at once can both pass at the last allowed count. A per-account Durable Object
would make that count exact. It's separate work.

## Questions for Jason

1. **The order.** Traceability first (stages 1–2, the record alongside today's loop), then the
   reducer (3)? Scout did the reducer first because its crash recovery needed the proof; Siren's
   first need is the record.
2. **What outlives a private conversation?** Nothing, or a daily count of runs, steps and cost
   with no conversation id?
3. **Visitors without an account:** keep text-only follow-ups stored nowhere, or give them a
   conversation too, under a cookie, with the same 7-day expiry?
4. **The public record for Bluesky:** permanent, in an append-only D1 table like Scout's `log`,
   and exported to the repo? It would hold only block-level text, checked as it's written.
