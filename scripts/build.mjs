#!/usr/bin/env node
// Build the docs portal into dist/.
//  1. Scan docs/ and sync docs/catalog.json (ids, inferred metadata, project registry, sensitivity).
//  2. Emit dist/catalog.json (metadata + keywords + git history) and dist/search-index.json (plain-text bodies).
//  3. Copy site/ (portal UI) and docs/ into dist/, honouring sensitivity:
//       機密   → file deployed, body withheld from the search index, preview gated behind a click
//       極機密 → file NOT deployed, no body; listed as metadata only ("僅存 git，未上傳")
//     --max-sensitivity=<level> drops every doc above <level> entirely (for share builds; also drops the vault).
//     --no-vault  do not deploy vault.json ({{vault:…}} fields then stay masked for everyone).
//     --check  only reports what would change.
//  4. Vault: vault/vault.json (ciphertext only) → dist/vault.json; HTML docs that reference {{vault:…}} get
//     <script type="module" src="/vault.js"> so the masked fields can be revealed in the browser.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CONTENT, DOCS, VAULT_FILE, SENSITIVITIES, sensRank, loadCatalog, saveCatalog, syncCatalog, toRecord, gitHistory } from './lib/catalog.mjs';

const SITE = path.join(ROOT, 'site');
const DIST = path.join(ROOT, 'dist');
const TEXT_CAP = 40000;
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const maxArg = (argv.find((a) => a.startsWith('--max-sensitivity=')) || '').split('=')[1];
if (maxArg && !SENSITIVITIES.includes(maxArg)) {
  console.error(`--max-sensitivity must be one of: ${SENSITIVITIES.join(' / ')}`);
  process.exit(2);
}
const maxRank = maxArg ? sensRank(maxArg) : Infinity;
const withVault = !argv.includes('--no-vault') && !maxArg && fs.existsSync(VAULT_FILE);

const catalog = loadCatalog();
const { items, added, missing, raised } = syncCatalog(catalog);
for (const r of raised) console.warn(`⚠ sensitivity raised: ${r}`);

const vault = fs.existsSync(VAULT_FILE) ? JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')) : null;
const unknownRefs = [...new Set(items.flatMap((it) => it.vaultRefs))].filter((n) => !vault?.secrets?.[n]);
for (const n of unknownRefs) console.warn(`⚠ {{vault:${n}}} is referenced but not in ${path.relative(CONTENT, VAULT_FILE)}`);

if (checkOnly) {
  console.log(`docs: ${items.length}, new: ${added.length}, removed: ${missing.length}, raised: ${raised.length}, unknown vault refs: ${unknownRefs.length}`);
  process.exit(0);
}
saveCatalog(catalog);

const records = [], search = [], excluded = new Set();
let dropped = 0;
for (const it of items) {
  const abs = path.join(CONTENT, it.rel);
  const rank = sensRank(it.entry.sensitivity);
  if (it.entry.hidden || rank > maxRank) { excluded.add(abs); dropped++; continue; }
  const rec = toRecord(it);
  delete rec.sensitivityReviewed;
  rec.history = gitHistory(it.rel);
  if (rank >= sensRank('極機密')) { rec.offline = true; excluded.add(abs); }
  else if (rank >= sensRank('機密')) rec.gated = true;
  else search.push({ id: rec.id, t: it.text.slice(0, TEXT_CAP) });
  records.push(rec);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SITE, DIST, { recursive: true });
const DIST_DOCS = path.join(DIST, 'docs');
fs.cpSync(DOCS, DIST_DOCS, {
  recursive: true,
  filter: (s) => !path.basename(s).includes(':') && !excluded.has(s) && s !== path.join(DOCS, 'catalog.json'),
});
if (withVault) fs.copyFileSync(VAULT_FILE, path.join(DIST, 'vault.json'));

// HTML docs with vault fields load the reveal widget (absolute path: docs live at any depth under /docs/).
const TAG = '<script type="module" src="/vault.js"></script>';
let injected = 0;
for (const it of items) {
  if (it.type !== 'html' || !it.vaultRefs.length) continue;
  const f = path.join(DIST_DOCS, path.relative(DOCS, path.join(CONTENT, it.rel)));
  if (!fs.existsSync(f)) continue;
  const html = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${TAG}</body>`) : html + TAG);
  injected++;
}

records.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
const out = {
  builtAt: new Date().toISOString(),
  maxSensitivity: maxArg || null,
  site: catalog.site,
  vault: withVault,
  categories: catalog.categories, statuses: catalog.statuses, sensitivities: catalog.sensitivities,
  projects: catalog.projects, filters: catalog.filters,
  docs: records,
};
fs.writeFileSync(path.join(DIST, 'catalog.json'), JSON.stringify(out));
fs.writeFileSync(path.join(DIST, 'search-index.json'), JSON.stringify(search));

const n = (lvl) => records.filter((r) => r.sensitivity === lvl).length;
const vaultNote = vault ? `; vault: ${Object.keys(vault.secrets).length} secrets${withVault ? '' : ' (not deployed)'}, ${injected} html docs wired` : '';
console.log(`built ${records.length} docs → dist/  (${SENSITIVITIES.map((s) => `${s} ${n(s)}`).join(' · ')}; new: ${added.length}${added.length ? ' — ' + added.join(', ') : ''}; removed: ${missing.length}${dropped ? `; dropped: ${dropped}` : ''}${vaultNote})`);
