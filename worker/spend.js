// Siren's running costs, as Siren records them, for the steward's spend page
// (/admin/spend; Jason, 2026-11-16: "a Spend dashboard so we can see what
// Siren's running costs are").
//
// Every paid model call is priced as it's made (src/providers/anthropic.js
// PRICES, the API's own usage numbers) and written as one KV key,
// spend:<day>:<uuid>, its cost in the key's metadata (limits.js recordSpend):
// micros, the tier that asked (t) and whether it was the first priced call of
// an answer (a). Those keys are what the daily budget sums; they're kept 8
// days. Once a day is over (an hour after midnight UTC, so a listing has
// caught up with the day's last writes), its total is written once as
// spend-day:<day>, kept for good, the summary in its metadata so the whole
// history is one listing. The Cron Trigger rolls days up (index.js
// scheduled) and so does opening the page, so a day is lost only if neither
// happens for a week.
//
// spend-since holds the first day recorded in full. The first rollup sets it
// to yesterday: before this change spend keys lived 48 hours, so yesterday's
// were all still there and the day before's weren't. A day after it with no
// spend keys is a day with no spend.
//
// These are Siren's own prices applied to each call, not the API's invoice:
// the Claude Console shows what was billed. Hosting (Cloudflare), email
// (Resend) and the domain bill elsewhere and aren't here.

export const SPEND_KEEP_DAYS = 8;
export const TIERS = ['member', 'invite', 'public', 'visitor', 'person'];
const DAY_MS = 86400e3;
// A day is rolled up once this long after it ends.
const SETTLE_MS = 3600e3;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOf = (day) => Date.parse(`${day}T00:00:00Z`);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function listAll(kv, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

/**
 * One day's spend from its keys' metadata: micros, priced calls, answers
 * (calls marked as an answer's first), micros by tier, and micros from keys
 * written before tiers were recorded (unlabeled), whose answers weren't marked.
 */
export function tally(keys) {
  const out = { micros: 0, calls: 0, answers: 0, tiers: {}, unlabeled: 0 };
  for (const k of keys) {
    const m = k.metadata || {};
    const micros = Math.max(0, Math.round(Number(m.micros) || 0));
    if (!micros) continue;
    out.micros += micros;
    out.calls += 1;
    if (m.a === 1) out.answers += 1;
    if (TIERS.includes(m.t)) out.tiers[m.t] = (out.tiers[m.t] || 0) + micros;
    else out.unlabeled += micros;
  }
  return out;
}

export async function dayTally(kv, day) {
  return tally(await listAll(kv, `spend:${day}:`));
}

/** The compact form stored in a spend-day key's metadata (under KV's 1 KB). */
const compact = (t) => ({ u: t.micros, c: t.calls, a: t.answers, t: t.tiers, x: t.unlabeled });
const expand = (m) => ({
  micros: Number(m?.u) || 0,
  calls: Number(m?.c) || 0,
  answers: Number(m?.a) || 0,
  tiers: Object.fromEntries(Object.entries(m?.t || {}).filter(([k, v]) => TIERS.includes(k) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])),
  unlabeled: Number(m?.x) || 0,
});

/**
 * Write the total of every finished day since spend-since (at most the last
 * SPEND_KEEP_DAYS - 1, whose keys still exist) that has none yet. Returns the
 * days written. Safe to run twice at once: both write the same total.
 */
export async function rollupSpend(kv, { now = Date.now() } = {}) {
  const today = dayOf(now);
  let since = await kv.get('spend-since');
  if (!DAY_RE.test(String(since || ''))) {
    since = dayOf(startOf(today) - DAY_MS);
    await kv.put('spend-since', since);
  }
  const written = [];
  for (let back = SPEND_KEEP_DAYS - 1; back >= 1; back--) {
    const day = dayOf(startOf(today) - back * DAY_MS);
    if (day < since) continue;
    if (now < startOf(day) + DAY_MS + SETTLE_MS) continue;
    if (await kv.get(`spend-day:${day}`)) continue;
    const t = await dayTally(kv, day);
    await kv.put(`spend-day:${day}`, JSON.stringify({ day, ...t, rolled: new Date(now).toISOString() }), { metadata: compact(t) });
    written.push(day);
  }
  return written;
}

