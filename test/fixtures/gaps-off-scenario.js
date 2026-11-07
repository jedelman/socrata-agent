// The gaps-off scenario test/gaps-answer.test.js holds byte-identical to the
// merge base (c5d7f58, before gaps): the system prompt, the core tools, and a
// scripted ask() with an unknown note_unanswered call, a query, and a voice
// rewrite. gaps-off-snapshot.json is this scenario's output from c5d7f58's
// src/, made by passing that tree's modules in. Timings are zeroed.

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

export async function gapsOffScenario({ ask, toolsFor, systemPrompt, getCity }) {
  const norfolk = getCity('norfolk');
  const replies = [
    { tools: [['note_unanswered', { question: 'Was a tree removed?', answered: 'no' }], ['query_dataset', { dataset_id: 'qzfe-wj25', soql: "SELECT count(*) AS n WHERE area = 'Forestry'" }]] },
    { text: 'There are 1 work orders.' },
    { text: 'I found 1 work order.' },
  ];
  const bodies = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://openrouter.ai')) {
      bodies.push(JSON.parse(init.body));
      const r = replies[Math.min(i++, replies.length - 1)];
      const message = r.tools ? { content: '', tool_calls: r.tools.map(([name, args], k) => call(`c${i}-${k}`, name, args)) } : { content: r.text };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { cost: 0.001 } }));
    }
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Work Orders', columns: [{ fieldName: 'area', dataTypeName: 'text' }] }));
    return new Response(JSON.stringify([{ n: '1' }]));
  };
  const out = await ask({ question: 'How many Forestry work orders?', city: norfolk, apiKey: 'k', fetchImpl });
  const zero = (k, v) => (k === 'ms' ? 0 : typeof v === 'string' ? v.replace(/ · \d+ ms · /g, ' · 0 ms · ') : v);
  return JSON.parse(
    JSON.stringify(
      {
        systemPrompt: systemPrompt(norfolk, '2026-11-06'),
        tools: toolsFor(norfolk),
        ask: out,
        // The system prompt holds today's date; it's compared above with a fixed date.
        requests: bodies.map((b) => ({ ...b, messages: b.messages.map((m) => (m.role === 'system' ? { ...m, content: '(system prompt)' } : m)) })),
      },
      zero
    )
  );
}
