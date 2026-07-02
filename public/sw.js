// Kurhona Service Worker
// Handles real Web Push events (fired by the push server / Edge Function)
// AND falls back to client-side setTimeout scheduling when the app is open.

// ---------------------------------------------------------------------------
// Real push events — fired by the server even when the app is closed
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: '⏰ Kurhona Reminder', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(data.title ?? '⏰ Kurhona Reminder', {
      body:   data.body  ?? 'You have an upcoming deadline.',
      icon:   data.icon  ?? '/favicon.png',
      badge:  '/favicon.png',
      tag:    data.tag   ?? 'kurhona-deadline',
      requireInteraction: false,
      data: { url: self.location.origin },
    })
  );
});

// ---------------------------------------------------------------------------
// Client-side fallback scheduling (setTimeout) — works while app is open
// Used as a backup for tasks added after the last cron run.
// ---------------------------------------------------------------------------
const scheduledTimers = new Map();

self.addEventListener('message', (event) => {
  const { type, notifications } = event.data ?? {};

  if (type === 'SCHEDULE_NOTIFICATIONS') {
    for (const timerId of scheduledTimers.values()) clearTimeout(timerId);
    scheduledTimers.clear();

    const now = Date.now();
    for (const notif of notifications ?? []) {
      const delay = notif.fireAt - now;
      if (delay < 0) continue;

      const timerId = setTimeout(() => {
        self.registration.showNotification(notif.title, {
          body:  notif.body,
          icon:  '/favicon.png',
          badge: '/favicon.png',
          tag:   notif.id,
          requireInteraction: false,
          data: { url: self.location.origin },
        });
        scheduledTimers.delete(notif.id);
      }, delay);

      scheduledTimers.set(notif.id, timerId);
    }
  }

  if (type === 'CANCEL_ALL') {
    for (const timerId of scheduledTimers.values()) clearTimeout(timerId);
    scheduledTimers.clear();
  }
});

// ---------------------------------------------------------------------------
// Notification click — focus or open the app
// ---------------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url ?? self.location.origin;

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(targetUrl) && 'focus' in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
