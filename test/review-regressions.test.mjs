// Regressions from a security review: display-name spoofing, tenant discovery through user management, operator
// secrets overridden from the web vault, and a source whose vault key would be VAULT_KEY_PREVIOUS.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serve, keyPair, sign, claimsFor, jwksFetch, resetCaches } from './helpers/server.mjs';
import { makeEnv, vaultFixture, catalog as catalogFixture } from './fixtures.mjs';
import { checkName } from '../functions/_lib/people.js';

let key, deps, env;
before(async () => { key = await keyPair('k1'); deps = { fetch: jwksFetch(() => [key]) }; await vaultFixture(); });
beforeEach(async () => { resetCaches(); env = await makeEnv(); });
const tokens = new Map();
async function call(email, path, opts = {}) {
  if (!tokens.has(email)) tokens.set(email, await sign(key, claimsFor(email)));
  const res = await serve(env, path, { ...opts, token: tokens.get(email), deps });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}
const sql = (q, ...p) => env.DB.raw.prepare(q).run(...p);
const rows = (q, ...p) => env.DB.raw.prepare(q).all(...p).map((r) => ({ ...r }));

test('display names: one validator for /api/me and /api/users rejects control, invisible and bidi characters', async () => {
  for (const ch of ['\u0000', '\u0085', '؜', '​', '‍', '‎', '‏', '‪', '‮', '⁦', '⁩', '﻿', ' ', ' ']) {
    assert.ok(checkName(`a${ch}b`).error, `U+${ch.codePointAt(0).toString(16)}`);
  }
  assert.ok(checkName('x'.repeat(81)).error);
  assert.equal(checkName('  é  '.normalize('NFD')).name, 'é'.normalize('NFC'), 'trimmed and NFC');
  assert.ok(checkName('mia@example.com').error, 'email-like');
  assert.ok(checkName('Mia (mia@example.com)').error, 'email-like inside');
  assert.equal(checkName('').name, '', 'empty clears');
  // blank fillers, combining-only names and Latin / Cyrillic / Greek mixes (confusables)
  for (const n of ['a\u3164', '\u3164', '\u115f', '\u1160x', '\uffa0', '\u2800', 'x\u034fy', '\u17b4', '\u0301\u0301', '\u0301a', 'P\u0430ypal', 'Mi\u03b1', '\u0410\u03b1']) {
    assert.ok(checkName(n).error, JSON.stringify(n));
  }
  for (const n of ['José Núñez', '王小明', 'Анна', 'Ελένη', "O'Brien", 'Nguyễn', 'Mia 2', '🙂']) assert.equal(checkName(n).name, n.normalize('NFC'), n);
  assert.equal((await call('viewer@example.com', '/api/me', { method: 'PATCH', body: { name: 'P\u0430ypal' } })).status, 400);
  const bidi = 'Eve‮gnp.exe';
  for (const [email, path, method, body] of [
    ['manager@example.com', '/api/users/viewer%40example.com', 'PATCH', { name: bidi }],
    ['manager@example.com', '/api/users/viewer%40example.com', 'PATCH', { name: 'x'.repeat(150) }],
    ['manager@example.com', '/api/users', 'POST', { email: 'n@example.com', name: bidi, memberships: [{ project: 'alpha', role: 'viewer' }] }],
    ['viewer@example.com', '/api/me', 'PATCH', { name: bidi }],
  ]) {
    assert.equal((await call(email, path, { method, body })).status, 400, `${method} ${path}`);
  }
  assert.equal(rows("SELECT name FROM users WHERE email = 'viewer@example.com'")[0].name, 'viewer', 'nothing stored');
  assert.equal(rows("SELECT * FROM users WHERE email = 'n@example.com'").length, 0);
});

