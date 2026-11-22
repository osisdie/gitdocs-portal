// Server vault (DESIGN.md → Server vault, Tenant vaults). Three stores, looked up in this order:
//   web   D1 vault_secrets, encrypted with VAULT_KEY (VAULT_KEY_PREVIOUS still opens rows written before a rekey)
//   git   a mounted source's own vault, deployed as /_vaults/<source>.json, key = Pages secret VAULT_KEY_<SOURCE>
//   host  /vault.json from the host repo, key = VAULT_KEY (VAULT_PASSPHRASE as a fallback for low-iteration vaults)
// Every key is built once per isolate. Workers' WebCrypto refuses PBKDF2 above 100,000 iterations and the vault uses
// 600,000, so the raw keys printed by `npm run vault -- key` are what the server gets.
import { deriveKey, importKey, seal, unseal, verifyKey, NAME_RE } from '../../site/vault-core.js';
import { assetJson } from './assets.js';

const cache = new Map(); // store id → { fingerprint, key: Promise<CryptoKey> }

export const clearVaultKey = () => cache.clear();

function cachedKey(id, fingerprint, build) {
  let hit = cache.get(id);
  if (!hit || hit.fingerprint !== fingerprint) {
    hit = { fingerprint, key: build() };
    cache.set(id, hit);
    hit.key.catch(() => { if (cache.get(id) === hit) cache.delete(id); }); // retry next time instead of caching a failure
  }
  return hit.key;
}

export const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const NAME_MAX = 200;
export const VALUE_MAX = 16 * 1024;
/** Pages secret holding a source's vault key: VAULT_KEY_<SOURCE> (upper-case, '-' → '_'). */
export const tenantKeyName = (source) => `VAULT_KEY_${source.toUpperCase().replace(/-/g, '_')}`;
export const namespaceOf = (name) => String(name).split('/')[0];

/** A storable secret name: NAME_RE, '<namespace>/…', no empty segments, ≤ 200 characters. */
export const validName = (name) => typeof name === 'string' && name.length <= NAME_MAX && NAME_RE.test(name)
  && name.includes('/') && name.split('/').every(Boolean);

// ---------- keys ----------
export async function vaultKey(env, vault) {
  if (!env.VAULT_KEY && !env.VAULT_PASSPHRASE) throw new Error('server vault not configured (VAULT_KEY)');
  return cachedKey('host', `${vault.kdf.salt}:${env.VAULT_KEY ? 'k' : 'p'}`, async () => {
    const key = env.VAULT_KEY ? await importKey(env.VAULT_KEY.trim()) : await deriveKey(env.VAULT_PASSPHRASE, vault.kdf);
    if (!(await verifyKey(key, vault))) throw new Error('VAULT_KEY / VAULT_PASSPHRASE does not open vault.json');
    return key;
  });
}

async function tenantKey(env, source, vault) {
  const raw = env[tenantKeyName(source)];
  if (!raw) throw new Error(`${tenantKeyName(source)} is not configured`);
  return cachedKey(`git:${source}`, `${vault.kdf.salt}:${raw}`, async () => {
    const key = await importKey(String(raw).trim());
    if (!(await verifyKey(key, vault))) throw new Error(`${tenantKeyName(source)} does not open the vault of source ${source}`);
    return key;
  });
}

/** True when the web vault can encrypt (VAULT_KEY set). */
export const webVaultReady = (env) => !!env.VAULT_KEY;

const webKey = (env, which) => {
  const raw = env[which];
  return raw ? cachedKey(`web:${which}`, raw, () => importKey(String(raw).trim())) : null;
};

export async function webSeal(env, name, value) {
  if (!webVaultReady(env)) throw new Error('web vault not configured (VAULT_KEY)');
  return seal(await webKey(env, 'VAULT_KEY'), name, value);
}

async function webUnseal(env, name, box) {
  for (const which of ['VAULT_KEY', 'VAULT_KEY_PREVIOUS']) {
    const key = webKey(env, which);
    if (!key) continue;
    try { return await unseal(await key, name, box); } catch { /* try the previous key */ }
  }
  throw new Error(`web vault: VAULT_KEY (or VAULT_KEY_PREVIOUS) does not open ${name}`);
}

// ---------- stores ----------
const own = (obj, k) => !!obj && Object.hasOwn(obj, k);

/** Source names the build refuses (scripts/lib/catalog.mjs sourceList): their key would be a deployment setting. */
const RESERVED_SOURCES = new Set(['notes', 'previous']);

/** The source whose git vault may answer `name`: its first segment, when that is a mounted source of the catalog. */
function tenantOf(catalog, name) {
  const s = namespaceOf(name);
  return SOURCE_RE.test(s) && !RESERVED_SOURCES.has(s) && own(catalog?.projects, s) && catalog.projects[s]?.source === s ? s : null;
}

const tenantVault = (env, request, source) => assetJson(env, request, `/_vaults/${source}.json`, { optional: true });
const hostVault = (env, request) => assetJson(env, request, '/vault.json', { optional: true });

/** Plaintext of a secret as { value, origin }, or null when no store has it. */
export async function revealSecret(env, request, name, { db, catalog } = {}) {
  if (db) {
    const row = await db.prepare('SELECT iv, ct FROM vault_secrets WHERE name = ?').bind(name).first();
    if (row) return { value: await webUnseal(env, name, row), origin: 'web' };
  }
  const source = tenantOf(catalog, name);
  if (source) {
    const v = await tenantVault(env, request, source);
    if (own(v?.secrets, name)) return { value: await unseal(await tenantKey(env, source, v), name, v.secrets[name]), origin: 'git' };
  }
  const host = await hostVault(env, request);
  if (own(host?.secrets, name)) return { value: await unseal(await vaultKey(env, host), name, host.secrets[name]), origin: 'host' };
  return null;
}

/** Stores other than the web vault that hold `name` ('git', 'host'), without decrypting anything. */
export async function otherStores(env, request, name, catalog) {
  const out = [];
  const source = tenantOf(catalog, name);
  if (source && own((await tenantVault(env, request, source))?.secrets, name)) out.push('git');
  if (own((await hostVault(env, request))?.secrets, name)) out.push('host');
  return out;
}

/**
 * Names under `<project>/` from every store, one row per name: { name, note, origin, stores, updated_by, updated_at }.
 * No values, no ciphertext.
 */
export async function listSecrets(env, request, { db, catalog, project }) {
  const prefix = `${project}/`;
  const rows = new Map();
  const add = (name, store, meta) => {
    const r = rows.get(name);
    if (r) { r.stores.push(store); return; }
    rows.set(name, { name, note: meta.note || '', origin: store, stores: [store], updated_by: meta.updated_by || null, updated_at: meta.updated_at || null });
  };
  const web = (await db.prepare('SELECT name, note, updated_by, updated_at FROM vault_secrets WHERE substr(name, 1, ?) = ? ORDER BY name')
    .bind(prefix.length, prefix).all()).results;
  for (const r of web) add(r.name, 'web', r);
  const source = tenantOf(catalog, prefix);
  if (source) {
    const v = await tenantVault(env, request, source);
    for (const [name, box] of Object.entries(v?.secrets || {})) if (name.startsWith(prefix)) add(name, 'git', { note: box.note, updated_at: box.updated });
  }
  const host = await hostVault(env, request);
  for (const [name, box] of Object.entries(host?.secrets || {})) if (name.startsWith(prefix)) add(name, 'host', { note: box.note, updated_at: box.updated });
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
