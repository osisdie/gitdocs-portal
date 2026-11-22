// Cloudflare Access JWT verification (RS256) with WebCrypto only.
// Keys come from https://<team domain>/cdn-cgi/access/certs and are cached per isolate.

const JWKS_TTL_MS = 10 * 60 * 1000;
const REFRESH_MIN_MS = 30 * 1000; // an unknown kid triggers a refetch (key rotation), at most this often
const SKEW_S = 60;
const cache = new Map(); // team domain → { at, keys: Map<kid, Promise<CryptoKey>> }

export const clearJwksCache = () => cache.clear();

export const teamOrigin = (teamDomain) => `https://${String(teamDomain).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function fetchJwks(origin, fetchFn) {
  const res = await fetchFn(`${origin}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    const { kty, n, e } = jwk;
    keys.set(jwk.kid, crypto.subtle.importKey('jwk', { kty, n, e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']).catch(() => null));
  }
  return keys;
}

async function keyFor(origin, kid, fetchFn, now) {
  let entry = cache.get(origin);
  const stale = !entry || now - entry.at > JWKS_TTL_MS;
  const unknownKid = entry && !entry.keys.has(kid) && now - entry.at > REFRESH_MIN_MS;
  if (stale || unknownKid) {
    entry = { at: now, keys: await fetchJwks(origin, fetchFn) };
    cache.set(origin, entry);
  }
  return (await entry.keys.get(kid)) || null;
}

/**
 * Verify an Access JWT. Returns the payload; throws Error with a short reason otherwise.
 * opts: { teamDomain, aud, fetch, now (ms) }
 */
export async function verifyAccessJwt(token, { teamDomain, aud, fetch: fetchFn = fetch, now = Date.now() }) {
  if (!teamDomain || !aud) throw new Error('TEAM_DOMAIN / ACCESS_AUD not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { throw new Error('malformed token'); }
  if (header.alg !== 'RS256') throw new Error('unexpected alg');
  const origin = teamOrigin(teamDomain);
  const key = await keyFor(origin, header.kid, fetchFn, now);
  if (!key) throw new Error('unknown signing key');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('bad signature');
  const t = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + SKEW_S < t) throw new Error('token expired');
  if (typeof payload.nbf === 'number' && payload.nbf - SKEW_S > t) throw new Error('token not yet valid');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('audience mismatch');
  if (payload.iss && payload.iss.replace(/\/+$/, '') !== origin) throw new Error('issuer mismatch');
  return payload;
}
