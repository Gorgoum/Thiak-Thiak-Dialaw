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
      // Un onglet Thiak Thiak est déjà ouvert (ex. l'écran de paiement resté derrière Wave) :
      // on le ramène au premier plan et on l'amène sur l'adresse de l'alerte (ex. le retour de paiement).
      const cible = new URL(url, self.location.origin);
      const onglet = fenetres.find((f) => new URL(f.url).origin === cible.origin && new URL(f.url).pathname === '/' && 'focus' in f)
        || fenetres.find((f) => new URL(f.url).pathname === cible.pathname && 'focus' in f);
      if (!onglet) return self.clients.openWindow(cible.href);
      return onglet.focus().then((o) => (o && 'navigate' in o ? o.navigate(cible.href).catch(() => o) : o))
        .catch(() => self.clients.openWindow(cible.href));
    })
  );
});
