// atproto identity, resolved by Siren itself: handle -> DID -> DID document
// -> PDS, with the handle checked in both directions. Pure: every network call
// goes through `fetchImpl`, and every call through `safeFetch`, the only way
// the Bluesky modules reach the network.
//
// Handle domains, DID documents and PDS URLs are all attacker-controlled, so
// safeFetch allows https on the default port to hostnames only, follows
// redirects by hand (re-checking each), never caches, and caps time and size.
// Error codes are fixed strings; no remote text ever leaves this module.
//
// Rules from atproto.com/specs/handle, /specs/did and the did:plc and did:web
// specs, read 2026-11-06.

export class IdentityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export const HANDLE_RE = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
export const DID_RE = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
export const DISALLOWED_TLDS = ['alt', 'arpa', 'example', 'internal', 'invalid', 'local', 'localhost', 'onion'];

const PLC_RE = /^did:plc:[a-z2-7]{24}$/;
const WEB_RE = /^did:web:[a-z0-9.-]+$/;

/** A DNS hostname Siren may name: the handle syntax, at most 253 characters, no disallowed TLD. */
function okHost(host) {
  if (typeof host !== 'string' || host.length > 253 || !HANDLE_RE.test(host)) return false;
  const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
  return !DISALLOWED_TLDS.includes(tld) && host.toLowerCase() !== 'localhost';
}

/** trim, strip one leading '@', lowercase; null unless a valid, resolvable handle. */
export function normalizeHandle(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.startsWith('@')) s = s.slice(1);
  s = s.toLowerCase();
  return okHost(s) ? s : null;
}

/** did:plc, or a hostname-level did:web (no port, no path). */
export function isSupportedDid(s) {
  if (typeof s !== 'string' || s.length > 2048 || !DID_RE.test(s)) return false;
  if (PLC_RE.test(s)) return true;
  // Hostname-level did:web only. The 253-character host limit is DNS's own;
  // a longer name can't resolve.
  return WEB_RE.test(s) && okHost(s.slice('did:web:'.length));
}

/** What someone typed into the sign-in form: { kind: 'did', did } | { kind: 'handle', handle } | null. */
export function parseAccountInput(input) {
  if (typeof input !== 'string' || input.length > 260) return null;
  const t = input.trim();
  const u = t.startsWith('@') ? t.slice(1) : t;
  if (u.startsWith('did:')) return isSupportedDid(u) ? { kind: 'did', did: u } : null;
  const handle = normalizeHandle(t);
  return handle ? { kind: 'handle', handle } : null;
}

// The authority (host[:port]) as written in an absolute or scheme-relative URL
// string, before the URL parser drops a default port. null for relative refs.
function rawAuthority(s) {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:[/\\]{2}([^/?#\\]*)/.exec(s) || /^[/\\]{2}([^/?#\\]*)/.exec(s);
  return m ? m[1] : null;
}

/**
 * URL | null: https only, no username or password, no port (not even an
 * explicit :443), and a hostname with a letter-led TLD (so no IP literals),
 * not localhost and not a disallowed TLD.
 */
export function safeUrl(s) {
  if (typeof s !== 'string' || s.length > 4096) return null;
  const auth = rawAuthority(s);
  if (auth === null || /[:@]/.test(auth)) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '') return null;
  return okHost(u.hostname) ? u : null;
}

async function cancelBody(res) {
  try {
    await res.body?.cancel();
  } catch {
    // already closed or locked
  }
}

/**
 * The hardened fetch. -> { status, headers, text, url }.
 * Throws IdentityError('bad_url' | 'redirect' | 'too_large'), or whatever the
 * underlying fetch throws (an abort, a network error).
 */
export async function safeFetch(url, { fetchImpl = fetch, method = 'GET', headers = {}, body, signal, timeoutMs = 4000, maxBytes = 65536, redirects = 0 } = {}) {
  let u = safeUrl(typeof url === 'string' ? url : String(url));
  if (!u) throw new IdentityError('bad_url');
  const sig = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(u.href, { method, headers, body, signal: sig, cache: 'no-store', redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      await cancelBody(res);
      const loc = res.headers.get('Location');
      if (hop >= redirects || !loc) throw new IdentityError('redirect');
      const auth = rawAuthority(loc);
      if (auth !== null && /[:@]/.test(auth)) throw new IdentityError('bad_url');
      let next;
      try {
        next = new URL(loc, u);
      } catch {
        throw new IdentityError('bad_url');
      }
      u = safeUrl(next.href);
      if (!u) throw new IdentityError('bad_url');
      continue;
    }
    const declared = Number(res.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancelBody(res);
      throw new IdentityError('too_large');
    }
    let text = '';
    if (res.body) {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          throw new IdentityError('too_large');
        }
        chunks.push(value);
      }
      const all = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.byteLength;
      }
      text = new TextDecoder().decode(all);
    }
    return { status: res.status, headers: res.headers, text, url: u.href };
  }
}

const parseObject = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

// TXT record data as DoH JSON gives it: one or more quoted segments.
function txtValue(data) {
  if (typeof data !== 'string') return '';
  const segs = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return segs.length ? segs.join('') : data;
}

