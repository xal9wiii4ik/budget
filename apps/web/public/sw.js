// The whole service worker. It does ONE thing: when a page navigation fails
// because the network is gone, it answers with /offline.html instead of the
// browser's own error page — which, inside an installed app, is a dead end with
// no address bar.
//
// What it deliberately does NOT do: cache the bundle, the API, fonts or anything
// else. Budget is live data from the server; a cached bundle that outlives a
// deploy would be the worse failure by far, and a worker that never stores the
// app can never serve a stale one. Network first, always — the cache holds
// exactly one file.
/* global self, caches, fetch, Response -- the ServiceWorkerGlobalScope */
const CACHE = 'budget-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Navigations only. Everything else — scripts, styles, the API on its own
  // origin — is left to the browser untouched.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(OFFLINE_URL).then((cached) => cached ?? Response.error()),
    ),
  );
});
