// Vault crypto shared by the browser (site/vault.js) and the CLI (scripts/vault.mjs). WebCrypto only.
//
// vault.json  { version, kdf: { name, hash, iterations, salt }, check: Box, secrets: { <name>: Box & { note, updated } } }
// Box         { iv, ct }  — AES-256-GCM, base64. The secret name is the AAD, so a ciphertext cannot be moved to another name.
// Key         PBKDF2-SHA256(passphrase, salt, iterations) → AES-256-GCM.
// Documents reference a secret as {{vault:<name>}}; the value itself never appears in git, dist or the search index.

export const VAULT_RE = /\{\{\s*vault:([A-Za-z0-9_.\/-]+)\s*\}\}/g;
export const NAME_RE = /^[A-Za-z0-9_.\/-]+$/;
export const KDF_ITERATIONS = 600000;
const CHECK_NAME = '__check__';
const CHECK_TEXT = 'gitdocs-vault-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Unique secret names referenced in a text. */
export const refsIn = (text) => [...new Set([...String(text).matchAll(VAULT_RE)].map((m) => m[1]))];

export async function deriveKey(passphrase, kdf, extractable = false) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: kdf.hash || 'SHA-256', salt: unb64(kdf.salt), iterations: kdf.iterations },
    base, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt'],
  );
}
export const exportKey = async (key) => b64(await crypto.subtle.exportKey('raw', key));
export const importKey = (raw) => crypto.subtle.importKey('raw', unb64(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

export async function seal(key, name, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(name) }, key, enc.encode(plaintext));
  return { iv: b64(iv), ct: b64(ct) };
}
export async function unseal(key, name, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(name) }, key, unb64(box.ct));
  return dec.decode(pt);
}

export async function verifyKey(key, vault) {
  try { return (await unseal(key, CHECK_NAME, vault.check)) === CHECK_TEXT; } catch { return false; }
}

/** A new, empty vault plus its key. */
export async function createVault(passphrase) {
  const kdf = { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: b64(crypto.getRandomValues(new Uint8Array(16))) };
  const key = await deriveKey(passphrase, kdf);
  return { key, vault: { version: 1, kdf, check: await seal(key, CHECK_NAME, CHECK_TEXT), secrets: {} } };
}

/** Re-encrypt every secret under a new passphrase (new salt). */
export async function rekeyVault(vault, oldKey, newPassphrase) {
  const { key, vault: next } = await createVault(newPassphrase);
  for (const [name, box] of Object.entries(vault.secrets)) {
    next.secrets[name] = { ...box, ...(await seal(key, name, await unseal(oldKey, name, box))) };
  }
  return { key, vault: next };
}
