import { describe, it, expect } from "vitest";
import {
  pickMissing, buildReminderBody, pickFallbackNudge, FALLBACK_NUDGES,
  greet, buildMorningBody, buildLunchBody, buildNightBody,
  pickMealFactFallback, MEAL_FACT_FALLBACKS, sumReminderResults,
} from "@/lib/reminderLogic";

describe("pickMissing", () => {
  it("marks both missing when the user is in neither set", () => {
    expect(pickMissing(new Set(), new Set(), "u1")).toEqual({ missingMeal: true, missingVitamin: true });
  });

  it("marks only vitamin missing when the user logged a meal but no vitamin", () => {
    const meals = new Set(["u1", "u2"]);
    const vitamins = new Set(["u2"]);
    expect(pickMissing(meals, vitamins, "u1")).toEqual({ missingMeal: false, missingVitamin: true });
  });

  it("marks nothing missing when the user is in both sets", () => {
    const meals = new Set(["u1"]);
    const vitamins = new Set(["u1"]);
    expect(pickMissing(meals, vitamins, "u1")).toEqual({ missingMeal: false, missingVitamin: false });
  });
});

describe("buildReminderBody", () => {
  it("combines both when meal and vitamin are missing", () => {
    const body = buildReminderBody({ missingMeal: true, missingVitamin: true, nudge: "Semangat!" });
    expect(body).toContain("menu & minum vitamin");
    expect(body).toContain("Semangat!");
  });

  it("mentions only the meal when just the meal is missing", () => {
    const body = buildReminderBody({ missingMeal: true, missingVitamin: false, nudge: "Semangat!" });
    expect(body).toContain("Belum catat menu hari ini.");
    expect(body).not.toContain("vitamin");
  });

  it("mentions only the vitamin when just the vitamin is missing", () => {
    const body = buildReminderBody({ missingMeal: false, missingVitamin: true, nudge: "Semangat!" });
    expect(body).toContain("Belum minum vitamin hari ini.");
    expect(body).not.toContain("catat menu");
  });

  it("works without a nudge (falls back to just the lead line)", () => {
    const body = buildReminderBody({ missingMeal: true, missingVitamin: false, nudge: "" });
    expect(body).toBe("Belum catat menu hari ini.");
  });

  it("prefixes a personal greeting when a name is given", () => {
    const body = buildReminderBody({ missingMeal: true, missingVitamin: false, nudge: "Semangat!", name: "Sarah" });
    expect(body).toBe("Hai Sarah, belum catat menu hari ini. Semangat!");
  });
});

describe("greet", () => {
  it("uses the name when given", () => {
    expect(greet("Sarah", "Pagi")).toBe("Pagi, Sarah!");
  });

  it("falls back to a generic greeting when no name is set", () => {
    expect(greet(null, "Pagi")).toBe("Pagi!");
    expect(greet("", "Pagi")).toBe("Pagi!");
  });
});

describe("buildMorningBody / buildLunchBody / buildNightBody", () => {
  it("morning combines a greeting with the nudge", () => {
    expect(buildMorningBody({ name: "Sarah", nudge: "Semangat hari ini!" })).toBe("Pagi, Sarah! Semangat hari ini!");
    expect(buildMorningBody({ name: null, nudge: "Semangat hari ini!" })).toBe("Pagi! Semangat hari ini!");
  });

  it("lunch combines a greeting, the fixed nudge line, and a meal fact", () => {
    const body = buildLunchBody({ name: "Sarah", mealFact: "Protein penting hari ini." });
    expect(body).toContain("Siang, Sarah!");
    expect(body).toContain("Waktunya makan siang");
    expect(body).toContain("Protein penting hari ini.");
  });

  it("night combines a greeting, the sleep reminder, and the nudge", () => {
    const body = buildNightBody({ name: "Sarah", nudge: "Istirahat ya." });
    expect(body).toContain("Malam, Sarah!");
    expect(body).toContain("Waktunya istirahat");
    expect(body).toContain("Istirahat ya.");
  });
});

describe("pickFallbackNudge", () => {
  it("is deterministic for the same seed", () => {
    const a = pickFallbackNudge("user-1:2026-09-08");
    const b = pickFallbackNudge("user-1:2026-09-08");
    expect(a).toBe(b);
  });

  it("returns a real line from the bank", () => {
    const line = pickFallbackNudge("user-1:2026-09-08");
    expect(FALLBACK_NUDGES).toContain(line);
  });

  it("handles an empty/undefined seed without throwing", () => {
    expect(() => pickFallbackNudge(undefined)).not.toThrow();
    expect(FALLBACK_NUDGES).toContain(pickFallbackNudge(undefined));
  });
});

describe("pickMealFactFallback", () => {
  it("is deterministic for the same seed and returns a real bank line", () => {
    const a = pickMealFactFallback("user-1:2026-09-08");
    const b = pickMealFactFallback("user-1:2026-09-08");
    expect(a).toBe(b);
    expect(MEAL_FACT_FALLBACKS).toContain(a);
  });
});

// Covers the aggregation step app/api/cron/reminders/route.js runs after its
// per-user Promise.all settles (see the timeout fix -- concurrent per-user
// tasks return their own { sent, pruned, skipped } instead of mutating a
// shared counter mid-loop).
describe("sumReminderResults", () => {
  it("sums sent/pruned/skipped across multiple user results", () => {
    const results = [
      { sent: 2, pruned: 0, skipped: 0 }, // user with 2 devices, both sent
      { sent: 0, pruned: 1, skipped: 0 }, // user with 1 dead subscription, pruned
      { sent: 0, pruned: 0, skipped: 1 }, // dinner slot: already logged, skipped
    ];
    expect(sumReminderResults(results)).toEqual({ sent: 2, pruned: 1, skipped: 1 });
  });

  it("returns all zeros for an empty result list (e.g. no subscribers)", () => {
    expect(sumReminderResults([])).toEqual({ sent: 0, pruned: 0, skipped: 0 });
  });

  it("handles a mix of successes, prunes, and skips in the same batch", () => {
    const results = [
      { sent: 1, pruned: 1, skipped: 0 }, // one device sent, one pruned, same user
      { sent: 3, pruned: 0, skipped: 0 },
      { sent: 0, pruned: 0, skipped: 1 },
      { sent: 0, pruned: 0, skipped: 1 },
    ];
    expect(sumReminderResults(results)).toEqual({ sent: 4, pruned: 1, skipped: 2 });
  });

  it("doesn't throw on a missing/undefined input", () => {
    expect(() => sumReminderResults(undefined)).not.toThrow();
    expect(sumReminderResults(undefined)).toEqual({ sent: 0, pruned: 0, skipped: 0 });
  });
});
