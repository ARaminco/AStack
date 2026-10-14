/* ============================================================================
   Aramin — service worker
   ----------------------------------------------------------------------------
   The server stamps the current build into BUILD, so every change to the
   shell is new bytes here: the worker reinstalls and drops the old cache.

   Strategies
     shell assets → cache-first from this build's cache (they are versioned).
     navigations  → network first, falling back to the cached shell offline.
     /api/*       → never cached, never intercepted: data stays on the server.
   ========================================================================== */

const BUILD = "__BUILD__";
const CACHE = "aramin-shell-" + BUILD;
const SHELL = [
  "/",
  "/app.css?v=" + BUILD,
  "/app.js?v=" + BUILD,
  "/boot.js?v=" + BUILD,
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/fonts/vazirmatn-variable.woff2"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("aramin-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/sw.js") {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/", { cacheName: CACHE })));
    return;
  }
  event.respondWith(caches.match(request, { cacheName: CACHE }).then((hit) => hit || fetch(request)));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "#/home";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ link });
          return client.focus();
        }
      }
      return self.clients.openWindow("/" + link);
    })
  );
});
