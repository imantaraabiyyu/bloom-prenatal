import { describe, it, expect } from "vitest";
import {
  computeBMI, bmiCategory, BMI_CATEGORY_META,
  TOTAL_GAIN_RANGE_KG, WEEKLY_GAIN_RATE_KG_T2T3, T1_GAIN_RANGE_KG, T1_END_WEEK,
  expectedGainRangeAtWeek, gainStatusForWeek, GAIN_STATUS_META, computeMonthlyGain,
} from "@/lib/weight";

describe("computeBMI", () => {
  it("computes a normal BMI from weight (kg) and height (cm)", () => {
    // 60kg / (1.65m)^2 = 22.03...
    expect(computeBMI(60, 165)).toBeCloseTo(22.04, 1);
  });

  it("returns null when either input is missing", () => {
    expect(computeBMI(null, 165)).toBeNull();
    expect(computeBMI(60, null)).toBeNull();
    expect(computeBMI(undefined, undefined)).toBeNull();
  });

  it("returns null for a zero or negative weight/height", () => {
    expect(computeBMI(0, 165)).toBeNull();
    expect(computeBMI(60, 0)).toBeNull();
    expect(computeBMI(-60, 165)).toBeNull();
  });

  it("returns null for a non-numeric input", () => {
    expect(computeBMI("not a number", 165)).toBeNull();
  });
});

describe("bmiCategory", () => {
  it("returns null for a null/non-finite BMI", () => {
    expect(bmiCategory(null)).toBeNull();
    expect(bmiCategory(undefined)).toBeNull();
    expect(bmiCategory(NaN)).toBeNull();
  });

  it("classifies clearly-in-range values correctly", () => {
    expect(bmiCategory(17)).toBe("underweight");
    expect(bmiCategory(22)).toBe("normal");
    expect(bmiCategory(27)).toBe("overweight");
    expect(bmiCategory(35)).toBe("obese");
  });

  // Boundary values belong to the HIGHER category (same convention as
  // lib/nutrition.js's STATUS_TIERS).
  it("assigns each boundary value to the higher category", () => {
    expect(bmiCategory(18.5)).toBe("normal");
    expect(bmiCategory(25)).toBe("overweight");
    expect(bmiCategory(30)).toBe("obese");
  });

  it("every returned category has a BMI_CATEGORY_META entry", () => {
    for (const cat of ["underweight", "normal", "overweight", "obese"]) {
      expect(BMI_CATEGORY_META[cat]).toBeTruthy();
      expect(BMI_CATEGORY_META[cat].label).toBeTruthy();
    }
  });
});

describe("expectedGainRangeAtWeek", () => {
  it("returns null for an unknown/null category", () => {
    expect(expectedGainRangeAtWeek(null, 20)).toBeNull();
    expect(expectedGainRangeAtWeek("not-a-category", 20)).toBeNull();
  });

  it("is [0,0] at week 0 regardless of category", () => {
    for (const cat of Object.keys(WEEKLY_GAIN_RATE_KG_T2T3)) {
      expect(expectedGainRangeAtWeek(cat, 0)).toEqual({ minKg: 0, maxKg: 0 });
    }
  });

  it("reaches exactly T1_GAIN_RANGE_KG at week 13, regardless of category (flat T1 allowance)", () => {
    for (const cat of Object.keys(WEEKLY_GAIN_RATE_KG_T2T3)) {
      const range = expectedGainRangeAtWeek(cat, T1_END_WEEK);
      expect(range.minKg).toBeCloseTo(T1_GAIN_RANGE_KG[0], 5);
      expect(range.maxKg).toBeCloseTo(T1_GAIN_RANGE_KG[1], 5);
    }
  });

  it("interpolates linearly toward the T1 allowance before week 13", () => {
    // Halfway through T1 (week 6.5) -> roughly half the T1 allowance
    const range = expectedGainRangeAtWeek("normal", T1_END_WEEK / 2);
    expect(range.minKg).toBeCloseTo(T1_GAIN_RANGE_KG[0] / 2, 5);
    expect(range.maxKg).toBeCloseTo(T1_GAIN_RANGE_KG[1] / 2, 5);
  });

  it("adds the category's weekly T2/T3 rate on top of the full T1 allowance after week 13", () => {
    const week = 20; // 7 weeks into T2/T3
    const range = expectedGainRangeAtWeek("normal", week);
    const [minRate, maxRate] = WEEKLY_GAIN_RATE_KG_T2T3.normal;
    expect(range.minKg).toBeCloseTo(T1_GAIN_RANGE_KG[0] + 7 * minRate, 5);
    expect(range.maxKg).toBeCloseTo(T1_GAIN_RANGE_KG[1] + 7 * maxRate, 5);
  });

  it("treats a negative/undefined week as week 0", () => {
    expect(expectedGainRangeAtWeek("normal", -5)).toEqual({ minKg: 0, maxKg: 0 });
    expect(expectedGainRangeAtWeek("normal", undefined)).toEqual({ minKg: 0, maxKg: 0 });
  });
});

