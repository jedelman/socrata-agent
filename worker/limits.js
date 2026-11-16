// Pure helpers for the Worker's limits, kept apart so they can be tested
// without the Workers runtime.

// Read a numeric setting. A typo ("2O") must not switch a limit off, so
// anything that isn't a finite number at or above `min` falls back to the default.
export function setting(value, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

// The limits one answer runs under, from the Worker's environment.
// `provider` is providerOf(model): Claude models think, and thinking counts
// toward the token allowance, so they get their own (MAX_TOKENS_CLAUDE).
export function askLimits(env, provider) {
  return {
    maxSteps: setting(env.MAX_STEPS, 6, { min: 1, max: 12 }),
    // Outbound requests per answer, model calls and retries included.
    // Siren's account moved to Workers Paid on 2026-11-09 (Jason): 10,000
    // external subrequests per invocation, so the platform cap is far off. The
    // budget stays as a guard against a runaway answer: 120 is about four times
    // what a heavy four-tool answer measured (59), and keeps cost bounded.
    subrequestBudget: setting(env.SUBREQUEST_BUDGET, 120, { min: 10, max: 10000 }),
    maxTokens: provider === 'anthropic'
      ? setting(env.MAX_TOKENS_CLAUDE, 8000, { min: 1000, max: 16000 })
      : setting(env.MAX_TOKENS, 1200, { min: 100, max: 4000 }),
  };
}

// Who a visitor is, for per-visitor limits. One IPv6 client usually controls a
// whole /64, so count the /64, not the address; IPv4 counts per address.
export function visitorId(ip) {
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Spend is written as one KV key per paid model call (spend:<day>:<id>, cost
// in the key's metadata), as each call is priced, and summed by listing.
// Unlike a single read-modify-write counter, concurrent calls can't overwrite
// each other's spend; a listing may lag a few seconds behind the newest writes.
// The metadata also says which tier asked (t) and marks an answer's first
// priced call (a: 1), for the steward's spend page (spend.js), which writes
// each finished day's total to its own key; the call keys are kept 8 days so
// a missed rollup can still be made.
export async function spentToday(kv, day) {
  let micros = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix: `spend:${day}:`, cursor });
    for (const k of page.keys) micros += Number(k.metadata?.micros || 0);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return micros / 1e6;
}

export function recordSpend(kv, day, usd, { tier, first = false } = {}) {
  const micros = Math.round(usd * 1e6);
  if (!micros) return Promise.resolve();
  const metadata = { micros, ...(tier ? { t: tier } : {}), ...(first ? { a: 1 } : {}) };
  return kv.put(`spend:${day}:${crypto.randomUUID()}`, '', { metadata, expirationTtl: 8 * 86400 });
}

/**
 * The onCost an answer passes to ask(): each priced call recorded as it's
 * made (pushed to `spends` so the caller can wait for them), the first one
 * marked as the answer's.
 */
export function spendRecorder(kv, day, tier, spends, onError = (err) => console.error('recording spend failed', err)) {
  let first = true;
  return (usd) => {
    if (!kv || !usd || !Math.round(usd * 1e6)) return;
    spends.push(recordSpend(kv, day, usd, { tier, first }).catch(onError));
    first = false;
  };
}
