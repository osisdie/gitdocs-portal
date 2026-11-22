// Server vault (DESIGN.md → Server vault): decrypts vault.json from env.ASSETS; the key is built once per isolate.
//
// VAULT_KEY (preferred): the raw AES key printed by `npm run vault -- key`. Workers' WebCrypto refuses PBKDF2 above
// 100,000 iterations and the vault uses 600,000, so deriving from VAULT_PASSPHRASE only works for vaults created
// with fewer iterations (it is kept as a fallback; it also costs a lot of CPU on every cold start).
import { deriveKey, importKey, unseal, verifyKey } from '../../site/vault-core.js';
import { assetJson } from './assets.js';

let cached = null; // { fingerprint, key: Promise<CryptoKey> }

export const clearVaultKey = () => { cached = null; };

async function buildKey(env, vault) {
  const key = env.VAULT_KEY ? await importKey(env.VAULT_KEY.trim()) : await deriveKey(env.VAULT_PASSPHRASE, vault.kdf);
  if (!(await verifyKey(key, vault))) throw new Error('VAULT_KEY / VAULT_PASSPHRASE does not open vault.json');
  return key;
}

export async function vaultKey(env, vault) {
  if (!env.VAULT_KEY && !env.VAULT_PASSPHRASE) throw new Error('server vault not configured (VAULT_KEY)');
  const fingerprint = `${vault.kdf.salt}:${env.VAULT_KEY ? 'k' : 'p'}`;
  if (!cached || cached.fingerprint !== fingerprint) {
    cached = { fingerprint, key: buildKey(env, vault) };
    cached.key.catch(() => { cached = null; }); // retry on the next request instead of caching the failure
  }
  return cached.key;
}

/** Plaintext of a secret, or null when the deployment has no vault / no such secret. */
export async function revealSecret(env, request, name) {
  const vault = await assetJson(env, request, '/vault.json', { optional: true });
  if (!vault?.secrets?.[name]) return null;
  return unseal(await vaultKey(env, vault), name, vault.secrets[name]);
}
