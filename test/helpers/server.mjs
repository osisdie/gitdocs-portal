// Simulates Cloudflare Pages for tests: static assets (env.ASSETS), the middleware and the /api catch-all.
import { gate } from '../../functions/_lib/gate.js';
import { handleApi } from '../../functions/_lib/api.js';
import { clearAssetCache } from '../../functions/_lib/assets.js';
import { clearJwksCache } from '../../functions/_lib/jwt.js';
import { clearVaultKey } from '../../functions/_lib/vault.js';

export const ORIGIN = 'https://docs.example.com';
export const TEAM = 'team.example.com';
export const AUD = 'test-aud';

/**
 * The Pages asset server's lookup (wrangler pages generateHandler, html_handling auto-trailing-slash): decode once;
 * '/x/' serves x/index.html (else redirects to /x when x.html exists); otherwise the exact file wins
 * (x.html is served only when an extensionless x also exists, else it redirects to /x), then x.html,
 * then a redirect to /x/ when x/index.html exists. Kept independent of the gate so tests cannot pass by agreeing with it.
 */
export function assets(files) {
  const has = (p) => Object.hasOwn(files, p);
  const serveFile = (p) => new Response(typeof files[p] === 'string' ? files[p] : JSON.stringify(files[p]), { status: 200 });
  const redirect = (to) => new Response(null, { status: 308, headers: { location: encodeURI(to) } });
  const notFound = () => new Response('not found', { status: 404 });
  return {
    async fetch(req) {
      let p = new URL(req.url).pathname;
      try { p = decodeURIComponent(p); } catch { /* served as-is, like Pages */ }
      if (p.endsWith('/')) {
        if (has(`${p}index.html`)) return serveFile(`${p}index.html`);
        if (p.endsWith('/index/')) return redirect(p.slice(0, -6));
        if (has(`${p.slice(0, -1)}.html`)) return redirect(p.slice(0, -1));
        return notFound();
      }
      if (has(p)) {
        if (!p.endsWith('.html')) return serveFile(p);
        const bare = p.slice(0, -5);
        if (bare.endsWith('/index')) return redirect(bare.slice(0, -5));
        return has(bare) || bare === '/' ? serveFile(p) : redirect(bare);
      }
      if (p.endsWith('/index')) return redirect(p.slice(0, -5));
      if (has(`${p}.html`)) return serveFile(`${p}.html`);
      if (has(`${p}/index.html`)) return redirect(`${p}/`);
      return notFound();
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
