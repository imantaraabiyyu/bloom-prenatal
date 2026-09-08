import { describe, it, expect, vi, afterEach } from "vitest";
import { todayISOInTimeZone, buildExtraNutrientsMap, vitaminItemToRow } from "@/lib/nutrition";

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

  it("falls back to a placeholder name when the item has none", () => {
    const row = vitaminItemToRow({}, "user-1");
    expect(row.name).toBe("Vitamin");
  });

  it("coerces non-numeric/missing nutrient fields to 0 instead of NaN", () => {
    const row = vitaminItemToRow({ name: "X", calcium_mg: "not a number" }, "user-1");
    expect(row.calcium_mg).toBe(0);
  });
});
