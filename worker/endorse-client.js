// The browser's Bluesky client for endorsing (docs/bluesky-endorsements.md,
// "The browser flow"). The requests page is the OAuth client: it signs in
// with PAR, PKCE and DPoP, then writes and deletes endorsement records on
// the person's own PDS. Siren's Worker never sees a token; the only thing it
// may be asked is to resolve a handle a browser can't (public data).
//
// Sign-in, in short:
//   1. Resolve the account in the browser (DNS over HTTPS, the handle's
//      well-known, the DID document), falling back to the Worker's
//      /api/bsky/resolve for the DID only; the browser checks the DID
//      document's handle and PDS itself. Then the PDS's authorization
//      server and its metadata, with the same checks the server used to
//      make.
//   2. A non-extractable P-256 key, PKCE and a random state, kept in the
//      store (IndexedDB) for 10 minutes; PAR asking for
//      `atproto repo:<NSID>?action=create&action=delete` and
//      response_mode=fragment; then the browser goes to the AS.
//   3. Back on /requests#state=…&iss=…&code=…: exactly one stored flow for
//      that state, unexpired, iss equal to its issuer; the token request;
//      the token must be DPoP, name the DID, and grant the repo scope (a
//      server may grant less without saying so; then the token is revoked
//      and nothing is kept); the DID is re-resolved with no cache and its
//      PDS must still name the same AS.
//   4. The session (DID, handle, PDS, access token, key) is kept at most 24
//      hours, with no refresh token (D2, default, pending Jason); an action
//      after the token expires re-authorizes with login_hint = the DID.
//
// Every remote string is untrusted. Error codes map to the fixed sentences
// in MESSAGES; no remote text reaches the page.

import { parseAccountInput, resolveHandle, resolveDidDoc, docHandle, docPds, isSupportedDid, safeFetch } from './atproto-identity.js';
import {
  clientIds, authServerFor, authServerMetadata, pkce, newDpopKey, pushAuthorization, authorizeUrl, exchangeCode,
  checkTokenResponse, revokeTokens, dpopPost,
} from './atproto-oauth.js';
import { ENDORSE_NSID, ENDORSE_ID_RE, endorseSubject, buildEndorsement, endorses } from './endorse-config.js';
import { randomToken } from './crypto.js';

export const FLOW_MS = 10 * 60e3;
/** The longest a sign-in lasts in the browser (D2, default, pending Jason). */
export const SESSION_MS = 24 * 3600e3;
const LIST_PAGES = 10;
const BATCH = 50;

// Fixed sentences; remote text never reaches a person.
export const MESSAGES = {
  bad_input: "That doesn't look like a Bluesky handle. Try one like alice.bsky.social.",
  handle_unresolved: "I couldn't find that handle. Check the spelling, or try again in a minute.",
  did_unresolved: "I couldn't read that account's public record. Try again in a minute.",
  handle_mismatch: "That handle's record doesn't point back to it, so I can't sign you in with it.",
  no_pds: "That account doesn't name a server I can sign in through.",
  pds_unsupported: "Your Bluesky server doesn't offer a sign-in I can use from a web page, or didn't answer. Try again in a minute.",
  as_unsupported: "Your Bluesky server's sign-in doesn't meet the checks I need.",
  issuer_mismatch: "Your Bluesky server's answer didn't check out, so I didn't sign you in.",
  as_refused: 'Your Bluesky server refused to start the sign-in. Try again in a minute.',
  busy: 'Lots of sign-ins right now. Try again in a minute.',
  flow_expired: 'That sign-in took too long, was already used, or was started in another tab. Try again.',
  denied: 'Sign-in was cancelled.',
  as_error: "Your Bluesky server couldn't finish the sign-in. Try again in a minute.",
  token_failed: "Your Bluesky server couldn't finish the sign-in. Try again in a minute.",
  token_type: "Your Bluesky server's answer didn't check out, so I didn't sign you in.",
  account_mismatch: "Your Bluesky server's answer didn't check out, so I didn't sign you in.",
  scope_missing: "Your Bluesky server's answer didn't check out, so I didn't sign you in.",
  scope_narrow: "Your Bluesky server can't grant the narrow permission Siren needs (to create and delete endorsement records only), so Siren didn't sign you in.",
  signed_out: 'Sign in with Bluesky first.',
  reauth: 'Your Bluesky sign-in has expired. Sign in again to go on.',
  write_failed: "Your Bluesky server didn't save that. Try again in a minute.",
  not_listed: "That request isn't open for endorsements.",
};

