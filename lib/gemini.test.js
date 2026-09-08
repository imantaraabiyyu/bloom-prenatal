import { describe, it, expect, vi } from "vitest";

// lib/gemini.js starts with `import "server-only"` — a marker package whose
// default export throws unconditionally outside of Next.js's own
// react-server bundling condition (which Vitest, running under plain Node,
// never sets). Stubbing it here is the standard way to unit-test a
// server-only module's pure helpers without a full Next.js render pipeline;
// sanitizeChatTurnResult and isGeminiBusyError touch no secrets/network, and
// every other function's real fetch() call is stubbed out below per test —
// only the GEMINI_API_KEY env var they read needs to actually be set.
vi.mock("server-only", () => ({}));

const {
  sanitizeChatTurnResult, isGeminiBusyError, GeminiHttpError, generateDailyNudge,
  streamNutritionChatTurn, streamTranscribeVoiceNote, GEMINI_LOWER_TIER_NOTICE, formatGeminiModelCaption,
} = await import("@/lib/gemini");

// Builds a fake ReadableStream body mimicking Gemini's streamGenerateContent
// SSE format (one "data: {...}" line carrying the whole response text in a
// single chunk) — enough to drive streamNutritionChatTurn/
// streamTranscribeVoiceNote through to their final sanitized result.
// Delta-by-delta streaming granularity is unchanged by the model-tier
// feature under test here and already exercised by production usage.
function fakeSseBody(fullJsonText) {
  const sseLine = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: fullJsonText }] } }] })}\n`;
  const bytes = new TextEncoder().encode(sseLine);
  let sent = false;
  return {
    getReader: () => ({
      async read() {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: bytes };
      },
    }),
  };
}

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

// isGeminiBusyError is what both app/api/nutrition-chat/route.js and
// app/api/journal/transcribe/route.js use to decide whether to show
// GEMINI_BUSY_MESSAGE ("lagi dibatasi kuotanya...") or their own generic
// failure copy — tested here directly since it's pure and exported.
describe("isGeminiBusyError", () => {
  it("is true for a 429 (rate limit / quota exceeded)", () => {
    expect(isGeminiBusyError(new GeminiHttpError(429, "quota exceeded"))).toBe(true);
  });

  it("is true for a 503 (Gemini overloaded)", () => {
    expect(isGeminiBusyError(new GeminiHttpError(503, "high demand"))).toBe(true);
  });

  it("is false for a non-busy GeminiHttpError status", () => {
    expect(isGeminiBusyError(new GeminiHttpError(500, "server error"))).toBe(false);
    expect(isGeminiBusyError(new GeminiHttpError(400, "bad request"))).toBe(false);
  });

  it("is false for an error that isn't a GeminiHttpError at all", () => {
    expect(isGeminiBusyError(new Error("some other failure"))).toBe(false);
    expect(isGeminiBusyError(null)).toBe(false);
  });
});

// generateDailyNudge is the simplest exported Gemini call site (non-streaming,
// one fetch + one retry loop) — used here purely as the vehicle for exercising
// fetchGeminiWithRetries's status-based retry policy, since that function
// itself isn't exported (same "export only what needs independent testing"
// convention as sanitizeChatTurnResult above).
describe("fetchGeminiWithRetries status policy (via generateDailyNudge)", () => {
  const nudgeSuccessBody = {
    candidates: [{ content: { parts: [{ text: JSON.stringify({ nudge: "Semangat ya!" }) }] } }],
  };

  it("does not retry a 429 (quota exceeded) — fails fast with a single fetch call", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(generateDailyNudge({})).rejects.toMatchObject({ status: 429 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still retries a 503 (unaffected legacy behavior) and eventually succeeds", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "high demand" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "high demand" })
      .mockResolvedValueOnce({ ok: true, json: async () => nudgeSuccessBody });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const nudge = await generateDailyNudge({});
      expect(nudge).toBe("Semangat ya!");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// generateDailyNudge (low tier) exercises GEMINI_MODEL/GEMINI_FALLBACK_MODELS'
// model-fallback chain specifically — distinct from the retry-per-model
// policy above, this is "move to a *different* model" rather than "retry the
// same one". Falls back on ANY GeminiHttpError status now (not just 429) —
// broadened after gemini-2.5-pro started 404ing in production with no code
// change on this end (Google retiring/renaming a model), per tryModelChain's
// own comment in lib/gemini.js.
describe("low-tier model fallback chain (GEMINI_MODEL / GEMINI_FALLBACK_MODELS, via generateDailyNudge)", () => {
  const nudgeBody = (text) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ nudge: text }) }] } }] });

  it("falls back to the next low-tier model on a 429, and succeeds there", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "low-model-a";
    process.env.GEMINI_FALLBACK_MODELS = "low-model-b";
    const fetchMock = vi.fn(async (url) => (
      url.includes("low-model-b")
        ? { ok: true, json: async () => nudgeBody("Semangat dari model cadangan!") }
        : { ok: false, status: 429, text: async () => "quota exceeded" }
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const nudge = await generateDailyNudge({});
      expect(nudge).toBe("Semangat dari model cadangan!");
      expect(fetchMock).toHaveBeenCalledTimes(2); // low-model-a (429), low-model-b (success)
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_MODEL;
      delete process.env.GEMINI_FALLBACK_MODELS;
    }
  });

  it("falls back to the next low-tier model on a 404 (model retired/unavailable — the reported production bug)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "low-model-a";
    process.env.GEMINI_FALLBACK_MODELS = "low-model-b";
    const fetchMock = vi.fn(async (url) => (
      url.includes("low-model-b")
        ? { ok: true, json: async () => nudgeBody("Semangat dari model cadangan!") }
        : { ok: false, status: 404, text: async () => "model no longer available" }
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const nudge = await generateDailyNudge({});
      expect(nudge).toBe("Semangat dari model cadangan!");
      expect(fetchMock).toHaveBeenCalledTimes(2); // low-model-a (404, no retry — not in RETRYABLE_STATUS), low-model-b (success)
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_MODEL;
      delete process.env.GEMINI_FALLBACK_MODELS;
    }
  });

  it("falls back to the next low-tier model even on an already-retry-exhausted 5xx (broadened trigger)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "low-model-a";
    process.env.GEMINI_FALLBACK_MODELS = "low-model-b";
    const fetchMock = vi.fn(async (url) => (
      url.includes("low-model-b")
        ? { ok: true, json: async () => nudgeBody("Semangat dari model cadangan!") }
        : { ok: false, status: 503, text: async () => "high demand" }
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const nudge = await generateDailyNudge({});
      expect(nudge).toBe("Semangat dari model cadangan!");
      // low-model-a's own retry policy (503 is retryable) accounts for 3 calls, THEN low-model-b (success) — 4 total
      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (const [url] of fetchMock.mock.calls.slice(0, 3)) expect(url).toContain("low-model-a");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_MODEL;
      delete process.env.GEMINI_FALLBACK_MODELS;
    }
  });

  it("exhausts the whole low-tier chain when every model fails, regardless of status, propagating the last model's error", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "low-model-a";
    process.env.GEMINI_FALLBACK_MODELS = "low-model-b,low-model-c";
    // Mixed statuses on purpose — proves the chain doesn't special-case 429
    const fetchMock = vi.fn(async (url) => (
      url.includes("low-model-a") ? { ok: false, status: 404, text: async () => "not found" }
      : url.includes("low-model-b") ? { ok: false, status: 429, text: async () => "quota exceeded" }
      : { ok: false, status: 403, text: async () => "forbidden" }
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(generateDailyNudge({})).rejects.toMatchObject({ status: 403 }); // low-model-c's, the last one tried
      expect(fetchMock).toHaveBeenCalledTimes(3); // one per model in the chain, no retries (none of these statuses are retryable)
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_MODEL;
      delete process.env.GEMINI_FALLBACK_MODELS;
    }
  });

  it("does not attempt any fallback on a raw network exception (not an HTTP response at all)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_MODEL = "low-model-a";
    process.env.GEMINI_FALLBACK_MODELS = "low-model-b";
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(generateDailyNudge({})).rejects.toThrow("fetch failed");
      expect(fetchMock).toHaveBeenCalledTimes(1); // not a GeminiHttpError at all — tryModelChain never tries low-model-b
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_MODEL;
      delete process.env.GEMINI_FALLBACK_MODELS;
    }
  });
});

// Chat tier (streamNutritionChatTurn, streamTranscribeVoiceNote) + the
// cross-tier last-resort drop to the low tier. Uses fakeSseBody since both
// functions read a streaming SSE body, unlike generateDailyNudge above.
describe("chat tier + cross-tier fallback (streamNutritionChatTurn, streamTranscribeVoiceNote)", () => {
  it("uses the chat tier directly when it succeeds — no cross-tier fallback, caption shows the chat-tier model", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "chat-model-a";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: fakeSseBody(JSON.stringify({ category: "chat", reply: "Halo!" })),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const safe = await streamNutritionChatTurn({ message: "hi", image: null, history: [] }, () => {});
      expect(safe.reply).toBe(`Halo!\n\n${formatGeminiModelCaption("chat-model-a")}`);
      expect(safe.reply).not.toContain(GEMINI_LOWER_TIER_NOTICE);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_CHAT_MODEL;
    }
  });

  it("falls through to the low tier when the whole chat tier 429s, appending the notice + model caption to reply (streamNutritionChatTurn)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "chat-model-a";
    process.env.GEMINI_CHAT_FALLBACK_MODELS = "chat-model-b";
    process.env.GEMINI_MODEL = "low-model-a";
    const fetchMock = vi.fn(async (url) => (
      url.includes("low-model-a")
        ? { ok: true, body: fakeSseBody(JSON.stringify({ category: "chat", reply: "Halo dari model cadangan!" })) }
        : { ok: false, status: 429, text: async () => "quota exceeded" }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const deltas = [];
    try {
      const safe = await streamNutritionChatTurn({ message: "hi", image: null, history: [] }, (d) => deltas.push(d));
      expect(safe.reply).toBe(
        `Halo dari model cadangan!\n\n${GEMINI_LOWER_TIER_NOTICE}\n\n${formatGeminiModelCaption("low-model-a")}`
      );
      expect(deltas.join("")).toBe(safe.reply); // onDelta's final "tail" flush covers the notice + caption too
      expect(fetchMock).toHaveBeenCalledTimes(3); // chat-model-a (429), chat-model-b (429), low-model-a (success)
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_CHAT_MODEL;
      delete process.env.GEMINI_CHAT_FALLBACK_MODELS;
      delete process.env.GEMINI_MODEL;
    }
  });

  it("falls through to the low tier when the whole chat tier 429s, appending the notice + model caption to tidiedNote, not transcript (streamTranscribeVoiceNote)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "chat-model-a";
    process.env.GEMINI_CHAT_FALLBACK_MODELS = "chat-model-b";
    process.env.GEMINI_MODEL = "low-model-a";
    const successBody = JSON.stringify({ transcript: "halo ini transkrip", tidied_note: "Halo, ini catatan rapinya." });
    const fetchMock = vi.fn(async (url) => (
      url.includes("low-model-a")
        ? { ok: true, body: fakeSseBody(successBody) }
        : { ok: false, status: 429, text: async () => "quota exceeded" }
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const safe = await streamTranscribeVoiceNote({ base64: "AAAA", mimeType: "audio/webm" }, () => {});
      expect(safe.transcript).toBe("halo ini transkrip"); // verbatim — no notice/caption appended here
      expect(safe.tidiedNote).toBe(
        `Halo, ini catatan rapinya.\n\n${GEMINI_LOWER_TIER_NOTICE}\n\n${formatGeminiModelCaption("low-model-a")}`
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_CHAT_MODEL;
      delete process.env.GEMINI_CHAT_FALLBACK_MODELS;
      delete process.env.GEMINI_MODEL;
    }
  });

  it("falls back within the chat tier on a 404 (model retired/unavailable) — the exact reported production bug", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "chat-model-a"; // stands in for the real gemini-2.5-pro
    process.env.GEMINI_CHAT_FALLBACK_MODELS = "chat-model-b"; // stands in for e.g. gemini-3.1-pro-preview
    const fetchMock = vi.fn(async (url) => (
      url.includes("chat-model-b")
        ? { ok: true, body: fakeSseBody(JSON.stringify({ category: "chat", reply: "Halo!" })) }
        : {
            ok: false,
            status: 404,
            text: async () => JSON.stringify({
              error: { code: 404, status: "NOT_FOUND", message: "This model models/chat-model-a is no longer available to new users." },
            }),
          }
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const safe = await streamNutritionChatTurn({ message: "hi", image: null, history: [] }, () => {});
      // Stays entirely within the chat tier — no cross-tier notice, caption names chat-model-b
      expect(safe.reply).toBe(`Halo!\n\n${formatGeminiModelCaption("chat-model-b")}`);
      expect(safe.reply).not.toContain(GEMINI_LOWER_TIER_NOTICE);
      expect(fetchMock).toHaveBeenCalledTimes(2); // chat-model-a (404, no retry), chat-model-b (success)
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_CHAT_MODEL;
      delete process.env.GEMINI_CHAT_FALLBACK_MODELS;
    }
  });

  it("falls through to the low tier even on a non-429 status once the whole chat tier is exhausted (broadened trigger)", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "chat-model-a"; // no chat-tier fallback configured
    process.env.GEMINI_MODEL = "low-model-a";
    const fetchMock = vi.fn(async (url) => (
      url.includes("low-model-a")
        ? { ok: true, body: fakeSseBody(JSON.stringify({ category: "chat", reply: "Halo dari model cadangan!" })) }
        : { ok: false, status: 500, text: async () => "server error" }
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const safe = await streamNutritionChatTurn({ message: "hi", image: null, history: [] }, () => {});
      expect(safe.reply).toBe(
        `Halo dari model cadangan!\n\n${GEMINI_LOWER_TIER_NOTICE}\n\n${formatGeminiModelCaption("low-model-a")}`
      );
      // chat-model-a's own retry policy (500 is retryable) accounts for 3 calls, THEN low-model-a (success) — 4 total
      expect(fetchMock).toHaveBeenCalledTimes(4);
      for (const [url] of fetchMock.mock.calls.slice(0, 3)) expect(url).toContain("chat-model-a");
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_CHAT_MODEL;
      delete process.env.GEMINI_MODEL;
    }
  });

  it("does not attempt any fallback (same-tier or cross-tier) on a raw network exception", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_CHAT_MODEL = "chat-model-a";
    process.env.GEMINI_MODEL = "low-model-a";
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(streamNutritionChatTurn({ message: "hi", image: null, history: [] }, () => {}))
        .rejects.toThrow("fetch failed");
      expect(fetchMock).toHaveBeenCalledTimes(1); // not a GeminiHttpError — never reaches low-model-a
    } finally {
      vi.unstubAllGlobals();
      delete process.env.GEMINI_CHAT_MODEL;
      delete process.env.GEMINI_MODEL;
    }
  });
});
