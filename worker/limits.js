// Pure helpers for the Worker's limits, kept apart so they can be tested
// without the Workers runtime.

// Read a numeric setting. A typo ("2O") must not switch a limit off, so
// anything that isn't a finite number at or above `min` falls back to the default.
export function setting(value, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
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

// Spend is written as one KV key per request (spend:<day>:<id>, cost in the
// key's metadata) and summed by listing. Unlike a single read-modify-write
// counter, concurrent requests can't overwrite each other's spend; a listing
// may lag a few seconds behind the newest writes.
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

export function recordSpend(kv, day, usd) {
  const micros = Math.round(usd * 1e6);
  if (!micros) return Promise.resolve();
  return kv.put(`spend:${day}:${crypto.randomUUID()}`, '', { metadata: { micros }, expirationTtl: 172800 });
}
