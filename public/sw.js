// self.addEventListener('push', e => {
//   const data = e.data.json();
//   self.registration.showNotification('Reminder', {
//     body: data.message,
//     icon: '/icon.png'
//   });
// });

// self.addEventListener('notificationclick', e => {
//   e.notification.close();
//   e.waitUntil(
//     clients.openWindow('/?msg=' + encodeURIComponent(e.notification.body))
//   );
// });
self.addEventListener('push', e => {
  const data = e.data.json();
  self.registration.showNotification('Reminder', {
    body: data.message,
    icon: '/icon.png'
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow('/?msg=' + encodeURIComponent(e.notification.body))
  );
});
