// The steward's spend page (worker/spend.js, GET /api/admin/spend and the
// page's script): Jason, 2026-11-16, "a Spend dashboard so we can see what
// Siren's running costs are". Each priced call is a spend:<day> key with its
// tier and whether it opened an answer; each finished day is totaled once
// into spend-day:<day>, kept for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSpend, spendRecorder, spentToday } from '../worker/limits.js';
import { tally, rollupSpend, spendHistory, spendSummary, spendReport, SPEND_KEEP_DAYS } from '../worker/spend.js';
import { handleAdmin } from '../worker/admin.js';
import { signUser, userId, userCookieName } from '../worker/accounts.js';
import { money, niceScale, columnPath } from '../worker/admin-spend.js';
import { fakeKV, readyEnv, SECRET } from './fake-atproto.js';

const T = (iso) => Date.parse(iso);
const NOW = T('2026-11-16T15:00:00Z');

test('a call\'s record carries its tier and marks the answer\'s first priced call; kept 8 days', async () => {
  const kv = fakeKV();
  const spends = [];
  const onCost = spendRecorder(kv, '2026-11-16', 'member', spends);
  onCost(0); // a free call marks nothing
  onCost(0.0123);
  onCost(0.002);
  await Promise.all(spends);
  const puts = kv.ops.filter((o) => o.op === 'put');
  assert.deepEqual(puts.map((o) => o.opts.metadata), [{ micros: 12300, t: 'member', a: 1 }, { micros: 2000, t: 'member' }]);
  assert.ok(puts.every((o) => o.opts.expirationTtl === SPEND_KEEP_DAYS * 86400));
  assert.equal(await spentToday(kv, '2026-11-16'), 0.0143, 'the daily cap still sums them');
  // A record with no tier (as the CLI or an old caller writes) still counts.
  await recordSpend(kv, '2026-11-16', 0.5);
  assert.equal(await spentToday(kv, '2026-11-16'), 0.5143);
});

test('a day\'s tally: cost, calls, answers, by tier, and the part recorded before tiers', () => {
  const t = tally([
    { metadata: { micros: 1000, t: 'member', a: 1 } },
    { metadata: { micros: 500, t: 'member' } },
    { metadata: { micros: 2000, t: 'public', a: 1 } },
    { metadata: { micros: 700 } },
    { metadata: { micros: 0, t: 'member', a: 1 } },
    { metadata: { micros: 50, t: 'nonsense', a: 1 } },
  ]);
  assert.deepEqual(t, { micros: 4250, calls: 5, answers: 3, tiers: { member: 1500, public: 2000 }, unlabeled: 750 });
});

async function seeded() {
  const kv = fakeKV();
  // Before this change: records lived 48 hours, so only yesterday and today remain.
  await kv.put('spend:2026-11-15:a', '', { metadata: { micros: 400000 } });
  await kv.put('spend:2026-11-15:b', '', { metadata: { micros: 100000 } });
  await kv.put('spend:2026-11-16:c', '', { metadata: { micros: 30000, t: 'member', a: 1 } });
  await kv.put('spend:2026-11-16:d', '', { metadata: { micros: 20000, t: 'invite', a: 1 } });
  return kv;
}

