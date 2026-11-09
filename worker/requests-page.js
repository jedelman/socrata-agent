// The requests page (requests.html), as a module the Worker serves under a
// strict Content-Security-Policy (no inline script). The render helpers are
// pure and exported, so Node tests check the escaping and the wording; the
// page itself starts only in a browser. With endorsing on, it loads the
// browser OAuth client (endorse-client.js) and talks to the person's own
// Bluesky server directly; Siren's Worker gets no token, ever.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const link = (u) => (/^https:\/\//i.test(String(u || '')) ? esc(u) : '#');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The endorsement part of an item's count line: never a 0 standing in for a count that couldn't be read. */
export function countLine(r, { endorse = false } = {}) {
  if (!('endorsements' in r)) return '';
  if (r.endorsements === null || r.endorsements_unavailable) return ' · Endorsement count unavailable right now';
  const n = Number(r.endorsements);
  if (!Number.isFinite(n)) return '';
  let s = ` · ${plural(n, 'Bluesky endorsement')}`;
  if (typeof r.endorsements_as_of === 'string' && /T\d{2}:\d{2}/.test(r.endorsements_as_of)) s += ` (as of ${esc(r.endorsements_as_of.slice(11, 16))} UTC)`;
  if (Number.isFinite(r.endorsements_at_decision)) s += ` · ${r.endorsements_at_decision} at decision`;
  if (endorse && n > 0) s += ` · <button type="button" class="link" data-who="${esc(r.id)}">see who</button>`;
  return s;
}

/** One request on the list. */
export function itemHtml(r, { endorse = false, endorsed = new Set(), inFlight = new Set(), repo = '', focus = '' } = {}) {
  const on = endorsed.has(r.id);
  const button = endorse && r.status === 'accepted' && 'endorsements' in r
    ? ` <button type="button" class="endorse" data-id="${esc(r.id)}" aria-pressed="${on}"${inFlight.has(r.id) ? ' disabled' : ''}>${on ? 'Endorsed (undo)' : 'Endorse'}</button>`
    : '';
  const notes = Array.isArray(r.notes) ? r.notes : [];
  return `<li class="req${focus === r.id ? ' focus' : ''}" id="r-${esc(r.id)}">
    <div class="top"><span class="src">${esc(r.source)}</span><span class="count">${plural(Number(r.count) || 0, 'person', 'people')} asked${countLine(r, { endorse })}</span></div>
    <div><span class="chip ${esc(r.status)}">${r.status === 'fulfilled' ? 'Fulfilled' : 'Open'}</span><small class="count">since ${esc(String(r.first || '').slice(0, 10))}</small>${button}</div>
    ${r.steward_note ? `<p class="steward">${esc(r.steward_note)}</p>` : ''}
    ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <div class="links">
      ${r.url ? `<a href="${link(r.url)}" target="_blank" rel="noopener">The source</a>` : ''}
      <a href="${link(`${repo}/issues?q=${encodeURIComponent(`label:source-request ${r.id}`)}`)}" target="_blank" rel="noopener">Discussion on GitHub</a>
      ${r.fulfilled_by ? `<a href="${link(r.fulfilled_by)}" target="_blank" rel="noopener">How it was fulfilled</a>` : ''}
    </div>
    <div class="who" id="who-${esc(r.id)}" hidden></div>
  </li>`;
}

const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/;

/** One page of endorsers, appended under a request. Every string from the network is escaped. */
export function endorsersHtml(page, { first = true } = {}) {
  const list = Array.isArray(page?.endorsers) ? page.endorsers : [];
  const flagged = list.filter((e) => Array.isArray(e.flags) && e.flags.length).length;
  const head = first ? `<p class="small">${plural(Number(page.total) || 0, 'account')} endorsed this${flagged ? ` · ${flagged} of those shown flagged` : ''}. Flagged accounts still count.</p>` : '';
  const items = list.map((e) => {
    const profile = DID_RE.test(String(e.did)) ? `https://bsky.app/profile/${encodeURIComponent(e.did)}` : '#';
    const who = e.handle ? `@${esc(e.handle)}` : 'an account with no handle';
    const name = e.displayName ? ` <span class="name">${esc(e.displayName)}</span>` : '';
    const day = typeof e.endorsed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.endorsed) ? ` · endorsed ${esc(e.endorsed)}` : '';
    const flags = (Array.isArray(e.flags) ? e.flags : []).map((f) => `<span class="flag" title="${esc(f.reason)}">${esc(f.reason)}</span>`).join('');
    return `<li><a href="${profile}" target="_blank" rel="noopener">${who}</a>${name}${day}${flags}</li>`;
  }).join('');
  const dropped = Number(page.dropped) > 0 ? `<p class="small">${plural(Number(page.dropped), 'listed account')} left out: the endorsement wasn't found on the account's own server (the index is out of date), or couldn't be checked just now.</p>` : '';
  const more = page.cursor ? `<button type="button" class="link" data-more="${esc(page.cursor)}">more</button>` : '';
  return `${head}<ul>${items}</ul>${dropped}${more}`;
}

// ---- The page ------------------------------------------------------------

