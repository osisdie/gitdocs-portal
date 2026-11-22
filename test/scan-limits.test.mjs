// Regression: a huge or hostile document (or keyword alias) costs bounded time in the catalog scan.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdocs-scan-'));
process.env.CONTENT_DIR = dir; // must be set before catalog.mjs is imported
process.env.SOURCE_FILE_MAX_BYTES = String(4 * 1024 * 1024);
let lib;
const MB = 1024 * 1024;
const write = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
const fill = (unit, bytes) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

before(async () => {
  // each one is quadratic (or worse) for at least one of the previous regexes
  write('docs/alpha/run.md', fill('a', 3 * MB)); // EMAIL_RE from every position of a local-part run
  write('docs/alpha/tags.html', `<title>${'T'.repeat(5000)}</title>` + fill('<!--<head<style<meta<', 3 * MB));
  write('docs/alpha/front.md', `---\nsensitivity:${fill(' ', 3 * MB)}x\n---\n`);
  write('docs/alpha/addr.md', fill('路 1', 3 * MB));
  write('docs/alpha/late-ref.md', `# Late\n${fill('word ', 2.5 * MB)} {{vault:alpha/late}}\n`);
  // credentials past the scan limit, and past 2.5 MB of inline base64, are still found (R2)
  write('docs/alpha/inline.html', `<p>x</p><img src="data:image/png;base64,${fill('QUFB', 2.5 * MB)}"><p>AKIAABCDEFGHIJKLMNOP</p>`);
  write('docs/alpha/late-key.md', `# Late key\n${fill('word ', 2.5 * MB)}\n-----BEGIN RSA PRIVATE KEY-----\n`);
  write('docs/alpha/long.md', `---\ndescription: ${'d'.repeat(2000)}\n---\n# ${'h'.repeat(2000)}\n`);
  write('docs/catalog.json', JSON.stringify({
    site: { sources: [{ name: 'acme', repo: 'https://git.example.com/acme.git' }] },
    keywords: { Bad: ['(a+)+$', '\\w+x'], Good: ['\\bdeploy(?:s|ed)?\\b'] },
  }));
  write('.sources/acme/.git/HEAD', 'ref: refs/heads/main\n');
  write('.sources/acme/big.md', fill('b ', 5 * MB));
  write('.sources/acme/small.md', '# small\n');
  lib = await import('../scripts/lib/catalog.mjs');
});

test('a 3 MB pathological file set scans in under 2 s', () => {
  const catalog = lib.loadCatalog();
  const skipped = [];
  const t0 = performance.now();
  const sync = lib.syncCatalog(catalog, { onSkip: (rel, why) => skipped.push([rel, why]) });
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `scan took ${Math.round(ms)} ms`);
  const byRel = Object.fromEntries(sync.items.map((it) => [it.rel, it]));
  assert.ok(byRel['docs/alpha/run.md'] && byRel['docs/alpha/tags.html'] && byRel['docs/alpha/front.md']);
  assert.ok(byRel['docs/alpha/run.md'].text.length <= lib.SCAN_MAX_BYTES, 'search text reads the first SCAN_MAX_BYTES only');
  assert.equal(byRel['docs/alpha/run.md'].size, 3 * MB, 'size is still the real file size');
  assert.deepEqual(byRel['docs/alpha/late-ref.md'].vaultRefs, ['alpha/late'], 'vault refs are found past the scan limit');

  // mounted source files above SOURCE_FILE_MAX_BYTES are skipped with a warning, not a failure
  assert.ok(skipped.some(([rel, why]) => rel === 'docs/acme/big.md' && /SOURCE_FILE_MAX_BYTES/.test(why)));
  assert.ok(byRel['docs/acme/small.md'] && !byRel['docs/acme/big.md']);
  assert.equal(lib.mountFiles(sync.mounts[0]).some((f) => f.rel === 'docs/acme/big.md'), false, 'the build does not deploy it either');

  // user-supplied keyword aliases outside the linear subset are ignored with a warning
  assert.equal(sync.warnings.filter((w) => w.startsWith('keyword "Bad"')).length, 2);

  assert.equal(catalog.docs['docs/alpha/inline.html'].sensitivity, '極機密', 'key after a big data: URI');
  assert.equal(catalog.docs['docs/alpha/late-key.md'].sensitivity, '極機密', 'key past SCAN_MAX_BYTES');
  assert.equal(byRel['docs/alpha/run.md'].truncated, true);
  assert.equal(byRel['docs/alpha/inline.html'].truncated, false, 'data: URIs do not count against the limit');
  assert.equal(byRel['docs/acme/small.md'].truncated, false);

  const long = catalog.docs['docs/alpha/long.md'];
  assert.equal(long.title.length, lib.TITLE_MAX);
  assert.equal(long.desc.length, lib.DESC_MAX);
  assert.equal(catalog.docs['docs/alpha/tags.html'].title.length, lib.TITLE_MAX);
});

