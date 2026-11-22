#!/usr/bin/env node
// Pull live workflow state from D1 back into git (DESIGN.md → State back to git).
//   npm run state:pull [-- --dry-run] [--local] [--db=<database_name>]
// Reads doc_state rows and notes that changed since the last pull (per path, table `synced`), writes status /
// assignee / reviewer / tags into docs/catalog.json, appends notes to docs/notes/<id>.md, then records the exported
// timestamps in `synced`. Project-shared saved filters are snapshotted whole into docs/notes/shared-filters.json
// (docs/notes/ is neither scanned as documents nor deployed). Git stays the long-term record; D1 is the live layer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, CONTENT, NOTES_DIR, loadCatalog, saveCatalog, PEOPLE_FIELDS } from './lib/catalog.mjs';

const WRANGLER = 'wrangler@4.166.0';

export const DOCS_SQL = `SELECT d.path, d.status, d.assignee, d.reviewer, d.tags, d.updated_by, d.updated_at
FROM doc_state d LEFT JOIN synced s ON s.path = d.path WHERE s.at IS NULL OR d.updated_at > s.at ORDER BY d.updated_at`;
export const NOTES_SQL = `SELECT n.id, n.path, n.author, n.body, n.created_at
FROM notes n LEFT JOIN synced s ON s.path = n.path WHERE s.at IS NULL OR n.created_at > s.at ORDER BY n.id`;

export const SHARED_SQL = 'SELECT project, name, params, created_by, created_at FROM shared_filters ORDER BY project, name';
export const sharedFile = (notesDir = NOTES_DIR) => path.join(notesDir, 'shared-filters.json');
/** Deterministic snapshot text of shared_filters rows (no D1 ids: they are not stable across databases). */
export function sharedFiltersJson(rows) {
  const clean = (rows || []).map((r) => ({ project: r.project, name: r.name, params: r.params, created_by: r.created_by, created_at: r.created_at }))
    .sort((a, b) => (a.project + '\0' + a.name < b.project + '\0' + b.name ? -1 : 1));
  return `${JSON.stringify(clean, null, 2)}\n`;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** database_name of the [[d1_databases]] entry with binding "DB" in a wrangler.toml text. */
export function dbNameFromToml(text) {
  for (const block of String(text).split(/^\s*\[/m)) {
    if (!/^\[d1_databases\]\]/.test(block)) continue;
    const binding = (block.match(/^\s*binding\s*=\s*["']([^"']+)["']/m) || [])[1];
    const name = (block.match(/^\s*database_name\s*=\s*["']([^"']+)["']/m) || [])[1];
    if (binding === 'DB' && name) return name;
  }
  return null;
}

/** Line written before each pulled note; matched as a whole line, so a note body cannot fake it. */
export const noteMarker = (id) => `<!-- gitdocs-note:${Number(id)} -->`;
/** Note bodies are user input: quote every line so a body cannot forge headings or markers. */
export const quote = (body) => String(body).trim().split(/\r\n|\r|\n/).map((l) => (l ? `> ${l}` : '>')).join('\n');
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');

/**
 * Apply exported rows to the catalog (mutates it) and to notes files.
 * Returns { docs: [{ id, path, fields }], notes: [{ id, path, file }], marks: Map<path, at>, warnings }.
 */
export function applyExport(catalog, { docs = [], notes = [] }, { notesDir = NOTES_DIR, write = true } = {}) {
  const out = { docs: [], notes: [], marks: new Map(), warnings: [] };
  const mark = (p, at) => { if (!out.marks.has(p) || at > out.marks.get(p)) out.marks.set(p, at); };
  for (const row of docs) {
    mark(row.path, row.updated_at);
    const entry = catalog.docs[row.path];
    if (!entry) { out.warnings.push(`${row.path}: not in catalog (deleted or renamed?) — state skipped`); continue; }
    const fields = [];
    if (row.status && row.status !== entry.status) {
      if (catalog.statuses.includes(row.status)) { entry.status = row.status; fields.push('status'); }
      else out.warnings.push(`${row.path}: unknown status ${row.status} — skipped`);
    }
    for (const k of PEOPLE_FIELDS.filter((f) => f !== 'reporter')) {
      const v = row[k] || undefined;
      if (v !== entry[k]) { if (v) entry[k] = v; else delete entry[k]; fields.push(k); }
    }
    let tags = row.tags;
    if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = null; } }
    if (Array.isArray(tags) && JSON.stringify(tags) !== JSON.stringify(entry.tags || [])) { entry.tags = tags; fields.push('tags'); }
    if (fields.length) out.docs.push({ id: entry.id, path: row.path, fields });
  }
  for (const n of notes) {
    mark(n.path, n.created_at);
    const entry = catalog.docs[n.path];
    if (!entry) { out.warnings.push(`${n.path}: not in catalog — note ${n.id} skipped`); continue; }
    const file = path.join(notesDir, `${entry.id}.md`);
    const marker = noteMarker(n.id);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // already pulled (an earlier run did not reach the `synced` update)
    if (existing.split(/\r?\n/).includes(marker)) continue;
    const head = existing || `# Notes · #${String(entry.id).padStart(7, '0')} ${entry.title}\n\n${n.path}\n`;
    const block = `\n${marker}\n## ${n.created_at.replace('T', ' ').replace(/\.\d+Z$/, 'Z')} · ${oneLine(n.author)}\n\n${quote(n.body)}\n`;
    if (write) { fs.mkdirSync(notesDir, { recursive: true }); fs.writeFileSync(file, head + block); }
    out.notes.push({ id: n.id, path: n.path, file });
  }
  return out;
}

