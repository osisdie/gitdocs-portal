#!/usr/bin/env node
// Build the docs portal into dist/.
//  1. Scan docs/ and sync docs/catalog.json (ids, inferred metadata, project registry, sensitivity).
//  2. Emit dist/catalog.json (metadata + keywords + git history) and dist/search-index.json (plain-text bodies).
//  3. Copy site/ (portal UI) and docs/ into dist/, honouring sensitivity:
//       機密   → file deployed, body withheld from the search index, preview gated behind a click
//       極機密 → file NOT deployed, no body; listed as metadata only ("僅存 git，未上傳")
//     --max-sensitivity=<level> drops every doc above <level> entirely (for share builds; also drops the vault and
//     the reporter / assignee / reviewer emails).
//     --no-vault  do not deploy vault.json ({{vault:…}} fields then stay masked for everyone).
//     --check  only reports what would change.
//  4. Vault: vault/vault.json (ciphertext only) → dist/vault.json. HTML docs that reference {{vault:…}} get the
//     site/vault-frame.js shim inlined: docs are served sandboxed (opaque origin, see site/_headers), so the shim only
//     masks fields and asks the portal to show a value in the portal's own dialog — it never sees keys or plaintext.
//  5. External sources (catalog.json → site.sources, checked out by `npm run sources:pull`): files under
//     .sources/<name>/<path>/ are deployed at docs/<projectRoot>/<name>/ with the same sensitivity rules; their
//     {{vault:…}} references outside <name>/ are replaced by {{vault-blocked}} and never listed on the record.
//     A source that is not checked out keeps its catalog entries but deploys nothing (warning).
//     A source's own vault/vault.json (ciphertext, its own passphrase) is deployed as _vaults/<source>.json with only
//     the names under <source>/; the server opens it with VAULT_KEY_<SOURCE> and never serves it. Only server builds
//     emit it (--server, or a wrangler.toml with a [[d1_databases]] binding): a static host would serve the file.
//  DIST_DIR=<dir> builds somewhere other than dist/ (tests).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, CONTENT, DOCS, VAULT_FILE, NOTES_DIR, SENSITIVITIES, sensRank, loadCatalog, saveCatalog, syncCatalog, toRecord, gitHistory, PEOPLE_FIELDS, mountFiles, stripBlockedRefs, visibilityOf, sourceEnvName, tenantVaultFile } from './lib/catalog.mjs';

