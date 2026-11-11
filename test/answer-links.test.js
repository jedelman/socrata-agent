// Links in the answer's own words, and follow-up offers (Jason, 2026-11-10:
// "can we link the relevant text in the answer itself?" and "a button with a
// preloaded followup question prompt that says 'Would you like me to look
// into that?' AS LONG AS the source is actually available"). The links are
// held to the answer's hand-off in code (src/answer-links.js); the offers to
// sources Siren's tools can open (src/followups.js). Offline throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterAnswerLinks, handoffUrls, normalizeUrl, readableSources, unescapeMarkdown } from '../src/answer-links.js';
import { offerFollowup, finalFollowups, FOLLOWUP_LABEL, NOT_OPENABLE_NOTE, OFFERED_NOTE, MAX_FOLLOWUPS } from '../src/followups.js';
import { ask, createContext } from '../src/agent.js';
import { toolsFor, runTool } from '../src/tools.js';
import { systemPrompt, LINK_LINE, FOLLOWUP_LINE } from '../src/prompt.js';
import { voiceViolations } from '../src/voice.js';
import { getCity } from '../src/cities/index.js';
import { applyConfig, definePlugin } from '../src/plugins.js';
import { answerRecord, saveTurn, loadConversation, turnView, newConversationId } from '../worker/conversations.js';
import { TOOL_LABELS } from '../worker/ask-stream.js';
import { followupsHtml, followupOffer, checkLink as pageCheckLink, handoffLinks as pageHandoffLinks, normUrl as pageNormUrl, md as pageMd, answerHtml, FOLLOWUP_LABEL as PAGE_LABEL } from '../worker/questions-page.js';
import siren from '../deployments/siren.config.js';

const norfolk = getCity('norfolk');
const LEGI = 'https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=7337';
const PAGE = 'https://data.norfolk.gov/d/qzfe-wj25';
const CSV = "https://data.norfolk.gov/resource/qzfe-wj25.csv?$query=SELECT%20count(*)%20WHERE%20area%20%3D%20'Forestry'";
const DOCS = 'https://dev.socrata.com/foundry/data.norfolk.gov/qzfe-wj25';
const SITE = 'https://www.mynorfolk.org';
const LINK = 'https://norfolkcityva.iqm2.com/Citizens/Default.aspx';
const RESOURCES = {
  records: [{ kind: 'legislation', title: 'ORD 48-512: A kennel at 111 Pennsylvania Ave', url: LEGI }, { kind: 'web', title: 'Flood maps', url: 'https://msc.fema.gov/portal/' }],
  datasets: [{ id: 'qzfe-wj25', name: 'Work Orders', page: PAGE, docs: DOCS, csv: '', queries: [CSV] }],
  contacts: [{ role: 'City services', url: SITE, email: 'ccouncil@norfolk.gov' }],
  links: [{ title: 'Meetings', url: LINK }],
};
const KNOWN = handoffUrls(RESOURCES);
const filter = (s) => filterAnswerLinks(s, KNOWN);

// ---- normalization and the hand-off ------------------------------------

test('URLs compare trimmed, with one trailing slash off the path; the query, fragment and case are never touched', () => {
  assert.equal(normalizeUrl('  https://x.gov/a/  '), 'https://x.gov/a');
  assert.equal(normalizeUrl('https://x.gov/'), 'https://x.gov');
  assert.equal(normalizeUrl('https://x.gov/a/?q=1/'), 'https://x.gov/a?q=1/');
  assert.equal(normalizeUrl('https://x.gov/A?Q=B'), 'https://x.gov/A?Q=B');
  assert.notEqual(normalizeUrl('https://x.gov/a?q=1'), normalizeUrl('https://x.gov/a?q=2'));
  assert.notEqual(normalizeUrl('https://x.gov/Path'), normalizeUrl('https://x.gov/path'));
});

test("the hand-off's URLs: records and web pages, dataset pages, CSVs, queries and docs, contact sites and emails, deployment links; nothing else", () => {
  for (const u of [LEGI, 'https://msc.fema.gov/portal', PAGE, CSV, DOCS, SITE, LINK]) assert.ok(KNOWN.has(normalizeUrl(u)), u);
  assert.ok(KNOWN.has('mailto:ccouncil@norfolk.gov'));
  assert.ok(!handoffUrls({ records: [{ url: 'javascript:alert(1)' }, { url: 'data:text/html,x' }] }).size, 'web links only');
  const readable = readableSources(RESOURCES);
  assert.deepEqual([...readable.keys()].sort(), [LEGI, 'https://msc.fema.gov/portal', PAGE].map(normalizeUrl).sort(), 'records and dataset pages are the sources Siren can read again');
  assert.equal(readable.get(normalizeUrl(PAGE)).title, 'Work Orders');
});