test('display names are unique among enabled users (NFKC + case-folded, local parts count); legacy collisions are told apart', async () => {
  sql("UPDATE users SET name = 'Mia Manager' WHERE email = 'manager@example.com'");
  for (const name of ['Mia Manager', 'mia  manager', 'Ｍｉａ Manager', 'editor']) {
    const r = await call('viewer@example.com', '/api/me', { method: 'PATCH', body: { name } });
    assert.equal(r.status, 409, name);
    assert.match(r.body.error, /already used/);
  }
  assert.equal((await call('manager@example.com', '/api/users/viewer%40example.com', { method: 'PATCH', body: { name: 'MIA MANAGER' } })).status, 409);
  assert.equal((await call('manager@example.com', '/api/me', { method: 'PATCH', body: { name: 'Mia Manager' } })).status, 200, 'own name is not a conflict');
  sql("UPDATE users SET disabled = 1 WHERE email = 'editor@example.com'");
  assert.equal((await call('viewer@example.com', '/api/me', { method: 'PATCH', body: { name: 'editor' } })).status, 200, 'disabled users do not hold names');

  // legacy rows that collide (written before the check) are disambiguated in every name map
  sql("UPDATE users SET name = 'Sam' WHERE email IN ('manager@example.com', 'viewer@example.com')");
  sql("INSERT INTO users (email, name, disabled, created_at, created_by) VALUES ('sam@other.example.org', 'sam', 0, 'x', 'seed')");
  sql("INSERT INTO memberships (email, project, role) VALUES ('sam@other.example.org', 'alpha', 'viewer')");
  const people = (await call('viewer@example.com', '/api/state')).body.people;
  assert.equal(people['manager@example.com'], 'Sam (manager@example.com)');
  assert.equal(people['viewer@example.com'], 'Sam (viewer@example.com)');
  assert.equal(people['sam@other.example.org'], 'sam (other.example.org)');
  assert.equal(new Set(Object.values(people)).size, Object.keys(people).length, 'no two people look alike');
  await call('manager@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: 'hi' } });
  const notes = (await call('viewer@example.com', '/api/docs/1/notes')).body;
  assert.equal(notes[0].author_name, 'Sam (manager@example.com)');
});

test('managers cannot discover users of other tenants through invite / patch / list', async () => {
  sql("INSERT INTO users (email, name, disabled, created_at, created_by) VALUES ('bob@acme.example.com', 'Bob Acme', 0, '2026-01-01T00:00:00Z', 'acme-admin@acme.example.com')");
  sql("INSERT INTO memberships (email, project, role) VALUES ('bob@acme.example.com', 'acme', 'viewer')");
  sql("INSERT INTO history (path, actor, action, at) VALUES (NULL, 'bob@acme.example.com', 'login', '2026-11-20T10:00:00Z')");

  // PATCH: a user they do not manage answers exactly like one that does not exist
  const body = { memberships: [{ project: 'alpha', role: 'viewer' }] };
  const exists = await call('manager@example.com', '/api/users/bob%40acme.example.com', { method: 'PATCH', body });
  const missing = await call('manager@example.com', '/api/users/nobody%40acme.example.com', { method: 'PATCH', body });
  assert.deepEqual(exists, missing);
  assert.equal(exists.status, 404);

  // POST: same status and shape for an existing and a new account
  const invite = (email) => call('manager@example.com', '/api/users', { method: 'POST', body: { email, memberships: [{ project: 'alpha', role: 'viewer' }] } });
  const old = await invite('bob@acme.example.com');
  const fresh = await invite('nobody-here@acme.example.com');
  assert.equal(old.status, 201);
  assert.equal(fresh.status, 201);
  assert.deepEqual(old.body, { user: { email: 'bob@acme.example.com', memberships: [{ project: 'alpha', role: 'viewer' }] } });
  assert.deepEqual(Object.keys(old.body).sort(), Object.keys(fresh.body).sort());
  assert.deepEqual(Object.keys(old.body.user).sort(), Object.keys(fresh.body.user).sort());
  assert.equal(JSON.stringify(old.body).includes('Bob Acme'), false);

  // GET: the merged user shows neither the other tenant's creator nor sign-ins from before the invite
  const listed = (await call('manager@example.com', '/api/users')).body.find((u) => u.email === 'bob@acme.example.com');
  assert.deepEqual([listed.created_by, listed.created_at, listed.last_seen], [null, null, null]);
  assert.deepEqual(listed.memberships, [{ project: 'alpha', role: 'viewer' }]);
  const asOwner = (await call('owner@example.com', '/api/users')).body.find((u) => u.email === 'bob@acme.example.com');
  assert.deepEqual([asOwner.created_by, asOwner.last_seen], ['acme-admin@acme.example.com', '2026-11-20T10:00:00Z'], 'owners see everything');
  assert.equal((await call('bob@acme.example.com', '/api/me')).status, 200);
  const later = (await call('manager@example.com', '/api/users')).body.find((u) => u.email === 'bob@acme.example.com');
  assert.ok(later.last_seen > '2026-11-20T10:00:00Z', 'sign-ins after the invite are shown');
});

test('a manager cannot override an operator (host) or source (git) secret from the web vault', async () => {
  const before = await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { id: 1, name: 'alpha/token', action: 'show' } });
  const put = await call('manager@example.com', '/api/vault/secrets', { method: 'PUT', body: { name: 'alpha/token', value: 'https://attacker.example/login' } });
  const after = await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { id: 1, name: 'alpha/token', action: 'show' } });
  assert.equal(put.status, 409);
  assert.deepEqual(after.body, before.body);
  assert.equal(after.body.origin, 'host');
  assert.equal(rows('SELECT * FROM vault_secrets').length, 0);
});

test('a catalog project "previous" never opens a git vault with VAULT_KEY_PREVIOUS', async () => {
  const c = catalogFixture();
  c.projects.previous = { title: 'previous', desc: '', source: 'previous' };
  c.docs.push({ id: 9, path: 'docs/previous/x.md', project: 'previous', subproject: '', title: 'x', status: '待處理', tags: [], source: 'previous', vault: ['previous/k'] });
  const { vault } = await vaultFixture();
  env = await makeEnv({ VAULT_KEY_PREVIOUS: env.VAULT_KEY }, { '/catalog.json': c, '/_vaults/previous.json': vault, '/docs/previous/x.md': '# x' });
  resetCaches();
  const r = await call('owner@example.com', '/api/vault/reveal', { method: 'POST', body: { id: 9, name: 'previous/k', action: 'show' } });
  assert.equal(r.status, 404, 'treated as no tenant vault at all');
});
