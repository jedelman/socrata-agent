// The chat page's script (ui.html), served as a classic script under
// <base>/assets/<hash>/ so the page can carry a strict Content-Security-Policy
// with no inline script. It runs where the inline script did, at the end of
// the body, after marked and DOMPurify. It is the same for every deployment
// (cached a year by its hash): the deployment's text comes from the page's
// data attributes, never from placeholders in here. Its relative URLs
// ('api/...', 'requests') resolve against the page, so it works at any
// BASE_PATH, the root included.
const LOADING = document.documentElement.dataset.loading || 'Looking it up. This usually takes 10 to 30 seconds';
const APP_NAME = document.documentElement.dataset.appName || 'socrata-agent';
const EXAMPLES = {
  norfolk: ["What's on my block? 810 Union St", 'Who decided to allow a kennel at 111 Pennsylvania Ave?', 'What public meetings are coming up in the next two weeks?'],
  seattle: ['What datasets does Seattle publish about building permits?', 'How many building permits were issued in Seattle last month?'],
  chicago: ['How many pothole complaints did Chicago get in the last 30 days?', 'Which community areas had the most 311 rodent complaints this year?'],
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Links come from city data, configs and plugins: allow only web links.
const link = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#');
// No style attributes: the page's CSP would refuse them anyway, with a console error each.
// No data attributes, no form controls or dialogs, and named properties
// sanitized: model output can't pose as one of the page's own controls.
const md = (s) => (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(s || ''), { FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true, FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'dialog'] }) : `<p>${esc(s)}</p>`);
let history = [];
let cities = [];
let conversationId = null;
let session = {};
// Set while a dropped answer may still be saved to this conversation (see savedTurn).
let hold = null;

async function loadCities() {
  try {
    cities = await (await fetch('api/cities')).json();
  } catch { cities = [{ id: 'norfolk', name: 'Norfolk, VA', block: true }]; }
  $('#city').innerHTML = cities.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  setCity();
}
function setCity() {
  const c = cities.find((x) => x.id === $('#city').value) || cities[0];
  $('#intro').textContent = c?.block
    ? `Ask about an address in ${c.name}, or about anything in the city's open data. Every answer lists the queries behind it, the data to download, and who to contact.`
    : `Ask about anything in ${c?.name}'s open data. (Address and "who decided" lookups are Norfolk-only for now.) Every answer lists the queries behind it and the data to download.`;
  $('#examples').innerHTML = (EXAMPLES[c?.id] || []).map((e) => `<button type="button">${esc(e)}</button>`).join('');
  history = [];
}
$('#city').addEventListener('change', () => { newConversation(); setCity(); });
$('#examples').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { $('#q').value = e.target.textContent; $('#f').requestSubmit(); } });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#f').requestSubmit(); } });