describe("gainStatusForWeek", () => {
  const range = { minKg: 5, maxKg: 8 };

  it("returns null when the range itself is null (unknown BMI category)", () => {
    expect(gainStatusForWeek(6, null)).toBeNull();
  });

  it("returns null for a non-numeric actual gain", () => {
    expect(gainStatusForWeek("not a number", range)).toBeNull();
  });

  it("classifies clearly below/within/above", () => {
    expect(gainStatusForWeek(3, range)).toBe("below");
    expect(gainStatusForWeek(6.5, range)).toBe("within");
    expect(gainStatusForWeek(10, range)).toBe("above");
  });

  it("treats the exact boundary values as within range", () => {
    expect(gainStatusForWeek(5, range)).toBe("within");
    expect(gainStatusForWeek(8, range)).toBe("within");
  });

  it("every returned status has a GAIN_STATUS_META entry", () => {
    for (const status of ["below", "within", "above"]) {
      expect(GAIN_STATUS_META[status]).toBeTruthy();
      expect(GAIN_STATUS_META[status].label).toBeTruthy();
    }
  });
});

// Sanity guard: every BMI category referenced by bmiCategory has entries in
// both IOM tables, so a category returned by one function is always usable
// by the others without an undefined lookup.
describe("category tables stay in sync", () => {
  it("TOTAL_GAIN_RANGE_KG and WEEKLY_GAIN_RATE_KG_T2T3 cover the same 4 categories", () => {
    const categories = ["underweight", "normal", "overweight", "obese"];
    for (const cat of categories) {
      expect(TOTAL_GAIN_RANGE_KG[cat]).toHaveLength(2);
      expect(WEEKLY_GAIN_RATE_KG_T2T3[cat]).toHaveLength(2);
      expect(BMI_CATEGORY_META[cat]).toBeTruthy();
    }
  });
});

// Used by the "Peningkatan berat bulanan" monthly bar chart
// (app/dashboard/profile/page.js).
describe("computeMonthlyGain", () => {
  it("returns [] for no rows", () => {
    expect(computeMonthlyGain([], 60)).toEqual([]);
    expect(computeMonthlyGain(undefined, 60)).toEqual([]);
  });

  it("uses pre-pregnancy weight as the baseline for the first data month, when set", () => {
    const rows = [{ date: "2026-03-05", weight_kg: 61 }, { date: "2026-03-20", weight_kg: 62 }];
    // Only the LAST entry of March (62kg) counts, compared against 60kg pre-pregnancy.
    expect(computeMonthlyGain(rows, 60)).toEqual([{ month: "2026-03", gainKg: 2 }]);
  });

  it("omits the first data month entirely when there's no pre-pregnancy weight to compare against", () => {
    const rows = [{ date: "2026-03-20", weight_kg: 62 }];
    expect(computeMonthlyGain(rows, null)).toEqual([]);
    expect(computeMonthlyGain(rows, undefined)).toEqual([]);
  });

  it("chains consecutive months off each other's last entry", () => {
    const rows = [
      { date: "2026-03-20", weight_kg: 62 },
      { date: "2026-04-10", weight_kg: 63.5 },
      { date: "2026-04-25", weight_kg: 64 }, // April's LAST entry -- the 63.5 one is superseded
      { date: "2026-05-15", weight_kg: 65.2 },
    ];
    const result = computeMonthlyGain(rows, 60);
    expect(result.map((r) => r.month)).toEqual(["2026-03", "2026-04", "2026-05"]);
    expect(result[0].gainKg).toBeCloseTo(2, 5);   // 62 - 60
    expect(result[1].gainKg).toBeCloseTo(2, 5);   // 64 - 62 (April's LAST entry, 64, not 63.5)
    expect(result[2].gainKg).toBeCloseTo(1.2, 5); // 65.2 - 64
  });

  it("chains across a data-gap month using the last data-bearing month, not the literal prior calendar month", () => {
    const rows = [
      { date: "2026-03-20", weight_kg: 62 },
      // April has no entries at all
      { date: "2026-05-15", weight_kg: 65 },
    ];
    const result = computeMonthlyGain(rows, 60);
    expect(result).toEqual([
      { month: "2026-03", gainKg: 2 },   // 62 - 60
      { month: "2026-05", gainKg: 3 },   // 65 - 62 (April skipped, not a break in the chain)
    ]);
  });

  it("supports a negative gain (weight loss between months)", () => {
    const rows = [{ date: "2026-03-10", weight_kg: 58 }, { date: "2026-04-10", weight_kg: 57 }];
    const result = computeMonthlyGain(rows, 60);
    expect(result[1]).toEqual({ month: "2026-04", gainKg: -1 });
  });

  it("ignores rows with no date", () => {
    expect(computeMonthlyGain([{ weight_kg: 60 }], 55)).toEqual([]);
  });
});
