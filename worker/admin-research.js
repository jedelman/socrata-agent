// The steward's page for shared sources (admin-research.html at
// /admin/research; research memory, docs/research-memory.md), served under
// the same strict Content-Security-Policy as the steward's questions page:
// no inline script, style or handler. Every string is escaped and shown as
// plain text, and a source's link is shown only when it is https. The
// steward removes or restores; nothing else.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ID_RE = /^[a-z2-7]{16}$/;
const https = (u) => (/^https:\/\//i.test(String(u || '')) ? esc(u) : '');

/** One row for the steward: status, title and link, kind, city, days, shares, and its button. */
export function rowHtml(s) {
  const id = ID_RE.test(String(s.id)) ? s.id : '';
  const status = s.status === 'removed' ? 'removed' : 'listed';
  const href = https(s.url);
  const button = id ? `<button type="button" data-id="${esc(id)}" data-action="${status === 'listed' ? 'remove' : 'restore'}">${status === 'listed' ? 'Remove' : 'Restore'}</button>` : '';
  return `<li class="q">
    <div class="by"><span class="chip ${esc(status)}">${esc(status)}</span><span class="small">${esc(s.kind)} · ${esc(s.city)} · read ${esc(s.read_day)} · shared ${esc(s.first_day)}${s.last_day !== s.first_day ? ` to ${esc(s.last_day)}` : ''} · ${esc(Number(s.shares) || 1)}× · ${esc(id)}</span></div>
    <p class="question">${href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : esc(s.title)}</p>
    ${href ? `<p class="small">${esc(s.url)}</p>` : ''}
    ${button ? `<div class="steward">${button}</div>` : ''}
  </li>`;
}

async function main() {
  const $ = (s) => document.getElementById(s);
  const base = document.body.dataset.base || '';
  const say = (t) => { $('status').textContent = t || ''; };
  let rows = [];
  const render = () => {
    $('list').innerHTML = rows.length ? rows.map((s) => rowHtml(s)).join('') : '<li class="q empty">No shared sources yet.</li>';
  };
  async function load() {
    try {
      const res = await fetch(`${base}/api/admin/research`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return say('Sign in on the main page with a steward\'s email first.');
      if (!res.ok) return say(data.error || "Couldn't load the shared sources.");
      rows = data.sources || [];
      say(`${rows.length} shared source${rows.length === 1 ? '' : 's'}, newest first.`);
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
      const res = await fetch(`${base}/api/admin/research/${b.dataset.action === 'restore' ? 'restore' : 'remove'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id }) });
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

if (typeof document !== 'undefined' && document.getElementById('list')) main();