// ---- the filter -----------------------------------------------------------

test('a link to the hand-off is kept (its URL written so it can only ever be that link); an invented one becomes its words', () => {
  const r = filter(`I found the [kennel permit](${LEGI}) and the [rows](${CSV}). The [plan](https://evil.example/plan) is linked too.`);
  assert.equal(r.text, `I found the [kennel permit](${LEGI.replace('://', '\\://')}) and the [rows](${CSV.replace('://', '\\://')}). The plan is linked too.`);
  assert.deepEqual({ kept: r.kept, dropped: r.dropped }, { kept: 2, dropped: 1 });
  assert.ok(!r.text.includes('evil.example'), 'the invented URL is gone from the text');
  // The same text again changes nothing.
  assert.deepEqual(filter(r.text), { text: r.text, kept: 2, dropped: 0 });
});

test('a URL that appears only in the model text, not in the hand-off, is not a link, however often it is written', () => {
  const made = 'https://data.norfolk.gov/d/abcd-1234';
  const r = filter(`See [the dataset](${made}), also at ${made} and <${made}>.`);
  assert.equal(r.kept, 0);
  assert.equal(r.dropped, 3);
  assert.ok(!/\]\(|<https/.test(r.text));
  assert.match(r.text, /https\\:\/\/data\.norfolk\.gov\/d\/abcd-1234/, 'shown as text marked will not link');
});

test('the comparison: trimmed and trailing slash only, so a changed query, fragment or case is unlinked', () => {
  assert.equal(filter(`[a](${PAGE}/)`).kept, 1);
  assert.equal(filter(`[a]( ${PAGE} )`).kept, 1);
  assert.equal(filter(`[a](${PAGE}#rows)`).kept, 0);
  assert.equal(filter(`[a](${PAGE.toUpperCase()})`).kept, 0);
  assert.equal(filter(`[a](${CSV.replace('Forestry', 'Parks')})`).kept, 0);
});

test('edge cases: titles, angle brackets, nested brackets, reference-style links, images, code spans', () => {
  // Titles and angle-bracket URLs are read as marked reads them.
  assert.equal(filter(`[the record](${LEGI} "Legislation")`).text, `[the record](${LEGI.replace('://', '\\://')} "Legislation")`);
  assert.equal(filter(`[x](https://evil.example 'title')`).text, 'x');
  assert.equal(filter(`[the record](<${LEGI}>)`).kept, 1);
  assert.equal(filter('[x](<https://evil.example>)').text, 'x');
  // Nested brackets: the inner link is judged on its own.
  assert.equal(filter(`[a [b](https://evil.example) c](${LEGI})`).text, `[a b c](${LEGI.replace('://', '\\://')})`);
  assert.equal(filter(`[a \\[b\\](https://evil.example) c](${LEGI})`).text, `[a b c](${LEGI.replace('://', '\\://')})`, 'escaped brackets in link text are read as marked reads them');
  assert.equal(filter('[[x](https://evil.example)](https://evil2.example)').text, 'x', 'unlinking that uncovers a link unlinks that too');
  // Reference-style links are unlinked, and definitions can't resolve.
  const ref = filter(`See [the record][r] and [this][].\n\n[r]: ${LEGI}\n[this]: https://evil.example`);
  assert.ok(ref.text.startsWith('See the record and this.'), ref.text);
  assert.match(ref.text, /\n\\\[r\]: /, 'the definition is disarmed');
  assert.equal(filter('A shortcut [ref].\n\n> - [ref]: https://evil.example').text, 'A shortcut \\[ref].\n\n> - \\[ref]: https\\://evil.example');
  // Images are dropped, even inside a kept link.
  assert.equal(filter('Map: ![map](https://evil.example/x.png).').text, 'Map: .');
  assert.equal(filter(`[![i](https://evil.example/i.png)](${LEGI})`).text, '', 'a link left with nothing to read goes too');
  // Code spans are left alone.
  for (const s of ['Run `[x](https://evil.example)` yourself.', 'The endpoint is `https://evil.example/resource.json`.', 'Column `date_and_time`.']) assert.equal(filter(s).text, s);
});

test('bare URLs and emails: known ones stay links (as autolinks), unknown ones become text marked will not link', () => {
  const r = filter(`Data at ${PAGE}, more at https://evil.example/x, www.evil.example, bob@evil.example; ask ccouncil@norfolk.gov.`);
  assert.equal(r.text, `Data at <${PAGE}>, more at https\\://evil.example/x, www\\.evil.example, bob\\@evil.example; ask <ccouncil@norfolk.gov>.`);
  assert.deepEqual({ kept: r.kept, dropped: r.dropped }, { kept: 2, dropped: 3 });
  assert.equal(filter('<https://evil.example> and <javascript:alert(1)>').text, 'https\\://evil.example and javascript:alert(1)');
  assert.equal(filter(`<${PAGE}>`).text, `<${PAGE}>`);
});

