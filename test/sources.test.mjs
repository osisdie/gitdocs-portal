// External content sources: config validation, sources:pull, mount path mapping, symlink / dot-file / escape
// rejection, vault namespace at build, missing-source behaviour, vault CLI on mounted files, project visibility CLI.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createVault, deriveKey, seal } from '../site/vault-core.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdocs-sources-'));
const CONTENT = path.join(T, 'content');
const SRC = path.join(T, 'src');
const DIST = path.join(T, 'dist');
process.env.CONTENT_DIR = CONTENT; // before catalog.mjs is imported
let lib;

const write = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Acme Writer', '-c', 'user.email=Writer@Acme.example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
const env = (extra = {}) => ({ ...process.env, CONTENT_DIR: CONTENT, DIST_DIR: DIST, ...extra });
const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { env: env(extra), encoding: 'utf8' });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const catalogFile = () => readJson(path.join(CONTENT, 'docs/catalog.json'));
const setSources = (sources) => { const c = catalogFile(); c.site.sources = sources; fs.writeFileSync(path.join(CONTENT, 'docs/catalog.json'), JSON.stringify(c, null, 2)); };
const AWS = 'AKIAABCDEFGHIJKLMNOP';
const PASS = 'test passphrase for sources';

before(async () => {
  // the other organisation's repo
  write(SRC, 'docs/guide.md', '# Guide\n\nUse {{vault:acme/key}} for the API.\n');
  write(SRC, 'docs/team/plan.md', '# Team plan\n');
  write(SRC, 'docs/mixed.html', '<title>Mixed</title><body><p>{{vault:acme/key}} and {{vault:alpha/token}}</p></body>');
  write(SRC, 'docs/leak.md', `# Leak\n\naws key ${AWS}\n`);
  write(SRC, 'docs/.hidden.md', '# hidden\n');
  write(SRC, 'docs/img.png', 'PNG');
  write(SRC, 'outside.md', '# outside the mount\n');
  fs.symlinkSync('../outside.md', path.join(SRC, 'docs/link.md'));
  fs.symlinkSync('/etc/hostname', path.join(SRC, 'docs/etc.md'));
  fs.symlinkSync('..', path.join(SRC, 'docs/linkdir'));
  git(SRC, 'init', '-q', '-b', 'main');
  git(SRC, 'add', '-A');
  git(SRC, 'commit', '-q', '-m', 'acme: first docs');

  // the host content repo
  write(CONTENT, '.gitignore', '.sources/\n');
  write(CONTENT, 'docs/alpha/a.md', '# A\n\n{{vault:alpha/token}}\n');
  write(CONTENT, 'docs/catalog.json', JSON.stringify({
    site: { title: 'host', sources: [{ name: 'acme', repo: 'https://git.example.invalid/acme/docs.git', ref: 'main', path: 'docs' }] },
  }));
  const { vault } = await createVault(PASS);
  const key = await deriveKey(PASS, vault.kdf);
  for (const [n, v] of [['alpha/token', 'alpha-secret'], ['acme/key', 'acme-secret']]) vault.secrets[n] = { ...(await seal(key, n, v)), note: '', updated: '2026-11-22' };
  write(CONTENT, 'vault/vault.json', JSON.stringify(vault));
  git(CONTENT, 'init', '-q', '-b', 'main');
  git(CONTENT, 'add', '-A');
  git(CONTENT, 'commit', '-q', '-m', 'host');
  lib = await import('../scripts/lib/catalog.mjs');
});

test('site.sources validation: names, paths, refs, duplicates', () => {
  const bad = [
    [{ name: '../x' }], [{ name: 'Acme' }], [{ name: 'a/b' }], [{ name: '-x' }], [{ name: 'notes' }], [{ name: '' }],
    [{ name: 'a', path: '../up' }], [{ name: 'a', path: '/etc' }], [{ name: 'a', path: 'docs/../..' }], [{ name: 'a', path: 'C:/x' }],
    [{ name: 'a', path: '.git' }], [{ name: 'a', path: 'a\\b' }], [{ name: 'a', ref: '--upload-pack=x' }], [{ name: 'a', ref: 'a..b' }],
    [{ name: 'a', depth: 0 }], [{ name: 'a' }, { name: 'a' }], 'nope', [null],
  ];
  for (const sources of bad) assert.throws(() => lib.sourceList({ sources }), Error, JSON.stringify(sources));
  assert.deepEqual(lib.sourceList({ sources: [{ name: 'acme-2', repo: 'r', path: './docs/x/' }] }),
    [{ name: 'acme-2', repo: 'r', ref: 'main', path: 'docs/x', depth: null }]);
  assert.equal(lib.sourceEnvName('acme-2'), 'SOURCE_ACME_2_URL');
});

