// The steward's page for public questions (admin-questions.html at
// /admin/questions; the free tier, docs/free-tier.md), served under the same
// strict Content-Security-Policy as the public pages: no inline script,
// style or handler. Every string from a question is escaped and shown as
// plain text (no markdown here). The steward hides or unhides; nothing else.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ID_RE = /^[a-z2-7]{16}$/;
const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/;

/** One row for the steward: status, asker, day, question, the start of the answer, and its button. */
export function rowHtml(q, { base = '' } = {}) {
  const id = ID_RE.test(String(q.id)) ? q.id : '';
  const status = ['answering', 'answered', 'withdrawn', 'hidden'].includes(q.status) ? q.status : 'unknown';
  const who = q.handle ? `@${esc(q.handle)}` : DID_RE.test(String(q.did)) ? esc(q.did) : '';
  const answer = String(q.answer ?? '');
  const button = status === 'answered' ? `<button type="button" data-id="${esc(id)}" data-hidden="true">Hide</button>`
    : status === 'hidden' ? `<button type="button" data-id="${esc(id)}" data-hidden="false">Unhide</button>` : '';
  return `<li class="q">
    <div class="by"><span class="chip ${esc(status)}">${esc(status)}</span>${who}<span class="small"> · ${esc(q.day)}${q.city ? ` · ${esc(q.city)}` : ''}${status === 'answered' && id ? ` · <a href="${esc(`${base}/q/${id}`)}">its page</a>` : ''} · ${esc(id)}</span></div>
    ${q.question ? `<p class="question">${esc(q.question)}</p>` : ''}
    ${answer ? `<p class="small">${esc(answer.slice(0, 400))}${answer.length > 400 ? '…' : ''}</p>` : ''}
    ${button ? `<div class="steward">${button}</div>` : ''}
  </li>`;
}

async function main() {
  const $ = (s) => document.getElementById(s);
  const base = document.body.dataset.base || '';
  const say = (t) => { $('status').textContent = t || ''; };
  let rows = [];
  const render = () => {
    $('list').innerHTML = rows.length ? rows.map((q) => rowHtml(q, { base })).join('') : '<li class="q empty">No public questions yet.</li>';
  };
  async function load() {
    try {
      const res = await fetch(`${base}/api/admin/questions`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return say('Sign in on the main page with a steward\'s email first.');
      if (!res.ok) return say(data.error || "Couldn't load the questions.");
      rows = data.questions || [];
      say(`${rows.length} question${rows.length === 1 ? '' : 's'}, newest first.`);
      render();
    } catch {
      say("Couldn't reach the server. Try again.");
    }
    return undefined;
  }
  $('list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    b.disabled = true;
    try {
      const res = await fetch(`${base}/api/admin/questions/hide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id, hidden: b.dataset.hidden === 'true' }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) say(data.error || 'That didn\'t work.');
      await load();
    } catch {
      say("Couldn't reach the server. Try again.");
      b.disabled = false;
    }
  });
  await load();
}

if (typeof document !== 'undefined' && document.body) main();
