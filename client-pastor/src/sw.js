import { precacheAndRoute } from 'workbox-precaching';

// Injected at build time by vite-plugin-pwa (injectManifest strategy).
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Displays a system notification when the server sends a Web Push message
// (attendance/offering digest, direct message, emergency alert).
//
// Every notification is branded: the title is the church's name, the icon is the
// VRT logo and the badge is the roundel, so a lock-screen or notification-tray
// entry is recognizable at a glance instead of reading as a generic system
// alert. The subject line the server sent (`title`) becomes the first line of the
// body: a notification whose title is always the brand must not lose the fact
// that says what happened.
const BRAND = 'Victory Revival Temple';
self.addEventListener('push', (event) => {
  let payload = { title: null, body: 'You have a new update.', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // A payload that is not JSON (or an older sender) is still shown verbatim.
    payload.body = event.data ? event.data.text() : payload.body;
  }

  const brand = payload.brand || BRAND;
  const body = [payload.title, payload.body].filter(Boolean).join('\n');
  const options = {
    body,
    icon: payload.icon || '/vrt-logo.png',
    badge: payload.badge || '/vrt-roundel.png',
    data: { url: payload.url || '/' },
    // requireInteraction keeps an alert on screen until it is dismissed: used for
    // emergencies. Sound/vibration is the platform's own notification behaviour;
    // nothing custom is played here.
    requireInteraction: !!payload.requireInteraction,
    timestamp: Date.now(),
  };
  // `renotify` (re-alert instead of silently replacing a collapsed notification)
  // is only legal together with a tag, so both are set as a pair.
  if (payload.tag) {
    options.tag = payload.tag;
    options.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(brand, options));
});

// Offline navigation fallback: full-page (navigation) requests fall back to
// the precached app shell if the network fails, so the PWA still opens offline.
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        const shell = await caches.match('/index.html');
        return shell || Response.error();
      }
    })()
  );
});

// Focuses an already-open tab if there is one, otherwise opens a new one at
// the URL relevant to the notification (e.g. /emergencies for an alert).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
