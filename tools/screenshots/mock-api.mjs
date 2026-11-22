// Fake server-mode API for screenshots. Shapes follow DESIGN.md "HTTP API" / "Tenant vaults" / "People and display
// names" and what site/api.js, site/app.js and site/admin.js read. Everything is demo data for the fictional
// Northwind Labs (example.com addresses only).
import fs from 'node:fs';
import path from 'node:path';
import { deriveKey, unseal } from '../../site/vault-core.js';

export const ME = 'alice@example.com';
const DEMO_PASSPHRASE = 'correct horse battery staple';
const NOW = Date.parse('2026-11-22T09:30:00Z');
const ago = (h) => new Date(NOW - h * 3600e3).toISOString();

const NAMES = {
  'alice@example.com': 'Alice Chen', 'bob@example.com': 'Bob Novak', 'chen@example.com': 'Chen Wei',
  'dana@example.com': 'Dana Ortiz', 'erin@example.com': 'Erin Park', 'farid@example.com': 'Farid Haddad',
};
const USERS = [
  { email: 'alice@example.com', owner: true, memberships: [], last_seen: ago(0.2), created_at: '2026-08-20T08:00:00Z', created_by: 'alice@example.com' },
  { email: 'bob@example.com', memberships: [{ project: 'platform', role: 'manager' }, { project: 'ops', role: 'editor' }], last_seen: ago(3), created_at: '2026-08-21T09:12:00Z', created_by: 'alice@example.com' },
  { email: 'chen@example.com', memberships: [{ project: 'handbook', role: 'manager' }, { project: '*', role: 'viewer' }], last_seen: ago(26), created_at: '2026-08-21T09:15:00Z', created_by: 'alice@example.com' },
  { email: 'dana@example.com', memberships: [{ project: 'product', role: 'editor' }, { project: 'ops', role: 'manager' }], last_seen: ago(5), created_at: '2026-08-22T10:02:00Z', created_by: 'alice@example.com' },
  { email: 'erin@example.com', memberships: [{ project: 'product', role: 'viewer' }], last_seen: ago(72), created_at: '2026-10-03T13:40:00Z', created_by: 'dana@example.com' },
  { email: 'farid@example.com', disabled: true, memberships: [], last_seen: ago(500), created_at: '2026-09-01T07:30:00Z', created_by: 'bob@example.com' },
].map((u) => ({ disabled: false, owner: false, name: NAMES[u.email], ...u }));
const named = (rows, key) => rows.map((r) => ({ ...r, [`${key}_name`]: NAMES[r[key]] }));

// Web edits that D1 would hold, keyed by catalog id: [hours ago, by, note count, overrides]
const STATE = {
  9: [1.5, 'dana@example.com', 3, { status: '待確認' }],
  20: [4, 'alice@example.com', 1, {}],
  24: [6, 'dana@example.com', 2, {}],
  16: [20, 'bob@example.com', 1, {}],
  25: [27, 'bob@example.com', 1, {}],
  23: [30, 'chen@example.com', 0, {}],
  17: [50, 'dana@example.com', 2, {}],
};
const NOTES = {
  9: [
    ['bob@example.com', 'Ran the failover drill on staging: promotion took 41 s, replica lag was 3 s. Step 2 works as written.', 30],
    ['chen@example.com', 'Can we add the read-only fallback for checkout while the replica is promoted?', 6],
    ['dana@example.com', 'Added a verify step for p99 latency. Moving to feedback — Alice, please confirm.', 1.5],
  ],
};
const HISTORY = {
  9: [
    { actor: 'dana@example.com', action: 'edit', field: 'status', old: '待處理', new: '待確認', at: ago(1.5) },
    { actor: 'dana@example.com', action: 'note', field: null, old: null, new: 'Added a verify step for p99 latency…', at: ago(1.5) },
    { actor: 'dana@example.com', action: 'edit', field: 'reviewer', old: '', new: 'alice@example.com', at: ago(1.6) },
    { actor: 'chen@example.com', action: 'note', field: null, old: null, new: 'Can we add the read-only fallback…', at: ago(6) },
    { actor: 'bob@example.com', action: 'edit', field: 'tags', old: 'runbook', new: 'runbook, orders', at: ago(29) },
    { actor: 'bob@example.com', action: 'edit', field: 'assignee', old: '', new: 'bob@example.com', at: ago(30) },
  ],
};
const VAULT_AUDIT = [
  ['bob@example.com', 'ops/db-admin-password', 'docs/ops/runbooks/2026-09-20-database-failover.md', 'show', 29],
  ['bob@example.com', 'platform/staging-db-url', null, 'copy', 40],
  ['dana@example.com', 'ops/oncall-webhook-token', 'docs/ops/runbooks/2026-11-02-on-call-handbook.md', 'copy', 52],
  ['bob@example.com', 'postman/orders/api_key', 'docs/platform/api/northwind-orders-staging.postman_environment.json', 'copy', 75],
];
// Web vault (D1 vault_secrets): name → [value, note, updated_by, hours ago]. Host-vault names come from vault.json.
const WEB_VAULT = {
  'platform/registry-token': ['nwreg_demo_rotated_77c1e0a4b9d2', 'container registry deploy token (rotated)', 'bob@example.com', 20],
  'platform/staging-db-url': ['postgres://orders_app:demo-only@db.staging.example.com/orders', 'staging orders database URL', 'bob@example.com', 44],
  'ops/pager-escalation-key': ['esc_demo_5d4c3b2a1f0e', 'pager escalation API key', 'dana@example.com', 70],
};

