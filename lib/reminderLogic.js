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

// Shared name-aware salutation for all 4 slots — falls back to a generic
// greeting when profiles.name hasn't been filled in (it's optional). `label`
// is the time-of-day word ("Pagi"/"Malam"/etc.) — kept separate from the
// slot-specific message that follows it in each build* function below.
export function greet(name, label) {
  return name ? `${label}, ${name}!` : `${label}!`;
}

// Builds the dinner-slot notification body (the meal/vitamin "missing"
// check). Callers should only call this when at least one of
// missingMeal/missingVitamin is true (the route skips sending entirely
// otherwise) — passed both false, it still returns a sane (if unused) string
// rather than throwing, so a caller mistake fails loud in a test instead of
// at 19:00 in production. `name` is optional (see greet() above).
export function buildReminderBody({ missingMeal, missingVitamin, nudge, name }) {
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
  const prefixed = name ? `Hai ${name}, ${lead.charAt(0).toLowerCase()}${lead.slice(1)}` : lead;
  return nudge ? `${prefixed} ${nudge}` : prefixed;
}

// Morning slot (07:00 WIB, unconditional): greeting + affirmation-or-fact
// (the `nudge` — see generateDailyNudge in lib/gemini.js, same function
// reused for morning/dinner/night).
export function buildMorningBody({ name, nudge }) {
  return `${greet(name, "Pagi")} ${nudge}`.trim();
}

// Lunch slot (12:00 WIB, unconditional — always sent regardless of whether a
// meal's already logged, per the answered question): nudge to log lunch +
// a nutrition-specific fact (`mealFact` — see generateMealFact, distinct
// from the general affirmation/fact nudge).
export function buildLunchBody({ name, mealFact }) {
  return `${greet(name, "Siang")} Waktunya makan siang — jangan lupa dicatat di Bloom ya. ${mealFact}`.trim();
}

// Night slot (21:30 WIB, unconditional): sleep reminder + affirmation
// (reuses the same `nudge` function as morning/dinner).
export function buildNightBody({ name, nudge }) {
  return `${greet(name, "Malam")} Waktunya istirahat, jangan begadang ya. ${nudge}`.trim();
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

// Same string-hash approach as pickFallbackNudge below, factored out so both
// pickers rotate through their own bank the same deterministic way.
function pickFromBank(bank, seed) {
  let hash = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return bank[Math.abs(hash) % bank.length];
}

// Deterministic pick from a string seed (e.g. `${userId}:${dateIso}`) — same
// seed always picks the same line, so a retried cron run or a user with two
// subscribed devices doesn't get two different-feeling messages for the same
// day. Rotates through the whole bank across seeds via a simple string hash;
// not cryptographic, just needs to spread reasonably evenly.
export function pickFallbackNudge(seed) {
  return pickFromBank(FALLBACK_NUDGES, seed);
}

// Lunch-specific fallback bank — used when generateMealFact (lib/gemini.js)
// is unavailable. Deliberately about nutrition needs during pregnancy
// specifically (not general pregnancy facts, that's FALLBACK_NUDGES's job),
// matching what the lunch slot is meant to nudge: eating well, not just
// eating.
export const MEAL_FACT_FALLBACKS = [
  "Kebutuhan protein ibu hamil naik jadi sekitar 71g/hari — telur, tahu, tempe, ikan semua hitung.",
  "Zat besi penting banget trimester ini — bayam, hati ayam, atau daging merah bisa bantu cukupi.",
  "Kalsium bukan cuma buat tulang bayi, tapi juga jaga tulang & gigi kamu tetap kuat.",
  "Folat/asam folat bantu perkembangan otak dan saraf bayi — sayuran hijau sumber yang bagus.",
  "Cairan yang cukup (minimal 8 gelas/hari) bantu cegah dehidrasi dan kram di kehamilan.",
  "Serat dari sayur, buah, dan biji-bijian bantu pencernaan tetap lancar selama hamil.",
  "DHA dari ikan berlemak seperti salmon bantu perkembangan otak bayi.",
  "Porsi kecil tapi sering bisa lebih nyaman di perut dibanding makan besar sekaligus.",
  "Vitamin D bantu penyerapan kalsium — sinar matahari pagi dan telur bisa bantu cukupi.",
  "Camilan sehat seperti kacang atau buah potong tetap dihitung sebagai asupan gizi harian, lho.",
];

export function pickMealFactFallback(seed) {
  return pickFromBank(MEAL_FACT_FALLBACKS, seed);
}

// Sums each user's { sent, pruned, skipped, emailed } result (one per
// settled task in app/api/cron/reminders/route.js's Promise.all over
// userIds) into the route's final response totals. Pulled out as its own
// pure function -- like everything else in this file -- so the one bit of
// the route's own logic that *can* be unit-tested without mocking
// Gemini/Supabase/web-push/Resend actually is, instead of only being
// exercised by production traffic. `emailed` counts the email fallback
// (lib/emailSender.js) sent when every one of a user's push subscriptions
// failed this run -- see the route's own comment for exactly when that fires.
export function sumReminderResults(results) {
  return (results || []).reduce(
    (totals, r) => ({
      sent: totals.sent + (r?.sent || 0),
      pruned: totals.pruned + (r?.pruned || 0),
      skipped: totals.skipped + (r?.skipped || 0),
      emailed: totals.emailed + (r?.emailed || 0),
    }),
    { sent: 0, pruned: 0, skipped: 0, emailed: 0 }
  );
}
