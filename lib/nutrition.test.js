import { describe, it, expect, vi, afterEach } from "vitest";
import {
  todayISOInTimeZone, buildExtraNutrientsMap, vitaminItemToRow,
  LIMITS, exceededLimitLabels, computeActiveLimitNutrients,
  groupLimitTotalsByUser, mergeUserTotals,
} from "@/lib/nutrition";

// This function pre-dates the push-reminder feature (a leftover from the
// removed WhatsApp integration, see supabase/schema.sql's cleanup block) and
// had no test coverage. It's added here because app/api/cron/reminders/route.js
// now depends on it being correct at day boundaries to decide *when* "today"
// rolls over in WIB for a serverless host running on UTC — not a drive-by
// test of unrelated code.
describe("todayISOInTimeZone", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolls over to the next WIB day before UTC midnight", () => {
    // 23:30 UTC on 2026-09-08 is 06:30 WIB on 2026-09-09 (UTC+7, no DST) --
    // the exact boundary case a naive UTC-date read would get wrong.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T23:30:00Z"));
    expect(todayISOInTimeZone("Asia/Jakarta")).toBe("2026-09-09");
  });

  it("stays on the same WIB day well before the boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T05:00:00Z")); // 12:00 WIB, same day
    expect(todayISOInTimeZone("Asia/Jakarta")).toBe("2026-09-08");
  });
});

// Shared by the manual "Tambah vitamin" form's "nutrisi lain" rows and, since
// the chat-vitamin-label-analysis feature, a Gemini-detected vitamin item's
// extra_nutrients — see app/dashboard/page.js's handleAddVitamin and
// app/dashboard/chat/page.js's saveVitaminItemToDashboard.
describe("buildExtraNutrientsMap", () => {
  it("builds a slug-keyed map from complete rows", () => {
    const map = buildExtraNutrientsMap([{ label: "Zinc", unit: "mg", value: "15" }]);
    expect(map).toEqual({ zinc: { label: "Zinc", unit: "mg", value: 15 } });
  });

  it("silently drops rows with no label or a non-numeric value, not as zero", () => {
    const map = buildExtraNutrientsMap([
      { label: "", unit: "mg", value: "15" },
      { label: "Iodium", unit: "mcg", value: "" },
      { label: "Iodium", unit: "mcg", value: "abc" },
    ]);
    expect(map).toEqual({});
  });

  it("accepts an already-numeric value (Gemini's shape) as well as a raw form string", () => {
    const map = buildExtraNutrientsMap([{ label: "Vitamin B6", unit: "mg", value: 2.5 }]);
    expect(map.vitamin_b6).toEqual({ label: "Vitamin B6", unit: "mg", value: 2.5 });
  });

  it("defaults a missing unit to an empty string", () => {
    const map = buildExtraNutrientsMap([{ label: "Selenium", value: "5" }]);
    expect(map.selenium.unit).toBe("");
  });

  it("collapses same-slug labels (case/spacing-insensitive) to the last row", () => {
    const map = buildExtraNutrientsMap([
      { label: "Zinc", unit: "mg", value: "10" },
      { label: " zinc ", unit: "mg", value: "20" },
    ]);
    expect(Object.keys(map)).toEqual(["zinc"]);
    expect(map.zinc.value).toBe(20);
  });

  it("returns an empty map for no rows", () => {
    expect(buildExtraNutrientsMap([])).toEqual({});
    expect(buildExtraNutrientsMap(undefined)).toEqual({});
  });
});

describe("vitaminItemToRow", () => {
  it("builds a DB-ready row with user_id, numeric nutrients, and extra_nutrients", () => {
    const item = {
      name: "Folamil Genio",
      folate_mcg: 1000,
      iron_mg: 30,
      extra_nutrients: [{ label: "Zinc", unit: "mg", value: 15 }],
    };
    const row = vitaminItemToRow(item, "user-1");
    expect(row.user_id).toBe("user-1");
    expect(row.name).toBe("Folamil Genio");
    expect(row.folate_mcg).toBe(1000);
    expect(row.iron_mg).toBe(30);
    expect(row.calories).toBe(0); // NUTRIENT_ORDER field not present on the item
    expect(row.extra_nutrients).toEqual({ zinc: { label: "Zinc", unit: "mg", value: 15 } });
  });

  // Regression guard for exactly the "silently dropped" bug this feature
  // would otherwise reintroduce -- vitaminItemToRow switched from
  // NUTRIENT_ORDER to ALL_TRACKED_NUTRIENTS so a Gemini-detected vitamin
  // item's sugar/sodium/etc. (e.g. an effervescent tablet) actually persist.
  it("carries the 5 LIMIT_ORDER (batas harian) fields onto the row", () => {
    const item = { name: "Vitamin C Effervescent", sugar_g: 4, sodium_mg: 60 };
    const row = vitaminItemToRow(item, "user-1");
    expect(row.sugar_g).toBe(4);
    expect(row.sodium_mg).toBe(60);
    expect(row.cholesterol_mg).toBe(0);
    expect(row.saturated_fat_g).toBe(0);
    expect(row.caffeine_mg).toBe(0);
  });

  it("falls back to a placeholder name when the item has none", () => {
    const row = vitaminItemToRow({}, "user-1");
    expect(row.name).toBe("Vitamin");
  });

  it("coerces non-numeric/missing nutrient fields to 0 instead of NaN", () => {
    const row = vitaminItemToRow({ name: "X", calcium_mg: "not a number" }, "user-1");
    expect(row.calcium_mg).toBe(0);
  });
});

