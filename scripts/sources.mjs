#!/usr/bin/env node
// External content sources.  npm run sources:pull [-- <name>…]   ·   node scripts/sources.mjs ls
//
// catalog.json → site.sources: [{ "name": "acme", "repo": "https://git.example.com/acme/docs.git", "ref": "main",
// "path": "docs" }]. Each source is checked out into <content>/.sources/<name>/ (gitignored) and mounted by the
// catalog scan at docs/<projectRoot>/<name>/ (see scripts/lib/catalog.mjs → mountsOf).
//
// Credentials: from the user's git config (credential helper, SSH agent) or, in CI, a variable SOURCE_<NAME>_URL
// (e.g. https://deploy-token:<token>@git.example.com/acme/docs.git) that overrides `repo`. The URL is passed to
// `git fetch` on the command line only: there is no remote in .git/config, no FETCH_HEAD, no reflog, and every
// message printed here has URL credentials, query strings and fragments masked. A URL with a query string or fragment
// is refused (tokens there would reach git's own messages and server logs): use the userinfo or a credential helper.
//
// History: the ref is fetched with its full history (one ref, no tags) so per-file history and reporters work;
// `depth: N` on a source makes it a shallow fetch for very large repos (history then stops at N commits).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTENT, SOURCES_DIR, loadCatalog, sourceList, sourceEnvName, mountsOf, mountFiles } from './lib/catalog.mjs';

const USAGE = `用法：node scripts/sources.mjs <指令>

  pull [名稱…]     抓取／更新外部來源到 .sources/<名稱>/（npm run sources:pull）
  ls               列出設定的來源與目前 checkout 的版本

設定在 docs/catalog.json → site.sources：
  [{ "name": "acme", "repo": "https://git.example.com/acme/docs.git", "ref": "main", "path": "docs" }]
憑證放在 git 設定或 CI 變數 SOURCE_<NAME>_URL（覆蓋 repo），不要寫進 catalog.json。`;

/**
 * Text with URL credentials (user:password@), URL query strings / fragments and the given secret strings masked.
 * Linear on hostile input (git relays the remote's messages): URL tokens start only where a scheme run starts and end
 * at the first blank or quote, so no position is rescanned.
 */
export function redact(text, secrets = []) {
  let out = String(text).replace(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]*/gi, (url) => {
    const scheme = url.indexOf('://') + 3;
    let rest = url.slice(scheme);
    const slash = rest.indexOf('/'), at = rest.lastIndexOf('@', slash < 0 ? rest.length : slash);
    if (at > 0) rest = `***${rest.slice(at)}`;
    const q = rest.search(/[?#]/);
    if (q >= 0) rest = `${rest.slice(0, q + 1)}***`;
    return url.slice(0, scheme) + rest;
  });
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

/** userinfo parts of a URL (to mask them even where git prints them without the scheme). */
const secretsOf = (url) => {
  const m = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/([^/@\s]+)@/i);
  if (!m) return [];
  const raw = m[1];
  return [raw, ...raw.split(':'), ...raw.split(':').map((p) => { try { return decodeURIComponent(p); } catch { return p; } })];
};

// https / ssh / scp-style / file URLs and absolute local paths. Nothing that git could read as an option or as the
// ext:: transport (which runs commands); protocol.ext.allow=never is passed as well.
const URL_OK = /^(https:\/\/|ssh:\/\/|file:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/)|\/)/;

