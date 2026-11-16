// The steward's waitlist (/admin/waitlist; Jason, 2026-11-16: "a tab to view
// the Waitlist and send waitlisted users a code, thereby taking them off the
// waitlist and granting them access"). Pure helpers that take KV, the
// environment and the mail sender as arguments, like invites.js.
//
// Sending mints a fresh invite (good for SEND_USES browsers, the CLI's
// default; signing in carries it to every device), emails the code to the
// address on the entry through Resend, the sign-in mail's sender, and only
// then deletes the entry. If the email fails, the invite is deleted again and
// the entry stays. The code itself is never stored, returned or logged: only
// its hash, as every invite. The invite's label names the person only by a
// masked address (n•••@example.org), so once the entry is gone KV holds no
// address for them, as for email sign-in.

import { newCode, inviteKey, normalizeEmail, basePathOf } from './invites.js';
import { loginConfigured, maskEmail, sendWithResend } from './accounts.js';
import { publicOrigin } from './atproto-oauth.js';

export const SEND_USES = 3;
const ID_RE = /^[0-9a-f]{64}$/;
// Read at most this many entries (a list call per 1,000 keys, a bulk get per
// 100) and show the oldest MAX_SHOWN of them.
const MAX_READ = 5000;
const MAX_SHOWN = 1000;
const inviteOnly = (env) => String(env.INVITE_REQUIRED || '').toLowerCase() === 'true';
const NOT_INVITE_ONLY = 'Siren isn’t invite-only right now, so there’s no code to enter (the sign-in and code forms are off) and anyone can ask without one. Remove them instead, or turn invite-only back on first.';
const clip = (s, n) => String(s ?? '').slice(0, n);
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const isWaitlistId = (id) => typeof id === 'string' && ID_RE.test(id);

/** Every entry, oldest first, and how sending stands here. */
export async function listWaitlist(kv, env) {
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'waitlist:', cursor });
    for (const k of page.keys) if (ID_RE.test(k.name.slice('waitlist:'.length))) names.push(k.name);
    cursor = page.list_complete || names.length >= MAX_READ ? undefined : page.cursor;
  } while (cursor);
  // KV's bulk get: 100 keys are one of the 1,000 operations a Worker
  // invocation may make (see requests.js requestRows), so 1,000 entries
  // cost 10, not 1,000.
  const values = new Map();
  const wanted = names.slice(0, MAX_READ);
  for (let i = 0; i < wanted.length; i += 100) {
    const got = await kv.get(wanted.slice(i, i + 100), 'json');
    for (const [k, v] of got) values.set(k, v);
  }
  const entries = [];
  for (const name of wanted) {
    const e = values.get(name);
    if (!e || typeof e !== 'object') continue;
    entries.push({
      id: name.slice('waitlist:'.length),
      email: clip(e.email, 254),
      name: clip(e.name, 120),
      org: clip(e.org, 160),
      note: clip(e.note, 600),
      source: clip(e.source, 60),
      at: clip(e.at, 40),
      ...(e.sent_maybe ? { sent_maybe: clip(e.sent_maybe, 40) } : {}),
    });
  }
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const blocked = !loginConfigured(env) ? 'Email isn’t set up here (RESEND_API_KEY and LOGIN_FROM), so codes can’t be sent.'
    : !publicOrigin(env) ? 'PUBLIC_ORIGIN isn’t set, so the email would have no link to the site.'
      : !inviteOnly(env) ? NOT_INVITE_ONLY : null;
  return {
    entries: entries.slice(0, MAX_SHOWN),
    total: entries.length,
    truncated: entries.length > MAX_SHOWN || names.length >= MAX_READ,
    can_send: !blocked,
    send_blocked: blocked,
    invite_only: inviteOnly(env),
    uses: SEND_USES,
  };
}

/** The invite email: the code, the site's own link (PUBLIC_ORIGIN, never the Host header) and how to use it. */
export function inviteEmail({ appName, link, code, uses }) {
  const text = `You're off the ${appName} waitlist. Here's your invite code:\n\n    ${code}\n\nTo start, open ${link}, sign in with this email address, then enter the code. Once you've entered it while signed in, it works on every device you sign in on. Without signing in, it works in up to ${uses} browsers.\n\nThe code is for you; please don't share it.`;
  const html = `<p>You're off the ${escHtml(appName)} waitlist. Here's your invite code:</p><p style="font-size:1.25em;font-family:monospace;letter-spacing:.05em"><strong>${escHtml(code)}</strong></p><p>To start, open <a href="${escHtml(link)}">${escHtml(link)}</a>, sign in with this email address, then enter the code. Once you've entered it while signed in, it works on every device you sign in on. Without signing in, it works in up to ${uses} browsers.</p><p>The code is for you; please don't share it.</p>`;
  return { subject: `Your invite to ${appName}`, text, html };
}

