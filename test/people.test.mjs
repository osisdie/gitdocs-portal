// Display names (MantisBT "show realname"): /api/state people map scoped per tenant, names on notes / history,
// PATCH /api/me, site.people trimmed in the server catalog, bilingual error page.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serve, keyPair, sign, claimsFor, jwksFetch, resetCaches, assets } from './helpers/server.mjs';
import { makeEnv, vaultFixture, catalog as catalogFixture } from './fixtures.mjs';

let key, deps, env;
before(async () => {
  key = await keyPair('k1');
  deps = { fetch: jwksFetch(() => [key]) };
  await vaultFixture();
});
beforeEach(async () => { resetCaches(); env = await makeEnv(); seedAcme(); });

const tokens = new Map();
async function call(email, path, opts = {}) {
  if (!tokens.has(email)) tokens.set(email, await sign(key, claimsFor(email)));
  const res = await serve(env, path, { ...opts, token: tokens.get(email), deps });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
}
const sql = (q, ...p) => env.DB.raw.prepare(q).run(...p);

const ALICE = 'alice@acme.example.com', BOB = 'bob@acme.example.com';
/** Second tenant: project acme (from an external source) with its own two users; nobody has no membership. */
function seedAcme() {
  for (const [e, n] of [[ALICE, 'Alice Acme'], [BOB, null], ['nobody@example.com', null]]) {
    sql('INSERT INTO users (email, name, disabled, created_at, created_by) VALUES (?, ?, 0, ?, ?)', e, n, 'x', 'seed');
  }
  sql("INSERT INTO memberships (email, project, role) VALUES (?, 'acme', 'editor')", ALICE);
  sql("INSERT INTO memberships (email, project, role) VALUES (?, 'acme', 'viewer')", BOB);
  deploy(() => {});
}
function deploy(mutate) {
  const c = catalogFixture();
  c.projects.acme = { title: 'acme', desc: '', source: 'acme' };
  c.docs.push({ id: 5, path: 'docs/acme/guide.md', project: 'acme', subproject: '', title: 'G', status: '待處理', tags: [], source: 'acme', reporter: BOB });
  c.site.people = { [ALICE]: 'Alice (catalog)', 'editor@example.com': 'Ed Itor', 'stranger@example.net': 'Never Shown' };
  mutate(c);
  const files = { '/catalog.json': c };
  const base = env.ASSETS;
  const over = assets(files);
  env.ASSETS = { fetch: async (r) => { const res = await over.fetch(r); return res.status === 404 ? base.fetch(r) : res; } };
  resetCaches();
}
const people = async (email) => (await call(email, '/api/state')).body.people;

test('people map: each tenant sees its own members, owners and * members — never the other tenant', async () => {
  const a = await people(ALICE);
  assert.deepEqual(Object.keys(a).sort(), [ALICE, BOB, 'mixed@example.com', 'owner@example.com', 'second-owner@example.com', 'star@example.com'].sort());
  assert.equal(a[ALICE], 'Alice Acme', 'users.name');
  assert.equal(a[BOB], 'bob', 'local part when no name');
  const v = await people('viewer@example.com');
  for (const e of [ALICE, BOB, 'bmanager@example.com', 'idx@example.com', 'nobody@example.com']) assert.equal(e in v, false, e);
  for (const e of ['viewer@example.com', 'editor@example.com', 'manager@example.com', 'star@example.com', 'owner@example.com']) assert.ok(e in v, e);
  assert.equal('disabled@example.com' in v, false, 'disabled users only appear when referenced');
  const o = await people('owner@example.com');
  for (const e of [ALICE, BOB, 'viewer@example.com', 'nobody@example.com']) assert.ok(e in o, e);
});

test('a public project does not make its viewers discover each other; members and references do', async () => {
  deploy((c) => { c.projects.beta.visibility = 'public'; });
  const n = await people('nobody@example.com');
  assert.deepEqual(Object.keys(n).sort(), ['bmanager@example.com', 'mixed@example.com', 'nobody@example.com', 'owner@example.com', 'second-owner@example.com', 'star@example.com']);
  assert.equal(ALICE in n, false, 'alice also sees beta (public) but is not a member');
  assert.equal('nobody@example.com' in await people(ALICE), false);
  assert.ok('bmanager@example.com' in await people(ALICE), 'members of a public project are visible to its viewers');
  // a note on the public doc makes its author referenced
  assert.equal((await call(ALICE, '/api/docs/3/notes', { method: 'POST', body: { body: 'hi from acme' } })).status, 201);
  assert.equal((await people('nobody@example.com'))[ALICE], 'Alice Acme');
  assert.equal(ALICE in await people('viewer@example.com'), true, 'viewer also sees beta now that it is public');
  deploy(() => {});
  assert.equal(ALICE in await people('viewer@example.com'), false, 'beta private again: viewer cannot see the note');
});

