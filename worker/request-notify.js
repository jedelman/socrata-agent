// One email when a requested source is decided (Jason, 2026-11-18: "When a
// source request is fulfilled, does siren notify those who had requested that
// source by email? We should." Then, the same day, yes to declined requests
// too, and to asking from the public list).
//
// A request keeps nothing about who asked (requests.js). This is the one
// exception, and only on the asker's own say: a signed-in member ticks "Email
// me when it's added or declined" on the request card, or presses that button
// on an open request on the public list, and types the email they signed in
// with, checked against the account as watches do. What's kept:
//
//   request-notify:<hash>:<tag>  { v: 1, sealed: { iv, ct }, day }
//
// <hash> is the request's own key hash (requests.js requestKey); <tag> is an
// HMAC of it and the account, so an account asks once per request and nothing
// in the key names the account. The address is AES-GCM sealed under a key
// derived from INVITE_SECRET, bound to the key's name. None of it is in the
// request, its steward views, the public list, the GitHub mirror or a log.
// It goes when the email is sent, when the person undoes it, or after
// NOTIFY_DAYS, whichever comes first.
//
// The cron sends: for each kept key whose request is now fulfilled, one email
// (the source, the steward's link to what added it and their public note);
// for one declined, one email (the source and the steward's note) once the
// UTC day of the decision has passed, so a decline made by mistake can be
// undone before anyone hears. At most REQUEST_NOTIFY_DAILY a day (default
// 100, "0" pauses), then the key is deleted. A request set back to open
// before the cron sends sends nothing.
//
// Behind REQUEST_NOTIFY (off). With it off, nothing here runs: the session,
// the request card, POST /api/requests and the cron are as before.

import { enc, b64url, unb64url, hmac, hex, sha256 } from './crypto.js';
import { loginConfigured, sendWithResend, userId } from './accounts.js';
import { normalizeEmail } from './invites.js';
import { requestKey, requestStatusByKey } from './requests.js';

export const NOTIFY_DAYS = 365;
const PREFIX = 'request-notify:';
const LIST_MAX = 5000;

const flag = (v) => String(v ?? '').trim() === 'true';
export const notifyOn = (env) => flag(env?.REQUEST_NOTIFY);
/** On, and able to send: email sign-in set up, a public origin for links, KV. */
export const notifyReady = (env) => notifyOn(env) && loginConfigured(env) && Boolean(env.PUBLIC_ORIGIN) && Boolean(env.LIMITS);

/** The key for one account's ask on one request, by the request's storage key. */
export async function notifyKeyFor(secret, key, uid) {
  const hash = String(key).slice('request:'.length);
  const tag = hex(await hmac(secret, `request-notify:${hash}:${uid}`)).slice(0, 24);
  return `${PREFIX}${hash}:${tag}`;
}
/** The same, by the request's source text (folded as a raise folds it). */
export const notifyKey = async (secret, source, uid) => notifyKeyFor(secret, await requestKey(source), uid);
const hashOf = (name) => name.slice(PREFIX.length).split(':')[0];

async function sealKey(secret) {
  return crypto.subtle.importKey('raw', await hmac(secret, 'request-notify-email-key:v1'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function sealFor(secret, name, email) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(name) }, await sealKey(secret), enc.encode(email)));
  return { iv: b64url(iv), ct: b64url(ct) };
}
export async function openFor(secret, name, sealed) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(sealed.iv), additionalData: enc.encode(name) }, await sealKey(secret), unb64url(sealed.ct));
  return new TextDecoder().decode(pt);
}

/**
 * Check an opt-in before the request is raised: { ok: true, email } or
 * { ok: false, status, error, code }. Only the address this account signed in
 * with, typed again.
 */
export async function checkOptIn(env, uid, body) {
  if (!uid) return { ok: false, status: 401, code: 'signin', error: "Sign in to be emailed when it's added." };
  const email = normalizeEmail(body?.email);
  if (!email || (await userId(env.INVITE_SECRET, email)) !== uid) return { ok: false, status: 400, code: 'email', error: 'Enter the email you signed in with: the note goes only to that address.' };
  return { ok: true, email };
}

/** Keep one account's ask on a request, by `key` or `source` (a second ask replaces the first). */
export async function optIn(kv, env, { uid, key, source, email, now = Date.now() }) {
  const name = key ? await notifyKeyFor(env.INVITE_SECRET, key, uid) : await notifyKey(env.INVITE_SECRET, source, uid);
  await kv.put(name, JSON.stringify({ v: 1, sealed: await sealFor(env.INVITE_SECRET, name, email), day: new Date(now).toISOString().slice(0, 10) }), { expirationTtl: NOTIFY_DAYS * 86400 });
  return name;
}

