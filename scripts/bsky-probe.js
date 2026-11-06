#!/usr/bin/env node
// Rollout probe for Bluesky sign-in (docs/bluesky-endorsements.md, step 3).
// Resolves a real account the way the Worker does, checks its PDS and
// authorization server, and sends one PAR with the production client_id, then
// prints what the AS said. It never opens a browser, never gets a code and
// never gets tokens; the pending request expires on its own in minutes.
//
//   node scripts/bsky-probe.js --account alice.bsky.social
//   node scripts/bsky-probe.js --account did:plc:... --origin https://jason-edelman.org --base /ask-siren
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
  const env = { PUBLIC_ORIGIN: opt('origin', 'https://jason-edelman.org') };
  const base = opt('base', '/ask-siren');
  const ids = clientIds(env, base);
  if (!ids) throw new Error('--origin must be https://host (no port, no path) or http://127.0.0.1:<port>, and --base a path like /ask-siren.');
  const opts = { fetchImpl: fetch, dohUrl: opt('doh', 'https://cloudflare-dns.com/dns-query'), plcUrl: opt('plc', 'https://plc.directory'), signal: AbortSignal.timeout(20000) };

  console.log(`client_id     ${ids.clientId}`);
  if (!ids.loopback) {
    const meta = await safeFetch(ids.clientId, { fetchImpl: fetch });
    console.log(`metadata      ${meta.status} ${meta.headers.get('Content-Type') || ''}`);
    if (meta.status !== 200) throw new Error('The client metadata must answer 200 at the client_id URL (no redirect). Deploy with PUBLIC_ORIGIN set first.');
    const doc = JSON.parse(meta.text);
    if (doc.client_id !== ids.clientId) throw new Error(`The metadata's client_id is ${doc.client_id}, not the URL it was served from.`);
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
  const { jwk } = await newDpopKey();
  const out = await dpopPost(meta.pushed_authorization_request_endpoint, {
    client_id: ids.clientId, response_type: 'code', redirect_uri: ids.redirectUri, scope: SCOPE,
    state: randomToken(32), code_challenge: challenge, code_challenge_method: 'S256',
    login_hint: input.kind === 'did' ? input.did : input.handle,
  }, { jwk, fetchImpl: fetch });
  console.log(`PAR           ${out.status}${out.json?.expires_in ? `, expires_in ${out.json.expires_in}` : ''}${out.nonce ? ', DPoP-Nonce present' : ', NO DPoP-Nonce'}`);
  if (out.status !== 201 && out.status !== 200) {
    console.log(`AS error      ${out.json?.error || '?'}: ${String(out.json?.error_description || '').slice(0, 300)}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.code ? `Failed: ${err.code}` : err.message);
  process.exit(1);
});
