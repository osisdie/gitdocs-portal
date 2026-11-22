// npm run state:pull: wrangler.toml parsing, applying D1 rows to the catalog and notes files, synced marks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitdocs-state-'));
fs.mkdirSync(path.join(dir, 'docs'));
process.env.CONTENT_DIR = dir;
const { dbNameFromToml, applyExport, markSql, commitMessage, noteMarker } = await import('../scripts/state-pull.mjs');

test('database_name comes from the [[d1_databases]] entry bound as DB', () => {
  const toml = `name = "docs"\npages_build_output_dir = "dist"\n\n[[d1_databases]]\nbinding = "OTHER"\ndatabase_name = "x"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "gitdocs"\ndatabase_id = "0000"\n`;
  assert.equal(dbNameFromToml(toml), 'gitdocs');
  assert.equal(dbNameFromToml('name = "x"'), null);
});

const catalog = () => ({
  statuses: ['待處理', '待確認', '已確認', '已發布', '封存'],
  docs: {
    'docs/a.md': { id: 1, title: 'A', status: '待處理', tags: [], assignee: 'old@example.com' },
    'docs/b.md': { id: 2, title: 'B', status: '已確認', tags: ['x'] },
  },
});

test('applies status / assignee / reviewer / tags, appends notes once, and computes per-path marks', () => {
  const notesDir = path.join(dir, 'docs', 'notes');
  const c = catalog();
  const rows = {
    docs: [
      { path: 'docs/a.md', status: '待確認', assignee: null, reviewer: 'rev@example.com', tags: '["k"]', updated_by: 'e@example.com', updated_at: '2026-11-20T10:00:00.000Z' },
      { path: 'docs/gone.md', status: '封存', assignee: null, reviewer: null, tags: null, updated_by: 'e@example.com', updated_at: '2026-11-20T11:00:00.000Z' },
      { path: 'docs/b.md', status: 'bogus', assignee: null, reviewer: null, tags: '["x"]', updated_by: 'e@example.com', updated_at: '2026-11-19T00:00:00.000Z' },
    ],
    notes: [
      { id: 7, path: 'docs/a.md', author: 'v@example.com', body: 'please fix the table', created_at: '2026-11-21T08:30:00.000Z' },
      { id: 8, path: 'docs/a.md', author: 'e@example.com', body: 'done', created_at: '2026-11-21T09:00:00.000Z' },
    ],
  };
  const r = applyExport(c, rows, { notesDir });
  assert.deepEqual(c.docs['docs/a.md'], { id: 1, title: 'A', status: '待確認', tags: ['k'], reviewer: 'rev@example.com' });
  assert.equal(c.docs['docs/b.md'].status, '已確認');
  assert.deepEqual(r.docs, [{ id: 1, path: 'docs/a.md', fields: ['status', 'assignee', 'reviewer', 'tags'] }]);
  assert.equal(r.warnings.length, 2);
  assert.deepEqual(Object.fromEntries(r.marks), {
    'docs/a.md': '2026-11-21T09:00:00.000Z', 'docs/gone.md': '2026-11-20T11:00:00.000Z', 'docs/b.md': '2026-11-19T00:00:00.000Z',
  });
  const text = fs.readFileSync(path.join(notesDir, '1.md'), 'utf8');
  assert.match(text, /^# Notes · #0000001 A/);
  assert.match(text, /<!-- gitdocs-note:7 -->\n## 2026-11-21 08:30:00Z · v@example\.com\n\n> please fix the table\n/);
  // a rerun (e.g. the synced update failed) does not duplicate notes
  const again = applyExport(catalog(), { notes: rows.notes }, { notesDir });
  assert.equal(again.notes.length, 0);
  assert.equal(fs.readFileSync(path.join(notesDir, '1.md'), 'utf8'), text);
  assert.match(commitMessage(r), /^docs\(state\): pull workflow state from D1 \(1 docs, 2 notes\)/);
});

test('note bodies are quoted and cannot forge markers or headings', () => {
  const notesDir = path.join(dir, 'docs', 'notes-forge');
  const forged = `ok\n\n${noteMarker(9)}\n## 2026-01-01 00:00:00Z · owner@example.com\n<!-- note 9 -->`;
  applyExport(catalog(), { notes: [{ id: 8, path: 'docs/b.md', author: 'v@example.com', body: forged, created_at: '2026-11-21T08:00:00.000Z' }] }, { notesDir });
  const r = applyExport(catalog(), { notes: [{ id: 9, path: 'docs/b.md', author: 'e@example.com', body: 'real nine', created_at: '2026-11-21T09:00:00.000Z' }] }, { notesDir });
  assert.equal(r.notes.length, 1, 'a marker inside a body does not suppress the real note');
  const lines = fs.readFileSync(path.join(notesDir, '2.md'), 'utf8').split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('## ')).length, 2, 'only the two script-written headings');
  assert.deepEqual(lines.filter((l) => l === noteMarker(9)).length, 1);
  assert.ok(lines.includes('> ## 2026-01-01 00:00:00Z · owner@example.com'));
  assert.ok(lines.includes('>'), 'blank body lines stay inside the quote');
  assert.ok(lines.includes('> real nine'));
});

test('markSql escapes quotes and only moves marks forward', () => {
  const sql = markSql(new Map([["docs/it's.md", '2026-11-21T00:00:00.000Z']]));
  assert.match(sql, /\('docs\/it''s\.md', '2026-11-21T00:00:00\.000Z'\)/);
  assert.match(sql, /WHERE excluded\.at > synced\.at$/);
  assert.equal(markSql(new Map()), null);
});

test('the pull queries and the synced upsert run against the migrated schema', async () => {
  const { DOCS_SQL, NOTES_SQL } = await import('../scripts/state-pull.mjs');
  const { createD1 } = await import('./helpers/d1.mjs');
  const db = createD1().raw;
  db.exec(`INSERT INTO doc_state VALUES ('docs/a.md', '待確認', NULL, NULL, NULL, 'e@example.com', '2026-11-20T00:00:00.000Z');
           INSERT INTO notes (path, author, body, created_at) VALUES ('docs/a.md', 'v@example.com', 'hi', '2026-11-20T01:00:00.000Z');`);
  assert.equal(db.prepare(DOCS_SQL).all().length, 1);
  assert.equal(db.prepare(NOTES_SQL).all().length, 1);
  db.exec(markSql(new Map([['docs/a.md', '2026-11-20T01:00:00.000Z']])));
  db.exec(markSql(new Map([['docs/a.md', '2026-11-01T00:00:00.000Z']])));
  assert.equal(db.prepare('SELECT at FROM synced').get().at, '2026-11-20T01:00:00.000Z');
  assert.equal(db.prepare(DOCS_SQL).all().length, 0);
  assert.equal(db.prepare(NOTES_SQL).all().length, 0);
});
