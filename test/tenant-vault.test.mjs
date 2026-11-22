// Tenant vaults (DESIGN.md → Tenant vaults): web vault in D1, a source's git vault, host vault; lookup order,
// namespace rules, vault-page reveal, audit, no plaintext at rest.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serve, keyPair, sign, claimsFor, jwksFetch, resetCaches, assets } from './helpers/server.mjs';
import { makeEnv, vaultFixture, catalog as catalogFixture } from './fixtures.mjs';
import { createVault, deriveKey, exportKey, seal } from '../site/vault-core.js';

let key, deps, env, acmeVault, acmeKey;
before(async () => {
  key = await keyPair('k1');
  deps = { fetch: jwksFetch(() => [key]) };
  await vaultFixture();
  // the tenant's own vault (its own passphrase), as the build deploys it: only acme/… names
  const pass = 'acme tenant passphrase';
  const { vault } = await createVault(pass);
  const k = await deriveKey(pass, vault.kdf, true);
  vault.secrets['acme/key'] = { ...(await seal(k, 'acme/key', 'acme-git-value')), note: 'from git', updated: '2026-11-20' };
  acmeVault = vault;
  acmeKey = await exportKey(k);
});
beforeEach(async () => {
  resetCaches();
  env = await makeEnv({ VAULT_KEY_ACME: acmeKey });
  for (const [e, role] of [['alice@acme.example.com', 'manager'], ['bob@acme.example.com', 'editor']]) {
    env.DB.raw.prepare("INSERT INTO users (email, name, disabled, created_at, created_by) VALUES (?, NULL, 0, 'x', 'seed')").run(e);
    env.DB.raw.prepare("INSERT INTO memberships (email, project, role) VALUES (?, 'acme', ?)").run(e, role);
  }
  const c = catalogFixture();
  c.projects.acme = { title: 'acme', desc: '', source: 'acme' };
  c.docs.push({ id: 5, path: 'docs/acme/guide.md', project: 'acme', subproject: '', title: 'G', status: '待處理', tags: [], source: 'acme', vault: ['acme/key', 'acme/token'] });
  const base = env.ASSETS;
  const over = assets({ '/catalog.json': c, '/_vaults/acme.json': acmeVault });
  env.ASSETS = { fetch: async (r) => { const res = await over.fetch(r); return res.status === 404 ? base.fetch(r) : res; } };
});

const tokens = new Map();
async function call(email, path, opts = {}) {
  if (!tokens.has(email)) tokens.set(email, await sign(key, claimsFor(email)));
  const res = await serve(env, path, { ...opts, token: tokens.get(email), deps });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}
const put = (email, body) => call(email, '/api/vault/secrets', { method: 'PUT', body });
const reveal = (email, body) => call(email, '/api/vault/reveal', { method: 'POST', body: { action: 'show', ...body } });
const rows = (q, ...p) => env.DB.raw.prepare(q).all(...p).map((r) => ({ ...r }));
const dbText = () => ['vault_secrets', 'vault_versions', 'history', 'vault_audit'].map((t) => JSON.stringify(rows(`SELECT * FROM ${t}`))).join('\n');

