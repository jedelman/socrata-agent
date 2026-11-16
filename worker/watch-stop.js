// The stop page a watch's email links to (worker/watches.js). The token is
// in the page's own address; it's posted from script, so a mail scanner that
// only fetches the link stops nothing.
(() => {
  const t = new URLSearchParams(location.search).get('t') || '';
  const msg = document.querySelector('#msg');
  const button = document.querySelector('#stop');
  button.addEventListener('click', async () => {
    button.disabled = true;
    msg.textContent = 'Stopping…';
    try {
      const res = await fetch('../api/watches/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t }) });
      let out = {};
      try { out = await res.json(); } catch {}
      msg.className = res.ok ? 'msg ok' : 'msg';
      msg.textContent = res.ok ? 'Stopped. You will get no more emails from this watch.' : out.error || 'Something went wrong.';
      if (!res.ok) button.disabled = false;
    } catch {
      msg.textContent = "Couldn't reach the server. Try again.";
      button.disabled = false;
    }
  });
})();