test('raw HTML: <a> and <img> are removed, a tag that could start an HTML block is escaped, formatting stays', () => {
  assert.equal(filter('<a href="https://evil.example">click</a> <img src="https://evil.example/x.png"> <b>bold</b>').text, 'click  <b>bold</b>');
  assert.equal(filter('<A\nHREF="https://evil.example">x</A>').text, 'x');
  assert.equal(filter('<iframe src="https://evil.example"></iframe>').text, '\\<iframe src="https\\://evil.example">\\</iframe>');
  assert.equal(filter('<!-- <a href="https://evil.example">x</a> -->').text, '\\<!-- x -->');
});

test('text with no links, brackets, tags, emails or bare URLs comes back exactly as it was', () => {
  for (const s of ['I found no tree datasets.', 'I found 2 areas: Landscape and Traffic.', '| area | n |\n|---|---|\n| Forestry | `46,685` |', "I can't say that for sure, but here's what I found:\n\n- **2026-10-14**: the Council's vote."]) {
    assert.deepEqual(filterAnswerLinks(s, KNOWN), { text: s, kept: 0, dropped: 0 }, s);
  }
});

test('counts are bounded and the dropped URLs are never returned', () => {
  const r = filter(Array.from({ length: 1200 }, (_, i) => `[x${i}](https://evil.example/${i})`).join(' '));
  assert.deepEqual(Object.keys(r).sort(), ['dropped', 'kept', 'text']);
  assert.equal(r.dropped, 999);
  assert.ok(!r.text.includes('evil.example'));
  // Nesting past the label grammar: every bracket left is escaped, so none can open a link.
  const deep = filter(`${'['.repeat(40)}x${'](https://evil.example)'.repeat(40)}`);
  assert.ok(!/(^|[^\\])\[/.test(deep.text), deep.text);
  assert.ok(!/https:\/\//.test(deep.text), 'and every URL is text');
});

// ---- ask() ----------------------------------------------------------------

// OpenRouter-shaped replies: each a tool-call list or the answer's text.
function scripted(replies) {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://openrouter.ai')) {
      bodies.push(JSON.parse(init.body));
      const r = replies[Math.min(n++, replies.length - 1)];
      const message = r.tools ? { content: '', tool_calls: r.tools.map(([name, args], k) => ({ id: `c${n}-${k}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { content: r.text };
      return new Response(JSON.stringify({ choices: [{ message }], usage: { cost: 0.001 } }));
    }
    if (u.includes('/api/views/')) return new Response(JSON.stringify({ name: 'Work Orders' }));
    return new Response(JSON.stringify([{ n: '1' }]));
  };
  return { fetchImpl, bodies };
}
// A plugin that hands off one legislation record, as the iqm2 tools do.
const recordPlugin = definePlugin({
  name: 'the_record_tool',
  description: 'Hands off a record.',
  async run(ctx) {
    ctx.resources.addRecord({ kind: 'legislation', title: 'ORD 48-512: A kennel permit', url: LEGI });
    return { url: LEGI };
  },
});

test('ask(): links in the answer are checked against its own hand-off, after the voice check; the counts go in the record, the URLs never', async () => {
  const { fetchImpl } = scripted([
    { tools: [['the_record_tool', {}], ['query_dataset', { dataset_id: 'qzfe-wj25', soql: "SELECT count(*) AS n WHERE area = 'Forestry'" }]] },
    { text: `I found the [kennel permit](${LEGI}) and the [work orders](${PAGE}); the [staff report](https://norfolk.example/report.pdf) is online.` },
  ]);
  const out = await ask({ question: 'What happened with the kennel?', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl });
  assert.equal(out.answer, `I found the [kennel permit](${LEGI.replace('://', '\\://')}) and the [work orders](${PAGE.replace('://', '\\://')}); the staff report is online.`);
  assert.deepEqual(out.answerLinks, { kept: 2, dropped: 1 });
  const record = answerRecord(out);
  assert.deepEqual(record.answerLinks, { kept: 2, dropped: 1 });
  assert.ok(!JSON.stringify(record).includes('norfolk.example'), 'the dropped URL is recorded nowhere');
  // An answer with no links has neither key, so it reads as before.
  const plain = await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl: scripted([{ text: 'I found no tree datasets.' }]).fetchImpl });
  assert.ok(!('answerLinks' in plain) && !('followups' in plain));
  assert.ok(!('answerLinks' in answerRecord(plain)) && !('followups' in answerRecord(plain)));
  assert.deepEqual(answerRecord({ answerLinks: { kept: 5e9, dropped: -3 } }).answerLinks, { kept: 999, dropped: 0 }, 'bounded numbers');
  // Words a dropped link held apart are checked as they'll read.
  const joined = await ask({ question: 'q', city: norfolk, apiKey: 'k', fetchImpl: scripted([{ text: 'I found [no](https://evil.example) one on the record.' }]).fetchImpl, maxSteps: 1 });
  assert.equal(joined.answer, 'I found no one on the record.');
  assert.equal(joined.voice.ok, false);
});

test('the prompt asks for inline links from tool results only, and for offer_followup beside the suggest line, which stays byte-identical', () => {
  for (const city of [norfolk, applyConfig(norfolk, siren), getCity('chicago')]) {
    const p = systemPrompt(city, '2026-11-10');
    assert.ok(p.includes(LINK_LINE) && p.includes(FOLLOWUP_LINE), city.name);
    assert.ok(p.includes("- When the records you can reach don't answer the question, say so, then call suggest_data_source with the specific source that would (an ordinance, a plan, a report, a dataset). Don't guess what that source says.\n" + FOLLOWUP_LINE));
  }
  assert.match(LINK_LINE, /Never write a bare URL, and never one you didn't see in a tool result/);
  assert.match(FOLLOWUP_LINE, /never say you didn't read it/);
  assert.match(FOLLOWUP_LINE, /call suggest_data_source/);
  // With gaps on, the suggest line is swapped and the follow-up line stays.
  assert.ok(systemPrompt(norfolk, '2026-11-10', { gaps: true }).includes(FOLLOWUP_LINE));
  for (const s of [LINK_LINE, FOLLOWUP_LINE]) assert.deepEqual(voiceViolations(s.replace(/"[^"]*"/g, '')), [], s);
});

// ---- offer_followup -------------------------------------------------------

function ctxWith(resources = RESOURCES, extra = {}) {
  const ctx = createContext({ city: norfolk });
  for (const r of resources.records || []) ctx.resources.addRecord(r);
  for (const d of resources.datasets || []) ctx.resources.addDataset(d);
  return Object.assign(ctx, extra);
}

test('offer_followup: a source the tools returned is offered, with the hand-off\'s own title', async () => {
  const ctx = ctxWith();
  const r = await runTool(ctx, 'offer_followup', { question: 'What does the kennel ordinance say?', source_title: 'whatever the model says', url: LEGI });
  assert.deepEqual(r, { offered: true, note: OFFERED_NOTE });
  assert.deepEqual(ctx.followups, [{ question: 'What does the kennel ordinance say?', source_title: 'ORD 48-512: A kennel at 111 Pennsylvania Ave', url: LEGI }]);
  assert.match(OFFERED_NOTE, new RegExp(FOLLOWUP_LABEL.replace('?', '\\?')));
  assert.equal(FOLLOWUP_LABEL, 'Would you like me to look into that?');
  // A dataset page counts, with a trailing slash or markdown escapes in the url.
  const d = ctxWith();
  assert.equal((await runTool(d, 'offer_followup', { question: 'Which areas have the most work orders?', source_title: 'x', url: `${PAGE.replace('://', '\\://')}/` })).offered, true);
  assert.equal(d.followups[0].url, PAGE);
});

test('offer_followup: a source the tools can\'t open is refused with the suggest_data_source note, and nothing is attached', async () => {
  for (const url of ['https://norfolk.example/staff-report.pdf', CSV, DOCS, SITE, LINK, 'mailto:ccouncil@norfolk.gov', '', undefined]) {
    const ctx = ctxWith(RESOURCES);
    ctx.resources.addContact({ role: 'City services', url: SITE });
    ctx.resources.addLink({ title: 'Meetings', url: LINK });
    const r = await runTool(ctx, 'offer_followup', { question: 'What does it say?', source_title: 'x', url });
    assert.deepEqual(r, { offered: false, note: NOT_OPENABLE_NOTE }, String(url));
    assert.deepEqual(ctx.followups, []);
  }
  assert.match(NOT_OPENABLE_NOTE, /can't open it/);
  assert.match(NOT_OPENABLE_NOTE, /call suggest_data_source instead/);
});

test('offer_followup: at most two, the question bounded and held to the voice contract and the public-text rules', async () => {
  const ctx = ctxWith();
  const ask1 = (question, url = LEGI) => runTool(ctx, 'offer_followup', { question, source_title: 'x', url });
  assert.equal((await ask1('x'.repeat(201))).offered, false);
  assert.equal((await ask1('   ')).offered, false);
  const voice = await ask1('Why did no one appeal it?');
  assert.equal(voice.offered, false);
  assert.match(voice.note, /without "there is"/);
  for (const q of ['What was decided at 810 Union St?', 'Who complained about it, and whose permit was it?', 'Can you email ccouncil@norfolk.gov about it?', 'Can you read https://evil.example for me?', "What did Mr. Smith say?"]) {
    const r = await ask1(q);
    assert.equal(r.offered, false, q);
    assert.match(r.note, /^Rephrase the question\./, q);
  }
  assert.deepEqual(ctx.followups, [], 'nothing refused is attached');
  assert.equal((await ask1('What does the kennel ordinance say?')).offered, true);
  assert.deepEqual(await ask1('What else does it say?'), { offered: true, note: 'This source is already offered.' }, 'one offer per source');
  assert.equal((await ask1('Which areas have the most work orders?', PAGE)).offered, true);
  const third = ctxWith({ records: [...RESOURCES.records, { kind: 'source', title: 'Zoning Ordinance §5.3', url: 'https://www.norfolk.gov/DocumentCenter/View/1474' }], datasets: RESOURCES.datasets });
  third.followups = [...ctx.followups];
  const r3 = await runTool(third, 'offer_followup', { question: 'What does section 5.3 say?', source_title: 'x', url: 'https://www.norfolk.gov/DocumentCenter/View/1474' });
  assert.equal(r3.offered, false);
  assert.match(r3.note, /2 follow-ups are already offered/);
  assert.equal(MAX_FOLLOWUPS, 2);
});

test('offer_followup: a web page search returned can be offered, and is kept only if the final hand-off has it', () => {
  const ctx = ctxWith({ records: [], datasets: [] }, { webResults: [{ url: 'https://law.lis.virginia.gov/vacode/15.2-961/', title: '§ 15.2-961' }] });
  assert.equal(offerFollowup(ctx, { question: 'What does § 15.2-961 say about replacement trees?', source_title: 'x', url: 'https://law.lis.virginia.gov/vacode/15.2-961/' }).offered, true);
  assert.deepEqual(finalFollowups(ctx.followups, { records: [] }), [], 'not handed off in the end (the answer cited other pages): no offer');
  assert.equal(finalFollowups(ctx.followups, { records: [{ kind: 'web', url: 'https://law.lis.virginia.gov/vacode/15.2-961/', title: 't' }] }).length, 1);
});

test('offer_followup is a core tool like suggest_data_source: after it (and note_unanswered), labelled, counted as an ordinary tool step', async () => {
  const names = toolsFor(norfolk).map((t) => t.function.name);
  assert.equal(names.indexOf('offer_followup'), names.indexOf('suggest_data_source') + 1);
  const gapsOn = toolsFor(norfolk, [], { gaps: JSON.parse(readFileSync(new URL('../data/gaps/norfolk.json', import.meta.url), 'utf8')) }).map((t) => t.function.name);
  assert.deepEqual(gapsOn.slice(gapsOn.indexOf('suggest_data_source'), gapsOn.indexOf('suggest_data_source') + 3), ['suggest_data_source', 'note_unanswered', 'offer_followup']);
  assert.throws(() => toolsFor(norfolk, [definePlugin({ name: 'offer_followup', description: 'x', run() {} })]), /replace a core tool/);
  assert.ok(TOOL_LABELS.offer_followup);
  const def = toolsFor(norfolk).find((t) => t.function.name === 'offer_followup').function;
  assert.deepEqual(def.parameters.required, ['question', 'source_title', 'url']);
  assert.ok(def.description.includes(FOLLOWUP_LABEL));
  // Through the loop: one tool step, like any other core tool, and the offer comes back with the answer.
  const { fetchImpl } = scripted([
    { tools: [['the_record_tool', {}]] },
    { tools: [['offer_followup', { question: 'What does the kennel ordinance say?', source_title: 'the ordinance', url: LEGI }], ['offer_followup', { question: 'What does the plan say?', source_title: 'a plan', url: 'https://norfolk.example/plan' }]] },
    { text: `I found [an ordinance](${LEGI}) about the kennel.` },
  ]);
  const out = await ask({ question: 'What about the kennel?', city: norfolk, plugins: [recordPlugin], apiKey: 'k', fetchImpl });
  assert.equal(out.steps, 2);
  assert.deepEqual(out.followups, [{ question: 'What does the kennel ordinance say?', source_title: 'ORD 48-512: A kennel permit', url: LEGI }]);
  const refused = out.toolResults.filter((t) => t.name === 'offer_followup').map((t) => JSON.parse(t.content));
  assert.deepEqual(refused.map((r) => r.offered), [true, false]);
  assert.equal(refused[1].note, NOT_OPENABLE_NOTE);
  // Kept in the record, bounded, so a reopened conversation shows them.
  const record = answerRecord(out);
  assert.deepEqual(record.followups, out.followups);
  const long = answerRecord({ followups: [{ question: 'q'.repeat(500), source_title: 't'.repeat(500), url: `${LEGI}${'x'.repeat(3000)}` }, { question: 'a' }, { question: 'b' }] }).followups;
  assert.equal(long.length, 2);
  assert.deepEqual([long[0].question.length, long[0].source_title.length, long[0].url.length], [200, 200, 2000]);
  const kv = new Map();
  const store = { async get(k, t) { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, v); } };
  const id = newConversationId();
  await saveTurn(store, 'u1', id, null, { city: 'norfolk', question: 'What about the kennel?', answer: out.answer, tools: out.toolResults, record: out });
  const view = turnView((await loadConversation(store, 'u1', id)).turns[0]);
  assert.deepEqual(view.record.followups, out.followups);
});

// ---- the chat page ----------------------------------------------------------

const chatPage = () => readFileSync(new URL('../worker/chat-page.js', import.meta.url), 'utf8');
const block = (ui, mark) => {
  const i = ui.indexOf(mark);
  assert.ok(i >= 0, mark);
  return ui.slice(i, ui.indexOf('\n}\n', i) + 2);
};
const line = (ui, mark) => {
  const i = ui.indexOf(mark);
  assert.ok(i >= 0, mark);
  return ui.slice(i, ui.indexOf('\n', i));
};
const marked = (ui, start, end) => {
  const a = ui.indexOf(start);
  const b = ui.indexOf(end);
  assert.ok(a >= 0 && b > a, start);
  return ui.slice(a, b);
};
// A stand-in for an element DOMPurify hands the hook.
function anchor(href) {
  const attrs = new Map(href == null ? [] : [['href', href]]);
  return { nodeName: 'A', attrs, hasAttribute: (k) => attrs.has(k), getAttribute: (k) => attrs.get(k) ?? null, setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
}

test('chat page: a follow-up offer is a button reading exactly "Would you like me to look into that?", the source small beside it, everything escaped', () => {
  const ui = chatPage();
  const { renderFollowups } = new Function(`${line(ui, 'const esc = ')}\n${line(ui, 'const link = ')}\n${block(ui, 'function renderFollowups(list) {')}\nreturn { renderFollowups };`)();
  const html = renderFollowups([{ question: 'What does the "kennel" <ordinance> say?', source_title: 'ORD <b>48-512</b>', url: LEGI }, { question: 'q2', source_title: 'Work Orders', url: 'javascript:alert(1)' }]);
  assert.equal((html.match(/>Would you like me to look into that\?<\/button>/g) || []).length, 2);
  assert.ok(html.includes('data-question="What does the &quot;kennel&quot; &lt;ordinance&gt; say?"'));
  assert.ok(html.includes('<small><a href="https://norfolkcityva.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=7337" target="_blank" rel="noopener noreferrer">ORD &lt;b&gt;48-512&lt;/b&gt;</a></small>'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(!/\son[a-z]+=/i.test(html) && !/\sstyle=/.test(html));
  assert.equal(renderFollowups([]), '');
  assert.equal(renderFollowups(undefined), '');
  // Under the answer, before the request cards.
  const render = block(ui, 'function renderAnswer(');
  assert.ok(render.indexOf('renderFollowups(r.followups)') > 0 && render.indexOf('renderFollowups(r.followups)') < render.indexOf('renderSuggestions(r.suggestions)'));
});

test('chat page: clicking an offer sends its question as the next message, exactly as typed, once; not while an answer is on its way', () => {
  const ui = chatPage();
  assert.ok(ui.includes("$('#log').addEventListener('click', followupClick);"), 'wired to the log, in the page script');
  const run = ({ busy = false, held = null } = {}) => {
    const els = { '#q': { value: '' }, '#go': { disabled: busy }, '#f': { submitted: [], requestSubmit() { this.submitted.push(els['#q'].value); } } };
    const $ = (s) => els[s];
    const { followupClick } = new Function('$', 'hold', `${block(ui, 'function followupClick(e) {')}\nreturn { followupClick };`)($, held);
    const button = { disabled: false, dataset: { question: 'What does the kennel ordinance say?' } };
    button.closest = (sel) => (sel === 'button.followup-ask' ? button : null);
    const click = () => followupClick({ target: { closest: (sel) => button.closest(sel) } });
    return { els, button, click };
  };
  const a = run();
  a.click();
  assert.deepEqual(a.els['#f'].submitted, ['What does the kennel ordinance say?']);
  assert.equal(a.els['#q'].value, 'What does the kennel ordinance say?');
  assert.equal(a.button.disabled, true);
  a.click();
  assert.equal(a.els['#f'].submitted.length, 1, 'once');
  for (const opts of [{ busy: true }, { held: { id: 'x' } }]) {
    const b = run(opts);
    b.click();
    assert.deepEqual(b.els['#f'].submitted, [], JSON.stringify(opts));
    assert.equal(b.button.disabled, false);
  }
  // A click anywhere else does nothing.
  const c = run();
  new Function('$', 'hold', `${block(ui, 'function followupClick(e) {')}\nreturn followupClick;`)((s) => c.els[s], null)({ target: { closest: () => null } });
  assert.deepEqual(c.els['#f'].submitted, []);
});

test("chat page: links in an answer open in a new tab with rel=noopener noreferrer; a link outside the answer's hand-off loses its href", () => {
  const ui = chatPage();
  const { normUrl, handoffLinks, checkLink } = new Function(`${marked(ui, '// ---- answer links', '// ---- end answer links')}\nreturn { normUrl, handoffLinks, checkLink };`)();
  const allowed = handoffLinks(RESOURCES);
  const ok = anchor(LEGI);
  checkLink(ok, allowed);
  assert.deepEqual(Object.fromEntries(ok.attrs), { href: LEGI, target: '_blank', rel: 'noopener noreferrer' });
  const mail = anchor('mailto:ccouncil@norfolk.gov');
  checkLink(mail, allowed);
  assert.deepEqual(Object.fromEntries(mail.attrs), { href: 'mailto:ccouncil@norfolk.gov' }, 'no new tab for an email link');
  const bad = anchor('https://evil.example/');
  checkLink(bad, allowed);
  assert.deepEqual(Object.fromEntries(bad.attrs), {});
  // Any element with an href, an SVG link's xlink:href included, is checked; only <a> opens a new tab.
  const svgA = { ...anchor(null), nodeName: 'a' };
  svgA.attrs.set('xlink:href', 'https://evil.example/');
  svgA.attrs.set('href', LEGI);
  checkLink(svgA, allowed);
  assert.deepEqual(Object.fromEntries(svgA.attrs), { href: LEGI, target: '_blank', rel: 'noopener noreferrer' });
  const area = { ...anchor('https://evil.example/'), nodeName: 'AREA' };
  checkLink(area, allowed);
  assert.equal(area.attrs.has('href'), false);
  checkLink({ nodeName: '#text' }, allowed);
  const encoded = anchor(encodeURI('https://msc.fema.gov/portal/flood maps'));
  checkLink(encoded, handoffLinks({ records: [{ url: 'https://msc.fema.gov/portal/flood maps' }] }));
  assert.equal(encoded.attrs.get('target'), '_blank', 'a URL as marked writes it into an href still matches');
  // The page and the module agree.
  for (const u of ['https://x.gov/a/', ' https://x.gov/a?b=c/ ', 'https://x.gov/', 'https://x.gov/A#f']) assert.equal(normUrl(u), normalizeUrl(u), u);
  for (const u of KNOWN) assert.ok(allowed.has(u), u);
  // The hook is registered once, the md() line is unchanged, and every answer renders through it with its hand-off.
  assert.ok(ui.includes("DOMPurify.addHook('afterSanitizeAttributes', (node) => { if (renderingLinks) checkLink(node, renderingLinks); });"));
  assert.ok(block(ui, 'function renderAnswer(').includes('answerMd(answer, r.resources)'));
  assert.ok(!/\bmd\(answer\)/.test(block(ui, 'function renderAnswer(')));
});

test('chat page: the request card is a stacked card: heading, why, the source, the note at full width with the public notice under it, then the button and its status', () => {
  const ui = chatPage();
  const css = readFileSync(new URL('../worker/chat.css', import.meta.url), 'utf8');
  const { renderSuggestions } = new Function(`${line(ui, 'const esc = ')}\n${line(ui, 'const link = ')}\n${block(ui, 'function renderSuggestions(list) {')}\nreturn { renderSuggestions };`)();
  const html = renderSuggestions([{ need: 'What is the plan <for> MacArthur Center?', source: 'MacArthur Center plan', why: 'I found leases but no plan.', url: 'https://www.norfolk.gov/' }]);
  const order = ['<form class="suggest"', '<h3>Ask for this source</h3>', '<p class="why">I found leases but no plan.</p>', '<p class="source"><strong>MacArthur Center plan</strong>', '<label class="note">What you wanted to know<textarea name="need" class="need" maxlength="300">What is the plan &lt;for&gt; MacArthur Center?</textarea></label>', '<p class="fine">Requests are public: once reviewed, this note may appear on the <a href="requests"', 'leave out your address and name.</p>', '<div class="row"><button class="ask" type="submit">Request this source</button><span class="msg" role="status"></span></div></form>'];
  let at = -1;
  for (const part of order) {
    const i = html.indexOf(part);
    assert.ok(i > at, part);
    at = i;
  }
  assert.ok(!html.includes('class="suggest gate"'), 'no longer laid out by the page form row');
  for (const rule of ['form.suggest { display: block;', 'form.suggest textarea.need { width: 100%;', 'form.suggest .row { display: flex;']) assert.ok(css.includes(rule), rule);
  // The request still goes where it went.
  assert.match(ui, /postJson\('api\/requests', \{ source: f\.source\.value, url: f\.url\.value, need: f\.need\.value, public: true \}\)/);
});

// ---- the public questions page ----------------------------------------------

test('questions page: offers show only on a question whose thread takes a follow-up, with the exact label, and fill the ask box for that thread', () => {
  const offers = [{ question: 'What does the <kennel> ordinance say?', source_title: 'ORD 48-512', url: LEGI }];
  assert.equal(PAGE_LABEL, FOLLOWUP_LABEL);
  const html = followupsHtml(offers, { offer: 'abcdefghijklmnop' });
  assert.ok(html.includes('<button type="button" class="offer" data-offer="abcdefghijklmnop" data-n="0" title="What does the &lt;kennel&gt; ordinance say?">Would you like me to look into that?</button>'));
  assert.equal(followupsHtml(offers, {}), '', 'a thread that takes no follow-up shows no offer');
  assert.equal(followupsHtml(offers, { offer: '"><script>' }), '');
  const withOffer = answerHtml('I found it.', { followups: offers }, { render: (s) => s, offer: 'abcdefghijklmnop' });
  assert.ok(withOffer.indexOf('class="offer"') > withOffer.indexOf('</div>'), 'outside the answer, where clicks act');
  const q = { id: 'abcdefghijklmnop', question: 'What about the kennel?', city: 'norfolk', followup: { root: { uri: 'at://x', cid: 'c' }, parent: { uri: 'at://x', cid: 'c' } }, record: { followups: offers } };
  assert.deepEqual(followupOffer(q, '0'), { replyTo: { id: q.id, question: q.question, city: 'norfolk', followup: q.followup }, text: 'What does the <kennel> ordinance say?' });
  assert.equal(followupOffer({ ...q, followup: null }, 0), null);
  assert.equal(followupOffer(q, 5), null);
});

test('questions page: answers render through DOMPurify with the link hook: hand-off links open in a new tab, others lose their href', () => {
  const hooks = [];
  const seen = [];
  globalThis.marked = { parse: (s) => s };
  globalThis.DOMPurify = {
    addHook: (name, fn) => hooks.push([name, fn]),
    // Stands in for DOMPurify walking the parsed answer: each <a href> goes to the hook.
    sanitize: (s, opts) => {
      seen.push(opts);
      return s.replace(/<a href="([^"]*)">/g, (m, href) => {
        const a = anchor(href);
        for (const [, fn] of hooks) fn(a);
        return `<a${[...a.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')}>`;
      });
    },
  };
  try {
    const html = pageMd(`<a href="${LEGI}">kennel</a> <a href="https://evil.example">x</a>`, RESOURCES);
    assert.equal(html, `<a href="${LEGI}" target="_blank" rel="noopener noreferrer">kennel</a> <a>x</a>`);
    pageMd('again', RESOURCES);
    assert.equal(hooks.length, 1, 'the hook is added once');
    assert.equal(hooks[0][0], 'afterSanitizeAttributes');
    assert.deepEqual(seen[0], { FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true, FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'dialog'] }, 'the sanitizer options are as they were');
    assert.equal(pageMd(`<a href="${LEGI}">kennel</a>`), '<a>kennel</a>', 'an answer with no hand-off keeps no link');
    // answerHtml hands the record's resources to the renderer.
    assert.match(answerHtml(`<a href="${PAGE}">rows</a>`, { resources: RESOURCES }), /target="_blank" rel="noopener noreferrer"/);
  } finally {
    delete globalThis.marked;
    delete globalThis.DOMPurify;
  }
  const a = anchor(LEGI);
  pageCheckLink(a, pageHandoffLinks(RESOURCES));
  assert.equal(a.attrs.get('rel'), 'noopener noreferrer');
  for (const u of ['https://x.gov/a/', 'https://x.gov/a?b=c/']) assert.equal(pageNormUrl(u), normalizeUrl(u));
  assert.equal(unescapeMarkdown('https\\://x.gov/a\\_b'), 'https://x.gov/a_b');
});