test('references on visible docs count: catalog people fields, doc_state, history', async () => {
  assert.equal((await people(ALICE))[BOB], 'bob');
  assert.equal((await call(ALICE, '/api/docs/5', { method: 'PATCH', body: { assignee: 'contractor@example.org' } })).status, 200);
  const a = await people(ALICE);
  assert.equal(a['contractor@example.org'], 'contractor', 'unknown email: local part');
  assert.equal('contractor@example.org' in await people('viewer@example.com'), false);
});

test('notes and history rows carry author_name / actor_name; audit rows too', async () => {
  sql("UPDATE users SET name = 'Vera Viewer' WHERE email = 'viewer@example.com'");
  let r = await call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: 'n' } });
  assert.equal(r.body.author_name, 'Vera Viewer');
  r = await call('editor@example.com', '/api/docs/1/notes');
  assert.deepEqual(r.body.map((x) => [x.author, x.author_name]), [['viewer@example.com', 'Vera Viewer']]);
  await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '待確認' } });
  r = await call('viewer@example.com', '/api/docs/1/history');
  assert.deepEqual(r.body.map((h) => h.actor_name), ['editor', 'Vera Viewer']);
  r = await call('owner@example.com', '/api/audit');
  assert.ok(r.body.history.every((h) => typeof h.actor_name === 'string'));
});

test('PATCH /api/me { name }: validation, history, owner row created without memberships', async () => {
  const patch = (email, body) => call(email, '/api/me', { method: 'PATCH', body });
  for (const body of [{ name: 5 }, { name: 'x'.repeat(81) }, { name: 'a\u0007b' }, { name: 'evil‮eman' }, { name: 'ok', email: 'x@example.com' }, {}, []]) {
    assert.equal((await patch('viewer@example.com', body)).status, 400, JSON.stringify(body));
  }
  let r = await patch('viewer@example.com', { name: '  Vera  Viewer ' });
  assert.deepEqual([r.status, r.body.name], [200, 'Vera  Viewer']);
  assert.equal((await call('viewer@example.com', '/api/me')).body.name, 'Vera  Viewer');
  assert.equal((await people('viewer@example.com'))['viewer@example.com'], 'Vera  Viewer');
  assert.deepEqual(env.DB.raw.prepare("SELECT field, old, new FROM history WHERE action = 'user.update'").all().map((x) => ({ ...x })),
    [{ field: 'viewer@example.com name', old: 'viewer', new: 'Vera  Viewer' }]);
  r = await patch('viewer@example.com', { name: '' });
  assert.equal(r.body.name, '', "'' clears the name");
  assert.equal((await people('viewer@example.com'))['viewer@example.com'], 'viewer');
  assert.equal((await patch('viewer@example.com', { name: 'x'.repeat(80) })).status, 200);
  // second-owner@example.com is only in OWNER_EMAILS
  r = await patch('second-owner@example.com', { name: 'Second Owner' });
  assert.equal(r.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT name FROM users WHERE email = 'second-owner@example.com'").get().name, 'Second Owner');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM memberships WHERE email = 'second-owner@example.com'").get().n, 0);
  assert.equal((await call('second-owner@example.com', '/api/me')).body.name, 'Second Owner');
  assert.equal((await call('viewer@example.com', '/api/me', { method: 'PATCH', body: { name: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403, 'CSRF guard applies');
});

test('server catalog trims site.people to the caller\'s visible people', async () => {
  const c = (await call('viewer@example.com', '/catalog.json')).body;
  assert.deepEqual(c.site.people, { 'editor@example.com': 'Ed Itor' });
  const a = (await call(ALICE, '/catalog.json')).body;
  assert.deepEqual(a.site.people, { [ALICE]: 'Alice (catalog)' });
  const o = (await call('owner@example.com', '/catalog.json')).body;
  assert.equal('stranger@example.net' in o.site.people, false, 'not related to anyone: never shown');
});

test('the 403 page for navigations is bilingual, English first', async () => {
  const r = await call('unknown@example.com', '/', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 403);
  assert.match(r.body, /<html lang="en">/);
  const en = r.body.indexOf('not enabled yet'), zh = r.body.indexOf('尚未開通，請聯絡管理員');
  assert.ok(en > 0 && zh > en, 'English before Chinese');
  assert.match(r.body, /Sign out/);
  const d = await call('viewer@example.com', '/docs/beta/c.md', { headers: { accept: 'text/html' } });
  assert.match(d.body, /You do not have permission to view this document[\s\S]*沒有權限檢視這份文件/);
});

test('UI translations are shell files: /i18n.js and /i18n/<file>, one level, plain names only', async () => {
  const base = env.ASSETS;
  env.ASSETS = { fetch: (r) => (new URL(r.url).pathname.startsWith('/i18n') ? new Response('export default {}') : base.fetch(r)) };
  for (const p of ['/i18n.js', '/i18n/en.js', '/i18n/zh-TW.js']) assert.equal((await call('viewer@example.com', p)).status, 200, p);
  for (const p of ['/i18n/', '/i18n/a/b.js', '/i18n/.hidden.js', '/i18n/../vault.json', '/i18n%2F..%2Fvault.json', '/i18n2/en.js']) {
    assert.equal((await call('viewer@example.com', p)).status, 404, p);
  }
});
