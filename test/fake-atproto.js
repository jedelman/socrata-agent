// A fake atproto network, KV, rate limiter and cache for the Bluesky tests.
// Nothing here touches the real network: every call goes through the
// `fetch` this returns, which routes by host and path.

import { b64url, sha256, enc } from '../worker/crypto.js';
import { ENDORSE_SOURCE, OAUTH_SCOPE } from '../worker/endorse-config.js';

export const W = {
  DID: 'did:plc:abcdefghijklmnopqrstuvwx',
  DID2: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
  HANDLE: 'alice.fixture.dev',
  PDS: 'https://pds.fixture.dev',
  ISSUER: 'https://auth.fixture.dev',
  DOH: 'https://dns.fixture.dev/dns-query',
  PLC: 'https://plc.fixture.dev',
  CREATED: '2025-01-02T03:04:05.000Z',
  ACCESS: 'at-secret-AAAA1111',
  REFRESH: 'rt-secret-BBBB2222',
  CODE: 'code-secret-CCCC3333',
  CONSTELLATION: 'https://constellation.fixture.dev',
  APPVIEW: 'https://appview.fixture.dev',
};

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export function didDoc({ did = W.DID, handle = W.HANDLE, pds = W.PDS } = {}) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    alsoKnownAs: handle ? [`at://${handle}`] : [],
    service: pds ? [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }] : [],
  };
}

export function asMeta(issuer = W.ISSUER, extra = {}) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    pushed_authorization_request_endpoint: `${issuer}/oauth/par`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    scopes_supported: ['atproto', 'transition:generic'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    require_pushed_authorization_requests: true,
    dpop_signing_alg_values_supported: ['ES256'],
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    ...extra,
  };
}

const decodePart = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0))));

export function decodeJwt(jwt) {
  const [h, p, s] = jwt.split('.');
  return { header: decodePart(h), payload: decodePart(p), signingInput: `${h}.${p}`, signature: s };
}

