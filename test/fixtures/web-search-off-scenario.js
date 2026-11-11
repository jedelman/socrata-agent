// The web-search-off scenario test/web-search.test.js holds byte-identical to
// the code before web search: Siren's deployment (its plugins and prompt) on
// a Claude model with server-side fallbacks, with a tool step, a fallback
// mid-stream, thinking events and a voice rewrite. Every request body sent to
// the Messages API is kept (with the anthropic-beta header), and the answer.
// web-search-off-snapshot.json is this scenario's output from a286524 (main
// before web search). Timings are zeroed; usage carries no cache reads, so
// the Sonnet 5.5 cache-read price fix doesn't move the cost.
//
// Siren as it was at the snapshot: tools added to Siren since then, and the
// prompt lines that name them, are left out, so the comparison with a286524
// still covers everything else. Add a tool's name here when it joins Siren.
import { PARTIAL_PROMPT, LINK_LINE, FOLLOWUP_LINE } from '../../src/prompt.js';
import { stripAddedCases, enumAtSnapshot } from './cases-at-snapshot.js';
import { readFileSync } from 'node:fs';

export const ADDED_SINCE_SNAPSHOT = Object.freeze(['city_news']);
// Base-prompt lines added since the snapshot (each joins every deployment's
// prompt, so it can't be left out by tool): stripped from the prompt and the
// requests before comparing. Add the exported text here when one joins.
export const PROMPT_ADDED_SINCE_SNAPSHOT = Object.freeze([PARTIAL_PROMPT, LINK_LINE, FOLLOWUP_LINE]);
// Core tools added since the snapshot (every deployment gets them): left out
// of the requests' tool lists before comparing. Add a name when one joins.
export const CORE_TOOLS_ADDED_SINCE_SNAPSHOT = Object.freeze(['offer_followup']);
const stripAdded = (s) => PROMPT_ADDED_SINCE_SNAPSHOT.reduce((t, x) => t.split(x).join(''), s);
// Siren plugin tools whose own definition (description or parameters) changed
// since the snapshot: compared at the definition the snapshot recorded, so the
// rest of every request is still compared byte for byte. Each one's new
// definition is tested in its own test file. Add a name when one changes.
export const PLUGIN_TOOLS_CHANGED_SINCE_SNAPSHOT = Object.freeze(['capital_projects']);
export const SNAPSHOT_TOOLS = new Map(
  JSON.parse(readFileSync(new URL('./web-search-off-snapshot.json', import.meta.url), 'utf8')).requests[0].body.tools.map((t) => [t.name, t]),
);
const atSnapshot = (t) => (PLUGIN_TOOLS_CHANGED_SINCE_SNAPSHOT.includes(t.name) ? SNAPSHOT_TOOLS.get(t.name) : t);

function sirenAtSnapshot(siren) {
  const added = (text) => ADDED_SINCE_SNAPSHOT.some((name) => text.includes(name));
  return {
    ...siren,
    plugins: siren.plugins.filter((p) => !ADDED_SINCE_SNAPSHOT.includes(p.name)),
    prompt: siren.prompt.split('\n').filter((line) => !added(line)).join('\n'),
  };
}

export async function webSearchOffScenario({ ask, systemPrompt, getCity, applyConfig, definePlugin, siren: current, claudeResponse, extra = {} }) {
  const siren = sirenAtSnapshot(current);
  const city = applyConfig(getCity('norfolk'), siren);
  const plugins = siren.plugins.map(definePlugin);
  const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const msg = (content, stop_reason) => ({ id: 'msg_s', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason, stop_details: null, usage });
  const replies = [
    msg([
      { type: 'thinking', thinking: 'Look for tree datasets.', signature: 'sig-1' },
      { type: 'text', text: 'Let me look. ' },
      { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
      { type: 'tool_use', id: 'toolu_s1', name: 'search_datasets', input: { query: 'trees' } },
    ], 'tool_use'),
    msg([{ type: 'text', text: 'There are no tree datasets.' }], 'end_turn'),
    msg([{ type: 'text', text: 'I found no tree datasets.' }], 'end_turn'),
  ];
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/v1/messages')) {
      const i = requests.length;
      const body = JSON.parse(init.body);
      if (Array.isArray(body.tools)) body.tools = body.tools.filter((t) => !CORE_TOOLS_ADDED_SINCE_SNAPSHOT.includes(t.name)).map(atSnapshot);
      requests.push({ beta: new Headers(init.headers).get('anthropic-beta'), body });
      return claudeResponse(init, replies[Math.min(i, replies.length - 1)]);
    }
    if (u.includes('/api/catalog/')) return new Response(JSON.stringify({ results: [], resultSetSize: 0 }));
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  };
  const events = [];
  const out = await ask({
    question: 'Any tree data?', city, plugins, apiKey: 'sk-ant-test', model: 'claude-sonnet-5-5', effort: 'medium',
    fetchImpl, thinkingEvents: true, onEvent: (e) => events.push(e), ...extra,
  });
  // The prompt holds the date: any date reads "(today)".
  // Case files added since the snapshot are left out of case_file's description and enum.
  const zero = (k, v) => (k === 'ms' ? 0 : k === 'enum' ? enumAtSnapshot(v) : typeof v === 'string' ? stripAddedCases(stripAdded(v)).replace(/ · \d+ ms · /g, ' · 0 ms · ').replace(/Today is \d{4}-\d{2}-\d{2}\./g, 'Today is (today).') : v);
  return JSON.parse(JSON.stringify({ systemPrompt: systemPrompt(city, '2026-11-10'), requests, events, ask: out }, zero));
}
