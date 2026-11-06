// atproto identity: syntax, the hardened fetch, handle and DID resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHandle, isSupportedDid, parseAccountInput, safeUrl, safeFetch, resolveHandle, resolveDidDoc,
  docHandle, docPds, resolveAccount, plcCreatedDay, firstArrayObject,
} from '../worker/atproto-identity.js';
import { W, json, didDoc, fakeNetwork, hang } from './fake-atproto.js';

const opts = (net) => ({ fetchImpl: net.fetch, dohUrl: W.DOH, plcUrl: W.PLC });
const dns = (did) => () => json({ Answer: [{ type: 16, data: `"did=${did}"` }] });
const noDns = () => json({ Status: 3 });

test('normalizeHandle lowercases, strips one @, and refuses what can never resolve', () => {
  assert.equal(normalizeHandle('@Alice.BSKY.social'), 'alice.bsky.social');
  assert.equal(normalizeHandle('  bob.example.com '), 'bob.example.com');
  for (const bad of ['foo.local', 'x.onion', 'a.alt', '1.2.3.4', 'localhost', 'a..b', `${'a'.repeat(250)}.com`, 'nodot', 'x.example', '-a.com', 'a.com.', 'http://a.com', '@@a.com', null, 42]) {
    assert.equal(normalizeHandle(bad), null, String(bad));
  }
  assert.equal(`${'a'.repeat(250)}.com`.length, 254);
});

