"use client";
// Client-side Web Push helpers — used only by the "Notifikasi" panel in
// app/dashboard/profile/page.js. Talks to app/api/push/subscribe/route.js to
// persist/remove the subscription server-side; the actual
// permission-request + PushManager calls happen here since only the browser
// can do those.

export function isPushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
}

// Web Push wants the VAPID public key as a Uint8Array, but browsers hand out
// (and env vars store) the base64url string form — this is the standard
// conversion between the two.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Current state for the panel to render: whether the browser supports push
// at all, the Notification permission ("default"/"granted"/"denied"), and
// whether an active PushManager subscription already exists on this device.
export async function getPushState() {
  if (!isPushSupported()) return { supported: false, permission: "default", subscribed: false };
  const permission = Notification.permission;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  return { supported: true, permission, subscribed: !!subscription };
}

// Asks for permission (if not already granted/denied), subscribes via
// PushManager, and POSTs the subscription to our API so the cron route can
// find it later. Throws with a message the panel shows directly on any
// failure (permission denied, missing VAPID key, network error, ...).
export async function subscribeToPush() {
  if (!isPushSupported()) throw new Error("Push notification tidak didukung di browser ini.");
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY belum diisi (lihat README).");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Izin notifikasi ditolak. Aktifkan lagi lewat pengaturan situs di browser kamu."
        : "Izin notifikasi belum diberikan."
    );
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || "Gagal menyimpan langganan notifikasi.");
  }
  return subscription;
}

// Unsubscribes the browser's PushManager subscription (if any) and tells the
// API to delete the matching server-side row.
export async function unsubscribeFromPush() {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready.catch(() => null);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}
