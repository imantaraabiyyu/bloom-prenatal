import { describe, it, expect, vi } from "vitest";

// lib/gemini.js starts with `import "server-only"` — a marker package whose
// default export throws unconditionally outside of Next.js's own
// react-server bundling condition (which Vitest, running under plain Node,
// never sets). Stubbing it here is the standard way to unit-test a
// server-only module's pure helpers without a full Next.js render pipeline;
// sanitizeChatTurnResult itself touches no secrets/network, only
// buildResponseSchema/streamNutritionChatTurn (both call the live Gemini API
// with GEMINI_API_KEY) actually need that guard.
vi.mock("server-only", () => ({}));

const { sanitizeChatTurnResult } = await import("@/lib/gemini");

// sanitizeChatTurnResult turns Gemini's raw parsed JSON (lib/gemini.js's
// buildResponseSchema: category "food"|"vitamin"|"chat") into the shape
// app/dashboard/chat/page.js relies on. It's the one piece of the chat-turn
// pipeline with no network/DOM dependency, so it's exported specifically to
// be unit-tested here — the rest of streamNutritionChatTurn (the actual
// Gemini HTTP call) has no test in this repo, same as before this feature.
describe("sanitizeChatTurnResult", () => {
  it("passes through a normal food result", () => {
    const result = sanitizeChatTurnResult({
      category: "food", meal: "Nasi goreng", calories: 400, protein_g: 12,
      iron_mg: 2, calcium_mg: 50, folate_mcg: 30, vitamin_d_mcg: 0, fiber_g: 3,
      water_ml: 0, dha_mg: 0, vitamin_k_mcg: 5, vitamins: [], reply: "Enak ya!",
    });
    expect(result.category).toBe("food");
    expect(result.meal).toBe("Nasi goreng");
    expect(result.calories).toBe(400);
    expect(result.vitamins).toEqual([]);
    expect(result.reply).toBe("Enak ya!");
  });

  it("downgrades food with an empty meal to chat (nothing sensible to save)", () => {
    const result = sanitizeChatTurnResult({ category: "food", meal: "", calories: 400, reply: "Hmm" });
    expect(result.category).toBe("chat");
    expect(result.meal).toBe("");
    expect(result.calories).toBe(0);
  });

  it("passes through a vitamin result with multiple items and extra_nutrients", () => {
    const result = sanitizeChatTurnResult({
      category: "vitamin",
      vitamins: [
        { name: "Folamil Genio", folate_mcg: 1000, iron_mg: 30, extra_nutrients: [{ label: "Zinc", unit: "mg", value: 15 }] },
        { name: "Cavit D3", calcium_mg: 500, vitamin_d_mcg: 3.3, extra_nutrients: [] },
      ],
      reply: "Ketemu 2 vitamin ya!",
    });
    expect(result.category).toBe("vitamin");
    expect(result.vitamins).toHaveLength(2);
    expect(result.vitamins[0]).toMatchObject({ name: "Folamil Genio", folate_mcg: 1000, iron_mg: 30 });
    expect(result.vitamins[0].extra_nutrients).toEqual([{ label: "Zinc", unit: "mg", value: 15 }]);
    expect(result.vitamins[1]).toMatchObject({ name: "Cavit D3", calcium_mg: 500 });
    // food-only fields stay at their default for a vitamin-category result
    expect(result.meal).toBe("");
    expect(result.calories).toBe(0);
  });

  it("drops a vitamin item with no name", () => {
    const result = sanitizeChatTurnResult({
      category: "vitamin",
      vitamins: [{ name: "", iron_mg: 5 }, { name: "Real One", iron_mg: 5 }],
      reply: "ok",
    });
    expect(result.vitamins).toHaveLength(1);
    expect(result.vitamins[0].name).toBe("Real One");
  });

  it("downgrades to chat when every vitamin item is invalid (empty array left)", () => {
    const result = sanitizeChatTurnResult({ category: "vitamin", vitamins: [{ name: "" }], reply: "ok" });
    expect(result.category).toBe("chat");
    expect(result.vitamins).toEqual([]);
  });

  it("truncates an oversized vitamins array to the 10-item cap", () => {
    const vitamins = Array.from({ length: 15 }, (_, i) => ({ name: `Item ${i}` }));
    const result = sanitizeChatTurnResult({ category: "vitamin", vitamins, reply: "ok" });
    expect(result.vitamins).toHaveLength(10);
  });

  it("truncates an oversized extra_nutrients array per item to the 20-entry cap", () => {
    const extra_nutrients = Array.from({ length: 25 }, (_, i) => ({ label: `N${i}`, unit: "mg", value: 1 }));
    const result = sanitizeChatTurnResult({ category: "vitamin", vitamins: [{ name: "X", extra_nutrients }], reply: "ok" });
    expect(result.vitamins[0].extra_nutrients).toHaveLength(20);
  });

  it("drops extra_nutrients entries with no label", () => {
    const result = sanitizeChatTurnResult({
      category: "vitamin",
      vitamins: [{ name: "X", extra_nutrients: [{ label: "", unit: "mg", value: 1 }, { label: "Zinc", unit: "mg", value: 1 }] }],
      reply: "ok",
    });
    expect(result.vitamins[0].extra_nutrients).toEqual([{ label: "Zinc", unit: "mg", value: 1 }]);
  });

  it("defaults an unknown or missing category to chat", () => {
    expect(sanitizeChatTurnResult({ category: "something-else", reply: "hi" }).category).toBe("chat");
    expect(sanitizeChatTurnResult({ reply: "hi" }).category).toBe("chat");
    expect(sanitizeChatTurnResult({}).category).toBe("chat");
  });

  it("caps reply at 800 characters in every category", () => {
    const longReply = "x".repeat(900);
    expect(sanitizeChatTurnResult({ category: "chat", reply: longReply }).reply).toHaveLength(800);
    expect(sanitizeChatTurnResult({ category: "food", meal: "M", reply: longReply }).reply).toHaveLength(800);
    expect(sanitizeChatTurnResult({ category: "vitamin", vitamins: [{ name: "X" }], reply: longReply }).reply).toHaveLength(800);
  });

  it("coerces non-numeric/negative nutrient values to 0 (toSafeNumber)", () => {
    const result = sanitizeChatTurnResult({ category: "food", meal: "M", calories: "not a number", protein_g: -5, reply: "ok" });
    expect(result.calories).toBe(0);
    expect(result.protein_g).toBe(0);
  });
});
