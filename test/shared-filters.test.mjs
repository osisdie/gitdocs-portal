// /api/filters: project-shared saved filters (authorisation, tenant isolation, validation, CSRF, audit).
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serve, keyPair, sign, claimsFor, jwksFetch, resetCaches } from './helpers/server.mjs';
import { makeEnv, vaultFixture, catalog as catalogFixture } from './fixtures.mjs';

let key, deps, env;
before(async () => {
  key = await keyPair('k1');
  deps = { fetch: jwksFetch(() => [key]) };
  await vaultFixture();
});
beforeEach(async () => { resetCaches(); env = await makeEnv(); });

const tokens = new Map();
async function call(email, path, opts = {}) {
  if (!tokens.has(email)) tokens.set(email, await sign(key, claimsFor(email)));
  const res = await serve(env, path, { ...opts, token: tokens.get(email), deps });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}
const rows = (sql, ...p) => env.DB.raw.prepare(sql).all(...p).map((r) => ({ ...r }));
const post = (email, body, headers) => call(email, '/api/filters', { method: 'POST', body, headers });
const seed = (project, name, params = `p=${project}&q=x`, by = 'owner@example.com') =>
  env.DB.raw.prepare('INSERT INTO shared_filters (project, name, params, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(project, name, params, by, '2026-11-01T00:00:00.000Z');

test('a manager shares a filter in their project; viewers of the project list it, by display name only', async () => {
  let r = await post('manager@example.com', { project: 'alpha', name: ' Open in sub ', params: 'q=s%3A%E5%BE%85%E8%99%95%E7%90%86&p=alpha%2Fsub&page=3' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.name, 'Open in sub');
  assert.equal(r.body.params, 'q=s%3A%E5%BE%85%E8%99%95%E7%90%86&p=alpha%2Fsub', 'page dropped');
  assert.equal(r.body.created_by_name, 'manager');
  assert.equal('created_by' in r.body, false, 'no email in responses');
  for (const email of ['viewer@example.com', 'editor@example.com', 'star@example.com']) {
    r = await call(email, '/api/filters?project=alpha');
    assert.equal(r.status, 200, email);
    assert.deepEqual(r.body.map((f) => [f.name, f.canDelete]), [['Open in sub', false]], email);
  }
  r = await call('manager@example.com', '/api/filters');
  assert.deepEqual(r.body.map((f) => [f.project, f.name, f.mine, f.canDelete]), [['alpha', 'Open in sub', true, true]]);
  const h = rows("SELECT actor, action, field FROM history WHERE action LIKE 'filter.%'");
  assert.deepEqual(h, [{ actor: 'manager@example.com', action: 'filter.create', field: 'alpha Open in sub' }]);
});

test('the same name replaces the filter (200) and is audited as an update', async () => {
  assert.equal((await post('manager@example.com', { project: 'alpha', name: 'n', params: 'p=alpha&q=a' })).status, 201);
  const r = await post('manager@example.com', { project: 'alpha', name: 'n', params: 'p=alpha&q=b' });
  assert.equal(r.status, 200);
  assert.deepEqual(rows('SELECT name, params FROM shared_filters'), [{ name: 'n', params: 'p=alpha&q=b' }]);
  assert.deepEqual(rows("SELECT action FROM history WHERE action LIKE 'filter.%' ORDER BY id").map((x) => x.action), ['filter.create', 'filter.update']);
});

test('viewers and editors can list but not create; a manager of alpha cannot create or delete in beta', async () => {
  for (const email of ['viewer@example.com', 'editor@example.com', 'star@example.com', 'mixed@example.com']) {
    assert.equal((await post(email, { project: 'alpha', name: 'x', params: 'p=alpha' })).status, 403, email);
  }
  assert.equal((await post('mixed@example.com', { project: 'beta', name: 'x', params: 'p=beta' })).status, 403, 'editor of beta');
  assert.equal((await post('manager@example.com', { project: 'beta', name: 'x', params: 'p=beta' })).status, 403);
  seed('beta', 'beta filter');
  const id = rows('SELECT id FROM shared_filters')[0].id;
  assert.equal((await call('manager@example.com', `/api/filters/${id}`, { method: 'DELETE' })).status, 404, 'cannot even see beta');
  assert.equal((await call('mixed@example.com', `/api/filters/${id}`, { method: 'DELETE' })).status, 403, 'sees beta, does not manage it');
  assert.equal(rows('SELECT * FROM shared_filters').length, 1);
  assert.equal((await call('bmanager@example.com', `/api/filters/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(rows('SELECT * FROM shared_filters').length, 0);
  assert.deepEqual(rows("SELECT action, field FROM history WHERE action = 'filter.delete'"), [{ action: 'filter.delete', field: 'beta beta filter' }]);
});

test('tenant isolation: listing never returns another project’s filters; owners see everything', async () => {
  seed('alpha', 'a1');
  seed('beta', 'b1');
  seed('（索引）', 'i1');
  seed('gone', 'old');
  const names = async (email, q = '') => (await call(email, `/api/filters${q}`)).body.map?.((f) => f.name) ?? null;
  assert.deepEqual(await names('viewer@example.com'), ['a1']);
  assert.deepEqual(await names('bmanager@example.com'), ['b1']);
  assert.deepEqual(await names('star@example.com'), ['a1', 'b1'], '* does not cover the index project');
  assert.deepEqual(await names('idx@example.com'), ['i1']);
  assert.deepEqual((await names('owner@example.com')).sort(), ['a1', 'b1', 'i1', 'old'], 'owner: all, even gone projects');
  for (const q of ['?project=beta', '?project=nope', '?project=__proto__', '?project=constructor']) {
    const r = await call('viewer@example.com', `/api/filters${q}`);
    assert.equal(r.status, 404, q);
  }
  assert.equal((await call('viewer@example.com', '/api/filters?project=alpha%2Fsub')).status, 200, 'a subproject means its top level');
  assert.equal((await call('bmanager@example.com', '/api/filters?project=gone')).status, 404);
});

test('public projects: every known user can list their shared filters, but never create them', async () => {
  const c = catalogFixture();
  c.projects.beta.visibility = 'public';
  env = await makeEnv({}, { '/catalog.json': c });
  seed('beta', 'public one');
  assert.deepEqual((await call('viewer@example.com', '/api/filters?project=beta')).body.map((f) => f.name), ['public one']);
  assert.equal((await post('viewer@example.com', { project: 'beta', name: 'x', params: 'p=beta' })).status, 403);
});

test('owners may share in any catalog project, not in unknown ones', async () => {
  assert.equal((await post('owner@example.com', { project: 'beta', name: 'o', params: 'p=beta' })).status, 201);
  assert.equal((await post('owner@example.com', { project: 'nope', name: 'o', params: 'p=nope' })).status, 400);
  assert.equal((await post('owner@example.com', { project: '__proto__', name: 'o', params: 'p=__proto__' })).status, 400);
  assert.equal((await post('owner@example.com', { project: '*', name: 'o', params: 'p=*' })).status, 400);
});

test('validation: names, params scope, project conditions in the search text, keys and sizes', async () => {
  const bad = async (body, msg) => {
    const r = await post('manager@example.com', { project: 'alpha', name: 'n', params: 'p=alpha', ...body });
    assert.equal(r.status, 400, `${msg}: ${JSON.stringify(r.body)}`);
  };
  await bad({ name: '' }, 'empty name');
  await bad({ name: 'x'.repeat(61) }, 'long name');
  await bad({ name: 'a\nb' }, 'control character');
  await bad({ name: 7 }, 'non-string name');
  await bad({ params: 'q=a' }, 'no scope');
  await bad({ params: 'p=beta' }, 'other project scope');
  await bad({ params: 'p=alpha&p=beta' }, 'two scopes');
  await bad({ params: `p=alpha&q=${encodeURIComponent('p:beta api')}` }, 'search text names another project');
  await bad({ params: `p=alpha&q=${encodeURIComponent('-project:beta')}` }, 'even negated');
  await bad({ params: `p=alpha&q=${encodeURIComponent('p:alpha/x,beta')}` }, 'another project as a comma alternative');
  await bad({ params: 'p=alpha&s=a' }, 'legacy list key');
  await bad({ params: 'p=alpha&lang=en' }, 'a key that is not list state');
  await bad({ params: 'p=alpha&__proto__=1' }, 'prototype key');
  await bad({ params: 'p=alpha&a%20b=1' }, 'odd key');
  await bad({ params: `p=alpha&q=${'x'.repeat(1000)}` }, 'too long');
  await bad({ params: ['p=alpha'] }, 'non-string params');
  await bad({ extra: 1 }, 'unknown field');
  const ok = await post('manager@example.com', { project: 'alpha', name: 'ok', params: `p=alpha&q=${encodeURIComponent('p:alpha/sub api')}` });
  assert.equal(ok.status, 201, 'own project in the search text is fine');
  const r = await call('manager@example.com', '/api/filters', { method: 'POST', body: '{"project":"alpha","name":"n","params":"p=alpha","__proto__":{"x":1}}' });
  assert.equal(r.status, 400, '__proto__ in the body is an unknown field');
  assert.equal(rows('SELECT * FROM shared_filters').length, 1);
});

test('a project holds at most 100 shared filters', async () => {
  for (let i = 0; i < 100; i++) seed('alpha', `f${i}`);
  assert.equal((await post('manager@example.com', { project: 'alpha', name: 'one more', params: 'p=alpha' })).status, 400);
  assert.equal((await post('manager@example.com', { project: 'alpha', name: 'f5', params: 'p=alpha&q=b' })).status, 200, 'replacing still works');
});

test('CSRF: creating and deleting need a JSON content type and a same-origin signal', async () => {
  const body = { project: 'alpha', name: 'x', params: 'p=alpha' };
  assert.equal((await post('manager@example.com', body, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post('manager@example.com', body, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example.net' })).status, 403);
  assert.equal((await post('manager@example.com', body, { 'sec-fetch-site': null })).status, 403, 'no Origin, no Sec-Fetch-Site');
  seed('alpha', 'keep');
  const id = rows('SELECT id FROM shared_filters')[0].id;
  assert.equal((await call('manager@example.com', `/api/filters/${id}`, { method: 'DELETE', headers: { 'content-type': null } })).status, 403);
  assert.equal((await call('manager@example.com', `/api/filters/${id}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.deepEqual(rows('SELECT name FROM shared_filters'), [{ name: 'keep' }]);
});

test('odd ids and methods', async () => {
  assert.equal((await call('owner@example.com', '/api/filters/abc', { method: 'DELETE' })).status, 404);
  assert.equal((await call('owner@example.com', '/api/filters/999', { method: 'DELETE' })).status, 404);
  assert.equal((await call('owner@example.com', '/api/filters', { method: 'PUT', body: {} })).status, 405);
});

test('a creator the caller may not see is shown without a name', async () => {
  seed('alpha', 'by someone gone', 'p=alpha&q=x', 'gone@elsewhere.example');
  const r = await call('viewer@example.com', '/api/filters?project=alpha');
  assert.equal(r.status, 200);
  const f = r.body.find((x) => x.name === 'by someone gone');
  assert.equal(f.created_by_name, null);
  assert.equal(JSON.stringify(r.body).includes('gone'), true, 'only the filter name mentions it');
  assert.equal(JSON.stringify(r.body).includes('elsewhere'), false, 'no trace of the creator');
});
