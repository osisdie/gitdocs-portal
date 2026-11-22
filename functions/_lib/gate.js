// Middleware logic: authenticate every request, then apply the static-file rules
// (DESIGN.md → Access control on static files). Kept out of _middleware.js so tests can inject fetch / clock.
import { callerEmail, loadUser } from './auth.js';
import { canSee } from './roles.js';
import { deny, json, sameOriginJson } from './http.js';
import { assetJson, loadCatalog, catalogFor, searchIndexFor, docByPath, publicOf, isRestricted } from './assets.js';
import { visiblePeople } from './people.js';

const NOT_ENABLED = '尚未開通，請聯絡管理員';

// App-shell files any known user may load. Default-deny: a file the build adds to site/ later stays 404 in server
// mode until it is listed here (test/server.test.mjs fails when this list and site/ drift apart).
export const SHELL_FILES = new Set([
  '/', '/index.html', '/app.js', '/app.css', '/query.js', '/model.js', '/api.js', '/admin.js', '/graph.js',
  '/graph.css', '/vault.js', '/vault-core.js', '/vault-frame.js', '/sw.js', '/manifest.webmanifest', '/robots.txt',
  '/i18n.js', '/filters.js', '/liststate.js',
]);
// one level of plain file names in the shell's asset folders (icons, UI translations)
const SHELL_DIR_RE = /^\/(icons|i18n)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
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

/**
 * Every file the Pages asset server may answer `path` with a body, in its lookup order: '/x/' → x/index.html;
 * '/x/index' → itself; otherwise x, then x.html. Forms that only redirect are left out: the redirect target comes back
 * through the gate. This models Cloudflare Pages' asset server (wrangler pages generateHandler, the auto-trailing-slash
 * behaviour); Workers static assets with another html_handling mode resolve differently and are not supported.
 */
export function servedCandidates(path) {
  const p = path.replace(/^\/+/, '');
  if (p.endsWith('/')) return [`${p}index.html`];
  if (p.endsWith('/index')) return [p];
  return [p, `${p}.html`];
}

/**
 * Whether a file `p` sits next to `p.html`. Pages serves '/p.html' only when an extensionless `p` also exists and
 * otherwise redirects to '/p'; anything but that redirect counts as "exists" (fail closed).
 */
async function siblingExists(env, request, p) {
  const probe = new Request(new URL(encodePath(`/${p}.html`), request.url), { method: 'HEAD', redirect: 'manual' });
  const res = await env.ASSETS.fetch(probe);
  return !(res.status >= 300 && res.status < 400);
}

/**
 * null when `user` may read whatever the asset server serves for `path`, else { status, msg }. Every deployed catalog
 * doc among the candidates must be readable (not just the first one), and a file the catalog does not know is
 * owner-only wherever it could be served: with no deployed doc among the candidates, or ahead of the first one (an
 * extensionless `x` beside doc `x.html`). After a deployed doc nothing can be served: Pages stops at it.
 * An `offline` doc (極機密, not deployed) is no doc here: its path can only be some other, unknown file.
 */
export async function docRefusal(env, request, user, catalog, path) {
  const cands = servedCandidates(path).map((c) => {
    const doc = docByPath(catalog, c);
    return { path: c, doc: doc && !doc.offline ? doc : null };
  });
  const first = cands.findIndex((c) => c.doc);
  if (user.owner) return null;
  if (first < 0) return { status: 403, msg: '沒有權限檢視這份文件' };
  const pub = publicOf(catalog);
  for (const { doc } of cands) {
    if (!doc) continue;
    if (!canSee(user, doc.project, pub)) return { status: 403, msg: '沒有權限檢視這份文件' };
    if (isRestricted(user, doc)) return { status: 403, msg: '機密文件需要 editor 權限' };
  }
  for (const c of cands.slice(0, first)) {
    if (await siblingExists(env, request, c.path)) return { status: 403, msg: '沒有權限檢視這份文件' };
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
  if (!user) {
    return deny(request, 403, NOT_ENABLED, {
      en: `${who.email} is not enabled yet. Please contact the administrator.`, zh: `${who.email} 尚未開通，請聯絡管理員。`,
    });
  }
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
  if (path === '/catalog.json') {
    const catalog = await loadCatalog(env, request);
    const people = catalog.site?.people ? await visiblePeople(env.DB, env, user, catalog) : null;
    return json(catalogFor(user, catalog, people));
  }
  if (path === '/search-index.json') {
    const catalog = await loadCatalog(env, request);
    const rows = await assetJson(env, request, '/search-index.json');
    return json(searchIndexFor(user, catalog, rows));
  }
  if (path === '/docs' || path.startsWith('/docs/')) {
    const catalog = await loadCatalog(env, request);
    const refused = await docRefusal(env, request, user, catalog, path);
    if (refused) return deny(request, refused.status, refused.msg);
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
