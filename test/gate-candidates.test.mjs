// Regression: the gate authorises every file the Pages asset server could serve for a /docs URL, not just one guess.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serve, keyPair, sign, claimsFor, jwksFetch, resetCaches } from './helpers/server.mjs';
import { makeEnv, vaultFixture, catalog as catalogFixture } from './fixtures.mjs';
import { servedCandidates } from '../functions/_lib/gate.js';

let key, deps;
before(async () => { key = await keyPair('k1'); deps = { fetch: jwksFetch(() => [key]) }; await vaultFixture(); });
beforeEach(() => resetCaches());
const tokens = new Map();
async function call(env, email, path) {
  if (!tokens.has(email)) tokens.set(email, await sign(key, claimsFor(email)));
  const res = await serve(env, path, { token: tokens.get(email), deps });
  return { status: res.status, body: await res.text() };
}
const doc = (id, path, extra = {}) => ({ id, path, project: 'alpha', subproject: '', title: path, status: '待處理', tags: [], sensitivity: '內部', ...extra });

test('servedCandidates mirrors the Pages lookup order', () => {
  assert.deepEqual(servedCandidates('/docs/p/guide/'), ['docs/p/guide/index.html']);
  assert.deepEqual(servedCandidates('/docs/p/guide'), ['docs/p/guide', 'docs/p/guide.html']);
  assert.deepEqual(servedCandidates('/docs/p/a.md'), ['docs/p/a.md', 'docs/p/a.md.html']);
  assert.deepEqual(servedCandidates('/docs/p/x/index'), ['docs/p/x/index']);
});

test('a 機密 x/index.html is not readable by a viewer through /x/ when an internal x.html sits beside it', async () => {
  const c = catalogFixture();
  c.docs.push(doc(10, 'docs/alpha/guide.html'), doc(11, 'docs/alpha/guide/index.html', { sensitivity: '機密' }));
  const env = await makeEnv({}, { '/catalog.json': c, '/docs/alpha/guide.html': 'INTERNAL', '/docs/alpha/guide/index.html': 'CONFIDENTIAL BODY' });
  assert.equal((await call(env, 'viewer@example.com', '/docs/alpha/guide/index.html')).status, 403);
  const r = await call(env, 'viewer@example.com', '/docs/alpha/guide/');
  assert.equal(r.status, 403);
  assert.notEqual(r.body, 'CONFIDENTIAL BODY');
  const pretty = await call(env, 'viewer@example.com', '/docs/alpha/guide');
  assert.deepEqual([pretty.status, pretty.body], [200, 'INTERNAL'], 'the internal sibling stays readable');
  const ed = await call(env, 'editor@example.com', '/docs/alpha/guide/');
  assert.deepEqual([ed.status, ed.body], [200, 'CONFIDENTIAL BODY']);
});

test('an unknown extensionless file beside doc x.html stays owner-only at /x', async () => {
  const c = catalogFixture();
  c.docs.push(doc(10, 'docs/alpha/data.html'));
  const env = await makeEnv({}, { '/catalog.json': c, '/docs/alpha/data.html': 'doc', '/docs/alpha/data': 'RAW NON-DOC FILE' });
  const r = await call(env, 'viewer@example.com', '/docs/alpha/data');
  assert.equal(r.status, 403);
  assert.notEqual(r.body, 'RAW NON-DOC FILE');
  assert.equal((await call(env, 'viewer@example.com', '/docs/alpha/data.html')).body, 'doc', 'the doc itself is still served by its full name');
  assert.deepEqual(Object.values(await call(env, 'owner@example.com', '/docs/alpha/data')), [200, 'RAW NON-DOC FILE']);
});

test('without a shadowing file the pretty URL of doc x.html serves the doc', async () => {
  const c = catalogFixture();
  c.docs.push(doc(10, 'docs/alpha/data.html'));
  const env = await makeEnv({}, { '/catalog.json': c, '/docs/alpha/data.html': 'doc' });
  assert.deepEqual(Object.values(await call(env, 'viewer@example.com', '/docs/alpha/data')), [200, 'doc']);
  assert.equal((await call(env, 'viewer@example.com', '/docs/alpha/data.html')).status, 308);
});

test('a hidden-project doc at x/index.html is not readable through /x/ beside a visible x.html', async () => {
  const c = catalogFixture();
  c.docs.push(doc(10, 'docs/alpha/beta.html'), doc(11, 'docs/alpha/beta/index.html', { project: 'beta' }));
  const env = await makeEnv({}, { '/catalog.json': c, '/docs/alpha/beta.html': 'A', '/docs/alpha/beta/index.html': 'B' });
  assert.equal((await call(env, 'viewer@example.com', '/docs/alpha/beta/')).status, 403);
});

test('an unknown x.md.html beside an offline (極機密, not deployed) doc x.md is owner-only at /x.md', async () => {
  const c = catalogFixture();
  c.docs.push(doc(10, 'docs/alpha/keys.md', { sensitivity: '極機密', offline: true }));
  const env = await makeEnv({}, { '/catalog.json': c, '/docs/alpha/keys.md.html': 'UNKNOWN FILE' });
  for (const who of ['viewer@example.com', 'editor@example.com', 'manager@example.com']) {
    const r = await call(env, who, '/docs/alpha/keys.md');
    assert.equal(r.status, 403, who);
    assert.notEqual(r.body, 'UNKNOWN FILE');
  }
  assert.equal((await call(env, 'owner@example.com', '/docs/alpha/keys.md')).body, 'UNKNOWN FILE', 'owners see unknown files');
});
