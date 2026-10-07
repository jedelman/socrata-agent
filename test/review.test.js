// Regression tests for the 2026-10-07 code review findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLimit, checkSingleDataset, Socrata } from '../src/socrata.js';
import { Trace } from '../src/trace.js';
import { Resources } from '../src/resources.js';
import { addressKey, lookupAddress } from '../src/block.js';
import { voiceViolations } from '../src/voice.js';
import { extractAddresses } from '../src/adapters/iqm2.js';
import { createContext } from '../src/agent.js';
import { definePlugin, pluginContext } from '../src/plugins.js';
import { getCity } from '../src/cities/index.js';
import { setting, visitorId, spentToday, recordSpend } from '../worker/limits.js';
import { verifyAccess, resetAccessCache } from '../worker/access.js';

test('a query can read only its own dataset', () => {
  assert.throws(() => checkSingleDataset('SELECT a LIMIT 1 UNION ALL SELECT b FROM @cab7-wvn5 LIMIT 1'), /only its own dataset/);
  assert.throws(() => checkSingleDataset('SELECT a FROM @abcd-1234'), /only its own dataset/);
  assert.throws(() => checkSingleDataset('select a join @abcd-1234 as x on true'), /only its own dataset/);
  // The words are fine inside string literals.
  assert.doesNotThrow(() => checkSingleDataset("SELECT a WHERE b like '%from the union%' AND c = 'x@abcd-1234'"));
});

test('excluded datasets stay excluded through a UNION', async () => {
  const s = new Socrata({ city: getCity('norfolk'), trace: new Trace(), resources: new Resources(), fetchImpl: async () => assert.fail('no request') });
  await assert.rejects(s.query('fahm-yuh4', 'SELECT x LIMIT 1 UNION ALL SELECT y FROM @cab7-wvn5'), /only its own dataset/);
});

test('clampLimit rewrites only the trailing LIMIT, never a literal', () => {
  assert.equal(clampLimit("SELECT a WHERE b != 'limit 1' LIMIT 3000"), "SELECT a WHERE b != 'limit 1' LIMIT 500");
  assert.equal(clampLimit("SELECT a WHERE b = 'limit 9000'"), "SELECT a WHERE b = 'limit 9000' LIMIT 100");
  assert.equal(clampLimit('SELECT a LIMIT 900 OFFSET 20'), 'SELECT a LIMIT 500 OFFSET 20');
});

test('street names made of a direction or suffix keep their name', () => {
  assert.equal(addressKey('100 West Ave').street, 'WEST');
  assert.equal(addressKey('100 East Street').street, 'EAST');
  assert.equal(addressKey('12 Circle Dr').street, 'CIRCLE');
  assert.equal(addressKey('5 W Crescent Rd').street, 'CRESCENT');
  assert.equal(addressKey('160 W. Virginia Beach Blvd').street, 'VIRGINIA BEACH');
  assert.notEqual(addressKey('100 West Ave').street, addressKey('100 East Street').street);
});

test('a near-miss address is offered as a candidate, never chosen', async () => {
  const fetchImpl = async (url) =>
    new Response(String(url).includes('/api/views/') ? '{"name":"Address Information"}' : JSON.stringify([{ full_address: '100 EAST STREET', house_number: '100', full_street_name: 'EAST STREET' }]));
  const ctx = createContext({ city: getCity('norfolk'), fetchImpl });
  const r = await lookupAddress(ctx, '100 West Ave');
  assert.equal(r.match, null);
  assert.deepEqual(r.candidates, ['100 EAST STREET']);
  assert.match(r.note, /no exact match/);
});

test('an inch mark does not hide a claim from the voice check', () => {
  assert.equal(voiceViolations('A 6" main broke. There are 3 open work orders. See "Work Orders" below.').length, 1);
  assert.deepEqual(voiceViolations('The ordinance says "there is hereby granted".'), []);
});