export class EndorseError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EndorseError';
    this.code = code;
  }
}

const codeOf = (err, fallback) => (err?.code && MESSAGES[err.code] ? err.code : fallback);

/**
 * A client for one page. `origin` is PUBLIC_ORIGIN (the page's own), `base`
 * the path prefix, `store` from endorse-store.js, `resolveFallback(account)`
 * the Worker's resolver (-> { did } or throws EndorseError).
 */
export function createClient({ origin, base = '', store, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), resolveFallback, dohUrl, plcUrl }) {
  const ids = clientIds({ PUBLIC_ORIGIN: origin }, base);
  if (!ids) throw new EndorseError('not_set_up');
  const opts = { fetchImpl, ...(dohUrl ? { dohUrl } : {}), ...(plcUrl ? { plcUrl } : {}) };

  // Handle or DID -> { did, handle, pds }, in the browser where it can be.
  async function resolve(input) {
    let did;
    if (input.kind === 'handle') {
      try {
        did = await resolveHandle(input.handle, opts);
      } catch {
        did = null;
      }
      if (!did && resolveFallback) {
        const r = await resolveFallback(input.handle);
        did = isSupportedDid(r?.did) ? r.did : null;
      }
      if (!did) throw new EndorseError('handle_unresolved');
    } else {
      did = input.did;
    }
    let doc;
    try {
      doc = await resolveDidDoc(did, opts);
    } catch {
      throw new EndorseError('did_unresolved');
    }
    let handle = null;
    if (input.kind === 'handle') {
      if (docHandle(doc) !== input.handle) throw new EndorseError('handle_mismatch');
      handle = input.handle;
    } else {
      const claimed = docHandle(doc);
      try {
        if (claimed && (await resolveHandle(claimed, opts)) === did) handle = claimed;
      } catch {
        handle = null;
      }
    }
    const pds = docPds(doc);
    if (!pds) throw new EndorseError('no_pds');
    return { did, handle, pds };
  }

  /** Start a sign-in. -> the authorization URL to send the browser to. `after` rides along (e.g. a request id to endorse). */
  async function signIn(account, after = null) {
    const input = parseAccountInput(account);
    if (!input) throw new EndorseError('bad_input');
    try {
      const { did, handle, pds } = await resolve(input);
      const issuer = await authServerFor(pds, opts);
      const meta = await authServerMetadata(issuer, opts);
      const state = randomToken(32);
      const { verifier, challenge } = await pkce();
      const key = await newDpopKey();
      const { requestUri, nonce } = await pushAuthorization({ meta, clientId: ids.clientId, redirectUri: ids.redirectUri, state, challenge, loginHint: input.kind === 'did' ? input.did : input.handle, key, fetchImpl, now: now() });
      await store.putFlow({
        state, verifier, did, handle, pds, issuer, key, nonce,
        tokenEndpoint: meta.token_endpoint, revocationEndpoint: meta.revocation_endpoint || null,
        expires: now() + FLOW_MS, after: typeof after === 'string' && after.length <= 64 ? after : null,
      });
      return authorizeUrl(meta, ids.clientId, requestUri);
    } catch (err) {
      throw new EndorseError(codeOf(err, 'as_refused'));
    }
  }

  /**
   * Finish a sign-in from the URL fragment. -> null when the fragment isn't
   * a sign-in return; { handle, after } on success; throws EndorseError.
   */
  async function finish(fragment) {
    const params = new URLSearchParams(String(fragment || '').replace(/^#/, ''));
    const state = params.get('state');
    if (!state || (!params.has('code') && !params.has('error'))) return null;
    const flow = await store.takeFlow(state);
    await store.purgeFlows(now());
    if (!flow || !(flow.expires > now())) throw new EndorseError('flow_expired');
    // RFC 9207, before reading the error or the code.
    if (params.get('iss') !== flow.issuer) throw new EndorseError('issuer_mismatch');
    const error = params.get('error');
    if (error !== null) throw new EndorseError(error === 'access_denied' ? 'denied' : 'as_error');
    const code = params.get('code');
    if (typeof code !== 'string' || code.length < 1 || code.length > 2048) throw new EndorseError('as_error');
    let token;
    let nonce = flow.nonce;
    const revoke = () => revokeTokens({ revocationEndpoint: flow.revocationEndpoint, token, clientId: ids.clientId, key: flow.key, nonce, fetchImpl, now: now() });
    try {
      ({ token, nonce } = await exchangeCode({ tokenEndpoint: flow.tokenEndpoint, code, verifier: flow.verifier, clientId: ids.clientId, redirectUri: ids.redirectUri, key: flow.key, nonce, fetchImpl, now: now() }));
    } catch (err) {
      if (err?.token) {
        token = err.token;
        nonce = err.nonce || nonce;
        await revoke();
      }
      throw new EndorseError('token_failed');
    }
    try {
      checkTokenResponse(token, flow.did);
    } catch (err) {
      await revoke();
      throw new EndorseError(codeOf(err, 'account_mismatch'));
    }
    // Re-resolve with no cache: the account's PDS must still name this AS.
    let pds;
    try {
      pds = docPds(await resolveDidDoc(flow.did, opts));
      if (!pds) throw new EndorseError('no_pds');
      if ((await authServerFor(pds, opts)) !== flow.issuer) {
        await revoke();
        throw new EndorseError('issuer_mismatch');
      }
    } catch (err) {
      if (err?.code === 'issuer_mismatch') throw err;
      await revoke();
      throw new EndorseError('did_unresolved');
    }
    const t = now();
    const life = Number.isFinite(token.expires_in) && token.expires_in > 0 ? Math.min(token.expires_in * 1000, SESSION_MS) : 5 * 60e3;
    await store.putSession({
      did: flow.did, handle: flow.handle, pds, issuer: flow.issuer, key: flow.key,
      accessToken: token.access_token, tokenExpires: t + life, expires: t + SESSION_MS,
      asNonce: nonce, pdsNonce: null, revocationEndpoint: flow.revocationEndpoint,
      // A refresh token is never used; one sent anyway is revoked on sign out.
      ...(typeof token.refresh_token === 'string' && token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    });
    return { handle: flow.handle, did: flow.did, after: flow.after };
  }

  /** The signed-in account, or null; an expired session is deleted. -> { did, handle, tokenLive }. */
  async function current() {
    const s = await store.getSession();
    if (!s) return null;
    if (!(s.expires > now())) {
      await store.deleteSession();
      return null;
    }
    return { did: s.did, handle: s.handle, tokenLive: s.tokenExpires > now() };
  }

  async function liveSession() {
    const s = await store.getSession();
    if (!s || !(s.expires > now())) throw new EndorseError('signed_out');
    if (!(s.tokenExpires > now())) throw new EndorseError('reauth');
    return s;
  }

  // One authenticated write to the session's own PDS, its nonce kept apart from the AS's.
  async function pdsPost(s, nsid, body) {
    let out;
    try {
      out = await dpopPost(`${s.pds}/xrpc/${nsid}`, { json: body, key: s.key, nonce: s.pdsNonce, accessToken: s.accessToken, fetchImpl, now: now() });
    } catch {
      throw new EndorseError('write_failed');
    }
    if (out.nonce && out.nonce !== s.pdsNonce) {
      s.pdsNonce = out.nonce;
      await store.putSession(s);
    }
    if (out.status === 401) throw new EndorseError('reauth');
    return out;
  }

  // The session account's own endorsement records, read without a token:
  // [{ rkey, value }], at most LIST_PAGES pages of 100.
  async function listOwn(s) {
    const out = [];
    let cursor;
    for (let page = 0; page < LIST_PAGES; page++) {
      const u = new URL('/xrpc/com.atproto.repo.listRecords', s.pds);
      u.searchParams.set('repo', s.did);
      u.searchParams.set('collection', ENDORSE_NSID);
      u.searchParams.set('limit', '100');
      if (cursor) u.searchParams.set('cursor', cursor);
      const res = await safeFetch(u.href, { fetchImpl, maxBytes: 262144 });
      if (res.status !== 200) throw new EndorseError('write_failed');
      let body;
      try {
        body = JSON.parse(res.text);
      } catch {
        throw new EndorseError('write_failed');
      }
      for (const r of Array.isArray(body?.records) ? body.records.slice(0, 100) : []) {
        const m = typeof r?.uri === 'string' && /^at:\/\/([^/]+)\/([^/]+)\/([A-Za-z0-9._:~-]{1,512})$/.exec(r.uri);
        if (m && m[1] === s.did && m[2] === ENDORSE_NSID) out.push({ rkey: m[3], value: r.value });
      }
      cursor = typeof body?.cursor === 'string' && body.cursor.length <= 512 ? body.cursor : null;
      if (!cursor) break;
    }
    return out;
  }

  const subjectOf = (id) => {
    const subject = typeof id === 'string' && ENDORSE_ID_RE.test(id) ? endorseSubject(origin, base, id) : null;
    if (!subject) throw new EndorseError('not_listed');
    return subject;
  };

  /** Write the endorsement record for one request (rkey = its id). Already there counts as done. */
  async function endorse({ id, source }) {
    const subject = subjectOf(id);
    const s = await liveSession();
    const record = buildEndorsement({ subject, id, title: source, now: now() });
    // No `validate` field: the PDS can't resolve an unpublished Lexicon, and
    // optimistic validation is the default.
    const out = await pdsPost(s, 'com.atproto.repo.createRecord', { repo: s.did, collection: ENDORSE_NSID, rkey: id, record });
    if (out.status === 200) return { ok: true, already: false };
    // A record already under that key (another tab, an earlier visit): fine if it's this endorsement.
    try {
      const u = new URL('/xrpc/com.atproto.repo.getRecord', s.pds);
      u.searchParams.set('repo', s.did);
      u.searchParams.set('collection', ENDORSE_NSID);
      u.searchParams.set('rkey', id);
      const res = await safeFetch(u.href, { fetchImpl, maxBytes: 16384 });
      if (res.status === 200 && endorses(JSON.parse(res.text)?.value, subject)) return { ok: true, already: true };
    } catch {
      // fall through
    }
    throw new EndorseError('write_failed');
  }

  /** Delete this account's endorsements of one request: the record under its id, then any other tool's. */
  async function withdraw(id) {
    const subject = subjectOf(id);
    const s = await liveSession();
    const out = await pdsPost(s, 'com.atproto.repo.deleteRecord', { repo: s.did, collection: ENDORSE_NSID, rkey: id });
    if (out.status !== 200) throw new EndorseError('write_failed');
    let removed = 1;
    for (const r of await listOwn(s)) {
      if (r.rkey === id || !endorses(r.value, subject)) continue;
      const d = await pdsPost(s, 'com.atproto.repo.deleteRecord', { repo: s.did, collection: ENDORSE_NSID, rkey: r.rkey });
      if (d.status !== 200) throw new EndorseError('write_failed');
      removed++;
    }
    return { ok: true, removed };
  }

  /** Delete every endorsement record in this account, in batches. -> { removed }. */
  async function removeAll() {
    const s = await liveSession();
    const all = await listOwn(s);
    for (let i = 0; i < all.length; i += BATCH) {
      const writes = all.slice(i, i + BATCH).map((r) => ({ $type: 'com.atproto.repo.applyWrites#delete', collection: ENDORSE_NSID, rkey: r.rkey }));
      const out = await pdsPost(s, 'com.atproto.repo.applyWrites', { repo: s.did, writes });
      if (out.status !== 200) throw new EndorseError('write_failed');
    }
    return { removed: all.length };
  }

  /** Which of these request ids the signed-in account has endorsed, read from its own PDS without a token. */
  async function endorsedIds(requestIds) {
    const s = await store.getSession();
    if (!s || !(s.expires > now())) return new Set();
    const wanted = new Map(requestIds.filter((id) => ENDORSE_ID_RE.test(id)).map((id) => [endorseSubject(origin, base, id), id]));
    const out = new Set();
    for (const r of await listOwn(s)) {
      const id = wanted.get(r.value?.subject?.uri);
      if (id && endorses(r.value, r.value.subject.uri)) out.add(id);
    }
    return out;
  }

  /** Revoke the token and forget the session. Never throws. */
  async function signOut() {
    const s = await store.getSession();
    await store.deleteSession();
    if (s) await revokeTokens({ revocationEndpoint: s.revocationEndpoint, token: { access_token: s.accessToken, refresh_token: s.refreshToken }, clientId: ids.clientId, key: s.key, nonce: s.asNonce, fetchImpl, now: now() });
  }

  return { signIn, finish, current, endorse, withdraw, removeAll, endorsedIds, signOut, clientId: ids.clientId, redirectUri: ids.redirectUri };
}

/** The Worker's resolver, for handles the browser can't resolve. -> { did }; throws EndorseError. */
export function workerResolver(base, fetchImpl = (...a) => fetch(...a)) {
  return async (account) => {
    let res;
    try {
      res = await fetchImpl(`${base}/api/bsky/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account }) });
    } catch {
      throw new EndorseError('handle_unresolved');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new EndorseError(body && MESSAGES[body.code] ? body.code : 'handle_unresolved');
    return { did: body?.did };
  };
}
