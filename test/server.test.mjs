// Middleware + API: role matrix, static-file rules, workflow edits, notes, vault reveal, user management.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serve, keyPair, sign, claimsFor, jwksFetch, resetCaches, ORIGIN } from './helpers/server.mjs';
import { makeEnv, vaultFixture, catalog as catalogFixture } from './fixtures.mjs';
import { roleIn, canSee, canEdit, rank } from '../functions/_lib/roles.js';
import { normalizePath, isShellPath, SHELL_FILES, DOC_CSP, SHELL_CSP } from '../functions/_lib/gate.js';
import { readJson } from '../functions/_lib/http.js';
import { catalogFor } from '../functions/_lib/assets.js';
import { syncAccessGroup } from '../functions/_lib/access-group.js';
import { createD1 } from './helpers/d1.mjs';

let key, deps, env;
before(async () => {
  key = await keyPair('k1');
  deps = { fetch: jwksFetch(() => [key]) };
  await vaultFixture();
});
beforeEach(async () => { resetCaches(); env = await makeEnv(); });

const tokens = new Map();
async function tokenFor(email) {
  if (!tokens.has(email)) tokens.set(email, await sign(key, claimsFor(email)));
  return tokens.get(email);
}
async function call(email, path, opts = {}) {
  const res = await serve(env, path, { ...opts, token: email ? await tokenFor(email) : undefined, deps: { ...deps, ...(opts.deps || {}) } });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}
const rows = (sql, ...p) => env.DB.raw.prepare(sql).all(...p).map((r) => ({ ...r }));

// ---------- roles ----------
test('roleIn: per-project roles, * membership, index project, owner', () => {
  const u = (roles, owner = false) => ({ owner, roles });
  assert.equal(roleIn(u({ alpha: 'editor' }), 'alpha'), 'editor');
  assert.equal(roleIn(u({ alpha: 'editor' }), 'alpha/sub'), 'editor');
  assert.equal(roleIn(u({ alpha: 'editor' }), 'beta'), null);
  assert.equal(roleIn(u({ '*': 'viewer' }), 'beta'), 'viewer');
  assert.equal(roleIn(u({ '*': 'viewer', beta: 'manager' }), 'beta'), 'manager');
  assert.equal(roleIn(u({ '*': 'editor', beta: 'viewer' }), 'beta'), 'editor');
  assert.equal(roleIn(u({ '*': 'manager' }), '（索引）'), null);
  assert.equal(roleIn(u({ '（索引）': 'viewer' }), '（索引）'), 'viewer');
  assert.equal(roleIn(u({}, true), '（索引）'), 'owner');
});

test('role lookups ignore inherited properties (constructor, __proto__, toString)', () => {
  const viewer = { owner: false, roles: { alpha: 'viewer' } };
  for (const p of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(canSee(viewer, p), false, p);
    assert.equal(canEdit(viewer, p), false, p);
    assert.equal(canSee({ owner: false, roles: {} }, p), false, p);
  }
  assert.equal(rank('constructor'), 0);
  assert.equal(rank('toString'), 0);
  assert.equal(roleIn({ owner: false, roles: { alpha: 'constructor' } }, 'alpha'), null, 'unknown role values count as none');
  assert.equal(canSee({ owner: false, roles: { '*': 'viewer' } }, 'constructor'), true, '* still covers every project');
});

// ---------- identity ----------
test('unknown, disabled and token-less callers get 403 (HTML for navigations, JSON for /api)', async () => {
  let r = await call('unknown@example.com', '/api/me');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /尚未開通/);
  r = await call('disabled@example.com', '/', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 403);
  assert.match(r.body, /尚未開通，請聯絡管理員/);
  r = await call(null, '/api/me');
  assert.equal(r.status, 403);
});

test('owners come from OWNER_EMAILS (case-insensitive) and get a users row on first /api/me', async () => {
  const r = await call('OWNER@example.com', '/api/me');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.email, r.body.owner], ['owner@example.com', true]);
  assert.equal(rows("SELECT * FROM users WHERE email = 'owner@example.com'").length, 1);
  assert.equal(rows("SELECT * FROM history WHERE action = 'login' AND actor = 'owner@example.com'").length, 1);
  await call('owner@example.com', '/api/me');
  assert.equal(rows("SELECT * FROM history WHERE action = 'login' AND actor = 'owner@example.com'").length, 1, 'login logged at most hourly');
});

