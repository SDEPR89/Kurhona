// Kurhona Service Worker — handles Web Push notifications and PWA offline caching.

const CACHE_NAME = "kurhona-shell-v2";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/favicon.png",
  "/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch handler: Network-first for dynamic & API calls, fallback to cache for app shell when offline
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and Supabase / external API calls
  if (
    event.request.method !== "GET" ||
    url.pathname.startsWith("/rest/v1") ||
    url.pathname.startsWith("/auth/v1") ||
    url.hostname.includes("supabase.co")
  ) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful responses for same-origin static assets
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // If navigating to a page offline, return cached index.html
        if (event.request.mode === "navigate") {
          return caches.match("/");
        }
        return Promise.reject("offline");
      })
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "Kurhona", body: "", tag: "kurhona", data: {} };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }
  const options = {
    body: payload.body,
    tag: payload.tag,
    icon: "/logo.png",
    badge: "/favicon.png",
    data: payload.data,
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});

