// Cloudflare Access identity. When ACCESS_TEAM_DOMAIN and ACCESS_AUD are set,
// every request must carry a valid Access JWT, and limits are counted per
// person (by email) instead of per IP. The plain Cf-Access-Authenticated-User-Email
// header is never trusted on its own: anyone can send it if Access isn't in
// front, so the signed token is verified against the team's public keys.

const CERT_TTL_MS = 60 * 60 * 1000;
let certCache = { team: null, at: 0, keys: [] };

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

async function teamKeys(team, fetchImpl) {
  if (certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys = [] } = await res.json();
  certCache = { team, at: Date.now(), keys };
  return keys;
}

export function resetAccessCache() {
  certCache = { team: null, at: 0, keys: [] };
}

/** Returns { email } for a valid token, or throws with the reason. */
export async function verifyAccess(req, env, fetchImpl = fetch) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Error('missing Access token');
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) throw new Error('malformed token');
  const header = json(h);
  const payload = json(p);
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  const jwk = (await teamKeys(team, fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expired');
  if (payload.iss !== `https://${team}`) throw new Error('wrong issuer');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('wrong audience');
  if (!payload.email) throw new Error('token has no email');
  return { email: String(payload.email).toLowerCase() };
}