test('/api/me returns roles and prefs; PUT /api/me/prefs stores ≤ 8 KB objects', async () => {
  let r = await call('mixed@example.com', '/api/me');
  assert.deepEqual(r.body.roles, { '*': 'viewer', beta: 'editor' });
  assert.deepEqual(r.body.prefs, {});
  r = await call('mixed@example.com', '/api/me/prefs', { method: 'PUT', body: { theme: 'dark', focusProjects: ['beta'] } });
  assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  r = await call('mixed@example.com', '/api/me');
  assert.deepEqual(r.body.prefs, { theme: 'dark', focusProjects: ['beta'] });
  assert.equal((await call('mixed@example.com', '/api/me/prefs', { method: 'PUT', body: [1] })).status, 400);
  assert.equal((await call('mixed@example.com', '/api/me/prefs', { method: 'PUT', body: { x: 'y'.repeat(9000) } })).status, 400);
});

test('static mode: without a D1 binding or server variables the middleware passes through and /api is 404', async () => {
  env = { ASSETS: env.ASSETS };
  assert.equal((await call(null, '/vault.json')).status, 200);
  assert.equal((await call(null, '/api/me')).status, 404);
});

test('missing D1 binding with server variables set fails closed with 503 (HTML for navigations, JSON for /api)', async () => {
  for (const k of ['ACCESS_AUD', 'TEAM_DOMAIN', 'OWNER_EMAILS']) {
    const e = { ASSETS: env.ASSETS, [k]: 'x' };
    let res = await serve(e, '/docs/beta/c.md', { headers: { accept: 'text/html' } });
    assert.equal(res.status, 503, k);
    assert.match(await res.text(), /server mode misconfigured/);
    res = await serve(e, '/api/me');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'server mode misconfigured' });
    assert.equal((await serve(e, '/vault.json')).status, 503);
  }
});

test('DEV_USER_EMAIL works only without a JWT and only on localhost', async () => {
  env.DEV_USER_EMAIL = 'editor@example.com';
  let res = await serve(env, '/api/me', { origin: 'http://localhost:8788', deps });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).email, 'editor@example.com');
  res = await serve(env, '/api/me', { deps });
  assert.equal(res.status, 403, 'not on a public host');
  res = await serve(env, '/api/me', { origin: 'http://localhost:8788', token: 'not.a.jwt', deps });
  assert.equal(res.status, 403, 'a bad JWT never falls back to the dev user');
});

// ---------- static files ----------
test('catalog.json is trimmed to visible projects, filters and registry included, server flag set', async () => {
  const ids = async (email) => (await call(email, '/catalog.json')).body.docs.map((d) => d.id).sort();
  assert.deepEqual(await ids('viewer@example.com'), [1, 2]);
  assert.deepEqual(await ids('star@example.com'), [1, 2, 3], '* does not include the index project');
  assert.deepEqual(await ids('idx@example.com'), [4]);
  assert.deepEqual(await ids('owner@example.com'), [1, 2, 3, 4]);
  const c = (await call('viewer@example.com', '/catalog.json')).body;
  assert.equal(c.server, true);
  assert.deepEqual(Object.keys(c.projects).sort(), ['alpha', 'alpha/sub']);
  assert.deepEqual(c.filters.map((f) => f.name), ['pending', 'not beta']);
  assert.deepEqual(c.statuses, ['待處理', '待確認', '已確認', '已發布', '封存']);
});

test('search-index.json only has rows of visible docs', async () => {
  const r = await call('viewer@example.com', '/search-index.json');
  assert.deepEqual(r.body.map((x) => x.id), [1, 2]);
  assert.match(r.headers.get('cache-control'), /no-store/);
});

test('/docs/* is gated by project; unknown files are owner-only; /vault.json is always 404', async () => {
  assert.equal((await call('viewer@example.com', '/docs/alpha/a.md')).status, 200);
  assert.equal((await call('viewer@example.com', '/docs/alpha/sub/b%20%E5%A0%B1%E5%91%8A.html')).status, 308, 'Pages redirects x.html to x');
  const pretty = await call('viewer@example.com', '/docs/alpha/sub/b%20%E5%A0%B1%E5%91%8A');
  assert.equal(pretty.status, 200, 'pretty URL without .html maps to the doc');
  assert.equal(pretty.body, '<p>B</p>');
  assert.equal((await call('viewer@example.com', '/docs/beta/c.md')).status, 403);
  assert.equal((await call('star@example.com', '/docs/README.md')).status, 403);
  assert.equal((await call('idx@example.com', '/docs/README.md')).status, 200);
  assert.equal((await call('viewer@example.com', '/docs/stray.txt')).status, 403);
  assert.equal((await call('owner@example.com', '/docs/stray.txt')).status, 200);
  assert.equal((await call('owner@example.com', '/vault.json')).status, 404);
  assert.equal((await call('viewer@example.com', '/')).status, 200);
  assert.equal((await call('viewer@example.com', '/index.html')).status, 308, 'Pages redirects /index.html to /');
});

