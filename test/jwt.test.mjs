// Access JWT verification: RS256 against the team JWKS (fake fetch), claims, caching and key rotation.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAccessJwt, clearJwksCache } from '../functions/_lib/jwt.js';
import { keyPair, sign, claimsFor, jwksFetch, TEAM, AUD } from './helpers/server.mjs';

let k1, k2, other, published, fetchStub;
const opts = (extra = {}) => ({ teamDomain: TEAM, aud: AUD, fetch: fetchStub, ...extra });

before(async () => {
  k1 = await keyPair('k1');
  k2 = await keyPair('k2');
  other = await keyPair('k1'); // same kid, different key: a forged signature
});
beforeEach(() => {
  clearJwksCache();
  published = [k1];
  fetchStub = jwksFetch(() => published);
});

test('accepts a valid token and returns its claims', async () => {
  const p = await verifyAccessJwt(await sign(k1, claimsFor('User@Example.com')), opts());
  assert.equal(p.email, 'User@Example.com');
});

test('accepts TEAM_DOMAIN given as a URL and a string aud claim', async () => {
  const t = await sign(k1, claimsFor('a@example.com', { aud: AUD }));
  assert.equal((await verifyAccessJwt(t, opts({ teamDomain: `https://${TEAM}/` }))).email, 'a@example.com');
});

test('rejects a wrong audience, an expired token, a future nbf and a foreign issuer', async () => {
  await assert.rejects(verifyAccessJwt(await sign(k1, claimsFor('a@example.com', { aud: ['other'] })), opts()), /audience/);
  const past = Math.floor(Date.now() / 1000) - 3600;
  await assert.rejects(verifyAccessJwt(await sign(k1, claimsFor('a@example.com', { exp: past })), opts()), /expired/);
  await assert.rejects(verifyAccessJwt(await sign(k1, claimsFor('a@example.com', { nbf: past + 7200 })), opts()), /not yet valid/);
  await assert.rejects(verifyAccessJwt(await sign(k1, claimsFor('a@example.com', { iss: 'https://evil.example.com' })), opts()), /issuer/);
  await assert.rejects(verifyAccessJwt(await sign(k1, { ...claimsFor('a@example.com'), exp: undefined }), opts()), /expired/);
});

test('rejects forged signatures, other algorithms and malformed tokens', async () => {
  await assert.rejects(verifyAccessJwt(await sign(other, claimsFor('a@example.com')), opts()), /bad signature/);
  const good = await sign(k1, claimsFor('a@example.com'));
  const [, payload, sig] = good.split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
  await assert.rejects(verifyAccessJwt(`${none}.${payload}.`, opts()), /alg/);
  const hs = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
  await assert.rejects(verifyAccessJwt(`${hs}.${payload}.${sig}`, opts()), /alg/);
  const tampered = Buffer.from(JSON.stringify(claimsFor('admin@example.com'))).toString('base64url');
  await assert.rejects(verifyAccessJwt(`${good.split('.')[0]}.${tampered}.${sig}`, opts()), /bad signature/);
  await assert.rejects(verifyAccessJwt('abc', opts()), /malformed/);
  await assert.rejects(verifyAccessJwt(good, opts({ aud: '' })), /not configured/);
});

test('caches the JWKS and refetches for an unknown kid (key rotation), rate-limited', async () => {
  const t1 = await sign(k1, claimsFor('a@example.com'));
  const now = Date.now();
  await verifyAccessJwt(t1, opts({ now }));
  await verifyAccessJwt(t1, opts({ now: now + 1000 }));
  assert.equal(fetchStub.calls, 1);

  published = [k1, k2];
  const t2 = await sign(k2, claimsFor('a@example.com'));
  await assert.rejects(verifyAccessJwt(t2, opts({ now: now + 2000 })), /unknown signing key/, 'within 30 s: no refetch');
  assert.equal(fetchStub.calls, 1);
  assert.equal((await verifyAccessJwt(t2, opts({ now: now + 31000 }))).email, 'a@example.com');
  assert.equal(fetchStub.calls, 2);
  await verifyAccessJwt(t1, opts({ now: now + 11 * 60 * 1000 }));
  assert.equal(fetchStub.calls, 3, 'cache expires after 10 minutes');
});

test('a JWKS fetch failure rejects the token', async () => {
  const t = await sign(k1, claimsFor('a@example.com'));
  await assert.rejects(verifyAccessJwt(t, opts({ fetch: async () => new Response('down', { status: 503 }) })), /JWKS fetch failed/);
});
