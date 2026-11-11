// The gaps-off scenario test/gaps-answer.test.js holds byte-identical to the
// code without gaps: the system prompt, the core tools, and a scripted ask()
// with an unknown note_unanswered call, a query, and a voice rewrite.
// gaps-off-snapshot.json is this scenario's output from a tree without gaps,
// made by passing that tree's modules in. Timings are zeroed. First made from
// c5d7f58 (the merge base before gaps); remade from 34e7ec5 (the budget
// branch, still without gaps) when it was merged in, which added only the
// answer's requestBudget.

import { PARTIAL_PROMPT, LINK_LINE, FOLLOWUP_LINE } from '../../src/prompt.js';

// Base-prompt lines added since the snapshot, for every deployment, gaps on
// or off: stripped before comparing, so the comparison still covers the rest.
export const PROMPT_ADDED_SINCE_SNAPSHOT = Object.freeze([PARTIAL_PROMPT, LINK_LINE, FOLLOWUP_LINE]);
// Core tools added since the snapshot: left out of the tool lists the same way.
export const CORE_TOOLS_ADDED_SINCE_SNAPSHOT = Object.freeze(['offer_followup']);
const coreAtSnapshot = (tools) => (Array.isArray(tools) ? tools.filter((t) => !CORE_TOOLS_ADDED_SINCE_SNAPSHOT.includes(t.function?.name)) : tools);
const stripAdded = (s) => PROMPT_ADDED_SINCE_SNAPSHOT.reduce((t, x) => t.split(x).join(''), s);

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
  const zero = (k, v) => (k === 'ms' ? 0 : typeof v === 'string' ? stripAdded(v).replace(/ · \d+ ms · /g, ' · 0 ms · ') : v);
  return JSON.parse(
    JSON.stringify(
      {
        systemPrompt: systemPrompt(norfolk, '2026-11-06'),
        tools: coreAtSnapshot(toolsFor(norfolk)),
        ask: out,
        // The system prompt holds today's date; it's compared above with a fixed date.
        requests: bodies.map((b) => ({ ...b, ...('tools' in b ? { tools: coreAtSnapshot(b.tools) } : {}), messages: b.messages.map((m) => (m.role === 'system' ? { ...m, content: '(system prompt)' } : m)) })),
      },
      zero
    )
  );
}
