// gitdocs service worker: caches the app shell only.
// Everything else — catalog.json, search-index.json, /api/*, /docs/*, vault.json, /cdn-cgi/* (Access login/logout)
// and every cross-origin request (CDN libraries) — is not intercepted, so it always goes to the network: access can
// be revoked at any time and no document, catalog or secret may outlive it in a cache.
const CACHE = 'gitdocs-shell-__BUILD__'; // the build may stamp __BUILD__; while unstamped the shell is network-first
const STAMPED = !CACHE.includes('__BUILD' + '__');
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'model.js', 'api.js', 'query.js', 'vault.js', 'vault-core.js',
  'admin.js', 'graph.js', 'graph.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/maskable.svg',
];
const scope = new URL(self.registration.scope);
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, scope).pathname));

self.addEventListener('install', (e) => {
  // Individual adds: a missing optional file (e.g. graph.js on an older build) must not fail the install.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((p) => c.add(new Request(p, { cache: 'reload' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('gitdocs-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function fromNetwork(req, key) {
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(key, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin || !SHELL_PATHS.has(url.pathname)) return; // network only
  // Navigations to the shell share one cache entry (the hash route never reaches the server).
  const key = req.mode === 'navigate' ? new URL('index.html', scope).href : url.origin + url.pathname;
  e.respondWith((async () => {
    if (!STAMPED) {
      try { return await fromNetwork(req, key); } catch { return (await caches.match(key)) || Response.error(); }
    }
    return (await caches.match(key)) || fromNetwork(req, key);
  })());
});
