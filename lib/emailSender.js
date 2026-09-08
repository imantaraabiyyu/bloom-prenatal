import "server-only";
import { Resend } from "resend";

// Thin wrapper around Resend — used only by app/api/cron/reminders/route.js
// as a last-resort fallback when a user's push notification couldn't be
// delivered to ANY of their devices this run (see that route's own comment
// for exactly when this fires). Mirrors lib/pushSender.js's shape: optional
// (no-ops without an API key, same "absent = feature gracefully skipped"
// philosophy as GEMINI_API_KEY elsewhere in this app), never throws (this
// is already the last-resort fallback — nothing left to fall back to
// further if it also fails).

let resendClient = null;
function getResendClient() {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  resendClient = new Resend(apiKey);
  return resendClient;
}

// Returns true on success, false on failure (logged via console.error, same
// as pushSender.js does for a failed push) or when the feature isn't
// configured at all.
export async function sendReminderEmail(to, subject, text) {
  const client = getResendClient();
  if (!client) return false;
  // Resend's own sandbox sender -- works without verifying a custom domain
  // first; swap in a verified domain via EMAIL_FROM once you have one (see
  // README).
  const from = process.env.EMAIL_FROM || "Bloom <onboarding@resend.dev>";
  try {
    const { error } = await client.emails.send({ from, to, subject, text });
    if (error) {
      console.error(`email fallback failed (to ...${to.slice(-12)}):`, error);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`email fallback failed (to ...${to.slice(-12)}):`, e?.message || e);
    return false;
  }
}