/** The URL to fetch a source from: $SOURCE_<NAME>_URL, else site.sources[].repo. Throws when unusable. */
export function resolveUrl(s, env = process.env) {
  const url = env[sourceEnvName(s.name)] || s.repo;
  if (!url) throw new Error(`source ${s.name}: no repo URL (set site.sources[].repo or ${sourceEnvName(s.name)})`);
  if (url.startsWith('-') || !URL_OK.test(url) || /[\s\u0000-\u001f\u007f]/.test(url)) {
    throw new Error(`source ${s.name}: unsupported repo URL ${redact(url)} (use https://, ssh://, git@host:path, file:// or an absolute path)`);
  }
  if (/[?#]/.test(url)) {
    throw new Error(`source ${s.name}: repo URL ${redact(url)} carries a query string or fragment — put credentials in the userinfo (https://user:token@host/…) or a git credential helper`);
  }
  return url;
}

function git(args, cwd, secrets) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // CI must fail, not hang on a prompt
    }).trim();
  } catch (e) {
    const msg = redact(`${e.stderr || ''}`.trim() || e.message, secrets);
    throw new Error(`git ${args.find((a) => !a.startsWith('-')) || ''} failed: ${msg}`);
  }
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/** Clone-or-update one source; returns { sha, docs }. */
export function pullSource(s, env = process.env) {
  const url = resolveUrl(s, env);
  const secrets = secretsOf(url);
  const dir = path.join(SOURCES_DIR, s.name);
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
  const st = lstat(dir);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`.sources/${s.name} exists but is not a folder; remove it`);
  if (!lstat(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    git(['init', '-q'], dir, secrets);
  }
  const shallow = git(['rev-parse', '--is-shallow-repository'], dir, secrets) === 'true';
  const depth = s.depth ? [`--depth=${s.depth}`] : shallow ? ['--unshallow'] : [];
  // no remote is configured and nothing records the URL: credentials in it never reach the disk
  git(['-c', 'protocol.ext.allow=never', '-c', 'core.logAllRefUpdates=false', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
    ...depth, '--', url, `+${s.ref}:refs/gitdocs/source`], dir, secrets);
  git(['-c', 'advice.detachedHead=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.logAllRefUpdates=false',
    'checkout', '--quiet', '--force', '--detach', 'refs/gitdocs/source'], dir, secrets);
  git(['clean', '-ffdxq'], dir, secrets);
  return { sha: git(['rev-parse', '--short=12', 'HEAD'], dir, secrets) };
}

function warnIfNotIgnored() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: CONTENT, stdio: 'ignore' });
  } catch { return; } // content folder is not a git repo
  try {
    execFileSync('git', ['check-ignore', '-q', '.sources/x'], { cwd: CONTENT, stdio: 'ignore' });
  } catch {
    console.warn('⚠ .sources/ is not gitignored in the content repo — add a line ".sources/" to .gitignore so checkouts are never committed');
  }
}

function main() {
  const [cmd, ...names] = process.argv.slice(2);
  const catalog = loadCatalog();
  let sources, mounts;
  try {
    sources = sourceList(catalog.site);
    mounts = mountsOf(catalog.site); // also refuses a source that collides with a local folder
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  if (cmd === 'ls') {
    if (!sources.length) { console.log('（沒有設定外部來源：catalog.json → site.sources）'); return; }
    for (const m of mounts) {
      const sha = m.available ? execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: m.repoDir, encoding: 'utf8' }).trim() : '—';
      const via = process.env[sourceEnvName(m.name)] ? `$${sourceEnvName(m.name)}` : redact(m.repo || '(no repo)');
      console.log(`${m.available ? '✓' : '✗'} ${m.name.padEnd(20)} ${m.ref.padEnd(16)} ${sha.padEnd(13)} ${m.prefix}/ ← ${via}${m.path ? ` : ${m.path}/` : ''}`);
    }
    return;
  }
  if (cmd !== 'pull') { console.log(USAGE); process.exit(cmd && cmd !== 'help' ? 1 : 0); }
  if (!sources.length) { console.log('no external sources configured (catalog.json → site.sources) — nothing to pull'); return; }
  const unknown = names.filter((n) => !sources.some((s) => s.name === n));
  if (unknown.length) { console.error(`✗ unknown source: ${unknown.join(', ')}`); process.exit(1); }
  warnIfNotIgnored();
  let failed = 0;
  for (const s of sources.filter((x) => !names.length || names.includes(x.name))) {
    try {
      const { sha } = pullSource(s);
      const m = mountsOf(catalog.site).find((x) => x.name === s.name);
      if (!m.available) throw new Error(`path "${s.path}" is missing in the source or is not a real folder (symlinks are refused)`);
      const docs = mountFiles(m).filter((f) => f.doc).length;
      console.log(`✓ ${s.name}: ${s.ref} → ${sha} (${docs} docs at ${m.prefix}/)`);
    } catch (e) {
      failed++;
      console.error(`✗ ${s.name}: ${redact(e.message)}`);
    }
  }
  // fail the job: deploying without a source would take its documents off the site until the next good pull
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main();
