/* Vertex Hub service worker — Web Push for the installed PWA (iOS Home Screen
 * + Android/Chrome). Renders Vertex-branded notifications and focuses/opens the
 * app on tap. Kept dependency-free and tiny. It keeps no Cache Storage (no
 * offline cache), so there is no cache name to version — nothing from the
 * Cube install can be reused. */
const APP_NAME = 'Vertex Hub';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: APP_NAME, body: event.data ? event.data.text() : '' };
  }

  // The number on the app's icon, like any inbox: the server sends the
  // person's unread count with every push.
  let badge = Promise.resolve();
  try {
    if (typeof payload.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
      badge = payload.badge > 0 ? self.navigator.setAppBadge(payload.badge) : self.navigator.clearAppBadge();
    }
  } catch (e) { /* not supported on this device */ }

  const title = payload.title || APP_NAME;
  const options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',      // Vertex app icon
    badge: '/icons/badge-96.png',     // monochrome X for the Android status bar
    tag: (payload.data && payload.data.tag) || undefined, // collapse duplicates when set
    renotify: !!(payload.data && payload.data.tag),
    data: { url: payload.url || '/', ...(payload.data || {}) },
    vibrate: [80, 40, 80],
  };

  event.waitUntil(Promise.all([self.registration.showNotification(title, options), Promise.resolve(badge).catch(() => {})]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  // A target on another origin (an external link) can't be reached by
  // navigating an existing app window — client.navigate() rejects cross-origin
  // and we'd silently strand the user in the app. Always open those in a new tab.
  const isExternal = /^https?:\/\//i.test(target) && target.indexOf(self.location.origin) !== 0;

  event.waitUntil(
    (isExternal
      ? Promise.resolve(null)
      : self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    ).then((clients) => {
      // Focus an existing app window if one is open; navigate it to the target.
      for (const client of clients || []) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && target && target !== '/') {
            try { client.navigate(target); } catch (e) { /* cross-origin guard */ }
          }
          return;
        }
      }
      // Otherwise open a new window.
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
