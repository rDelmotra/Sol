// SPIKE — not production. Service worker for the pack page: caches only the page shell (html, app.js, worker script) so the
// page itself opens with no network. The pack data is NOT cached here; it lives in the Origin Private File System.
const SHELL = ['./', 'index.html', 'app.js', 'pack.worker.js'];
const NAME = 'pack-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/pack/')) return; // pack files: straight to the network
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
