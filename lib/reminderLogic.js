// Pure decision logic for the daily meal/vitamin reminder — no I/O here on
// purpose (same "computed, not stored" philosophy as lib/nutrition.js /
// lib/pregnancy.js), so app/api/cron/reminders/route.js can stay a thin
// orchestrator and this logic can be unit-tested without a database, a
// service worker, or a Gemini call in the loop.

// `mealUserIds`/`vitaminUserIds` are Sets of user_id strings who already have
// today's entry (see the route for exactly how "today" and "checked=true
// only" are queried) — pickMissing just answers the two yes/no questions for
// one user against those sets.
export function pickMissing(mealUserIds, vitaminUserIds, userId) {
  return {
    missingMeal: !mealUserIds.has(userId),
    missingVitamin: !vitaminUserIds.has(userId),
  };
}

// Builds the notification body. Callers should only call this when at least
// one of missingMeal/missingVitamin is true (the route skips sending
// entirely otherwise) — passed both false, it still returns a sane (if
// unused) string rather than throwing, so a caller mistake fails loud in a
// test instead of at 19:00 in production.
export function buildReminderBody({ missingMeal, missingVitamin, nudge }) {
  let lead;
  if (missingMeal && missingVitamin) {
    lead = "Belum catat menu & minum vitamin hari ini.";
  } else if (missingMeal) {
    lead = "Belum catat menu hari ini.";
  } else if (missingVitamin) {
    lead = "Belum minum vitamin hari ini.";
  } else {
    lead = "Semua sudah tercatat hari ini!";
  }
  return nudge ? `${lead} ${nudge}` : lead;
}

// Static fallback bank — used when Gemini is unavailable (missing key,
// rate-limited, network error) so the daily reminder still says *something*
// warm instead of just the bare "belum catat..." line every single day.
// Deliberately generic (not trimester/week-specific) since the fallback path
// often runs precisely when we can't afford a slow/failing external call —
// trimester-specific facts are Gemini's job (lib/gemini.js:generateDailyNudge),
// this is just the safety net under it.
export const FALLBACK_NUDGES = [
  "Kamu sedang melakukan hal luar biasa untuk si kecil 🌸",
  "Satu langkah kecil hari ini, tumbuh kembang yang besar untuknya.",
  "Jangan lupa istirahat cukup — tubuhmu sedang bekerja keras.",
  "Air putih yang cukup bikin kamu dan si kecil sama-sama nyaman.",
  "Kamu boleh capek, dan itu wajar. Pelan-pelan saja.",
  "Setiap ibu hamil punya ritmenya sendiri — kamu tidak perlu terburu-buru.",
  "Gerakan kecil si kecil hari ini juga bagian dari ceritamu.",
  "Minta bantuan itu bukan tanda lemah, itu tanda sayang ke diri sendiri.",
  "Tubuh ibu hamil memompa hampir 50% lebih banyak darah dari biasanya.",
  "Indra penciuman bayi mulai berkembang sejak trimester kedua.",
  "Detak jantung bayi bisa mulai terdengar lewat USG sekitar minggu ke-6.",
  "Kulit bayi dilapisi vernix caseosa, lapisan lilin alami pelindung di dalam rahim.",
  "Kamu tidak harus sempurna hari ini — cukup hadir untuk dirimu dan si kecil.",
  "Momen tenang sejenak juga bentuk perawatan diri yang penting.",
  "Setiap centang kecil di checklist Bloom adalah bentuk sayang untuk si kecil.",
  "Perutmu yang membesar adalah bukti nyata kehidupan baru sedang tumbuh.",
];

// Deterministic pick from a string seed (e.g. `${userId}:${dateIso}`) — same
// seed always picks the same line, so a retried cron run or a user with two
// subscribed devices doesn't get two different-feeling messages for the same
// day. Rotates through the whole bank across seeds via a simple string hash;
// not cryptographic, just needs to spread reasonably evenly.
export function pickFallbackNudge(seed) {
  let hash = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % FALLBACK_NUDGES.length;
  return FALLBACK_NUDGES[idx];
}