/** Resend's own refusal (a 4xx from its API, accounts.js sendWithResend): the email certainly didn't go. */
const refused = (err) => /^Resend 4\d\d$/.test(String(err?.message || ''));

/**
 * Send one waitlisted person a code. Returns { ok: true, email, warning? }
 * or { ok: false, status, error, maybe_sent? }.
 *
 * Before the email goes, the entry is marked with when a code may have gone
 * out (sent_maybe), so a send cut off partway (the steward leaving the page,
 * an error after Resend took the mail) is visible on the list rather than
 * silently re-sendable. If Resend refuses the mail outright (a 4xx), the
 * invite is taken back and the mark cleared: nothing changed. If the answer
 * is unclear (a timeout, a 5xx, a broken reply), the invite is kept, since
 * the email may have arrived, and the entry stays, marked. A send marker
 * (a random token for a minute, re-read after writing) refuses a second
 * send while one is under way; KV can't make that atomic, so it narrows the
 * race rather than closing it.
 */
export async function sendWaitlistInvite({ kv, env, id, appName = 'Siren', send = sendWithResend, now = Date.now() }) {
  if (!isWaitlistId(id)) return { ok: false, status: 400, error: 'Give the entry’s id.' };
  if (!loginConfigured(env)) return { ok: false, status: 503, error: 'Email isn’t set up here (RESEND_API_KEY and LOGIN_FROM), so codes can’t be sent.' };
  const origin = publicOrigin(env);
  if (!origin) return { ok: false, status: 503, error: 'PUBLIC_ORIGIN isn’t set, so the email would have no link to the site.' };
  if (!inviteOnly(env)) return { ok: false, status: 409, error: NOT_INVITE_ONLY };
  const entry = await kv.get(`waitlist:${id}`, 'json');
  if (!entry) return { ok: false, status: 404, error: 'That person isn’t on the waitlist any more (sent or removed already). Reload the list.' };
  const email = normalizeEmail(entry.email);
  if (!email) return { ok: false, status: 422, error: 'That entry’s email address doesn’t look right. Remove it instead.' };
  const lock = `waitlist-sending:${id}`;
  const busy = { ok: false, status: 409, error: 'A code for this person is already being sent. Reload in a minute.' };
  if (await kv.get(lock)) return busy;
  const token = crypto.randomUUID();
  await kv.put(lock, token, { expirationTtl: 60 });
  if ((await kv.get(lock)) !== token) return busy;

  const at = new Date(now).toISOString();
  const code = newCode();
  const key = await inviteKey(code);
  await kv.put(key, JSON.stringify({ label: `Waitlist: ${maskEmail(email)}`, max_uses: SEND_USES, created: at, via: 'waitlist' }));
  await kv.put(`waitlist:${id}`, JSON.stringify({ ...entry, sent_maybe: at }));
  const link = `${origin.origin}${basePathOf(env)}/`;
  try {
    await send(env, { to: email, ...inviteEmail({ appName, link, code, uses: SEND_USES }), idempotencyKey: `waitlist-${key.slice('invite:'.length)}` });
  } catch (err) {
    if (refused(err)) {
      // Certainly not sent: take the invite back and leave the entry as it was.
      await kv.delete(key).catch(() => {});
      await kv.put(`waitlist:${id}`, JSON.stringify(entry)).catch(() => {});
      await kv.delete(lock).catch(() => {});
      return { ok: false, status: 502, error: 'The email provider refused the email, so nothing changed: no code was made and they’re still on the waitlist.' };
    }
    await kv.delete(lock).catch(() => {});
    return { ok: false, status: 502, maybe_sent: true, error: 'The email provider didn’t confirm the email, so it may or may not have gone out. The code was kept and they’re still on the list, marked. If they got it, remove them; if not, send again.' };
  }
  try {
    await kv.delete(`waitlist:${id}`);
  } catch {
    return { ok: true, email, warning: 'Sent, but they couldn’t be taken off the list just now. Remove them by hand.' };
  } finally {
    await kv.delete(lock).catch(() => {});
  }
  return { ok: true, email };
}

/** Take someone off the waitlist without sending anything. */
export async function removeFromWaitlist({ kv, id }) {
  if (!isWaitlistId(id)) return { ok: false, status: 400, error: 'Give the entry’s id.' };
  if (!(await kv.get(`waitlist:${id}`))) return { ok: false, status: 404, error: 'That person isn’t on the waitlist any more. Reload the list.' };
  await kv.delete(`waitlist:${id}`);
  return { ok: true };
}
