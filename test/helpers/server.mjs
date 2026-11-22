// Simulates Cloudflare Pages for tests: static assets (env.ASSETS), the middleware and the /api catch-all.
import { gate } from '../../functions/_lib/gate.js';
import { handleApi } from '../../functions/_lib/api.js';
import { clearAssetCache } from '../../functions/_lib/assets.js';
import { clearJwksCache } from '../../functions/_lib/jwt.js';
import { clearVaultKey } from '../../functions/_lib/vault.js';

export const ORIGIN = 'https://docs.example.com';
export const TEAM = 'team.example.com';
export const AUD = 'test-aud';

/** Like the Pages asset server: decodes the path once, then tries the file, `<path>.html` and `<path>/index.html`. */
export function assets(files) {
  return {
    async fetch(req) {
      const p = decodeURIComponent(new URL(req.url).pathname);
      const hit = [p, `${p}.html`, `${p.replace(/\/$/, '')}/index.html`].find((c) => c in files);
      if (!hit) return new Response('not found', { status: 404 });
      const v = files[hit];
      return new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200 });
    },
  };
}

// ---------- signed Access tokens ----------
const enc = new TextEncoder();
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const part = (obj) => b64url(enc.encode(JSON.stringify(obj)));

export async function keyPair(kid = 'k1') {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey: pair.privateKey, jwk };
}

export async function sign(key, claims, header = {}) {
  const h = part({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const p = part(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

export const claimsFor = (email, extra = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { email, aud: [AUD], iss: `https://${TEAM}`, iat: now, exp: now + 3600, ...extra };
};

/** fetch stub serving the team JWKS; counts calls. */
export function jwksFetch(keysRef) {
  const f = async (url) => {
    f.calls++;
    if (url !== `https://${TEAM}/cdn-cgi/access/certs`) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify({ keys: keysRef().map((k) => k.jwk) }), { status: 200 });
  };
  f.calls = 0;
  return f;
}

export function resetCaches() {
  clearAssetCache();
  clearJwksCache();
  clearVaultKey();
}

/**
 * One request through middleware → API / assets. opts: { method, token, body, headers, deps }.
 * Mutating calls default to what a same-origin fetch from the portal sends (JSON + Sec-Fetch-Site); a header given
 * as null in `headers` is removed. `next(request)` forwards a rewritten request, as in Pages Functions.
 */
export async function serve(env, path, { method = 'GET', token, body, headers = {}, deps = {}, origin = ORIGIN } = {}) {
  const mutating = method !== 'GET' && method !== 'HEAD';
  const h = new Headers(mutating ? { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } : {});
  for (const [k, v] of Object.entries(headers)) { if (v === null) h.delete(k); else h.set(k, v); }
  if (token) h.set('cf-access-jwt-assertion', token);
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const request = new Request(origin + path, { method, headers: h, body: payload });
  const ctx = { request, env, data: {} };
  ctx.next = async (input) => {
    const req = input ? new Request(input) : request;
    ctx.forwarded = new URL(req.url).pathname;
    return ctx.forwarded.startsWith('/api/') ? handleApi(ctx, deps) : env.ASSETS.fetch(req);
  };
  const res = await gate(ctx, deps);
  res.forwarded = ctx.forwarded;
  return res;
}
