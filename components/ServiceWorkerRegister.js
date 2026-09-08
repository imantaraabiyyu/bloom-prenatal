"use client";
import { useEffect } from "react";

// Registers public/sw.js once per app load — mounted from app/layout.js so
// it runs on every page, not just Profile (where the notification opt-in
// lives). A subscription can't be created without a registered service
// worker, but registering it doesn't itself ask for notification permission
// or create a subscription (see lib/push.js for that, which is opt-in).
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.error("Gagal mendaftarkan service worker:", e);
    });
  }, []);
  return null;
}
