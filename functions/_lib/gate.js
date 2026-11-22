// Middleware logic: authenticate every request, then apply the static-file rules
// (DESIGN.md → Access control on static files). Kept out of _middleware.js so tests can inject fetch / clock.
import { callerEmail, loadUser } from './auth.js';
import { canSee } from './roles.js';
import { deny, json, sameOriginJson } from './http.js';
import { assetJson, loadCatalog, catalogFor, searchIndexFor, docByPath } from './assets.js';

const NOT_ENABLED = '尚未開通，請聯絡管理員';

// App-shell files any known user may load. Default-deny: a file the build adds to site/ later stays 404 in server
// mode until it is listed here (test/server.test.mjs fails when this list and site/ drift apart).
export const SHELL_FILES = new Set([
  '/', '/index.html', '/app.js', '/app.css', '/query.js', '/model.js', '/api.js', '/admin.js', '/graph.js',
  '/graph.css', '/vault.js', '/vault-core.js', '/vault-frame.js', '/sw.js', '/manifest.webmanifest', '/robots.txt',
]);
const SHELL_DIR_RE = /^\/icons\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const isShellPath = (p) => SHELL_FILES.has(p) || SHELL_DIR_RE.test(p);

export const DOC_CSP = 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
export const SHELL_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const SERVER_VARS = ['ACCESS_AUD', 'TEAM_DOMAIN', 'OWNER_EMAILS'];

/**
 * The path the asset server will resolve, or { status } when it must be refused.
 * Pages decodes the URL path once before the asset lookup, so every rule runs on the decoded form; anything that
 * could decode differently on a second pass (a leftover '%'), climb ('..'), or be read as a separator ('\') is refused.
 */
export function normalizePath(rawPathname) {
  let p;
  try { p = decodeURIComponent(rawPathname); } catch { return { status: 400 }; }
  p = p.replace(/\/{2,}/g, '/');
  if (/[%\\\u0000-\u001f\u007f]/.test(p)) return { status: 404 };
  if (p.split('/').some((s) => s === '..' || s === '.')) return { status: 404 };
  return { path: p };
}

/** URL path for a normalised path, each segment encoded, so the asset server decodes it back to exactly `p`. */
export const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Catalog path for a normalised /docs/… path, trying the forms Pages serves (pretty URLs drop .html, folders → index.html). */
export function docForUrl(catalog, path) {
  const p = path.replace(/^\/+/, '');
  const bare = p.replace(/\/+$/, '');
  for (const c of [p, `${bare}.html`, `${bare}/index.html`]) {
    const d = docByPath(catalog, c);
    if (d) return d;
  }
  return null;
}

/** Pass the request on with its path in canonical form, so what was checked is what gets served. */
function forward(ctx, path) {
  const url = new URL(ctx.request.url);
  const canonical = encodePath(path);
  if (url.pathname === canonical) return ctx.next();
  url.pathname = canonical;
  return ctx.next(new Request(url, ctx.request));
}

async function withHeaders(resPromise, headers) {
  const res = await resPromise;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export async function gate(ctx, deps = {}) {
  const { request, env, next } = ctx;
  if (!env.DB) {
    // a deployment that set the Access variables but lost its D1 binding must not silently become a public static site
    if (SERVER_VARS.some((k) => env[k])) return deny(request, 503, 'server mode misconfigured', 'D1 binding DB is missing; ask the administrator.');
    return next(); // static mode: no D1 binding, the portal behaves exactly as before
  }
  const who = await callerEmail(request, env, deps);
  if (who.error) return deny(request, who.status, NOT_ENABLED, who.error);
  const user = await loadUser(env.DB, env, who.email);
  if (!user) return deny(request, 403, NOT_ENABLED, `${who.email} 尚未開通，請聯絡管理員。`);
  ctx.data = ctx.data || {};
  ctx.data.user = user;

  const rawPath = new URL(request.url).pathname;
  const norm = normalizePath(rawPath);
  if (norm.status) return deny(request, norm.status, norm.status === 400 ? 'bad request' : 'not found');
  const path = norm.path;

  if (path.startsWith('/api/')) {
    // the API router splits the raw path itself: an encoded '/api' prefix would reach the asset server instead
    if (!rawPath.startsWith('/api/')) return deny(request, 404, 'not found');
    if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOriginJson(request)) {
      return deny(request, 403, 'cross-site or non-JSON request refused');
    }
    return next();
  }
  if (path === '/catalog.json') return json(catalogFor(user, await loadCatalog(env, request)));
  if (path === '/search-index.json') {
    const catalog = await loadCatalog(env, request);
    const rows = await assetJson(env, request, '/search-index.json');
    return json(searchIndexFor(user, catalog, rows));
  }
  if (path === '/docs' || path.startsWith('/docs/')) {
    const doc = docForUrl(await loadCatalog(env, request), path);
    const allowed = doc ? canSee(user, doc.project) : user.owner;
    if (!allowed) return deny(request, 403, '沒有權限檢視這份文件');
    // set here, not only in _headers: _headers rules match the raw path; private: access can be revoked
    return withHeaders(forward(ctx, path), {
      'content-security-policy': DOC_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-cache',
    });
  }
  if (isShellPath(path)) {
    const res = forward(ctx, path);
    return path === '/' || path === '/index.html' ? withHeaders(res, { 'content-security-policy': SHELL_CSP }) : res;
  }
  return deny(request, 404, 'not found'); // includes /vault.json: the server vault replaces it
}
