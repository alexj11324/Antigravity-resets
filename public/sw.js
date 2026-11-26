// Service worker: offline shell for static assets, plus push delivery.
//
// Deliberately never caches HTML or API responses. Pages are rendered per
// request and are locale-specific; a cached copy would show the wrong language
// and stale reset data.

const CACHE = "ag-resets-v1";
const PRECACHE = [
  "/styles.css",
  "/app.js",
  "/assets/i18n.js",
  "/assets/varun-avatar.webp",
  "/favicon.png",
];

const CACHEABLE = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?)$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Navigation and API traffic always hit the network.
  if (request.mode === "navigate") return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") return;
  if (!CACHEABLE.test(url.pathname)) return;

  // Network first so a deploy is picked up immediately; cache is the offline
  // fallback only.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || Response.error())),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Antigravity Resets" };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Antigravity reset", {
      body: payload.body || "An official Antigravity quota reset was announced.",
      icon: "/favicon.png",
      badge: "/favicon.png",
      tag: "antigravity-reset",
      renotify: true,
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
