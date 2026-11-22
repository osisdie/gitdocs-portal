// Shared fixture for the server tests: a small deployed catalog, search index, vault and D1 users.
import { createVault, deriveKey, exportKey, seal } from '../site/vault-core.js';
import { createD1 } from './helpers/d1.mjs';
import { assets, AUD, TEAM } from './helpers/server.mjs';

export const STATUSES = ['待處理', '待確認', '已確認', '已發布', '封存'];

export const catalog = () => ({
  builtAt: '2026-11-22T00:00:00.000Z',
  site: { title: 'test' },
  statuses: STATUSES,
  categories: ['報告'],
  sensitivities: ['公開', '內部', '機密', '極機密'],
  projects: {
    alpha: { title: 'alpha', desc: '' },
    'alpha/sub': { title: 'sub', desc: '', parent: 'alpha' },
    beta: { title: 'beta', desc: '' },
    '（索引）': { title: '（索引）', desc: '' },
  },
  filters: [
    { name: 'beta only', query: 'p:beta' },
    { name: 'pending', query: 's:待處理' },
    { name: 'not beta', query: '-p:beta' },
  ],
  docs: [
    { id: 1, path: 'docs/alpha/a.md', project: 'alpha', subproject: '', title: 'A', status: '待處理', tags: [], vault: ['alpha/token'] },
    { id: 2, path: 'docs/alpha/sub/b 報告.html', project: 'alpha', subproject: 'sub', title: 'B', status: '待確認', tags: ['x'], assignee: 'editor@example.com' },
    { id: 3, path: 'docs/beta/c.md', project: 'beta', subproject: '', title: 'C', status: '已確認', tags: [], vault: ['beta/token'] },
    { id: 4, path: 'docs/README.md', project: '（索引）', subproject: '', title: 'Index', status: '已發布', tags: [] },
  ],
});

export const searchIndex = [{ id: 1, t: 'alpha body' }, { id: 2, t: 'sub body' }, { id: 3, t: 'beta body' }, { id: 4, t: 'index body' }];

export const PASS = 'test passphrase for the server vault';
let vaultCache;
/** vault.json with two secrets + the raw key (VAULT_KEY). Built once: PBKDF2 at 600k iterations is slow. */
export async function vaultFixture() {
  if (vaultCache) return vaultCache;
  const { vault } = await createVault(PASS);
  const key = await deriveKey(PASS, vault.kdf, true);
  vault.secrets['alpha/token'] = await seal(key, 'alpha/token', 'alpha-secret-value');
  vault.secrets['beta/token'] = await seal(key, 'beta/token', 'beta-secret-value');
  vault.secrets['acme/token'] = await seal(key, 'acme/token', 'acme-secret-value');
  vaultCache = { vault, rawKey: await exportKey(key) };
  return vaultCache;
}

export const USERS = [
  ['viewer@example.com', [['alpha', 'viewer']]],
  ['editor@example.com', [['alpha', 'editor']]],
  ['manager@example.com', [['alpha', 'manager']]],
  ['star@example.com', [['*', 'viewer']]],
  ['mixed@example.com', [['*', 'viewer'], ['beta', 'editor']]],
  ['idx@example.com', [['（索引）', 'viewer']]],
  ['bmanager@example.com', [['beta', 'manager']]],
];

/** extraFiles: deployed files added to (or replacing) the fixture's, served by one asset server with the real lookup order. */
export async function makeEnv(extra = {}, extraFiles = {}) {
  const db = createD1();
  const at = '2026-11-01T00:00:00.000Z';
  for (const [email, rows] of USERS) {
    db.raw.prepare('INSERT INTO users (email, name, disabled, created_at, created_by) VALUES (?, ?, 0, ?, ?)').run(email, email.split('@')[0], at, 'seed');
    for (const [p, r] of rows) db.raw.prepare('INSERT INTO memberships (email, project, role) VALUES (?, ?, ?)').run(email, p, r);
  }
  db.raw.prepare('INSERT INTO users (email, name, disabled, created_at, created_by) VALUES (?, ?, 1, ?, ?)').run('disabled@example.com', 'gone', at, 'seed');
  db.raw.prepare("INSERT INTO memberships (email, project, role) VALUES ('disabled@example.com', 'alpha', 'editor')").run();
  const { vault, rawKey } = await vaultFixture();
  const files = {
    '/index.html': '<!doctype html><title>app</title>',
    '/app.js': 'console.log(1)',
    '/sw.js': '// sw',
    '/icons/icon.svg': '<svg/>',
    '/catalog.json': catalog(),
    '/search-index.json': searchIndex,
    '/vault.json': vault,
    '/docs/alpha/a.md': '# A',
    '/docs/alpha/sub/b 報告.html': '<p>B</p>',
    '/docs/beta/c.md': '# C',
    '/docs/README.md': '# Index',
    '/docs/stray.txt': 'not in catalog',
    ...extraFiles,
  };
  return {
    DB: db, ASSETS: assets(files),
    TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OWNER_EMAILS: 'Owner@Example.com, second-owner@example.com',
    VAULT_KEY: rawKey,
    ...extra,
  };
}
