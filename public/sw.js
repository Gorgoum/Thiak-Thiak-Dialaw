// Service worker : reçoit les notifications push même quand l'application est fermée.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // nécessaire pour que l'appli soit installable

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { corps: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(d.titre || 'Thiak Thiak Dialaw', {
      body: d.corps || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: d.tag,
      renotify: !!d.tag,
      requireInteraction: !!d.urgent,
      vibrate: [400, 150, 400, 150, 400],
      data: { url: d.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((fenetres) => {
      for (const f of fenetres) {
        if (new URL(f.url).pathname === url && 'focus' in f) return f.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