test('percent-encoded, double-slash, dot-segment and mixed-case paths are evaluated after decoding (fail closed)', async () => {
  const v = (p, opts) => call('viewer@example.com', p, opts);
  for (const p of ['/docs%2Fbeta%2Fc.md', '/%64ocs/beta/c.md', '/docs%2Fstray.txt', '//docs/beta/c.md', '/docs//beta/c.md',
    '/docs/alpha/%2e%2e/beta/c.md']) {
    assert.equal((await v(p)).status, 403, p);
  }
  for (const p of ['/vault.json', '/vault%2Ejson', '/%76ault.json', '//vault.json', '/VAULT.json', '/Docs/beta/c.md', '/DOCS%2Fbeta%2Fc.md',
    '/docs/alpha/%252e%252e/beta/c.md', '/docs%252Fbeta%252Fc.md', '/docs/alpha%5C..%5Cbeta%5Cc.md', '/docs/alpha/a.md%00', '/%61pi/me',
    '/docs/alpha/sub/..%2F..%2Fbeta/c.md']) {
    assert.equal((await v(p)).status, 404, p);
  }
  assert.equal((await v('/docs/%E0%A4%A')).status, 400, 'malformed escape');
  for (const p of ['/catalog%2Ejson', '/catalog.json']) assert.deepEqual((await v(p)).body.docs.map((d) => d.id), [1, 2], p);
  assert.deepEqual((await v('/search-index%2Ejson')).body.map((r) => r.id), [1, 2]);
  for (const p of ['/docs/beta/c.md', '/vault.json', '/vault%2Ejson']) {
    assert.ok([403, 404].includes((await v(p, { method: 'HEAD' })).status), `HEAD ${p}`);
  }
  // an allowed encoded path is forwarded in canonical form, so the file served is the one checked
  const ok = await serve(env, '/docs%2Falpha%2Fa.md', { token: await tokenFor('viewer@example.com'), deps });
  assert.equal(ok.status, 200);
  assert.equal(ok.forwarded, '/docs/alpha/a.md');
  assert.equal(await ok.text(), '# A');
});

test('default-deny: only listed shell files pass; files the build adds later are 404 until listed', async () => {
  const base = env.ASSETS;
  env.ASSETS = { fetch: (r) => (new URL(r.url).pathname === '/leak.txt' ? new Response('leak') : base.fetch(r)) };
  for (const p of ['/leak.txt', '/%6Ceak.txt', '/nope', '/docs-backup/c.md', '/icons/../vault.json', '/icons/.hidden', '/icons/a/b.svg']) {
    assert.equal((await call('owner@example.com', p)).status, 404, p);
  }
  for (const p of ['/', '/app.js', '/sw.js', '/icons/icon.svg', '/%61pp.js']) {
    assert.equal((await call('viewer@example.com', p)).status, 200, p);
  }
  assert.equal((await call('viewer@example.com', '/index.html')).status, 308, 'Pages redirects /index.html to /');
  for (const p of ['/', '/index.html']) assert.equal((await call('viewer@example.com', p)).headers.get('content-security-policy'), SHELL_CSP);
  assert.equal((await call('viewer@example.com', '/app.js')).headers.get('content-security-policy'), null);
});

test('the shell allowlist matches site/ exactly (keep functions/_lib/gate.js SHELL_FILES in sync)', () => {
  const site = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'site');
  const files = fs.readdirSync(site, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => `/${path.relative(site, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/')}`)
    .filter((p) => p !== '/_headers');
  assert.deepEqual(files.filter((p) => !isShellPath(p)), [], 'site/ files missing from SHELL_FILES');
  assert.deepEqual([...SHELL_FILES].filter((p) => p !== '/' && !files.includes(p)), [], 'SHELL_FILES entries with no site/ file');
});

