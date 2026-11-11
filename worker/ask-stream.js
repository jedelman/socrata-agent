// Streamed answers: POST /api/ask with `Accept: application/x-ndjson` gets one
// JSON object per line while the answer is worked out, then the answer:
//
//   {"type":"start","conversation":"<id>"}        signed-in accounts only: the
//                                                 conversation this turn is saved to
//   {"type":"thinking","step":0,"text":"..."}     a delta of the model's summarized
//                                                 thinking (Claude models only)
//   {"type":"notes_capped"}                       once, when MAX_NOTE_CHARS is reached
//   {"type":"discard","step":0}                   the model declined that step: drop
//                                                 its notes (the API says to discard
//                                                 a declined partial); with
//                                                 "reason":"fallback", another model
//                                                 continues the step
//   {"type":"tool","step":0,"name":"block_report","label":"..."}
//   {"type":"rewrite","step":2,"label":"..."}     the voice check's rewrite
//   {"type":"final","body":{...}}                 exactly the body POST /api/ask
//                                                 returns without streaming
//   {"type":"error","status":502,"body":{...}}    exactly that path's error body
//
// Tool and rewrite lines are written by code from the agent's own events: a
// fixed label per tool, never the model's arguments or text. The thinking is
// the model's summary of its own reasoning, shown live and labeled as such on
// the page; it is never saved, never enters the trace, the answer, the voice
// check or the conversation, and at most MAX_NOTE_CHARS of it is sent.

export const NDJSON = 'application/x-ndjson';
/** Thinking characters sent per answer, at most. */
export const MAX_NOTE_CHARS = 20000;

/** Whether this request asked for a stream. */
export const wantsStream = (req) => (req.headers.get('Accept') || '').toLowerCase().includes(NDJSON);

/** WORKING_NOTES = "off" turns the streamed notes off (default on); the page then gets the JSON answer. */
export const workingNotesOn = (env) => String(env.WORKING_NOTES ?? '').trim().toLowerCase() !== 'off';

// What each tool does, in a few words, for the notes panel. Tools not listed
// here get a generic line with their (code-declared) name.
export const TOOL_LABELS = Object.freeze({
  search_datasets: 'Searching the open data catalog',
  describe_dataset: "Reading a dataset's description and columns",
  query_dataset: 'Querying a dataset',
  lookup_address: 'Looking up the address',
  block_report: 'Reading what is on file for the address and its block',
  get_legislation: 'Reading a legislative record and its votes',
  find_legislation: 'Searching agenda items from public meetings',
  upcoming_meetings: 'Checking upcoming public meetings',
  suggest_data_source: 'Noting a source that would answer this',
  note_unanswered: "Noting what the records I read can't answer",
  offer_followup: 'Offering to look into a source next',
  prior_research: 'Checking where earlier research looked',
  water_on_my_block: 'Reading flooding and stormwater records for the address',
  sponge_site_screen: 'Screening city sites for stormwater projects',
  trees_on_my_block: 'Reading street-tree records',
  litter_on_my_street: 'Reading litter records',
  case_file: 'Reading a case file of checked findings',
  parcel_inventory: 'Reading the map layers for the parcel',
  ordinance_lookup: "Looking in Norfolk's ordinances",
  budget_book_lookup: 'Looking in the adopted budget books',
  budget_for: 'Reading the budget datasets',
  capital_projects: 'Reading planned capital projects',
  city_news: "Reading the City's announcements",
});
export const REWRITE_LABEL = 'Rewording the answer to say only what the records show';

export const toolLabel = (name) => TOOL_LABELS[name] || `Using the ${name} tool`;

/**
 * The agent's onEvent, turned into stream lines. `known` is the set of tool
 * names this answer declared: a call to any other name gets no line (the name
 * would be the model's text). Thinking stops after `maxChars` characters.
 */
export function noteEvents(send, { known, maxChars = MAX_NOTE_CHARS } = {}) {
  let left = maxChars;
  let capped = false;
  return (e) => {
    if (!e || typeof e !== 'object') return;
    const step = Number.isInteger(e.step) ? e.step : null;
    if (e.type === 'thinking') {
      if (capped || typeof e.text !== 'string' || !e.text) return;
      const text = e.text.slice(0, left);
      left -= text.length;
      if (text) send({ type: 'thinking', step, text });
      if (left <= 0) {
        capped = true;
        send({ type: 'notes_capped' });
      }
    } else if (e.type === 'tool') {
      if (!known?.has(e.name)) return;
      send({ type: 'tool', step, name: e.name, label: toolLabel(e.name) });
    } else if (e.type === 'rewrite') {
      send({ type: 'rewrite', step, label: REWRITE_LABEL });
    } else if (e.type === 'refusal') {
      send({ type: 'discard', step });
    } else if (e.type === 'fallback') {
      send({ type: 'discard', step, reason: 'fallback' });
    }
  };
}

/**
 * A streamed response. `work(send)` runs the answer and sends its lines. It
 * runs under ctx.waitUntil, so a reader who goes away doesn't stop it at
 * once, but Cloudflare extends it only about 30 seconds past their leaving:
 * work that must survive (spend) is written as it happens, not at the end.
 * `send` never waits on the reader and never throws; once the reader is gone,
 * lines are dropped.
 */
export function streamResponse(ctx, work) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  const send = (event) => {
    if (!open) return;
    writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {
      open = false;
    });
  };
  const done = (async () => {
    try {
      await work(send);
    } catch (err) {
      console.error('streamed answer failed', err);
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  if (ctx?.waitUntil) ctx.waitUntil(done);
  return new Response(readable, {
    headers: {
      'Content-Type': `${NDJSON}; charset=utf-8`,
      // no-transform: nothing on the way compresses (and so buffers) the lines.
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
