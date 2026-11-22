// Project visibility (public projects) and the vault namespace of mounted sources, through middleware + API.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serve, keyPair, sign, claimsFor, jwksFetch, resetCaches, assets } from './helpers/server.mjs';
import { makeEnv, vaultFixture, catalog as catalogFixture, searchIndex } from './fixtures.mjs';
import { roleIn, canSee, canEdit, canManage, publicProjectsOf } from '../functions/_lib/roles.js';

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

/** Replace the deployed catalog (and extra files) for this test. */
function deploy(mutate, extraFiles = {}) {
  const c = catalogFixture();
  mutate(c);
  const base = env.ASSETS;
  const over = assets({ '/catalog.json': c, ...extraFiles });
  env.ASSETS = { fetch: async (r) => { const res = await over.fetch(r); return res.status === 404 ? base.fetch(r) : res; } };
  return c;
}

/** A known, enabled user with no memberships at all. */
function addNobody() {
  env.DB.raw.prepare("INSERT INTO users (email, name, disabled, created_at, created_by) VALUES ('nobody@example.com', 'nobody', 0, 'x', 'seed')").run();
}

test('publicProjectsOf / roleIn: public gives viewer only; subprojects inherit; index project and * never public', () => {
  const c = catalogFixture();
  c.projects.beta.visibility = 'public';
  c.projects['alpha/sub'].visibility = 'public'; // ignored: only top-level entries count
  c.projects['（索引）'].visibility = 'public'; // ignored: never public
  c.projects['*'] = { title: '*', desc: '', visibility: 'public' }; // ignored
  const pub = publicProjectsOf(c);
  assert.deepEqual([...pub], ['beta']);
  const none = { owner: false, roles: {} };
  assert.equal(roleIn(none, 'beta', pub), 'viewer');
  assert.equal(roleIn(none, 'beta/any-sub', pub), 'viewer', 'subprojects inherit');
  assert.equal(roleIn(none, 'alpha/sub', pub), null);
  assert.equal(roleIn(none, '（索引）', new Set(['（索引）'])), null, 'index project even if a caller passes it');
  assert.equal(roleIn(none, 'beta'), null, 'without the set nothing is public');
  assert.equal(canEdit(none, 'beta'), false);
  assert.equal(canManage(none, 'beta'), false);
  assert.equal(roleIn({ owner: false, roles: { beta: 'editor' } }, 'beta', pub), 'editor', 'a membership still wins');
  assert.equal(canSee({ owner: false, roles: {} }, 'constructor', new Set(['beta'])), false);
});