test('redact masks URL credentials; resolveUrl refuses option-like and ext:: URLs', async () => {
  const { redact, resolveUrl } = await import('../scripts/sources.mjs');
  assert.equal(redact('fatal: https://deploy:glpat-secret123@git.example.com/a.git'), 'fatal: https://***@git.example.com/a.git');
  assert.equal(redact('token glpat-secret123 here', ['glpat-secret123']), 'token *** here');
  for (const repo of ['--upload-pack=touch /tmp/x', 'ext::sh -c id', 'http://git.example.com/a.git', 'relative/path', 'https://x/a b']) {
    assert.throws(() => resolveUrl({ name: 'a', repo }, {}), Error, repo);
  }
  assert.equal(resolveUrl({ name: 'a', repo: 'https://git.example.com/a.git' }, { SOURCE_A_URL: 'git@git.example.com:a/b.git' }), 'git@git.example.com:a/b.git');
});

test('sources:pull checks out the ref via SOURCE_<NAME>_URL without writing the URL to disk', () => {
  const r = run('sources.mjs', ['pull'], { SOURCE_ACME_URL: `file://${SRC}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ acme: main → [0-9a-f]{12} \(4 docs at docs\/acme\/\)/);
  const repo = path.join(CONTENT, '.sources/acme');
  assert.ok(fs.existsSync(path.join(repo, 'docs/guide.md')));
  assert.equal(fs.existsSync(path.join(repo, '.git/FETCH_HEAD')), false);
  const texts = ['config', 'HEAD', ...(fs.existsSync(path.join(repo, '.git/logs')) ? fs.readdirSync(path.join(repo, '.git/logs'), { recursive: true }).map((f) => `logs/${f}`) : [])]
    .map((f) => path.join(repo, '.git', f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, 'utf8'));
  assert.ok(texts.every((t) => !t.includes(SRC)), 'source URL is not stored in .git');
  // a failing source fails the command, with credentials masked
  const bad = run('sources.mjs', ['pull'], { SOURCE_ACME_URL: 'https://deploy:glpat-supersecret@git.example.invalid/acme.git' });
  assert.equal(bad.status, 1);
  assert.doesNotMatch(bad.stderr + bad.stdout, /glpat-supersecret/);
  assert.ok(fs.existsSync(path.join(repo, 'docs/guide.md')), 'a failed pull leaves the last checkout in place');
});

test('mount path mapping: virtual docs/<name>/…, subprojects, source, history and reporter from the source repo', () => {
  const c = lib.loadCatalog();
  const skipped = [];
  const { items } = lib.syncCatalog(c, { onSkip: (rel, why) => skipped.push(`${rel}: ${why}`) });
  const keys = Object.keys(c.docs).sort();
  assert.deepEqual(keys, ['docs/acme/guide.md', 'docs/acme/leak.md', 'docs/acme/mixed.html', 'docs/acme/team/plan.md', 'docs/alpha/a.md']);
  const it = (rel) => items.find((x) => x.rel === rel);
  assert.deepEqual([c.docs['docs/acme/team/plan.md'].project, c.docs['docs/acme/team/plan.md'].subproject], ['acme', 'team']);
  assert.equal(lib.toRecord(it('docs/acme/guide.md')).source, 'acme');
  assert.equal(lib.toRecord(it('docs/alpha/a.md')).source, undefined);
  assert.equal(c.docs['docs/acme/guide.md'].reporter, 'writer@acme.example.com');
  assert.deepEqual(lib.gitHistory('docs/acme/guide.md', 5, it('docs/acme/guide.md').loc).map((h) => h.subject), ['acme: first docs']);
  assert.equal(c.docs['docs/acme/leak.md'].sensitivity, '極機密', 'sensitivity detection runs on source files');
  assert.ok(c.projects.acme && c.projects['acme/team']);
  assert.deepEqual(skipped.sort(), ['docs/acme/etc.md: symlink', 'docs/acme/link.md: symlink', 'docs/acme/linkdir: symlink']);
  // vault namespace on the record
  assert.deepEqual(it('docs/acme/mixed.html').vaultRefs, ['acme/key']);
  assert.deepEqual(it('docs/acme/mixed.html').blockedRefs, ['alpha/token']);
  assert.equal(lib.toRecord(it('docs/acme/mixed.html')).vaultBlocked, 1);
  assert.doesNotMatch(it('docs/acme/mixed.html').text, /alpha\/token/);
  assert.deepEqual(it('docs/alpha/a.md').vaultRefs, ['alpha/token'], 'local docs may reference anything');
  lib.saveCatalog(c);
});

test('a mount root that is a symlink, or a source that shadows a local folder, is refused', () => {
  const m = lib.mountsOf({ sources: [{ name: 'acme', path: 'docs/linkdir' }] })[0];
  assert.equal(m.available, false, 'symlinked mount root');
  assert.deepEqual(lib.mountFiles(m), []);
  fs.mkdirSync(path.join(CONTENT, 'docs/beta'));
  try {
    assert.throws(() => lib.mountsOf({ sources: [{ name: 'beta' }] }), /collides with the local docs\/beta/);
    assert.throws(() => lib.mountsOf({ projectRoot: '', sources: [{ name: 'alpha' }] }), /collides/);
  } finally { fs.rmdirSync(path.join(CONTENT, 'docs/beta')); }
});

test('build: mounted files deployed under docs/<name>/, foreign vault refs stripped, 極機密 / symlinks / dot-files not deployed', () => {
  const r = run('build.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /docs\/acme\/mixed\.html \(source acme\) references \{\{vault:alpha\/token\}\} outside acme\/ — not exposed/);
  const out = readJson(path.join(DIST, 'catalog.json'));
  const rec = (p) => out.docs.find((d) => d.path === p);
  assert.deepEqual(rec('docs/acme/mixed.html').vault, ['acme/key']);
  assert.equal(rec('docs/acme/mixed.html').vaultBlocked, 1);
  assert.equal(rec('docs/acme/mixed.html').source, 'acme');
  assert.equal(rec('docs/acme/leak.md').offline, true);
  assert.equal(out.projects.acme.source, 'acme');
  assert.equal(out.projects.acme.visibility, 'private');
  assert.equal(out.projects['acme/team'].visibility, 'private');
  assert.equal('sources' in out.site, false, 'repo URLs are not deployed');
  const html = fs.readFileSync(path.join(DIST, 'docs/acme/mixed.html'), 'utf8');
  assert.match(html, /\{\{vault:acme\/key\}\}/);
  assert.doesNotMatch(html, /alpha\/token/);
  assert.match(html, /\{\{vault-blocked\}\}/);
  assert.match(html, /<script>/, 'vault shim injected for the allowed ref');
  assert.ok(fs.existsSync(path.join(DIST, 'docs/acme/team/plan.md')));
  assert.ok(fs.existsSync(path.join(DIST, 'docs/acme/img.png')), 'assets are copied like local ones');
  for (const p of ['docs/acme/leak.md', 'docs/acme/link.md', 'docs/acme/etc.md', 'docs/acme/linkdir', 'docs/acme/.hidden.md', 'docs/acme/outside.md']) {
    assert.equal(fs.existsSync(path.join(DIST, p)), false, p);
  }
  const search = readJson(path.join(DIST, 'search-index.json'));
  assert.ok(search.every((row) => !row.t.includes('alpha/token') || row.id === rec('docs/alpha/a.md').id));
  assert.ok(!search.some((row) => row.t.includes(AWS)));
});

test('vault check / scan cover mounted files read-only; --fix refuses to touch them', () => {
  const check = run('vault.mjs', ['check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stderr, /docs\/acme\/mixed\.html（來源 acme）引用 \{\{vault:alpha\/token\}\}/);
  assert.match(check.stderr, /明文憑證 aws-access-key .*docs\/acme\/leak\.md（來源 acme/);
  const scan = run('vault.mjs', ['scan']);
  assert.match(scan.stdout, /docs\/acme\/leak\.md\s+aws-access-key/);
  write(CONTENT, 'docs/alpha/local-leak.md', `# local\n\nkey ${AWS.replace('ABCD', 'WXYZ')}\n`);
  const mountedFile = path.join(CONTENT, '.sources/acme/docs/leak.md');
  const before = fs.readFileSync(mountedFile, 'utf8');
  const fix = run('vault.mjs', ['scan', '--fix'], { VAULT_PASSPHRASE: PASS });
  assert.equal(fix.status, 1, 'refused files make the command fail');
  assert.match(fix.stderr, /不修改 docs\/acme\/leak\.md/);
  assert.equal(fs.readFileSync(mountedFile, 'utf8'), before, 'mounted file untouched');
  assert.match(fs.readFileSync(path.join(CONTENT, 'docs/alpha/local-leak.md'), 'utf8'), /\{\{vault:alpha\/local-leak\/aws-access-key\}\}/, 'local file fixed');
  const direct = run('vault.mjs', ['scan', '--fix', mountedFile], { VAULT_PASSPHRASE: PASS });
  assert.notEqual(direct.status, 0);
  assert.equal(fs.readFileSync(mountedFile, 'utf8'), before);
  fs.rmSync(path.join(CONTENT, 'docs/alpha/local-leak.md'));
});

test('missing checkout: entries kept (same ids) but not deployed; restored checkout brings them back', () => {
  const ids = Object.fromEntries(Object.entries(catalogFile().docs).map(([k, v]) => [k, v.id]));
  const repo = path.join(CONTENT, '.sources/acme');
  const away = path.join(T, 'acme-away');
  fs.renameSync(repo, away);
  try {
    const r = run('build.mjs');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /source "acme" is not checked out .* 4 catalog entries kept but not deployed/);
    assert.deepEqual(Object.fromEntries(Object.entries(catalogFile().docs).map(([k, v]) => [k, v.id])), ids, 'catalog keeps every entry');
    assert.ok(catalogFile().projects.acme, 'registry entry kept');
    const out = readJson(path.join(DIST, 'catalog.json'));
    assert.deepEqual(out.docs.map((d) => d.path), ['docs/alpha/a.md']);
    assert.equal(fs.existsSync(path.join(DIST, 'docs/acme')), false);
  } finally { fs.renameSync(away, repo); }
  assert.equal(run('build.mjs').status, 0);
  assert.deepEqual(readJson(path.join(DIST, 'catalog.json')).docs.map((d) => d.id).sort(), Object.values(ids).sort());
});

test('a file deleted in the source disappears from the catalog after a successful pull', () => {
  git(SRC, 'rm', '-q', 'docs/team/plan.md');
  git(SRC, 'commit', '-q', '-m', 'acme: drop plan');
  assert.equal(run('sources.mjs', ['pull'], { SOURCE_ACME_URL: `file://${SRC}` }).status, 0);
  const r = run('build.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(catalogFile().docs['docs/acme/team/plan.md'], undefined);
  assert.ok(catalogFile().docs['docs/acme/guide.md']);
});

test('doc CLI: project visibility is top-level only and never on the index project; build emits it', () => {
  let r = run('doc.mjs', ['project', 'alpha', 'visibility=public']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(catalogFile().projects.alpha.visibility, 'public');
  assert.notEqual(run('doc.mjs', ['project', 'acme/team', 'visibility=public']).status, 0);
  assert.notEqual(run('doc.mjs', ['project', 'alpha', 'visibility=world']).status, 0);
  write(CONTENT, 'docs/README.md', '# index\n');
  assert.equal(run('build.mjs').status, 0);
  r = run('doc.mjs', ['project', '（索引）', 'visibility=public']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不能設為 public/);
  assert.equal(run('build.mjs').status, 0);
  const out = readJson(path.join(DIST, 'catalog.json'));
  assert.equal(out.projects.alpha.visibility, 'public');
  assert.equal(out.projects['（索引）'].visibility, 'private');
  assert.equal(run('doc.mjs', ['project', 'alpha', 'visibility=private']).status, 0);
  assert.equal('visibility' in catalogFile().projects.alpha, false, 'private is the default: the key is removed');
});

test('site.people: normal builds pass it through (normalised); share builds strip it with the other staff emails', () => {
  const c = catalogFile();
  c.site.people = { 'Writer@Acme.example.com': '  Acme Writer ', 'not-an-email': 'x', 'blank@example.com': ' ' };
  fs.writeFileSync(path.join(CONTENT, 'docs/catalog.json'), JSON.stringify(c, null, 2));
  assert.equal(run('build.mjs').status, 0);
  assert.deepEqual(readJson(path.join(DIST, 'catalog.json')).site.people, { 'writer@acme.example.com': 'Acme Writer' });
  const share = run('build.mjs', ['--max-sensitivity=內部']);
  assert.equal(share.status, 0, share.stderr);
  const out = readJson(path.join(DIST, 'catalog.json'));
  assert.equal('people' in out.site, false);
  assert.ok(out.docs.every((d) => !('reporter' in d) && !('assignee' in d) && !('reviewer' in d)));
  assert.equal(catalogFile().site.people['Writer@Acme.example.com'], '  Acme Writer ', 'the source catalog is not rewritten');
});

test('tenant git vault: deployed as _vaults/<source>.json with only <source>/ names by server builds only, never a document; share builds skip it', async () => {
  const pass = 'acme vault passphrase';
  const { vault } = await createVault(pass);
  const k = await deriveKey(pass, vault.kdf);
  vault.secrets['acme/key'] = { ...(await seal(k, 'acme/key', 'acme-value')), note: 'n', updated: '2026-11-22' };
  vault.secrets['alpha/token'] = { ...(await seal(k, 'alpha/token', 'grab')), note: '', updated: '2026-11-22' };
  write(SRC, 'vault/vault.json', JSON.stringify(vault));
  write(SRC, 'docs/conf.md', '---\nsensitivity: confidential\n---\n# Conf\n\n{{vault:acme/key}}\n');
  git(SRC, 'add', '-A');
  git(SRC, 'commit', '-q', '-m', 'acme: vault + confidential doc');
  assert.equal(run('sources.mjs', ['pull'], { SOURCE_ACME_URL: `file://${SRC}` }).status, 0);
  // a static build (no D1 binding, no --server) would publish the file to anyone: it is not emitted
  let r = run('build.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /source vaults not deployed: this is not a server build/);
  assert.equal(fs.existsSync(path.join(DIST, '_vaults')), false);
  // wrangler.toml with a D1 binding marks a server build, like scripts/deploy.sh
  fs.writeFileSync(path.join(CONTENT, 'wrangler.toml'), 'name = "x"\n\n[[d1_databases]]\nbinding = "DB"\n');
  r = run('build.mjs');
  fs.rmSync(path.join(CONTENT, 'wrangler.toml'));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(DIST, '_vaults/acme.json')));
  r = run('build.mjs', ['--server']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /source "acme": vault secret "alpha\/token" is outside acme\/ — ignored/);
  assert.doesNotMatch(r.stderr, /\{\{vault:acme\/key\}\} is referenced but not in/, 'found in the source vault');
  const deployed = readJson(path.join(DIST, '_vaults/acme.json'));
  assert.deepEqual(Object.keys(deployed.secrets), ['acme/key']);
  assert.deepEqual(deployed.kdf, vault.kdf);
  const out = readJson(path.join(DIST, 'catalog.json'));
  const conf = out.docs.find((d) => d.path === 'docs/acme/conf.md');
  assert.deepEqual([conf.sensitivity, conf.declaredSensitivity, conf.gated], ['機密', '機密', true], 'declared sensitivity on a source doc');
  assert.equal(out.docs.some((d) => d.path.includes('vault.json')), false);
  // mounting the whole repo (path '') still never treats vault/vault.json as a document
  const m = lib.mountsOf({ sources: [{ name: 'acme', path: '' }] })[0];
  assert.ok(m.available);
  assert.equal(lib.mountFiles(m).some((f) => f.rel.endsWith('vault/vault.json')), false);
  assert.ok(lib.tenantVaultFile(m));
  r = run('build.mjs', ['--server', '--max-sensitivity=內部']);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(DIST, '_vaults')), false, 'share builds deploy no vaults');
  assert.equal(run('build.mjs', ['--server', '--no-vault']).status, 0);
  assert.equal(fs.existsSync(path.join(DIST, '_vaults')), false);
  // a symlinked vault is ignored
  fs.rmSync(path.join(CONTENT, '.sources/acme/vault/vault.json'));
  fs.symlinkSync(path.join(SRC, 'vault/vault.json'), path.join(CONTENT, '.sources/acme/vault/vault.json'));
  assert.equal(lib.tenantVaultFile(m), null);
  assert.equal(run('build.mjs', ['--server']).status, 0);
  assert.equal(fs.existsSync(path.join(DIST, '_vaults/acme.json')), false);
  assert.equal(run('sources.mjs', ['pull'], { SOURCE_ACME_URL: `file://${SRC}` }).status, 0, 'pull restores the checkout');
});

