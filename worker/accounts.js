// Email sign-in by magic link, so a redeemed invite follows a person to any
// device. Pure helpers that take KV and secrets as arguments, like invites.js.
//
// The flow:
//   1. POST /api/login {email}: rate-limited per address and per visitor. A
//      random one-time token is stored by hash (login:<sha256>) for 15
//      minutes, and Resend emails a link to <base>/login#t=<token>.
//   2. The link opens the page; its script POSTs the token to
//      /api/login/verify. The token sits in the URL fragment, so it never
//      reaches a server log or a Referer header, and a mail scanner that
//      prefetches links can't spend it (it would have to run the page and
//      press nothing; the POST happens in script).
//   3. Verify deletes the token and sets a signed siren_user cookie holding
//      the user id: HMAC(INVITE_SECRET, email), so KV keys never reveal an
//      address and a stolen KV dump can't be reversed with a word list.
//      The cookie also carries a masked address (n•••@example.org) that the
//      page always shows. Someone could mail you a link to *their* account
//      (login CSRF) to read what you ask; the visible address is how you'd
//      notice. Binding the link to the requesting browser would stop it
//      outright but break "tap the link on your phone, sign in on the laptop".
//   4. Redeeming a code while signed in binds the invite to the account
//      (member:<uid>). Every device signed in to that email is then in, for
//      one use of the code.
//
// Addresses are never stored for sign-in: only sent to Resend, the mail
// provider, so it can deliver the link.

import { sha256hex, readCookie, normalizeEmail } from './invites.js';

