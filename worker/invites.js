// Invite-only mode and the waitlist, for a pre-alpha. Pure helpers that take
// a KV namespace and secrets as arguments, so they test without the Workers
// runtime.
//
// When INVITE_REQUIRED=true, asking needs an invite. A visitor redeems a code
// once; the Worker sets a signed cookie, and every question checks that the
// cookie is valid and the invite still exists, so deleting an invite revokes
// it. Codes are stored by hash (invite:<sha256>), so reading the KV namespace
// doesn't reveal usable codes. Without an invite, visitors can join the
// waitlist.

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no I, L, O, U, 0, 1
const CODE_CHARS = 10; // about 49 bits
export const COOKIE = 'siren_invite';
const COOKIE_DAYS = 30;

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A new code, shown to people as SIREN-XXXXX-XXXXX. */
export function newCode(prefix = 'SIREN') {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_CHARS));
  // 256 isn't a multiple of 30, so drop bytes >= 240 (8 * 30) and take the
  // rest mod 30; every character is then equally likely.
  let out = '';
  let i = 0;
  while (out.length < CODE_CHARS) {
    const b = i < bytes.length ? bytes[i++] : crypto.getRandomValues(new Uint8Array(1))[0];
    if (b < 240) out += ALPHABET[b % ALPHABET.length];
  }
  return `${prefix}-${out.slice(0, 5)}-${out.slice(5)}`;
}

/**
 * What people type, made comparable: case, spaces, dashes and the prefix
 * don't matter. The alphabet has no I, so a code can never itself contain
 * "SIREN" and stripping the prefix is safe.
 */
export function normalizeCode(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/^SIREN/, '');
  return s.length === CODE_CHARS && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

export async function inviteKey(code) {
  const n = normalizeCode(code);
  return n ? `invite:${await sha256hex(n)}` : null;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Cookie value: base64url(JSON {k: invite key hash, e: expiry seconds}).base64url(HMAC). */
export async function signSession(secret, inviteHash, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ k: inviteHash, e: Math.floor(now / 1000) + COOKIE_DAYS * 86400 })));
  return `${payload}.${b64url(await hmac(secret, payload))}`;
}

/** Returns the invite hash for a valid, unexpired cookie value, else null. */
export async function verifySession(secret, value, now = Date.now()) {
  if (!secret || typeof value !== 'string') return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  let given;
  try {
    given = unb64url(sig);
  } catch {
    return null;
  }
  if (!timingSafeEqual(given, await hmac(secret, payload))) return null;
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    return null;
  }
  if (typeof body.k !== 'string' || !/^[0-9a-f]{64}$/.test(body.k)) return null;
  if (typeof body.e !== 'number' || body.e < Math.floor(now / 1000)) return null;
  return body.k;
}

