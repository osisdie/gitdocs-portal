// gitdocs service worker — kill switch.
// The offline app shell is disabled for now: an earlier worker cached a redirected /index.html (Pages answers it with a
// 308 to '/') and answered navigations with it, which browsers reject (net::ERR_FAILED), so the portal could not be
// reloaded. This worker replaces any installed one, deletes every cache it owns and unregisters itself. It has no
// fetch handler, so it never intercepts a request. It does not reload pages (the page may register it again; that is
// harmless). The shell cache comes back once it is tested behind the auth proxy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('gitdocs-')) await caches.delete(k);
    await self.clients.claim();
    await self.registration.unregister();
  })());
});