test('PUT /api/vault/secrets: manager+ of the namespace (owner: any top-level project), validation, versions + history, no plaintext at rest', async () => {
  const value = 'web-db-password-1';
  assert.equal((await put('viewer@example.com', { name: 'alpha/db', value })).status, 403);
  assert.equal((await put('editor@example.com', { name: 'alpha/db', value })).status, 403);
  assert.equal((await put('manager@example.com', { name: 'beta/db', value })).status, 403, 'not their project');
  assert.equal((await put('manager@example.com', { name: 'nosuch/db', value })).status, 403);
  assert.equal((await put('alice@acme.example.com', { name: 'alpha/db', value })).status, 403, 'tenant cannot write the host namespace');
  for (const name of ['alpha', 'alpha//x', 'alpha/', 'alpha/x y', '/alpha/x', 'a'.repeat(199) + '/xx', 5]) {
    assert.equal((await put('manager@example.com', { name, value })).status, 400, String(name));
  }
  for (const body of [{ name: 'alpha/db' }, { name: 'alpha/db', value: '' }, { name: 'alpha/db', value: 'x'.repeat(16 * 1024 + 1) },
    { name: 'alpha/db', value, note: 'n'.repeat(201) }, { name: 'alpha/db', value, extra: 1 }]) {
    assert.equal((await put('manager@example.com', body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  let r = await put('manager@example.com', { name: 'alpha/db', value, note: 'prod db' });
  assert.deepEqual([r.status, r.body.origin, r.body.note, r.body.updated_by], [201, 'web', 'prod db', 'manager@example.com']);
  r = await put('manager@example.com', { name: 'alpha/db', value: 'web-db-password-2' });
  assert.deepEqual([r.status, r.body.note], [200, 'prod db'], 'note kept when omitted');
  assert.equal((await put('owner@example.com', { name: 'beta/x', value: 'owner-any-namespace' })).status, 201);
  assert.equal((await put('owner@example.com', { name: 'anything/x', value: 'v' })).status, 400, 'owner writes need a top-level project too');
  assert.equal((await put('owner@example.com', { name: 'sub/x', value: 'v' })).status, 400, 'a subproject key is not a namespace');
  assert.equal((await put('alice@acme.example.com', { name: 'acme/web', value: 'acme-web-value' })).status, 201, 'tenant manages its own namespace');
  assert.deepEqual(rows("SELECT action, actor FROM vault_versions WHERE name = 'alpha/db' ORDER BY id"),
    [{ action: 'create', actor: 'manager@example.com' }, { action: 'update', actor: 'manager@example.com' }]);
  assert.deepEqual(rows("SELECT action, field, old, new FROM history WHERE action = 'vault.set' AND field = 'alpha/db'"),
    [{ action: 'vault.set', field: 'alpha/db', old: null, new: null }, { action: 'vault.set', field: 'alpha/db', old: null, new: null }]);
  const text = dbText();
  for (const v of [value, 'web-db-password-2', 'owner-any-namespace', 'acme-web-value']) assert.equal(text.includes(v), false, `${v} stored in plaintext`);
  // CSRF rules apply
  assert.equal((await call('manager@example.com', '/api/vault/secrets', { method: 'PUT', body: { name: 'alpha/x', value }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('without VAULT_KEY the web vault answers 503', async () => {
  delete env.VAULT_KEY;
  assert.equal((await put('manager@example.com', { name: 'alpha/db', value: 'v' })).status, 503);
});

test('lookup order web → git → host; GET lists names of all stores (editor+), never values', async () => {
  assert.equal((await call('viewer@example.com', '/api/vault/secrets?project=alpha')).status, 403);
  assert.equal((await call('editor@example.com', '/api/vault/secrets?project=beta')).status, 403);
  for (const p of ['', 'alpha/sub', '（索引）', 'a%20b']) assert.equal((await call('owner@example.com', `/api/vault/secrets?project=${p}`)).status, 400, p);
  let list = (await call('editor@example.com', '/api/vault/secrets?project=alpha')).body;
  assert.deepEqual(list.map((s) => [s.name, s.origin, s.stores]), [['alpha/token', 'host', ['host']]]);
  // a web secret shadows the host one with the same name: refused for managers, an owner override is recorded
  assert.equal((await put('manager@example.com', { name: 'alpha/token', value: 'web-shadow' })).status, 409);
  assert.equal((await put('owner@example.com', { name: 'alpha/token', value: 'web-shadow' })).status, 201);
  assert.deepEqual(rows("SELECT actor, field, old, new FROM history WHERE action = 'vault.override'"), [{ actor: 'owner@example.com', field: 'alpha/token', old: 'host', new: 'web' }]);
  assert.equal((await put('manager@example.com', { name: 'alpha/token', value: 'web-shadow-2' })).status, 200, 'once a web row exists its managers keep it up to date');
  list = (await call('editor@example.com', '/api/vault/secrets?project=alpha')).body;
  assert.deepEqual(list.map((s) => [s.name, s.origin, s.stores, s.updated_by_name]), [['alpha/token', 'web', ['web', 'host'], 'manager']]);
  assert.equal(JSON.stringify(list).includes('web-shadow'), false);
  let r = await reveal('editor@example.com', { id: 1, name: 'alpha/token' });
  assert.deepEqual([r.status, r.body.value, r.body.origin], [200, 'web-shadow-2', 'web']);
  // tenant namespace: git vault + host names under acme/
  list = (await call('bob@acme.example.com', '/api/vault/secrets?project=acme')).body;
  assert.deepEqual(list.map((s) => [s.name, s.origin, s.note]), [['acme/key', 'git', 'from git'], ['acme/token', 'host', '']]);
  r = await reveal('bob@acme.example.com', { id: 5, name: 'acme/key' });
  assert.deepEqual([r.status, r.body.value, r.body.origin], [200, 'acme-git-value', 'git']);
  r = await reveal('bob@acme.example.com', { id: 5, name: 'acme/token' });
  assert.deepEqual([r.body.value, r.body.origin], ['acme-secret-value', 'host']);
  assert.equal((await put('alice@acme.example.com', { name: 'acme/key', value: 'acme-web-override' })).status, 409, 'git secret is changed in its repo');
  assert.equal((await reveal('bob@acme.example.com', { id: 5, name: 'acme/key' })).body.origin, 'git');
  assert.equal((await put('owner@example.com', { name: 'acme/key', value: 'acme-web-override' })).status, 201);
  assert.equal((await reveal('bob@acme.example.com', { id: 5, name: 'acme/key' })).body.origin, 'web');
});

test('git vault: wrong or missing VAULT_KEY_<SOURCE> fails closed; the file is never served', async () => {
  env.VAULT_KEY_ACME = Buffer.alloc(32, 9).toString('base64');
  assert.equal((await reveal('bob@acme.example.com', { id: 5, name: 'acme/key' })).status, 500);
  resetCaches();
  delete env.VAULT_KEY_ACME;
  assert.equal((await reveal('bob@acme.example.com', { id: 5, name: 'acme/key' })).status, 500);
  assert.equal(rows('SELECT * FROM vault_audit').length, 0);
  for (const p of ['/_vaults/acme.json', '/_vaults/', '/_vaults%2Facme.json', '/vault.json']) assert.equal((await call('owner@example.com', p)).status, 404, p);
});

test('vault-page reveal { name, action }: manager+ of the namespace only, audited with path NULL', async () => {
  assert.equal((await reveal('bob@acme.example.com', { name: 'acme/key' })).status, 403, 'editor is not enough without a doc');
  assert.equal((await reveal('manager@example.com', { name: 'acme/key' })).status, 403, 'other project');
  assert.equal((await reveal('alice@acme.example.com', { name: 'alpha/token' })).status, 403);
  assert.equal((await reveal('alice@acme.example.com', { name: 'bad name' })).status, 400);
  let r = await reveal('alice@acme.example.com', { name: 'acme/key', action: 'copy' });
  assert.deepEqual([r.status, r.body.value, r.body.origin, r.headers.get('cache-control')], [200, 'acme-git-value', 'git', 'no-store']);
  r = await reveal('owner@example.com', { name: 'alpha/token' });
  assert.deepEqual([r.status, r.body.origin], [200, 'host']);
  assert.equal((await reveal('owner@example.com', { name: 'alpha/missing' })).status, 404);
  assert.deepEqual(rows('SELECT email, name, path, action FROM vault_audit ORDER BY id'), [
    { email: 'alice@acme.example.com', name: 'acme/key', path: null, action: 'copy' },
    { email: 'owner@example.com', name: 'alpha/token', path: null, action: 'show' },
  ]);
  // the doc form still needs the reference and the source namespace
  assert.equal((await reveal('mixed@example.com', { id: 3, name: 'acme/key' })).status, 403);
});

test('DELETE /api/vault/secrets/<name>: plain or encoded name, web store only, version row', async () => {
  await put('owner@example.com', { name: 'alpha/token', value: 'web-shadow' });
  await put('manager@example.com', { name: 'alpha/db/main', value: 'v2' });
  assert.equal((await call('editor@example.com', '/api/vault/secrets/alpha/token', { method: 'DELETE' })).status, 403);
  assert.equal((await call('manager@example.com', '/api/vault/secrets/alpha%2Ftoken', { method: 'DELETE' })).status, 200);
  assert.equal((await call('manager@example.com', '/api/vault/secrets/alpha/db/main', { method: 'DELETE' })).status, 200);
  assert.equal((await call('manager@example.com', '/api/vault/secrets/alpha/token', { method: 'DELETE' })).status, 404, 'host secret cannot be deleted here');
  assert.equal((await call('manager@example.com', '/api/vault/secrets', { method: 'DELETE' })).status, 405);
  assert.equal((await reveal('editor@example.com', { id: 1, name: 'alpha/token' })).body.origin, 'host', 'falls back to the host vault');
  assert.deepEqual(rows("SELECT action, iv, ct FROM vault_versions WHERE name = 'alpha/token' ORDER BY id").map((r) => [r.action, r.iv === null]), [['create', false], ['delete', true]]);
  assert.equal((await put('manager@example.com', { name: 'alpha/token', value: 'again' })).status, 409, 'after the delete the host secret is back in charge');
  assert.equal(rows("SELECT * FROM history WHERE action = 'vault.delete'").length, 2);
});

test('after a rekey, VAULT_KEY_PREVIOUS still opens web secrets; a save re-encrypts with the new key', async () => {
  await put('manager@example.com', { name: 'alpha/db', value: 'old-key-value' });
  const old = env.VAULT_KEY;
  env.VAULT_KEY = Buffer.alloc(32, 3).toString('base64');
  resetCaches();
  assert.equal((await reveal('manager@example.com', { name: 'alpha/db' })).status, 500, 'new key alone cannot open it');
  env.VAULT_KEY_PREVIOUS = old;
  resetCaches();
  assert.equal((await reveal('manager@example.com', { name: 'alpha/db' })).body.value, 'old-key-value');
  await put('manager@example.com', { name: 'alpha/db', value: 'new-key-value' });
  delete env.VAULT_KEY_PREVIOUS;
  resetCaches();
  assert.equal((await reveal('manager@example.com', { name: 'alpha/db' })).body.value, 'new-key-value');
});
