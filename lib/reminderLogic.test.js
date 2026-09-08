import { describe, it, expect } from "vitest";
import { pickMissing, buildReminderBody, pickFallbackNudge, FALLBACK_NUDGES } from "@/lib/reminderLogic";

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
