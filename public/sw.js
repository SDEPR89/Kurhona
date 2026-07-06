// Kurhona service worker — receives Web Push messages and shows
// system notifications. No fetch handler: we don't cache the app
// shell or assets, so the SW's only job is handling the two events
// the push protocol requires (`push` and `notificationclick`).
//
// skipWaiting + clients.claim make the first install pick up
// immediately, so the user doesn't have to refresh twice after
// subscribing. The scope is `/` (set by register('/sw.js')) —
// this means the SW intercepts *every* fetch, but since we
// don't install a fetch handler the browser falls through to
// the network as normal.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // The send-push Edge Function serializes a JSON body with
  // { title, body, tag, data }. data is the only field we use
  // here for click-through; the rest is rendered verbatim.
  let payload = { title: "Kurhona", body: "", tag: "kurhona", data: {} };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      // If the body isn't JSON, fall back to the raw text as the
      // body so the user still sees something.
      payload.body = event.data.text();
    }
  }
  const options = {
    body: payload.body,
    tag: payload.tag,
    icon: "/logo.png",
    badge: "/favicon.png",
    data: payload.data,
    // Vibrate on Android, ignored elsewhere. Pattern: short-pause-
    // short. Doesn't repeat.
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Focus an existing tab if one is open; otherwise open a new
  // tab at the URL the payload specified (defaults to "/").
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        // Same-origin match — focus the tab rather than open a new one.
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
