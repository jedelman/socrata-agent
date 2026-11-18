// The member's watches page (worker/watches.js). Served under a strict CSP:
// no inline script or style; every string from the server is escaped.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let data = null;
  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let out = {};
    try { out = await res.json(); } catch {}
    return { res, out };
  }
  function render() {
    const list = $('#list');
    list.innerHTML = data.watches.map((w) => `<li data-id="${esc(w.id)}"><strong>${esc(w.label)}</strong><p class="meta">Started ${esc(String(w.created).slice(0, 10))} · runs until ${esc(String(w.ends).slice(0, 10))} · ${w.sent ? `${esc(w.sent)} email${w.sent === 1 ? '' : 's'}, the last on ${esc(String(w.last_sent).slice(0, 10))}` : 'no email yet'}</p><p class="actions"><button type="button" class="quiet" data-act="renew">Keep watching for a year</button><button type="button" class="quiet" data-act="delete">Stop</button></p></li>`).join('');
    $('#empty').hidden = data.watches.length > 0;
    $('#new').hidden = data.watches.length >= data.max;
    const city = Object.keys(data.options)[0];
    const opt = data.options[city] || { bodies: [], leagues: [] };
    $('#league').innerHTML = '<option value="">Anywhere in the city</option>' + opt.leagues.map((l) => `<option>${esc(l)}</option>`).join('');
    $('#bodies').innerHTML = '<legend>Bodies</legend>' + opt.bodies.map((b) => `<label><input type="checkbox" name="body" value="${esc(b)}" checked> ${esc(b)}</label>`).join('');
    $('#topics').innerHTML = '<legend>Topics</legend>' + (opt.topics || []).map((t) => `<label><input type="checkbox" name="topic" value="${esc(t.id)}"> ${esc(t.label)}</label>`).join('');
    $('#f').dataset.city = city || '';
  }
  async function load() {
    const res = await fetch('api/watches', { cache: 'no-store' });
    let out = {};
    try { out = await res.json(); } catch {}
    if (res.status === 401) { $('#msg').innerHTML = 'Sign in on <a href="./">the main page</a> to see your watches.'; return; }
    if (!res.ok) { $('#msg').textContent = out.error || 'Your watches could not be read just now.'; return; }
    data = out;
    render();
  }
  $('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = b.closest('li').dataset.id;
    b.disabled = true;
    const { res, out } = await post(b.dataset.act === 'delete' ? 'api/watches/delete' : 'api/watches/renew', { id });
    $('#msg').className = res.ok ? 'msg ok' : 'msg';
    $('#msg').textContent = res.ok ? (b.dataset.act === 'delete' ? 'Stopped.' : 'Renewed for a year.') : out.error || 'Something went wrong.';
    await load();
  });
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const bodies = [...f.querySelectorAll('input[name="body"]:checked')].map((i) => i.value);
    $('#fmsg').textContent = 'Starting…';
    const topics = [...f.querySelectorAll('input[name="topic"]:checked')].map((i) => i.value);
    const { res, out } = await post('api/watches', { city: f.dataset.city, topics, phrases: $('#phrases').value.split(/[,;]/), league: $('#league').value, bodies, email: $('#email').value });
    if (!res.ok) {
      const refused = (out.refused_phrases || []).map((r) => `"${r.phrase}": ${r.reason}`).join('; ');
      $('#fmsg').textContent = `${out.error || 'Something went wrong.'}${refused ? ` (${refused})` : ''}`;
      return;
    }
    $('#fmsg').textContent = '';
    f.reset();
    $('#msg').className = 'msg ok';
    const notes = [...(out.notes || []).map((n) => `"${n.phrase}" is ${n.note}.`), ...(out.refused_phrases || []).map((r) => `Left out "${r.phrase}": ${r.reason}.`)].join(' ');
    $('#msg').textContent = `Watching ${out.watch.label}.${out.already?.length ? ` ${out.already.length} item${out.already.length === 1 ? ' is' : 's are'} already on a posted agenda; your first email will list ${out.already.length === 1 ? 'it' : 'them'}.` : ''}${notes ? ` ${notes}` : ''}`;
    await load();
  });
  load();
})();
