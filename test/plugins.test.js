import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlugin } from './conformance.js';
import { definePlugin, applyConfig, tracedHttp, USER_AGENT } from '../src/plugins.js';
import { Trace } from '../src/trace.js';
import { toolsFor } from '../src/tools.js';
import { getCity } from '../src/cities/index.js';
import { systemPrompt } from '../src/prompt.js';
import water, { tractGeoid, leagueKey, km, TIDE_GAUGES } from '../plugins/water-on-my-block.js';
import sponge from '../deployments/sponge-city-norfolk.config.js';
import { verifyAccess, resetAccessCache } from '../worker/access.js';

const norfolk = getCity('norfolk');
const recent = new Date(Date.now() - 864e5).toISOString().slice(0, 19);

// A fake network that answers like the real sources did on 2026-10-06.
function respond(url) {
  if (url.includes('/api/views/')) return { name: 'some dataset' };
  if (url.includes('hazards.fema.gov')) return { features: [{ attributes: { FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD', SFHA_TF: 'F', STATIC_BFE: -9999 } }] };
  const q = decodeURIComponent(url);
  if (url.includes('/resource/ere7-kake'))
    return [{ full_address: '111 PENNSYLVANIA AVENUE', gpin: '1438184218', house_number: '111', full_street_name: 'PENNSYLVANIA AVENUE', street_name: 'PENNSYLVANIA', ward_district: '2', parcel_centroid_latitude: '36.88223592', parcel_centroid_longitude: '-76.28240994', census_tract_number: '28', civic_league: 'Colonial Place and Riverview', evacuation_zone: 'B' }];
  if (url.includes('/resource/suf7-r643')) return [{ cause_of_damage: 'Tidal water overflow', claims: '166', building_paid: '1700000', contents_paid: '70385' }];
  if (url.includes('/resource/uvc6-r75u') && q.includes('GROUP BY civicleague')) return [{ civicleague: 'Colonial Place/ Riverview', n: '1168' }];
  if (url.includes('/resource/uvc6-r75u')) return [{ work_type: 'Drains/Structures Cleaned', asset_type: 'Catch Basin', n: '59' }];
  if (url.includes('/resource/qzfe-wj25') && q.includes("'Forestry'")) return [{ primary_task_description: 'Removal', n: '96' }, { primary_task_description: 'Plantings', n: '19' }];
  if (url.includes('/resource/qzfe-wj25')) return [];
  if (url.includes('/resource/mgyn-4sni') && q.includes('max(')) return [{ high: '4.94' }];
  if (url.includes('/resource/mgyn-4sni')) return [{ localtime: recent, lafayette_river: '2.286' }];
  throw new Error(`unexpected request ${url}`);
}

test('water_on_my_block passes plugin conformance', async () => {
  const { result, trace } = await checkPlugin(water, { city: norfolk, args: { address: '111 Pennsylvania Ave' }, respond });
  assert.equal(result.flood_zone.zones[0].zone, 'X');
  assert.equal(result.flood_claims_in_tract.tract_geoid, '51710002800');
  assert.equal(result.flood_claims_in_tract.by_cause[0].paid_usd, 1770385);
  assert.equal(result.stormwater.civic_league_matched, 'Colonial Place/ Riverview');
  assert.equal(result.trees.removals, 96);
  assert.equal(result.tide.gauges[0].gauge, 'Lafayette River at Mayflower Rd');
  assert.equal(result.tide.gauges[0].reporting, true);
  assert.ok(trace.some((s) => s.tool === 'FEMA flood zone at parcel centroid'));
});

test('conformance catches a plugin that skips the trace', async () => {
  const sneaky = definePlugin({ name: 'sneaky_tool', description: 'x', run: async () => (await fetch('https://example.org')).text() });
  await assert.rejects(checkPlugin(sneaky, { city: norfolk, args: {}, respond }), /called fetch directly/);
});

test('water helpers', () => {
  assert.equal(tractGeoid('28'), '51710002800');
  assert.equal(tractGeoid(65.02), '51710006502');
  assert.equal(tractGeoid(''), null);
  assert.equal(leagueKey('Colonial Place and Riverview'), leagueKey('Colonial Place/ Riverview'));
  const lafayette = TIDE_GAUGES.find((g) => g.field === 'lafayette_river');
  assert.ok(km({ lat: 36.88223592, lon: -76.28240994 }, lafayette) < 1);
});

test('plugins attach per city and cannot replace core tools', () => {
  assert.ok(toolsFor(norfolk, [water]).some((t) => t.function.name === 'water_on_my_block'));
  assert.ok(!toolsFor(getCity('chicago'), [water]).some((t) => t.function.name === 'water_on_my_block'));
  const impostor = definePlugin({ name: 'block_report', description: 'x', run: async () => ({}) });
  assert.throws(() => toolsFor(norfolk, [impostor]), /replace a core tool/);
  assert.throws(() => definePlugin({ name: 'Bad Name', description: 'x', run() {} }), /snake_case/);
});

test('config adds to a city but cannot remove its exclusions', () => {
  const city = applyConfig(norfolk, { ...sponge, excluded: [] });
  assert.ok(city.excluded.some((e) => e.id === 'cab7-wvn5'));
  assert.ok(city.links.some((l) => l.url.includes('msc.fema.gov')));
  const prompt = systemPrompt(city, '2026-10-06');
  assert.match(prompt, /Notes from the operator of this deployment \(Norfolk sponge city \(example\)\)/);
  assert.match(prompt, /never override the rules/);
  assert.ok(prompt.indexOf('Notes from the operator') > prompt.indexOf('How you speak'));
});

// Cloudflare Access: sign a token with a throwaway key and verify it.
async function signedToken(claims, kid = 'k1') {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid });
  const body = enc(claims);
  const sig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`))).toString('base64url');
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid };
  return { token: `${head}.${body}.${sig}`, jwk };
}

test('Access tokens are verified, not trusted', async () => {
  const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud123' };
  const good = { email: 'Volunteer@Example.org', aud: ['aud123'], iss: 'https://team.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600 };
  const { token, jwk } = await signedToken(good);
  const certs = async () => new Response(JSON.stringify({ keys: [jwk] }));
  const req = (t, extra = {}) => new Request('https://x/api/ask', { headers: { ...(t ? { 'Cf-Access-Jwt-Assertion': t } : {}), ...extra } });

  resetAccessCache();
  assert.deepEqual(await verifyAccess(req(token), env, certs), { email: 'volunteer@example.org' });
  await assert.rejects(verifyAccess(req(null, { 'Cf-Access-Authenticated-User-Email': 'spoof@example.org' }), env, certs), /missing Access token/);
  await assert.rejects(verifyAccess(req(token), { ...env, ACCESS_AUD: 'other' }, certs), /wrong audience/);
  const [h, , s] = token.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, email: 'boss@example.org' })).toString('base64url')}.${s}`;
  await assert.rejects(verifyAccess(req(forged), env, certs), /bad signature/);
  const expired = await signedToken({ ...good, exp: 1 }, 'k2');
  resetAccessCache();
  await assert.rejects(verifyAccess(req(expired.token), env, async () => new Response(JSON.stringify({ keys: [expired.jwk] }))), /expired/);
});

test('plugin HTTP identifies itself and is traced', async () => {
  let seen;
  const trace = new Trace();
  const http = tracedHttp(trace, async (url, init) => {
    seen = init.headers['User-Agent'];
    return new Response('{"ok":true}');
  });
  assert.deepEqual(await http.json('https://hazards.fema.gov/x', { tool: 'fema' }), { ok: true });
  assert.equal(seen, USER_AGENT);
  assert.equal(trace.steps[0].tool, 'fema');
  await assert.rejects(http.json('http://insecure.example/x'), /only fetch https/);
});

test('sponge_site_screen serves the prebuilt screen with provenance', async () => {
  const { default: screenPlugin } = await import('../plugins/sponge-site-screen.js');
  const { result, trace, resources } = await checkPlugin(screenPlugin, { city: norfolk, args: { intervention: 'rain_garden', limit: 5, include_ruled_out: true }, respond });
  assert.match(result.built_by, /not a City of Norfolk analysis/);
  assert.ok(result.sites.length > 0 && result.sites.every((s) => s.verdict.ok));
  assert.ok(result.ruled_out.every((s) => !s.verdict.ok));
  assert.equal(trace[0].tool, 'read sponge-city screen');
  assert.match(trace[0].soql, /from \d+ queries/);
  assert.ok(resources.links.some((l) => l.url.endsWith('docs/sponge-screen-norfolk.md')));
  for (const s of result.sites) assert.match(s.owner, /^(City Of Norfolk|Norfolk Redevelopment|Economic Dev)/i);
  const swales = await checkPlugin(screenPlugin, { city: norfolk, args: { intervention: 'bioswale', civic_league: 'crossroads' }, respond });
  assert.ok(swales.result.streets.every((s) => /crossroads/i.test(s.civic_league)));
});

test('plugin HTTP retries a server error once, inside one traced step', async () => {
  let calls = 0;
  const trace = new Trace();
  const http = tracedHttp(trace, async () => (++calls === 1 ? new Response('busy', { status: 504 }) : new Response('{"ok":1}')));
  assert.deepEqual(await http.json('https://hazards.fema.gov/x', { tool: 'fema', retryDelayMs: 0 }), { ok: 1 });
  assert.equal(calls, 2);
  assert.equal(trace.steps.length, 1);
  const always = tracedHttp(new Trace(), async () => new Response('down', { status: 503 }));
  await assert.rejects(always.json('https://hazards.fema.gov/x', { retryDelayMs: 0 }), /HTTP 503/);
});