test('the first rollup starts the record at yesterday and totals it; never today; twice is the same', async () => {
  const kv = await seeded();
  // Before 01:00 UTC the finished day isn't totaled yet (a listing may lag).
  assert.deepEqual(await rollupSpend(kv, { now: T('2026-11-16T00:30:00Z') }), []);
  assert.equal(await kv.get('spend-since'), '2026-11-15');
  assert.deepEqual(await rollupSpend(kv, { now: NOW }), ['2026-11-15']);
  assert.deepEqual(JSON.parse(await kv.get('spend-day:2026-11-15')), { day: '2026-11-15', micros: 500000, calls: 2, answers: 0, tiers: {}, unlabeled: 500000, rolled: '2026-11-16T15:00:00.000Z' });
  assert.deepEqual(await rollupSpend(kv, { now: NOW }), [], 'already written');
  assert.equal(kv.store.has('spend-day:2026-11-16'), false, 'today is still running');
  // Three days later: the 16th and an empty 17th and 18th are written (no keys: no spend).
  assert.deepEqual(await rollupSpend(kv, { now: T('2026-11-19T02:00:00Z') }), ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.equal(JSON.parse(await kv.get('spend-day:2026-11-17')).micros, 0);
  const history = await spendHistory(kv);
  assert.deepEqual(history.map((d) => [d.day, d.micros, d.answers]), [['2026-11-15', 500000, 0], ['2026-11-16', 50000, 2], ['2026-11-17', 0, 0], ['2026-11-18', 0, 0]]);
  assert.deepEqual(history[1].tiers, { member: 30000, invite: 20000 });
});

test('the rollup never reaches past the kept records, nor before the start of the record', async () => {
  const kv = fakeKV();
  await kv.put('spend-since', '2026-11-01');
  // Two weeks on, only the last seven finished days still have their records.
  const written = await rollupSpend(kv, { now: T('2026-11-15T12:00:00Z') });
  assert.deepEqual(written, ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
  const kv2 = fakeKV();
  await kv2.put('spend-since', '2026-11-13');
  assert.deepEqual(await rollupSpend(kv2, { now: T('2026-11-15T12:00:00Z') }), ['2026-11-13', '2026-11-14']);
});

test('the summary: windows, cost per answer only where answers were counted, and each day\'s state', () => {
  const day = (d, micros, answers, extra = {}) => ({ day: d, micros, calls: answers, answers, tiers: { member: micros }, unlabeled: 0, ...extra });
  const history = [
    { ...day('2026-11-14', 900000, 0), tiers: {}, unlabeled: 900000 },
    day('2026-11-15', 1000000, 40),
  ];
  const live = { '2026-11-16': day('2026-11-16', 250000, 10) };
  const s = spendSummary({ history, live, since: '2026-11-14', now: NOW, budgetUsd: 2, days: 5 });
  assert.equal(s.today.usd, 0.25);
  assert.equal(s.today.budget_used, 0.125);
  assert.equal(s.last_7_days.usd, 2.15);
  assert.equal(s.last_7_days.answers, 50);
  assert.equal(s.last_7_days.per_answer_usd, 0.025, '1.25 over 50 answers, leaving out the day recorded before answers were');
  assert.equal(s.last_7_days.unlabeled_usd, 0.9);
  assert.deepEqual(s.last_7_days.tiers, { member: 1.25 });
  assert.equal(s.month_to_date.month, '2026-11');
  assert.equal(s.since_recorded.since, '2026-11-14');
  assert.deepEqual(s.days.map((d) => [d.day, d.status, d.usd]), [
    ['2026-11-12', 'not_recorded', null],
    ['2026-11-13', 'not_recorded', null],
    ['2026-11-14', 'final', 0.9],
    ['2026-11-15', 'final', 1],
    ['2026-11-16', 'today', 0.25],
  ]);
  // No cap, no share of it.
  assert.equal(spendSummary({ history: [], live: {}, since: null, now: NOW, budgetUsd: 0 }).today.budget_used, null);
});

test('the report end to end: rolls up, then sums today and any day not totaled yet', async () => {
  const kv = await seeded();
  const r = await spendReport(kv, { now: NOW, budgetUsd: 2, days: 3 });
  assert.equal(r.today.usd, 0.05);
  assert.equal(r.today.answers, 2);
  assert.deepEqual(r.today.tiers, { member: 0.03, invite: 0.02 });
  assert.deepEqual(r.days.map((d) => [d.day, d.status, d.usd]), [['2026-11-14', 'not_recorded', null], ['2026-11-15', 'final', 0.5], ['2026-11-16', 'today', 0.05]]);
  // Shortly after midnight, yesterday isn't totaled yet and is summed live.
  const kv2 = await seeded();
  const early = await spendReport(kv2, { now: T('2026-11-17T00:20:00Z'), budgetUsd: 2, days: 2 });
  assert.deepEqual(early.days.map((d) => [d.day, d.status, d.usd]), [['2026-11-16', 'live', 0.05], ['2026-11-17', 'today', 0]]);
});

test('GET /api/admin/spend: stewards only, with the model and its rates', async () => {
  const env = readyEnv({ ADMIN_EMAILS: 'steward@example.org', DAILY_BUDGET_USD: '3' });
  await env.LIMITS.put('spend:2026-11-16:x', '', { metadata: { micros: 120000, t: 'member', a: 1 } });
  const get = async (uid) => {
    const req = new Request('https://ask-siren.jason-edelman.org/api/admin/spend', { headers: uid ? { Cookie: `${userCookieName('')}=${await signUser(SECRET, uid)}` } : {} });
    const res = await handleAdmin(req, env, '/api/admin/spend', {}, { model: 'claude-haiku-5-5', now: NOW });
    return { status: res.status, body: await res.json(), cache: res.headers.get('Cache-Control') };
  };
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(await userId(SECRET, 'someone@example.org'))).status, 403);
  const ok = await get(await userId(SECRET, 'steward@example.org'));
  assert.equal(ok.status, 200);
  assert.equal(ok.cache, 'no-store');
  assert.equal(ok.body.today.usd, 0.12);
  assert.equal(ok.body.today.budget_usd, 3);
  assert.equal(ok.body.model, 'claude-haiku-5-5');
  assert.deepEqual(ok.body.price_per_million_tokens, { input: 0.1, output: 0.5 });
});

test('the page\'s helpers: money, a round axis, a column with a rounded top and a square foot', () => {
  assert.equal(money(0.0345), '$0.035');
  assert.equal(money(1.5), '$1.50');
  assert.equal(money(0), '$0.00');
  assert.equal(money(null), '—');
  assert.deepEqual(niceScale(1.7), { top: 2, step: 0.5 });
  assert.deepEqual(niceScale(0), { top: 0.01, step: 0.0025 });
  assert.equal(columnPath(10, 90, 20, 90), '', 'no column for zero');
  assert.equal(columnPath(10, 50, 20, 90), 'M10,90V54Q10,50 14,50H26Q30,50 30,54V90Z');
  assert.equal(columnPath(10, 88, 20, 90), 'M10,90V90Q10,88 12,88H28Q30,88 30,90V90Z', 'a short column rounds by its height');
});

test('a day whose total was never written, after its records expired, is lost, not $0', async () => {
  const kv = fakeKV();
  await kv.put('spend-since', '2026-11-15');
  await kv.put('spend-day:2026-11-15', '{}', { metadata: { u: 500000, c: 2, a: 0, t: {}, x: 500000 } });
  // Nothing ran from the 16th until the 26th: the 16th to the 18th's records are gone.
  const r = await spendReport(kv, { now: T('2026-11-26T12:00:00Z'), budgetUsd: 2, days: 13 });
  const status = Object.fromEntries(r.days.map((d) => [d.day, d.status]));
  assert.equal(status['2026-11-14'], 'not_recorded');
  assert.equal(status['2026-11-15'], 'final');
  for (const d of ['2026-11-16', '2026-11-17', '2026-11-18']) assert.equal(status[d], 'lost', d);
  assert.equal(status['2026-11-19'], 'final', 'inside the kept records: rolled up (as zero)');
  assert.equal(r.days.find((d) => d.day === '2026-11-16').usd, null);
  assert.equal(r.lost_days, 3);
});
