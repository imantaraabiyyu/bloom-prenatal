// BMI + IOM (2009) pregnancy weight-gain guidance — same "computed, not
// stored" philosophy as lib/pregnancy.js: nothing here is persisted, it's
// all derived on the fly from profiles.pre_pregnancy_weight_kg/height_cm
// (see supabase/schema.sql) + a weight_logs row + the current gestational
// week (lib/pregnancy.js's computeGestationalAge). No component/network code
// here — fully unit-testable, used by app/dashboard/page.js and
// app/dashboard/profile/page.js.
//
// Singleton-pregnancy guidance only — twins/multiples have a different IOM
// table, and this app has no "multiples" flag anywhere to key off of. Same
// "general guidance, not personal medical advice" caveat as this app's other
// nutrient targets/limits.

export function computeBMI(weightKg, heightCm) {
  const w = Number(weightKg);
  const h = Number(heightCm);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const heightM = h / 100;
  return w / (heightM * heightM);
}

// WHO/IOM adult BMI categories — same boundary convention as
// lib/nutrition.js's STATUS_TIERS (a boundary value belongs to the *higher*
// category): 18.5 itself is "normal" (not "underweight"), 25 is "overweight"
// (not "normal"), 30 is "obese".
export function bmiCategory(bmi) {
  if (bmi == null || !Number.isFinite(bmi)) return null;
  if (bmi < 18.5) return "underweight";
  if (bmi < 25) return "normal";
  if (bmi < 30) return "overweight";
  return "obese";
}

export const BMI_CATEGORY_META = {
  underweight: { label: "Kurus", color: "#7FA9C7" },
  normal: { label: "Normal", color: "#8FAE8B" },
  overweight: { label: "Gemuk", color: "#E3B65E" },
  obese: { label: "Obesitas", color: "#C77B7B" },
};

// IOM (Institute of Medicine, 2009) total recommended weight gain over a
// SINGLETON pregnancy, in kg, by pre-pregnancy BMI category.
export const TOTAL_GAIN_RANGE_KG = {
  underweight: [12.5, 18],
  normal: [11.5, 16],
  overweight: [7, 11.5],
  obese: [5, 9],
};

// IOM per-week gain rate for the 2nd+3rd trimester (week 14 onward), kg/week.
export const WEEKLY_GAIN_RATE_KG_T2T3 = {
  underweight: [0.44, 0.58],
  normal: [0.35, 0.5],
  overweight: [0.23, 0.33],
  obese: [0.17, 0.27],
};

// Flat, category-independent 1st-trimester allowance (IOM), reached by week
// 13 — every BMI category's expected range starts from the same [0.5,2]kg by
// the end of trimester 1 (from 0kg at week 0), then diverges by category
// afterward via WEEKLY_GAIN_RATE_KG_T2T3.
export const T1_GAIN_RANGE_KG = [0.5, 2];
export const T1_END_WEEK = 13;

// Expected cumulative gain range at a given gestational week, for a BMI
// category — weeks 0–13 linearly interpolate toward T1_GAIN_RANGE_KG, weeks
// 14+ add WEEKLY_GAIN_RATE_KG_T2T3 on top of the full T1 allowance. Returns
// null when category is unknown (BMI not computable yet — pre-pregnancy
// weight/height not both set).
export function expectedGainRangeAtWeek(category, weeks) {
  const rate = WEEKLY_GAIN_RATE_KG_T2T3[category];
  if (!rate) return null;
  const w = Math.max(0, Number(weeks) || 0);
  if (w <= T1_END_WEEK) {
    const frac = w / T1_END_WEEK;
    return { minKg: T1_GAIN_RANGE_KG[0] * frac, maxKg: T1_GAIN_RANGE_KG[1] * frac };
  }
  const extraWeeks = w - T1_END_WEEK;
  return {
    minKg: T1_GAIN_RANGE_KG[0] + extraWeeks * rate[0],
    maxKg: T1_GAIN_RANGE_KG[1] + extraWeeks * rate[1],
  };
}

// Where an actual cumulative gain falls relative to the expected range at
// this week — "below"/"within"/"above" its [minKg,maxKg] band (boundary
// values count as "within", same strict-inequality spirit as
// lib/nutrition.js's exceededLimitLabels using `>` rather than `>=`).
// A null `expectedRange` (unknown BMI category) -> null (nothing to compare).
export function gainStatusForWeek(actualGainKg, expectedRange) {
  if (!expectedRange) return null;
  const g = Number(actualGainKg);
  if (!Number.isFinite(g)) return null;
  if (g < expectedRange.minKg) return "below";
  if (g > expectedRange.maxKg) return "above";
  return "within";
}

export const GAIN_STATUS_META = {
  within: { label: "Sesuai target", color: "#8FAE8B" },
  below: { label: "Di bawah target", color: "#E3B65E" },
  above: { label: "Di atas target", color: "#C77B7B" },
};
