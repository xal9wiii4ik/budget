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
/* global self, caches, fetch, Response, URL -- the ServiceWorkerGlobalScope */
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

// --- Web push (web-push W1) ------------------------------------------------
// The server sends `{title, body, url, tag}` — names only, never amounts. Every
// field is checked here because a push is input from outside the page.
const FALLBACK_TITLE = 'Budget';
const NOTIFICATION_ICON = '/icons/icon-192.png';

// A path on THIS origin, or '/'. The payload's url is origin-relative by
// contract; anything that resolves elsewhere is not followed.
function safePath(url) {
  if (typeof url !== 'string' || url === '') return '/';
  try {
    const resolved = new URL(url, self.location.origin);
    if (resolved.origin !== self.location.origin) return '/';
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  // The handler ALWAYS shows a notification (`userVisibleOnly`): Safari revokes
  // a subscription whose pushes show nothing, so an empty or non-JSON payload
  // still gets the generic one rather than a throw.
  let title = FALLBACK_TITLE;
  let body = '';
  let tag;
  let url = '/';
  try {
    const payload = event.data ? event.data.json() : null;
    if (payload !== null && typeof payload === 'object') {
      if (typeof payload.title === 'string' && payload.title !== '') title = payload.title;
      if (typeof payload.body === 'string') body = payload.body;
      if (typeof payload.tag === 'string' && payload.tag !== '') tag = payload.tag;
      url = safePath(payload.url);
    }
  } catch {
    // Not JSON: the generic notification below.
  }
  const options = { body, data: { url }, icon: NOTIFICATION_ICON };
  if (tag !== undefined) options.tag = tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an open window of the app (one already at the target if there is one)
// and send it to the target; with no window, open one. A full navigation — the
// SPA boots at the deep link — rather than postMessage routing, which would need
// a listener inside the app.
async function openTarget(target) {
  const origin = self.location.origin;
  const href = new URL(target, origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const ours = windows.filter((client) => new URL(client.url).origin === origin);
  if (ours.length === 0) return self.clients.openWindow(target);
  const client = ours.find((candidate) => candidate.url === href) ?? ours[0];
  // Focus FIRST, while the click's activation is still live.
  const focused = await client.focus().catch(() => client);
  if (focused.url === href) return focused;
  // `navigate` rejects for a window this worker does not control (a page loaded
  // before the first registration) — open the target instead.
  return focused.navigate(href).catch(() => self.clients.openWindow(target));
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = safePath(data !== null && typeof data === 'object' ? data.url : undefined);
  event.waitUntil(openTarget(target));
});