test('aliasProblem accepts the seed aliases and refuses super-linear constructs', () => {
  for (const a of Object.values(lib.DEFAULT_KEYWORDS).flat()) assert.equal(lib.aliasProblem(a), null, a);
  for (const a of ['\\bpag(?:ed|er|ing)\\b', '[a-z]{1,10}ing', 'x{3}', 'new hires?']) assert.equal(lib.aliasProblem(a), null, a);
  for (const a of ['(a+)+$', 'a*', 'foo.*bar', 'a{1,}', 'a{2,40}', '(a|aa){1,30}', '(.)\\1', '[', 'x'.repeat(201)]) {
    assert.notEqual(lib.aliasProblem(a), null, a);
  }
});

test('numeric character references beyond U+10FFFF do not abort the scan', () => {
  assert.equal(lib.htmlToText('<p>&#99999999;&#x110000;&#65;</p>'), '&#99999999;&#x110000;A');
});

// ---------- CLI runs in their own content folder (child processes) ----------
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cli = (script, args, content, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args],
  { env: { ...process.env, CONTENT_DIR: content, ...extra }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

test('vault check / scan stay linear: unclosed key openers (1 MB same label, 2 MB distinct labels) and 20k tokens in < 2 s, local and mounted', () => {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdocs-vaultscan-'));
  const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(c, rel)), { recursive: true }); fs.writeFileSync(path.join(c, rel), data); };
  const openers = fill('-----BEGIN RSA PRIVATE KEY-----\n', MB);
  const tokens = Array.from({ length: 20000 }, (_, i) => `sk-${String(i).padStart(24, 'x')}`).join(' ');
  // every opener with its own label: a missing END must not be searched for once per label
  const label = (i) => i.toString(26).split('').map((ch) => String.fromCharCode(65 + parseInt(ch, 26))).join('');
  let distinct = '';
  for (let i = 0; distinct.length < 2 * MB; i++) distinct += `-----BEGIN ${label(i)} PRIVATE KEY-----\n`;
  put('docs/a/openers.md', openers);
  put('docs/a/labels.md', distinct);
  put('.sources/acme/labels.md', distinct);
  put('docs/a/tokens.md', tokens);
  put('docs/catalog.json', JSON.stringify({ site: { sources: [{ name: 'acme', repo: 'https://git.example.com/acme.git' }] } }));
  put('.sources/acme/.git/HEAD', 'ref: refs/heads/main\n');
  put('.sources/acme/openers.md', openers);
  put('.sources/acme/tokens.md', tokens);
  for (const args of [['check'], ['scan']]) {
    const t0 = performance.now();
    const r = cli('vault.mjs', args, c);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `vault ${args[0]} took ${Math.round(ms)} ms`);
    assert.equal(r.error, undefined, `vault ${args[0]}: ${r.error?.message}`);
    assert.equal(r.signal, null, `vault ${args[0]} was killed`);
    const out = r.stdout + r.stderr;
    assert.match(out, /openai-key/, `vault ${args[0]} still reports the tokens`);
  }
});

test('a file larger than SCAN_MAX_BYTES is marked sensitivityPending by the build (fail closed)', () => {
  const c = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdocs-pending-'));
  fs.mkdirSync(path.join(c, 'docs/a'), { recursive: true });
  fs.writeFileSync(path.join(c, 'docs/a/big.md'), `# Big\n${fill('plain words ', 5000)}`);
  fs.writeFileSync(path.join(c, 'docs/a/small.md'), '# Small\n');
  const dist = path.join(c, 'dist');
  const r = cli('build.mjs', [], c, { DIST_DIR: dist, SCAN_MAX_BYTES: '2000' });
  assert.equal(r.status, 0, r.stderr);
  const docs = JSON.parse(fs.readFileSync(path.join(dist, 'catalog.json'), 'utf8')).docs;
  const by = Object.fromEntries(docs.map((d) => [d.path, d]));
  assert.deepEqual([by['docs/a/big.md'].sensitivity, by['docs/a/big.md'].sensitivityPending], ['內部', true]);
  assert.equal(by['docs/a/small.md'].sensitivityPending, undefined);
});