function renderResources(r) {
  const parts = [];
  if (r.contacts?.length) {
    parts.push(`<details open><summary>Who to contact <small>(${r.contacts.length})</small></summary><ul class="plain">${r.contacts.map((c) => `<li><span class="role">${esc(c.role)}</span>${[c.name && esc(c.name), c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`, c.phone && `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>`, c.url && `<a href="${link(c.url)}" target="_blank" rel="noopener">website</a>`].filter(Boolean).join(' · ')}${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</li>`).join('')}</ul></details>`);
  }
  const records = (r.records || []).filter((x) => x.kind !== 'web');
  const pages = (r.records || []).filter((x) => x.kind === 'web');
  if (records.length) {
    parts.push(`<details><summary>Public records <small>(${records.length})</small></summary><ul class="plain">${records.map((x) => `<li><a href="${link(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ul></details>`);
  }
  if (pages.length) {
    parts.push(`<details><summary>Web pages <small>(${pages.length})</small></summary><p class="meta">Found by web search, which Anthropic runs, on the official sites this deployment allows. A web page is not a record: it says what it said when the search found it.</p><ul class="plain">${pages.map((x) => `<li><a href="${link(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a>${x.page_age ? ` <small>${esc(x.page_age)}</small>` : ''}</li>`).join('')}</ul></details>`);
  }
  if (r.datasets?.length) {
    parts.push(`<details><summary>Download the data <small>(${r.datasets.length} datasets)</small></summary><ul class="plain">${r.datasets.map((d) => `<li><strong>${esc(d.name || d.id)}</strong>${d.department ? ` <small>from ${esc(d.department)}</small>` : ''}<div class="links"><a href="${link(d.page)}" target="_blank" rel="noopener">dataset page</a>${d.csv ? `<a href="${link(d.csv)}">full CSV</a>` : ''}${(d.queries || []).map((q, i) => `<a href="${link(q)}">these rows${d.queries.length > 1 ? ` (${i + 1})` : ''} as CSV</a>`).join('')}<a href="${link(d.docs)}" target="_blank" rel="noopener">API docs</a></div></li>`).join('')}</ul></details>`);
  }
  if (r.links?.length) {
    parts.push(`<details><summary>Go further</summary><ul class="plain">${r.links.map((l) => `<li><a href="${link(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a></li>`).join('')}</ul></details>`);
  }
  return parts.join('');
}
// Sources Siren said would answer what she couldn't. The person sees exactly
// what will be sent, can edit it, and sends it with one button.
function renderSuggestions(list) {
  if (!list?.length) return '';
  return list.map((s, i) => `<form class="suggest gate" data-i="${i}"><h3>Ask for this source to be added</h3><p>${esc(s.why)}</p><p><strong>${esc(s.source)}</strong>${s.url ? ` · <a href="${link(s.url)}" target="_blank" rel="noopener">link</a>` : ''}</p><label class="fine">What you wanted to know. Requests are public: once reviewed, this note may appear on the <a href="requests" target="_blank" rel="noopener">source request list</a> and on GitHub. Edit it, and leave out your address and name.<textarea name="need" class="need" maxlength="300">${esc(s.need)}</textarea></label><input type="hidden" name="source" value="${esc(s.source)}"><input type="hidden" name="url" value="${esc(s.url || '')}"><button class="ask" type="submit">Request this source</button> <span class="msg" role="status"></span></form>`).join('');
}
$('#log').addEventListener('submit', async (e) => {
  const f = e.target.closest('form.suggest');
  if (!f) return;
  e.preventDefault();
  const msg = f.querySelector('.msg');
  msg.textContent = 'Sending…';
  try {
    const { res, data } = await postJson('api/requests', { source: f.source.value, url: f.url.value, need: f.need.value, public: true });
    if (!res.ok) { msg.textContent = data.error || 'Something went wrong.'; return; }
    msg.className = 'msg ok';
    // The server gives a count only for a request already on the public list.
    msg.textContent = typeof data.count === 'number' && data.count > 1 ? `Requested. ${data.count} people have asked for this source.` : `Requested. Thank you: requests decide what ${APP_NAME} learns next.`;
    f.querySelector('button').disabled = true;
  } catch { msg.textContent = "Couldn't reach the server. Try again."; }
});
// What the records couldn't answer (docs/gaps.md §8.5). Only with gaps on;
// code-written text, escaped, never through md(). A reopened answer's record
// keeps only {gap, statement, measured} per gap (worker/conversations.js), so
// label, title and the open state show only on a live answer.
function renderGaps(g) {
  if (!g?.shown?.length) return '';
  const today = new Date().toISOString().slice(0, 10);
  const stale = (d) => (Date.parse(today) - Date.parse(d)) / 864e5 > 14;
  // Open when a gap bit or was named, or the question was noted as unanswered (§8.5).
  const open = g.noted || g.shown.some((x) => x.bit || x.named);
  const n = g.shown.length + (g.more || 0);
  return `<details class="gaps"${open ? ' open' : ''}><summary>What I couldn't answer from the records I read <small>(${n})</small></summary><ul class="plain">${g.shown.map((x) => `<li>${x.label ? `<span class="role">${esc(x.label)}</span> ` : ''}${x.title ? `<strong>${esc(x.title)}</strong><br>` : ''}${esc(x.statement)}<br><small>measured ${esc(x.measured)}${stale(x.measured) ? ' · due for a re-check' : ''}${x.notice ? ` · ${esc(x.notice)}` : ''}</small>${x.absence ? `<br><small>${esc(x.absence)}</small>` : ''}</li>`).join('')}${g.more ? `<li><small>${esc(g.more)} more in the gap catalog</small></li>` : ''}</ul></details>`;
}
// One answer with what was found behind it: the voice notice, what the
// records couldn't answer (gaps on only), suggested
// sources, the hand-off, the trace and the model line. The same for a live
// answer and for one reopened from a saved conversation (`at` set); turns
// saved before records were kept show the answer alone.
function renderAnswer(answer, r, at) {
  const when = at ? `${esc(String(at).slice(0, 16).replace('T', ' '))} UTC` : '';
  const rb = r.requestBudget;
  const how = r.model ? `${esc(r.model)} · ${r.steps} step${r.steps === 1 ? '' : 's'}${rb ? ` · ${rb.used} request${rb.used === 1 ? '' : 's'}${rb.limit ? ` of ${rb.limit}` : ''}` : ''}` : '';
  return `<div class="answer">${md(answer)}</div>${r.voice && !r.voice.ok ? `<p class="notice">This answer states some things as fact rather than as what the records show. Check them against the trace.</p>` : ''}${rb?.note ? `<p class="notice">${esc(rb.note)}</p>` : ''}${renderGaps(Array.isArray(r.gaps) ? { shown: r.gaps } : r.gaps)}${renderSuggestions(r.suggestions)}${renderResources(r.resources || {})}${renderTrace(r.trace)}${when || how ? `<p class="meta">${[when, how].filter(Boolean).join(' · ')}</p>` : ''}`;
}
// A web search step (web search on). Its tool name is WEB_SEARCH_STEP in
// src/web-search.js (test/web-search.test.js keeps the two the same). The
// search ran on Anthropic's side, so there is nothing to re-run: the step's
// link is the first page it found, or the tool's documentation.
const WEB_STEP = 'web search (run by Anthropic)';
const isWebStep = (s) => s.tool === WEB_STEP;
function traceStep(s) {
  if (isWebStep(s)) {
    const status = s.ok ? (s.rows == null ? 'ok' : `${s.rows} result${s.rows === 1 ? '' : 's'}`) : `failed: ${esc(s.error)}`;
    const docs = /^https:\/\/platform\.claude\.com\//.test(String(s.url || ''));
    return `<li><strong>${esc(s.tool)}</strong>${s.soql ? `<code>${esc(s.soql)}</code>` : ''}<span class="meta">${status} · ${s.ms} ms · <a href="${link(s.url)}" target="_blank" rel="noopener">${docs ? 'how web search works' : 'first page found'}</a></span></li>`;
  }
  return `<li><strong>${esc(s.tool)}</strong>${s.dataset ? ` · <code class="ds">${esc(s.dataset)}</code>` : ''}${s.soql ? `<code>${esc(s.soql)}</code>` : ''}<span class="meta">${s.ok ? (s.rows == null ? 'ok' : `${s.rows} row${s.rows === 1 ? '' : 's'}`) : `${s.refused ? 'refused' : 'failed'}: ${esc(s.error)}`} · ${s.ms} ms · <a href="${link(s.url)}" target="_blank" rel="noopener">run it yourself</a></span></li>`;
}
function renderTrace(t) {
  if (!t?.length) return '';
  const refused = t.filter((s) => s.refused).length;
  const searches = t.filter((s) => !s.refused && isWebStep(s)).length;
  const queries = t.length - refused - searches;
  const counts = [];
  if (queries || !searches) counts.push(`${queries} quer${queries === 1 ? 'y' : 'ies'}`);
  if (searches) counts.push(`${searches} web search${searches === 1 ? '' : 'es'}`);
  if (refused) counts.push(`${refused} not sent`);
  return `<details><summary>How I found this <small>(${counts.join(', ')})</small></summary><ol class="trace">${t.map(traceStep).join('')}</ol></details>`;
}

function showGate(on) {
  $('#gate').hidden = !on;
  $('#f').hidden = on;
  $('#examples').hidden = on;
  const signin = on && session.login && !session.signed_in;
  $('#signin').hidden = !signin;
  $('#code-intro').textContent = session.signed_in
    ? "You're signed in. Enter your invite code once and it works on every device you sign in on."
    : signin ? 'Or, if someone gave you an invite code, enter it here (it will work in this browser only).' : 'If someone gave you an invite code, enter it here.';
  if (on) (signin ? $('#login-email') : $('#code')).focus();
}
function newConversation() {
  // A new conversation can't race the old one's save.
  if (hold) { hold = null; $('#go').disabled = false; }
  conversationId = null;
  history = [];
  $('#log').innerHTML = '';
  $('#conv-state').textContent = 'New conversation';
  $('#conv-forget').hidden = true;
}
async function loadRecent() {
  if (!session.conversations) return;
  try {
    const { conversations = [] } = await (await fetch('api/conversations', { cache: 'no-store' })).json();
    $('#conv-recent').hidden = !conversations.length;
    $('#conv-list').innerHTML = conversations.map((c) => `<li><button type="button" data-id="${esc(c.id)}">${esc(c.title)}</button> <small>${c.turns} question${c.turns === 1 ? '' : 's'} · ${esc(String(c.updated).slice(0, 10))}</small></li>`).join('');
  } catch {}
}
async function loadSession() {
  try {
    session = await (await fetch('api/session', { cache: 'no-store' })).json();
    showGate(Boolean(session.invite_required && !session.invited));
    $('#convbar').hidden = !session.conversations;
    $('#privacy-signed-in').hidden = !session.signed_in;
    $('#account').hidden = !session.signed_in;
    $('#account').innerHTML = session.signed_in ? `Signed in as <strong>${esc(session.account)}</strong>. Not you? <button type="button" id="signout-top">Sign out</button>` : '';
    $('#signout-top')?.addEventListener('click', () => $('#signout').click());
    loadRecent();
  } catch { /* the ask call reports any problem */ }
}
// The sign-in link lands on <base>/login#t=<token>. The token is posted from
// script, so a mail scanner that only fetches the link can't spend it.
async function finishSignIn() {
  if (!/\/login$/.test(location.pathname)) return;
  const token = new URLSearchParams(location.hash.slice(1)).get('t');
  window.history.replaceState(null, '', location.pathname.replace(/login$/, ''));
  if (!token) return;
  try {
    const { res, data } = await postJson('api/login/verify', { token });
    if (!res.ok) { showGate(true); $('#login-msg').textContent = data.error || 'That sign-in link did not work. Ask for a new one.'; }
  } catch {}
}
$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  msg.className = 'msg'; msg.textContent = 'Sending…';
  try {
    const { res, data } = await postJson('api/login', { email: $('#login-email').value, website: $('#login-website').value });
    if (!res.ok) { msg.textContent = data.error || 'Something went wrong. Try again.'; return; }
    msg.className = 'msg ok'; msg.textContent = 'Check your email for a sign-in link. It works once, for 15 minutes.';
  } catch { msg.textContent = "Couldn't reach the server. Try again."; }
});
$('#conv-new').addEventListener('click', () => { newConversation(); $('#q').focus(); });
$('#conv-forget').addEventListener('click', async () => {
  if (!conversationId) return;
  await postJson('api/conversations/delete', { id: conversationId }).catch(() => {});
  newConversation();
  loadRecent();
});
$('#conv-forget-all').addEventListener('click', async () => {
  if (!window.confirm('Forget all your conversations? This deletes them for good.')) return;
  await postJson('api/conversations/delete-all', { confirm: 'delete all' }).catch(() => {});
  newConversation();
  loadRecent();
});
$('#conv-list').addEventListener('click', async (e) => {
  const id = e.target.closest('button')?.dataset.id;
  if (!id) return;
  try {
    const res = await fetch(`api/conversation?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) return;
    newConversation();
    conversationId = id;
    if (data.city && cities.some((c) => c.id === data.city)) $('#city').value = data.city;
    for (const t of data.turns) {
      const turn = document.createElement('section');
      turn.className = 'turn';
      turn.innerHTML = `<div class="q">${esc(t.question)}</div><div class="a">${renderAnswer(t.answer, t.record || {}, t.at)}</div>`;
      $('#log').append(turn);
    }
    $('#conv-state').textContent = `Continuing: ${data.turns[0]?.question.slice(0, 60) || ''}`;
    $('#conv-forget').hidden = false;
    $('#conv-recent').open = false;
  } catch {}
});
$('#signout').addEventListener('click', async () => {
  await postJson('api/logout', {}).catch(() => {});
  newConversation();
  loadSession();
});
async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch {}
  return { res, data };
}
$('#redeem').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#redeem-msg');
  msg.className = 'msg'; msg.textContent = 'Checking…';
  try {
    const { res, data } = await postJson('api/redeem', { code: $('#code').value });
    if (!res.ok) { msg.textContent = data.error || 'That code didn\'t work.'; return; }
    msg.textContent = '';
    await loadSession();
    showGate(false);
    $('#q').focus();
    if ($('#q').value.trim()) $('#f').requestSubmit();
  } catch { msg.textContent = "Couldn't reach the server. Try again."; }
});
$('#wl').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#wl-msg');
  msg.className = 'msg'; msg.textContent = 'Adding you…';
  const body = { email: $('#wl-email').value, name: $('#wl-name').value, org: $('#wl-org').value, note: $('#wl-note').value, website: $('#wl-website').value };
  try {
    const { res, data } = await postJson('api/waitlist', body);
    if (!res.ok) { msg.textContent = data.error || 'Something went wrong. Try again.'; return; }
    msg.className = 'msg ok'; msg.textContent = "You're on the list. We'll be in touch when there's room.";
    $('#wl').reset();
  } catch { msg.textContent = "Couldn't reach the server. Try again."; }
});

// What came back for a question, streamed or not: the invite gate, an error,
// or the answer with everything found behind it.
function showAnswer(turn, a, question, status, data) {
  if (status === 401 && data.gate === 'invite') {
    turn.remove();
    $('#q').value = question;
    showGate(true);
    $('#redeem-msg').textContent = data.error || '';
    return;
  }
  if (status < 200 || status >= 300) { a.innerHTML = `<p class="notice">${esc(data.error || 'Something went wrong.')}</p>`; return; }
  history.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
  if (data.conversation) {
    if (!conversationId) { $('#conv-state').textContent = `Conversation: ${question.slice(0, 60)}`; loadRecent(); }
    conversationId = data.conversation;
    $('#conv-forget').hidden = false;
  }
  a.innerHTML = renderAnswer(data.answer, data);
}

// The working notes, streamed while the answer is worked out (worker/ask-stream.js).
// Everything here is plain text (text nodes and textContent), never markup:
// the thinking is the model's own summary, and the step lines are the Worker's.
const NDJSON = 'application/x-ndjson';
const canStream = typeof ReadableStream === 'function' && typeof TextDecoder === 'function' && typeof Response === 'function' && 'body' in Response.prototype;
function notesPanel(turn) {
  const panel = $('#notes-tpl').content.firstElementChild.cloneNode(true);
  turn.querySelector('.a').before(panel);
  const body = panel.querySelector('.notes-body');
  const byStep = new Map();
  let current = null;
  let currentStep = null;
  let shown = false;
  // Follow the newest line unless the reader has scrolled up.
  const add = (fill) => {
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    fill();
    shown = true;
    if (follow) body.scrollTop = body.scrollHeight;
  };
  const line = (cls, text) => {
    const p = document.createElement('p');
    p.className = cls;
    p.textContent = text;
    body.append(p);
    return p;
  };
  return {
    thinking(step, text) {
      add(() => {
        if (!current || currentStep !== step) {
          current = line('note', '');
          currentStep = step;
          byStep.set(step, [...(byStep.get(step) || []), current]);
        }
        current.append(text);
      });
    },
    step(label) { add(() => { line('step', label); current = null; }); },
    // The model declined this step: what it wrote there is withdrawn. After
    // a fallback, another model's notes for the same step follow.
    discard(step, reason) {
      add(() => {
        for (const p of byStep.get(step) || []) p.remove();
        byStep.delete(step);
        current = null;
        line('aside', reason === 'fallback'
          ? 'The model declined here and another model took over, so the first model\'s notes from this step are withdrawn.'
          : 'The model declined here, so its notes from this step are withdrawn.');
      });
    },
    capped() { add(() => { line('aside', 'The notes stop here: the rest was not sent.'); current = null; }); },
    done() {
      if (!shown) { panel.remove(); return; }
      panel.open = false;
      panel.querySelector('.notes-state').textContent = '(open to read them again)';
    },
  };
}
// ---- helpers (test/ask-stream.test.js runs these directly) ----
// Reads the stream's lines; stops, and lets the rest go, once onLine returns
// true (the final or error line), so nothing after it can undo the answer.
async function readLines(res, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const stop = () => reader.cancel().catch(() => {});
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const text = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (text.trim() && onLine(JSON.parse(text)) === true) return stop();
    }
  }
  buf += decoder.decode();
  if (buf.trim()) onLine(JSON.parse(buf));
}
// After a dropped stream, the Worker may still finish and save the answer.
// Asking again in the same conversation before that save would race it (the
// last save wins), so the page waits: this polls the saved conversation and
// returns the turn once it is there, or null after `total` ms.
async function savedTurn(id, question, since, { get = (u) => fetch(u, { cache: 'no-store' }), wait = (ms) => new Promise((r) => setTimeout(r, ms)), polls = [25000, 35000], total = 60000 } = {}) {
  let waited = 0;
  for (const ms of polls) {
    await wait(ms);
    waited += ms;
    try {
      const res = await get(`api/conversation?id=${encodeURIComponent(id)}`);
      if (!res.ok) continue;
      const t = ((await res.json()).turns || []).at(-1);
      // Its question, saved since this one was asked (two minutes for clock skew).
      if (t && t.question === question && Date.parse(t.at) >= since - 120000) return t;
    } catch {}
  }
  if (total > waited) await wait(total - waited);
  return null;
}
// ---- end helpers ----

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (hold) return;
  const question = $('#q').value.trim();
  if (!question) return;
  const askedAt = Date.now();
  const city = $('#city').value;
  const turn = document.createElement('section');
  turn.className = 'turn';
  turn.innerHTML = `<div class="q">${esc(question)}</div><div class="a"><p class="loading">${esc(LOADING)}</p></div>`;
  $('#log').append(turn);
  turn.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#q').value = '';
  $('#go').disabled = true;
  const a = turn.querySelector('.a');
  let notes = null;
  let ended = false;
  let started = null;
  try {
    // Asks for the stream where this browser can read one; the Worker sends
    // JSON instead when its notes are off, and for any error before it starts.
    const res = await fetch('api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(canStream ? { Accept: `${NDJSON}, application/json` } : {}) }, body: JSON.stringify({ question, city, history, conversation: conversationId }) });
    if (canStream && res.body && (res.headers.get('Content-Type') || '').toLowerCase().startsWith(NDJSON)) {
      notes = notesPanel(turn);
      turn.setAttribute('aria-busy', 'true');
      await readLines(res, (ev) => {
        if (ended) return;
        if (ev.type === 'thinking') notes.thinking(ev.step, String(ev.text ?? ''));
        else if (ev.type === 'tool' || ev.type === 'rewrite') notes.step(String(ev.label ?? ''));
        else if (ev.type === 'discard') notes.discard(ev.step, ev.reason);
        else if (ev.type === 'notes_capped') notes.capped();
        else if (ev.type === 'start') started = typeof ev.conversation === 'string' ? ev.conversation : null;
        else if (ev.type === 'final' || ev.type === 'error') {
          ended = true;
          showAnswer(turn, a, question, ev.type === 'final' ? 200 : Number(ev.status) || 502, ev.body || {});
          return true;
        }
      });
      if (!ended) throw new Error('The stream ended before the answer.');
    } else {
      showAnswer(turn, a, question, res.status, await res.json());
    }
  } catch (err) {
    if (notes && !ended && started) {
      // Signed in: the Worker had the question and may still save its answer
      // to this conversation. Asking again now would pay for it twice and race
      // that save, so new questions wait until it shows up or a minute passes.
      const mine = { id: started };
      hold = mine;
      if (!conversationId) $('#conv-state').textContent = `Conversation: ${question.slice(0, 60)}`;
      conversationId = started;
      $('#conv-forget').hidden = false;
      a.innerHTML = '<p class="notice">The connection dropped before the answer arrived. It may still finish: this page will show it here if it is saved. You can ask again in a minute.</p>';
      savedTurn(started, question, askedAt).then((t) => {
        if (hold !== mine) return;
        hold = null;
        $('#go').disabled = false;
        loadRecent();
        if (t) {
          history.push({ role: 'user', content: question }, { role: 'assistant', content: t.answer });
          a.innerHTML = renderAnswer(t.answer, t.record || {}, t.at);
        } else {
          $('#q').value = $('#q').value || question;
          a.innerHTML = '<p class="notice">The connection dropped before the answer arrived, and it has not been saved. Asking again counts as a new question.</p>';
        }
      });
    } else if (notes && !ended) {
      // Nothing is saved for this reader, so nothing to race; asking again
      // still counts as a new question, so say so instead of retrying.
      $('#q').value = question;
      a.innerHTML = '<p class="notice">The connection dropped before the answer arrived. Asking again counts as a new question.</p>';
    } else {
      a.innerHTML = `<p class="notice">Couldn't reach the server. Check your connection and try again.</p>`;
    }
  } finally {
    notes?.done();
    turn.removeAttribute('aria-busy');
    $('#go').disabled = Boolean(hold);
  }
});
loadCities();
finishSignIn().then(loadSession);
