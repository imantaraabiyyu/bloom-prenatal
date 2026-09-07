// Gestational-age math from HPHT (Hari Pertama Haid Terakhir — first day of
// the last menstrual period), the one date Indonesian pregnancy tracking
// conventionally asks for. Everything else (usia kehamilan / gestational
// age, HPL / estimated due date, trimester, progress toward 40 weeks) is
// derived from it on the fly, same philosophy as the rest of lib/nutrition.js
// (percentages/status computed, not stored).

// Naegele's rule: HPL = HPHT + 280 hari (40 minggu).
export const HPL_OFFSET_DAYS = 280;
export const FULL_TERM_WEEKS = 40;

export function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function daysBetween(fromIso, toIso) {
  const a = new Date(fromIso + "T00:00:00");
  const b = new Date(toIso + "T00:00:00");
  return Math.round((b - a) / 86400000);
}

// HPL (Hari Perkiraan Lahir / estimated due date).
export function computeHPL(hpht) {
  return hpht ? addDays(hpht, HPL_OFFSET_DAYS) : null;
}

// Reverse of the above — for when a doctor gives the HPL directly (from USG)
// instead of the user knowing their HPHT. Same 280-day offset, other
// direction, so the app can still store just the one HPHT date either way.
export function computeHPHTFromHPL(hpl) {
  return hpl ? addDays(hpl, -HPL_OFFSET_DAYS) : null;
}

// Usia kehamilan (gestational age) as of `todayIso`. Returns null for a
// missing or future HPHT (nothing sensible to show yet).
export function computeGestationalAge(hpht, todayIso) {
  if (!hpht) return null;
  const totalDays = daysBetween(hpht, todayIso);
  if (totalDays < 0) return null;
  return { totalDays, weeks: Math.floor(totalDays / 7), days: totalDays % 7 };
}

export function formatGestationalAge(ga) {
  if (!ga) return "—";
  return `${ga.weeks} minggu ${ga.days} hari`;
}

export function trimesterForWeeks(weeks) {
  if (weeks < 14) return "t1";
  if (weeks < 28) return "t2";
  return "t3";
}

// Trimester is never manually chosen — the dashboard derives it fresh from
// HPHT + whichever date is being viewed (so browsing to a past day via the
// calendar shows the trimester — and nutrient targets — for *that* day, not
// always today). Falls back to Trimester 1 both when HPHT isn't set yet and
// for a `dateIso` before HPHT (nothing better to show either way).
export function trimesterForDate(hpht, dateIso) {
  const ga = computeGestationalAge(hpht, dateIso);
  return ga ? trimesterForWeeks(ga.weeks) : "t1";
}

export function gestationalProgressPct(ga) {
  if (!ga) return 0;
  return Math.min(100, (ga.totalDays / (FULL_TERM_WEEKS * 7)) * 100);
}

export function formatDateID(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}