test('address extraction is fast on pathological titles and skips square footage', () => {
  const bad = `${Array.from({ length: 40 }, (_, i) => i + 1).join('   ')} !`;
  const t0 = Date.now();
  extractAddresses(bad);
  assert.ok(Date.now() - t0 < 200, 'should not backtrack');
  assert.deepEqual(extractAddresses('a Principal Structure Larger than 30,000 Square Feet at 7728 Hampton Boulevard'), ['7728 Hampton Boulevard']);
});

test("a plugin can't relabel an excluded dataset as harmless", async () => {
  const fetchImpl = async (url) => new Response(String(url).includes('/api/views/') ? '{"name":"Sex Offenders"}' : '[]');
  const ctx = createContext({ city: getCity('chicago'), fetchImpl });
  const p = definePlugin({ name: 'sneaky_label', description: 'x', run: (c) => c.socrata.query('vc9r-bqvy', 'SELECT *', { name: 'Benign Data' }) });
  await assert.rejects(p.run(pluginContext(ctx), {}), /excluded/);
});

test('numeric settings fall back instead of switching a limit off', () => {
  assert.equal(setting('2O', 2), 2);
  assert.equal(setting(undefined, 20), 20);
  assert.equal(setting('', 20), 20);
  assert.equal(setting('0', 2), 0);
  assert.equal(setting('-5', 2), 2);
  assert.equal(setting('abc', 6, { min: 1, max: 12 }), 6);
  assert.equal(setting('99', 6, { min: 1, max: 12 }), 12);
});

test('IPv6 visitors are counted per /64', () => {
  assert.equal(visitorId('2001:db8:1234:5678:aaaa::1'), visitorId('2001:db8:1234:5678:ffff:eeee:dddd:1'));
  assert.notEqual(visitorId('2001:db8:1234:5678::1'), visitorId('2001:db8:1234:5679::1'));
  assert.equal(visitorId('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(visitorId('203.0.113.7'), '203.0.113.7');
  assert.equal(visitorId(null), 'unknown');
});

test('spend is recorded per request and summed, so concurrent writes are not lost', async () => {
  const store = new Map();
  const kv = {
    async put(key, value, opts) {
      store.set(key, opts.metadata);
    },
    async list({ prefix }) {
      return { keys: [...store].filter(([k]) => k.startsWith(prefix)).map(([name, metadata]) => ({ name, metadata })), list_complete: true };
    },
  };
  await Promise.all([recordSpend(kv, '2026-10-07', 0.003), recordSpend(kv, '2026-10-07', 0.004), recordSpend(kv, '2026-10-06', 1)]);
  assert.equal(await spentToday(kv, '2026-10-07'), 0.007);
});

test('Access: a rotated key is re-fetched; a future nbf is refused', async () => {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = async (claims) => {
    const h = enc({ alg: 'RS256', kid: 'new' });
    const b = enc(claims);
    const s = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${b}`))).toString('base64url');
    return `${h}.${b}.${s}`;
  };
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'new' };
  const env = { ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', ACCESS_AUD: 'a' };
  const base = { email: 'v@example.org', aud: 'a', iss: 'https://t.cloudflareaccess.com', exp: Math.floor(Date.now() / 1000) + 600 };
  const req = (t) => new Request('https://x/', { headers: { 'Cf-Access-Jwt-Assertion': t } });

  // The cache holds only an old key, fetched over a minute ago; the token uses a new one.
  let calls = 0;
  const certs = async () => (++calls === 1 ? new Response('{"keys":[{"kid":"old"}]}') : new Response(JSON.stringify({ keys: [jwk] })));
  resetAccessCache();
  const realNow = Date.now;
  Date.now = () => realNow() - 120_000;
  await assert.rejects(verifyAccess(req(await sign(base)), env, certs)); // primes the cache with "old"
  Date.now = realNow;
  assert.deepEqual(await verifyAccess(req(await sign(base)), env, certs), { email: 'v@example.org' });
  assert.equal(calls, 2);
  await assert.rejects(verifyAccess(req(await sign({ ...base, nbf: Math.floor(Date.now() / 1000) + 3600 })), env, certs), /not yet valid/);
});
