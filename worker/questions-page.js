// The public questions pages (questions.html at /questions and /q/<id>; the
// free tier, docs/free-tier.md), as a module the Worker serves under a strict
// Content-Security-Policy: no inline script, style or handler. The render
// helpers are pure and exported, so Node tests check the escaping and the
// wording; the page itself starts only in a browser.
//
// Everything here is public. With a Bluesky sign-in (the ask client of
// endorse-client.js, talking to the person's own server directly) and an
// invite, the page writes a question record to the person's own repo and
// posts its address to Siren, which reads it there and answers its text.
// The answer's markdown goes through marked and DOMPurify (no style
// attributes), as on the chat page; every other remote string is escaped.
//
// Threads: any answered question can take a follow-up (a record naming it
// and its thread's root). The list shows roots with a reply count; a
// question's page shows its whole thread, root first, replies nested under
// their parents, the current one highlighted, a withdrawn or hidden one as a
// placeholder with its replies kept.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Links come from city data, configs and plugins: allow only web links.
export const link = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/;
const ID_RE = /^[a-z2-7]{16}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How the answer's markdown is sanitized, as on the chat page: no style
 * attributes (the CSP would refuse them), no data attributes (the page's own
 * controls are found by them), no form controls or dialogs, named
 * properties sanitized. A public question can steer the model's output, so
 * nothing in an answer may pose as one of the page's controls.
 */
export const PURIFY = Object.freeze({ FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false, SANITIZE_NAMED_PROPS: true, FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'dialog'] });

/** The answer's markdown as the chat page renders it, or escaped text where marked or DOMPurify is missing. */
export function md(s) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return g.marked && g.DOMPurify ? g.DOMPurify.sanitize(g.marked.parse(String(s || '')), { ...PURIFY, FORBID_ATTR: [...PURIFY.FORBID_ATTR], FORBID_TAGS: [...PURIFY.FORBID_TAGS] }) : `<p>${esc(s)}</p>`;
}

/** The line beside the ask button once signed in (docs/free-tier.md, exact copy). */
export function publicLine(handle) {
  return handle
    ? `Public: anyone can read this question and its answer, with your handle @${handle}.`
    : "Public: anyone can read this question and its answer, with your account's DID.";
}