test('vault set in a tenant repo warns when a name leaves the vault namespace', () => {
  const tenant = path.join(T, 'acme-docs');
  fs.mkdirSync(path.join(tenant, 'docs'), { recursive: true });
  const vault = (args, input, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/vault.mjs'), ...args],
    { env: { ...process.env, CONTENT_DIR: tenant, VAULT_PASSPHRASE: 'tenant passphrase 123', ...extra }, input, encoding: 'utf8' });
  assert.equal(vault(['init']).status, 0);
  let r = vault(['set', 'acme/smtp'], 'v1');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /命名空間/);
  r = vault(['set', 'other/x'], 'v2');
  assert.match(r.stderr, /other\/x 不在這個 vault 的命名空間 acme\/ 之下/);
  r = vault(['set', 'acme/y'], 'v3', { VAULT_NAMESPACE: 'beta' });
  assert.match(r.stderr, /命名空間 beta\//, '$VAULT_NAMESPACE wins');
  assert.ok(readJson(path.join(tenant, 'vault/vault.json')).secrets['acme/smtp']);
});

test('an HTML doc whose vault refs are all blocked still gets the shim (disabled mask), without the foreign names', () => {
  write(SRC, 'docs/blocked-only.html', '<title>Blocked</title><body><p>{{vault:alpha/token}}</p></body>');
  write(SRC, 'docs/plain.html', '<title>Plain</title><body><p>no vault here</p></body>');
  git(SRC, 'add', '-A');
  git(SRC, 'commit', '-q', '-m', 'acme: blocked-only doc');
  assert.equal(run('sources.mjs', ['pull'], { SOURCE_ACME_URL: `file://${SRC}` }).status, 0);
  const r = run('build.mjs');
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(DIST, 'docs/acme/blocked-only.html'), 'utf8');
  assert.match(html, /<p>\{\{vault-blocked\}\}<\/p>/);
  assert.match(html, /<script>[\s\S]*<\/script><\/body>/, 'shim inlined');
  assert.doesNotMatch(html, /alpha\/token/);
  const rec = readJson(path.join(DIST, 'catalog.json')).docs.find((d) => d.path === 'docs/acme/blocked-only.html');
  assert.deepEqual([rec.vault, rec.vaultBlocked], [undefined, 1]);
  assert.doesNotMatch(fs.readFileSync(path.join(DIST, 'docs/acme/plain.html'), 'utf8'), /<script>/, 'docs without vault fields stay untouched');
});