test('/docs/* responses carry the sandbox CSP and nosniff from the gate, overriding any merged header', async () => {
  const base = env.ASSETS;
  env.ASSETS = { fetch: async (r) => { const res = await base.fetch(r); const out = new Response(res.body, res); out.headers.set('content-security-policy', "frame-ancestors 'none'"); return out; } };
  for (const [email, p] of [['viewer@example.com', '/docs/alpha/a.md'], ['viewer@example.com', '/docs/alpha/sub/b%20%E5%A0%B1%E5%91%8A'], ['owner@example.com', '/docs/stray.txt']]) {
    const r = await call(email, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-security-policy'), DOC_CSP, p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(r.headers.get('cache-control'), 'private, no-cache', p);
  }
  assert.equal((await call('idx@example.com', '/docs/alpha/sub/b%20%E5%A0%B1%E5%91%8A')).status, 403, 'extensionless HTML form is gated too');
});

test('normalizePath: one decode, slashes collapsed, leftovers refused', () => {
  assert.deepEqual(normalizePath('/docs%2Fa%20b.md'), { path: '/docs/a b.md' });
  assert.deepEqual(normalizePath('//docs///a.md'), { path: '/docs/a.md' });
  assert.deepEqual(normalizePath('/docs/%25'), { status: 404 });
  assert.deepEqual(normalizePath('/docs/%5Ca'), { status: 404 });
  assert.deepEqual(normalizePath('/docs/%2E%2E/x'), { status: 404 });
  assert.deepEqual(normalizePath('/docs/%E0%A4%A'), { status: 400 });
});

test('catalog.json drops related / supersedes links to docs the user cannot see', () => {
  const c = catalogFixture();
  Object.assign(c.docs[0], { related: [2, 3, '#3', '4'] });
  Object.assign(c.docs[1], { supersedes: 3 });
  c.docs[2].related = [1];
  const viewer = { owner: false, roles: { alpha: 'viewer' } };
  const out = catalogFor(viewer, c);
  assert.deepEqual(out.docs.find((d) => d.id === 1).related, [2]);
  assert.equal('supersedes' in out.docs.find((d) => d.id === 2), false);
  assert.deepEqual(c.docs[0].related, [2, 3, '#3', '4'], 'the cached catalog is not mutated');
  assert.equal(catalogFor({ owner: true, roles: {} }, c).docs.find((d) => d.id === 2).supersedes, 3);
});

// ---------- CSRF ----------
test('mutating /api calls need a JSON content type and a same-origin signal', async () => {
  const note = (headers) => call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: 'hi' }, headers });
  assert.equal((await note({ 'content-type': 'text/plain' })).status, 403, 'text/plain form post');
  assert.equal((await note({ 'content-type': 'application/x-www-form-urlencoded' })).status, 403);
  assert.equal((await note({ 'content-type': 'application/json-patch+json' })).status, 403, 'exact media type');
  assert.equal((await note({ 'content-type': null })).status, 403);
  assert.equal((await note({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example.net' })).status, 403, 'cross-origin');
  assert.equal((await note({ 'sec-fetch-site': null, origin: 'https://evil.example.net' })).status, 403);
  assert.equal((await note({ 'sec-fetch-site': null })).status, 403, 'no Origin, no Sec-Fetch-Site');
  assert.equal((await note({ 'sec-fetch-site': null, origin: ORIGIN, 'content-type': 'Application/JSON; charset=utf-8' })).status, 201, 'Origin match');
  assert.equal((await note({})).status, 201, 'Sec-Fetch-Site: same-origin');
  assert.equal((await call('owner@example.com', '/api/users/star@example.com', { method: 'DELETE', headers: { 'content-type': null } })).status, 403, 'DELETE without a body too');
  assert.equal(rows('SELECT * FROM notes').length, 2);
  assert.equal((await call('viewer@example.com', '/api/me', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200, 'GET is not affected');
});

test('readJson refuses oversized bodies by Content-Length before reading, and while reading chunked bodies', async () => {
  let pulled = 0;
  const endless = () => new ReadableStream({ pull(ctrl) { pulled++; ctrl.enqueue(new Uint8Array(1024).fill(32)); } });
  const declared = new Request(ORIGIN, { method: 'POST', body: endless(), duplex: 'half', headers: { 'content-length': '999999' } });
  await assert.rejects(readJson(declared, 4096), { status: 400, message: 'request body too large' });
  assert.equal(pulled <= 1, true, 'body not read when Content-Length is over the limit');
  pulled = 0;
  const chunked = new Request(ORIGIN, { method: 'POST', body: endless(), duplex: 'half' });
  await assert.rejects(readJson(chunked, 4096), { status: 400 });
  assert.ok(pulled < 10, `stopped after ${pulled} chunks`);
  const fine = new Request(ORIGIN, { method: 'POST', body: JSON.stringify({ a: '報告' }) });
  assert.deepEqual(await readJson(fine, 64), { a: '報告' });
  const r = await call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: JSON.stringify({ body: 'x'.repeat(70000) }) });
  assert.equal(r.status, 400);
});

// ---------- workflow ----------
test('PATCH /api/docs/:id: editor+ only, validates, writes doc_state and one history row per field', async () => {
  assert.equal((await call('viewer@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '待確認' } })).status, 403);
  assert.equal((await call('editor@example.com', '/api/docs/3', { method: 'PATCH', body: { status: '待確認' } })).status, 404, 'invisible doc looks missing');
  assert.equal((await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '草稿' } })).status, 400);
  assert.equal((await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { assignee: 'not-an-email' } })).status, 400);
  assert.equal((await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { title: 'x' } })).status, 400);

  const r = await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '待確認', reviewer: 'Manager@Example.com', tags: ['a', 'a', 'b'] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, '待確認');
  assert.equal(r.body.reviewer, 'manager@example.com');
  assert.deepEqual(r.body.tags, ['a', 'b']);
  assert.equal(r.body.updated_by, 'editor@example.com');
  const h = rows("SELECT field, old, new FROM history WHERE path = 'docs/alpha/a.md' ORDER BY id");
  assert.deepEqual(h, [
    { field: 'status', old: '待處理', new: '待確認' },
    { field: 'reviewer', old: null, new: 'manager@example.com' },
    { field: 'tags', old: '[]', new: '["a","b"]' },
  ]);
  // no-op patch: no new history
  await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '待確認' } });
  assert.equal(rows("SELECT * FROM history WHERE path = 'docs/alpha/a.md'").length, 3);
  // a cleared person is stored as '' (explicitly nobody), so clients can tell it from "no override"
  const cleared = await call('editor@example.com', '/api/docs/2', { method: 'PATCH', body: { assignee: '' } });
  assert.equal(cleared.body.assignee, '');
  assert.equal((await call('viewer@example.com', '/api/state')).body.docs['docs/alpha/sub/b 報告.html'].assignee, '');
  // '*' viewer + beta editor can edit beta
  assert.equal((await call('mixed@example.com', '/api/docs/3', { method: 'PATCH', body: { assignee: 'mixed@example.com' } })).status, 200);
  assert.equal((await call('mixed@example.com', '/api/docs/1', { method: 'PATCH', body: { assignee: null } })).status, 403);
});

