// The web-search-off scenario test/web-search.test.js holds byte-identical to
// the code before web search: Siren's deployment (its plugins and prompt) on
// a Claude model with server-side fallbacks, with a tool step, a fallback
// mid-stream, thinking events and a voice rewrite. Every request body sent to
// the Messages API is kept (with the anthropic-beta header), and the answer.
// web-search-off-snapshot.json is this scenario's output from a286524 (main
// before web search). Timings are zeroed; usage carries no cache reads, so
// the Sonnet 5.5 cache-read price fix doesn't move the cost.

export async function webSearchOffScenario({ ask, systemPrompt, getCity, applyConfig, definePlugin, siren, claudeResponse, extra = {} }) {
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
      requests.push({ beta: new Headers(init.headers).get('anthropic-beta'), body: JSON.parse(init.body) });
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
  const zero = (k, v) => (k === 'ms' ? 0 : typeof v === 'string' ? v.replace(/ · \d+ ms · /g, ' · 0 ms · ').replace(/Today is \d{4}-\d{2}-\d{2}\./g, 'Today is (today).') : v);
  return JSON.parse(JSON.stringify({ systemPrompt: systemPrompt(city, '2026-11-10'), requests, events, ask: out }, zero));
}