/** Every rolled-up day, oldest first: [{ day, micros, calls, answers, tiers, unlabeled }]. */
export async function spendHistory(kv) {
  const keys = await listAll(kv, 'spend-day:');
  return keys
    .map((k) => ({ day: k.name.slice('spend-day:'.length), ...expand(k.metadata) }))
    .filter((d) => DAY_RE.test(d.day))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

const usd = (micros) => Math.round(micros) / 1e6;
const sum = (days, f) => days.reduce((n, d) => n + f(d), 0);
function totals(days) {
  const micros = sum(days, (d) => d.micros);
  const tiers = {};
  for (const d of days) for (const [k, v] of Object.entries(d.tiers)) tiers[k] = (tiers[k] || 0) + v;
  // Cost per answer only over days whose every call was marked.
  const marked = days.filter((d) => !d.unlabeled);
  const markedAnswers = sum(marked, (d) => d.answers);
  return {
    usd: usd(micros),
    calls: sum(days, (d) => d.calls),
    answers: sum(days, (d) => d.answers),
    per_answer_usd: markedAnswers ? usd(sum(marked, (d) => d.micros) / markedAnswers) : null,
    tiers: Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, usd(v)])),
    unlabeled_usd: usd(sum(days, (d) => d.unlabeled)),
  };
}

/**
 * The page's numbers. `history` is spendHistory's; `live` holds the tallies
 * of days not rolled up yet (today, and yesterday until an hour past
 * midnight), by day. Windows are UTC days, as the daily budget is.
 */
export function spendSummary({ history, live, since, now = Date.now(), budgetUsd, days = 30 }) {
  const today = dayOf(now);
  const byDay = new Map(history.map((d) => [d.day, { ...d, status: 'final' }]));
  for (const [day, t] of Object.entries(live)) if (!byDay.has(day)) byDay.set(day, { day, ...t, status: day === today ? 'today' : 'live' });
  const window = (n) => {
    const from = dayOf(startOf(today) - (n - 1) * DAY_MS);
    return [...byDay.values()].filter((d) => d.day >= from && d.day <= today);
  };
  const month = [...byDay.values()].filter((d) => d.day.slice(0, 7) === today.slice(0, 7) && d.day <= today);
  const series = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = dayOf(startOf(today) - back * DAY_MS);
    const d = byDay.get(day);
    // A day after spend-since always has a total (a day with no spend is
    // written as zero) unless its records expired before one was written
    // (neither the cron nor the page ran for a week): lost, never $0.
    const recorded = since && day >= since;
    series.push(d
      ? { day, usd: usd(d.micros), answers: d.answers, calls: d.calls, tiers: Object.fromEntries(Object.entries(d.tiers).map(([k, v]) => [k, usd(v)])), unlabeled_usd: usd(d.unlabeled), status: d.status }
      : { day, usd: null, answers: null, calls: null, tiers: {}, unlabeled_usd: 0, status: recorded ? 'lost' : 'not_recorded' });
  }
  const todayRow = byDay.get(today) || { micros: 0, calls: 0, answers: 0, tiers: {}, unlabeled: 0 };
  const lost = series.filter((d) => d.status === 'lost').length;
  return {
    lost_days: lost,
    today: { day: today, ...totals([todayRow]), budget_usd: budgetUsd, budget_used: budgetUsd > 0 ? Math.min(1, usd(todayRow.micros) / budgetUsd) : null },
    last_7_days: totals(window(7)),
    last_30_days: totals(window(30)),
    month_to_date: { month: today.slice(0, 7), ...totals(month) },
    since_recorded: { since: since || null, ...totals([...byDay.values()]) },
    days: series,
  };
}

/** Everything the spend page shows: rolls up finished days first. */
export async function spendReport(kv, { now = Date.now(), budgetUsd, days = 30 } = {}) {
  await rollupSpend(kv, { now });
  const [history, since] = await Promise.all([spendHistory(kv), kv.get('spend-since')]);
  const rolled = new Set(history.map((d) => d.day));
  const today = dayOf(now);
  const live = {};
  // Today, and any recent day whose total isn't written yet.
  for (let back = SPEND_KEEP_DAYS - 1; back >= 0; back--) {
    const day = dayOf(startOf(today) - back * DAY_MS);
    if (rolled.has(day) || (since && day < since && day !== today)) continue;
    live[day] = await dayTally(kv, day);
  }
  return spendSummary({ history, live, since, now, budgetUsd, days });
}