// Single source of truth shared by the Dashboard's warning banner
// (app/dashboard/page.js) and the dinner-reminder trigger/message
// (lib/reminderLogic.js, app/api/cron/reminders/route.js) — "what counts as
// exceeded" can't drift between the two since both call this.
describe("exceededLimitLabels", () => {
  it("returns an empty list when nothing is over its limit", () => {
    expect(exceededLimitLabels({})).toEqual([]);
    expect(exceededLimitLabels({ sugar_g: 10, sodium_mg: 500 })).toEqual([]);
  });

  it("names a single nutrient strictly over its LIMITS entry", () => {
    expect(exceededLimitLabels({ sodium_mg: LIMITS.sodium_mg + 1 })).toEqual(["Natrium"]);
  });

  it("excludes a nutrient sitting exactly AT its limit (strict >, not >=)", () => {
    expect(exceededLimitLabels({ sodium_mg: LIMITS.sodium_mg })).toEqual([]);
  });

  it("names every exceeded nutrient, in LIMIT_ORDER order", () => {
    const totals = { sugar_g: LIMITS.sugar_g + 5, caffeine_mg: LIMITS.caffeine_mg + 10 };
    expect(exceededLimitLabels(totals)).toEqual(["Gula", "Kafein"]);
  });

  it("handles a missing/undefined totals object without throwing", () => {
    expect(() => exceededLimitLabels(undefined)).not.toThrow();
    expect(exceededLimitLabels(undefined)).toEqual([]);
  });
});

describe("computeActiveLimitNutrients", () => {
  // Same "present" (not null/undefined) semantics as computeActiveNutrients
  // already uses for the floor-type list -- a column explicitly present
  // (even at 0) counts as tracked; a column never present on any row doesn't.
  it("returns only LIMIT_ORDER nutrients present (non-null) on at least one row", () => {
    const rows = [{ sugar_g: 5 }, { cholesterol_mg: 0 }]; // sodium_mg never present on any row
    expect(computeActiveLimitNutrients(rows)).toEqual(["sugar_g", "cholesterol_mg"]);
  });

  it("returns an empty list for no rows, or rows where the field is simply absent", () => {
    expect(computeActiveLimitNutrients([])).toEqual([]);
    expect(computeActiveLimitNutrients([{ meal: "Nasi goreng" }])).toEqual([]);
  });

  it("preserves LIMIT_ORDER's own ordering regardless of row order", () => {
    const rows = [{ caffeine_mg: 50, sugar_g: 5 }];
    expect(computeActiveLimitNutrients(rows)).toEqual(["sugar_g", "caffeine_mg"]);
  });
});

// Multi-user sum helpers used server-side by the cron route's dinner slot
// (app/api/cron/reminders/route.js) to combine meals rows + checked-vitamins
// rows into one per-user totals map, without a database in the loop.
describe("groupLimitTotalsByUser / mergeUserTotals", () => {
  it("sums LIMIT_ORDER fields per user_id across multiple rows", () => {
    const rows = [
      { user_id: "u1", sugar_g: 5, sodium_mg: 100 },
      { user_id: "u1", sugar_g: 10, sodium_mg: 200 },
      { user_id: "u2", sugar_g: 3, sodium_mg: 50 },
    ];
    const totals = groupLimitTotalsByUser(rows);
    expect(totals.u1.sugar_g).toBe(15);
    expect(totals.u1.sodium_mg).toBe(300);
    expect(totals.u2.sugar_g).toBe(3);
  });

  it("ignores rows with no user_id and returns {} for no rows", () => {
    expect(groupLimitTotalsByUser([{ sugar_g: 5 }])).toEqual({});
    expect(groupLimitTotalsByUser([])).toEqual({});
    expect(groupLimitTotalsByUser(undefined)).toEqual({});
  });

  it("mergeUserTotals adds two per-user maps together, per nutrient", () => {
    const mealTotals = groupLimitTotalsByUser([{ user_id: "u1", sugar_g: 5 }]);
    const vitaminTotals = groupLimitTotalsByUser([{ user_id: "u1", sugar_g: 2 }, { user_id: "u2", sodium_mg: 40 }]);
    const merged = mergeUserTotals(mealTotals, vitaminTotals);
    expect(merged.u1.sugar_g).toBe(7);
    expect(merged.u2.sodium_mg).toBe(40);
  });

  it("mergeUserTotals handles two empty maps without throwing", () => {
    expect(mergeUserTotals({}, {})).toEqual({});
  });
});