/** Drop one account's ask on a request, by `key` or `source`. */
export async function optOut(kv, env, { uid, key, source }) {
  await kv.delete(key ? await notifyKeyFor(env.INVITE_SECRET, key, uid) : await notifyKey(env.INVITE_SECRET, source, uid));
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const httpsLink = (u) => (/^https:\/\/[^\s<>"]+$/i.test(String(u || '')) ? String(u) : '');

/**
 * The one email: what was decided, the steward's note (and for an added
 * source, their link to what added it), and that the address is gone.
 */
export function notifyMail({ appName = 'Siren', origin, request }) {
  const source = String(request.source || '').slice(0, 200);
  const note = String(request.steward_note || '').slice(0, 600);
  if (request.status === 'declined') {
    const subject = `Not added to ${appName}: ${source}`.slice(0, 160);
    const lines = [
      `You asked ${appName} to add a source: ${source}.`,
      `The steward decided not to add it for now.`,
      ...(note ? ['', `Why: ${note}`] : []),
      '',
      `${appName} still answers what the records she reaches can show: ${origin}/`,
      `The source request list: ${origin}/requests`,
      '',
      `You asked for one email when this request was decided. This is it, and ${appName} has now deleted your address.`,
    ];
    const html = `<p>You asked ${escHtml(appName)} to add a source: <strong>${escHtml(source)}</strong>.</p><p>The steward decided not to add it for now.</p>${note ? `<p>Why: ${escHtml(note)}</p>` : ''}<p><a href="${escHtml(origin)}/">Ask ${escHtml(appName)}</a> · <a href="${escHtml(origin)}/requests">The source request list</a></p><p style="color:#666">You asked for one email when this request was decided. This is it, and ${escHtml(appName)} has now deleted your address.</p>`;
    return { subject, text: lines.join('\n'), html };
  }
  const by = httpsLink(request.fulfilled_by);
  const subject = `Added to ${appName}: ${source}`.slice(0, 160);
  const lines = [
    `You asked ${appName} to add a source: ${source}.`,
    `It's in now, so questions that needed it can be answered from it.`,
    ...(note ? ['', `From the steward: ${note}`] : []),
    ...(by ? ['', `What added it: ${by}`] : []),
    '',
    `Ask your question again: ${origin}/`,
    `The source request list: ${origin}/requests`,
    '',
    `You asked for one email when this request was decided. This is it, and ${appName} has now deleted your address.`,
  ];
  const html = `<p>You asked ${escHtml(appName)} to add a source: <strong>${escHtml(source)}</strong>.</p><p>It's in now, so questions that needed it can be answered from it.</p>${note ? `<p>From the steward: ${escHtml(note)}</p>` : ''}${by ? `<p><a href="${escHtml(by)}">What added it</a></p>` : ''}<p><a href="${escHtml(origin)}/">Ask your question again</a> · <a href="${escHtml(origin)}/requests">The source request list</a></p><p style="color:#666">You asked for one email when this request was decided. This is it, and ${escHtml(appName)} has now deleted your address.</p>`;
  return { subject, text: lines.join('\n'), html };
}

const resendStatus = (err) => Number(/Resend (\d{3})/.exec(String(err?.message || ''))?.[1]) || 0;

/**
 * The cron's part: send the ones whose request is decided (fulfilled at once,
 * declined once the day of the decision has passed), up to the day's cap,
 * deleting each key once its email is sent. Returns counts only.
 */
export async function sendDecided(env, { appName = 'Siren', fetchImpl = fetch, send = sendWithResend, now = Date.now() } = {}) {
  const out = { kept: 0, due: 0, sent: 0, failed: 0, capped: 0, stopped: false };
  if (!notifyReady(env)) return out;
  const kv = env.LIMITS;
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: PREFIX, cursor });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < LIST_MAX);
  out.kept = names.length;
  if (!names.length) return out;
  const cap = Math.max(0, Math.floor(Number(env.REQUEST_NOTIFY_DAILY ?? 100) || 0));
  const day = new Date(now).toISOString().slice(0, 10);
  const countKey = `request-notify-count:${day}`;
  let mailed = Number((await kv.get(countKey)) || 0);
  const start = mailed;
  const origin = String(env.PUBLIC_ORIGIN).replace(/\/+$/, '');
  const byHash = new Map();
  for (const name of names) {
    const h = hashOf(name);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(name);
  }
  let refusals = 0;
  try {
    for (const [h, keys] of byHash) {
      if (out.stopped) break;
      const request = await requestStatusByKey(kv, `request:${h}`);
      // Declined: only once the decision's UTC day is over (dates are kept as days), a day to undo a mistake.
      const due = request?.status === 'fulfilled' || (request?.status === 'declined' && typeof request.decided === 'string' && request.decided.slice(0, 10) < day);
      if (!due) continue;
      out.due += keys.length;
      const mail = notifyMail({ appName, origin, request });
      for (const name of keys) {
        if (mailed >= cap) {
          out.capped++;
          continue;
        }
        const kept = await kv.get(name, 'json');
        if (!kept?.sealed) continue;
        let to;
        try {
          to = await openFor(env.INVITE_SECRET, name, kept.sealed);
        } catch {
          // Sealed under another secret: nothing can be sent; it expires on its own.
          continue;
        }
        // One email per ask, whatever the run: Resend drops a repeat of this key for a day.
        const idempotencyKey = `request-notify-${hex(await sha256(name)).slice(0, 32)}`;
        try {
          await send(env, { to, ...mail, idempotencyKey }, fetchImpl);
        } catch (err) {
          const status = resendStatus(err);
          if (status !== 409) {
            out.failed++;
            console.error('request notify: an email was not sent', status || 'error');
            if (status >= 400 && status < 500 && status !== 429) {
              if (++refusals >= 3) out.stopped = true;
            } else out.stopped = true;
            if (out.stopped) break;
            continue;
          }
          // 409: Resend already took this key, so the email went.
        }
        mailed++;
        out.sent++;
        await kv.delete(name).catch(() => {});
      }
    }
  } finally {
    // The day's count, written once a run (KV takes one write a second per key).
    if (mailed !== start) await kv.put(countKey, String(mailed), { expirationTtl: 2 * 86400 }).catch(() => {});
  }
  return out;
}