test('isSupportedDid takes did:plc and hostname-level did:web only', () => {
  assert.ok(isSupportedDid(W.DID));
  assert.ok(isSupportedDid('did:web:example.com'));
  for (const bad of ['did:plc:ABCDEFGHIJKLMNOPQRSTUVWX', 'did:plc:abcdefghijklmnopqrstuvw', 'did:web:host.com:path', 'did:web:localhost%3A8080', 'did:web:localhost', 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', `did:web:${'a.'.repeat(1100)}com`, 'did:plc:abcdefghijklmnopqrstuvwx ', 'did:web:x.onion']) {
    assert.equal(isSupportedDid(bad), false, bad.slice(0, 60));
  }
});

test('parseAccountInput sorts handles from DIDs', () => {
  assert.deepEqual(parseAccountInput(' @Alice.Fixture.Dev '), { kind: 'handle', handle: 'alice.fixture.dev' });
  assert.deepEqual(parseAccountInput(W.DID), { kind: 'did', did: W.DID });
  assert.deepEqual(parseAccountInput(`@${W.DID}`), { kind: 'did', did: W.DID });
  assert.equal(parseAccountInput('did:key:abc'), null);
  assert.equal(parseAccountInput('x'.repeat(261)), null);
  assert.equal(parseAccountInput(''), null);
});

test('safeUrl allows https on the default port to hostnames only', () => {
  assert.ok(safeUrl('https://pds.fixture.dev/x'));
  for (const bad of ['http://pds.fixture.dev', 'https://pds.fixture.dev:443/', 'https://pds.fixture.dev:8443/', 'https://u:p@pds.fixture.dev/', 'https://user@pds.fixture.dev/', 'https://1.2.3.4/', 'https://[::1]/', 'https://localhost/', 'https://pds.local/', 'https://x.internal/', 'ftp://a.com/']) {
    assert.equal(safeUrl(bad), null, bad);
  }
});

test('safeFetch refuses bad URLs before any request, and sends no-store and manual redirects', async () => {
  const net = fakeNetwork({ 'a.fixture.dev/ok': () => new Response('hi') });
  for (const bad of ['http://a.fixture.dev/ok', 'https://a.fixture.dev:443/ok', 'https://a.fixture.dev:8443/ok', 'https://u:p@a.fixture.dev/ok', 'https://127.0.0.1/ok']) {
    await assert.rejects(safeFetch(bad, { fetchImpl: net.fetch }), { code: 'bad_url' });
  }
  assert.equal(net.calls.length, 0);
  const out = await safeFetch('https://a.fixture.dev/ok', { fetchImpl: net.fetch });
  assert.equal(out.text, 'hi');
  assert.equal(net.calls[0].cache, 'no-store');
  assert.equal(net.calls[0].redirect, 'manual');
});

function trackedBody(text, size) {
  const state = { cancelled: false };
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    pull(c) {
      c.enqueue(bytes);
      if (size !== undefined) c.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

test('safeFetch caps bodies by Content-Length and while streaming, cancelling the rest', async () => {
  const big = trackedBody('x');
  const declared = fakeNetwork({ 'a.fixture.dev/big': () => new Response(big.body, { headers: { 'Content-Length': '99999' } }) });
  await assert.rejects(safeFetch('https://a.fixture.dev/big', { fetchImpl: declared.fetch, maxBytes: 100 }), { code: 'too_large' });
  assert.ok(big.state.cancelled, 'the declared-too-big body is cancelled');
  const endless = trackedBody('y'.repeat(64));
  const streamed = fakeNetwork({ 'a.fixture.dev/stream': () => new Response(endless.body) });
  await assert.rejects(safeFetch('https://a.fixture.dev/stream', { fetchImpl: streamed.fetch, maxBytes: 1000 }), { code: 'too_large' });
  assert.ok(endless.state.cancelled, 'an endless body is cancelled past the cap');
});

test('safeFetch cancels redirect bodies and follows only as many hops as allowed', async () => {
  const bodies = [];
  const hop = (to) => () => {
    const t = trackedBody('moved', 1);
    bodies.push(t.state);
    return new Response(t.body, { status: 302, headers: { Location: to } });
  };
  const net = fakeNetwork({ 'a.fixture.dev/0': hop('/1'), 'a.fixture.dev/1': hop('https://b.fixture.dev/2'), 'b.fixture.dev/2': hop('/3'), 'b.fixture.dev/3': () => new Response('end') });
  assert.equal((await safeFetch('https://a.fixture.dev/0', { fetchImpl: net.fetch, redirects: 3 })).text, 'end');
  assert.ok(bodies.every((b) => b.cancelled));
  await assert.rejects(safeFetch('https://a.fixture.dev/0', { fetchImpl: net.fetch, redirects: 2 }), { code: 'redirect' });
  await assert.rejects(safeFetch('https://a.fixture.dev/0', { fetchImpl: net.fetch }), { code: 'redirect' });
});

test('safeFetch aborts when the outer signal fires', async () => {
  const net = fakeNetwork({ 'a.fixture.dev/slow': (u, init) => hang(init.signal) });
  const ctl = new AbortController();
  const p = safeFetch('https://a.fixture.dev/slow', { fetchImpl: net.fetch, signal: ctl.signal, timeoutMs: 60000 });
  ctl.abort();
  await assert.rejects(p);
});

test('resolveHandle: DNS only, HTTPS only, both agreeing; DNS wins a conflict and stops HTTPS', async () => {
  const H = 'h.fixture.dev';
  const wk = (did) => () => new Response(` ${did}\n\t`);
  let net = fakeNetwork({ 'dns.fixture.dev/dns-query': dns(W.DID) });
  assert.equal(await resolveHandle(H, opts(net)), W.DID);
  net = fakeNetwork({ 'dns.fixture.dev/dns-query': noDns, [`${H}/.well-known/atproto-did`]: wk(W.DID) });
  assert.equal(await resolveHandle(H, opts(net)), W.DID, 'well-known whitespace is trimmed');
  net = fakeNetwork({ 'dns.fixture.dev/dns-query': dns(W.DID), [`${H}/.well-known/atproto-did`]: wk(W.DID) });
  assert.equal(await resolveHandle(H, opts(net)), W.DID);
  let httpsSignal;
  net = fakeNetwork({
    'dns.fixture.dev/dns-query': dns(W.DID),
    [`${H}/.well-known/atproto-did`]: (u, init) => {
      httpsSignal = init.signal;
      return hang(init.signal);
    },
  });
  assert.equal(await resolveHandle(H, opts(net)), W.DID);
  assert.ok(httpsSignal?.aborted, 'the HTTPS lookup is aborted once DNS answers');
  net = fakeNetwork({ 'dns.fixture.dev/dns-query': dns(W.DID), [`${H}/.well-known/atproto-did`]: wk(W.DID2) });
  assert.equal(await resolveHandle(H, opts(net)), W.DID, 'DNS wins');
});

test('resolveHandle: TXT records are filtered and must agree', async () => {
  const H = 'h.fixture.dev';
  let net = fakeNetwork({ 'dns.fixture.dev/dns-query': () => json({ Answer: [{ type: 16, data: `"did=${W.DID}"` }, { type: 16, data: `"did=${W.DID2}"` }] }) });
  await assert.rejects(resolveHandle(H, opts(net)), { code: 'handle_unresolved' });
  net = fakeNetwork({ 'dns.fixture.dev/dns-query': () => json({ Answer: [{ type: 16, data: '"v=spf1 -all"' }, { type: 5, data: 'x' }, { type: 16, data: `"did=did:plc:" "abcdefghijklmnopqrstuvwx"` }] }) });
  assert.equal(await resolveHandle(H, opts(net)), W.DID, 'non-did= records ignored, segments joined');
});

test('resolveHandle: the well-known follows three redirects, refuses a fourth, http: and IP literals', async () => {
  const H = 'h.fixture.dev';
  const redirect = (to) => () => new Response(null, { status: 301, headers: { Location: to } });
  const chain = {
    'dns.fixture.dev/dns-query': noDns,
    [`${H}/.well-known/atproto-did`]: redirect('/r1'),
    [`${H}/r1`]: redirect('/r2'),
    [`${H}/r2`]: redirect('/r3'),
    [`${H}/r3`]: () => new Response(W.DID),
  };
  assert.equal(await resolveHandle(H, opts(fakeNetwork(chain))), W.DID);
  const four = { ...chain, [`${H}/r3`]: redirect('/r4'), [`${H}/r4`]: () => new Response(W.DID) };
  await assert.rejects(resolveHandle(H, opts(fakeNetwork(four))), { code: 'handle_unresolved' });
  for (const to of ['http://h.fixture.dev/plain', 'https://10.0.0.1/x', 'https://h.fixture.dev:443/x']) {
    const net = fakeNetwork({ ...chain, [`${H}/.well-known/atproto-did`]: redirect(to), 'h.fixture.dev/plain': () => new Response(W.DID), '10.0.0.1/x': () => new Response(W.DID) });
    await assert.rejects(resolveHandle(H, opts(net)), { code: 'handle_unresolved' }, to);
    assert.ok(!net.calls.some((c) => c.url.startsWith('http://') || c.url.includes('10.0.0.1')), to);
  }
});

test('resolveDidDoc checks the id, fetches did:web from /.well-known/did.json, and refuses redirects', async () => {
  let net = fakeNetwork({ [`plc.fixture.dev/${W.DID}`]: () => json(didDoc({ did: W.DID2 })) });
  await assert.rejects(resolveDidDoc(W.DID, opts(net)), { code: 'did_unresolved' });
  net = fakeNetwork({ 'web.fixture.dev/.well-known/did.json': () => json(didDoc({ did: 'did:web:web.fixture.dev' })) });
  assert.equal((await resolveDidDoc('did:web:web.fixture.dev', opts(net))).id, 'did:web:web.fixture.dev');
  assert.equal(net.calls[0].url, 'https://web.fixture.dev/.well-known/did.json');
  net = fakeNetwork({ 'web.fixture.dev/.well-known/did.json': () => new Response(null, { status: 302, headers: { Location: '/elsewhere' } }), 'web.fixture.dev/elsewhere': () => json(didDoc({ did: 'did:web:web.fixture.dev' })) });
  await assert.rejects(resolveDidDoc('did:web:web.fixture.dev', opts(net)), { code: 'did_unresolved' });
});

test('the handle is checked in both directions', async () => {
  let net = fakeNetwork({ [`plc.fixture.dev/${W.DID}`]: () => json(didDoc({ handle: 'mallory.fixture.dev' })) });
  await assert.rejects(resolveAccount({ kind: 'handle', handle: W.HANDLE }, opts(net)), { code: 'handle_mismatch' });
  net = fakeNetwork();
  assert.deepEqual(await resolveAccount({ kind: 'handle', handle: W.HANDLE }, opts(net)), { did: W.DID, handle: W.HANDLE, pds: W.PDS });
  assert.deepEqual(await resolveAccount({ kind: 'did', did: W.DID }, opts(net)), { did: W.DID, handle: W.HANDLE, pds: W.PDS });
  net = fakeNetwork({ 'dns.fixture.dev/dns-query': dns(W.DID2), [`${W.HANDLE}/.well-known/atproto-did`]: () => new Response(W.DID2) });
  assert.deepEqual(await resolveAccount({ kind: 'did', did: W.DID }, opts(net)), { did: W.DID, handle: null, pds: W.PDS }, 'a bad back-resolution shows no handle');
  assert.equal(docHandle({ alsoKnownAs: ['https://x.com', 'at://bad..handle', 'at://First.Fixture.Dev', 'at://second.fixture.dev'] }), 'first.fixture.dev');
  assert.equal(docHandle({ alsoKnownAs: ['at://x.local'] }), null);
});

test('docPds takes the atproto_pds service with an https origin', () => {
  const doc = (service) => ({ id: W.DID, service });
  assert.equal(docPds(doc([{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.fixture.dev' }])), 'https://pds.fixture.dev');
  assert.equal(docPds(doc([{ id: `${W.DID}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.fixture.dev/' }])), 'https://pds.fixture.dev');
  assert.equal(docPds(doc([{ id: '#atproto_pds', type: 'Wrong', serviceEndpoint: 'https://a.fixture.dev' }, { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://b.fixture.dev' }])), 'https://b.fixture.dev');
  assert.equal(docPds(doc([{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'http://pds.fixture.dev' }])), null);
  assert.equal(docPds(doc([{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.fixture.dev/path' }])), null);
  assert.equal(docPds(doc([{ id: 'did:plc:other#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.fixture.dev' }])), null);
});

test('plcCreatedDay returns the genesis day, or empty on failure', async () => {
  assert.equal(await plcCreatedDay(W.DID, opts(fakeNetwork())), '2025-01-02');
  assert.equal(await plcCreatedDay(W.DID, opts(fakeNetwork({ [`plc.fixture.dev/${W.DID}/log/audit`]: null }))), '');
  assert.equal(await plcCreatedDay(W.DID, opts(fakeNetwork({ [`plc.fixture.dev/${W.DID}/log/audit`]: () => new Response('not json') }))), '');
  assert.equal(await plcCreatedDay('did:web:web.fixture.dev', opts(fakeNetwork())), '');
});

test('plcCreatedDay reads the genesis day from a long account\'s audit log too (over 128 KB)', async () => {
  // A years-old account with many handle changes and moves; a brace inside a string must not end the entry.
  const op = (i) => ({ did: W.DID, operation: { type: 'plc_operation', alsoKnownAs: [`at://h${i}.fixture.dev`], services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: 'https://pds.fixture.dev' } }, note: 'a } and a \\" here' }, cid: `cid${i}`, nullified: false, createdAt: i === 0 ? '2023-04-05T06:07:08.000Z' : '2026-01-01T00:00:00.000Z' });
  const log = JSON.stringify(Array.from({ length: 800 }, (_, i) => op(i)));
  assert.ok(log.length > 131072);
  const long = fakeNetwork({ [`plc.fixture.dev/${W.DID}/log/audit`]: () => new Response(log, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(log.length) } }) });
  assert.equal(await plcCreatedDay(W.DID, opts(long)), '2023-04-05');
  // A first entry cut off by the cap is no date, not an error.
  const cut = fakeNetwork({ [`plc.fixture.dev/${W.DID}/log/audit`]: () => new Response(`[{"did":"${W.DID}","note":"${'x'.repeat(40000)}","createdAt":"2023-04-05T06:07:08.000Z"}]`) });
  assert.equal(await plcCreatedDay(W.DID, opts(cut)), '');
  assert.equal(firstArrayObject('[{"a":"}"},{"b":1}]').a, '}');
  assert.equal(firstArrayObject('{"a":1}'), null);
});