// The hand-off: who to contact, records, web pages, the data, links.
export function resourcesHtml(r = {}) {
  const parts = [];
  const contacts = Array.isArray(r.contacts) ? r.contacts : [];
  if (contacts.length) {
    parts.push(`<details><summary>Who to contact <small>(${contacts.length})</small></summary><ul class="plain">${contacts.map((c) => `<li><span class="role">${esc(c.role)}</span>${[c.name && esc(c.name), c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`, c.phone && `<a href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>`, c.url && `<a href="${link(c.url)}" target="_blank" rel="noopener">website</a>`].filter(Boolean).join(' · ')}${c.note ? `<br><small>${esc(c.note)}</small>` : ''}</li>`).join('')}</ul></details>`);
  }
  const all = Array.isArray(r.records) ? r.records : [];
  const records = all.filter((x) => x.kind !== 'web');
  const pages = all.filter((x) => x.kind === 'web');
  if (records.length) {
    parts.push(`<details><summary>Public records <small>(${records.length})</small></summary><ul class="plain">${records.map((x) => `<li><a href="${link(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join('')}</ul></details>`);
  }
  if (pages.length) {
    parts.push(`<details><summary>Web pages <small>(${pages.length})</small></summary><p class="meta">Found by web search, which Anthropic runs, on the official sites this deployment allows. A web page is not a record: it says what it said when the search found it.</p><ul class="plain">${pages.map((x) => `<li><a href="${link(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a>${x.page_age ? ` <small>${esc(x.page_age)}</small>` : ''}</li>`).join('')}</ul></details>`);
  }
  const datasets = Array.isArray(r.datasets) ? r.datasets : [];
  if (datasets.length) {
    parts.push(`<details><summary>Download the data <small>(${datasets.length} datasets)</small></summary><ul class="plain">${datasets.map((d) => `<li><strong>${esc(d.name || d.id)}</strong>${d.department ? ` <small>from ${esc(d.department)}</small>` : ''}<div class="links"><a href="${link(d.page)}" target="_blank" rel="noopener">dataset page</a>${d.csv ? `<a href="${link(d.csv)}">full CSV</a>` : ''}${(Array.isArray(d.queries) ? d.queries : []).map((q, i) => `<a href="${link(q)}">these rows${d.queries.length > 1 ? ` (${i + 1})` : ''} as CSV</a>`).join('')}<a href="${link(d.docs)}" target="_blank" rel="noopener">API docs</a></div></li>`).join('')}</ul></details>`);
  }
  const links = Array.isArray(r.links) ? r.links : [];
  if (links.length) {
    parts.push(`<details><summary>Go further</summary><ul class="plain">${links.map((l) => `<li><a href="${link(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a></li>`).join('')}</ul></details>`);
  }
  return parts.join('');
}

// A web search step's tool name: WEB_SEARCH_STEP in src/web-search.js (the
// chat page names it the same way).
const WEB_STEP = 'web search (run by Anthropic)';
function traceStep(s) {
  if (s.tool === WEB_STEP) {
    const status = s.ok ? (s.rows == null ? 'ok' : plural(s.rows, 'result')) : `failed: ${esc(s.error)}`;
    const docs = /^https:\/\/platform\.claude\.com\//.test(String(s.url || ''));
    return `<li><strong>${esc(s.tool)}</strong>${s.soql ? `<code>${esc(s.soql)}</code>` : ''}<span class="meta">${status} · ${Number(s.ms) || 0} ms · <a href="${link(s.url)}" target="_blank" rel="noopener">${docs ? 'how web search works' : 'first page found'}</a></span></li>`;
  }
  return `<li><strong>${esc(s.tool)}</strong>${s.dataset ? ` · <code class="ds">${esc(s.dataset)}</code>` : ''}${s.soql ? `<code>${esc(s.soql)}</code>` : ''}<span class="meta">${s.ok ? (s.rows == null ? 'ok' : plural(s.rows, 'row')) : `${s.refused ? 'refused' : 'failed'}: ${esc(s.error)}`} · ${Number(s.ms) || 0} ms · <a href="${link(s.url)}" target="_blank" rel="noopener">run it yourself</a></span></li>`;
}

/** How she found it: the code-written trace. */
export function traceHtml(t) {
  if (!Array.isArray(t) || !t.length) return '';
  const refused = t.filter((s) => s.refused).length;
  const searches = t.filter((s) => !s.refused && s.tool === WEB_STEP).length;
  const queries = t.length - refused - searches;
  const counts = [];
  if (queries || !searches) counts.push(`${queries} quer${queries === 1 ? 'y' : 'ies'}`);
  if (searches) counts.push(plural(searches, 'web search', 'web searches'));
  if (refused) counts.push(`${refused} not sent`);
  return `<details><summary>How I found this <small>(${counts.join(', ')})</small></summary><ol class="trace">${t.map(traceStep).join('')}</ol></details>`;
}

/** An answer with what was found behind it: the voice notice, suggested sources (as text), the hand-off, the trace, the model line. */
export function answerHtml(answer, r = {}, { render = md } = {}) {
  const rb = r.requestBudget;
  const how = r.model ? `${esc(r.model)} · ${plural(Number(r.steps) || 0, 'step')}${rb && Number.isFinite(rb.used) ? ` · ${plural(rb.used, 'request')}${rb.limit ? ` of ${esc(rb.limit)}` : ''}` : ''}` : '';
  const sugg = Array.isArray(r.suggestions) && r.suggestions.length
    ? `<p class="meta">Sources that would answer more: ${r.suggestions.map((s) => esc(s.source)).join('; ')}.</p>`
    : '';
  return `<div class="answer">${render(answer)}</div>${r.voice && !r.voice.ok ? '<p class="notice">This answer states some things as fact rather than as what the records show. Check them against the trace.</p>' : ''}${rb?.note ? `<p class="notice">${esc(rb.note)}</p>` : ''}${sugg}${resourcesHtml(r.resources || {})}${traceHtml(r.trace)}${how ? `<p class="meta">${how}</p>` : ''}`;
}

/** The flags shown next to an asker: shown, never used to leave anyone out. */
export function flagsHtml(flags) {
  if (!Array.isArray(flags)) return '';
  return flags.map((f) => `<span class="flag" title="${esc(f.reason)}">${esc(f.reason)}</span>`).join('');
}

/** What the page says when a withdrawal couldn't reach Siren: true, and no time promised. */
export const RECHECKS = 'Siren checks every public question regularly and takes it down when it finds the record gone.';

/** Why a thread takes no more follow-ups, as the page says it. */
export const CLOSED = {
  full: 'This thread is full, so it takes no more follow-ups. Ask a new question instead.',
  withdrawn: 'The first question of this thread was withdrawn, so it takes no more follow-ups.',
  hidden: 'The first question of this thread is hidden, so it takes no more follow-ups.',
};

/** What a withdrawn question's page says, and nothing else. */
export const WITHDRAWN = 'The asker withdrew this question.';
/** What a hidden question says in its thread. */
export const HIDDEN = 'Hidden by the steward.';

/**
 * One public question. `mine`: the signed-in account asked it (a Withdraw
 * button). `cityName(id)` names a city. `current`: the question this page is
 * for (highlighted). `children`: its replies, already rendered.
 */
export function entryHtml(q, { base = '', mine = false, cityName = (c) => c, render = md, current = false, children = '' } = {}) {
  const id = ID_RE.test(String(q.id)) ? q.id : '';
  const page = id ? esc(`${base}/q/${id}`) : '#';
  if (q.withdrawn || q.hidden) {
    return `<li class="q placeholder${current ? ' current' : ''}" id="q-${esc(id)}"><p class="small">${q.hidden ? HIDDEN : WITHDRAWN}</p>${children ? `<ol class="replies">${children}</ol>` : ''}</li>`;
  }
  const profile = DID_RE.test(String(q.did)) ? `https://bsky.app/profile/${encodeURIComponent(q.did)}` : '#';
  const who = q.handle ? `@${esc(q.handle)}` : 'an account whose handle wasn\'t verified';
  const day = DAY_RE.test(String(q.day)) ? esc(q.day) : '';
  const when = day && id && !current ? `<a href="${page}">${day}</a>` : day;
  const replies = (Number.isInteger(q.replies) && q.replies > 0 ? ` · <a href="${page}">${plural(q.replies, 'reply', 'replies')}</a>` : '') + (q.thread_full ? ' · thread full' : '');
  const actions = [
    q.followup ? `<button type="button" class="link" data-followup="${esc(id)}">Ask a follow-up</button>` : '',
    mine ? `<button type="button" class="link" data-withdraw="${esc(q.uri)}">Withdraw this question</button>` : '',
  ].filter(Boolean).join(' · ');
  return `<li class="q${current ? ' current' : ''}" id="q-${esc(id)}">
    <div class="by"><a href="${profile}" target="_blank" rel="noopener">${who}</a>${flagsHtml(q.flags)}<span class="small">${when ? ` · ${when}` : ''}${q.city ? ` · ${esc(cityName(q.city))}` : ''}${replies}</span></div>
    <p class="question">${esc(q.question)}</p>
    <div class="a">${answerHtml(q.answer, q.record || {}, { render })}</div>
    ${actions ? `<p class="actions">${actions}</p>` : ''}
    ${children ? `<ol class="replies">${children}</ol>` : ''}
  </li>`;
}

/**
 * A whole thread, root first, each reply nested under its parent (`parent`:
 * the parent's id). `current`: the id this page is for. `mine(q)`: whether
 * the signed-in account asked it.
 */
export function threadHtml(thread, { current = '', mine = () => false, ...opts } = {}) {
  const list = Array.isArray(thread) ? thread.filter((q) => q && ID_RE.test(String(q.id))) : [];
  const ids = new Set(list.map((q) => q.id));
  const kids = new Map();
  for (const q of list) {
    const p = q.parent && ids.has(q.parent) && q.parent !== q.id ? q.parent : '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(q);
  }
  const seen = new Set();
  const render = (q) => {
    if (seen.has(q.id)) return '';
    seen.add(q.id);
    return entryHtml(q, { ...opts, current: q.id === current, mine: mine(q), children: (kids.get(q.id) || []).map(render).join('') });
  };
  return (kids.get('') || []).map(render).join('');
}

// ---- The page ------------------------------------------------------------

const DRAFT = 'siren-public-draft';

async function main() {
  const $ = (s) => document.getElementById(s);
  const d = document.body.dataset;
  const base = d.base || '';
  const focus = ID_RE.test(d.focus || '') ? d.focus : '';
  const loading = d.loading || 'Looking it up. This usually takes 10 to 30 seconds';
  const say = (t) => { $('status').textContent = t || ''; };
  let client = null;
  let session = null;
  let messages = {};
  let invited = false;
  let skew = 0;
  let cities = [];
  let questions = [];
  let cursor = null;
  let busy = false;
  // The thread on a question's page, and the question a follow-up replies to.
  let thread = [];
  let replyTo = null;

  const cityName = (id) => cities.find((c) => c.id === id)?.name || id;
  const fail = (err) => say(messages[err?.code] || "That didn't work. Try again in a minute.");
  const store = (fn) => {
    try {
      return fn(window.sessionStorage);
    } catch {
      return null;
    }
  };
  const saveDraft = () => store((s) => s.setItem(DRAFT, JSON.stringify({ q: $('q').value, city: $('city').value, replyTo })));
  const clearDraft = () => store((s) => s.removeItem(DRAFT));

  const mine = (q) => Boolean(session && q.did && session.did === q.did);
  const render = () => {
    if (focus) {
      if (thread.length) $('list').innerHTML = threadHtml(thread, { base, current: focus, mine, cityName });
      return;
    }
    $('list').innerHTML = questions.length
      ? questions.map((q) => entryHtml(q, { base, mine: mine(q), cityName })).join('')
      : '<li class="q empty">No public questions yet.</li>';
    $('more').hidden = !cursor;
  };
  const renderReply = () => {
    $('ask-title').textContent = replyTo ? 'Ask a follow-up' : 'Ask a question';
    $('reply-to').hidden = !replyTo;
    $('reply-text').textContent = replyTo ? `Following up on: ${String(replyTo.question || '').slice(0, 140)}` : '';
    $('city').disabled = Boolean(replyTo);
    if (replyTo && cities.some((c) => c.id === replyTo.city)) $('city').value = replyTo.city;
  };
  const renderPanel = () => {
    // On a question's page the panel opens for a follow-up only.
    $('ask').hidden = !client || (Boolean(focus) && !replyTo);
    $('ask-intro').hidden = Boolean(session);
    $('bsky-form').hidden = Boolean(session);
    $('signed-in').hidden = !session;
    $('invite-form').hidden = invited;
    if (session) {
      $('who').textContent = session.handle ? `Signed in with Bluesky as @${session.handle}` : 'Signed in with your Bluesky account';
      $('public-line').textContent = publicLine(session.handle);
    }
    $('city').innerHTML = cities.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    $('city-label').hidden = cities.length < 2;
    renderReply();
  };

  async function load(next) {
    try {
      const res = await fetch(`${base}/api/questions${next ? `?cursor=${encodeURIComponent(next)}` : ''}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(res.status));
      questions = next ? [...questions, ...(data.questions || [])] : data.questions || [];
      cursor = data.cursor || null;
      $('meta').textContent = data.flags_unavailable ? 'Newest first. Account flags can\'t be read just now.' : 'Newest first.';
    } catch {
      $('meta').textContent = "Couldn't load the questions. Try again.";
    }
    render();
  }

  async function loadOne() {
    try {
      const res = await fetch(`${base}/api/q/${encodeURIComponent(focus)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.thread)) throw new Error(String(res.status));
      // A withdrawn question says only that, in the thread that stays.
      thread = data.thread.length ? data.thread : [{ id: focus, withdrawn: true }];
      const closed = data.thread_open === false && thread.length > 1 && CLOSED[data.thread_closed] ? ` ${CLOSED[data.thread_closed]}` : '';
      $('meta').textContent = `${thread.length > 1 ? `A thread of ${plural(thread.length, 'question')}, oldest first; this one is highlighted.` : ''}${closed}${data.flags_unavailable ? ' Account flags can\'t be read just now.' : ''}`.trim();
    } catch {
      thread = [];
      $('list').innerHTML = '<li class="q empty">No public question has that id.</li>';
      $('meta').textContent = '';
      return;
    }
    render();
  }

  try {
    cities = await (await fetch(`${base}/api/cities`)).json();
    if (!Array.isArray(cities)) cities = [];
  } catch {
    cities = [];
  }
  try {
    const res = await fetch(`${base}/api/public/session`, { cache: 'no-store' });
    const s = await res.json();
    invited = s.invited === true;
    if (Number.isFinite(s.now)) skew = s.now - Date.now();
  } catch {
    invited = false;
  }
  try {
    const [{ createClient, workerResolver, MESSAGES }, { bestStore }] = await Promise.all([import('./endorse-client.js'), import('./endorse-store.js')]);
    messages = MESSAGES;
    client = createClient({ origin: d.origin, base, store: await bestStore(), resolveFallback: workerResolver(base), kind: 'ask' });
    if (location.hash.length > 1) {
      const frag = location.hash;
      history.replaceState(null, '', location.pathname + location.search);
      try {
        if (await client.finish(frag)) say('Signed in with Bluesky.');
      } catch (err) {
        fail(err);
      }
    }
    session = await client.current();
  } catch {
    client = null;
  }
  renderPanel();
  const draft = store((s) => JSON.parse(s.getItem(DRAFT) || 'null'));
  if (draft && typeof draft.q === 'string') {
    $('q').value = draft.q.slice(0, 600);
    if (cities.some((c) => c.id === draft.city)) $('city').value = draft.city;
    if (draft.replyTo && ID_RE.test(String(draft.replyTo.id)) && draft.replyTo.followup) replyTo = draft.replyTo;
    renderPanel();
  }
  if (focus) await loadOne();
  else await load();

  const reauth = async () => {
    saveDraft();
    try {
      location.assign(await client.signIn(session.did));
    } catch (err) {
      fail(err);
    }
  };

  $('bsky-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!client) return;
    const account = $('bsky-account').value.trim();
    if (!account) return;
    say('Starting the sign-in…');
    saveDraft();
    try {
      location.assign(await client.signIn(account));
    } catch (err) {
      fail(err);
    }
  });

  $('invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    say('Checking…');
    try {
      const res = await fetch(`${base}/api/public/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('invite-code').value }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return say(data.error || "That code didn't work.");
      invited = true;
      renderPanel();
      say('Invite accepted.');
    } catch {
      say("Couldn't reach the server. Try again.");
    }
    return undefined;
  });

  $('signout').addEventListener('click', async () => {
    await client?.signOut();
    session = null;
    renderPanel();
    render();
    say('Signed out of Bluesky.');
  });

  $('q-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy || !client || !session) return;
    const text = $('q').value.trim();
    if (!text) return;
    if (!invited) {
      say('Enter your invite code first.');
      $('invite-code').focus();
      return;
    }
    const city = replyTo?.city || $('city').value || cities[0]?.id;
    const reply = replyTo?.followup || null;
    busy = true;
    $('go').disabled = true;
    try {
      say('Saving your question to your Bluesky account…');
      let rec;
      try {
        rec = await client.askQuestion({ text, city, now: Date.now() + skew, reply });
      } catch (err) {
        if (err?.code === 'reauth') return reauth();
        return fail(err);
      }
      say(loading);
      let res = null;
      let data = {};
      try {
        res = await fetch(`${base}/api/public/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri: rec.uri, cid: rec.cid }) });
        data = await res.json().catch(() => ({}));
      } catch {
        res = null;
      }
      if (res?.ok) {
        $('q').value = '';
        clearDraft();
        // Its own page, in its thread.
        if (data.id && ID_RE.test(data.id) && (reply || focus)) {
          location.assign(`${base}/q/${data.id}`);
          return undefined;
        }
        say('Answered. It is public now, at the top of the list.');
        await load();
        return undefined;
      }
      if (!res) return say('The connection dropped before the answer arrived. If it finishes, it will be on the list in a minute.');
      if (res.status === 409 && data.code === 'answering') return say(data.error);
      // Refused, or the answer failed: nothing public was kept, so the record goes too.
      let removed = false;
      try {
        await client.deleteQuestion(rec.uri);
        removed = true;
      } catch {
        removed = false;
      }
      if (res.status === 401 && data.gate === 'invite') {
        invited = false;
        renderPanel();
      }
      say(`${data.error || 'Something went wrong.'} ${removed ? 'The question record was deleted from your Bluesky account.' : 'The question record is still in your Bluesky account; delete it there if you like.'}`);
    } finally {
      busy = false;
      $('go').disabled = false;
    }
    return undefined;
  });

  $('more').addEventListener('click', () => load(cursor));

  $('reply-cancel').addEventListener('click', () => {
    replyTo = null;
    renderPanel();
  });

  $('list').addEventListener('click', async (e) => {
    // Nothing inside an answer acts: answers are model output.
    if (e.target.closest('.answer')) return undefined;
    const f = e.target.closest('button[data-followup]');
    if (f) {
      const q = [...questions, ...thread].find((x) => x.id === f.dataset.followup);
      if (!q?.followup) return undefined;
      replyTo = { id: q.id, question: q.question, city: q.city, followup: q.followup };
      renderPanel();
      $('ask').scrollIntoView({ behavior: 'smooth', block: 'start' });
      (session ? $('q') : $('bsky-account')).focus();
      return undefined;
    }
    const b = e.target.closest('button[data-withdraw]');
    if (!b || !client) return undefined;
    const uri = b.dataset.withdraw;
    if (!confirm('Delete this question from your Bluesky account and take its page down here?')) return;
    try {
      await client.deleteQuestion(uri);
    } catch (err) {
      if (err?.code === 'reauth') return reauth();
      return fail(err);
    }
    try {
      const res = await fetch(`${base}/api/public/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uri }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return say(data.error ? `${data.error} The record is deleted from your account. ${RECHECKS}` : `The record is deleted, but the page couldn't be taken down just now. ${RECHECKS}`);
      questions = questions.filter((q) => q.uri !== uri);
      if (focus) await loadOne();
      else render();
      say('Withdrawn: the record is deleted and its page is down.');
    } catch {
      say(`The record is deleted, but the page couldn't be taken down just now. ${RECHECKS}`);
    }
    return undefined;
  });
}

if (typeof document !== 'undefined' && document.body) main();