export async function thumbprint(jwk) {
  return b64url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

/** A response that never answers, but rejects when the request is aborted. */
export function hang(signal) {
  return new Promise((_, reject) => {
    const fail = () => reject(signal.reason || new DOMException('aborted', 'AbortError'));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
}

/**
 * fakeNetwork(overrides) -> { fetch, calls, proofs, state }. Routes are keyed
 * by `host/path` (no query); an override replaces a route, and null removes
 * it (a 404). A handler gets (url: URL, init, net) and returns a Response.
 */
export function fakeNetwork(overrides = {}) {
  // backlinks: subject URL -> DIDs, newest first (Constellation's order).
  // profiles: DID -> an AppView profile. repos: DID -> Map(collection -> Map(rkey -> value)).
  const state = { par: [], tokens: [], revokes: [], issued: 0, codesUsed: new Set(), backlinks: new Map(), profiles: new Map(), repos: new Map(), didDocs: new Map(), constellationDown: false };
  const host = (u) => new URL(u).host;
  const routes = {
    [`${host(W.DOH)}/dns-query`]: (u) => {
      const name = u.searchParams.get('name');
      if (name === `_atproto.${W.HANDLE}`) return json({ Status: 0, Answer: [{ name, type: 16, data: `"did=${W.DID}"` }] });
      return json({ Status: 3 });
    },
    [`${W.HANDLE}/.well-known/atproto-did`]: () => new Response(`${W.DID}\n`, { headers: { 'Content-Type': 'text/plain' } }),
    [`${host(W.PLC)}/${W.DID}`]: () => json(didDoc()),
    [`${host(W.PLC)}/${W.DID}/log/audit`]: () => json([{ did: W.DID, createdAt: W.CREATED }, { did: W.DID, createdAt: '2026-01-01T00:00:00.000Z' }]),
    [`${host(W.PDS)}/.well-known/oauth-protected-resource`]: () => json({ resource: W.PDS, authorization_servers: [W.ISSUER] }),
    [`${host(W.ISSUER)}/.well-known/oauth-authorization-server`]: () => json(asMeta()),
    [`${host(W.ISSUER)}/oauth/par`]: async (u, init, net) => {
      const proof = decodeJwt(init.headers.DPoP);
      if (!proof.payload.nonce) return json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'nonce-par-1' });
      const form = Object.fromEntries(new URLSearchParams(init.body));
      state.par.push({ form, jkt: await thumbprint(proof.header.jwk), nonce: proof.payload.nonce });
      return json({ request_uri: `urn:ietf:params:oauth:request_uri:req-${state.par.length}`, expires_in: 299 }, 201, { 'DPoP-Nonce': 'nonce-par-2' });
    },
    [`${host(W.ISSUER)}/oauth/token`]: async (u, init, net) => {
      const proof = decodeJwt(init.headers.DPoP);
      if (!proof.payload.nonce) return json({ error: 'use_dpop_nonce' }, 400, { 'DPoP-Nonce': 'nonce-tok-1' });
      const form = Object.fromEntries(new URLSearchParams(init.body));
      state.tokens.push({ form, jkt: await thumbprint(proof.header.jwk), nonce: proof.payload.nonce });
      // OAuth 2.1: a code works once.
      if (state.codesUsed.has(form.code)) return json({ error: 'invalid_grant' }, 400, { 'DPoP-Nonce': 'nonce-tok-2' });
      state.codesUsed.add(form.code);
      state.issued++;
      return json({ access_token: W.ACCESS, token_type: 'DPoP', scope: state.grantedScope ?? OAUTH_SCOPE, sub: W.DID, expires_in: 300 }, 200, { 'DPoP-Nonce': 'nonce-tok-2' });
    },
    [`${host(W.ISSUER)}/oauth/revoke`]: async (u, init) => {
      const proof = decodeJwt(init.headers.DPoP);
      state.revokes.push({ form: Object.fromEntries(new URLSearchParams(init.body)), nonce: proof.payload.nonce || null });
      return new Response('', { status: 200, headers: { 'DPoP-Nonce': `nonce-rev-${state.revokes.length}` } });
    },
    [`${host(W.CONSTELLATION)}/xrpc/blue.microcosm.links.getBacklinkDids`]: (u) => {
      if (state.constellationDown) return new Response('down', { status: 503 });
      if (u.searchParams.get('source') !== ENDORSE_SOURCE) return json({ total: 0, linking_dids: [], cursor: null });
      const all = state.backlinks.get(u.searchParams.get('subject')) || [];
      const limit = Math.min(Number(u.searchParams.get('limit') || 16), 100);
      const start = Number(u.searchParams.get('cursor') || 0);
      const page = all.slice(start, start + limit);
      return json({ total: all.length, linking_dids: page, cursor: start + limit < all.length ? String(start + limit) : null });
    },
    [`${host(W.APPVIEW)}/xrpc/app.bsky.actor.getProfiles`]: (u) => {
      const actors = u.searchParams.getAll('actors');
      if (actors.length > 25) return json({ error: 'InvalidRequest', message: 'array too big (maximum 25, got 26)' }, 400);
      return json({ profiles: actors.map((a) => state.profiles.get(a)).filter(Boolean) });
    },
    [`${host(W.PDS)}/xrpc/com.atproto.repo.getRecord`]: (u) => {
      const rec = state.repos.get(u.searchParams.get('repo'))?.get(u.searchParams.get('collection'))?.get(u.searchParams.get('rkey'));
      if (!rec) return json({ error: 'RecordNotFound', message: 'Could not locate record' }, 400);
      return json({ uri: `at://${u.searchParams.get('repo')}/${u.searchParams.get('collection')}/${u.searchParams.get('rkey')}`, cid: 'bafyfake', value: rec });
    },
    [`${host(W.PDS)}/xrpc/com.atproto.repo.listRecords`]: (u) => {
      const coll = state.repos.get(u.searchParams.get('repo'))?.get(u.searchParams.get('collection')) || new Map();
      const all = [...coll.entries()];
      const limit = Math.min(Number(u.searchParams.get('limit') || 50), 100);
      const start = Number(u.searchParams.get('cursor') || 0);
      const page = all.slice(start, start + limit);
      return json({ records: page.map(([rkey, value]) => ({ uri: `at://${u.searchParams.get('repo')}/${u.searchParams.get('collection')}/${rkey}`, cid: 'bafyfake', value })), ...(start + limit < all.length ? { cursor: String(start + limit) } : {}) });
    },
    // Authenticated writes, as the reference PDS takes them: DPoP-bound token,
    // a proof with ath, its own nonce (separate from the AS's).
    ...Object.fromEntries(['createRecord', 'deleteRecord', 'applyWrites'].map((m) => [`${host(W.PDS)}/xrpc/com.atproto.repo.${m}`, async (u, init) => {
      const proof = decodeJwt(init.headers.DPoP);
      state.pdsWrites = state.pdsWrites || [];
      if (init.headers.Authorization !== `DPoP ${state.liveToken ?? W.ACCESS}`) return json({ error: 'InvalidToken' }, 401);
      if (proof.payload.ath !== b64url(await sha256(init.headers.Authorization.slice(5)))) return json({ error: 'InvalidDPoPProof' }, 401);
      if (proof.payload.htu !== `${W.PDS}/xrpc/com.atproto.repo.${m}`) return json({ error: 'InvalidDPoPProof' }, 401);
      if (proof.payload.nonce !== 'nonce-pds-1') return new Response(JSON.stringify({ error: 'use_dpop_nonce' }), { status: 401, headers: { 'Content-Type': 'application/json', 'DPoP-Nonce': 'nonce-pds-1', 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' } });
      const body = JSON.parse(init.body);
      state.pdsWrites.push({ method: m, body, nonce: proof.payload.nonce });
      if (body.repo !== W.DID) return json({ error: 'InvalidRequest' }, 400);
      const coll = () => {
        if (!state.repos.has(W.DID)) state.repos.set(W.DID, new Map());
        const r = state.repos.get(W.DID);
        return (c) => {
          if (!r.has(c)) r.set(c, new Map());
          return r.get(c);
        };
      };
      if (m === 'createRecord') {
        const c = coll()(body.collection);
        if ('validate' in body) return json({ error: 'InvalidRequest', message: 'validate must not be sent' }, 400);
        if (c.has(body.rkey)) return json({ error: 'InvalidRequest', message: 'Record already exists' }, 400);
        state.putRecord(W.DID, body.collection, body.rkey, body.record);
        return json({ uri: `at://${W.DID}/${body.collection}/${body.rkey}`, cid: 'bafyfake' });
      }
      if (m === 'deleteRecord') {
        coll()(body.collection).delete(body.rkey);
        return json({});
      }
      if (body.writes.length > 200) return json({ error: 'InvalidRequest' }, 400);
      for (const w of body.writes) coll()(w.collection).delete(w.rkey);
      return json({});
    }])),
    ...overrides,
  };
  /** Put a record in a fake repo (and, by default, in Constellation's index). */
  state.putRecord = (did, collection, rkey, value, { index = true } = {}) => {
    if (!state.repos.has(did)) state.repos.set(did, new Map());
    const repo = state.repos.get(did);
    if (!repo.has(collection)) repo.set(collection, new Map());
    repo.get(collection).set(rkey, value);
    if (index && value?.subject?.uri) {
      const list = state.backlinks.get(value.subject.uri) || [];
      if (!list.includes(did)) state.backlinks.set(value.subject.uri, [did, ...list]);
    }
  };
  const calls = [];
  const proofs = [];
  const net = { calls, proofs, state, routes };
  net.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u.href, method: init.method || 'GET', headers: init.headers || {}, body: init.body, signal: init.signal, cache: init.cache, redirect: init.redirect });
    if (init.headers?.DPoP) proofs.push({ url: u.href, ...decodeJwt(init.headers.DPoP), raw: init.headers.DPoP });
    if (init.signal?.aborted) throw init.signal.reason || new DOMException('aborted', 'AbortError');
    const handler = routes[`${u.host}${u.pathname}`];
    if (!handler) {
      // Any other did:plc whose document a test registered in state.didDocs.
      if (u.host === host(W.PLC) && state.didDocs?.has(u.pathname.slice(1))) return json(state.didDocs.get(u.pathname.slice(1)));
      return new Response('not found', { status: 404 });
    }
    return handler(u, init, net);
  };
  return net;
}

/** KV with metadata, absolute expirations, bulk get, pagination and an op log. */
export function fakeKV({ pageSize = 1000 } = {}) {
  const store = new Map();
  const ops = [];
  const kv = {
    store,
    ops,
    failPut: false,
    failGet: false,
    async get(key, type) {
      if (Array.isArray(key)) {
        ops.push({ op: 'get', keys: key.slice() });
        if (key.length > 100) throw new Error('bulk get takes at most 100 keys');
        return new Map(key.map((k) => [k, store.has(k) ? (type === 'json' ? JSON.parse(store.get(k).value) : store.get(k).value) : null]));
      }
      ops.push({ op: 'get', key });
      if (kv.failGet) throw new Error('KV GET failed: 503');
      if (!store.has(key)) return null;
      const v = store.get(key).value;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async getWithMetadata(key) {
      if (Array.isArray(key)) {
        ops.push({ op: 'getWithMetadata', keys: key.slice() });
        if (key.length > 100) throw new Error('bulk get takes at most 100 keys');
        return new Map(key.map((k) => [k, store.has(k) ? { value: store.get(k).value, metadata: store.get(k).metadata ?? null } : null]));
      }
      ops.push({ op: 'getWithMetadata', key });
      if (kv.failGet) throw new Error('KV GET failed: 503');
      if (!store.has(key)) return { value: null, metadata: null };
      const e = store.get(key);
      return { value: e.value, metadata: e.metadata ?? null };
    },
    async put(key, value, opts = {}) {
      ops.push({ op: 'put', key, opts });
      if (kv.failPut) throw new Error('KV put failed');
      store.set(key, { value: String(value), metadata: opts.metadata, expiration: opts.expiration, expirationTtl: opts.expirationTtl });
    },
    async delete(key) {
      ops.push({ op: 'delete', key });
      if (kv.failPut) throw new Error('KV delete failed');
      store.delete(key);
    },
    async list({ prefix = '', cursor, limit } = {}) {
      ops.push({ op: 'list', prefix });
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const size = Math.min(limit || pageSize, pageSize);
      const page = names.slice(start, start + size);
      const done = start + size >= names.length;
      return {
        keys: page.map((name) => ({ name, ...(store.get(name).metadata !== undefined ? { metadata: store.get(name).metadata } : {}), ...(store.get(name).expiration ? { expiration: store.get(name).expiration } : {}) })),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + size) }),
      };
    },
  };
  return kv;
}