/** Builds the API handler for one dist/ build. Returns null for paths it does not know (→ 404). */
export function createMockApi(distDir, contentDir) {
  const catalog = JSON.parse(fs.readFileSync(path.join(distDir, 'catalog.json'), 'utf8'));
  const byId = new Map(catalog.docs.map((d) => [d.id, d]));
  const vaultFile = path.join(contentDir, 'vault', 'vault.json');
  const hostVault = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
  const hostDate = fs.statSync(vaultFile).mtime.toISOString().slice(0, 10);
  let hostKey = null;
  const publicProjects = Object.entries(catalog.projects).filter(([, v]) => !v.parent && v.visibility === 'public').map(([k]) => k);

  const state = { docs: {}, people: Object.fromEntries(Object.entries(NAMES).slice(0, 4)) };
  for (const [id, [h, by, notes, over]] of Object.entries(STATE)) {
    const d = byId.get(Number(id));
    if (!d) continue;
    state.docs[d.path] = { status: d.status, assignee: d.assignee ?? null, reviewer: d.reviewer ?? null, tags: null,
      ...over, updated_by: by, updated_at: ago(h), notes };
  }

  /** Same lookup order as the server: web (D1) first, then the host vault. */
  async function secret(name) {
    if (WEB_VAULT[name]) return { value: WEB_VAULT[name][0], origin: 'web' };
    if (!hostVault.secrets[name]) return null;
    hostKey ||= await deriveKey(DEMO_PASSPHRASE, hostVault.kdf, false);
    return { value: await unseal(hostKey, name, hostVault.secrets[name]), origin: 'host' };
  }
  function secretsOf(project) {
    const names = [...new Set([...Object.keys(WEB_VAULT), ...Object.keys(hostVault.secrets)])].filter((n) => n.startsWith(`${project}/`));
    return names.map((name) => {
      const web = WEB_VAULT[name], host = hostVault.secrets[name];
      const stores = [web && 'web', host && 'host'].filter(Boolean);
      return web
        ? { name, note: web[1], origin: 'web', stores, updated_by: web[2], updated_by_name: NAMES[web[2]], updated_at: ago(web[3]) }
        : { name, note: host.note || '', origin: 'host', stores, updated_by: null, updated_at: hostDate };
    });
  }
  const audit = () => {
    const history = Object.entries(HISTORY).flatMap(([id, rows]) => named(rows, 'actor').map((r) => ({ ...r, path: byId.get(Number(id))?.path })));
    history.push({ actor: 'alice@example.com', actor_name: NAMES['alice@example.com'], action: 'membership', path: null, field: 'role', old: '', new: 'product: viewer', at: ago(80) });
    const vault = VAULT_AUDIT.map(([email, name, p, action, h]) => ({ email, actor_name: NAMES[email], name, path: p, action, at: ago(h) }));
    return { history, vault };
  };

  return async function handle(method, url, body) {
    const p = url.pathname;
    let m;
    if (p === '/api/me' && method === 'GET') {
      return [200, { email: ME, name: NAMES[ME], owner: true, roles: { platform: 'manager', product: 'editor' }, publicProjects, prefs: {} }];
    }
    if (p === '/api/me' && method === 'PATCH') return [200, { email: ME, name: body?.name ?? NAMES[ME] }];
    if (p === '/api/me/prefs') return [200, { ok: true }];
    if (p === '/api/state') return [200, state];
    if ((m = p.match(/^\/api\/docs\/(\d+)\/notes$/))) {
      const id = Number(m[1]);
      if (method === 'POST') return [201, { id: 99, author: ME, author_name: NAMES[ME], body: body?.body || '', created_at: new Date(NOW).toISOString() }];
      const rows = NOTES[id] || (state.docs[byId.get(id)?.path]?.notes ? [['bob@example.com', 'Looks good to me — one small comment inline.', 20]] : []);
      return [200, rows.map(([author, text, h], i) => ({ id: id * 10 + i, author, author_name: NAMES[author], body: text, created_at: ago(h) }))];
    }
    if ((m = p.match(/^\/api\/docs\/(\d+)\/history$/))) return [200, named(HISTORY[Number(m[1])] || [], 'actor')];
    if ((m = p.match(/^\/api\/docs\/(\d+)$/)) && method === 'PATCH') return [200, { id: Number(m[1]), ...body }];
    if (p === '/api/users' && method === 'GET') return [200, USERS];
    if (p.startsWith('/api/users')) return [200, { user: USERS[0] }];
    if (p === '/api/audit') return [200, audit()];
    if (p === '/api/vault/secrets' && method === 'GET') return [200, secretsOf(url.searchParams.get('project') || '')];
    if (p === '/api/vault/secrets' && method === 'PUT') return [201, { name: body?.name, note: body?.note || '', origin: 'web', updated_by: ME, updated_at: new Date(NOW).toISOString() }];
    if (p.startsWith('/api/vault/secrets/') && method === 'DELETE') return [200, { ok: true }];
    if (p === '/api/vault/reveal' && method === 'POST') {
      // doc form { id, name } needs a doc that references the name; page form { name } is the project vault page
      if (body?.id != null && !byId.get(Number(body.id))?.vault?.includes(body.name)) return [403, { error: 'not referenced by this document' }];
      const s = await secret(String(body?.name || ''));
      return s ? [200, s] : [404, { error: 'not found' }];
    }
    return null;
  };
}