test('GET /api/state returns overrides for visible docs only, with note counts', async () => {
  await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '已確認' } });
  await call('mixed@example.com', '/api/docs/3', { method: 'PATCH', body: { status: '封存' } });
  await call('viewer@example.com', '/api/docs/2/notes', { method: 'POST', body: { body: 'looks good' } });
  const s = (await call('viewer@example.com', '/api/state')).body.docs;
  assert.deepEqual(Object.keys(s).sort(), ['docs/alpha/a.md', 'docs/alpha/sub/b 報告.html']);
  assert.equal(s['docs/alpha/a.md'].status, '已確認');
  assert.equal(s['docs/alpha/a.md'].notes, 0);
  assert.deepEqual([s['docs/alpha/sub/b 報告.html'].status, s['docs/alpha/sub/b 報告.html'].notes, s['docs/alpha/sub/b 報告.html'].assignee], ['待確認', 1, 'editor@example.com']);
});

test('notes: viewers can add and read; length limits; history records the note', async () => {
  let r = await call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: '  first note  ' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.body, 'first note');
  assert.equal((await call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: '' } })).status, 400);
  assert.equal((await call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: 'x'.repeat(4001) } })).status, 400);
  assert.equal((await call('viewer@example.com', '/api/docs/3/notes', { method: 'POST', body: { body: 'hi' } })).status, 404);
  r = await call('editor@example.com', '/api/docs/1/notes');
  assert.deepEqual(r.body.map((n) => [n.author, n.body]), [['viewer@example.com', 'first note']]);
  r = await call('editor@example.com', '/api/docs/1/history');
  assert.deepEqual(r.body.map((h) => [h.action, h.new]), [['note', String(rows('SELECT id FROM notes')[0].id)]]);
});

// ---------- vault ----------
test('vault reveal: editor+ of the project, name must be referenced by the doc, audited, no-store', async () => {
  const body = { id: 1, name: 'alpha/token', action: 'show' };
  assert.equal((await call('viewer@example.com', '/api/vault/reveal', { method: 'POST', body })).status, 403);
  assert.equal((await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { ...body, name: 'beta/token' } })).status, 403, 'not referenced by doc 1');
  assert.equal((await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { id: 3, name: 'beta/token', action: 'show' } })).status, 404);
  assert.equal((await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { ...body, action: 'steal' } })).status, 400);
  const r = await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { ...body, action: 'copy' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.value, 'alpha-secret-value');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(rows('SELECT email, name, path, action FROM vault_audit'), [{ email: 'editor@example.com', name: 'alpha/token', path: 'docs/alpha/a.md', action: 'copy' }]);
});

