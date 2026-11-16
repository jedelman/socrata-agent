// The steward's spend page (admin-spend.html at /admin/spend), under the
// strict Content-Security-Policy: no inline script, style or handler. The
// numbers come from GET /api/admin/spend (worker/spend.js). The chart is one
// series (dollars a day), so it has no legend: its title names it. Columns
// are drawn as SVG with DOM calls, sizes set through attributes and the
// CSSOM (which the policy allows), never a style attribute. Each column has
// a hit area the full height of its slot, a tooltip on hover and focus, and
// the same numbers are in the table under it.

const SVG = 'http://www.w3.org/2000/svg';
const TIER_LABELS = {
  member: 'Signed-in members (private conversations)',
  invite: 'Invite code, not signed in',
  public: 'Public questions (Bluesky free tier)',
  visitor: 'Open site, per visitor',
  person: 'Behind Cloudflare Access',
};

/** Dollars: three decimals under ten cents, else two. */
export function money(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: Math.abs(v) < 0.1 && v !== 0 ? 3 : 2, maximumFractionDigits: Math.abs(v) < 0.1 && v !== 0 ? 3 : 2 })}`;
}
const count = (n, one, many) => `${Number(n || 0).toLocaleString('en-US')} ${Number(n) === 1 ? one : many}`;
const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A round axis top and step for a maximum: steps of 1, 2, 2.5 or 5 times a power of ten, about four ticks. */
export function niceScale(max) {
  const m = Math.max(Number(max) || 0, 0.01);
  const raw = m / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((s) => s >= raw);
  return { top: Math.ceil(m / step) * step, step };
}

/** A column with a 4px rounded top and a square foot on the baseline. */
export function columnPath(x, y, w, base) {
  const h = base - y;
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function el(name, attrs = {}, text) {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}
function h(tag, text, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function tile(label, value, sub, extra) {
  const t = h('div', undefined, 'tile');
  t.append(h('p', label, 'label'), h('p', value, 'value'));
  if (sub) t.append(h('p', sub, 'sub'));
  if (extra) t.append(extra);
  return t;
}

function dayWords(d) {
  if (d.status === 'not_recorded') return 'Not recorded (before spend was kept by day)';
  const parts = [`${money(d.usd)}${d.status === 'today' ? ' so far' : ''}`, count(d.answers, 'answer', 'answers')];
  if (d.unlabeled_usd) parts.push('answers not counted (recorded before tiers were)');
  return parts.join(' · ');
}

function chart(container, days, budget) {
  // Drawn at the box's own width, so the axis text stays 11px on a phone.
  const W = Math.max(300, Math.round(container.clientWidth - 16) || 800);
  const H = W < 560 ? 200 : 230;
  const left = 52;
  const right = 8;
  const top = 12;
  const bottom = 26;
  const base = H - bottom;
  const max = Math.max(0, ...days.map((d) => d.usd || 0));
  const { top: yTop, step } = niceScale(max);
  const y = (v) => base - (v / yTop) * (base - top);
  const band = (W - left - right) / days.length;
  const bw = Math.min(24, band * 0.62);
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Spend each day for the last ${days.length} days, in dollars` });
  for (let v = 0; v <= yTop + step / 2; v += step) {
    svg.append(el('line', { class: 'grid', x1: left, x2: W - right, y1: y(v), y2: y(v) }));
    svg.append(el('text', { class: 'axis', x: left - 6, y: y(v) + 4, 'text-anchor': 'end' }, money(v)));
  }
  if (budget > 0 && budget <= yTop) {
    svg.append(el('line', { class: 'cap', x1: left, x2: W - right, y1: y(budget), y2: y(budget) }));
    svg.append(el('text', { class: 'axis', x: W - right, y: y(budget) - 4, 'text-anchor': 'end' }, `daily cap ${money(budget)}`));
  }
  const tip = h('div', undefined, 'tip');
  tip.hidden = true;
  days.forEach((d, i) => {
    const x0 = left + i * band;
    const x = x0 + (band - bw) / 2;
    const hit = el('rect', { class: 'hit', x: x0, y: top, width: band, height: base - top, tabindex: 0, 'aria-label': `${shortDay(d.day)}: ${dayWords(d)}` });
    svg.append(hit);
    const p = columnPath(x, y(d.usd || 0), bw, base);
    svg.append(el('path', { class: 'bar', d: p || `M${x},${base}Z` }));
    if (d.status === 'not_recorded') svg.append(el('text', { class: 'gap', x: x + bw / 2, y: base - 3, 'text-anchor': 'middle' }, '·'));
    const every = W < 560 ? 10 : 7;
    if (i % every === (days.length - 1) % every) {
      svg.append(el('text', { class: 'axis', x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, i === days.length - 1 ? 'today' : shortDay(d.day)));
    }
    const show = () => {
      tip.replaceChildren(h('strong', d.status === 'not_recorded' ? 'Not recorded' : `${money(d.usd)}${d.status === 'today' ? ' so far' : ''}`), h('span', `${shortDay(d.day)} · ${d.status === 'not_recorded' ? 'before spend was kept by day' : count(d.answers, 'answer', 'answers')}`));
      tip.hidden = false;
      const box = container.getBoundingClientRect();
      const r = hit.getBoundingClientRect();
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(4, Math.min(box.width - tw - 4, r.left - box.left + r.width / 2 - tw / 2))}px`;
      const barTop = r.top - box.top + ((y(d.usd || 0) - top) / (base - top)) * r.height;
      tip.style.top = `${Math.max(4, barTop - tip.offsetHeight - 8)}px`;
    };
    const hide = () => { tip.hidden = true; };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
  });
  container.replaceChildren(svg, tip);
}

function table(node, head, rows) {
  const thead = h('thead');
  const tr = h('tr');
  for (const [text, num] of head) tr.append(h('th', text, num ? 'num' : ''));
  thead.append(tr);
  const tbody = h('tbody');
  for (const row of rows) {
    const r = h('tr');
    row.forEach((cell, i) => r.append(h('td', cell, head[i][1] ? 'num' : '')));
    tbody.append(r);
  }
  node.replaceChildren(thead, tbody);
}

export function render(data, $) {
  const t = data.today;
  const meter = h('div', undefined, 'meter');
  const fill = h('span');
  const used = Number(t.budget_used) || 0;
  fill.style.width = `${Math.round(used * 100)}%`;
  meter.append(fill);
  if (used >= 1) meter.classList.add('over');
  else if (used >= 0.75) meter.classList.add('warn');
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `${Math.round(used * 100)}% of today's cap`);
  const capWords = t.budget_usd > 0 ? `${Math.round(used * 100)}% of the ${money(t.budget_usd)} daily cap${used >= 1 ? ' (new questions wait for midnight UTC)' : ''}` : 'no daily cap set';
  const s = data.since_recorded;
  $('tiles').replaceChildren(
    tile('Today so far', money(t.usd), `${capWords} · ${count(t.answers, 'answer', 'answers')}`, meter),
    tile('Last 7 days', money(data.last_7_days.usd), count(data.last_7_days.answers, 'answer', 'answers')),
    tile('Last 30 days', money(data.last_30_days.usd), count(data.last_30_days.answers, 'answer', 'answers')),
    tile(`This month (${new Date(`${data.month_to_date.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })})`, money(data.month_to_date.usd), count(data.month_to_date.answers, 'answer', 'answers')),
    tile('Per answer, last 30 days', money(data.last_30_days.per_answer_usd), data.last_30_days.per_answer_usd === null ? 'no answers counted yet' : 'model calls only'),
    tile(s.since ? `Since ${shortDay(s.since)}` : 'Since recording began', money(s.usd), count(s.answers, 'answer', 'answers')),
  );
  chart($('chart'), data.days, t.budget_usd);
  let width = $('chart').clientWidth;
  window.addEventListener('resize', () => {
    if ($('chart').clientWidth === width) return;
    width = $('chart').clientWidth;
    chart($('chart'), data.days, t.budget_usd);
  });
  table($('days-table'), [['Day (UTC)'], ['Spend', true], ['Answers', true], ['Model calls', true]],
    [...data.days].reverse().map((d) => [d.day + (d.status === 'today' ? ' (so far)' : ''), d.status === 'not_recorded' ? 'not recorded' : money(d.usd), d.answers ?? '—', d.calls ?? '—']));
  const m = data.last_30_days;
  const tierRows = Object.entries(m.tiers).sort((a, b) => b[1] - a[1]).map(([k, v]) => [TIER_LABELS[k] || k, money(v), m.usd ? `${Math.round((v / m.usd) * 100)}%` : '—']);
  if (m.unlabeled_usd) tierRows.push(['Before tiers were recorded', money(m.unlabeled_usd), m.usd ? `${Math.round((m.unlabeled_usd / m.usd) * 100)}%` : '—']);
  table($('tiers-table'), [['Who asked'], ['Spend', true], ['Share', true]], tierRows.length ? tierRows : [['No spend in the last 30 days', '—', '—']]);
  const price = data.price_per_million_tokens;
  const notes = [
    `Each model call is priced when it's made, from the token counts the API reports and ${data.model ? `the rates on file for ${data.model}${price ? ` (${money(price.input)} in, ${money(price.output)} out, per million tokens)` : ''}` : 'the rates on file'}, plus web searches at $10 per 1,000. These are the same numbers the daily cap counts. The Claude Console shows what was actually billed.`,
    'An answer is counted at its first priced call; follow-up calls in the same answer add to its cost, not to the count.',
    'Not counted here: Cloudflare (the Workers plan and usage), the email provider (Resend) and the domain. They bill separately.',
    s.since ? `Kept by day from ${s.since}. Before this page, call records lasted 48 hours, so earlier days aren't here.` : 'Days are kept from the first time this page or the scheduled job runs.',
    "A finished day's total is written once, an hour after midnight UTC; today, and any day not totaled yet, are summed live.",
  ];
  $('notes').replaceChildren(...notes.map((n) => h('li', n)));
}

async function main() {
  const $ = (s) => document.getElementById(s);
  const base = document.body.dataset.base || '';
  const say = (t, bad = false) => {
    $('status').textContent = t || '';
    $('status').classList.toggle('bad', bad);
  };
  try {
    const res = await fetch(`${base}/api/admin/spend`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) return say("Sign in on the main page with a steward's email first.", true);
    if (!res.ok) return say(data.error || "Couldn't load the spend.", true);
    say('');
    $('report').hidden = false;
    render(data, $);
  } catch {
    say("Couldn't reach the server. Try again.", true);
  }
  return undefined;
}

if (typeof document !== 'undefined') main();
