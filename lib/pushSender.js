import "server-only";
import webpush from "web-push";

// Thin wrapper around the `web-push` package — used only by
// app/api/cron/reminders/route.js. Keeps VAPID setup + the "is this
// subscription dead" decision in one place instead of scattered through the
// route.

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) {
    throw new Error(
      "VAPID_SUBJECT / NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum lengkap di " +
      ".env.local / Vercel (lihat README)."
    );
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
}

// `subscriptionRow`: a row from public.push_subscriptions (endpoint, p256dh,
// auth_key). `payload`: plain object (JSON.stringify'd here), matching what
// public/sw.js expects: { title, body, url }.
//
// Returns { ok: true } on success, or { ok: false, isDead } — `isDead` is
// true for a 404/410 response (the push service says this endpoint no
// longer exists), which the caller uses to prune the subscription row;
// false for anything else (transient failure — logged, not pruned).
export async function sendPush(subscriptionRow, payload) {
  ensureVapid();
  const subscription = {
    endpoint: subscriptionRow.endpoint,
    keys: { p256dh: subscriptionRow.p256dh, auth: subscriptionRow.auth_key },
  };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 60 * 60 * 12, // 12h -- no point redelivering a stale daily reminder much later than that
      timeout: 8000, // web-push's own socket timeout -- one slow/hanging push
                     // service response can't stall the cron route's budget
    });
    return { ok: true };
  } catch (e) {
    const statusCode = e?.statusCode;
    const isDead = statusCode === 404 || statusCode === 410;
    console.error(
      `push send failed (endpoint ...${subscriptionRow.endpoint.slice(-12)}, status ${statusCode ?? "?"}):`,
      e?.body || e?.message || e
    );
    return { ok: false, isDead };
  }
}
