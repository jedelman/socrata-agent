// Shared WebCrypto primitives. Runs unchanged in Node, Cloudflare Workers and
// the browser (index.js serves it to the requests page, for the endorse
// client); no dependency. Nothing secret-keyed here is used by the browser.
//
// invites.js and accounts.js keep their own private copies of a few of these
// for now; deduplicating them is a separate, mechanical change.

export const enc = new TextEncoder();

/** Uint8Array -> base64url, no padding. */
export function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url -> Uint8Array. Throws on anything that isn't base64url. */
export function unb64url(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('bad base64url');
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
}

export function randomToken(nBytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}

const bytesOf = (data) => (typeof data === 'string' ? enc.encode(data) : data);

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytesOf(data)));
}

export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytesOf(data)));
}

export async function hmacHex(secret, data, n = 64) {
  return hex(await hmac(secret, data)).slice(0, n);
}

/**
 * Epoch seconds at the start of the UTC hour, day or month that is `ahead`
 * units after the current one. Keys written in the same bucket share an
 * expiration, so a listing's expirations can't pair keys from one request.
 */
export function boundary(nowMs, unit, ahead) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  let t;
  if (unit === 'hour') t = Date.UTC(y, m, day, d.getUTCHours() + ahead);
  else if (unit === 'day') t = Date.UTC(y, m, day + ahead);
  else if (unit === 'month') t = Date.UTC(y, m + ahead, 1);
  else throw new Error(`Unknown unit ${unit}`);
  return Math.floor(t / 1000);
}