async function dnsDid(handle, { fetchImpl, dohUrl, signal }) {
  const u = new URL(dohUrl || 'https://cloudflare-dns.com/dns-query');
  u.searchParams.set('name', `_atproto.${handle}`);
  u.searchParams.set('type', 'TXT');
  const res = await safeFetch(u.href, { fetchImpl, headers: { Accept: 'application/dns-json' }, signal, maxBytes: 65536 });
  if (res.status !== 200) return null;
  const doc = parseObject(res.text);
  if (!doc || !Array.isArray(doc.Answer)) return null;
  const dids = new Set();
  for (const a of doc.Answer.slice(0, 50)) {
    if (!a || a.type !== 16) continue;
    const v = txtValue(a.data);
    if (v.startsWith('did=')) dids.add(v.slice(4));
  }
  // Only one valid record should exist; several distinct DIDs mean no answer.
  if (dids.size !== 1) return null;
  const [did] = dids;
  return isSupportedDid(did) ? did : null;
}

async function httpsDid(handle, { fetchImpl, signal }) {
  const res = await safeFetch(`https://${handle}/.well-known/atproto-did`, { fetchImpl, signal, redirects: 3, maxBytes: 2048 });
  if (res.status < 200 || res.status >= 300) return null;
  const did = res.text.trim();
  return isSupportedDid(did) ? did : null;
}

/**
 * Handle -> DID. DNS (over HTTPS; a Worker has no raw DNS) and the HTTPS
 * well-known start at once. DNS wins a conflict, so once it answers its
 * answer is final and the HTTPS lookup is aborted.
 */
export async function resolveHandle(handle, { fetchImpl = fetch, dohUrl, signal } = {}) {
  const h = normalizeHandle(handle);
  if (!h) throw new IdentityError('handle_unresolved');
  const ctl = new AbortController();
  const httpsSignal = signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal;
  const dns = dnsDid(h, { fetchImpl, dohUrl, signal }).catch(() => null);
  const web = httpsDid(h, { fetchImpl, signal: httpsSignal }).catch(() => null);
  const fromDns = await dns;
  if (fromDns) {
    ctl.abort();
    return fromDns;
  }
  const fromWeb = await web;
  if (fromWeb) return fromWeb;
  throw new IdentityError('handle_unresolved');
}

/** DID -> DID document whose `id` is exactly the DID. */
export async function resolveDidDoc(did, { fetchImpl = fetch, plcUrl, signal } = {}) {
  if (!isSupportedDid(did)) throw new IdentityError('did_unresolved');
  const url = did.startsWith('did:plc:')
    ? `${String(plcUrl || 'https://plc.directory').replace(/\/+$/, '')}/${did}`
    : `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
  let res;
  try {
    res = await safeFetch(url, { fetchImpl, signal, maxBytes: 65536 });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new IdentityError('did_unresolved');
  }
  const doc = res.status === 200 ? parseObject(res.text) : null;
  if (!doc || doc.id !== did) throw new IdentityError('did_unresolved');
  return doc;
}

/** The first syntactically valid at:// handle the document claims (lowercased), or null. */
export function docHandle(doc) {
  const aka = Array.isArray(doc?.alsoKnownAs) ? doc.alsoKnownAs.slice(0, 20) : [];
  for (const s of aka) {
    if (typeof s !== 'string' || !s.startsWith('at://')) continue;
    const rest = s.slice(5);
    if (rest.startsWith('@') || /[/?#\s]/.test(rest)) continue;
    const h = normalizeHandle(rest);
    if (h) return h;
  }
  return null;
}

/**
 * The PDS origin the document declares, or null. The service id must be
 * `#atproto_pds` or `<the document's DID>#atproto_pds` (the reference
 * resolver's rule; stricter than "ends in #atproto_pds").
 */
export function docPds(doc) {
  const services = Array.isArray(doc?.service) ? doc.service.slice(0, 20) : [];
  for (const s of services) {
    if (!s || typeof s.id !== 'string') continue;
    if (s.id !== '#atproto_pds' && s.id !== `${doc.id}#atproto_pds`) continue;
    if (s.type !== 'AtprotoPersonalDataServer' || typeof s.serviceEndpoint !== 'string') continue;
    const ep = s.serviceEndpoint;
    if (/[?#]/.test(ep)) continue;
    const u = safeUrl(ep);
    if (!u || (u.pathname !== '/' && u.pathname !== '')) continue;
    return u.origin;
  }
  return null;
}

/** Input from parseAccountInput -> { did, handle (verified, or null), pds }. */
export async function resolveAccount(input, opts = {}) {
  let did;
  let handle = null;
  let doc;
  if (input?.kind === 'handle') {
    did = await resolveHandle(input.handle, opts);
    doc = await resolveDidDoc(did, opts);
    if (docHandle(doc) !== input.handle) throw new IdentityError('handle_mismatch');
    handle = input.handle;
  } else if (input?.kind === 'did') {
    did = input.did;
    doc = await resolveDidDoc(did, opts);
    const claimed = docHandle(doc);
    if (claimed) {
      try {
        if ((await resolveHandle(claimed, opts)) === did) handle = claimed;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
      }
    }
  } else {
    throw new IdentityError('bad_input');
  }
  const pds = docPds(doc);
  if (!pds) throw new IdentityError('no_pds');
  return { did, handle, pds };
}

/** 'YYYY-MM-DD' the did:plc was created (its first audit-log entry), or ''. Never throws. */
export async function plcCreatedDay(did, { fetchImpl = fetch, plcUrl, signal } = {}) {
  try {
    if (typeof did !== 'string' || !PLC_RE.test(did)) return '';
    const res = await safeFetch(`${String(plcUrl || 'https://plc.directory').replace(/\/+$/, '')}/${did}/log/audit`, { fetchImpl, signal, maxBytes: 131072 });
    if (res.status !== 200) return '';
    const log = JSON.parse(res.text);
    const at = Array.isArray(log) ? log[0]?.createdAt : null;
    return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at.slice(0, 10) : '';
  } catch {
    return '';
  }
}