test('a user with no memberships sees public project docs, catalog, search, notes — nothing else', async () => {
  addNobody();
  deploy((c) => { c.projects.beta.visibility = 'public'; });
  const c = (await call('nobody@example.com', '/catalog.json')).body;
  assert.deepEqual(c.docs.map((d) => d.id), [3]);
  assert.deepEqual(Object.keys(c.projects), ['beta']);
  assert.equal(c.projects.beta.visibility, 'public');
  assert.deepEqual(c.filters.map((f) => f.name), ['beta only', 'pending', 'not beta'], 'filter on a public project is kept');
  assert.deepEqual((await call('nobody@example.com', '/search-index.json')).body.map((r) => r.id), [3]);
  assert.equal((await call('nobody@example.com', '/docs/beta/c.md')).status, 200);
  for (const p of ['/docs/alpha/a.md', '/docs/README.md', '/docs/stray.txt']) assert.equal((await call('nobody@example.com', p)).status, 403, p);

  const me = (await call('nobody@example.com', '/api/me')).body;
  assert.deepEqual([me.roles, me.publicProjects], [{}, ['beta']]);
  assert.equal((await call('nobody@example.com', '/api/docs/3/notes', { method: 'POST', body: { body: 'hello' } })).status, 201, 'viewers add notes');
  assert.equal((await call('nobody@example.com', '/api/docs/3/notes')).status, 200);
  assert.equal((await call('nobody@example.com', '/api/docs/3/history')).status, 200);
  assert.deepEqual(Object.keys((await call('nobody@example.com', '/api/state')).body.docs), ['docs/beta/c.md']);
  assert.equal((await call('nobody@example.com', '/api/docs/3', { method: 'PATCH', body: { status: '待確認' } })).status, 403);
  assert.equal((await call('nobody@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '待確認' } })).status, 404, 'private stays invisible');
  assert.equal((await call('nobody@example.com', '/api/docs/1/notes')).status, 404);
  const reveal = await call('nobody@example.com', '/api/vault/reveal', { method: 'POST', body: { id: 3, name: 'beta/token', action: 'show' } });
  assert.equal(reveal.status, 403);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM vault_audit').get().n, 0);
  assert.equal((await call('nobody@example.com', '/api/users')).status, 403, 'no member management');
  assert.equal((await call('nobody@example.com', '/api/users', { method: 'POST', body: { email: 'x@example.com', memberships: [{ project: 'beta', role: 'viewer' }] } })).status, 403);
});

test('members of other projects see public projects on top of their own; private projects stay hidden', async () => {
  deploy((c) => { c.projects.beta.visibility = 'public'; });
  assert.deepEqual((await call('viewer@example.com', '/catalog.json')).body.docs.map((d) => d.id).sort(), [1, 2, 3]);
  assert.deepEqual((await call('idx@example.com', '/catalog.json')).body.docs.map((d) => d.id).sort(), [3, 4]);
  // editor of alpha is only a viewer in beta
  assert.equal((await call('editor@example.com', '/api/docs/3', { method: 'PATCH', body: { status: '封存' } })).status, 403);
  assert.equal((await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { id: 3, name: 'beta/token', action: 'show' } })).status, 403);
  // without the flag beta is private again
  resetCaches();
  deploy(() => {});
  assert.deepEqual((await call('viewer@example.com', '/catalog.json')).body.docs.map((d) => d.id).sort(), [1, 2]);
  assert.deepEqual((await call('viewer@example.com', '/api/me')).body.publicProjects, []);
});

test("'（索引）' can never be public; subproject visibility is ignored", async () => {
  addNobody();
  deploy((c) => {
    c.projects['（索引）'].visibility = 'public';
    c.projects['alpha/sub'].visibility = 'public';
  });
  assert.deepEqual((await call('nobody@example.com', '/catalog.json')).body.docs, []);
  assert.equal((await call('nobody@example.com', '/docs/README.md')).status, 403);
  assert.equal((await call('star@example.com', '/docs/README.md')).status, 403);
  assert.equal((await call('nobody@example.com', '/docs/alpha/sub/b%20%E5%A0%B1%E5%91%8A.html')).status, 403);
  assert.deepEqual((await call('nobody@example.com', '/api/me')).body.publicProjects, []);
});

test('vault reveal: a doc from source X can only reveal X/… names, even if the catalog lists others', async () => {
  deploy((c) => {
    c.projects.acme = { title: 'acme', desc: '', source: 'acme' };
    c.docs.push(
      { id: 5, path: 'docs/acme/guide.md', project: 'acme', subproject: '', title: 'G', status: '待處理', tags: [], source: 'acme', vault: ['acme/token', 'beta/token'] },
      // no `source` on the record: the registry entry of the mount still applies
      { id: 6, path: 'docs/acme/other.md', project: 'acme', subproject: '', title: 'O', status: '待處理', tags: [], vault: ['beta/token'] },
    );
  }, { '/search-index.json': [...searchIndex, { id: 5, t: 'guide' }] });
  env.DB.raw.prepare("INSERT INTO memberships (email, project, role) VALUES ('mixed@example.com', 'acme', 'editor')").run();
  const reveal = (email, id, name) => call(email, '/api/vault/reveal', { method: 'POST', body: { id, name, action: 'show' } });
  let r = await reveal('mixed@example.com', 5, 'acme/token');
  assert.deepEqual([r.status, r.body.value], [200, 'acme-secret-value']);
  r = await reveal('mixed@example.com', 5, 'beta/token');
  assert.equal(r.status, 403, 'mixed is beta editor, but the acme doc may not open beta secrets');
  assert.match(r.body.error, /source acme/);
  assert.equal((await reveal('owner@example.com', 5, 'beta/token')).status, 403, 'not even for owners');
  assert.equal((await reveal('owner@example.com', 6, 'beta/token')).status, 403, 'registry source applies without record source');
  assert.equal((await reveal('mixed@example.com', 3, 'beta/token')).status, 200, 'local docs are unaffected');
  assert.deepEqual(env.DB.raw.prepare('SELECT name, path FROM vault_audit ORDER BY id').all().map((x) => ({ ...x })),
    [{ name: 'acme/token', path: 'docs/acme/guide.md' }, { name: 'beta/token', path: 'docs/beta/c.md' }]);
});

test('confidential (機密+) docs: editor+ only on /docs; viewers and public visitors get restricted metadata', async () => {
  addNobody();
  deploy((c) => {
    c.projects.beta.visibility = 'public';
    Object.assign(c.docs[0], { sensitivity: '機密' }); // alpha/a.md, references alpha/token
    Object.assign(c.docs[2], { sensitivity: '機密' }); // beta/c.md (public project)
  }, { '/search-index.json': [{ id: 1, t: 'alpha body' }, { id: 2, t: 'sub body' }, { id: 3, t: 'beta body' }] });
  const rec = async (email, id) => (await call(email, '/catalog.json')).body.docs.find((d) => d.id === id);
  // viewer of alpha
  assert.equal((await call('viewer@example.com', '/docs/alpha/a.md')).status, 403);
  assert.deepEqual([(await rec('viewer@example.com', 1)).restricted, 'vault' in (await rec('viewer@example.com', 1))], [true, false]);
  assert.equal((await rec('viewer@example.com', 1)).title, 'A', 'title and metadata stay');
  assert.equal((await rec('viewer@example.com', 2)).restricted, undefined, '內部 docs are not restricted');
  assert.deepEqual((await call('viewer@example.com', '/search-index.json')).body.map((r) => r.id), [2]);
  assert.equal((await call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: 'still discussable' } })).status, 201);
  // public visitor
  assert.equal((await call('nobody@example.com', '/docs/beta/c.md')).status, 403);
  assert.equal((await rec('nobody@example.com', 3)).restricted, true);
  // editor+ and owners read them
  assert.equal((await call('editor@example.com', '/docs/alpha/a.md')).status, 200);
  assert.equal((await rec('editor@example.com', 1)).restricted, undefined);
  assert.deepEqual((await rec('editor@example.com', 1)).vault, ['alpha/token']);
  assert.equal((await call('owner@example.com', '/docs/beta/c.md')).status, 200);
  assert.equal((await call('mixed@example.com', '/docs/beta/c.md')).status, 200, 'beta editor');
  const page = await call('viewer@example.com', '/docs/alpha/a.md', { headers: { accept: 'text/html' } });
  assert.match(page.body, /confidential[\s\S]*機密文件需要 editor 權限/);
});