test('vault reveal fails closed with a wrong key', async () => {
  env.VAULT_KEY = Buffer.alloc(32, 7).toString('base64');
  const r = await call('editor@example.com', '/api/vault/reveal', { method: 'POST', body: { id: 1, name: 'alpha/token', action: 'show' } });
  assert.equal(r.status, 500);
  assert.equal(rows('SELECT * FROM vault_audit').length, 0);
});

// ---------- users ----------
test('GET /api/users: owner sees everyone (incl. env owners); manager sees own project rows; others 403', async () => {
  assert.equal((await call('editor@example.com', '/api/users')).status, 403);
  const all = (await call('owner@example.com', '/api/users')).body;
  assert.ok(all.some((u) => u.email === 'second-owner@example.com' && u.owner));
  assert.ok(all.some((u) => u.email === 'disabled@example.com' && u.disabled));
  const mine = (await call('manager@example.com', '/api/users')).body;
  assert.deepEqual(mine.map((u) => u.email), ['disabled@example.com', 'editor@example.com', 'manager@example.com', 'viewer@example.com']);
  assert.ok(mine.every((u) => u.memberships.every((m) => m.project === 'alpha')));
});

test('POST /api/users: managers invite only into projects they manage; history written', async () => {
  let r = await call('manager@example.com', '/api/users', { method: 'POST', body: { email: 'New@Example.com', name: 'New', memberships: [{ project: 'beta', role: 'viewer' }] } });
  assert.equal(r.status, 403);
  r = await call('manager@example.com', '/api/users', { method: 'POST', body: { email: 'new@example.com', memberships: [{ project: '*', role: 'viewer' }] } });
  assert.equal(r.status, 403, 'only owners grant *');
  r = await call('manager@example.com', '/api/users', { method: 'POST', body: { email: 'new@example.com', memberships: [{ project: 'alpha', role: 'owner' }] } });
  assert.equal(r.status, 400);
  r = await call('manager@example.com', '/api/users', { method: 'POST', body: { email: 'New@Example.com', name: 'New', memberships: [{ project: 'alpha', role: 'editor' }] } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.user.memberships, [{ project: 'alpha', role: 'editor' }]);
  assert.equal(r.body.warning, undefined, 'no Access group sync configured → no warning');
  assert.deepEqual(rows("SELECT action FROM history WHERE actor = 'manager@example.com' ORDER BY id").map((x) => x.action), ['user.create', 'membership']);
  // new user can now sign in
  assert.equal((await call('new@example.com', '/api/me')).status, 200);
  // existing user invited by another project's manager: memberships merge; the answer does not tell it existed
  r = await call('bmanager@example.com', '/api/users', { method: 'POST', body: { email: 'new@example.com', memberships: [{ project: 'beta', role: 'viewer' }] } });
  assert.equal(r.status, 201);
  assert.equal('existing' in r.body, false);
  assert.deepEqual(r.body.user, { email: 'new@example.com', memberships: [{ project: 'beta', role: 'viewer' }] }, 'bmanager sees only beta rows');
  assert.deepEqual(rows("SELECT project FROM memberships WHERE email = 'new@example.com' ORDER BY project").map((x) => x.project), ['alpha', 'beta']);
});

test('PATCH /api/users/:email: managers edit only their rows, owners disable; DELETE disables', async () => {
  let r = await call('manager@example.com', '/api/users/mixed@example.com', { method: 'PATCH', body: { memberships: [{ project: 'beta', role: null }] } });
  assert.equal(r.status, 404, 'a user the manager does not manage looks like a missing one');
  r = await call('manager@example.com', '/api/users/viewer@example.com', { method: 'PATCH', body: { memberships: [{ project: 'alpha', role: 'editor' }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user.memberships, [{ project: 'alpha', role: 'editor' }]);
  assert.equal((await call('manager@example.com', '/api/users/viewer@example.com', { method: 'PATCH', body: { disabled: true } })).status, 403);
  assert.equal((await call('manager@example.com', '/api/users/owner@example.com', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  r = await call('manager@example.com', '/api/users/viewer@example.com', { method: 'PATCH', body: { memberships: [{ project: 'alpha', role: null }] } });
  assert.equal(r.status, 200);
  assert.equal(rows("SELECT * FROM memberships WHERE email = 'viewer@example.com'").length, 0);
  // the list is the desired set within the caller's projects: omitted managed rows go, other projects stay
  await call('owner@example.com', '/api/users/viewer@example.com', { method: 'PATCH', body: { memberships: [{ project: 'alpha', role: 'viewer' }, { project: 'beta', role: 'editor' }] } });
  r = await call('manager@example.com', '/api/users/viewer@example.com', { method: 'PATCH', body: { memberships: [] } });
  assert.equal(r.status, 200);
  assert.deepEqual(rows("SELECT project, role FROM memberships WHERE email = 'viewer@example.com'"), [{ project: 'beta', role: 'editor' }]);
  assert.equal((await call('owner@example.com', '/api/users/viewer@example.com', { method: 'PATCH', body: { memberships: [] } })).status, 200);
  assert.equal(rows("SELECT * FROM memberships WHERE email = 'viewer@example.com'").length, 0, 'owner list replaces everything');

  r = await call('owner@example.com', '/api/users/editor@example.com', { method: 'PATCH', body: { disabled: true } });
  assert.equal(r.status, 200);
  assert.equal((await call('editor@example.com', '/api/me')).status, 403);
  assert.equal((await call('owner@example.com', '/api/users/second-owner@example.com', { method: 'DELETE' })).status, 400);
  assert.equal((await call('manager@example.com', '/api/users/star@example.com', { method: 'DELETE' })).status, 403);
  assert.equal((await call('owner@example.com', '/api/users/star@example.com', { method: 'DELETE' })).status, 200);
  assert.equal(rows("SELECT disabled FROM users WHERE email = 'star@example.com'")[0].disabled, 1);
});

// enabled seed users with a membership, plus OWNER_EMAILS
const GROUP_BASE = ['bmanager@example.com', 'editor@example.com', 'idx@example.com', 'manager@example.com', 'mixed@example.com',
  'owner@example.com', 'second-owner@example.com', 'star@example.com', 'viewer@example.com'];
const SYNC_ENV = { ACCESS_GROUP_ID: 'g1', CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acc' };

/** Fake Access group API; `hooks.beforePut(body)` runs before a PUT is applied. */
function groupApi(include, hooks = {}) {
  const group = { id: 'g1', name: 'docs', include, exclude: [], require: [] };
  const f = async (url, init = {}) => {
    if (url.includes('/cdn-cgi/access/certs')) return deps.fetch(url);
    assert.match(url, /accounts\/acc\/access\/groups\/g1$/);
    if ((init.method || 'GET') === 'GET') { f.gets++; return new Response(JSON.stringify({ success: true, result: structuredClone(group) })); }
    f.puts++;
    const b = JSON.parse(init.body);
    await hooks.beforePut?.(b);
    group.include = b.include;
    return new Response(JSON.stringify({ success: true, result: group }));
  };
  f.gets = 0; f.puts = 0; f.group = group;
  f.emails = () => group.include.filter((r) => r.email).map((r) => r.email.email);
  return f;
}

test('Access group sync writes the full set from D1, keeps non-email rules, and drops stale emails', async () => {
  const cf = groupApi([{ email: { email: 'owner@example.com' } }, { email: { email: 'stale@example.com' } }, { group: { id: 'other' } }]);
  env = await makeEnv(SYNC_ENV);
  const opts = (o) => ({ ...o, deps: { fetch: cf } });
  let r = await call('owner@example.com', '/api/users', opts({ method: 'POST', body: { email: 'synced@example.com', memberships: [{ project: 'alpha', role: 'viewer' }] } }));
  assert.equal(r.status, 201);
  assert.equal(r.body.warning, undefined);
  assert.deepEqual(cf.group.include[0], { group: { id: 'other' } }, 'non-email rules preserved');
  assert.deepEqual(cf.emails(), [...GROUP_BASE, 'synced@example.com'].sort());
  await call('owner@example.com', '/api/users/synced@example.com', opts({ method: 'DELETE' }));
  assert.deepEqual(cf.emails(), GROUP_BASE);
  // losing the last membership removes the user; a new membership adds them back; losing one of several changes nothing
  await call('manager@example.com', '/api/users/viewer@example.com', opts({ method: 'PATCH', body: { memberships: [] } }));
  assert.deepEqual(cf.emails(), GROUP_BASE.filter((e) => e !== 'viewer@example.com'));
  // without a membership in their project the user is out of the manager's reach: they invite them again
  await call('manager@example.com', '/api/users', opts({ method: 'POST', body: { email: 'viewer@example.com', memberships: [{ project: 'alpha', role: 'viewer' }] } }));
  assert.deepEqual(cf.emails(), GROUP_BASE);
  const puts = cf.puts;
  await call('owner@example.com', '/api/users/mixed@example.com', opts({ method: 'PATCH', body: { memberships: [{ project: 'beta', role: 'editor' }] } }));
  assert.equal(cf.puts, puts, 'group already correct: no PUT');
  // disable / enable
  await call('owner@example.com', '/api/users/editor@example.com', opts({ method: 'PATCH', body: { disabled: true } }));
  assert.equal(cf.emails().includes('editor@example.com'), false);
  await call('owner@example.com', '/api/users/editor@example.com', opts({ method: 'PATCH', body: { disabled: false } }));
  assert.equal(cf.emails().includes('editor@example.com'), true);

  const broken = async (url) => (url.includes('/cdn-cgi/') ? deps.fetch(url) : new Response(JSON.stringify({ success: false, errors: [{ message: 'denied' }] }), { status: 403 }));
  r = await call('owner@example.com', '/api/users', { method: 'POST', body: { email: 'later@example.com', memberships: [] }, deps: { fetch: broken } });
  assert.equal(r.status, 201);
  assert.match(r.body.warning, /Access group sync failed: GET 403 denied/);
  assert.equal(rows("SELECT * FROM users WHERE email = 'later@example.com'").length, 1, 'D1 change kept');
});

test('Access group sync refuses to empty the group', async () => {
  const cf = groupApi([{ email: { email: 'last@example.com' } }]);
  const warning = await syncAccessGroup(SYNC_ENV, createD1(), cf); // no users, no OWNER_EMAILS
  assert.match(warning, /skipped: the group would be left empty/);
  assert.equal(cf.puts, 0);
});

test('concurrent writers: a PUT based on a stale D1 read is followed by a corrective sync', async () => {
  env = await makeEnv(SYNC_ENV);
  let raced = false;
  const cf = groupApi([], {
    async beforePut() {
      if (raced) return;
      raced = true;
      // another request commits and finishes its own sync while this PUT is in flight
      env.DB.raw.prepare("INSERT INTO users (email, name, disabled, created_at, created_by) VALUES ('b@example.com', 'b', 0, 'x', 'seed')").run();
      env.DB.raw.prepare("INSERT INTO memberships (email, project, role) VALUES ('b@example.com', 'alpha', 'viewer')").run();
      assert.equal(await syncAccessGroup(env, env.DB, cf), null);
    },
  });
  assert.equal(await syncAccessGroup(env, env.DB, cf), null);
  assert.deepEqual(cf.emails(), [...GROUP_BASE, 'b@example.com'].sort(), 'the stale writer re-syncs instead of dropping b');

  // two invitations at once through the API: both end up in the group
  const cf2 = groupApi([]);
  await Promise.all([
    call('owner@example.com', '/api/users', { method: 'POST', body: { email: 'c@example.com', memberships: [{ project: 'alpha', role: 'viewer' }] }, deps: { fetch: cf2 } }),
    call('owner@example.com', '/api/users', { method: 'POST', body: { email: 'd@example.com', memberships: [{ project: 'beta', role: 'viewer' }] }, deps: { fetch: cf2 } }),
  ]);
  assert.deepEqual(cf2.emails(), [...GROUP_BASE, 'b@example.com', 'c@example.com', 'd@example.com'].sort());
});

// ---------- owner tools ----------
test('audit and export are owner-only', async () => {
  await call('editor@example.com', '/api/docs/1', { method: 'PATCH', body: { status: '已確認' } });
  await call('viewer@example.com', '/api/docs/1/notes', { method: 'POST', body: { body: 'n1' } });
  assert.equal((await call('manager@example.com', '/api/audit')).status, 403);
  const a = (await call('owner@example.com', '/api/audit?limit=2')).body;
  assert.equal(a.history.length, 2);
  assert.ok(Array.isArray(a.vault));
  assert.equal((await call('manager@example.com', '/api/export/state')).status, 403);
  const e = (await call('owner@example.com', '/api/export/state?since=2000-01-01T00:00:00Z')).body;
  assert.deepEqual(e.docs.map((d) => [d.path, d.status]), [['docs/alpha/a.md', '已確認']]);
  assert.deepEqual(e.notes.map((n) => n.body), ['n1']);
});

test('unknown routes 404, wrong methods 405', async () => {
  assert.equal((await call('viewer@example.com', '/api/nope')).status, 404);
  assert.equal((await call('viewer@example.com', '/api/state', { method: 'POST', body: {} })).status, 405);
});
