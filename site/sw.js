// AverChat service worker: lets the browser show notifications and install the app. No offline caching of data.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('notificationclick', (e) => {
  e.notification.close(); const chat = e.notification.data && e.notification.data.chat;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) { c.focus(); if (chat) c.postMessage({ chat }); return; } }
    return self.clients.openWindow(chat ? '/#chat=' + chat : '/');
  }));
});
