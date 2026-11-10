#!/usr/bin/env node
// Rollout probe for Bluesky endorsing (docs/bluesky-endorsements.md,
// "Rollout", steps 2 and 3). Checks the browser client's metadata at its
// client_id URL, resolves a real account the way the browser does, checks
// its PDS and authorization server, and sends one PAR with the production
// client_id and the narrow repo scope, then prints what the AS said. It
// never opens a browser, never gets a code and never gets tokens; the
// pending request expires on its own in minutes. Whether the server actually
// GRANTS the repo scope shows only in a real sign-in's token response: that
// is step 3's browser check (the page refuses a token without it).
//
// Step 1's check comes first: it reports any listed request still on a
// legacy id.
//
//   node scripts/bsky-probe.js --account alice.bsky.social
//   node scripts/bsky-probe.js --account did:plc:... --origin https://example.org --base /siren
//     (the defaults are Siren's: https://ask-siren.jason-edelman.org, no base)
//
// Run it after the client metadata is live (PUBLIC_ORIGIN deployed, flag off)
// and before setting BLUESKY_LOGIN. Expect PAR 201. If the AS rejects the
// metadata (for example grant_types without refresh_token), its error code
// is printed here: this is the operator's own terminal, so remote text is shown.

import { parseAccountInput, resolveAccount, plcCreatedDay, safeFetch } from '../worker/atproto-identity.js';
import { clientIds, authServerFor, authServerMetadata, pkce, newDpopKey, dpopPost, SCOPE } from '../worker/atproto-oauth.js';
import { randomToken } from '../worker/crypto.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

async function main() {
  const input = parseAccountInput(opt('account', ''));
  if (!input) throw new Error('Give --account <handle or did>, for example --account alice.bsky.social');
  const env = { PUBLIC_ORIGIN: opt('origin', 'https://ask-siren.jason-edelman.org') };
  const base = opt('base', '');
  const ids = clientIds(env, base);
  if (!ids) throw new Error('--origin must be https://host (no port, no path) or http://127.0.0.1:<port>, and --base empty or a path like /siren.');
  const opts = { fetchImpl: fetch, dohUrl: opt('doh', 'https://cloudflare-dns.com/dns-query'), plcUrl: opt('plc', 'https://plc.directory'), signal: AbortSignal.timeout(20000) };

  console.log(`client_id     ${ids.clientId}`);
  if (!ids.loopback) {
    const meta = await safeFetch(ids.clientId, { fetchImpl: fetch });
    console.log(`metadata      ${meta.status} ${meta.headers.get('Content-Type') || ''}`);
    if (meta.status !== 200) throw new Error('The client metadata must answer 200 at the client_id URL (no redirect). Deploy with PUBLIC_ORIGIN set first.');
    const doc = JSON.parse(meta.text);
    if (doc.client_id !== ids.clientId) throw new Error(`The metadata's client_id is ${doc.client_id}, not the URL it was served from.`);
    if (doc.scope !== SCOPE) throw new Error(`The metadata declares scope "${doc.scope}", not "${SCOPE}".`);
    console.log(`scope         ${doc.scope}`);
  }
  if (!ids.loopback) {
    // Endorsements point at random request ids: none of the listed requests
    // should still carry a legacy hex id (run `invites.js request-ids --apply`).
    const feed = await safeFetch(`${env.PUBLIC_ORIGIN}${base}/api/requests`, { fetchImpl: fetch, maxBytes: 4 * 1024 * 1024 });
    let legacy = '?';
    try {
      legacy = String((JSON.parse(feed.text).requests || []).filter((r) => /^[0-9a-f]{12}$/.test(String(r.id))).length);
    } catch {
      legacy = '? (the list could not be read)';
    }
    console.log(`legacy ids    ${legacy}${legacy === '0' ? '' : ' on the public list: run `node scripts/invites.js request-ids --apply` before the flag'}`);
  }
  const account = await resolveAccount(input, opts);
  console.log(`did           ${account.did}`);
  console.log(`handle        ${account.handle || '(none verified)'}`);
  console.log(`pds           ${account.pds}`);
  console.log(`created       ${(await plcCreatedDay(account.did, opts)) || '(unknown)'}`);
  const issuer = await authServerFor(account.pds, opts);
  console.log(`issuer        ${issuer}`);
  const meta = await authServerMetadata(issuer, opts);
  console.log(`revocation    ${meta.revocation_endpoint || '(none on the issuer origin: no revoke)'}`);
  const { challenge } = await pkce();
  const key = await newDpopKey();
  const out = await dpopPost(meta.pushed_authorization_request_endpoint, {
    form: {
      client_id: ids.clientId, response_type: 'code', response_mode: 'fragment', redirect_uri: ids.redirectUri, scope: SCOPE,
      state: randomToken(32), code_challenge: challenge, code_challenge_method: 'S256',
      login_hint: input.kind === 'did' ? input.did : input.handle,
    },
    key, fetchImpl: fetch,
  });
  console.log(`PAR           ${out.status}${out.json?.expires_in ? `, expires_in ${out.json.expires_in}` : ''}${out.responseNonce ? ', DPoP-Nonce present' : ', NO DPoP-Nonce'}`);
  console.log(`fragment      ${(await authServerMetadataModes(meta, issuer, opts)) ? 'response_mode=fragment listed' : 'response_modes_supported does not list fragment: check before rollout'}`);
  if (out.status !== 201 && out.status !== 200) {
    console.log(`AS error      ${out.json?.error || '?'}: ${String(out.json?.error_description || '').slice(0, 300)}`);
    process.exitCode = 1;
  }
}

// Whether the AS lists the fragment response mode (bsky.social does, 2026-11-09).
async function authServerMetadataModes(meta, issuer, opts) {
  const res = await safeFetch(`${issuer}/.well-known/oauth-authorization-server`, { fetchImpl: opts.fetchImpl, maxBytes: 65536 });
  try {
    const m = JSON.parse(res.text);
    return Array.isArray(m.response_modes_supported) && m.response_modes_supported.includes('fragment');
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(err.code ? `Failed: ${err.code}` : err.message);
  process.exit(1);
});