async function main() {
  const $ = (s) => document.getElementById(s);
  const d = document.body.dataset;
  const base = d.base || '';
  const repo = d.repo || '';
  const focus = d.focus || '';
  const endorseOn = d.endorse === 'on';
  const say = (t) => { $('bsky-status').textContent = t || ''; };
  let requests = [];
  let endorsed = new Set();
  const inFlight = new Set();
  let client = null;
  let session = null;
  let messages = {};
  let pending = null; // a request to endorse once signed in

  const render = () => {
    $('list').innerHTML = requests.length
      ? requests.map((r) => itemHtml(r, { endorse: endorseOn, endorsed, inFlight, repo, focus })).join('')
      : '<li class="req empty">No reviewed requests yet.</li>';
  };
  const renderPanel = () => {
    $('bsky').hidden = !endorseOn;
    $('bsky-form').hidden = Boolean(session);
    $('bsky-in').hidden = !session;
    if (session) $('bsky-who').textContent = session.handle ? `Signed in with Bluesky as @${session.handle}` : 'Signed in with your Bluesky account';
  };
  const fail = (err) => say(messages[err?.code] || "That didn't work. Try again in a minute.");

  try {
    const res = await fetch(`${base}/api/requests`);
    if (!res.ok) throw new Error(String(res.status));
    requests = (await res.json()).requests || [];
    $('meta').textContent = `${plural(requests.length, 'reviewed request')}. Requests appear here after a steward reviews them.`;
  } catch {
    $('meta').textContent = "Couldn't load the list. Try again.";
  }

  if (endorseOn) {
    try {
      const [{ createClient, workerResolver, MESSAGES }, { bestStore }] = await Promise.all([import('./endorse-client.js'), import('./endorse-store.js')]);
      messages = MESSAGES;
      client = createClient({ origin: d.origin, base, store: await bestStore(), resolveFallback: workerResolver(base) });
      if (location.hash.length > 1) {
        const frag = location.hash;
        history.replaceState(null, '', location.pathname + location.search);
        try {
          const out = await client.finish(frag);
          if (out) {
            say('Signed in with Bluesky.');
            pending = out.after;
          }
        } catch (err) {
          fail(err);
        }
      }
      session = await client.current();
      if (session) endorsed = await client.endorsedIds(requests.map((r) => r.id)).catch(() => new Set());
    } catch {
      client = null;
    }
  }
  renderPanel();
  render();
  if (focus) document.getElementById(`r-${focus}`)?.scrollIntoView();

  const reauth = async (id) => {
    try {
      location.assign(await client.signIn(session.did, id));
    } catch (err) {
      fail(err);
    }
  };

  async function toggle(id, want) {
    if (inFlight.has(id) || !client) return;
    inFlight.add(id);
    render();
    try {
      if (want) {
        const out = await client.endorse({ id, source: requests.find((r) => r.id === id)?.source });
        endorsed.add(id);
        const r = requests.find((x) => x.id === id);
        if (r && Number.isFinite(r.endorsements) && !out.already) r.endorsements += 1;
        say('Endorsed. Counts can take a minute or two to update.');
      } else {
        await client.withdraw(id);
        endorsed.delete(id);
        const r = requests.find((x) => x.id === id);
        if (r && Number.isFinite(r.endorsements) && r.endorsements > 0) r.endorsements -= 1;
        say('Endorsement withdrawn.');
      }
    } catch (err) {
      if (err?.code === 'reauth') return reauth(id);
      if (err?.code === 'signed_out') {
        session = null;
        renderPanel();
      }
      fail(err);
    } finally {
      inFlight.delete(id);
      render();
    }
  }

  if (pending && session && !endorsed.has(pending) && requests.some((r) => r.id === pending && r.status === 'accepted')) await toggle(pending, true);

  async function showWho(id, cursor) {
    const box = document.getElementById(`who-${id}`);
    if (!box) return;
    box.hidden = false;
    if (!cursor) box.innerHTML = '<p class="small">Loading…</p>';
    try {
      const res = await fetch(`${base}/api/requests/${encodeURIComponent(id)}/endorsers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      const page = await res.json().catch(() => ({}));
      if (!res.ok) {
        box.innerHTML = `<p class="small">${esc(page.error || 'The list of endorsers is unavailable right now.')}</p>`;
        return;
      }
      box.querySelector('[data-more]')?.remove();
      if (cursor) box.insertAdjacentHTML('beforeend', endorsersHtml(page, { first: false }));
      else box.innerHTML = endorsersHtml(page);
    } catch {
      box.innerHTML = '<p class="small">The list of endorsers is unavailable right now.</p>';
    }
  }

  $('list').addEventListener('click', (e) => {
    const who = e.target.closest('button[data-who]');
    if (who) return showWho(who.dataset.who);
    const more = e.target.closest('button[data-more]');
    if (more) return showWho(more.closest('.who').id.slice(4), more.dataset.more);
    const b = e.target.closest('button.endorse');
    if (!b) return undefined;
    if (!session) {
      pending = b.dataset.id;
      $('bsky-account').focus();
      say('Sign in with Bluesky to endorse.');
      return undefined;
    }
    return toggle(b.dataset.id, b.getAttribute('aria-pressed') !== 'true');
  });

  $('bsky-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!client) return;
    const account = $('bsky-account').value.trim();
    if (!account) return;
    say('Starting the sign-in…');
    try {
      location.assign(await client.signIn(account, pending));
    } catch (err) {
      fail(err);
    }
  });

  $('bsky-logout').addEventListener('click', async () => {
    await client?.signOut();
    session = null;
    endorsed = new Set();
    renderPanel();
    render();
    say('Signed out of Bluesky.');
  });

  $('bsky-forget').addEventListener('click', async () => {
    if (!client || !confirm('Delete every Siren endorsement record from your Bluesky account?')) return;
    try {
      const out = await client.removeAll();
      endorsed = new Set();
      render();
      say(`Removed ${plural(out.removed, 'endorsement')} from your account. Counts can take a minute or two to update.`);
    } catch (err) {
      if (err?.code === 'reauth') return reauth(null);
      fail(err);
    }
    return undefined;
  });
}

if (typeof document !== 'undefined' && document.body) main();