export function readCookie(req, name = COOKIE) {
  const header = req.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function sessionCookie(value, path = '/') {
  return `${COOKIE}=${value}; Path=${path || '/'}; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The invite behind this request, if it is valid and not revoked:
 * { hash, label } or null. Checks the KV record on every call, so deleting
 * invite:<hash> revokes the invite at once.
 */
export async function currentInvite(req, env, kv) {
  const hash = await verifySession(env.INVITE_SECRET, readCookie(req));
  if (!hash) return null;
  const record = await kv.get(`invite:${hash}`, 'json');
  if (!record || record.revoked) return null;
  return { hash, label: record.label || '' };
}

// Redemptions are one KV key each (redeemed:<hash>:<uuid>) and counted by
// listing, like spend: concurrent redemptions can't overwrite each other's
// count. KV is eventually consistent, so redemptions made in parallel can all
// pass the check and exceed max_uses. Treat max_uses as a guide; deleting the
// invite (revoke) is the hard control. Each browser or device counts as one use.
async function redemptions(kv, hash) {
  let n = 0;
  let cursor;
  do {
    const page = await kv.list({ prefix: `redeemed:${hash}:`, cursor });
    n += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return n;
}

/**
 * Redeem a code. Returns { ok: true, cookie } or { ok: false, status, error }.
 * Only failed attempts are counted against a visitor, so a room of people on
 * one network can all redeem; with ~49-bit codes, `maxFailures` an hour still
 * makes guessing hopeless. Re-entering a code in a browser already signed in
 * with it costs no use: it just renews the cookie.
 */
export async function redeem({ code, env, kv, visitor, current = null, maxFailures = 30, now = Date.now() }) {
  if (!env.INVITE_SECRET) return { ok: false, status: 503, error: 'Invites are not set up on this site yet.' };
  const hour = new Date(now).toISOString().slice(0, 13);
  const failuresKey = `redeem-failures:${hour}:${visitor}`;
  const failures = Number((await kv.get(failuresKey)) || 0);
  if (failures >= maxFailures) return { ok: false, status: 429, error: 'Too many wrong codes from here. Wait an hour and try again.' };
  const fail = async (status, error) => {
    await kv.put(failuresKey, String(failures + 1), { expirationTtl: 7200 });
    return { ok: false, status, error };
  };

  const key = await inviteKey(code);
  const record = key ? await kv.get(key, 'json') : null;
  if (!record || record.revoked) return fail(403, "That code didn't work. Check it, or join the waitlist.");
  const hash = key.slice('invite:'.length);
  if (current === hash) return { ok: true, hash, cookie: await signSession(env.INVITE_SECRET, hash, now) };
  const max = Number(record.max_uses);
  if (Number.isFinite(max) && max > 0 && (await redemptions(kv, hash)) >= max) {
    return fail(403, 'That code has been used up. Ask whoever gave it to you for another, or join the waitlist.');
  }
  await kv.put(`redeemed:${hash}:${crypto.randomUUID()}`, new Date(now).toISOString());
  return { ok: true, hash, cookie: await signSession(env.INVITE_SECRET, hash, now) };
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()"',;:]+\.[A-Za-z0-9-]{2,}$/;
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/** A plausible email, trimmed and lowercased, or null. */
export function normalizeEmail(input) {
  const email = clip(input, 254).toLowerCase();
  return EMAIL.test(email) ? email : null;
}

/** Validate a waitlist entry. Returns { entry } or { error }. */
export function waitlistEntry(body) {
  if (!body || typeof body !== 'object') return { error: 'Send your email to join the waitlist.' };
  if (body.website) return { spam: true }; // honeypot: people never fill this field in
  const email = clip(body.email, 254).toLowerCase();
  if (!EMAIL.test(email)) return { error: 'That email address doesn\'t look right.' };
  return {
    entry: {
      email,
      name: clip(body.name, 120),
      org: clip(body.org, 160),
      note: clip(body.note, 600),
    },
  };
}

/**
 * Store a waitlist entry, one key per email. An email already on the list is
 * left as it is, so nobody can overwrite someone else's entry, and signing up
 * twice doesn't count against the visitor's daily limit.
 */
export async function joinWaitlist({ body, kv, visitor, source, perDay = 50, now = Date.now() }) {
  const { entry, error, spam } = waitlistEntry(body);
  if (spam) return { ok: true }; // look successful, store nothing
  if (error) return { ok: false, status: 400, error };
  const key = `waitlist:${await sha256hex(entry.email)}`;
  if (await kv.get(key)) return { ok: true };
  const day = new Date(now).toISOString().slice(0, 10);
  const rateKey = `waitlist-rate:${day}:${visitor}`;
  const count = Number((await kv.get(rateKey)) || 0);
  if (count >= perDay) return { ok: false, status: 429, error: 'Too many signups from here today. Try again tomorrow.' };
  await kv.put(rateKey, String(count + 1), { expirationTtl: 90000 });
  await kv.put(key, JSON.stringify({ ...entry, source, at: new Date(now).toISOString() }));
  return { ok: true };
}

/**
 * One CSV field. A value starting with = + - or @ would run as a formula when
 * the export is opened in a spreadsheet, and anyone can type one into the
 * waitlist form; a leading apostrophe keeps it text.
 */
export function csvField(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
