// The steward's waitlist page (admin-waitlist.html at /admin/waitlist),
// under the strict Content-Security-Policy: no inline script, style or
// handler. Every string from an entry is someone's own typing, escaped and
// shown as plain text. The steward sends a code or removes; nothing else.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ID_RE = /^[0-9a-f]{64}$/;

/** One entry's card: email, name and organization, when and where they joined, their note, and the two buttons. */
export function entryHtml(e, { canSend = true } = {}) {
  const id = ID_RE.test(String(e.id)) ? e.id : '';
  const who = [e.name, e.org].filter(Boolean).map(esc).join(' · ');
  const when = String(e.at || '').slice(0, 10);
  const buttons = id
    ? `<div class="actions"><button type="button" class="primary" data-id="${esc(id)}" data-action="invite"${canSend ? '' : ' disabled'}>Send a code</button><button type="button" data-id="${esc(id)}" data-action="remove">Remove</button><span class="msg" role="status"></span></div>`
    : '';
  return `<li class="card" data-id="${esc(id)}">
    <div class="who"><span class="email">${esc(e.email)}</span><span class="small">joined ${esc(when || '?')}${e.source ? ` · from ${esc(e.source)}` : ''}</span></div>
    ${who ? `<p class="small">${who}</p>` : ''}
    ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
    ${buttons}
  </li>`;
}

async function main() {
  const $ = (s) => document.getElementById(s);
  const base = document.body.dataset.base || '';
  const say = (t, bad = false) => {
    $('status').textContent = t || '';
    $('status').classList.toggle('bad', bad);
  };
  let data = { entries: [] };
  const render = () => {
    const can = data.can_send !== false;
    $('list').innerHTML = data.entries.length ? data.entries.map((e) => entryHtml(e, { canSend: can })).join('') : '<li class="card small">Nobody is waiting.</li>';
  };
  const summary = () => {
    const n = data.entries.length;
    const parts = [`${n} ${n === 1 ? 'person' : 'people'} waiting${data.truncated ? ' (the first 1,000 shown)' : ''}.`];
    if (data.send_blocked) parts.push(data.send_blocked);
    if (data.invite_only === false) parts.push("Siren isn't invite-only right now, so anyone can ask without a code; a code sent now still works if invite-only is turned back on.");
    return parts.join(' ');
  };
  async function load() {
    try {
      const res = await fetch(`${base}/api/admin/waitlist`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) return say("Sign in on the main page with a steward's email first.", true);
      if (!res.ok) return say(body.error || "Couldn't load the waitlist.", true);
      data = body;
      say(summary(), Boolean(data.send_blocked));
      render();
    } catch {
      say("Couldn't reach the server. Try again.", true);
    }
    return undefined;
  }
  $('list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const li = b.closest('li.card');
    const entry = data.entries.find((x) => x.id === b.dataset.id);
    const msg = li.querySelector('.msg');
    const invite = b.dataset.action === 'invite';
    const question = invite
      ? `Email a new invite code to ${entry?.email || 'this person'}? They'll come off the waitlist.`
      : `Take ${entry?.email || 'this person'} off the waitlist without sending anything?`;
    if (!confirm(question)) return;
    for (const x of li.querySelectorAll('button')) x.disabled = true;
    msg.textContent = invite ? 'Sending…' : 'Removing…';
    try {
      const res = await fetch(`${base}/api/admin/waitlist/${invite ? 'invite' : 'remove'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: b.dataset.id }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        msg.textContent = body.error || "That didn't work.";
        for (const x of li.querySelectorAll('button')) x.disabled = invite && data.can_send === false && x.dataset.action === 'invite';
        return;
      }
      data.entries = data.entries.filter((x) => x.id !== b.dataset.id);
      render();
      say(`${invite ? `Sent a code to ${body.email || entry?.email || 'them'}; they're off the waitlist.` : 'Removed.'} ${summary()}`);
    } catch {
      msg.textContent = "Couldn't reach the server. Reload to see whether it went through before trying again.";
    }
  });
  await load();
}

if (typeof document !== 'undefined') main();
