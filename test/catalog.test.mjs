// Workflow statuses in scripts/lib/catalog.mjs: idempotent migration of old values, defaults, reporter from git.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdocs-catalog-'));
process.env.CONTENT_DIR = dir; // must be set before catalog.mjs is imported
let lib;

const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const git = (...args) => execFileSync('git', ['-c', 'user.name=Author', '-c', 'user.email=Author@Example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });

before(async () => {
  write('docs/alpha/2026-11-01-old-draft.md', '# Old draft\n');
  write('docs/alpha/2026-11-02-old-review.md', '# Old review\n');
  write('docs/alpha/2026-11-03-old-local.md', '# Old local\n');
  write('docs/alpha/2026-11-04-old-local-url.html', '<!-- https://example.com/published -->\n<title>Old local with url</title>');
  write('docs/notes/1.md', '# notes are not documents\n');
  const entry = (id, status, extra = {}) => ({ id, title: 't', project: 'alpha', subproject: '', category: '報告', status, sensitivity: '內部', date: '2026-11-01', url: '', desc: '', tags: [], related: [], ...extra });
  write('docs/catalog.json', JSON.stringify({
    statuses: ['草稿', '審查中', '本機', '已發布', '封存', '自訂'],
    filters: [{ name: 'drafts', query: 's:草稿 -status:"本機" p:alpha' }],
    docs: {
      'docs/alpha/2026-11-01-old-draft.md': entry(1, '草稿'),
      'docs/alpha/2026-11-02-old-review.md': entry(2, '審查中', { reporter: 'kept@example.com' }),
      'docs/alpha/2026-11-03-old-local.md': entry(3, '本機'),
      'docs/alpha/2026-11-04-old-local-url.html': entry(4, '本機', { url: 'https://example.com/published' }),
    },
  }));
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  write('docs/beta/2026-11-05-new.md', '# New\n');
  write('docs/beta/2026-11-06-new-url.html', '<!-- https://example.com/x -->\n<title>New with url</title>');
  git('add', 'docs/beta/2026-11-05-new.md');
  git('commit', '-q', '-m', 'add new');
  lib = await import('../scripts/lib/catalog.mjs');
});

function syncOnce() {
  const c = lib.loadCatalog();
  const r = lib.syncCatalog(c);
  lib.saveCatalog(c);
  return { c, r };
}

test('old statuses migrate (草稿→待處理, 審查中→待確認, 本機→已確認 / 已發布 with URL); list keeps custom values', () => {
  const { c } = syncOnce();
  const s = (rel) => c.docs[`docs/${rel}`].status;
  assert.equal(s('alpha/2026-11-01-old-draft.md'), '待處理');
  assert.equal(s('alpha/2026-11-02-old-review.md'), '待確認');
  assert.equal(s('alpha/2026-11-03-old-local.md'), '已確認');
  assert.equal(s('alpha/2026-11-04-old-local-url.html'), '已發布');
  assert.deepEqual(c.statuses, ['待處理', '待確認', '已確認', '已發布', '封存', '自訂']);
  assert.equal(c.filters[0].query, 's:待處理 -status:"已確認" p:alpha');
});

test('new docs default to 待處理, or 已發布 when they carry an origin URL', () => {
  const { c } = syncOnce();
  assert.equal(c.docs['docs/beta/2026-11-05-new.md'].status, '待處理');
  assert.equal(c.docs['docs/beta/2026-11-06-new-url.html'].status, '已發布');
});

test('reporter = first git author email (lower-cased), kept when set, absent when the file is not committed', () => {
  const { c } = syncOnce();
  assert.equal(c.docs['docs/alpha/2026-11-01-old-draft.md'].reporter, 'author@example.com');
  assert.equal(c.docs['docs/alpha/2026-11-02-old-review.md'].reporter, 'kept@example.com');
  assert.equal(c.docs['docs/beta/2026-11-05-new.md'].reporter, 'author@example.com');
  assert.equal(c.docs['docs/beta/2026-11-06-new-url.html'].reporter, undefined);
});

test('docs/notes/ is not part of the catalog', () => {
  const { c } = syncOnce();
  assert.ok(!Object.keys(c.docs).some((k) => k.startsWith('docs/notes/')));
});

test('migration is idempotent', () => {
  const before = fs.readFileSync(path.join(dir, 'docs/catalog.json'), 'utf8');
  syncOnce();
  assert.equal(fs.readFileSync(path.join(dir, 'docs/catalog.json'), 'utf8'), before);
});

test('keyword seeds use real \\b word boundaries; stored backspace aliases migrate on load (idempotent)', () => {
  for (const aliases of Object.values(lib.DEFAULT_KEYWORDS)) for (const a of aliases) assert.equal(a.includes('\u0008'), false, a);
  const [[, [api]]] = lib.compileKeywords({ API: lib.DEFAULT_KEYWORDS.API });
  assert.equal('the api works'.match(api)?.length, 1);
  assert.equal('rapid'.match(api), null);
  const file = path.join(dir, 'docs/catalog.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.keywords = { API: ['\bapi\b', 'postman'], Mine: ['foo\\bar'] };
  fs.writeFileSync(file, JSON.stringify(saved));
  const c = lib.loadCatalog();
  assert.deepEqual(c.keywords, { API: ['\\bapi\\b', 'postman'], Mine: ['foo\\bar'] });
  assert.deepEqual(lib.migrateKeywords(c.keywords), c.keywords, 'idempotent');
  lib.saveCatalog(c);
  assert.equal(fs.readFileSync(file, 'utf8').includes('\\u0008'), false);
});

test('HTML search text leaves out <head> / <title>', () => {
  write('docs/beta/2026-11-07-page.html', '<!doctype html><html><head><title>Unique Page Title</title><meta name="x" content="metadata"></head><body><h1>Body heading</h1></body></html>');
  const c = lib.loadCatalog();
  const { items } = lib.syncCatalog(c);
  const it = items.find((x) => x.rel === 'docs/beta/2026-11-07-page.html');
  assert.equal(it.entry.title, 'Unique Page Title');
  assert.equal(it.text, 'Body heading');
  fs.rmSync(path.join(dir, 'docs/beta/2026-11-07-page.html'));
});

test('declared sensitivity (front matter / meta) raises, never lowers, and survives review', () => {
  write('docs/beta/2026-11-08-declared.md', '---\nname: declared\nsensitivity: confidential\n---\n# Declared\n');
  write('docs/beta/2026-11-09-meta.html', '<html><head><meta content="極機密" name="sensitivity"><title>Meta</title></head><body>x</body></html>');
  write('docs/beta/2026-11-10-lower.md', '---\nsensitivity: public\n---\n# Lower\n\ncontact: someone.real@corp.example.org\n');
  write('docs/beta/2026-11-11-bad.md', '---\nsensitivity: ultra\n---\n# Bad\n');
  let c = lib.loadCatalog();
  let r = lib.syncCatalog(c);
  const e = (n) => c.docs[`docs/beta/${n}`];
  assert.equal(e('2026-11-08-declared.md').sensitivity, '機密');
  assert.equal(e('2026-11-09-meta.html').sensitivity, '極機密');
  assert.equal(e('2026-11-10-lower.md').sensitivity, '機密', 'declared 公開 does not lower a detected 機密');
  assert.equal(e('2026-11-11-bad.md').sensitivity, '內部');
  assert.match(r.warnings.join('\n'), /2026-11-11-bad\.md: unknown declared sensitivity "ultra"/);
  const rec = lib.toRecord(r.items.find((x) => x.rel === 'docs/beta/2026-11-08-declared.md'));
  assert.equal(rec.declaredSensitivity, '機密');
  // a reviewer lowers it in the catalog: the declaration in the file wins again on the next scan
  Object.assign(e('2026-11-08-declared.md'), { sensitivity: '內部', sensitivityReviewed: true });
  lib.saveCatalog(c);
  c = lib.loadCatalog();
  r = lib.syncCatalog(c);
  assert.equal(c.docs['docs/beta/2026-11-08-declared.md'].sensitivity, '機密');
  assert.match(r.raised.join('\n'), /declared\.md: 內部 → 機密 \(declared in the file\)/);
  for (const n of ['2026-11-08-declared.md', '2026-11-09-meta.html', '2026-11-10-lower.md', '2026-11-11-bad.md']) fs.rmSync(path.join(dir, 'docs/beta', n));
  c = lib.loadCatalog();
  lib.syncCatalog(c);
  lib.saveCatalog(c);
});