export function markSql(marks) {
  if (!marks.size) return null;
  const values = [...marks].map(([p, at]) => `(${q(p)}, ${q(at)})`).join(', ');
  return `INSERT INTO synced (path, at) VALUES ${values} ON CONFLICT (path) DO UPDATE SET at = excluded.at WHERE excluded.at > synced.at`;
}

export function commitMessage(result) {
  const parts = [];
  if (result.docs.length) parts.push(`${result.docs.length} docs`);
  if (result.notes.length) parts.push(`${result.notes.length} notes`);
  const lines = result.docs.map((d) => `- #${d.id} ${d.fields.join(', ')}`);
  return `docs(state): pull workflow state from D1 (${parts.join(', ')})${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
}

// ---------- CLI ----------
function loadDotEnv(dirs) {
  for (const dir of dirs) {
    const f = path.join(dir, '.env');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

function wrangler(cwd, db, sql, local) {
  const args = ['--yes', WRANGLER, 'd1', 'execute', db, local ? '--local' : '--remote', '--json', '--command', sql];
  const out = execFileSync('npx', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0]?.results || [];
}

async function main(argv) {
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.length ? v.join('=') : true]; }));
  const dirs = [...new Set([CONTENT, ROOT, process.cwd()])];
  loadDotEnv(dirs);
  const tomlDir = dirs.find((d) => fs.existsSync(path.join(d, 'wrangler.toml')));
  const db = flags.db || process.env.D1_DATABASE || (tomlDir && dbNameFromToml(fs.readFileSync(path.join(tomlDir, 'wrangler.toml'), 'utf8')));
  if (!db) { console.error('找不到 D1 資料庫名稱：在 wrangler.toml 設定 [[d1_databases]] binding = "DB"，或設 D1_DATABASE，或加 --db=<name>'); process.exit(1); }
  const cwd = tomlDir || CONTENT;
  const local = !!flags.local;
  const dry = !!flags['dry-run'];

  const docs = wrangler(cwd, db, DOCS_SQL, local);
  const notes = wrangler(cwd, db, NOTES_SQL, local);
  // shared filters: a full snapshot each time (migration 0003; an older database without the table is skipped)
  let sharedChanged = false;
  try {
    const text = sharedFiltersJson(wrangler(cwd, db, SHARED_SQL, local));
    const file = sharedFile();
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : (text === '[]\n' ? text : '');
    sharedChanged = before !== text;
    if (sharedChanged) {
      console.log(`shared filters → ${path.relative(CONTENT, file)}`);
      if (!dry) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
    }
  } catch (e) { console.warn(`⚠ shared filters skipped: ${String(e.message).split('\n')[0]}`); }
  const catalog = loadCatalog();
  const result = applyExport(catalog, { docs, notes }, { write: !dry });
  for (const w of result.warnings) console.warn(`⚠ ${w}`);
  for (const d of result.docs) console.log(`#${d.id} ${d.path}: ${d.fields.join(', ')}`);
  for (const n of result.notes) console.log(`note ${n.id} → ${path.relative(CONTENT, n.file)}`);
  if (!result.docs.length && !result.notes.length && !result.marks.size) {
    if (sharedChanged && !dry) console.log(`\n建議 commit：\n\n  git add docs/notes/shared-filters.json && git commit -m "chore(state): shared filters snapshot"\n`);
    else if (!sharedChanged) console.log('D1 沒有新的變更。');
    return;
  }
  if (dry) { console.log(`（--dry-run：沒有寫入檔案，也沒有更新 synced）`); return; }
  if (result.docs.length) saveCatalog(catalog);
  const sql = markSql(result.marks);
  if (sql) wrangler(cwd, db, sql, local);
  console.log(`\n已更新 synced（${result.marks.size} 個路徑）。建議 commit：\n\n  git add docs/catalog.json docs/notes && git commit -m "${commitMessage(result).split('\n')[0]}"\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
