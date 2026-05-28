self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    data = {
      title: '🚴 Radgruppe Warnung',
      body: event.data ? event.data.text() : 'Ein Fahrer ist zu weit weg oder nicht live.'
    };
  }

  const title = data.title || '🚴 Radgruppe Warnung';

  const options = {
    body: data.body || 'Ein Fahrer ist zu weit weg oder nicht live.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'radgruppe-alert',
    renotify: true,
    requireInteraction: false,
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : '/';

  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
