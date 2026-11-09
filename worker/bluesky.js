// Bluesky endorsements, the Worker's side (docs/bluesky-endorsements.md).
// An endorsement is a record in the endorser's own atproto repository,
// written and deleted from the browser (endorse-client.js), which is the
// OAuth client; the Worker never sees a token, sets no Bluesky cookie and
// stores nothing about endorsers. What it serves: the public list with
// counts (public-list.js, through Constellation), the endorser list per
// request, the browser client's metadata, and a fallback for resolving
// handles a browser can't. The route handlers live here, not in index.js,
// so tests can drive them: index.js imports .html and JSON, which Node can't
// load.

import { publicOrigin } from './atproto-oauth.js';

const RL_BINDINGS = ['BSKY_VISITOR_RL', 'BSKY_INPUT_RL', 'BSKY_SITE_RL'];

/** The flag, request storage, the salt for visitor keys, the three limiters and a valid origin. */
export function blueskyReady(env) {
  return env?.BLUESKY_LOGIN === 'true'
    && Boolean(env.LIMITS && env.IP_SALT)
    && RL_BINDINGS.every((b) => env[b] && typeof env[b].limit === 'function')
    && Boolean(publicOrigin(env));
}

/**
 * With BLUESKY_LOGIN "true" but something missing, what's missing, by name
 * (bindings and secret names only, never values), for the log; else null.
 */
export function blueskySetupError(env) {
  if (env?.BLUESKY_LOGIN !== 'true' || blueskyReady(env)) return null;
  const missing = [
    ...['LIMITS', 'IP_SALT'].filter((k) => !env[k]),
    ...RL_BINDINGS.filter((b) => !(env[b] && typeof env[b].limit === 'function')),
    ...(publicOrigin(env) ? [] : ['PUBLIC_ORIGIN (a valid origin)']),
  ];
  return `BLUESKY_LOGIN is "true" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing, so Bluesky endorsements are off (docs/bluesky-endorsements.md).`;
}