/** A Workers Rate Limiting binding: `n` per key. */
export function fakeLimiter(n = 1000, { throws = false } = {}) {
  const counts = new Map();
  const calls = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      if (throws) throw new Error('rate limiter unavailable');
      const c = (counts.get(key) || 0) + 1;
      counts.set(key, c);
      return { success: c <= n };
    },
  };
}

export function fakeCache() {
  const store = new Map();
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  return {
    store,
    async match(req) {
      const r = store.get(keyOf(req));
      return r ? r.clone() : undefined;
    },
    async put(req, res) {
      store.set(keyOf(req), res.clone());
    },
    async delete(req) {
      return store.delete(keyOf(req));
    },
  };
}

export const SECRET = 'test-secret-that-is-long-enough';

/** An env with the feature on and every binding present. */
export function readyEnv(over = {}) {
  return {
    BLUESKY_LOGIN: 'true',
    PUBLIC_ORIGIN: 'https://jason-edelman.org',
    BASE_PATH: '/ask-siren',
    INVITE_SECRET: SECRET,
    IP_SALT: 'salt-for-tests',
    LIMITS: fakeKV(),
    BSKY_VISITOR_RL: fakeLimiter(),
    BSKY_INPUT_RL: fakeLimiter(),
    BSKY_SITE_RL: fakeLimiter(),
    DOH_URL: W.DOH,
    PLC_URL: W.PLC,
    CONSTELLATION_URL: W.CONSTELLATION,
    APPVIEW_URL: W.APPVIEW,
    ...over,
  };
}

export { enc };