export const USER_COOKIE = 'siren_user';
const USER_DAYS = 30;
const TOKEN_MINUTES = 15;

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** n•••@example.org: enough to recognize your own account, not enough to read it off. */
export function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 1)}\u2022\u2022\u2022@${domain}`;
}

/** The account id for an email: a keyed hash, so it can't be reversed from KV. */
export async function userId(secret, email) {
  return hex(await hmac(secret, `user:${email}`));
}

/** Cookie value: base64url(JSON {u, e}).base64url(HMAC), domain-separated from invite cookies. */
export async function signUser(secret, uid, now = Date.now(), masked = '') {
  const payload = b64url(enc.encode(JSON.stringify({ u: uid, m: masked, e: Math.floor(now / 1000) + USER_DAYS * 86400 })));
  return `${payload}.${b64url(await hmac(secret, `user-cookie:${payload}`))}`;
}

export async function verifyUser(secret, value, now = Date.now()) {
  return (await verifyUserInfo(secret, value, now))?.uid || null;
}

/** { uid, masked } for a valid, unexpired account cookie, else null. */
export async function verifyUserInfo(secret, value, now = Date.now()) {
  if (!secret || typeof value !== 'string') return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  let given;
  let body;
  try {
    given = unb64url(sig);
    if (!timingSafeEqual(given, await hmac(secret, `user-cookie:${payload}`))) return null;
    body = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch {
    return null;
  }
  if (typeof body.u !== 'string' || !/^[0-9a-f]{64}$/.test(body.u)) return null;
  if (typeof body.e !== 'number' || body.e < Math.floor(now / 1000)) return null;
  return { uid: body.u, masked: typeof body.m === 'string' ? body.m.slice(0, 260) : '' };
}

export function userCookie(value, path = '/') {
  return `${USER_COOKIE}=${value}; Path=${path || '/'}; Max-Age=${USER_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
export function clearUserCookie(path = '/') {
  return `${USER_COOKIE}=; Path=${path || '/'}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function currentUser(req, env) {
  return verifyUser(env.INVITE_SECRET, readCookie(req, USER_COOKIE));
}
export async function currentUserInfo(req, env) {
  return verifyUserInfo(env.INVITE_SECRET, readCookie(req, USER_COOKIE));
}

/** Email sign-in is available only when its secret and sender are set. */
export const loginConfigured = (env) => Boolean(env.RESEND_API_KEY && env.LOGIN_FROM && env.INVITE_SECRET);

/** Send through Resend's HTTP API. `fetchImpl` is injectable for tests. */
export async function sendWithResend(env, { to, subject, text, html, idempotencyKey }, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: env.LOGIN_FROM, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`);
  return res.json();
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Start a sign-in. Returns { ok: true } or { ok: false, status, error }. The
 * answer is the same whether or not the address has signed in before.
 */
export async function startLogin({ body, env, kv, visitor, link, appName = 'Siren', send = sendWithResend, perEmailHourly = 3, perVisitorHourly = 10, now = Date.now() }) {
  if (!loginConfigured(env)) return { ok: false, status: 503, error: 'Email sign-in is not set up on this site yet.' };
  if (body?.website) return { ok: true }; // honeypot
  const email = normalizeEmail(body?.email);
  if (!email) return { ok: false, status: 400, error: "That email address doesn't look right." };
  const uid = await userId(env.INVITE_SECRET, email);
  const hour = new Date(now).toISOString().slice(0, 13);
  // Per address, so nobody can flood someone's inbox; per visitor, so one
  // person can't spray addresses.
  const keys = [`login-rate:${hour}:u:${uid.slice(0, 32)}`, `login-rate:${hour}:v:${visitor}`];
  const [byEmail, byVisitor] = await Promise.all(keys.map(async (k) => Number((await kv.get(k)) || 0)));
  if (byEmail >= perEmailHourly || byVisitor >= perVisitorHourly) {
    return { ok: false, status: 429, error: 'Too many sign-in emails for now. Check your inbox (and spam) for the last one, or try again in an hour.' };
  }
  await Promise.all([kv.put(keys[0], String(byEmail + 1), { expirationTtl: 7200 }), kv.put(keys[1], String(byVisitor + 1), { expirationTtl: 7200 })]);

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256hex(token);
  await kv.put(`login:${tokenHash}`, JSON.stringify({ u: uid, m: maskEmail(email), e: now + TOKEN_MINUTES * 60e3 }), { expirationTtl: TOKEN_MINUTES * 60 + 60 });
  const url = `${link}#t=${token}`;
  await send(env, {
    to: email,
    subject: `Sign in to ${appName}`,
    text: `Here's your link to sign in to ${appName}:\n\n${url}\n\nIt works once, for ${TOKEN_MINUTES} minutes. If you didn't ask for it, ignore this email; nothing happens without the link.`,
    html: `<p>Here's your link to sign in to ${escHtml(appName)}:</p><p><a href="${escHtml(url)}">Sign in to ${escHtml(appName)}</a></p><p>It works once, for ${TOKEN_MINUTES} minutes. If you didn't ask for it, ignore this email; nothing happens without the link.</p>`,
    idempotencyKey: `login-${tokenHash}`,
  });
  return { ok: true };
}

/** Finish a sign-in: spend the token once. Returns { ok, uid, cookie } or an error. */
export async function finishLogin({ token, env, kv, now = Date.now() }) {
  if (!env.INVITE_SECRET) return { ok: false, status: 503, error: 'Email sign-in is not set up on this site yet.' };
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return { ok: false, status: 400, error: 'That sign-in link is broken. Ask for a new one.' };
  const key = `login:${await sha256hex(token)}`;
  const record = await kv.get(key, 'json');
  if (!record || typeof record.u !== 'string' || record.e < now) return { ok: false, status: 403, error: 'That sign-in link has expired or was already used. Ask for a new one.' };
  await kv.delete(key);
  const masked = typeof record.m === 'string' ? record.m : '';
  return { ok: true, uid: record.u, masked, cookie: await signUser(env.INVITE_SECRET, record.u, now, masked) };
}

/** The invite an account is bound to, if it still exists and isn't revoked. */
export async function memberInvite(kv, uid) {
  if (!uid) return null;
  const member = await kv.get(`member:${uid}`, 'json');
  if (!member?.invite) return null;
  const invite = await kv.get(`invite:${member.invite}`, 'json');
  if (!invite || invite.revoked) return null;
  return { hash: member.invite, label: invite.label || '' };
}

export async function bindInvite(kv, uid, inviteHash, now = Date.now()) {
  await kv.put(`member:${uid}`, JSON.stringify({ invite: inviteHash, since: new Date(now).toISOString() }));
}
