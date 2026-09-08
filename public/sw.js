// Bloom's service worker — exists only to receive Web Push events and react
// to a click on the resulting notification. No offline caching/asset
// strategy here (that's a separate concern from push, and out of scope for
// this feature) — this file is deliberately narrow.

// Payload shape sent by app/api/cron/reminders/route.js:
//   { title, body, url }
self.addEventListener("push", (event) => {
  let data = { title: "Bloom", body: "Ada pengingat baru buat kamu.", url: "/dashboard" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // Non-JSON payload (shouldn't happen from our own sender) — fall back to
    // the defaults above rather than throwing and dropping the notification.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/dashboard" },
    })
  );
});

// Clicking the notification focuses an already-open Bloom tab if one exists,
// otherwise opens a new one at the target URL — standard PWA notification-
// click pattern.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/dashboard";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if (client.url.includes(targetUrl) && "focus" in client) return client.focus();
      }
      if (allClients.length > 0 && "focus" in allClients[0]) {
        await allClients[0].focus();
        return allClients[0].navigate ? allClients[0].navigate(targetUrl) : undefined;
      }
      return self.clients.openWindow(targetUrl);
    })()
  );
});
