// gitdocs service worker: caches the app shell only.
// Everything else — catalog.json, search-index.json, /api/*, /docs/*, vault.json, /cdn-cgi/* (Access login/logout)
// and every cross-origin request (CDN libraries) — is not intercepted, so it always goes to the network: access can
// be revoked at any time and no document, catalog or secret may outlive it in a cache.
//
// Redirects: Pages answers /index.html with a 308 to '/'. A Response that came through a redirect carries
// `redirected: true`, and answering a navigation with one fails (net::ERR_FAILED): the portal could no longer be
// reloaded. So the shell is cached under './' only (not 'index.html'), redirected responses are never cached or served
// from the cache, and a redirected network response is rebuilt into a plain one before it is returned.
const CACHE = 'gitdocs-shell-__BUILD__'; // the build may stamp __BUILD__; while unstamped the shell is network-first
const STAMPED = !CACHE.includes('__BUILD' + '__');
const SHELL = [
  './', 'app.css', 'app.js', 'model.js', 'api.js', 'query.js', 'vault.js', 'vault-core.js',
  'admin.js', 'graph.js', 'graph.css', 'i18n.js', 'i18n/en.js', 'i18n/zh-TW.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/maskable.svg',
];
const scope = new URL(self.registration.scope);
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, scope).pathname));
const NAV_KEY = new URL('./', scope).href;

/** A copy without the `redirected` flag (same body, status and headers). */
const clean = (res) => (res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res);
const cacheable = (res) => res.ok && res.type === 'basic' && !res.redirected;

self.addEventListener('install', (e) => {
  // Individual fetches: a missing optional file (e.g. graph.js on an older build) must not fail the install.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map(async (p) => {
    try {
      const res = await fetch(new Request(p, { cache: 'reload' }));
      if (cacheable(res)) await c.put(new URL(p, scope).href, res);
    } catch { /* offline or missing: fetched on demand later */ }
  }))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('gitdocs-') && k !== CACHE).map((k) => caches.delete(k)));
    // purge what an older worker may have stored from a redirect (e.g. its 'index.html' navigation entry)
    const c = await caches.open(CACHE);
    for (const req of await c.keys()) {
      const res = await c.match(req);
      if (!res || res.redirected || new URL(req.url).pathname.endsWith('/index.html')) await c.delete(req);
    }
    await self.clients.claim();
  })());
});

async function fromNetwork(req, key) {
  const res = await fetch(req);
  if (cacheable(res)) (await caches.open(CACHE)).put(key, res.clone());
  return clean(res);
}

async function fromCache(key) {
  const hit = await caches.match(key);
  if (hit?.redirected) { await (await caches.open(CACHE)).delete(key); return null; } // never serve a redirected entry
  return hit || null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin || !SHELL_PATHS.has(url.pathname)) return; // network only
  // Navigations to the shell share one cache entry (the hash route never reaches the server).
  const key = req.mode === 'navigate' ? NAV_KEY : url.origin + url.pathname;
  e.respondWith((async () => {
    if (!STAMPED) {
      try { return await fromNetwork(req, key); } catch { return (await fromCache(key)) || Response.error(); }
    }
    return (await fromCache(key)) || fromNetwork(req, key);
  })());
});