test('reserved source names: "previous" (VAULT_KEY_PREVIOUS) and any name whose vault key is a deployment setting', async () => {
  for (const name of ['previous', 'notes']) assert.throws(() => lib.sourceList({ sources: [{ name }] }), /reserved/, name);
  assert.equal(lib.sourceKeyName('acme-2'), 'VAULT_KEY_ACME_2');
  const { tenantKeyName } = await import('../functions/_lib/vault.js');
  for (const name of ['acme', 'acme-2', 'a-b-c']) assert.equal(lib.sourceKeyName(name), tenantKeyName(name), 'build and server agree on the key name');
});

test('redact masks URL query strings and fragments; resolveUrl refuses them', async () => {
  const { redact, resolveUrl } = await import('../scripts/sources.mjs');
  assert.equal(redact("fatal: unable to access 'https://git.example.com/a.git?private_token=glpat-x1': 403"),
    "fatal: unable to access 'https://git.example.com/a.git?***': 403");
  assert.equal(redact('see https://git.example.com/a.git#tok=abc and more'), 'see https://git.example.com/a.git#*** and more');
  assert.equal(redact('https://u:p@git.example.com/a.git?x=1'), 'https://***@git.example.com/a.git?***');
  for (const repo of ['https://git.example.com/a.git?private_token=glpat-x1', 'https://git.example.com/a.git#frag']) {
    assert.throws(() => resolveUrl({ name: 'a', repo }, {}), (e) => /query string or fragment/.test(e.message) && !e.message.includes('glpat-x1') && !e.message.includes('#frag'), repo);
    assert.throws(() => resolveUrl({ name: 'a', repo: 'https://git.example.com/a.git' }, { SOURCE_A_URL: repo }), /query string or fragment/);
  }
  assert.equal(resolveUrl({ name: 'a', repo: 'https://deploy:tok@git.example.com/a.git' }, {}), 'https://deploy:tok@git.example.com/a.git');
});
