self.addEventListener('fetch', (e) => {
  // ネットワーク優先（出席データは常に最新を使う）
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  let d = { title: '部活出席管理', body: '' };
  try { d = { ...d, ...e.data.json() }; } catch { if (e.data) d.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, icon: undefined }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((list) => {
    if (list.length) return list[0].focus();
    return clients.openWindow('/');
  }));
});
