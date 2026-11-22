// Minimal D1-compatible wrapper around node:sqlite for tests: prepare().bind().first()/all()/run(), batch().
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'migrations');
const plain = (row) => (row ? { ...row } : row);

export function createD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));

  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
      for (const p of params) if (p === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in ${sql}`);
    }
    bind(...params) { return new Statement(this.sql, params); }
    exec(mode) {
      const st = db.prepare(this.sql);
      if (mode === 'first') return plain(st.get(...this.params)) ?? null;
      if (mode === 'all') return { success: true, results: st.all(...this.params).map(plain), meta: {} };
      const r = st.run(...this.params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async first(col) { const r = this.exec('first'); return r && col ? r[col] : r; }
    async all() { return this.exec('all'); }
    async run() { return this.exec('run'); }
  }

  return {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.exec(/^\s*select/i.test(s.sql) ? 'all' : 'run'));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    raw: db,
  };
}