const SITE = path.join(ROOT, 'site');
const DIST = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(ROOT, 'dist');
const TEXT_CAP = 40000;
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const maxArg = (argv.find((a) => a.startsWith('--max-sensitivity=')) || '').split('=')[1];
if (maxArg && !SENSITIVITIES.includes(maxArg)) {
  console.error(`--max-sensitivity must be one of: ${SENSITIVITIES.join(' / ')}`);
  process.exit(2);
}
const maxRank = maxArg ? sensRank(maxArg) : Infinity;
const vaultsAllowed = !argv.includes('--no-vault') && !maxArg; // share builds and --no-vault deploy no vault at all
// Server mode is what keeps /_vaults/* private (the gate answers 404); a static host has no way to, so tenant vaults
// are emitted only for a server build. Same test as scripts/deploy.sh and the CI templates.
const hasD1 = (dir) => { try { return /^\[\[d1_databases\]\]/m.test(fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8')); } catch { return false; } };
const serverBuild = argv.includes('--server') || hasD1(ROOT) || hasD1(CONTENT);
const withVault = vaultsAllowed && fs.existsSync(VAULT_FILE);

const catalog = loadCatalog();
let sync;
try {
  sync = syncCatalog(catalog, { onSkip: (rel, why) => console.warn(`⚠ skipped ${rel}: ${why}`) });
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
const { items, added, missing, raised, held, mounts, unavailable, warnings } = sync;
for (const r of raised) console.warn(`⚠ sensitivity raised: ${r}`);
for (const w of warnings) console.warn(`⚠ ${w}`);
for (const name of unavailable) {
  const n = held.filter((k) => k.startsWith(`${mounts.find((m) => m.name === name).prefix}/`)).length;
  console.warn(`⚠ source "${name}" is not checked out (.sources/${name}; run npm run sources:pull, credentials via ${sourceEnvName(name)}): ${n} catalog entries kept but not deployed`);
}
for (const it of items) {
  for (const n of it.blockedRefs) console.warn(`⚠ ${it.rel} (source ${it.source}) references {{vault:${n}}} outside ${it.source}/ — not exposed`);
}

const vault = fs.existsSync(VAULT_FILE) ? JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')) : null;

// tenant vaults: { source → { vault (only <source>/ names), foreign: [names ignored] } }
const tenantVaults = new Map();
for (const m of mounts) {
  const f = tenantVaultFile(m);
  if (!f) continue;
  let v;
  try { v = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.warn(`⚠ source "${m.name}": vault/vault.json is not valid JSON (${e.message}) — ignored`); continue; }
  if (!v || typeof v !== 'object' || !v.kdf?.salt || !v.check?.ct || !v.secrets || typeof v.secrets !== 'object') {
    console.warn(`⚠ source "${m.name}": vault/vault.json is not a gitdocs vault — ignored`);
    continue;
  }
  const kept = {}, foreign = [];
  for (const [n, box] of Object.entries(v.secrets)) {
    if (n.startsWith(`${m.name}/`) && box && typeof box.iv === 'string' && typeof box.ct === 'string') kept[n] = { iv: box.iv, ct: box.ct, note: typeof box.note === 'string' ? box.note : '', updated: typeof box.updated === 'string' ? box.updated : '' };
    else foreign.push(n);
  }
  for (const n of foreign) console.warn(`⚠ source "${m.name}": vault secret "${n}" is outside ${m.name}/ — ignored`);
  tenantVaults.set(m.name, { version: v.version, kdf: v.kdf, check: v.check, secrets: kept });
}
const inSomeVault = (it, n) => !!vault?.secrets?.[n] || !!tenantVaults.get(it.source)?.secrets?.[n];
const unknownRefs = [...new Set(items.flatMap((it) => it.vaultRefs.filter((n) => !inSomeVault(it, n))))];
for (const n of unknownRefs) console.warn(`⚠ {{vault:${n}}} is referenced but not in ${path.relative(CONTENT, VAULT_FILE)} or a source vault (fine if it lives in the web vault)`);

if (checkOnly) {
  console.log(`docs: ${items.length}, new: ${added.length}, removed: ${missing.length}, raised: ${raised.length}, unknown vault refs: ${unknownRefs.length}${mounts.length ? `, sources: ${mounts.length} (not checked out: ${unavailable.length}, held entries: ${held.length})` : ''}`);
  process.exit(0);
}
saveCatalog(catalog);

const builtAt = new Date().toISOString();
const records = [], search = [], excluded = new Set();
let dropped = 0;
const blocked = new Map(); // abs → source, for mounted files whose deployed copy must have refs rewritten
for (const it of items) {
  const abs = it.loc.abs;
  if (it.blockedRefs.length) blocked.set(abs, it.source);
  const rank = sensRank(it.entry.sensitivity);
  if (it.entry.hidden || rank > maxRank) { excluded.add(abs); dropped++; continue; }
  const rec = toRecord(it);
  // `doc set sensitivity=` always marks a doc reviewed, so above 內部 without that mark means "detected, not reviewed"
  // so is a file larger than SCAN_MAX_BYTES: the PII heuristics did not see all of it (fail closed: flag it for review)
  if (!it.entry.sensitivityReviewed && (rank > sensRank('內部') || it.truncated)) rec.sensitivityPending = true;
  delete rec.sensitivityReviewed;
  if (maxArg) for (const k of PEOPLE_FIELDS) delete rec[k]; // share builds leave the organisation: no staff emails
  rec.history = gitHistory(it.rel, 20, it.loc);
  if (rank >= sensRank('極機密')) { rec.offline = true; excluded.add(abs); }
  else if (rank >= sensRank('機密')) rec.gated = true;
  else search.push({ id: rec.id, t: it.text.slice(0, TEXT_CAP) });
  records.push(rec);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SITE, DIST, { recursive: true });
// version the service worker's shell cache per build
const SW = path.join(DIST, 'sw.js');
if (fs.existsSync(SW)) fs.writeFileSync(SW, fs.readFileSync(SW, 'utf8').replaceAll('__BUILD__', Date.parse(builtAt).toString(36)));
// Cache-busting for the shell: a CDN may stretch the browser TTL of .js/.css (Cloudflare's zone "Browser Cache TTL"
// overrides Pages' max-age=0 and even _headers' no-cache), so a fresh index.html could run a stale app.js for hours.
// Every shell URL carries ?v=<hash of site/>: index.html's script/stylesheet, and each relative module import, static or
// dynamic (the module map is keyed by full URL, so one unversioned import would pin an old module). Unchanged site/ →
// same hash → the browser cache still works across content-only deploys.
const shellVersion = (() => {
  const h = crypto.createHash('sha256');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else h.update(path.relative(SITE, f)).update('\0').update(fs.readFileSync(f)).update('\0');
  });
  walk(SITE);
  return h.digest('hex').slice(0, 10);
})();
const versionImports = (src) => src.replace(/((?:\bfrom|\bimport\s*\()\s*)(['"])(\.{1,2}\/[^'"?#]+\.js)\2/g, `$1$2$3?v=${shellVersion}$2`);
(function stampShell(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) stampShell(f);
    else if (e.name.endsWith('.js') && e.name !== 'sw.js' && e.name !== 'vault-frame.js') fs.writeFileSync(f, versionImports(fs.readFileSync(f, 'utf8')));
  }
})(DIST);
{
  const INDEX = path.join(DIST, 'index.html');
  if (fs.existsSync(INDEX)) {
    fs.writeFileSync(INDEX, fs.readFileSync(INDEX, 'utf8').replace(/(\b(?:src|href)=")([\w./-]+\.(?:js|css))(")/g, `$1$2?v=${shellVersion}$3`));
  }
}
const DIST_DOCS = path.join(DIST, 'docs');
fs.cpSync(DOCS, DIST_DOCS, {
  recursive: true,
  filter: (s) => !path.basename(s).includes(':') && !excluded.has(s) && s !== path.join(DOCS, 'catalog.json') && s !== NOTES_DIR,
});
// mounted sources: regular files only (mountFiles never returns symlinks or dot-files), same exclusions as local docs
let mountedCopied = 0;
for (const m of mounts) {
  for (const f of mountFiles(m)) {
    if (excluded.has(f.abs)) continue;
    const dest = path.join(DIST, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (blocked.has(f.abs)) fs.writeFileSync(dest, stripBlockedRefs(fs.readFileSync(f.abs, 'utf8'), blocked.get(f.abs)));
    else fs.copyFileSync(f.abs, dest);
    mountedCopied++;
  }
}
if (withVault) fs.copyFileSync(VAULT_FILE, path.join(DIST, 'vault.json'));
if (vaultsAllowed && !serverBuild && tenantVaults.size) {
  console.warn(`⚠ source vaults not deployed: this is not a server build (no [[d1_databases]] in wrangler.toml, no --server) and a static host would serve dist/_vaults/ to anyone`);
}
if (vaultsAllowed && serverBuild) {
  for (const [name, v] of tenantVaults) {
    fs.mkdirSync(path.join(DIST, '_vaults'), { recursive: true });
    fs.writeFileSync(path.join(DIST, '_vaults', `${name}.json`), JSON.stringify(v));
  }
}

// HTML docs with vault fields get the masking shim inlined (a sandboxed doc cannot load portal scripts with cookies).
const TAG = `<script>${fs.readFileSync(path.join(SITE, 'vault-frame.js'), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
let injected = 0;
for (const it of items) {
  if (it.type !== 'html' || (!it.vaultRefs.length && !(it.blockedRefs || []).length)) continue; // blocked-only docs still need the shim to mask {{vault-blocked}}
  const f = path.join(DIST, ...it.rel.split('/'));
  if (!fs.existsSync(f)) continue;
  const html = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${TAG}</body>`) : html + TAG);
  injected++;
}

records.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
// visibility: every registry entry carries the effective value (subprojects inherit the top-level one);
// mounts are flagged with `source`. site.sources (repo URLs) is not deployed.
const mountNames = new Set(mounts.map((m) => m.name));
const projectsOut = Object.fromEntries(Object.entries(catalog.projects).map(([k, v]) => {
  const top = k.split('/')[0];
  const out = { ...v, visibility: visibilityOf(catalog.projects, k) };
  delete out.source;
  if (mountNames.has(top) && !v.parent && !k.includes('/')) out.source = top;
  return [k, out];
}));
const { sources: _sources, people: sitePeople, ...siteOut } = catalog.site;
// site.people { email: display name } (static-mode names; server mode trims it per user): emails lower-cased, names
// trimmed to 80 characters; share builds leave the organisation, so they drop it with the other staff emails
if (sitePeople && typeof sitePeople === 'object' && !Array.isArray(sitePeople) && !maxArg) {
  siteOut.people = Object.fromEntries(Object.entries(sitePeople)
    .filter(([e, n]) => /^[^\s@]+@[^\s@]+$/.test(e) && typeof n === 'string' && n.trim())
    .map(([e, n]) => [e.toLowerCase(), n.trim().replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 80)]));
}
const out = {
  builtAt,
  maxSensitivity: maxArg || null,
  site: siteOut,
  vault: withVault,
  categories: catalog.categories, statuses: catalog.statuses, sensitivities: catalog.sensitivities,
  projects: projectsOut, filters: catalog.filters,
  docs: records,
};
fs.writeFileSync(path.join(DIST, 'catalog.json'), JSON.stringify(out));
fs.writeFileSync(path.join(DIST, 'search-index.json'), JSON.stringify(search));

const n = (lvl) => records.filter((r) => r.sensitivity === lvl).length;
const vaultNote = (vault ? `; vault: ${Object.keys(vault.secrets).length} secrets${withVault ? '' : ' (not deployed)'}, ${injected} html docs wired` : '')
  + (tenantVaults.size ? `; source vaults: ${[...tenantVaults].map(([n, v]) => `${n} ${Object.keys(v.secrets).length}`).join(', ')}${vaultsAllowed && serverBuild ? '' : ' (not deployed)'}` : '');
const srcNote = mounts.length ? `; sources: ${mounts.length - unavailable.length}/${mounts.length} mounted, ${mountedCopied} files${held.length ? `, ${held.length} held back` : ''}` : '';
console.log(`built ${records.length} docs → ${path.relative(ROOT, DIST) || '.'}/  (${SENSITIVITIES.map((s) => `${s} ${n(s)}`).join(' · ')}; new: ${added.length}${added.length ? ' — ' + added.join(', ') : ''}; removed: ${missing.length}${dropped ? `; dropped: ${dropped}` : ''}${vaultNote}${srcNote})`);
