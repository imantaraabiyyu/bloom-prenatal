import { describe, it, expect, vi, afterEach } from "vitest";
import {
  todayISOInTimeZone, buildExtraNutrientsMap, vitaminItemToRow,
  TARGETS, LIMITS, ALL_TRACKED_NUTRIENTS, exceededGoalLabels, computeActiveLimitNutrients,
  groupLimitTotalsByUser, mergeUserTotals, resolveEffectiveGoals, collectKnownExtraNutrientSlugs,
  statusForGoal, statusForPct, limitStatusForPct, computeActiveTrackedNutrients,
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
// exceeded" can't drift between the two since both call this. Replaces the
// old exceededLimitLabels(totals) (fixed LIMIT_ORDER/LIMITS) now that
// "which keys are max-type at all" is per-user (resolveEffectiveGoals),
// tested here via plain hand-built effectiveGoals maps rather than a real
// resolveEffectiveGoals call, since the two are independently testable.
describe("exceededGoalLabels", () => {
  const goals = {
    sodium_mg: { label: "Natrium", unit: "mg", goalType: "max", targetValue: LIMITS.sodium_mg },
    sugar_g: { label: "Gula", unit: "g", goalType: "max", targetValue: LIMITS.sugar_g },
    caffeine_mg: { label: "Kafein", unit: "mg", goalType: "max", targetValue: LIMITS.caffeine_mg },
    protein_g: { label: "Protein", unit: "g", goalType: "min", targetValue: TARGETS.t2.protein_g },
  };

  it("returns an empty list when nothing is over its limit", () => {
    expect(exceededGoalLabels({}, goals)).toEqual([]);
    expect(exceededGoalLabels({ sugar_g: 10, sodium_mg: 500 }, goals)).toEqual([]);
  });

  it("names a single nutrient strictly over its max-type target", () => {
    expect(exceededGoalLabels({ sodium_mg: LIMITS.sodium_mg + 1 }, goals)).toEqual(["Natrium"]);
  });

  it("excludes a nutrient sitting exactly AT its limit (strict >, not >=)", () => {
    expect(exceededGoalLabels({ sodium_mg: LIMITS.sodium_mg }, goals)).toEqual([]);
  });

  it("never flags a min-type goal, even when its total is far over the target", () => {
    expect(exceededGoalLabels({ protein_g: TARGETS.t2.protein_g * 3 }, goals)).toEqual([]);
  });

  it("names every exceeded nutrient", () => {
    const totals = { sugar_g: LIMITS.sugar_g + 5, caffeine_mg: LIMITS.caffeine_mg + 10 };
    expect(exceededGoalLabels(totals, goals)).toEqual(["Gula", "Kafein"]);
  });

  it("handles a missing/undefined totals or goals object without throwing", () => {
    expect(() => exceededGoalLabels(undefined, goals)).not.toThrow();
    expect(exceededGoalLabels(undefined, goals)).toEqual([]);
    expect(exceededGoalLabels({ sodium_mg: 9999 }, undefined)).toEqual([]);
  });
});

// The one seam every consumer (Dashboard, Gemini chat route, cron route)
// reads a user's nutrient goal through instead of TARGETS/LIMITS directly.
describe("resolveEffectiveGoals", () => {
  it("falls back to today's global defaults (direction + value) for every key when there are no goal rows", () => {
    const effective = resolveEffectiveGoals([], "t2");
    expect(effective.protein_g).toEqual({
      label: "Protein", unit: "g", goalType: "min", targetValue: TARGETS.t2.protein_g, isCustom: false,
    });
    expect(effective.sodium_mg).toEqual({
      label: "Natrium", unit: "mg", goalType: "max", targetValue: LIMITS.sodium_mg, isCustom: false,
    });
    expect(Object.keys(effective)).toEqual(ALL_TRACKED_NUTRIENTS);
  });

  it("uses a fixed-key override row verbatim instead of the global default", () => {
    const goalRows = [{ nutrient_key: "protein_g", label: "Protein", unit: "g", goal_type: "max", target_value: 90 }];
    const effective = resolveEffectiveGoals(goalRows, "t2");
    expect(effective.protein_g).toEqual({ label: "Protein", unit: "g", goalType: "max", targetValue: 90, isCustom: false });
  });

  it("folds in a custom (non-ALL_TRACKED_NUTRIENTS) goal row with isCustom: true", () => {
    const goalRows = [{ nutrient_key: "laktosa", label: "Laktosa", unit: "g", goal_type: "max", target_value: 12 }];
    const effective = resolveEffectiveGoals(goalRows, "t2");
    expect(effective.laktosa).toEqual({ label: "Laktosa", unit: "g", goalType: "max", targetValue: 12, isCustom: true });
    // fixed keys are still all present, untouched by the custom row
    expect(effective.protein_g.isCustom).toBe(false);
  });

  it("respects the given trimester for the floor-type fallback", () => {
    expect(resolveEffectiveGoals([], "t1").calories.targetValue).toBe(TARGETS.t1.calories);
    expect(resolveEffectiveGoals([], "t3").calories.targetValue).toBe(TARGETS.t3.calories);
  });
});

describe("collectKnownExtraNutrientSlugs", () => {
  it("dedupes by slug across meals and vitamins rows, last-seen label/unit wins", () => {
    const rows = [
      { extra_nutrients: { laktosa: { label: "Laktosa", unit: "g", value: 5 } } },
      { extra_nutrients: { laktosa: { label: "Laktosa", unit: "mg", value: 200 } } },
      { extra_nutrients: { zinc: { label: "Zinc", unit: "mg", value: 10 } } },
    ];
    const slugs = collectKnownExtraNutrientSlugs(rows);
    expect(slugs).toEqual([
      { slug: "laktosa", label: "Laktosa", unit: "mg" }, // last-seen unit wins
      { slug: "zinc", label: "Zinc", unit: "mg" },
    ]);
  });

  it("returns [] for no rows, rows with no extra_nutrients, or entries with no label", () => {
    expect(collectKnownExtraNutrientSlugs([])).toEqual([]);
    expect(collectKnownExtraNutrientSlugs([{ extra_nutrients: {} }, {}])).toEqual([]);
    expect(collectKnownExtraNutrientSlugs([{ extra_nutrients: { x: { unit: "g", value: 1 } } }])).toEqual([]);
  });
});

describe("statusForGoal", () => {
  it("routes a max-type goal through limitStatusForPct", () => {
    expect(statusForGoal(50, "max")).toEqual(limitStatusForPct(50));
    expect(statusForGoal(120, "max")).toEqual(limitStatusForPct(120));
  });

  it("routes a min-type (or any other) goal through statusForPct", () => {
    expect(statusForGoal(50, "min")).toEqual(statusForPct(50));
    expect(statusForGoal(90, undefined)).toEqual(statusForPct(90));
  });
});

describe("computeActiveTrackedNutrients", () => {
  it("detects presence across both floor- and ceiling-type keys together", () => {
    const rows = [{ protein_g: 10 }, { sodium_mg: 0 }]; // sodium_mg explicitly present, even at 0
    expect(computeActiveTrackedNutrients(rows)).toEqual(["protein_g", "sodium_mg"]);
  });

  it("returns [] for no rows or rows with no tracked fields", () => {
    expect(computeActiveTrackedNutrients([])).toEqual([]);
    expect(computeActiveTrackedNutrients([{ meal: "Nasi goreng" }])).toEqual([]);
  });

  it("preserves ALL_TRACKED_NUTRIENTS' own ordering regardless of row order", () => {
    const rows = [{ sodium_mg: 50, protein_g: 5 }];
    expect(computeActiveTrackedNutrients(rows)).toEqual(["protein_g", "sodium_mg"]);
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

  // Additive 3rd `keys` param (defaults to LIMIT_ORDER, preserving every
  // test above unchanged) -- new callers pass ALL_TRACKED_NUTRIENTS once
  // "which columns matter" is per-user instead of fixed to LIMIT_ORDER.
  it("sums an explicit ALL_TRACKED_NUTRIENTS key list when given a 3rd `keys` arg", () => {
    const rows = [
      { user_id: "u1", protein_g: 20, sodium_mg: 100 },
      { user_id: "u1", protein_g: 5, sodium_mg: 50 },
    ];
    const totals = groupLimitTotalsByUser(rows, ALL_TRACKED_NUTRIENTS);
    expect(totals.u1.protein_g).toBe(25); // a floor-type key, ignored by the default LIMIT_ORDER-only behavior
    expect(totals.u1.sodium_mg).toBe(150);
  });

  it("mergeUserTotals sums the same broader key list when given a matching `keys` arg", () => {
    const a = groupLimitTotalsByUser([{ user_id: "u1", calories: 300 }], ALL_TRACKED_NUTRIENTS);
    const b = groupLimitTotalsByUser([{ user_id: "u1", calories: 200 }], ALL_TRACKED_NUTRIENTS);
    const merged = mergeUserTotals(a, b, ALL_TRACKED_NUTRIENTS);
    expect(merged.u1.calories).toBe(500);
  });
});
